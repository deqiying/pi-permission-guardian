import { describe, expect, it } from "vitest";

import {
  breakerBlocksFastPath,
  breakerCounters,
  breakerTripped,
  createBreakerState,
  recordBreakerAllow,
  recordBreakerDeny,
  resetBreaker,
  type BreakerThresholds,
} from "../../src/decision/breaker.ts";

/**
 * 熔断器（FR-34/35）。
 *
 * 两条容易被写错的边界在这里固化：阈值 0 表示关闭该条件；基础设施失败（评审不可用）
 * 不参与风险阈值——它不是"这个做法被判定为危险"，而是"护栏没拿到独立判断"。
 */

const THRESHOLDS: BreakerThresholds = {
  consecutiveDenials: 3,
  recentDenials: 10,
  windowSize: 50,
};

const RISK = { infrastructureFailure: false };
const INFRA = { infrastructureFailure: true };

describe("熔断器阈值（FR-34）", () => {
  it("连续 deny 达到阈值即触发", () => {
    const state = createBreakerState();

    expect(recordBreakerDeny(state, "bash", THRESHOLDS, RISK)).toBe(false);
    expect(recordBreakerDeny(state, "bash", THRESHOLDS, RISK)).toBe(false);
    expect(recordBreakerDeny(state, "bash", THRESHOLDS, RISK)).toBe(true);
    expect(breakerTripped(state)).toBe(true);
  });

  it("任何 allow 清零连续计数", () => {
    const state = createBreakerState();
    recordBreakerDeny(state, "bash", THRESHOLDS, RISK);
    recordBreakerDeny(state, "bash", THRESHOLDS, RISK);

    recordBreakerAllow(state, THRESHOLDS);

    expect(state.consecutiveDenials).toBe(0);
    recordBreakerDeny(state, "bash", THRESHOLDS, RISK);
    expect(breakerTripped(state)).toBe(false);
  });

  it("窗口内 deny 总数达到阈值也触发", () => {
    const state = createBreakerState();
    const thresholds: BreakerThresholds = {
      consecutiveDenials: 0,
      recentDenials: 3,
      windowSize: 5,
    };

    recordBreakerDeny(state, "bash", thresholds, RISK);
    recordBreakerAllow(state, thresholds);
    recordBreakerDeny(state, "bash", thresholds, RISK);
    recordBreakerAllow(state, thresholds);
    expect(breakerTripped(state)).toBe(false);

    recordBreakerDeny(state, "bash", thresholds, RISK);
    expect(breakerTripped(state)).toBe(true);
  });

  it("阈值设为 0 表示关闭该条件", () => {
    const state = createBreakerState();
    const thresholds: BreakerThresholds = {
      consecutiveDenials: 0,
      recentDenials: 0,
      windowSize: 5,
    };

    for (let index = 0; index < 20; index += 1) {
      recordBreakerDeny(state, "bash", thresholds, RISK);
    }

    expect(breakerTripped(state)).toBe(false);
  });

  it("基础设施失败的 deny 不计入风险阈值，但同样让工具失去快路径", () => {
    const state = createBreakerState();

    for (let index = 0; index < 10; index += 1) {
      recordBreakerDeny(state, "bash", THRESHOLDS, INFRA);
    }

    expect(breakerTripped(state)).toBe(false);
    expect(state.consecutiveDenials).toBe(0);
    expect(breakerBlocksFastPath(state, "bash")).toBe(true);
  });
});

describe("熔断器边界（FR-35）", () => {
  it("被 deny 过的工具在本轮失去快路径，其它工具不受影响", () => {
    const state = createBreakerState();
    recordBreakerDeny(state, "bash", THRESHOLDS, RISK);

    expect(breakerBlocksFastPath(state, "bash")).toBe(true);
    expect(breakerBlocksFastPath(state, "write")).toBe(false);
  });

  it("每轮重置计数、触发标志与被拒工具集合", () => {
    const state = createBreakerState();
    recordBreakerDeny(state, "bash", THRESHOLDS, RISK);
    recordBreakerDeny(state, "bash", THRESHOLDS, RISK);
    recordBreakerDeny(state, "bash", THRESHOLDS, RISK);
    expect(breakerTripped(state)).toBe(true);

    resetBreaker(state);

    expect(breakerTripped(state)).toBe(false);
    expect(breakerCounters(state)).toEqual({ consecutive: 0, recent: 0, tripped: false });
    expect(breakerBlocksFastPath(state, "bash")).toBe(false);
  });
});
