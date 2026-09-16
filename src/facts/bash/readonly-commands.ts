import type { PathTarget, UnresolvedCause } from "../types.ts";

/**
 * 只读命令白名单匹配（FR-9）。
 *
 * 匹配方式固定为"可执行名 + 参数前缀"，刻意不分析选项语义：`git status` 命中
 * `git status --short`，不命中 `git push`。白名单只说明"这条命令本身不会改文件"，
 * 因此最终是否只读还要看它有没有写方向的路径（重定向、写类参数）。
 */

/** `entry`（如 `git status`）是否是 `words`（argv）的前缀。 */
export function matchesReadOnlyPrefix(
  entry: string,
  words: readonly string[],
): boolean {
  const entryWords = entry.trim().split(/\s+/).filter((word) => word.length > 0);
  if (entryWords.length === 0 || entryWords.length > words.length) {
    return false;
  }
  // 大小写敏感：跨平台一致且方向是安全的——匹配不上只是回到评审，不会多放行一条命令。
  return entryWords.every((word, index) => word === words[index]);
}

/** 命中外置白名单的条目（用于 `/perm status` 与审计展示），未命中返回 undefined。 */
export function matchReadOnlyCommands(
  words: readonly string[],
  whitelist: readonly string[],
): string | undefined {
  for (const entry of whitelist) {
    if (matchesReadOnlyPrefix(entry, words)) {
      return entry;
    }
  }
  return undefined;
}

/** 只读判定的输入。用对象传参是为了让每个条件在调用处都有名字，减少"漏传一个条件"。 */
export interface ReadOnlyInput {
  /** 命中的白名单条目；未命中为 undefined。 */
  matchedEntry: string | undefined;
  /** 该命令的全部路径目标（参数 + 重定向）。 */
  paths: readonly PathTarget[];
  /** 单元的可信性；不可信就不能算只读。 */
  unresolved?: UnresolvedCause;
  /** 参数里是否出现带路径值的 `--opt=value`。 */
  pathValuedOption: boolean;
}

/**
 * 命令单元是否属于"只读且无写副作用"（FR-9：命中即可免评审放行）。
 *
 * 四个条件缺一不可：
 * 1. 命中外置白名单；
 * 2. 没有写方向的路径（含重定向）——否则 `cat > /etc/hosts` 会被 `cat` 放行；
 * 3. 单元本身可信——否则 `cat $f` 会因为"`cat` 是只读的"而放行一个读向未知文件的命令；
 * 4. 没有带路径值的选项——`git diff --output=.env` 的参数全是"选项"，前缀匹配看不出它要写文件
 *    （`--output=<file>` 已实测会真实写文件），所以带路径值的选项一律取消免评审资格。
 *
 * 第 4 条不关心具体是哪个选项（D21 禁止为特殊选项开分支），只按形状判断：宁可多取消一次
 * 免评审，也不要少取消。
 */
export function isReadOnlyUnit(input: ReadOnlyInput): boolean {
  if (input.matchedEntry === undefined || input.unresolved !== undefined) {
    return false;
  }
  if (input.pathValuedOption) {
    return false;
  }
  return input.paths.every((path) => path.direction === "read");
}
