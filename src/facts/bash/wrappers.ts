/**
 * 包装器识别（FR-12）。
 *
 * 两类包装器都无法在静态上得到"实际会执行什么"，但**原因不同**，所以标记也不同：
 * - `opaque`：被包起来的是一段**代码文本**（`bash -c '...'`、`eval`、`source`），
 *   内部命令既不在 AST 里也不在 argv 里，只能整体降级；
 * - `indirection`：外层程序负责**间接执行**参数（`sudo`、`env`、`xargs`、`nohup`、
 *   `timeout`、`find -exec` 等），我们能看到外层命令，但真正执行的对象由外层程序决定。
 *
 * 集合保持最小且可解释：命中即降级到 `onUnresolvedFacts`，所以漏掉一项比多加一项危险。
 */

export type WrapperKind = "opaque" | "indirection";

/** 会执行"代码文本或脚本文件"的外部程序：内容不在本次 AST 中。 */
export const OPAQUE_WRAPPERS: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "ash",
  "fish",
  "csh",
  "tcsh",
  "eval",
  "source",
  ".",
]);

/** 间接执行参数的外部程序：能看到外层，看不到真正要执行的目标。 */
export const INDIRECTION_WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "su",
  "runuser",
  "pkexec",
  "env",
  "xargs",
  "nohup",
  "timeout",
  "time",
  "nice",
  "ionice",
  "stdbuf",
  "setsid",
  "chroot",
  "command",
  "builtin",
  "exec",
  "parallel",
]);

/** `find -exec` / `-execdir` / `-ok` 的间接执行标记。 */
const FIND_EXEC_FLAGS: readonly string[] = ["-exec", "-execdir", "-ok", "-okdir"];

/** 去掉目录部分、Windows 扩展名与前置反斜杠，得到可执行名。 */
export function executableName(word: string): string {
  const withoutPrefix = word.replace(/^\\+/, "");
  const segments = withoutPrefix.split(/[\\/]/);
  const base = segments[segments.length - 1] ?? withoutPrefix;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "");
}

/**
 * 判断一个命令单元是不是包装器调用。
 *
 * `words` 是该命令的 argv（含可执行名），用于识别 `find` 的 `-exec` 这类"要看参数才知道"的情况。
 */
export function classifyWrapper(
  executable: string | undefined,
  words: readonly string[],
): WrapperKind | undefined {
  if (executable === undefined) {
    return undefined;
  }
  if (OPAQUE_WRAPPERS.has(executable)) {
    return "opaque";
  }
  if (INDIRECTION_WRAPPERS.has(executable)) {
    return "indirection";
  }
  if (executable === "find" && words.some((word) => FIND_EXEC_FLAGS.includes(word))) {
    return "indirection";
  }
  return undefined;
}

export function unresolvedCauseForWrapper(kind: WrapperKind): "opaque-wrapper" | "indirection-wrapper" {
  return kind === "opaque" ? "opaque-wrapper" : "indirection-wrapper";
}
