import type { Node as SyntaxNode } from "web-tree-sitter";

import { makePathTarget } from "../path-value.ts";
import { expandNodeText } from "./expansion.ts";
import type { PathTarget } from "../types.ts";

/**
 * 重定向的读写方向（FR-13）。
 *
 * | 写法 | 方向 |
 * |---|---|
 * | `<` `<<<` | read（`<<<` 的右值是数据而不是路径，不产生路径目标） |
 * | `>` `>>` `>|` `&>` `&>>` | write |
 * | `<>` | 读写不可证：**同时**产出 read 与 write 两个目标，并把命令单元标记为 unresolved |
 * | `2>&1` 这类描述符复制 | 不涉及路径，不产生目标 |
 * | `<<` `<<-` | 右值是 heredoc 分隔符，不产生目标；正文里的命令替换由枚举器另行递归 |
 *
 * `<>` 的选择：同时给出两个方向不会低估风险（两个方向都要各自裁决），再叠加 unit 级
 * `ambiguous-direction` 降级，等价于"读写不可证就按不可证处理"。
 */

const READ_OPERATORS = new Set(["<", "<&"]);
const WRITE_OPERATORS = new Set([">", ">>", ">|", "&>", "&>>"]);
const AMBIGUOUS_OPERATORS = new Set(["<>"]);

export interface RedirectAnalysis {
  paths: PathTarget[];
  /** 出现 `<>` 这类方向不可证的重定向。 */
  ambiguous: boolean;
  /** 目标是非字面量（`> "$OUT"`）。 */
  dynamic: boolean;
}

export interface RedirectOptions {
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  roots: readonly string[];
}

/** 节点是否是重定向（`file_redirect` / `heredoc_redirect` / `herestring_redirect`）。 */
export function isRedirectNode(node: SyntaxNode): boolean {
  return node.type.endsWith("redirect");
}

/** 分析单个重定向节点。 */
export function analyzeRedirect(
  node: SyntaxNode,
  options: RedirectOptions,
): RedirectAnalysis {
  const empty: RedirectAnalysis = { paths: [], ambiguous: false, dynamic: false };
  if (node.type !== "file_redirect") {
    // heredoc / herestring：右值是分隔符或数据，不构成路径目标。
    return empty;
  }

  const operator = findOperator(node);
  const destination = node.childForFieldName("destination");
  if (operator === undefined || destination === null) {
    return empty;
  }

  const analysis = expandNodeText(destination, {
    home: options.home,
    cwd: options.cwd,
  });
  const dynamic = analysis.dynamic;

  if (READ_OPERATORS.has(operator)) {
    // `<&5` 这类描述符复制不涉及路径。
    const duplicating = destination.type === "number";
    return {
      paths: duplicating
        ? []
        : [toTarget(analysis.text, "read", options)],
      ambiguous: false,
      dynamic,
    };
  }
  if (WRITE_OPERATORS.has(operator)) {
    return {
      paths: [toTarget(analysis.text, "write", options)],
      ambiguous: false,
      dynamic,
    };
  }
  if (AMBIGUOUS_OPERATORS.has(operator)) {
    return {
      paths: [
        toTarget(analysis.text, "read", options),
        toTarget(analysis.text, "write", options),
      ],
      ambiguous: true,
      dynamic,
    };
  }
  // `>&` / `<&` 后面跟着数字是描述符复制；跟着别的就是文件。
  if (destination.type === "number") {
    return empty;
  }
  return {
    paths: [toTarget(analysis.text, "write", options)],
    ambiguous: false,
    dynamic,
  };
}

/**
 * 收集一个节点携带的重定向。
 *
 * 必须递归：`cat <<EOF > .env` 的 `>` 是**嵌在 heredoc_redirect 内部**的（语法树：
 * `heredoc_redirect → file_redirect`），只看直接子节点会漏掉它，副结果是白名单命令仍然
 * 被当成只读而免评审放行——而它实际会截断 `.env`。
 */
export function collectRedirects(node: SyntaxNode): SyntaxNode[] {
  const redirects: SyntaxNode[] = [];
  const seen = new Set<number>();
  // 只在重定向节点内部向下走：进入 body / 命令替换会把**内层命令**自己的重定向也算到外层，
  // 造成同一目标被重复归因。
  const collect = (current: SyntaxNode): void => {
    if (!isRedirectNode(current) || seen.has(current.id)) {
      return;
    }
    seen.add(current.id);
    redirects.push(current);
    for (const child of current.children) {
      collect(child);
    }
  };
  for (const child of node.children) {
    collect(child);
  }
  return redirects;
}

function toTarget(
  raw: string,
  direction: PathTarget["direction"],
  options: RedirectOptions,
): PathTarget {
  return makePathTarget(raw, direction, "redirect", options);
}

function findOperator(node: SyntaxNode): string | undefined {
  for (const child of node.children) {
    if (!child.isNamed) {
      return child.text;
    }
  }
  return undefined;
}
