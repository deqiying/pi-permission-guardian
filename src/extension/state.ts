import type { DecisionSource } from "../audit/entry.ts";
import type { ResolvedConfig } from "../config/merge.ts";
import { createBreakerState, resetBreaker, type BreakerState } from "../decision/breaker.ts";
import { createDecisionCache, type DecisionCache } from "../decision/cache.ts";
import { createClassifierState, type ClassifierState } from "../review/classifier.ts";

/**
 * 会话级运行时状态（architecture §3）。
 *
 * 全部是内存态：`session_shutdown` 清空，`/reload` 后重建，不落盘。
 * 容器与清空语义集中在这里，具体判定（缓存 key/TTL、熔断阈值、评分滞后）各自在自己的模块里：
 * `decision/cache.ts`、`decision/breaker.ts`、`review/classifier.ts`。
 */

/** 会话授权记忆（FR-29）。只有人工确认才能写入，键的生成规则在 `policy/session-grants.ts`。 */
export interface SessionGrants {
  keys: Set<string>;
}

/** 最近一次决策（FR-41 的状态栏来源显示）。 */
export interface LastDecision {
  final: "allow" | "deny";
  source: DecisionSource;
  toolName: string;
}

/** 父会话看到的子代理护栏覆盖情况（FR-55）。`unguarded` 表示发现过未加载护栏的子会话。 */
export type SubagentCoverage = "none" | "unguarded";

export interface GuardianRuntime {
  /** 总开关的实际结果：`engagedOverride ?? (config.enabled || --perm)`。 */
  engaged: boolean;
  /** `/perm on|off` 的会话级覆盖。会话开始时重置。 */
  engagedOverride: boolean | undefined;
  /** `--perm` flag；每次会话启动时从 pi 读取。 */
  flagEngaged: boolean;
  /** 逃生舱（FR-53）。由配置刷新写入。 */
  yolo: boolean;
  /** 会话级 gate 覆盖面覆盖（M6 子代理会话使用）。 */
  gateOverride: "side-effect" | "all" | undefined;
  /**
   * 已解析的配置。
   *
   * `undefined` 表示本会话尚未成功加载配置（会话未启动，或加载过程抛出异常）。
   * 决策入口遇到 `undefined` 必须按 fail-closed 处理，不能当成"未安装护栏"放行。
   */
  config: ResolvedConfig | undefined;
  /** 每次成功刷新配置后自增，供缓存 key 失效（FR-31）与 `/perm status` 观察。 */
  configVersion: number;
  /** 用户消息文本指纹（FR-33）；变化即清空授权记忆与缓存。 */
  authorizationVersion: string;
  grants: SessionGrants;
  cache: DecisionCache;
  breaker: BreakerState;
  /** 单调递增的调用序号，供预评分滞后判定（FR-37）。 */
  callIndex: number;
  classifier: ClassifierState;
  /** 最近一次决策结果，供状态栏显示来源（FR-41）。 */
  lastDecision: LastDecision | undefined;
  /** 当前会话是否是已识别的子代理会话（M6 写入，FR-56）。 */
  isSubagentSession: boolean;
  /** 识别为子代理会话时的父会话 ID；仅用于观测。 */
  subagentParentSessionId: string | undefined;
  /** 父会话视图：是否发现过未加载护栏的子会话（FR-55）。 */
  subagentCoverage: SubagentCoverage;
  /** 未加载护栏的子会话 ID，供 `/perm status` 列出。 */
  unguardedChildren: Set<string>;
  /** 检测到其他 `user_bash` 拦截器声明（M4 写入）。 */
  userBashConflict: boolean;
}

export function createRuntime(): GuardianRuntime {
  return {
    engaged: false,
    engagedOverride: undefined,
    flagEngaged: false,
    yolo: false,
    gateOverride: undefined,
    config: undefined,
    configVersion: 0,
    authorizationVersion: "",
    grants: { keys: new Set<string>() },
    cache: createDecisionCache(),
    breaker: createBreakerState(),
    callIndex: 0,
    classifier: createClassifierState(),
    lastDecision: undefined,
    isSubagentSession: false,
    subagentParentSessionId: undefined,
    subagentCoverage: "none",
    unguardedChildren: new Set<string>(),
    userBashConflict: false,
  };
}

/** 清空会话态（`session_start` 初始化与 `session_shutdown` 收尾共用）。 */
export function resetSessionState(runtime: GuardianRuntime): void {
  runtime.engagedOverride = undefined;
  runtime.gateOverride = undefined;
  runtime.authorizationVersion = "";
  runtime.grants.keys.clear();
  runtime.cache.entries.clear();
  resetBreaker(runtime.breaker);
  runtime.callIndex = 0;
  runtime.classifier = createClassifierState();
  runtime.lastDecision = undefined;
  runtime.isSubagentSession = false;
  runtime.subagentParentSessionId = undefined;
  runtime.subagentCoverage = "none";
  runtime.unguardedChildren.clear();
  runtime.userBashConflict = false;
}

/**
 * 用户消息文本指纹变化时清空"基于旧授权前提"的会话态（FR-33）。
 *
 * 授权记忆与缓存都建立在"用户当下要求的是什么"之上：用户追加新指令后，此前基于旧前提的
 * 判定与授权不能继续生效。返回是否发生了变化。
 */
export function updateAuthorizationVersion(
  runtime: GuardianRuntime,
  fingerprint: string,
): boolean {
  if (fingerprint === runtime.authorizationVersion) {
    return false;
  }
  runtime.authorizationVersion = fingerprint;
  runtime.grants.keys.clear();
  runtime.cache.entries.clear();
  return true;
}
