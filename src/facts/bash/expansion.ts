/**
 * `$HOME` / `${HOME}` / `$PWD` / `~` 的展开（FR-15）。
 *
 * 只展开需求列出的这四个形式，其余 `$VAR`、`$(...)`、反引号一律保持字面并标记为动态：
 * 猜一个值会让"外部目录判定"和规则匹配都建立在假事实上，比降级到评审更危险。
 *
 * 引号语义由 AST 提供（调用方告诉这里处于单引号 / 双引号 / 无引号上下文），因为：
 * - 单引号内一切都不展开；
 * - 双引号内 `~` 不展开（`"~/x"` 是字面的波浪号目录，不是家目录）。
 */

import type { Node as SyntaxNode } from "web-tree-sitter";

export type Quoting = "none" | "double" | "single";

export interface ExpansionOptions {
  home: string;
  cwd: string;
  quoting: Quoting;
}

export interface ExpansionResult {
  /** 展开后的文本：已知部分展开，未知部分原样保留。 */
  text: string;
  /** 是否含有无法静态确定的部分（未知变量、命令替换、算术展开等）。 */
  dynamic: boolean;
}

const EXPANDABLE_VARIABLES: Readonly<Record<string, keyof ExpansionOptions>> = {
  HOME: "home",
  PWD: "cwd",
};

export function expandToken(text: string, options: ExpansionOptions): ExpansionResult {
  if (options.quoting === "single") {
    return { text, dynamic: false };
  }
  const out: string[] = [];
  let dynamic = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index] as string;

    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined) {
        out.push(char);
        break;
      }
      // 反斜杠转义：$ 与 ` 在两种引号下都能被转义，其余情况原样保留反斜杠。
      if (next === "$" || next === "`" || next === "\\" || (options.quoting === "double" && next === '"')) {
        out.push(next);
      } else {
        out.push(char, next);
      }
      index += 2;
      continue;
    }

    if (char === "~" && options.quoting === "none" && isTildePosition(out, text, index)) {
      const expanded = expandTilde(text, index, options.home);
      if (expanded === undefined) {
        dynamic = true;
        out.push(char);
        index += 1;
      } else {
        out.push(expanded.text);
        index = expanded.nextIndex;
      }
      continue;
    }

    if (char === "$") {
      const variable = matchVariable(text, index);
      if (variable !== undefined) {
        const key = EXPANDABLE_VARIABLES[variable.name];
        if (key !== undefined) {
          out.push(options[key]);
        } else {
          dynamic = true;
          out.push(variable.text);
        }
        index = variable.nextIndex;
        continue;
      }
      const braced = matchBracedExpansion(text, index);
      if (braced !== undefined) {
        const key =
          braced.name === undefined ? undefined : EXPANDABLE_VARIABLES[braced.name];
        if (key !== undefined) {
          out.push(options[key]);
        } else {
          dynamic = true;
          out.push(braced.text);
        }
        index = braced.nextIndex;
        continue;
      }
      // `$(`、`$[`、裸 `$` 等：值不可知。
      dynamic = true;
      out.push(char);
      index += 1;
      continue;
    }

    if (char === "`") {
      dynamic = true;
      out.push(char);
      index += 1;
      continue;
    }

    out.push(char);
    index += 1;
  }

  return { text: out.join(""), dynamic };
}

/** `~` 只有在词首、或紧跟在 `=` / `:` 之后才被 bash 展开。 */
function isTildePosition(out: readonly string[], _text: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const previous = out[out.length - 1];
  return previous === "=" || previous === ":";
}

function expandTilde(
  text: string,
  index: number,
  home: string,
): { text: string; nextIndex: number } | undefined {
  const rest = text.slice(index + 1);
  if (rest.length === 0 || rest.startsWith("/") || rest.startsWith("\\")) {
    return { text: home, nextIndex: index + 1 };
  }
  // `~user/x`：不知道 user 的家目录，按动态处理。
  return undefined;
}

function matchVariable(
  text: string,
  index: number,
): { name: string; text: string; nextIndex: number } | undefined {
  const rest = text.slice(index + 1);
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
  if (match === null) {
    return undefined;
  }
  return {
    name: match[0],
    text: `$${match[0]}`,
    nextIndex: index + 1 + match[0].length,
  };
}

/** `${...}`：只有 `${HOME}` / `${PWD}` 这种纯变量形态可展开，其余（默认值、截取、长度）都不可静态确定。 */
function matchBracedExpansion(
  text: string,
  index: number,
): { name?: string; text: string; nextIndex: number } | undefined {
  if (text[index + 1] !== "{") {
    return undefined;
  }
  const end = text.indexOf("}", index + 2);
  if (end === -1) {
    return undefined;
  }
  const body = text.slice(index + 2, end);
  const nextIndex = end + 1;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(body)) {
    return { name: body, text: text.slice(index, nextIndex), nextIndex };
  }
  return { text: text.slice(index, nextIndex), nextIndex };
}

/** 值完全由运行时决定的节点类型。 */
const SUBSTITUTION_NODE_TYPES: ReadonlySet<string> = new Set([
  "command_substitution",
  "process_substitution",
  "arithmetic_expansion",
]);

/**
 * 变量展开类节点：`$HOME` / `${PWD}` 这类可展开，其余按动态处理，
 * 因此需要交给 `expandToken` 逐字符判断，不能一律当动态。
 */
const DYNAMIC_NODE_TYPES: ReadonlySet<string> = new Set([
  "expansion",
  "simple_expansion",
]);

/** 本身就是字面量的节点类型（引号内不做任何展开）。 */
const LITERAL_NODE_TYPES: ReadonlySet<string> = new Set([
  "raw_string",
  "ansi_c_string",
  "number",
  "heredoc_start",
]);

/**
 * 展开一个参数节点，并保留它自己的引号语义。
 *
 * 引号语义必须从 AST 读，不能只看文本：`'$HOME'` 不展开，`"~"` 也不是家目录。
 * 无法识别的节点类型保守处理：只要子树里出现取值取决于运行时的节点，就整体标记为动态。
 */
export function expandNodeText(
  node: SyntaxNode,
  options: { home: string; cwd: string },
): ExpansionResult {
  if (LITERAL_NODE_TYPES.has(node.type)) {
    return { text: stripQuotes(node.text), dynamic: false };
  }
  if (SUBSTITUTION_NODE_TYPES.has(node.type)) {
    // `$(...)` / `` `...` `` / `$((...))`: 取值完全由运行时决定，不需要再扫文本。
    return { text: node.text, dynamic: true };
  }
  if (DYNAMIC_NODE_TYPES.has(node.type)) {
    return expandToken(node.text, { ...options, quoting: "none" });
  }
  if (node.type === "string" || node.type === "translated_string") {
    return expandParts(node.namedChildren, options, "double");
  }
  if (node.type === "concatenation" || node.type === "word") {
    if (node.namedChildCount === 0) {
      return expandToken(node.text, { ...options, quoting: "none" });
    }
    return expandParts(node.namedChildren, options, "none");
  }
  if (node.namedChildren.some((child) => subtreeIsDynamic(child))) {
    return { text: stripQuotes(node.text), dynamic: true };
  }
  return { text: stripQuotes(node.text), dynamic: false };
}

function expandParts(
  children: readonly SyntaxNode[],
  options: { home: string; cwd: string },
  quoting: Quoting,
): ExpansionResult {
  const parts: string[] = [];
  let dynamic = false;
  for (const child of children) {
    if (child.type === "string_content" || child.type === "heredoc_content") {
      const expanded = expandToken(child.text, { ...options, quoting });
      parts.push(expanded.text);
      dynamic = dynamic || expanded.dynamic;
      continue;
    }
    const expanded = expandNodeText(child, options);
    parts.push(expanded.text);
    dynamic = dynamic || expanded.dynamic;
  }
  return { text: parts.join(""), dynamic };
}

function subtreeIsDynamic(node: SyntaxNode): boolean {
  if (DYNAMIC_NODE_TYPES.has(node.type) || node.type === "command_substitution") {
    return true;
  }
  return node.namedChildren.some((child) => subtreeIsDynamic(child));
}

/** 去掉最外层引号，用于把 AST 文本变成路径候选的字面文本。 */
function stripQuotes(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return text.slice(1, -1);
    }
  }
  return text;
}
