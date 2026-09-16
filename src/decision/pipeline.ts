import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import { DECISION_ENTRY_TYPE, type DecisionSource } from "../audit/entry.ts";
import type { AuditLogger } from "../audit/logger.ts";
import type { ResolvedConfig } from "../config/merge.ts";
import { isBuiltinTool, toolSurface } from "../facts/classify.ts";
import { extractFacts } from "../facts/extract.ts";
import type { Facts, FactsContext } from "../facts/types.ts";
import type { GuardianRuntime } from "../extension/state.ts";
import { askHuman } from "../interact/dialog.ts";
import {
  evaluateCall,
  type CallEvaluation,
  type ObjectEvaluation,
  type PolicyObject,
} from "../policy/evaluate.ts";
import { compileRuleTable, type CompiledRuleTable } from "../policy/rules.ts";
import {
  encodeGrantKey,
  formatGrantKey,
  grantKeysForObjects,
  isCallGranted,
} from "../policy/session-grants.ts";
import { withAntiCircumvention, type DecisionOutcome } from "./outcome.ts";

/**
 * 最小决策管线（M3，architecture §4）。
 *
 * 顺序：engaged → classify → facts → gate → rule → grant → review → ask → outcome。
 * - **grant 在 rule 之后**：授权只能把 `ask` / `review` 放宽为 `allow`，永不覆盖 `deny`，
 *   且 `unresolved` 调用不享受授权（用户决策 2026-01，见 docs/architecture.md §4/§8.1）。
 * - **review 在本阶段一律转 `ask`**：评审层是 M4 的事，提前把 review 当成 allow 会静默放行。
 * - 缓存与熔断是 M5 的事，这里不预留空壳。
 */

export interface DecisionEngineDeps {
  pi: ExtensionAPI;
  runtime: GuardianRuntime;
  audit: AuditLogger;
  /** 事实层环境；缺省取宿主进程的 home / platform。测试注入用。 */
  env?: { home?: string; platform?: NodeJS.Platform };
  warn?: (message: string) => void;
}

export interface DecisionEngine {
  /** `tool_call` 事件入口；返回 `undefined` 表示放行。 */
  handleToolCall(
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined>;
  /** 只做裁决、不做返回协议映射的入口，供测试与后续入口（M4 user_bash）复用。 */
  decideToolCall(
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<DecisionOutcome | undefined>;
}

/**
 * gate：哪些工具调用进入规则求值（FR-2、architecture §4.0）。
 *
 * `side-effect` 覆盖全部 pi 内置工具；`all` 额外包含自定义工具与 MCP 工具；`extraTools`
 * 是显式的追加名单。**没覆盖就完全不参与**，而不是"评估后放行"。
 */
export function isGated(toolName: string, config: ResolvedConfig): boolean {
  if (config.extraTools.includes(toolName) || isBuiltinTool(toolName)) {
    return true;
  }
  return config.gate === "all";
}

/**
 * 把 `workingDirectory.allowRoots` 展开为绝对路径（FR-16 的 facts 契约）。
 *
 * 事实层只有"路径"概念、没有会话 cwd，因此相对路径与 `~` 必须由组装 FactsContext 的一方
 * （也就是这里）展开；事实层对相对形式的根目录一律判为外部（宁可判外部）。
 */
export function expandRoots(
  cwd: string,
  allowRoots: readonly string[],
  home: string,
  platform: NodeJS.Platform,
): string[] {
  const paths = platform === "win32" ? win32 : posix;
  const roots = [cwd];
  for (const root of allowRoots) {
    const expanded = expandHomePrefix(root, home);
    roots.push(paths.isAbsolute(expanded) ? paths.normalize(expanded) : paths.resolve(cwd, expanded));
  }
  return roots;
}

function expandHomePrefix(value: string, home: string): string {
  const trimmed = home.replace(/[\\/]+$/, "");
  for (const prefix of ["~/", "$HOME/", "${HOME}/"]) {
    if (value.startsWith(prefix)) {
      return `${trimmed}/${value.slice(prefix.length)}`;
    }
  }
  for (const exact of ["~", "$HOME", "${HOME}"]) {
    if (value === exact) {
      return trimmed;
    }
  }
  return value;
}

export function createDecisionEngine(deps: DecisionEngineDeps): DecisionEngine {
  const home = deps.env?.home ?? homedir();
  const platform = deps.env?.platform ?? process.platform;
  const globOptions = { home, platform };
  const warn = deps.warn ?? ((message: string): void => console.warn(message));

  let cachedTableVersion = -1;
  let cachedTableConfig: ResolvedConfig | undefined;
  let cachedTable: CompiledRuleTable | undefined;

  /** 规则表按配置版本缓存；glob 编译只依赖 home / platform，与会话无关。 */
  function ruleTable(config: ResolvedConfig): CompiledRuleTable {
    if (
      cachedTable === undefined ||
      cachedTableConfig !== config ||
      cachedTableVersion !== deps.runtime.configVersion
    ) {
      cachedTable = compileRuleTable(config, globOptions);
      cachedTableConfig = config;
      cachedTableVersion = deps.runtime.configVersion;
    }
    return cachedTable;
  }

  function record(
    ctx: ExtensionContext,
    event: ToolCallEvent,
    toolName: string,
    outcome: DecisionOutcome,
    latencyMs: number,
  ): void {
    deps.runtime.callIndex += 1;
    const callIndex = deps.runtime.callIndex;
    try {
      deps.audit.record({
        ts: new Date().toISOString(),
        sessionId: ctx.sessionManager.getSessionId(),
        toolCallId: event.toolCallId,
        callIndex,
        toolName,
        surface: outcome.surface ?? toolSurface(toolName),
        targets: outcome.targets,
        matchedPattern: outcome.matchedPattern,
        action: outcome.final,
        source: outcome.source,
        latencyMs,
        reason: outcome.reason,
      });
    } catch (error) {
      // 审计只是观测面：写日志失败不能让裁决跟着失败。
      warn(`[pi-permission-guardian] 审计条目构造失败：${describeError(error)}`);
    }
    try {
      deps.pi.appendEntry(DECISION_ENTRY_TYPE, {
        timestamp: new Date().toISOString(),
        toolName,
        toolCallId: event.toolCallId,
        decision: outcome.final,
        source: outcome.source,
        surface: outcome.surface ?? toolSurface(toolName),
        matchedPattern: outcome.matchedPattern,
        reason: outcome.reason,
      });
    } catch (error) {
      // 会话内记录同样不进入关键路径。
      warn(`[pi-permission-guardian] appendEntry 失败：${describeError(error)}`);
    }
  }

  async function decideToolCall(
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<DecisionOutcome | undefined> {
    if (!deps.runtime.engaged) {
      return undefined;
    }
    const toolName = event.toolName;
    if (typeof toolName !== "string" || toolName.length === 0) {
      return undefined;
    }

    const config = deps.runtime.config;
    if (config === undefined) {
      // FR：runtime.config 为 undefined 表示本会话尚未成功加载配置，必须 fail-closed，
      // 不能当成"未安装护栏"而放行（extension/state.ts 的既有契约）。
      return {
        proposed: "deny",
        final: "deny",
        source: "policy",
        reason: withAntiCircumvention("配置尚未加载，按 fail-closed 拦截。"),
        surface: toolSurface(toolName),
        targets: [],
      };
    }

    if (!isGated(toolName, config)) {
      return undefined;
    }

    const started = Date.now();
    const factsContext: FactsContext = {
      cwd: ctx.cwd,
      platform,
      home,
      roots: expandRoots(ctx.cwd, config.workingDirectory.allowRoots, home, platform),
      readOnlyCommands: config.workingDirectory.readOnlyCommands,
    };

    let facts: Facts;
    let call: CallEvaluation;
    try {
      facts = await extractFacts(toolName, event.input, factsContext);
      call = evaluateCall({ facts, toolName, config, table: ruleTable(config) });
    } catch (error) {
      // §9 最后一行：插件内部异常必须显式阻断，不能依赖 pi"handler 抛错即阻断"的行为。
      const outcome: DecisionOutcome = {
        proposed: "deny",
        final: "deny",
        source: "policy",
        reason: withAntiCircumvention(
          `护栏内部异常，按 fail-closed 拦截：${describeError(error)}`,
        ),
        surface: toolSurface(toolName),
        targets: [],
      };
      record(ctx, event, toolName, outcome, Date.now() - started);
      return outcome;
    }

    const outcome = await resolveOutcome({ call, facts, toolName, config, ctx });
    record(ctx, event, toolName, outcome, Date.now() - started);
    return outcome;
  }

  interface ResolveInput {
    call: CallEvaluation;
    facts: Facts;
    toolName: string;
    config: ResolvedConfig;
    ctx: ExtensionContext;
  }

  async function resolveOutcome(input: ResolveInput): Promise<DecisionOutcome> {
    const { call, config, ctx } = input;
    const proposed = call.action;
    const surface = call.decisive?.object.surfaces[0] ?? toolSurface(input.toolName);
    const targets = collectTargets(call);

    let action = call.action;
    let source: DecisionSource = "policy";
    let reason = describeReason(call, config);
    let matchedPattern = call.decisive?.matchedPattern;

    // 需要授权的对象 = 动作落在 ask / review 的对象；与创建授权时的对象集合保持一致。
    const grantedObjects = call.evaluations
      .filter(
        (evaluation) =>
          evaluation.action === "ask" || evaluation.action === "review",
      )
      .map((evaluation) => evaluation.object);
    const hasUnresolved = call.evaluations.some(
      (evaluation) => evaluation.object.unresolved !== undefined,
    );
    const anyDeny = call.evaluations.some(
      (evaluation) => evaluation.action === "deny",
    );

    if (config.yoloMode && (action === "ask" || action === "review")) {
      return {
        proposed,
        final: "allow",
        source: "policy",
        reason: "yoloMode 已开启：ask / review 全部放行（FR-53）。",
        surface,
        targets,
      };
    }

    if (
      (action === "ask" || action === "review") &&
      !hasUnresolved &&
      !anyDeny &&
      config.sessionGrants.enabled &&
      isCallGranted(grantedObjects, deps.runtime.grants.keys, globOptions)
    ) {
      action = "allow";
      source = "session-grant";
      reason = "本会话已批准该模式（FR-29）。";
      matchedPattern = undefined;
    }

    if (action === "review") {
      // M4 的评审层会在这里接管；M3 一律转人工，避免把 review 当成静默放行。
      action = "ask";
      reason = `${reason ?? ""} 评审层尚未接入，转人工确认。`.trim();
    }

    if (action === "ask") {
      const resolved = await resolveAsk({
        ctx,
        config,
        grantedObjects,
        input,
      });
      action = resolved.action;
      source = resolved.source;
      reason = resolved.reason;
    }

    const outcome: DecisionOutcome = {
      proposed,
      final: action === "deny" ? "deny" : "allow",
      source,
      surface,
      targets,
    };
    if (action === "deny") {
      outcome.reason = withAntiCircumvention(reason);
    } else if (reason !== undefined) {
      outcome.reason = reason;
    }
    if (matchedPattern !== undefined) {
      outcome.matchedPattern = matchedPattern;
    }
    return outcome;
  }

  interface ResolveAskInput {
    ctx: ExtensionContext;
    config: ResolvedConfig;
    grantedObjects: readonly PolicyObject[];
    input: ResolveInput;
  }

  async function resolveAsk(
    askInput: ResolveAskInput,
  ): Promise<{ action: "allow" | "deny"; source: DecisionSource; reason: string }> {
    const { ctx, config, grantedObjects, input } = askInput;

    if (!ctx.hasUI) {
      // FR-46：没有交互界面时按 onAskWithoutUI 处理。失败分支若指向 ask / review，
      // 在本阶段同样无法执行（review 已转 ask），必须 fail-closed 落到 deny。
      const fallback = config.onAskWithoutUI;
      if (fallback === "allow") {
        return {
          action: "allow",
          source: "policy",
          reason: "无交互界面可确认，按 onAskWithoutUI=allow 放行（FR-46）。",
        };
      }
      if (fallback === "deny") {
        return {
          action: "deny",
          source: "policy",
          reason: "无交互界面可确认，按 onAskWithoutUI=deny 拦截（FR-46）。",
        };
      }
      return {
        action: "deny",
        source: "policy",
        reason: `无交互界面可确认，onAskWithoutUI=${fallback} 在无 UI 时无法执行，按 fail-closed 拦截。`,
      };
    }

    const suggestions = config.sessionGrants.enabled
      ? grantKeysForObjects(grantedObjects).map((key) =>
          formatGrantKey(encodeGrantKey(key)),
        )
      : [];
    const decision = await askHuman(ctx, {
      summary: `工具 ${input.toolName} 提议动作 ${input.call.action}，需要确认。\n目标：${collectTargets(input.call).join(", ")}`,
      detail: describeObjects(input.call, input.facts),
      suggestions,
    });

    if (decision?.choice === "session") {
      for (const key of grantKeysForObjects(grantedObjects)) {
        deps.runtime.grants.keys.add(encodeGrantKey(key));
      }
      return {
        action: "allow",
        source: "human",
        reason: "人工确认：本会话允许此类（已写入会话授权记忆）。",
      };
    }
    if (decision?.choice === "once") {
      return { action: "allow", source: "human", reason: "人工确认：仅此次允许。" };
    }
    return {
      action: "deny",
      source: "human",
      reason:
        decision?.note === undefined
          ? "人工拒绝。"
          : `人工拒绝：${decision.note}`,
    };
  }

  return {
    decideToolCall,

    async handleToolCall(
      event: ToolCallEvent,
      ctx: ExtensionContext,
    ): Promise<ToolCallEventResult | undefined> {
      try {
        const outcome = await decideToolCall(event, ctx);
        if (outcome === undefined || outcome.final === "allow") {
          return undefined;
        }
        return {
          block: true,
          reason: outcome.reason ?? "被 pi-permission-guardian 拦截。",
        };
      } catch (error) {
        // 最后一道防线：任何未预料的异常都不能变成放行。
        const reason = withAntiCircumvention(
          `护栏内部异常，按 fail-closed 拦截：${describeError(error)}`,
        );
        warn(`[pi-permission-guardian] ${reason}`);
        return { block: true, reason };
      }
    },
  };
}

/** 审计用的目标主值：优先命令 / 路径，没有时退回工具名。 */
function collectTargets(call: CallEvaluation): string[] {
  const primaries = call.evaluations
    .filter(
      (evaluation) =>
        evaluation.action !== undefined && evaluation.object.kind !== "tool",
    )
    .map((evaluation) => evaluation.object.primary);
  const fallback = call.evaluations.map((evaluation) => evaluation.object.primary);
  return [...new Set(primaries.length > 0 ? primaries : fallback)];
}

const LAYER_LABEL: Record<string, string> = {
  global: "全局配置",
  project: "项目配置",
  baseline: "默认矩阵",
};

function describeRule(evaluation: ObjectEvaluation): string {
  if (evaluation.source === "read-only") {
    return "命中只读命令白名单（FR-9）";
  }
  if (evaluation.source === "unresolved") {
    return "对象无法静态确定执行内容（FR-14）";
  }
  if (evaluation.source === "baseline") {
    const label = evaluation.matchedSurface ?? "surface";
    return `未命中用户规则，按默认动作矩阵（${label} → ${evaluation.action}）处理`;
  }
  const layer = LAYER_LABEL[evaluation.matchedLayer ?? ""] ?? evaluation.matchedLayer ?? "";
  const head = `命中规则 "${evaluation.matchedPattern ?? "*"}"（${layer}）→ ${evaluation.action}`;
  return evaluation.reason === undefined ? head : `${head}：${evaluation.reason}`;
}

function describeReason(call: CallEvaluation, config: ResolvedConfig): string {
  switch (call.cause) {
    case "unresolved-deny":
      return "同一调用中同时存在无法静态确定的对象与明确拒绝的对象，固定转人工确认（FR-61）。";
    case "mixed":
      return `同一调用的多个命令单元动作冲突，按 onMixedCommandActions=${config.onMixedCommandActions} 处理（FR-59）。`;
    case "unresolved":
      return `调用无法静态确定执行内容，按 onUnresolvedFacts=${config.onUnresolvedFacts} 处理。`;
    case "objects":
      return call.decisive === undefined
        ? "没有对象对该调用表态，按放行处理。"
        : describeRule(call.decisive);
  }
}

/** 人工提示里的逐对象摘要：让用户看到"哪些对象各自被什么规则判成了什么"。 */
function describeObjects(call: CallEvaluation, facts: Facts): string {
  const lines = call.evaluations.map((evaluation) => {
    const action = evaluation.action ?? "（不表态）";
    const detail =
      evaluation.matchedPattern === undefined
        ? evaluation.source === "read-only"
          ? "只读白名单"
          : ""
        : `规则 "${evaluation.matchedPattern}"`;
    const unresolved =
      evaluation.object.unresolved === undefined
        ? ""
        : `｜不可静态确定（${evaluation.object.unresolved}）`;
    return `- ${evaluation.object.kind} ${evaluation.object.label} → ${action}${
      detail.length > 0 ? `（${detail}）` : ""
    }${unresolved}`;
  });
  if (facts.unresolved !== undefined) {
    lines.push(`- 整体不可静态确定：${facts.unresolved}`);
  }
  return lines.join("\n");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
