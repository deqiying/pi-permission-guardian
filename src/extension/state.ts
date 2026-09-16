import type { ResolvedConfig } from "../config/merge.ts";

/**
 * 会话级运行时状态（architecture §3）。
 *
 * 全部是内存态：`session_shutdown` 清空，`/reload` 后重建，不落盘。
 * 这里只放 M1 需要的骨架与容器；授权键生成（M3）、缓存 key/TTL（M5）、
 * 熔断阈值判定（M5）等逻辑各自在自己的里程碑实现，共用这些容器。
 */

/** 会话授权记忆（FR-29）。只有人工确认才能写入，键的生成规则在 M3。 */
export interface SessionGrants {
  keys: Set<string>;
}

/** 判定缓存（FR-31~33）。key 组成与 TTL 淘汰在 M5，这里只保留容器与清空语义。 */
export interface DecisionCache {
  entries: Map<string, unknown>;
}

/** 熔断器计数（FR-34/35）。阈值判定与每轮重置在 M5。 */
export interface BreakerState {
  consecutiveDenials: number;
  recentDenials: number;
}

/** 非阻塞预评分状态（FR-36~38）。默认关闭。 */
export interface ClassifierState {
  lastScore?: "low" | "high" | "failure";
  lastCallIndex?: number;
}

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
   * M3 的决策入口遇到 `undefined` 必须按 fail-closed 处理，不能当成"未安装护栏"放行。
   */
  config: ResolvedConfig | undefined;
  /** 每次成功刷新配置后自增，供缓存 key 失效（FR-31）与 `/perm status` 观察。 */
  configVersion: number;
  grants: SessionGrants;
  cache: DecisionCache;
  breaker: BreakerState;
  /** 单调递增的调用序号，供预评分滞后判定（FR-37）。 */
  callIndex: number;
  classifier: ClassifierState;
  /** 当前会话是否是已识别的子代理会话（M6 写入）。 */
  isSubagentSession: boolean;
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
    grants: { keys: new Set<string>() },
    cache: { entries: new Map<string, unknown>() },
    breaker: { consecutiveDenials: 0, recentDenials: 0 },
    callIndex: 0,
    classifier: {},
    isSubagentSession: false,
    userBashConflict: false,
  };
}

/** 清空会话态（`session_start` 初始化与 `session_shutdown` 收尾共用）。 */
export function resetSessionState(runtime: GuardianRuntime): void {
  runtime.engagedOverride = undefined;
  runtime.gateOverride = undefined;
  runtime.grants.keys.clear();
  runtime.cache.entries.clear();
  runtime.breaker.consecutiveDenials = 0;
  runtime.breaker.recentDenials = 0;
  runtime.callIndex = 0;
  runtime.classifier = {};
  runtime.isSubagentSession = false;
  runtime.userBashConflict = false;
}
