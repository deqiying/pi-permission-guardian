import { looksLikePath } from "../path-value.ts";
import type {
  PathTarget,
  ReadOnlyCommandProfile,
  ReadOnlyRole,
  UnresolvedCause,
} from "../types.ts";
import { optionKey, isOptionLike, type Argv, type ArgvToken } from "./argv.ts";

/**
 * 只读命令档案的匹配与免评审判定（FR-9、FR-65~FR-69）。
 *
 * 三种名单叠在一起决定"能不能免评审"：
 *
 * 1. **白名单（档案）**：`argv` 前缀命中才算候选。字符串形态的旧条目（`readOnlyCommands`）
 *    等价于 `{ argv, roles: ["paths"] }`，因此旧配置语义完全保留。
 * 2. **参数角色**：档案声明每个位置参数是 `paths`（真的路径）、`pattern`（模式/正则，
 *    不是文件）、还是 `script`（脚本代码，必须整体命中 `script` 模式集）。
 * 3. **选项名单**：`unsafeOptions`（命中即取消，用于"写文件/执行程序/改工作目录"的选项）
 *    与 `safeOptions` + `optionPolicy`（`allow-list` 下未列出的选项一律取消）。
 *
 * 判定方向一律 fail-closed：任何"看不懂"的形态（选项名不可信、值不可静态确定、脚本不匹配、
 * 路径位置动态取值）都只是**取消免评审**，不会放宽成放行。
 */

/** 命中档案后的求值计划。 */
export interface ReadOnlyPlan {
  entry: ReadOnlyCommandProfile;
  /** 位置参数角色序列；空数组表示该命令不产出路径目标。 */
  roles: readonly ReadOnlyRole[];
  /** 免评审取消原因（`kind` 或 `kind:detail`）；undefined 表示通过。 */
  cancel?: string;
  /** 未声明安全的带值选项里"值像路径"的取值：仍按旧口径产出 read 路径目标。 */
  optionPathValues: readonly string[];
  /**
   * 出现了档案无法核实其含义的动态取值（未声明安全的带值选项、选项名本身动态、脚本取值动态）：
   * 单元必须按 FR-15 升级为不可信对象，交给 `onUnresolvedFacts`。
   *
   * 与 `cancel` 的分工：`cancel` 说"档案检查没过"，`dynamicArg` 说"这条命令的取值我们看不透"。
   * 两者可以同时成立（`git diff --output="$OUT"`），此时按更保守的“不可静态确定”处理。
   */
  dynamicArg?: boolean;
}

/** 免评审被取消的原因种类（FR-69；`kind:detail` 的 detail 供审计展示）。 */
export const READ_ONLY_CANCEL_KINDS = [
  /** 写入真实目标的写方向重定向（`> out.txt`）。 */
  "redirect-write",
  /** 命中 `unsafeOptions`。 */
  "unsafe-option",
  /** `allow-list` 下未列出的选项，或带值选项的值不可静态确定。 */
  "option-not-allowed",
  /** 未声明安全的 `--opt=<值像路径>`。 */
  "option-path-value",
  /** `script` 角色未命中 `script` 模式集（含脚本缺失、脚本取值动态）。 */
  "script-not-allowed",
  /** 非路径位置出现动态取值（选项名/脚本本身不可静态确定）。 */
  "dynamic-arg",
  /** 档案声明了角色却出现了未被任何角色吸收的位置参数（例如 `git branch <新分支名>`）。 */
  "unexpected-arg",
] as const;

export type ReadOnlyCancelKind = (typeof READ_ONLY_CANCEL_KINDS)[number];

/** 把旧白名单字符串条目当作“可执行名 + 参数前缀、全部位置参数都是路径”的档案。 */
export function legacyProfiles(
  entries: readonly string[],
): ReadOnlyCommandProfile[] {
  return entries.map((entry) => ({
    argv: entry
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0),
    roles: ["paths"] as const,
    group: "readOnlyCommands",
  }));
}

/** `profile.argv` 是否是 `words` 的前缀。大小写敏感：匹配不上只会变严。 */
export function matchesProfilePrefix(
  profileArgv: readonly string[],
  words: readonly string[],
): boolean {
  if (profileArgv.length === 0 || profileArgv.length > words.length) {
    return false;
  }
  return profileArgv.every((word, index) => word === words[index]);
}

/** 位置参数序号 → 角色；序列最后一项吸收剩余位置参数。 */
export function roleAt(
  roles: readonly ReadOnlyRole[],
  positionalIndex: number | undefined,
): ReadOnlyRole | undefined {
  if (positionalIndex === undefined || roles.length === 0) {
    return undefined;
  }
  return roles[Math.min(positionalIndex, roles.length - 1)];
}

/**
 * 档案 `argv` 前缀自身消耗掉的位置参数个数。
 *
 * `git status` 的 `status`、`git branch` 的 `branch` 都是前缀的一部分，不是文件路径；
 * 不排除它们就既会造出幽灵路径目标，又会被 `unexpected-arg` 误判。
 */
export function prefixPositionalCount(entry: ReadOnlyCommandProfile): number {
  return entry.argv.slice(1).filter((word) => !isOptionLike(word)).length;
}

/** 选项名单匹配：按词前缀（`--pre` 覆盖 `--pre` 与 `--pre-glob`），方向是"宁可多取消"。 */
function matchOptionEntry(
  list: readonly string[] | undefined,
  key: string,
): string | undefined {
  if (list === undefined || list.length === 0) {
    return undefined;
  }
  return list.find((entry) => entry.length > 0 && (key === entry || key.startsWith(entry)));
}

/**
 * `script` 模式集匹配（白名单式：整体锚定，不匹配即取消）。
 *
 * 编译失败的模式按"永不匹配"处理，并同时由配置校验拦住（`schema.ts` 的 `script` 校验），
 * 因此这里不会因为一个手写错的模式让整条决策链路抛异常。
 */
const scriptPatternCache = new Map<string, RegExp | undefined>();

function compileScriptPattern(pattern: string): RegExp | undefined {
  if (scriptPatternCache.has(pattern)) {
    return scriptPatternCache.get(pattern);
  }
  let compiled: RegExp | undefined;
  try {
    compiled = new RegExp(pattern, "s");
  } catch {
    compiled = undefined;
  }
  scriptPatternCache.set(pattern, compiled);
  return compiled;
}

function matchesScript(patterns: readonly string[] | undefined, text: string): boolean {
  if (patterns === undefined || patterns.length === 0) {
    return false;
  }
  return patterns.some((pattern) => compileScriptPattern(pattern)?.test(text) ?? false);
}

/**
 * 匹配档案并给出免评审计划。
 *
 * 只有第一个命中的档案生效：档案顺序即优先级，调用方按“内置分组 → 用户条目”排好序。
 * `~` / `$HOME` 的展开在 `buildArgv` 阶段已经完成，这里只做档案比对。
 */
export function planReadOnly(
  argv: Argv,
  profiles: readonly ReadOnlyCommandProfile[],
): ReadOnlyPlan | undefined {
  const entry = profiles.find((profile) => matchesProfilePrefix(profile.argv, argv.words));
  if (entry === undefined) {
    return undefined;
  }

  const roles = entry.roles ?? (["paths"] as const);
  const policy = entry.optionPolicy ?? "deny-list";
  const optionPathValues: string[] = [];
  let cancel: string | undefined;
  let dynamicArg = false;
  let sawScript = false;
  const setCancel = (value: string): void => {
    cancel ??= value;
  };
  const markDynamicArg = (): void => {
    dynamicArg = true;
  };

  for (const token of argv.tokens) {
    if (token.kind === "option") {
      checkOptionToken(token, entry, policy, optionPathValues, setCancel, markDynamicArg);
      continue;
    }
    const index = token.positionalIndex ?? 0;
    const prefixCount = prefixPositionalCount(entry);
    if (index < prefixCount) {
      continue;
    }
    // 角色序列从**档案前缀之后**开始编号（`git grep` 的 `grep` 占据了序号 0，但它是前缀）。
    const role = roleAt(roles, index - prefixCount);
    if (role === undefined) {
      // `roles: []` 的含义是“不允许位置参数”：`git branch <新分支名>` 会造分支、
      // `node --version x` 属于没见过的形态，都只能按取消处理。
      setCancel(`unexpected-arg:${token.text}`);
      continue;
    }
    if (role !== "script") {
      continue;
    }
    sawScript = true;
    if (token.dynamic) {
      setCancel("dynamic-arg");
      markDynamicArg();
    } else if (!matchesScript(entry.script, token.text)) {
      setCancel("script-not-allowed");
    }
  }

  // 声明了 script 角色（且给了模式集）时，脚本必须存在且可核实：`sed --version` 这类
  // 没有脚本体可核实的调用一律取消，要放行就单独写一条 `argv` 前缀更具体的档案。
  if (
    roles.includes("script") &&
    entry.script !== undefined &&
    entry.script.length > 0 &&
    !sawScript
  ) {
    setCancel("script-not-allowed");
  }

  const plan: ReadOnlyPlan = { entry, roles, optionPathValues };
  if (cancel !== undefined) {
    plan.cancel = cancel;
  }
  if (dynamicArg) {
    plan.dynamicArg = true;
  }
  return plan;
}

function checkOptionToken(
  token: ArgvToken,
  entry: ReadOnlyCommandProfile,
  policy: "deny-list" | "allow-list",
  optionPathValues: string[],
  setCancel: (value: string) => void,
  markDynamicArg: () => void,
): void {
  const key = optionKey(token.raw);
  const unsafe = matchOptionEntry(entry.unsafeOptions, key);
  if (unsafe !== undefined) {
    setCancel(`unsafe-option:${unsafe}`);
    // 取值不可静态确定的写/执行类选项：除了取消免评审，还要交代"看不透"这件事。
    if (token.embedded?.dynamic === true) {
      markDynamicArg();
    }
    return;
  }
  const safe = matchOptionEntry(entry.safeOptions, key) !== undefined;
  if (policy === "allow-list" && !safe) {
    setCancel(`option-not-allowed:${key}`);
    if (token.embedded?.dynamic === true) {
      markDynamicArg();
    }
    return;
  }
  if (safe) {
    // 已声明安全：不看取值（`--glob=<路径形状>` 这类正是要靠它豁免的形状规则）。
    return;
  }
  if (token.embedded !== undefined) {
    if (token.embedded.dynamic) {
      setCancel(`option-not-allowed:${key}`);
      markDynamicArg();
      return;
    }
    if (looksLikePath(token.embedded.text)) {
      setCancel(`option-path-value:${key}`);
      optionPathValues.push(token.embedded.text);
    }
    return;
  }
  // `--$X` 这类选项名本身不可静态确定，无法比对两个名单。
  if (token.dynamic) {
    setCancel(`option-not-allowed:${key}`);
    markDynamicArg();
  }
}

/** 只读判定的输入。用对象传参是为了让每个条件在调用处都有名字。 */
export interface ReadOnlyInput {
  /** 命中的档案计划；未命中为 undefined。 */
  plan: ReadOnlyPlan | undefined;
  /** 该命令单元的全部路径目标（参数 + 重定向）。 */
  paths: readonly PathTarget[];
  /** 单元的可信性；不可信就不能算只读。 */
  unresolved?: UnresolvedCause;
}

/**
 * 命令单元是否属于"只读且无写副作用"（FR-9 / FR-65：命中即可免评审放行）。
 *
 * 三个条件缺一不可：
 * 1. 命中档案，且档案检查全部通过（`plan.cancel` 为空）；
 * 2. 单元本身可信——否则 `cat $f` 会因为"`cat` 是只读的"而放行一个读向未知文件的命令；
 * 3. 没有写方向的路径（含重定向）——否则 `cat > /etc/hosts` 会被 `cat` 放行。
 *
 * 第 3 条里的"写方向"不含写入空设备的目标（`2>/dev/null`、`> NUL`）：那些由重定向层
 * 直接不产出路径目标（FR-67），因此这里天然只看真实文件。
 */
export function isReadOnlyUnit(input: ReadOnlyInput): boolean {
  if (input.plan === undefined || input.unresolved !== undefined) {
    return false;
  }
  if (input.plan.cancel !== undefined) {
    return false;
  }
  if (rootsCancelReason(input.plan, input.paths) !== undefined) {
    return false;
  }
  return input.paths.every((path) => path.direction === "read");
}

/**
 * 档案要求“目标必须在项目根内”（`onlyWithinRoots`）时的取消原因（FR-65/FR-69）。
 *
 * 单独导出是因为它需要路径目标，而 `planReadOnly` 只看 argv：
 * `isReadOnlyUnit` 用它做判定，事实层用它填 `readOnlyCancel`。
 */
export function rootsCancelReason(
  plan: ReadOnlyPlan,
  paths: readonly PathTarget[],
): string | undefined {
  if (plan.entry.onlyWithinRoots !== true) {
    return undefined;
  }
  if (paths.length === 0) {
    return "no-path-target";
  }
  return paths.some((path) => path.external) ? "outside-roots" : undefined;
}
