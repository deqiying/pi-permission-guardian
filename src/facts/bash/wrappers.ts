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
 *
 * FR-12 修订（2026-09）：其中一部份是**透明前缀**（`timeout` / `nice` / `env` / `command` 等，
 * 见 `transparentPrefixStart`）——它们的规则固定且不改变后面的命令，知道怎么跳过自己的参数后，
 * 后面的命令就是真正要执行的东西，因此可以内推判定。`sudo` / `xargs` / `exec` 仍保持不透明：
 * 前者可能以另一个用户身份或在另一个环境下执行，后者会把参数拼成新命令。
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

/**
 * 透明前缀（FR-12 修订）的取参规则：给出“内层命令从第几个参数开始”。
 *
 * 入参是**未过滤空词**的参数词序列（不含可执行名），返回的是该序列的下标；
 * 返回 `undefined` 表示“看不懂这个包装器的参数布局”，此时仍按不透明处理（fail-closed）。
 */
const EMPTY_VALUE_OPTIONS: ReadonlySet<string> = new Set<string>();
const TIMEOUT_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-s", "--signal", "-k", "--kill-after"]);
const NICE_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-n", "--adjustment"]);
const IONICE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-c",
  "--class",
  "-n",
  "--classdata",
  "-p",
  "--pid",
  "-P",
  "--pgid",
  "-u",
  "--uid",
]);
const STDBUF_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-i",
  "--input",
  "-o",
  "--output",
  "-e",
  "--error",
]);
const TIME_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-o", "--output", "-f", "--format"]);
const ENV_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-u",
  "--unset",
  "-C",
  "--chdir",
  "-S",
  "--split-string",
]);

const TRANSPARENT_PREFIXES: Readonly<
  Record<string, (words: readonly string[]) => number | undefined>
> = {
  // 规则：跳过自己的选项（含取值选项）再跳过一个时长，后面才是真正要执行的命令。
  timeout: (words) => skipOptionsThen(words, 1, TIMEOUT_VALUE_OPTIONS),
  // 规则：只跳过自己的选项（含 `-n N` 的取值）。
  nice: (words) => skipOptions(words, NICE_VALUE_OPTIONS),
  ionice: (words) => skipOptions(words, IONICE_VALUE_OPTIONS),
  stdbuf: (words) => skipOptions(words, STDBUF_VALUE_OPTIONS),
  nohup: (words) => skipOptions(words, EMPTY_VALUE_OPTIONS),
  time: (words) => skipOptions(words, TIME_VALUE_OPTIONS),
  // `env [-i] [-u NAME] [NAME=VALUE]… 命令 …`：跳过选项与赋值。
  env: (words) => {
    const start = skipOptions(words, ENV_VALUE_OPTIONS);
    if (start === undefined) {
      return undefined;
    }
    let index = start;
    while (index < words.length && isAssignment(words[index] as string)) {
      index += 1;
    }
    return index < words.length ? index : undefined;
  },
  // `command [-pVv] 命令 …`：`-v` / `-V` 是**查询**而不是执行（由 profile 处理，见 readonly.ts），
  // 只有不带这两个旗标时才内推。
  command: (words) => {
    const start = skipOptions(words, EMPTY_VALUE_OPTIONS);
    if (start === undefined) {
      return undefined;
    }
    if (words.slice(0, start).some((word) => word === "-v" || word === "-V")) {
      return undefined;
    }
    return start < words.length ? start : undefined;
  },
};

/** 跳过自己的选项，返回下一个词的下标（`--` 终止选项解析；没有后续词就返回 undefined）。 */
function skipOptions(words: readonly string[], valueOptions: ReadonlySet<string>): number | undefined {
  let index = 0;
  while (index < words.length) {
    const word = words[index] as string;
    if (word === "--") {
      return index + 1 < words.length ? index + 1 : undefined;
    }
    if (!word.startsWith("-") || word === "-") {
      return index;
    }
    const equals = word.indexOf("=");
    if (equals > 0) {
      // `--signal=KILL`：取值就写在同一词里。
      index += 1;
      continue;
    }
    const isLong = word.startsWith("--");
    const takesValue =
      valueOptions.has(word) || (!isLong && valueOptions.has(word.slice(0, 2)));
    // 长选项 `--signal KILL` 与短选项 `-n 5` 吃下一个词；`-n5` / `-o0` 这类取值已粘在同一词里。
    index += takesValue && (isLong || word.length === 2) ? 2 : 1;
  }
  return undefined;
}

/** 跳过选项后再跳 `extra` 个固定位置参数（`timeout` 的 DURATION）。 */
function skipOptionsThen(
  words: readonly string[],
  extra: number,
  valueOptions: ReadonlySet<string>,
): number | undefined {
  const start = skipOptions(words, valueOptions);
  if (start === undefined) {
    return undefined;
  }
  const inner = start + extra;
  return inner < words.length ? inner : undefined;
}

/** `NAME=VALUE` 形式的环境变量赋值。 */
function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

/**
 * 透明前缀内推（FR-12 修订）：返回内层命令在**参数词序列**里的下标。
 *
 * 只对规则固定的一小组前缀生效（`timeout` / `nice` / `ionice` / `stdbuf` / `nohup` / `time` /
 * `env` / `command`，且 `command -v` 是查询不是执行）；其余（`sudo` / `xargs` / `exec` / `parallel`…）
 * 一律返回 undefined，保持原有的“不透明即降级”。
 */
export function transparentPrefixStart(
  executable: string | undefined,
  words: readonly string[],
): number | undefined {
  if (executable === undefined) {
    return undefined;
  }
  return TRANSPARENT_PREFIXES[executable]?.(words);
}

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
  if (executable === "command" && isCommandQuery(words.slice(1))) {
    return undefined;
  }
  if (INDIRECTION_WRAPPERS.has(executable)) {
    return "indirection";
  }
  if (executable === "find" && words.some((word) => FIND_EXEC_FLAGS.includes(word))) {
    return "indirection";
  }
  return undefined;
}

/**
 * `command -v X` / `-V X` 是**查询**（列路径/描述），不会执行 X，因此不算包装器。
 *
 * 它由内置档案按 `["command", "-v"]` 前缀命中而免评审（与 `which` / `type` 同类）；
 * 不带这两个旗标的 `command cat f` 仍然按包装器处理（可被透明前缀内推）。
 */
function isCommandQuery(words: readonly string[]): boolean {
  for (const word of words) {
    if (word === "-v" || word === "-V") {
      return true;
    }
    if (!word.startsWith("-") || word === "-") {
      return false;
    }
  }
  return false;
}

export function unresolvedCauseForWrapper(kind: WrapperKind): "opaque-wrapper" | "indirection-wrapper" {
  return kind === "opaque" ? "opaque-wrapper" : "indirection-wrapper";
}
