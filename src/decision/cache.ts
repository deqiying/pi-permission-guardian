import { createHash } from "node:crypto";

import type { DecisionOutcome } from "./outcome.ts";

/**
 * 判定缓存（FR-31~33、architecture §8.2）。
 *
 * 四条不可让步的约束：
 * - **只缓存确定结论**（allow / deny）。`unavailable` 不入缓存（FR-32）——否则一次网络抖动
 *   会在 TTL 内固化成"这条路永远超时"。`ask`、人工的临时决定与预评分放行同样不缓存：
 *   它们都不是"规则或模型给出的确定结论"。
 * - **key 覆盖全部前提**：surface + 规范化目标集合 + 方向 + cwd + 规则集版本 + 用户授权版本 +
 *   评审模型（FR-31）。任一维度变化都会落到不同的 key，因此"失效"天然发生。
 * - **仅内存**：`session_shutdown` 清空，不落盘（FR-32）。
 * - **facts 带 unresolved 时由调用方跳过缓存**：无法稳定复现的目标不该被复用。
 */

export const CACHE_KEY_SEPARATOR = "\u0000";
/** 目标集合内部的分隔符；与 key 分隔符不同，避免"一个目标含分隔符"造成歧义。 */
const TARGET_SEPARATOR = "\u0001";

export interface DecisionCache {
  entries: Map<string, CachedDecision>;
}

export interface CachedDecision {
  outcome: DecisionOutcome;
  storedAt: number;
}

/** `decisionCacheKey` 的输入；字段名与 FR-31 的 key 组成一一对应。 */
export interface DecisionCacheKeyInput {
  surface: string;
  /** 参与裁决的全部匹配目标（命令单元文本、调用级文本、路径的词法形与真实形）。 */
  targets: readonly string[];
  /** 该调用的方向集合（`read` / `write`）；命令与工具对象没有方向。 */
  directions: readonly string[];
  cwd: string;
  configVersion: number;
  authorizationVersion: string;
  reviewerModel: string | undefined;
}

export function createDecisionCache(): DecisionCache {
  return { entries: new Map<string, CachedDecision>() };
}

/**
 * 判定缓存的 key（FR-31）。
 *
 * 目标与方向先排序去重再拼接，让"同样的目标集合、不同的出现顺序"命中同一条缓存；
 * `reviewer.model` 为 `undefined` 时用空串占位，保证字段个数固定。
 */
export function decisionCacheKey(input: DecisionCacheKeyInput): string {
  const parts = [
    input.surface,
    [...new Set(input.targets)].sort().join(TARGET_SEPARATOR),
    [...new Set(input.directions)].sort().join(","),
    input.cwd,
    String(input.configVersion),
    input.authorizationVersion,
    input.reviewerModel ?? "",
  ];
  return createHash("sha256")
    .update(parts.join(CACHE_KEY_SEPARATOR), "utf8")
    .digest("hex");
}

/**
 * 用户消息文本指纹（FR-33）。
 *
 * 目的是**变更检测**而不是抗碰撞：低成本算法足够，别把它当成安全摘要。
 * 长度参与其中，让"同 hash 不同长度"这种低成本碰撞也表现为不同版本。
 */
export function authorizationFingerprint(text: string): string {
  const value = text.trim();
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return `${value.length}-${hash.toString(16)}`;
}

/**
 * 读取缓存（FR-31）。
 *
 * 命中时把条目移到 Map 尾部（LRU），并把来源改写成 `cache`——审计必须能回答
 * "这次是复用旧结论，不是重新评审的"。原始来源与理由保留在理由文本里，避免丢证据。
 */
export function readCache(
  cache: DecisionCache,
  key: string,
  ttlMs: number,
  now: () => number,
): DecisionOutcome | undefined {
  if (ttlMs <= 0) {
    return undefined;
  }
  const entry = cache.entries.get(key);
  if (entry === undefined) {
    return undefined;
  }
  if (now() - entry.storedAt > ttlMs) {
    cache.entries.delete(key);
    return undefined;
  }
  cache.entries.delete(key);
  cache.entries.set(key, entry);
  return {
    ...entry.outcome,
    source: "cache",
    reason: cacheHitReason(entry.outcome),
  };
}

/** 命中缓存的理由文本：保留原判定来源与理由，说明这是复用而不是新判定。 */
function cacheHitReason(outcome: DecisionOutcome): string {
  const original =
    outcome.reason === undefined || outcome.reason.length === 0
      ? "（原判定没有理由）"
      : outcome.reason;
  return `命中判定缓存（原判定来源 ${outcome.source}）：${original}`;
}

/** 写入缓存（FR-32）：超出容量时按最久未使用淘汰。 */
export function writeCache(
  cache: DecisionCache,
  key: string,
  outcome: DecisionOutcome,
  maxEntries: number,
  now: () => number,
): void {
  cache.entries.delete(key);
  cache.entries.set(key, { outcome: { ...outcome }, storedAt: now() });
  const limit = Math.max(1, maxEntries);
  while (cache.entries.size > limit) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    cache.entries.delete(oldest);
  }
}

/**
 * 该结论是否可以进入缓存。
 *
 * 只有**评审模型给出的确定结论**值得缓存：它是唯一昂贵且可复现的判定。
 * 规则层结论是纯内存计算（缓存它只是白占内存），而 `unavailable`、`ask`、
 * 人工的临时决定与预评分放行要么不构成安全结论，要么带一次性意图，都不能被固化。
 */
export function isCacheable(outcome: DecisionOutcome): boolean {
  if (outcome.source !== "reviewer") {
    return false;
  }
  if (outcome.verdict === "unavailable") {
    return false;
  }
  if (outcome.terminate === true) {
    return false;
  }
  return true;
}
