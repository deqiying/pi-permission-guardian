import type { ResolvedConfig } from "../config/merge.ts";
import {
  EXTERNAL_DIRECTORY_SURFACE,
  PATH_SURFACE,
  isBuiltinTool,
  toolSurface,
} from "../facts/classify.ts";
import type {
  CommandUnit,
  Direction,
  Facts,
  PathTarget,
  UnresolvedCause,
} from "../facts/types.ts";
import { compareActions, strictestAction, type Action } from "./action.ts";
import type { CompiledRule, CompiledRuleTable } from "./rules.ts";

/**
 * 规则求值（FR-4~FR-8、FR-59、FR-61、architecture §4.2、§6.2）。
 *
 * 三步：
 * 1. 把 facts 摊成"被裁决对象"（命令单元 / 路径 / 工具本身），见 `buildPolicyObjects`；
 * 2. 每个对象独立求值（层内 last-match-wins、跨层最严格者、baseline 只在用户层全未命中时参与）；
 * 3. 按固定优先级把对象动作合成为调用级动作。
 *
 * 为什么对象要分开求值：`read ./.env` 的工具面是 `read`（默认 `allow`）、路径面是 `path_read`
 * （用户规则 `*.env → deny`）。把它们塞进同一个对象会让默认 `allow` 与用户 `deny` 的比较
 * 变成"同层两条规则"的问题，而它实际是"两个独立面各自投票"——`never-weaker` 要求它们都保留。
 */

export type PolicyObjectKind = "command" | "path" | "tool";

export interface PolicyObject {
  kind: PolicyObjectKind;
  /**
   * 参与求值的 surface 列表。
   *
   * 不含 `*` 兜底面——`rule.surface === "*"` 的规则由求值器统一追加，避免每个对象都要记得带上它。
   */
  surfaces: string[];
  /** glob 匹配目标：命令单元文本 + 调用级文本 / 路径的词法形与真实形 / 工具名。 */
  targets: string[];
  /** 生成授权建议模式（FR-30）与审计 targets 用的主目标。 */
  primary: string;
  /** 路径对象的方向；命令与工具对象为 undefined。 */
  direction?: Direction;
  /** 只读命令白名单命中且无写副作用（仅命令单元，FR-9）。 */
  readOnly: boolean;
  /** 该对象来自不可静态确定的构造，求值结果不可信（FR-14、FR-61）。 */
  unresolved?: UnresolvedCause;
  /** 供审计与人工提示展示的文本。 */
  label: string;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** 命令单元对象：surface 是工具面（bash / powershell），匹配目标是单元文本与调用级文本（FR-62）。 */
function commandObject(
  unit: CommandUnit,
  surface: string,
  compositeTexts: readonly string[],
): PolicyObject {
  const object: PolicyObject = {
    kind: "command",
    surfaces: [surface],
    targets: dedupe([unit.text, ...compositeTexts]),
    primary: unit.text,
    readOnly: unit.readOnly,
    label: unit.text,
  };
  if (unit.unresolved !== undefined) {
    object.unresolved = unit.unresolved;
  }
  return object;
}

/**
 * 路径对象：同时携带方向面与（外部路径时的）外部目录面。
 *
 * `external_directory_*` 只对确实在工作目录之外的目标参与求值，否则用户为外部目录写的规则
 * 会顺带作用于工作目录内的文件（classify.ts 的既定语义）。
 */
function pathObject(path: PathTarget, unresolved: UnresolvedCause | undefined): PolicyObject {
  const surfaces = [PATH_SURFACE[path.direction]];
  if (path.external) {
    surfaces.push(EXTERNAL_DIRECTORY_SURFACE[path.direction]);
  }
  const targets = [path.lexical];
  if (path.canonical !== undefined && path.canonical !== path.lexical) {
    targets.push(path.canonical);
  }
  const object: PolicyObject = {
    kind: "path",
    surfaces,
    targets,
    primary: path.lexical,
    direction: path.direction,
    readOnly: false,
    label: path.raw === path.lexical ? path.lexical : `${path.raw} → ${path.lexical}`,
  };
  if (unresolved !== undefined) {
    object.unresolved = unresolved;
  }
  return object;
}

/** 工具对象：未识别 / 自定义工具的 surface 追加 `tool` 哨兵（同时保留按工具名精确写规则的能力）。 */
function toolObject(toolName: string, surface: string): PolicyObject {
  const surfaces = isBuiltinTool(toolName)
    ? [surface]
    : dedupe([surface, "tool"]);
  return {
    kind: "tool",
    surfaces,
    targets: [toolName],
    primary: toolName,
    readOnly: false,
    label: toolName,
  };
}

/** 命令类工具：它们的 surface 由命令单元承载。 */
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

/**
 * 把一次调用的 facts 摊成被裁决对象。
 *
 * 命令类调用（bash / powershell）以**命令单元**为对象：`unresolved + trusted deny -> ask`（FR-61）
 * 与跨单元混合动作（FR-59）都要求逐个单元知道自己的动作与可信性。
 *
 * 路径类工具补一个工具对象，让工具面规则与默认矩阵有投票的载体。命令类工具**不**补：
 * - 有命令单元时补了会让默认矩阵的 `review` 压过单元级的只读白名单放行（FR-9）；
 * - 没有命令单元时（空命令、只有注释，或 `2>&1` 这种描述符复制）本来就没有可执行的东西，
 *   事实层也刻意不为它们造假对象，这里再补一个只会让无害语句招来人工确认。
 */
export function buildPolicyObjects(facts: Facts, toolName: string): PolicyObject[] {
  const surface = toolSurface(toolName);
  const compositeTexts = facts.compositeTexts ?? [];
  const objects: PolicyObject[] = [];

  if (facts.commands.length > 0) {
    for (const unit of facts.commands) {
      objects.push(commandObject(unit, surface, compositeTexts));
      for (const path of unit.paths) {
        objects.push(pathObject(path, unit.unresolved));
      }
    }
    return objects;
  }

  if (!COMMAND_TOOLS.has(toolName)) {
    objects.push(toolObject(toolName, surface));
  }
  for (const path of facts.paths) {
    objects.push(pathObject(path, undefined));
  }
  return objects;
}

export type ObjectActionSource = "rule" | "baseline" | "read-only" | "unresolved";

export interface ObjectEvaluation {
  object: PolicyObject;
  /** 该对象的动作；`undefined` 表示"不表态"（没命中任何规则，也不是只读白名单）。 */
  action?: Action;
  source?: ObjectActionSource;
  matchedPattern?: string;
  matchedSurface?: string;
  matchedLayer?: string;
  reason?: string;
}

const READ_ONLY_REASON = "命中只读命令白名单（FR-9）";
const UNRESOLVED_REASON = "该对象无法静态确定执行内容（FR-14）";

/** 层内 last-match-wins：按 (layer, surface) 分组，各取 index 最大的一条。 */
function lastMatchPerGroup(rules: readonly CompiledRule[]): CompiledRule[] {
  const groups = new Map<string, CompiledRule>();
  for (const rule of rules) {
    const key = `${rule.layer}\u0000${rule.surface}`;
    const current = groups.get(key);
    if (current === undefined || rule.index >= current.index) {
      groups.set(key, rule);
    }
  }
  return [...groups.values()];
}

/** 跨组取最严格者；同严格度时保留先出现的，保证结果确定。 */
function strictestRule(rules: readonly CompiledRule[]): CompiledRule {
  let strictest = rules[0] as CompiledRule;
  for (const rule of rules) {
    if (compareActions(rule.action, strictest.action) < 0) {
      strictest = rule;
    }
  }
  return strictest;
}

function ruleResult(
  object: PolicyObject,
  source: ObjectActionSource,
  rule: CompiledRule,
): ObjectEvaluation {
  const evaluation: ObjectEvaluation = {
    object,
    action: rule.action,
    source,
    matchedPattern: rule.pattern,
    matchedSurface: rule.surface,
    matchedLayer: rule.layer,
  };
  if (rule.reason !== undefined) {
    evaluation.reason = rule.reason;
  }
  return evaluation;
}

/**
 * 单个对象的规则求值。
 *
 * 优先级（这是"用户显式决定 > 事实层免评审宽松 > 失败分支/默认矩阵"的落点）：
 * 1. 任一**用户层**（global / project）命中 → 取用户层结果。命中即完全屏蔽后面的步骤，
 *    这样 `permission.bash["rm -rf ./dist"] = "allow"` 不会被默认矩阵的 `review` 推翻，
 *    也不会被只读白名单的 `allow` 悄悄改成另一种理由。
 * 2. 命中只读白名单且无写副作用 → `allow`（FR-9）。
 * 3. 对象不可静态确定（bash 解析失败 / opaque 包装器 / 动态路径 / PowerShell）→ `unresolvedAction`
 *    （`onUnresolvedFacts`）。它**取代**默认矩阵，而不是取代整个调用的结果：PowerShell 的每个
 *    单元都是 `unresolved`，若让调用级分支覆盖已求值结果，显式的 `permission.powershell = "ask"`
 *    会被 `onUnresolvedFacts` 的默认 `review` 悄悄放宽。
 * 4. 否则才轮到 baseline 兜底（§6.1：baseline 是兜底层，不是普通一层）。
 * 5. 都没有 → 不表态。
 */
export function evaluateObject(
  object: PolicyObject,
  table: CompiledRuleTable,
  unresolvedAction: Action,
): ObjectEvaluation {
  const candidateSurfaces = new Set([...object.surfaces, "*"]);
  const matched = table.rules.filter(
    (rule) =>
      candidateSurfaces.has(rule.surface) &&
      object.targets.some((target) => rule.matcher(target)),
  );

  const userMatched = matched.filter((rule) => rule.layer !== "baseline");
  if (userMatched.length > 0) {
    return ruleResult(object, "rule", strictestRule(lastMatchPerGroup(userMatched)));
  }

  if (object.readOnly) {
    return { object, action: "allow", source: "read-only", reason: READ_ONLY_REASON };
  }

  if (object.unresolved !== undefined) {
    return {
      object,
      action: unresolvedAction,
      source: "unresolved",
      reason: UNRESOLVED_REASON,
    };
  }

  const baselineMatched = matched.filter((rule) => rule.layer === "baseline");
  if (baselineMatched.length > 0) {
    return ruleResult(object, "baseline", strictestRule(lastMatchPerGroup(baselineMatched)));
  }

  return { object };
}

/** 调用级动作的来源判定。 */
export type CallCause = "objects" | "unresolved-deny" | "mixed" | "unresolved";

export interface CallEvaluation {
  /** 规则层得出的调用级动作（未经过 review→ask、失败分支与授权放宽）。 */
  action: Action;
  cause: CallCause;
  evaluations: ObjectEvaluation[];
  /** `cause === "objects"` 时决定最终动作的对象。 */
  decisive?: ObjectEvaluation;
}

export interface EvaluateCallInput {
  facts: Facts;
  toolName: string;
  config: ResolvedConfig;
  table: CompiledRuleTable;
}

/** 命中对象动作的最严格者（同严格度时取先出现的，保证结果确定）。 */
function strictestEvaluation(
  evaluations: readonly ObjectEvaluation[],
): ObjectEvaluation | undefined {
  let strictest: ObjectEvaluation | undefined;
  for (const evaluation of evaluations) {
    if (evaluation.action === undefined) {
      continue;
    }
    if (
      strictest?.action === undefined ||
      compareActions(evaluation.action, strictest.action) < 0
    ) {
      strictest = evaluation;
    }
  }
  return strictest;
}

/**
 * 调用级合成，固定优先级见 architecture §4.2：
 * 1. 有不可信对象、且至少一个**可信**对象明确 `deny` → 固定 `ask`（FR-61，不受 `onUnresolvedFacts` 放宽）；
 * 2. 同一 shell 调用的多个命令单元同时出现 `allow` 与 `deny` → `onMixedCommandActions`（FR-59）；
 * 3. 其余情况 → 所有对象动作的最严格者；没有任何对象表态时 `allow`（无事发生）。
 *
 * 不可信对象的动作已在 `evaluateObject` 里换成 `onUnresolvedFacts`（而不是在这里覆盖整个调用），
 * 因此显式规则不会被默认值放宽，反过来 `onUnresolvedFacts` 也不会被默认矩阵架空。
 */
export function evaluateCall(input: EvaluateCallInput): CallEvaluation {
  const evaluations = buildPolicyObjects(input.facts, input.toolName).map((object) =>
    evaluateObject(object, input.table, input.config.onUnresolvedFacts),
  );
  const actions = evaluations
    .map((evaluation) => evaluation.action)
    .filter((action): action is Action => action !== undefined);

  const trustedDeny = evaluations.some(
    (evaluation) =>
      evaluation.action === "deny" && evaluation.object.unresolved === undefined,
  );
  const hasUnresolved = evaluations.some(
    (evaluation) => evaluation.object.unresolved !== undefined,
  );
  const commandActions = evaluations
    .filter((evaluation) => evaluation.object.kind === "command")
    .map((evaluation) => evaluation.action)
    .filter((action): action is Action => action !== undefined);
  const mixed = commandActions.includes("allow") && commandActions.includes("deny");

  if (hasUnresolved && trustedDeny) {
    return { action: "ask", cause: "unresolved-deny", evaluations };
  }
  if (mixed) {
    return { action: input.config.onMixedCommandActions, cause: "mixed", evaluations };
  }

  const decisive = strictestEvaluation(evaluations);
  const evaluation: CallEvaluation = {
    action: strictestAction(actions) ?? "allow",
    cause: decisive?.source === "unresolved" ? "unresolved" : "objects",
    evaluations,
  };
  if (decisive !== undefined) {
    evaluation.decisive = decisive;
  }
  return evaluation;
}
