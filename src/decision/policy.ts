import type { ResolvedConfig } from "../config/merge.ts";
import type { DecisionSource } from "../audit/entry.ts";
import type { ReviewOutcome, RiskLevel, UserAuthorization } from "../review/types.ts";
import { isRiskierThan, boundText } from "../review/types.ts";

/**
 * 评审结论到动作的映射（FR-23、FR-27，architecture §7.4）。
 *
 * 模型结论不是最终结论：`allow` 还要过一道固定门槛，防止一个给出低质量 allow 的模型
 * 独自决定高风险动作。`unavailable` 则走 `onReviewUnavailable`（默认 `deny`）。
 */

export interface ReviewDecision {
  action: "allow" | "deny" | "ask";
  source: DecisionSource;
  reason: string;
  reviewerModel?: string;
  verdict?: "allow" | "deny" | "unavailable";
  evidenceRounds?: number;
  riskLevel?: RiskLevel;
  userAuthorization?: UserAuthorization;
}

const CAUSE_LABEL: Record<string, string> = {
  "not-configured": "评审模型未配置或无法解析",
  timeout: "评审超时",
  cancelled: "评审被取消",
  "provider-error": "评审模型报错",
  "invalid-output": "评审未给出可解析的结论",
};

/**
 * `unavailable` 的理由（FR-27）。
 *
 * 必须同时说明两件事：**这不是因为风险被拒**（否则用户会误以为动作被判定为危险），
 * 以及可选的安全替代路径（否则这条消息只剩"被拦了"）。
 */
function unavailableReason(cause: string, detail: string): string {
  const label = CAUSE_LABEL[cause] ?? "评审未完成";
  // 细节来自不可信的错误文本，任何写进审计与返回值的副本都必须限长。
  return [
    `${label}，评审未完成（${boundText(detail, 300)}）。`,
    "这不代表该动作因风险被拒绝，只是护栏没拿到独立判断。",
    "可选的安全替代路径：把它拆成范围更小、可复核的命令；由你自己执行该命令；",
    "或把 onReviewUnavailable 显式设为 ask，让这类动作转人工确认。",
  ].join("");
}

/**
 * 把评审结论映射成动作（FR-23）。
 *
 * | verdict | riskLevel | 结果 |
 * |---|---|---|
 * | `allow` | 不超过 `reviewer.maxAllowRiskLevel` | 放行 |
 * | `allow` | 超过门槛 | 不直接放行 → `ask`（无 UI 由 `onAskWithoutUI` 接手） |
 * | `deny` | 任意 | 拦截（理由由调用方补反规避条款） |
 * | `unavailable` | — | `onReviewUnavailable` |
 *
 * `onReviewUnavailable` 配成 `review` 时按 `deny` 处理：评审已经不可用，"再评审一次"不是
 * 一个可执行的落点，fail-closed 是唯一诚实的解释。
 */
export function applyReviewOutcome(
  outcome: ReviewOutcome,
  config: ResolvedConfig,
): ReviewDecision {
  if (outcome.kind === "unavailable") {
    const reason = unavailableReason(outcome.cause, outcome.reason);
    switch (config.onReviewUnavailable) {
      case "allow":
        return {
          action: "allow",
          source: "policy",
          verdict: "unavailable",
          reason: `${reason}（onReviewUnavailable=allow，本次放行由配置决定，不是评审结论）`,
        };
      case "ask":
        return { action: "ask", source: "policy", verdict: "unavailable", reason };
      default:
        return {
          action: "deny",
          source: "policy",
          verdict: "unavailable",
          reason:
            config.onReviewUnavailable === "review"
              ? `${reason}（onReviewUnavailable=review 在评审不可用时无法执行，按 fail-closed 拦截）`
              : reason,
        };
    }
  }

  const { verdict } = outcome;
  const base = {
    reviewerModel: outcome.reviewerModel,
    verdict: verdict.decision,
    evidenceRounds: outcome.evidenceRounds,
    riskLevel: verdict.riskLevel,
    userAuthorization: verdict.userAuthorization,
  } as const;
  const detail = `评审模型（风险 ${verdict.riskLevel}／授权 ${verdict.userAuthorization}）：${verdict.rationale}`;

  if (outcome.kind === "deny") {
    return { action: "deny", source: "reviewer", reason: detail, ...base };
  }
  if (isRiskierThan(verdict.riskLevel, config.reviewer.maxAllowRiskLevel)) {
    return {
      action: "ask",
      source: "reviewer",
      reason: `评审模型给出 allow，但风险等级 ${verdict.riskLevel} 超过门槛 ${config.reviewer.maxAllowRiskLevel}，转人工确认（FR-23）。${detail}`,
      ...base,
    };
  }
  return { action: "allow", source: "reviewer", reason: detail, ...base };
}
