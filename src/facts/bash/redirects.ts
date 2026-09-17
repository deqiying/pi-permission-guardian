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
 * | 写入**空设备**（`/dev/null`、`NUL`） | 不产出路径目标（FR-67） |
 * | `<>` | 读写不可证：**同时**产出 read 与 write 两个目标，并把命令单元标记为 unresolved |
 * | `2>&1` 这类描述符复制 | 不涉及路径，不产生目标 |
 * | `<<` `<<-` | 右值是 heredoc 分隔符，不产生目标；正文里的命令替换由枚举器另行递归 |
 *
 * `<>` 的选择：同时给出两个方向不会低估风险（两个方向都要各自裁决），再叠加 unit 级
 * `ambiguous-direction` 降级，等价于“读写不可证就按不可证处理”。
 *
 * 空设备单独处理（FR-67）：写 `/dev/null` 没有持久副作用，而 `cmd 2>/dev/null` 是抑制噪声的
 * 最常见写法——把它当成写副作用会让只读命令一律降级为评审。只有一个例外不放松：
 * **非**空设备的写目标照旧产出 write 路径目标。
 */

const READ_OPERATORS = new Set(["<", "<&"]);
const WRITE_OPERATORS = new Set([">", ">>", ">|", "&>", "&>>"]);
const AMBIGUOUS_OPERATORS = new Set(["<>"]);

/**
 * 内置空设备集合（按目标平台）：`/dev/null` 在两种平台都是空设备（Windows 上的 pi 用 git-bash），
 * 而 `NUL` 只有 win32 才是空设备——POSIX 上的 `> NUL` 会真的在当前目录创建一个叫 `NUL` 的文件，
 * 因此不能当作 sink。
 */
const POSIX_BUILTIN_SINKS: readonly string[] = ["/dev/null"];
const WIN32_BUILTIN_SINKS: readonly string[] = ["/dev/null", "nul"];

export function builtinWriteSinks(platform: NodeJS.Platform): readonly string[] {
  return platform === "win32" ? WIN32_BUILTIN_SINKS : POSIX_BUILTIN_SINKS;
}

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
  /** 额外的“写入不算副作用”目标（FR-67）；内置空设备总是生效。 */
  writeSinks?: readonly string[];
}

/**
 * 目标是否是“写入不算副作用”的空设备。
 *
 * 比较大小写不敏感、分隔符归一、忽略盘符（Windows 上可能写成 `D:\dev\null` 或 `NUL`）。
 * 不做“以 /dev/null 结尾”这类模糊匹配：项目里的 `src/dev/null` 不是空设备。
 */
export function isWriteSink(
  text: string,
  extra: readonly string[] | undefined,
  platform: NodeJS.Platform,
): boolean {
  const candidates =
    extra === undefined || extra.length === 0
      ? builtinWriteSinks(platform)
      : [...builtinWriteSinks(platform), ...extra];
  const normalized = normalizeSink(text);
  return normalized.length > 0 && candidates.some((sink) => normalizeSink(sink) === normalized);
}

function normalizeSink(text: string): string {
  return text
    .trim()
    .replace(/\\/g, "/")
    .replace(/^[A-Za-z]:/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
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
  const sink =
    (WRITE_OPERATORS.has(operator) || AMBIGUOUS_OPERATORS.has(operator)) &&
    isWriteSink(analysis.text, options.writeSinks, options.platform);

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
    if (sink) {
      // 写空设备：无持久副作用，不产出路径目标（FR-67）。
      return { paths: [], ambiguous: false, dynamic };
    }
    return {
      paths: [toTarget(analysis.text, "write", options)],
      ambiguous: false,
      dynamic,
    };
  }
  if (AMBIGUOUS_OPERATORS.has(operator)) {
    if (sink) {
      return { paths: [], ambiguous: false, dynamic };
    }
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
  if (isWriteSink(analysis.text, options.writeSinks, options.platform)) {
    return { paths: [], ambiguous: false, dynamic };
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
