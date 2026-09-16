import type { PathTarget } from "../types.ts";

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

/**
 * 命令单元是否属于"只读且无写副作用"。
 *
 * 三个条件缺一不可：命中外置白名单、没有写方向的路径、没有写方向的重定向——
 * 少了后两条，`cat > /etc/hosts` 会因为 `cat` 在白名单里而被直接放行。
 */
export function isReadOnlyUnit(
  matchedEntry: string | undefined,
  paths: readonly PathTarget[],
): boolean {
  if (matchedEntry === undefined) {
    return false;
  }
  return paths.every((path) => path.direction === "read");
}
