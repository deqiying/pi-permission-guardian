/**
 * 评审层的数据契约（FR-19~FR-28）。
 *
 * 与 `policy/action.ts` 同一个理由：结论类型先定下来，评审调用、裁决门槛、审计与测试
 * 才能对同一组字段达成一致。四个风险等级与四个授权等级的次序在这里是唯一的定义处。
 */

/** 动作自身的固有风险（FR-21）。 */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/** 会话里观察到的用户授权程度（FR-21）。 */
export type UserAuthorization = "unknown" | "low" | "medium" | "high";

export const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high", "critical"];
export const USER_AUTHORIZATIONS: readonly UserAuthorization[] = [
  "unknown",
  "low",
  "medium",
  "high",
];

/** 风险等级比较用序：数值越大越危险。 */
const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** `a` 是否比 `b` 更危险。 */
export function isRiskierThan(a: RiskLevel, b: RiskLevel): boolean {
  return RISK_ORDER[a] > RISK_ORDER[b];
}

/** 评审模型给出的完整结论（FR-21）。 */
export interface ReviewVerdict {
  decision: "allow" | "deny";
  riskLevel: RiskLevel;
  userAuthorization: UserAuthorization;
  reversible: boolean;
  rationale: string;
}

/**
 * 评审未能完成的原因（FR-25）。
 *
 * 与 `deny` 分开是刻意的：基础设施失败不能被当成安全结论报告给 agent（FR-27）。
 */
export type ReviewFailureCause =
  | "not-configured"
  | "timeout"
  | "cancelled"
  | "provider-error"
  | "invalid-output";

export type ReviewOutcome =
  | { kind: "allow"; verdict: ReviewVerdict; reviewerModel: string; evidenceRounds: number }
  | { kind: "deny"; verdict: ReviewVerdict; reviewerModel: string; evidenceRounds: number }
  | { kind: "unavailable"; cause: ReviewFailureCause; reason: string };

// —— 预算（FR-20 的"受预算约束"、FR-21 的 rationale ≤300 字） ——

/** 待执行动作原文的上限；超出即截断，避免超长命令挤占判定上下文。 */
export const MAX_INPUT_CHARS = 8_000;
/** 单条 transcript 条目的上限。 */
export const MAX_TRANSCRIPT_ENTRY_CHARS = 2_000;
/** transcript 正文（非用户条目）的总预算。 */
export const MAX_TRANSCRIPT_TOOL_CHARS = 12_000;
/** transcript 纳入的最近条目数。 */
export const MAX_TRANSCRIPT_RECENT_ENTRIES = 40;
/** verdict.rationale 的上限（FR-21）。 */
export const MAX_RATIONALE_CHARS = 300;
/** 单条证据工具结果的上限（architecture §7.3）。 */
export const MAX_EVIDENCE_RESULT_CHARS = 4_000;
/** 截断标记：出现即表示有内容被丢弃，而不是内容无害。 */
export const TRUNCATION_MARKER = "<truncated />";

/**
 * 把任意文本压成有界、单行安全的诊断串。
 *
 * 评审理由与工具参数都来自不可信文本，任何落盘或回喂的副本都必须先过这里：
 * 既要限长，也要去掉会破坏日志与 UI 的控制字符。
 */
export function boundText(value: unknown, maxChars: number): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const collapsed = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxChars - 3))}...`;
}
