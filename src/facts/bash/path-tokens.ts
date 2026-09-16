import type { Node as SyntaxNode } from "web-tree-sitter";

import { makePathTarget } from "../path-value.ts";
import { expandNodeText } from "./expansion.ts";
import { isRedirectNode } from "./redirects.ts";
import { matchesReadOnlyPrefix } from "./readonly-commands.ts";
import type { Direction, PathTarget } from "../types.ts";

/**
 * 命令参数里的路径候选与读写效应归因（FR-15）。
 *
 * 归因规则（刻意保守，宁可多标一个路径目标，不要漏掉敏感文件）：
 *
 * | 条件 | 是否路径候选 | 方向 |
 * |---|---|---|
 * | 命令命中外置只读白名单 | 全部非选项参数 | read |
 * | 参数看起来像路径（含分隔符、`~`、`.`/`..` 开头、盘符） | 是 | 命令非只读时按 write |
 * | 参数里出现变量/替换（`"$DIR"`、`$(...)`） | 仅当它同时像路径 | 同上 |
 * | 命令属于内置写类文件命令（`rm` / `cp` / `tee` …） | 全部非选项参数 | write |
 * | 其余参数（选项、普通词） | 否 | — |
 *
 * 为什么不把所有参数都当路径：`echo note.env` 会因为 `*.env` 命中 `deny` 而被误拦。
 * 为什么对"只读白名单命中"与"写类命令"要给全部参数：这两类命令的参数按定义就是文件，
 * 漏掉它们会直接放过 `cat secrets.pem` 这类敏感文件读取。
 *
 * 只读白名单条目本身消耗的词（`git status` 的两个词）不算路径，否则 `git status` 会把
 * 子命令名 `status` 当成一个路径目标。
 *
 * 变量/替换取值不可知时，若它又不像路径（没有任何分隔符），就不产出路径目标——把
 * "这里有个文件、但叫什么不知道"的信息交给单元级 `unresolved` 表达，避免造出假路径。
 */

/** 导航类命令：位置参数是目录，效应按读处理。 */
const READ_PATH_COMMANDS: ReadonlySet<string> = new Set(["cd", "pushd", "popd"]);

/** 内置写类文件命令：位置参数按定义就是文件路径。 */
const WRITE_PATH_COMMANDS: ReadonlySet<string> = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "truncate",
  "shred",
  "ln",
  "tee",
  "touch",
  "mkdir",
  "chmod",
  "chown",
  "chgrp",
  "install",
  "rsync",
  "unzip",
  "zip",
  "tar",
  "patch",
]);

export interface CommandArgAnalysis {
  /** argv 的文本形式（已去引号），用于只读白名单前缀匹配与日志。 */
  words: string[];
  paths: PathTarget[];
  /** 参数中存在无法静态确定的取值。 */
  dynamic: boolean;
}

export interface CommandArgOptions {
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  roots: readonly string[];
  readOnlyCommands: readonly string[];
}

/**
 * 分析一个 `command` 节点的参数。
 *
 * `executable` 用于决定方向与白名单匹配；重定向由调用方单独处理，这里只看参数。
 */
export function analyzeCommandArgs(
  node: SyntaxNode,
  executable: string | undefined,
  options: CommandArgOptions,
): CommandArgAnalysis {
  const argumentNodes: SyntaxNode[] = [];
  for (const child of node.namedChildren) {
    if (isRedirectNode(child) || child.type === "variable_assignment") {
      continue;
    }
    if (child.type === "command_name") {
      continue;
    }
    argumentNodes.push(child);
  }

  const words = [executable ?? "", ...argumentNodes.map((child) => argumentWord(child))].filter(
    (word) => word.length > 0,
  );

  // 只读白名单按"可执行名 + 参数前缀"匹配整个 argv（FR-9）。
  const readOnlyMatch = matchAnyPrefix(words, options.readOnlyCommands);
  // 白名单条目本身消耗掉的词（`git status` 消耗 2 个）不是文件路径，不参与路径候选。
  const consumedWords = readOnlyMatch === undefined ? 0 : wordCount(readOnlyMatch) - 1;
  const navigation = executable !== undefined && READ_PATH_COMMANDS.has(executable);
  const direction: Direction = readOnlyMatch !== undefined || navigation ? "read" : "write";
  const allArgsArePaths =
    readOnlyMatch !== undefined ||
    navigation ||
    (executable !== undefined && WRITE_PATH_COMMANDS.has(executable));

  const paths: PathTarget[] = [];
  let dynamic = false;
  for (const [index, child] of argumentNodes.entries()) {
    if (index < consumedWords || isOptionLike(child)) {
      continue;
    }
    const expanded = expandNodeText(child, { home: options.home, cwd: options.cwd });
    dynamic = dynamic || expanded.dynamic;
    if (!allArgsArePaths && !looksLikePath(expanded.text)) {
      continue;
    }
    if (expanded.text.length === 0) {
      continue;
    }
    paths.push(
      makePathTarget(expanded.text, direction, "arg", {
        cwd: options.cwd,
        platform: options.platform,
        roots: options.roots,
      }),
    );
  }

  return { words, paths, dynamic };
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

function matchAnyPrefix(
  words: readonly string[],
  whitelist: readonly string[],
): string | undefined {
  if (words.length === 0) {
    return undefined;
  }
  return whitelist.find((entry) => matchesReadOnlyPrefix(entry, words));
}

function wordCount(entry: string): number {
  return entry.trim().split(/\s+/).filter((word) => word.length > 0).length;
}

/** 选项形态：`-x`、`--long`；单独的 `-` 视为路径（stdin/stdout 约定不涉及文件）。 */
function isOptionLike(node: SyntaxNode): boolean {
  const text = node.text;
  return text.length > 1 && text.startsWith("-") && !text.startsWith("--=");
}

/** URL 形态（`https://host/path`）：不是文件路径，当作路径候选会产生误判。 */
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 看起来像路径：含分隔符、以 `~` / `.` / `/` 开头、或带盘符。 */
export function looksLikePath(text: string): boolean {
  if (text.length === 0 || URL_PATTERN.test(text)) {
    return false;
  }
  if (text.includes("/") || text.includes("\\")) {
    return true;
  }
  if (text.startsWith("~")) {
    return true;
  }
  if (text.startsWith(".")) {
    return true;
  }
  return /^[A-Za-z]:$/.test(text) || /^[A-Za-z]:[^\\/]/.test(text);
}
