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
import type { Action } from "../policy/action.ts";
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
import { classifierAllows } from "../review/classifier.ts";
import { createEvidenceTools } from "../review/evidence.ts";
import { requestReview, type ReviewerRegistry } from "../review/reviewer.ts";
import { transcriptFromEntries } from "../review/transcript.ts";
import type { ReviewOutcome } from "../review/types.ts";
import {
  BREAKER_REASON,
  breakerBlocksFastPath,
  breakerTripped,
  recordBreakerAllow,
  recordBreakerDeny,
} from "./breaker.ts";
import {
  decisionCacheKey,
  isCacheable,
  readCache,
  writeCache,
} from "./cache.ts";
import { withAntiCircumvention, type DecisionOutcome } from "./outcome.ts";
import { applyReviewOutcome } from "./policy.ts";

/**
 * 决策管线（architecture §4）。
 *
 * 顺序：engaged → 配置已加载？ → gate → 熔断 → classify → facts → rule → grant → cache → 预评分
 * → review → ask → outcome → 熔断记账 → 写缓存。
 * - **配置未加载（FR-64）**：`runtime.config === undefined` 时走独立分支，按 schema 默认 gate 纳入
 *   裁决的调用转人工确认（无 UI 时 `deny`），不参与熔断与缓存（阈值与 key 来自读不到的配置）。
 * - **grant 在 rule 之后**：授权只能把 `ask` / `review` 放宽为 `allow`，永不覆盖 `deny`，
 *   且 `unresolved` 调用不享受授权（用户决策 2026-01，见 docs/architecture.md §4/§8.1）。
 * - **cache 在 grant 之后、review 之前**：只复用确定结论，且 `unresolved` 调用跳过（FR-31/32）。
 * - **预评分只放行**（FR-36）：它排在评审之前，但受 FR-35（被拒过的工具失去快路径）与
 *   `unresolved` 限制，永远不会产生 deny。
 * - **熔断（FR-34）**：本轮被拒绝的次数达阈值后，后续调用直接拦截并 `terminate` 本轮。
 * - **review 交评审模型**（M4）：结论还要过 FR-23 的风险门槛；评审不可用走 `onReviewUnavailable`。
 *
 * `tool_call` 与 `user_bash` 共用同一个内核：两个入口只负责把自己的事件形状翻译成
 * `DecisionRequest`，再把自己的返回协议贴回去，裁决逻辑只有一份。
 */

/** 一次待裁决的调用；两个入口唯一需要对齐的形状。 */
export interface DecisionRequest {
  origin: "tool_call" | "user_bash";
  toolName: string;
  toolCallId: string;
  input: unknown;
  /** 调用自己的工作目录；`user_bash` 用事件里的 cwd，缺省用 `ctx.cwd`。 */
  cwd?: string;
}

export interface DecisionEngineDeps {
  pi: ExtensionAPI;
  runtime: GuardianRuntime;
  audit: AuditLogger;
  /** 事实层环境；缺省取宿主进程的 home / platform。测试注入用。 */
  env?: { home?: string; platform?: NodeJS.Platform };
  warn?: (message: string) => void;
  /**
   * 每次结论落定后的观测回调（状态栏等）。
   *
   * 放在这里而不是两个入口各自实现：`tool_call` 与 `user_bash` 的结论必须产生同一份观测，
   * 否则不同入口会长出不同字段（M5 门禁）。回调不得影响返回值。
   */
  onDecision?: (outcome: DecisionOutcome, ctx: ExtensionContext) => void;
}

export interface DecisionEngine {
  /** `tool_call` 事件入口；返回 `undefined` 表示放行。 */
  handleToolCall(
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined>;
  /** `DecisionRequest` 入口；`user_bash` 与测试复用。 */
  decide(
    request: DecisionRequest,
    ctx: ExtensionContext,
  ): Promise<DecisionOutcome | undefined>;
  /** `tool_call` 事件 → `DecisionOutcome`，不做返回协议映射。 */
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
    roots.push(
      paths.isAbsolute(expanded) ? paths.normalize(expanded) : paths.resolve(cwd, expanded),
    );
  }
  return roots;
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

  /**
   * 评审层需要的能力面：只给 `find` / `complete`。
   *
   * 这个门面同时是"插件不能覆盖 wire 协议、认证、baseUrl"这条约束的类型级落点：
   * 评审层拿不到 registry 上的其他任何东西。
   */
  function registryFacade(ctx: ExtensionContext): ReviewerRegistry {
    return {
      find: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
      complete: (model, context, options) =>
        ctx.modelRegistry.complete(model, context, options),
    };
  }

  function record(
    ctx: ExtensionContext,
    request: DecisionRequest,
    outcome: DecisionOutcome,
    latencyMs: number,
    readOnlyCancel?: string,
  ): void {
    deps.runtime.callIndex += 1;
    const callIndex = deps.runtime.callIndex;
    deps.runtime.lastDecision = {
      final: outcome.final,
      source: outcome.source,
      toolName: request.toolName,
    };
    try {
      deps.audit.record({
        ts: new Date().toISOString(),
        sessionId: ctx.sessionManager.getSessionId(),
        toolCallId: request.toolCallId,
        callIndex,
        toolName: request.toolName,
        surface: outcome.surface ?? toolSurface(request.toolName),
        targets: outcome.targets,
        matchedPattern: outcome.matchedPattern,
        action: outcome.final,
        source: outcome.source,
        latencyMs,
        reason: outcome.reason,
        model: outcome.reviewerModel,
        verdict: outcome.verdict,
        evidenceRounds: outcome.evidenceRounds,
        ...(readOnlyCancel === undefined ? {} : { readOnlyCancel }),
      });
    } catch (error) {
      // 审计只是观测面：写日志失败不能让裁决跟着失败。
      warn(`[pi-permission-guardian] 审计条目构造失败：${describeError(error)}`);
    }
    try {
      deps.pi.appendEntry(DECISION_ENTRY_TYPE, {
        timestamp: new Date().toISOString(),
        origin: request.origin,
        toolName: request.toolName,
        toolCallId: request.toolCallId,
        decision: outcome.final,
        source: outcome.source,
        surface: outcome.surface ?? toolSurface(request.toolName),
        matchedPattern: outcome.matchedPattern,
        reviewerModel: outcome.reviewerModel,
        verdict: outcome.verdict,
        evidenceRounds: outcome.evidenceRounds,
        reason: outcome.reason,
        ...(readOnlyCancel === undefined ? {} : { readOnlyCancel }),
      });
    } catch (error) {
      // 会话内记录同样不进入关键路径。
      warn(`[pi-permission-guardian] appendEntry 失败：${describeError(error)}`);
    }
    try {
      deps.onDecision?.(outcome, ctx);
    } catch (error) {
      // 观测面（状态栏）失败同样不能影响裁决。
      warn(`[pi-permission-guardian] 决策观测回调失败：${describeError(error)}`);
    }
  }

  function failClosed(
    toolName: string,
    reason: string,
  ): DecisionOutcome {
    return {
      proposed: "deny",
      final: "deny",
      source: "policy",
      reason: withAntiCircumvention(reason),
      surface: toolSurface(toolName),
      targets: [],
    };
  }

  /**
   * FR-64：配置根本没加载出来时的落点。
   *
   * `runtime.config === undefined` 表示会话未启动、加载过程抛了异常，或 `/perm on` 在加载前
   * 强行启用（`extension/state.ts` 的既有契约）。此时读不到任何字段，因此：
   *
   * - 落点取 `ask`（人工确认）而不是 `deny`：配置未加载是护栏自身的状态，不是这次调用有风险。
   *   原实现的 fail-closed deny 会把“护栏自己没起来”报成“这次调用被拦了”，与 D26 的取向相反。
   * - 纳入裁决的范围按 schema 默认 gate（`side-effect`：pi 内置工具）：不能因为“读不出配置”
   *   就把自定义 / MCP 工具也拉进来 —— 安全方向应当是转人工，而不是扩大拦截面。
   * - 不提供“本会话允许此类”：`sessionGrants` 读不出来，不猜。
   * - 无交互界面时仍然落到 `deny`（读不到 `onAskWithoutUI`，fail-closed）。
   *
   * 熔断器与判定缓存都不参与：它们的阈值与 key 维度都来自读不到的配置。
   */
  async function decideUnloadedConfig(
    request: DecisionRequest,
    ctx: ExtensionContext,
  ): Promise<DecisionOutcome | undefined> {
    const { toolName } = request;
    if (!isBuiltinTool(toolName)) {
      return undefined;
    }

    const started = Date.now();
    const surface = toolSurface(toolName);
    const lead =
      "配置未加载（会话未启动或加载失败），护栏没有规则可评估这次调用（FR-64）。";

    if (!ctx.hasUI) {
      const outcome: DecisionOutcome = {
        proposed: "ask",
        final: "deny",
        source: "policy",
        reason: withAntiCircumvention(`${lead}无交互界面可确认，按 fail-closed 拦截。`),
        surface,
        targets: [],
      };
      record(ctx, request, outcome, Date.now() - started);
      return outcome;
    }

    const decision = await askHuman(ctx, {
      action: `工具 ${toolName}；配置未加载，没有规则可评估；目标：（无）`,
      rule: "护栏尚未加载配置（FR-64）",
      risk: "读不到任何规则与失败分支配置，无法判断这次调用是否安全。",
      note: `${lead}修好配置后用 /perm reload 重载。`,
      suggestion: "先修复并重载配置；确需执行时建议由你自己执行该命令。",
      suggestions: [],
    });

    // 只接受“仅此次”：会话授权需要 `sessionGrants` 配置，而它读不出来（强行收到按拒绝处理）。
    const allowed = decision?.choice === "once";
    const reason = allowed
      ? "人工确认（配置未加载）：仅此次允许。"
      : decision?.note === undefined
        ? "人工拒绝（配置未加载）。"
        : `人工拒绝（配置未加载）：${decision.note}`;
    const outcome: DecisionOutcome = {
      proposed: "ask",
      final: allowed ? "allow" : "deny",
      source: "human",
      surface,
      targets: [],
      reason: allowed ? reason : withAntiCircumvention(reason),
    };
    record(ctx, request, outcome, Date.now() - started);
    return outcome;
  }

  async function decide(
    request: DecisionRequest,
    ctx: ExtensionContext,
  ): Promise<DecisionOutcome | undefined> {
    if (!deps.runtime.engaged) {
      return undefined;
    }
    const { toolName } = request;
    if (typeof toolName !== "string" || toolName.length === 0) {
      return undefined;
    }

    const config = deps.runtime.config;
    if (config === undefined) {
      // FR-64：配置没加载出来时的落点是一条独立分支（人工确认，而不是 deny）。
      return decideUnloadedConfig(request, ctx);
    }

    if (!isGated(toolName, config)) {
      return undefined;
    }

    const started = Date.now();

    // 熔断（FR-34）：本轮已触发时，进入评估范围的调用一律拦截并提前结束本轮。
    // 检查放在 facts 之前：它只需要内存里的计数，不必为一条注定被拦的命令去解析 bash。
    if (breakerTripped(deps.runtime.breaker)) {
      const outcome: DecisionOutcome = {
        proposed: "deny",
        final: "deny",
        source: "circuit-breaker",
        reason: withAntiCircumvention(BREAKER_REASON),
        surface: toolSurface(toolName),
        targets: [],
        terminate: true,
      };
      record(ctx, request, outcome, Date.now() - started);
      return outcome;
    }

    // 命令实际执行的工作目录可能不同于会话 cwd（`user_bash` 事件自带 cwd）。
    const cwd = request.cwd ?? ctx.cwd;
    const factsContext: FactsContext = {
      cwd,
      platform,
      home,
      roots: expandRoots(cwd, config.workingDirectory.allowRoots, home, platform),
      readOnlyCommands: config.workingDirectory.readOnlyCommands,
      readOnlyProfiles: config.readOnlyProfiles,
      writeSinks: config.writeSinks,
    };

    let facts: Facts;
    let call: CallEvaluation;
    try {
      facts = await extractFacts(toolName, request.input, factsContext);
      const floor = defaultActionFloor(config);
      call = evaluateCall({
        facts,
        toolName,
        config,
        table: ruleTable(config),
        ...(floor === undefined ? {} : { defaultActionFloor: floor }),
      });
    } catch (error) {
      // §9 最后一行：插件内部异常必须显式阻断，不能依赖 pi"handler 抛错即阻断"的行为。
      const outcome = failClosed(
        toolName,
        `护栏内部异常，按 fail-closed 拦截：${describeError(error)}`,
      );
      record(ctx, request, outcome, Date.now() - started);
      return outcome;
    }

    const cacheKey = cacheKeyForCall(call, request, config, cwd);

    // 免评审被取消的原因（FR-69）：命中档案但被选项/重定向/脚本规则挡住时记一笔，
    // 让"为什么这条命令又去评审了"在审计里能直接回答。只作为观测字段传递，不进缓存对象。
    const readOnlyCancel = call.evaluations
      .map((evaluation) => evaluation.object.readOnlyCancel)
      .find((value) => value !== undefined);

    let outcome: DecisionOutcome;
    try {
      outcome = await resolveOutcome({ call, facts, request, config, ctx, cacheKey });
    } catch (error) {
      outcome = failClosed(
        toolName,
        `护栏内部异常，按 fail-closed 拦截：${describeError(error)}`,
      );
    }
    applyBreakerAccounting(outcome, toolName, config);
    storeCache(outcome, cacheKey, config);
    record(ctx, request, outcome, Date.now() - started, readOnlyCancel);
    return outcome;
  }

  /** 评审模型规格：`user_bash` 先用 `userBashPolicy.model`，否则用 `reviewer.model`（FR-60）。 */
  function reviewModelSpec(
    request: DecisionRequest,
    config: ResolvedConfig,
  ): string | undefined {
    return request.origin === "user_bash"
      ? (config.userBashPolicy.model ?? config.reviewer.model)
      : config.reviewer.model;
  }

  /**
   * 评审调用的推理强度（FR-19 的边界内，协议字段仍由模型自身决定）。
   *
   * `user_bash` 与 agent 调用各自取值，缺省都是“不发送推理参数”：两个入口的等待成本不同，
   * 不因为共用一个评审模型就共享强度设置（详情见 `review/reasoning.ts`）。
   */
  function reviewReasoningEffort(request: DecisionRequest, config: ResolvedConfig) {
    return (
      (request.origin === "user_bash"
        ? config.userBashPolicy.reasoningEffort
        : config.reviewer.reasoningEffort) ?? undefined
    );
  }

  /**
   * 子代理会话的默认动作下限（FR-56）。
   *
   * 只在命中子代理会话、且 `subagentPolicy.enabled` 时生效，取值只能是 `deny` / `ask` / `review`
   * （schema 已禁止 `allow`），因此它只可能收紧。它作用在默认动作矩阵这一层：用户显式规则、
   * 只读白名单与 `onUnresolvedFacts` 各自的分支不受影响（详见 `policy/evaluate.ts`）。
   */
  function defaultActionFloor(config: ResolvedConfig): Action | undefined {
    if (!deps.runtime.isSubagentSession || !config.subagentPolicy.enabled) {
      return undefined;
    }
    return config.subagentPolicy.defaultAction;
  }

  /**
   * 本会话是否可以使用和创建会话授权（FR-29/56）。
   *
   * 子代理会话在 `subagentPolicy.enabled` 且 `allowSessionGrants=false`（默认）时两侧都禁止：
   * 既不能用父会话的授权，也不能建立自己的。`subagentPolicy.enabled=false` 表示不适用子代理策略，
   * 回到 `sessionGrants.enabled`。
   */
  function sessionGrantsAllowed(config: ResolvedConfig): boolean {
    if (!config.sessionGrants.enabled) {
      return false;
    }
    if (!deps.runtime.isSubagentSession) {
      return true;
    }
    return !config.subagentPolicy.enabled || config.subagentPolicy.allowSessionGrants;
  }

  /**
   * 判定缓存的 key（FR-31）。
   *
   * 关闭缓存、`TTL <= 0`、或 facts 带 `unresolved` 时返回 `undefined`：无法稳定复现的目标
   * 不该被复用（architecture §8.2）。查询与写入共用这一个判据，避免"查得到但写不进"。
   */
  function cacheKeyForCall(
    call: CallEvaluation,
    request: DecisionRequest,
    config: ResolvedConfig,
    cwd: string,
  ): string | undefined {
    if (!config.cache.enabled || config.cache.ttlMs <= 0) {
      return undefined;
    }
    if (call.evaluations.some((evaluation) => evaluation.object.unresolved !== undefined)) {
      return undefined;
    }
    const objects = call.evaluations.map((evaluation) => evaluation.object);
    return decisionCacheKey({
      surface: call.decisive?.object.surfaces[0] ?? toolSurface(request.toolName),
      targets: objects.flatMap((object) => object.targets),
      directions: objects.flatMap((object) =>
        object.direction === undefined ? [] : [object.direction],
      ),
      cwd,
      configVersion: deps.runtime.configVersion,
      authorizationVersion: deps.runtime.authorizationVersion,
      reviewerModel: reviewModelSpec(request, config),
    });
  }

  /**
   * 熔断记账（FR-34/35）。
   *
   * - `infrastructureFailure` 专指评审不可用导致的 deny：它只让该工具失去快路径，
   *   不计入风险阈值（M5 门禁：不把基础设施失败伪装成风险 deny）。
   * - 预评分的放行不喂熔断器：它永远不会 deny，没有资格影响"被拒绝的连续性"。
   * - 触发阈值的那次 deny 自己也带 `terminate`：达到阈值就该结束本轮，而不是等下一次调用。
   */
  function applyBreakerAccounting(
    outcome: DecisionOutcome,
    toolName: string,
    config: ResolvedConfig,
  ): void {
    if (outcome.source === "classifier") {
      return;
    }
    if (outcome.final === "deny") {
      const tripped = recordBreakerDeny(
        deps.runtime.breaker,
        toolName,
        config.circuitBreaker,
        { infrastructureFailure: outcome.verdict === "unavailable" },
      );
      if (tripped) {
        outcome.terminate = true;
        outcome.reason = `${outcome.reason ?? "调用被拒绝。"} ${BREAKER_REASON}`;
      }
      return;
    }
    recordBreakerAllow(deps.runtime.breaker, config.circuitBreaker);
  }

  /** 缓存写入（FR-32）：只接受评审模型给出的确定结论，`unavailable` 与人工/授予结论都不固化。 */
  function storeCache(
    outcome: DecisionOutcome,
    cacheKey: string | undefined,
    config: ResolvedConfig,
  ): void {
    if (cacheKey === undefined || !isCacheable(outcome)) {
      return;
    }
    writeCache(deps.runtime.cache, cacheKey, outcome, config.cache.maxEntries, Date.now);
  }

  interface ResolveInput {
    call: CallEvaluation;
    facts: Facts;
    request: DecisionRequest;
    config: ResolvedConfig;
    ctx: ExtensionContext;
    /** 判定缓存 key；`undefined` 表示本条调用不参与缓存（关闭 / unresolved）。 */
    cacheKey?: string;
  }

  async function resolveOutcome(input: ResolveInput): Promise<DecisionOutcome> {
    const { call, config, ctx, request, cacheKey } = input;
    const proposed = call.action;
    const surface = call.decisive?.object.surfaces[0] ?? toolSurface(request.toolName);
    const targets = collectTargets(call);

    let action = call.action;
    let source: DecisionSource = "policy";
    // 规则 / 失败分支给出的判定依据（"命中规则"）。评审会覆写 `reason`，因此单独留一份。
    const ruleReason = describeReason(call, config);
    let reason: string | undefined = ruleReason;
    /** 评审给出的风险评级与理由（"风险点"）。 */
    let riskText: string | undefined;
    /** 需要额外解释的判定说明（评审不可用、userBashPolicy.autoReview=false 等）。 */
    let noteText: string | undefined;
    let matchedPattern = call.decisive?.matchedPattern;
    let reviewerModel: string | undefined;
    let verdict: "allow" | "deny" | "unavailable" | undefined;
    let evidenceRounds: number | undefined;

    // 需要授权的对象 = 动作落在 ask / review 的对象；与创建授权时的对象集合保持一致。
    const grantedObjects = call.evaluations
      .filter((evaluation) => evaluation.action === "ask" || evaluation.action === "review")
      .map((evaluation) => evaluation.object);
    const hasUnresolved = call.evaluations.some(
      (evaluation) => evaluation.object.unresolved !== undefined,
    );
    const anyDeny = call.evaluations.some((evaluation) => evaluation.action === "deny");
    // FR-35：本轮被 deny 过的工具失去全部快路径（授权 / 缓存 / 预评分）。
    const fastPathBlocked = breakerBlocksFastPath(deps.runtime.breaker, request.toolName);

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
      !fastPathBlocked &&
      sessionGrantsAllowed(config) &&
      isCallGranted(grantedObjects, deps.runtime.grants.keys, globOptions)
    ) {
      action = "allow";
      source = "session-grant";
      reason = "本会话已批准该模式（FR-29）。";
      matchedPattern = undefined;
    }

    // 缓存（FR-31）：确定性结论的快路径，排在授权之后、评审之前。
    if (
      cacheKey !== undefined &&
      !fastPathBlocked &&
      (action === "ask" || action === "review")
    ) {
      const cached = readCache(deps.runtime.cache, cacheKey, config.cache.ttlMs, Date.now);
      if (cached !== undefined) {
        return cached;
      }
    }

    // 预评分（FR-36~38）：只用于放行、永不产生 deny；同样受 FR-35 与 unresolved 限制。
    // 它排在评审之前、缓存之后：缓存是确定性结论，应优先复用。
    if (
      config.classifier.enabled &&
      (action === "ask" || action === "review") &&
      !hasUnresolved &&
      !fastPathBlocked &&
      classifierAllows(
        deps.runtime.classifier,
        deps.runtime.callIndex,
        deps.runtime.authorizationVersion,
        config.classifier.maxLag,
      )
    ) {
      return {
        proposed,
        final: "allow",
        source: "classifier",
        reason:
          "预评分判定最近轨迹为低风险，本次调用走快路径放行（FR-36）：预评分只放行、不拒绝，也不代表已复核该动作。",
        surface,
        targets,
      };
    }

    if (action === "review") {
      const reviewed = await runReview(input, reason ?? "");
      action = reviewed.action;
      source = reviewed.source;
      reason = reviewed.reason;
      reviewerModel = reviewed.reviewerModel;
      verdict = reviewed.verdict;
      evidenceRounds = reviewed.evidenceRounds;
      if (verdict === "allow" || verdict === "deny") {
        riskText = reviewed.reason;
      } else if (reviewed.reason !== ruleReason) {
        noteText = reviewed.reason;
      }
    }

    if (action === "ask") {
      const resolved = await resolveAsk({
        ctx,
        config,
        grantedObjects,
        input,
        reason,
        rule: ruleReason,
        risk: riskText ?? describeRisk(call, config),
        ...(noteText === undefined ? {} : { note: noteText }),
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
    if (reviewerModel !== undefined) {
      outcome.reviewerModel = reviewerModel;
    }
    if (verdict !== undefined) {
      outcome.verdict = verdict;
    }
    if (evidenceRounds !== undefined) {
      outcome.evidenceRounds = evidenceRounds;
    }
    return outcome;
  }

  /**
   * 评审（FR-19~FR-28）。
   *
   * `userBashPolicy.autoReview=false` 时不调用模型，直接转人工：这是"用户可以拒绝让模型
   * 参与自己手输命令的裁决"的开关（FR-60）。`user_bash` 的模型解析顺序是
   * `userBashPolicy.model` → `reviewer.model`。
   */
  async function runReview(
    input: ResolveInput,
    ruleReason: string,
  ): Promise<{
    action: "allow" | "deny" | "ask";
    source: DecisionSource;
    reason: string;
    reviewerModel?: string;
    verdict?: "allow" | "deny" | "unavailable";
    evidenceRounds?: number;
  }> {
    const { config, ctx, call, facts, request } = input;

    if (request.origin === "user_bash" && !config.userBashPolicy.autoReview) {
      return {
        action: "ask",
        source: "policy",
        reason: `${ruleReason} userBashPolicy.autoReview=false，用户手输命令不交评审模型，转人工确认（FR-60）。`.trim(),
      };
    }

    const modelSpec = reviewModelSpec(request, config);

    const transcript = config.reviewer.transcript
      ? transcriptFromEntries(ctx.sessionManager.getEntries(), {
          maxTotalChars: config.reviewer.transcriptBudgetChars,
        }).text
      : undefined;

    const outcome: ReviewOutcome = await requestReview({
      origin: request.origin,
      toolName: request.toolName,
      toolInput: request.input,
      cwd: request.cwd ?? ctx.cwd,
      reason: ruleReason,
      factsSummary: describeObjects(call, facts),
      grants: [...deps.runtime.grants.keys].map(formatGrantKey),
      ...(transcript === undefined ? {} : { transcript }),
      registry: registryFacade(ctx),
      modelSpec,
      reasoningEffort: reviewReasoningEffort(request, config),
      timeoutMs: config.reviewer.timeoutMs,
      maxEvidenceRounds: config.reviewer.maxEvidenceRounds,
      evidenceTools: config.reviewer.evidenceTools
        ? createEvidenceTools(request.cwd ?? ctx.cwd)
        : [],
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });

    return applyReviewOutcome(outcome, config);
  }

  interface ResolveAskInput {
    ctx: ExtensionContext;
    config: ResolvedConfig;
    grantedObjects: readonly PolicyObject[];
    input: ResolveInput;
    /** 转人工前的理由（命中规则、评审结论或调用级分支）。 */
    reason: string | undefined;
    /** 命中规则 / 失败分支的判定依据（FR-42 的"命中规则"）。 */
    rule: string;
    /** 风险点（FR-42）。 */
    risk: string;
    /** 需要额外解释的判定说明（评审不可用等）。 */
    note?: string;
  }

  async function resolveAsk(
    askInput: ResolveAskInput,
  ): Promise<{ action: "allow" | "deny"; source: DecisionSource; reason: string }> {
    const { ctx, config, grantedObjects, input, reason } = askInput;
    // 无 UI 的降级理由要把"为什么走到这里"带上，否则用户看不到触发人工确认的那条规则。
    const lead = reason === undefined || reason.length === 0 ? "" : `${reason} `;

    if (!ctx.hasUI) {
      // FR-46：没有交互界面时按 onAskWithoutUI 处理。失败分支若指向 ask / review，
      // 在这里同样无法执行，必须 fail-closed 落到 deny。
      const fallback = config.onAskWithoutUI;
      if (fallback === "allow") {
        return {
          action: "allow",
          source: "policy",
          reason: `${lead}无交互界面可确认，按 onAskWithoutUI=allow 放行（FR-46）。`,
        };
      }
      if (fallback === "deny") {
        return {
          action: "deny",
          source: "policy",
          reason: `${lead}无交互界面可确认，按 onAskWithoutUI=deny 拦截（FR-46）。`,
        };
      }
      return {
        action: "deny",
        source: "policy",
        reason: `${lead}无交互界面可确认，onAskWithoutUI=${fallback} 在无 UI 时无法执行，按 fail-closed 拦截。`,
      };
    }

    const suggestions = sessionGrantsAllowed(config)
      ? grantKeysForObjects(grantedObjects).map((key) => formatGrantKey(encodeGrantKey(key)))
      : [];
    const targets = collectTargets(input.call);
    const decision = await askHuman(ctx, {
      action: `工具 ${input.request.toolName}，规则层提议动作 ${input.call.action}；目标：${
        targets.length === 0 ? "（无）" : targets.join("、")
      }`,
      rule: askInput.rule,
      risk: askInput.risk,
      ...(askInput.note === undefined ? {} : { note: askInput.note }),
      suggestion: askSuggestion(input.call),
      suggestions,
    });

    if (decision?.choice === "session") {
      if (!sessionGrantsAllowed(config)) {
        // 本会话不提供会话授权（子代理会话且 allowSessionGrants=false，FR-56）。
        // 对话框本来就不会给出这个选项；真收到它时不静默降级为"仅此次"，也不写入授权。
        return {
          action: "deny",
          source: "human",
          reason: "本会话不允许创建会话授权（FR-56），无法执行「本会话允许此类」，按拒绝处理。",
        };
      }
      // 只有这里能创建会话授权（FR-29）：评审模型的 allow 与缓存都不写入。
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
      reason: decision?.note === undefined ? "人工拒绝。" : `人工拒绝：${decision.note}`,
    };
  }

  async function decideToolCall(
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<DecisionOutcome | undefined> {
    return decide(
      {
        origin: "tool_call",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: event.input,
      },
      ctx,
    );
  }

  return {
    decide,
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
          // `terminate` 只在一次调用里生效（FR-34）：触发熔断或被熔断拦下时提前结束本轮。
          ...(outcome.terminate === true ? { terminate: true } : {}),
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
      (evaluation) => evaluation.action !== undefined && evaluation.object.kind !== "tool",
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
    return "命中只读命令档案（FR-9 / FR-65）";
  }
  if (evaluation.source === "unresolved") {
    return "对象无法静态确定执行内容（FR-14）";
  }
  if (evaluation.source === "baseline") {
    const label = evaluation.matchedSurface ?? "surface";
    const head = `未命中用户规则，按默认动作矩阵（${label} → ${evaluation.action}）处理`;
    // baseline 也可能带理由：配置失效时的收紧、子代理会话的默认动作下限。
    return evaluation.reason === undefined ? head : `${head}：${evaluation.reason}`;
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
    case "objects": {
      if (call.decisive === undefined) {
        return "没有对象对该调用表态，按放行处理。";
      }
      const head = describeRule(call.decisive);
      const cancel = call.decisive.object.readOnlyCancel;
      return cancel === undefined
        ? head
        : `${head}；该命令命中只读档案，但免评审被取消（${cancel}，FR-69）`;
    }
  }
}

/**
 * 风险点（FR-42 的对话框要素）。
 *
 * 没有评审结论时也要回答"为什么这条命令有风险"：要么来自调用级分支（不可静态确定、动作冲突），
 * 要么来自`命中并要求逐次确认的规则`本身。
 */
function describeRisk(call: CallEvaluation, config: ResolvedConfig): string {
  switch (call.cause) {
    case "unresolved-deny":
      return "同一调用中同时存在无法静态确定的对象与明确拒绝的对象：静态分析看不到的部分无法保证无害（FR-61）。";
    case "mixed":
      return `同一调用的多个命令单元动作冲突，按 onMixedCommandActions=${config.onMixedCommandActions} 处理：被拒绝的动作可能被夹带在允许的动作里（FR-59）。`;
    case "unresolved":
      return "调用无法静态确定执行内容（解析失败、包装器内部不可见或路径不可静态确定）：静态分析看不到的写法正是绕过风险所在（FR-14）。";
    default: {
      const pattern = call.decisive?.matchedPattern;
      return pattern === undefined
        ? "该调用需要人工判断，护栏没有更具体的风险说明。"
        : `命中规则 "${pattern}"，该规则要求逐次人工确认。`;
    }
  }
}

/** 护栏建议的动作（FR-42）；无法静态确定的调用给出可执行的替代路径。 */
function askSuggestion(call: CallEvaluation): string {
  if (call.evaluations.some((evaluation) => evaluation.object.unresolved !== undefined)) {
    return "命令内容无法静态确定：请让 agent 改用可直接复核的写法（写明路径与参数），或由你自己执行。";
  }
  return "确认目标与影响范围符合你的意图后再放行；不确定时选择「拒绝并说明原因」，让 agent 换一种范围更小的写法。";
}

/** 逐对象摘要：作为评审的 facts 摘要（FR-20）。 */
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
