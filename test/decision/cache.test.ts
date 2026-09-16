import { describe, expect, it } from "vitest";

import {
  authorizationFingerprint,
  createDecisionCache,
  decisionCacheKey,
  isCacheable,
  readCache,
  writeCache,
} from "../../src/decision/cache.ts";
import type { DecisionOutcome } from "../../src/decision/outcome.ts";

/**
 * 判定缓存（FR-31~33）。
 *
 * 这里断言的是"什么能进缓存"与"key 覆盖了哪些前提"：缓存是护栏里唯一会把旧结论复用给
 * 新调用的机制，一旦它的前提漏掉一个维度，配置收紧或用户换了说法都拦不住旧判定。
 */

const BASE_KEY_INPUT = {
  surface: "bash",
  targets: ["rm -rf ./dist", "/repo/dist"],
  directions: [],
  cwd: "/repo",
  configVersion: 1,
  authorizationVersion: "10-abc",
  reviewerModel: "test/reviewer",
} as const;

function outcome(overrides: Partial<DecisionOutcome> = {}): DecisionOutcome {
  return {
    proposed: "review",
    final: "allow",
    source: "reviewer",
    targets: ["rm -rf ./dist"],
    ...overrides,
  };
}

describe("判定缓存 key（FR-31）", () => {
  it("相同输入得到相同 key，目标顺序不影响结果", () => {
    const first = decisionCacheKey(BASE_KEY_INPUT);
    const reordered = decisionCacheKey({
      ...BASE_KEY_INPUT,
      targets: [...BASE_KEY_INPUT.targets].reverse(),
    });

    expect(first).toBe(reordered);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("任一维度变化都会落到不同的 key", () => {
    const base = decisionCacheKey(BASE_KEY_INPUT);
    const variants = [
      { surface: "powershell" },
      { targets: ["rm -rf ./other"] },
      { directions: ["write"] },
      { cwd: "/other" },
      { configVersion: 2 },
      { authorizationVersion: "10-def" },
      { reviewerModel: "test/other" },
      { reviewerModel: undefined },
    ];

    for (const variant of variants) {
      expect(decisionCacheKey({ ...BASE_KEY_INPUT, ...variant })).not.toBe(base);
    }
  });
});

describe("缓存准入（FR-32）", () => {
  it("只接受评审模型给出的确定结论", () => {
    expect(isCacheable(outcome())).toBe(true);
    expect(
      isCacheable(outcome({ final: "deny", verdict: "deny", reason: "危险" })),
    ).toBe(true);
  });

  it("不固化 unavailable、人工决定、授权、预评分与熔断", () => {
    expect(isCacheable(outcome({ verdict: "unavailable" }))).toBe(false);
    expect(isCacheable(outcome({ source: "human" }))).toBe(false);
    expect(isCacheable(outcome({ source: "session-grant" }))).toBe(false);
    expect(isCacheable(outcome({ source: "classifier" }))).toBe(false);
    expect(isCacheable(outcome({ source: "circuit-breaker" }))).toBe(false);
    expect(isCacheable(outcome({ source: "cache" }))).toBe(false);
    expect(isCacheable(outcome({ terminate: true }))).toBe(false);
    // 规则层结论是纯内存计算，没有缓存价值，也不进入这里。
    expect(isCacheable(outcome({ source: "policy" }))).toBe(false);
  });
});

describe("缓存读写（FR-31/32）", () => {
  it("命中时改写来源为 cache 并保留原判定", () => {
    const cache = createDecisionCache();
    const stored = outcome({ reason: "评审模型（风险 low／授权 medium）：常规清理" });
    writeCache(cache, "k", stored, 10, () => 0);

    const hit = readCache(cache, "k", 300_000, () => 1_000);

    expect(hit?.source).toBe("cache");
    expect(hit?.final).toBe("allow");
    expect(hit?.targets).toEqual(stored.targets);
    expect(hit?.reason).toContain("命中判定缓存");
    expect(hit?.reason).toContain("原判定来源 reviewer");
    expect(hit?.reason).toContain("常规清理");
  });

  it("TTL 过期后失效，ttlMs<=0 视为不缓存", () => {
    const cache = createDecisionCache();
    writeCache(cache, "k", outcome(), 10, () => 0);

    expect(readCache(cache, "k", 300_000, () => 300_001)).toBeUndefined();
    expect(cache.entries.size).toBe(0);

    writeCache(cache, "k2", outcome(), 10, () => 0);
    expect(readCache(cache, "k2", 0, () => 0)).toBeUndefined();
  });

  it("超过容量时淘汰最久未使用的条目", () => {
    const cache = createDecisionCache();
    writeCache(cache, "a", outcome(), 2, () => 0);
    writeCache(cache, "b", outcome(), 2, () => 0);
    // 命中 a 让它在 LRU 里变成最近使用，于是 b 变成候选淘汰对象。
    readCache(cache, "a", 300_000, () => 1);
    writeCache(cache, "c", outcome(), 2, () => 2);

    expect(cache.entries.size).toBe(2);
    expect(readCache(cache, "b", 300_000, () => 3)).toBeUndefined();
    expect(readCache(cache, "a", 300_000, () => 3)).toBeDefined();
    expect(readCache(cache, "c", 300_000, () => 3)).toBeDefined();
  });
});

describe("用户授权版本指纹（FR-33）", () => {
  it("同一文本得到同一指纹，文本变化即变化", () => {
    expect(authorizationFingerprint("清理 dist")).toBe(authorizationFingerprint("  清理 dist  "));
    expect(authorizationFingerprint("清理 dist")).not.toBe(
      authorizationFingerprint("顺便把 build 也清了"),
    );
  });

  it("指纹包含长度，避免低成本碰撞被当成同一版本", () => {
    expect(authorizationFingerprint("a")).not.toBe(authorizationFingerprint("aa"));
  });
});
