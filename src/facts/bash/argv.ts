import type { Node as SyntaxNode } from "web-tree-sitter";

import { expandNodeText, expandToken, type Quoting } from "./expansion.ts";
import { isRedirectNode } from "./redirects.ts";

/**
 * 命令 argv 的结构化视图（FR-65 角色模型的基础）。
 *
 * 事实层此前的参数分析只能按"出现在第几个、看起来像不像路径"来猜，于是搜索**模式**会被当成
 * 路径、选项的值会被当成路径、`--opt=value` 里嵌的路径又会整体取消免评审。这里先把 argv 摊平
 * 成 token 序列，让"哪个参数是路径、哪个是模式、哪个是选项"由档案声明而不是由形态猜。
 *
 * 保持纯函数：只依赖语法树节点与 `{ home, cwd }` 展开上下文。
 */

/** 引号内的展开上下文（与 `expansion.ts` 的 `Quoting` 一致）。 */
export type { Quoting };

export interface ArgvToken {
  /** 展开后的文本（未知变量保持字面）。 */
  text: string;
  /** 源码原文（含引号）；选项键必须从原文取，`--output="$X"` 的键是 `--output`。 */
  raw: string;
  node: SyntaxNode;
  /** `option` = 选项形态；`positional` = 位置参数（含 `--` 之后的一切）。 */
  kind: "option" | "positional";
  /** 位置参数序号（仅 `kind === "positional"`）。 */
  positionalIndex?: number;
  /** `--opt=value` 的 value（已展开）；仅选项 token 可能有。 */
  embedded?: { text: string; dynamic: boolean; quoting: Quoting };
  /** 该 token 自身含无法静态确定的取值。 */
  dynamic: boolean;
}

export interface Argv {
  /** 含可执行名的 argv 文本，用于前缀匹配、日志与包装器判断。 */
  words: string[];
  executable?: string;
  /** 可执行名之后的 token，按源码顺序。`--` 本身不是 token。 */
  tokens: ArgvToken[];
}

export interface ArgvOptions {
  home: string;
  cwd: string;
  /**
   * 从第几个**参数节点**开始构造 argv（FR-12 的透明前缀内推：`timeout 5 cat f` 从 `cat` 开始）。
   *
   * 该位置上的节点成为新的“可执行名”，之前的节点（`5`、`-n 5`、`FOO=1`）完全不入 argv，
   * 因此既不会成为路径目标，也不参与选项名单。索引对着**未被空词过滤的**参数节点序列，
   * 与 `argumentNodesOf` 的返回值一致。
   */
  startArgument?: number;
}

/**
 * 命令节点的实参节点（按源码顺序，**不做空词过滤**）。
 *
 * 跳过重定向、前导赋值与命令名，与 `buildArgv` 的内部口径一致；不过滤空词是为了让下标
 * 可以被 `startArgument` 安全引用（FR-12 的透明前缀内推）。
 */
export function argumentNodesOf(node: SyntaxNode): SyntaxNode[] {
  const nodes: SyntaxNode[] = [];
  for (const child of node.namedChildren) {
    if (isRedirectNode(child) || child.type === "variable_assignment") {
      continue;
    }
    if (child.type === "command_name") {
      continue;
    }
    nodes.push(child);
  }
  return nodes;
}

/** argv 的单词文本：去掉最外层引号。 */
export function argumentWord(node: SyntaxNode): string {
  const text = node.text;
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/** 选项形态：`-x`、`--long`；单独的 `-` 视为位置参数（stdin/stdout 约定不涉及文件）。 */
export function isOptionLike(raw: string): boolean {
  return raw.length > 1 && raw.startsWith("-") && !raw.startsWith("--=");
}

/** 选项键：`--opt=value` → `--opt`，其余原样。 */
export function optionKey(raw: string): string {
  const equals = raw.indexOf("=");
  return equals > 0 ? raw.slice(0, equals) : raw;
}

/**
 * 取出 `--opt=value` 里的 value（含引号语义）。
 *
 * 从文本切而不从 AST 取：`--output=.env` 在语法树里是**单个 word 节点**，没有子节点可读；
 * 只有 `--output="$OUT"` 这类才是 `concatenation`。
 */
export function embeddedOptionValue(
  raw: string,
): { text: string; quoting: Quoting } | undefined {
  const equals = raw.indexOf("=");
  if (equals <= 0) {
    return undefined;
  }
  const value = raw.slice(equals + 1);
  if (value.length === 0) {
    return undefined;
  }
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === "'" && last === "'") {
      return { text: value.slice(1, -1), quoting: "single" };
    }
    if (first === '"' && last === '"') {
      return { text: value.slice(1, -1), quoting: "double" };
    }
  }
  return { text: value, quoting: "none" };
}

/**
 * 构造 argv 的结构化视图。
 *
 * 前导赋值（`FOO=1 cmd`）由语法树单独给出，天然被跳过；重定向由调用方单独处理（它有方向语义）。
 */
export function buildArgv(
  node: SyntaxNode,
  executable: string | undefined,
  options: ArgvOptions,
): Argv {
  const allNodes = argumentNodesOf(node);
  // `startArgument` 指向内层命令名那个节点（FR-12 透明前缀内推）：它已经被当作 `executable`
  // 传进来，因此要从参数里**再去掉**，否则会多出一个同名的幽灵参数与幽灵路径。
  // 注意 `startArgument === 0`（`command rm …`）是合法取值，必须与“不内推”区分开。
  const argumentNodes =
    options.startArgument === undefined ? allNodes : allNodes.slice(options.startArgument + 1);

  const words = [executable ?? "", ...argumentNodes.map((child) => argumentWord(child))].filter(
    (word) => word.length > 0,
  );

  const tokens: ArgvToken[] = [];
  let positionalIndex = 0;
  let pastDoubleDash = false;
  for (const child of argumentNodes) {
    const raw = child.text;
    const word = argumentWord(child);
    if (word.length === 0) {
      continue;
    }
    // `--` 只作为"后面全是位置参数"的分隔符，本身不是参数。
    if (!pastDoubleDash && raw === "--") {
      pastDoubleDash = true;
      continue;
    }
    const expanded = expandNodeText(child, { home: options.home, cwd: options.cwd });
    const option = !pastDoubleDash && isOptionLike(raw);
    const token: ArgvToken = {
      text: expanded.text,
      raw: word,
      node: child,
      kind: option ? "option" : "positional",
      dynamic: expanded.dynamic,
    };
    if (option) {
      const embedded = embeddedOptionValue(raw);
      if (embedded !== undefined) {
        const value = expandToken(embedded.text, {
          home: options.home,
          cwd: options.cwd,
          quoting: embedded.quoting,
        });
        token.embedded = { text: value.text, dynamic: value.dynamic, quoting: embedded.quoting };
      }
    } else {
      token.positionalIndex = positionalIndex;
      positionalIndex += 1;
    }
    tokens.push(token);
  }

  const argv: Argv = { words, tokens };
  if (executable !== undefined) {
    argv.executable = executable;
  }
  return argv;
}
