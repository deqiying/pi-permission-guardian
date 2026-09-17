import type { Node as SyntaxNode } from "web-tree-sitter";

import { looksLikePath, makePathTarget } from "../path-value.ts";
import type { Direction, PathTarget, ReadOnlyCommandProfile } from "../types.ts";
import { buildArgv, type Argv } from "./argv.ts";
import {
  legacyProfiles,
  planPositionalRoles,
  planReadOnly,
  type ReadOnlyPlan,
} from "./readonly-commands.ts";

/**
 * 命令参数里的路径候选与读写效应归因（FR-15、FR-65）。
 *
 * 有两条归因路径，取决于是否命中只读档案：
 *
 * | 情形 | 哪些参数算路径 | 方向 |
 * |---|---|---|
 * | 命中档案 | 由档案的 `roles` 声明（`paths` 位置；`pattern` / `script` 不产出目标）；档案前缀自身消耗的词不算 | read |
 * | 未命中档案：导航命令（`cd` / `pushd` / `popd`） | 全部位置参数 | read |
 * | 未命中档案：写类文件命令（`rm` / `cp` / `tee` …） | 全部位置参数 | write |
 * | 未命中档案：其余命令 | 只把“看起来像路径”的参数当路径 | write（fail-closed） |
 *
 * 未命中档案时的口径与旧实现完全一致（D29：不声明档案就不改变行为）；命中档案后才启用
 * 角色模型，因此 `rg -n "\.env" src/` 的**模式**不会再被当成路径去撞 `*.env` 规则。
 *
 * `--opt=value` 的边缘：命中档案时，未声明安全的带值选项只在“值像路径”时产出目标并取消免评审
 * （旧口径，形状规则）；未命中档案时仍按旧口径产出目标。
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
  /** argv 的文本形式（已去引号），用于规则匹配、日志与包装器判断。 */
  words: string[];
  paths: PathTarget[];
  /**
   * 需要升级为单元级 `unresolved` 的动态取值。
   *
   * 命中档案时只看**路径位置**；未命中档案时沿用旧口径（任意位置出现动态取值即升级）。
   */
  dynamic: boolean;
  /** 命中的只读档案计划（未命中为 undefined）。 */
  readOnlyPlan?: ReadOnlyPlan;
}

export interface CommandArgOptions {
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  roots: readonly string[];
  /** 旧白名单条目（字符串形态）：按“全部位置参数都是路径”的档案处理。 */
  readOnlyCommands: readonly string[];
  /** 结构化档案（内置分组 + 用户条目）；缺省表示只有旧条目。 */
  readOnlyProfiles?: readonly ReadOnlyCommandProfile[];
  /**
   * 透明前缀内推（FR-12 修订）：从第几个参数开始才是真正要执行的命令。
   * 缺省 0（整个 argv 就是这条命令）。此时 `executable` 必须已经是**内层**命令名。
   */
  startArgument?: number;
}

/**
 * 分析一个 `command` 节点的参数。
 *
 * `executable` 用于决定归因方向与档案匹配；重定向由调用方单独处理，这里只看参数。
 */
export function analyzeCommandArgs(
  node: SyntaxNode,
  executable: string | undefined,
  options: CommandArgOptions,
): CommandArgAnalysis {
  const argv = buildArgv(node, executable, {
    home: options.home,
    cwd: options.cwd,
    ...(options.startArgument === undefined ? {} : { startArgument: options.startArgument }),
  });
  const profiles = [
    ...(options.readOnlyProfiles ?? []),
    ...legacyProfiles(options.readOnlyCommands),
  ];
  const plan = planReadOnly(argv, profiles);
  if (plan !== undefined) {
    return profiledAnalysis(argv, plan, options);
  }
  return legacyAnalysis(argv, executable, options);
}

function targetOptions(options: CommandArgOptions) {
  return {
    cwd: options.cwd,
    platform: options.platform,
    roots: options.roots,
  };
}

/** 命中档案：按角色归因，方向固定 read（档案只用于“只读命令”）。 */
function profiledAnalysis(
  argv: Argv,
  plan: ReadOnlyPlan,
  options: CommandArgOptions,
): CommandArgAnalysis {
  const paths: PathTarget[] = [];
  // 档案自己报出的“看不透”的动态取值（未声明安全的带值选项、动态选项名）也要升级为不可信。
  let dynamic = plan.dynamicArg === true;
  // 角色分配与判定共用同一实现（FR-65）：已跳过档案前缀与“取值不是文件”的选项取值。
  for (const { token, role } of planPositionalRoles(
    argv,
    plan.entry,
    plan.valueTokenIndexes,
  )) {
    if (role !== "paths") {
      continue;
    }
    dynamic = dynamic || token.dynamic;
    if (token.text.length === 0) {
      continue;
    }
    paths.push(makePathTarget(token.text, "read", "arg", targetOptions(options)));
  }
  // 未声明安全的带值选项：值像路径时按旧口径产出 read 目标（并已由档案判定取消免评审）。
  for (const value of plan.optionPathValues) {
    paths.push(makePathTarget(value, "read", "arg", targetOptions(options)));
  }
  return { words: argv.words, paths, dynamic, readOnlyPlan: plan };
}

/** 未命中档案：旧口径（白名单字符串条目已被 `legacyProfiles` 变成档案，因此这里只剩形态启发式）。 */
function legacyAnalysis(
  argv: Argv,
  executable: string | undefined,
  options: CommandArgOptions,
): CommandArgAnalysis {
  const navigation = executable !== undefined && READ_PATH_COMMANDS.has(executable);
  const direction: Direction = navigation ? "read" : "write";
  const allArgsArePaths =
    navigation ||
    (executable !== undefined && WRITE_PATH_COMMANDS.has(executable));

  const paths: PathTarget[] = [];
  let dynamic = false;
  for (const token of argv.tokens) {
    if (token.kind === "option") {
      if (token.embedded !== undefined) {
        dynamic = dynamic || token.embedded.dynamic;
        if (token.embedded.text.length > 0 && looksLikePath(token.embedded.text)) {
          paths.push(
            makePathTarget(token.embedded.text, direction, "arg", targetOptions(options)),
          );
        }
      }
      continue;
    }
    dynamic = dynamic || token.dynamic;
    if (!allArgsArePaths && !looksLikePath(token.text)) {
      continue;
    }
    if (token.text.length === 0) {
      continue;
    }
    paths.push(makePathTarget(token.text, direction, "arg", targetOptions(options)));
  }
  return { words: argv.words, paths, dynamic };
}
