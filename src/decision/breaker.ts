/**
 * 熔断器（FR-34/35、architecture §8.3）。
 *
 * 意图：同一轮内反复被拒说明"当前做法不可接受"，继续让 agent 换写法试下去只是在制造
 * 一次次的拦截与解释成本。达到阈值后直接结束本轮并让 agent 向用户说明阻碍。
 *
 * 三条边界：
 * - **只影响后续调用**：触发它的那次调用已经按自己的规则/评审结论给出动作，熔断只负责终止本轮。
 * - **不把基础设施失败伪装成风险 deny**：评审不可用导致的 `deny` 是"没拿到独立判断"，
 *   不是"这个做法被判定为危险"，因此它只让工具失去快路径，不计入风险阈值。
 * - **每轮重置**：`turn_start` 清空计数与被拒工具集合（FR-35 的"同一轮内"）。
 */

export interface BreakerThresholds {
  /** 本轮连续 deny 阈值；0 表示关闭该条件。 */
  consecutiveDenials: number;
  /** 窗口内 deny 阈值；0 表示关闭该条件。 */
  recentDenials: number;
  /** 窗口大小（按调用次数计）。 */
  windowSize: number;
}

export interface BreakerState {
  /** 本轮连续 deny 计数；任何被记录的 allow 清零。 */
  consecutiveDenials: number;
  /** 滑动窗口：每次被记录的调用压入一个布尔（true = deny）。 */
  window: boolean[];
  /** 本轮是否已触发熔断。 */
  tripped: boolean;
  /** 本轮被 deny 过的工具名（FR-35：它们失去全部快路径）。 */
  deniedTools: Set<string>;
}

export const BREAKER_REASON =
  "本轮连续拦截次数已达熔断阈值，护栏判定当前做法不可接受：停止本轮继续尝试，" +
  "并向用户说明遇到的阻碍与你想达成的目标，由用户决定下一步；" +
  "不要通过改写、拆分或间接执行来绕过。";

export function createBreakerState(): BreakerState {
  return {
    consecutiveDenials: 0,
    window: [],
    tripped: false,
    deniedTools: new Set<string>(),
  };
}

/** 每轮重置（FR-34/35）。 */
export function resetBreaker(state: BreakerState): void {
  state.consecutiveDenials = 0;
  state.window = [];
  state.tripped = false;
  state.deniedTools.clear();
}

/** 是否已触发熔断；触发后本轮所有进入评估范围的调用都被拦截。 */
export function breakerTripped(state: BreakerState): boolean {
  return state.tripped;
}

/** 该工具本轮是否被拒绝过（FR-35：被拒过的工具失去全部快路径）。 */
export function breakerBlocksFastPath(state: BreakerState, toolName: string): boolean {
  return state.deniedTools.has(toolName);
}

export interface DenyRecord {
  /** 该 deny 是否由基础设施失败（评审 unavailable）产生。 */
  infrastructureFailure: boolean;
}

function pushWindow(state: BreakerState, denied: boolean, windowSize: number): void {
  const size = Math.max(1, windowSize);
  state.window.push(denied);
  while (state.window.length > size) {
    state.window.shift();
  }
}

/**
 * 记录一次 allow。
 *
 * 任何 allow（含缓存与授权快路径）都清零连续计数（architecture §8.3）。
 * 预评分产生的放行**不调用这里**：预评分永远不会 deny，没有资格影响"被拒绝的连续性"。
 */
export function recordBreakerAllow(state: BreakerState, thresholds: BreakerThresholds): void {
  state.consecutiveDenials = 0;
  pushWindow(state, false, thresholds.windowSize);
}

/** 记录一次 deny，返回记录后本轮是否处于熔断状态。 */
export function recordBreakerDeny(
  state: BreakerState,
  toolName: string,
  thresholds: BreakerThresholds,
  record: DenyRecord,
): boolean {
  state.deniedTools.add(toolName);
  if (record.infrastructureFailure) {
    // 基础设施失败不参与风险阈值：它既不加连续计数，也不进窗口。
    return state.tripped;
  }
  state.consecutiveDenials += 1;
  pushWindow(state, true, thresholds.windowSize);
  if (
    thresholds.consecutiveDenials > 0 &&
    state.consecutiveDenials >= thresholds.consecutiveDenials
  ) {
    state.tripped = true;
  }
  if (
    thresholds.recentDenials > 0 &&
    state.window.filter(Boolean).length >= thresholds.recentDenials
  ) {
    state.tripped = true;
  }
  return state.tripped;
}

/** `/perm status` 用的计数快照。 */
export function breakerCounters(state: BreakerState): {
  consecutive: number;
  recent: number;
  tripped: boolean;
} {
  return {
    consecutive: state.consecutiveDenials,
    recent: state.window.filter(Boolean).length,
    tripped: state.tripped,
  };
}
