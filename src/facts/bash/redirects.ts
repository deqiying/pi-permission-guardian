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
      dynamic: false,
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

/** 收集一个节点自身携带的重定向（`command` 与 `redirected_statement` 两种形态都会出现）。 */
export function collectRedirects(
  node: SyntaxNode,
): SyntaxNode[] {
  const redirects: SyntaxNode[] = [];
  for (const child of node.children) {
    if (isRedirectNode(child)) {
      redirects.push(child);
    }
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
