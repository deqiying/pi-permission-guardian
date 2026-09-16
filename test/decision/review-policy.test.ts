import { describe, expect, it } from "vitest";

import { applyReviewOutcome } from "../../src/decision/policy.ts";
import type { ReviewOutcome, ReviewVerdict } from "../../src/review/types.ts";
import { resolveConfig, type ResolveOptions } from "../support/resolved-config.ts";

/**
 * 裁决门槛（FR-23）与失败分支（FR-27、D7）。
 *
 * 模型结论不是最终结论：这道门槛保证"高风险动作不会因为模型一句 allow 就执行"，
 * 而 `unavailable` 必须走失败分支，不能被伪装成风险判定。
 */

function verdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    decision: "allow",
    riskLevel: "low",
    userAuthorization: "high",
    reversible: true,
    rationale: "常规操作",
    ...overrides,
  };
}

function decision(options: ResolveOptions, outcome: ReviewOutcome): ReturnType<typeof applyReviewOutcome> {
  return applyReviewOutcome(outcome, resolveConfig(options));
}

describe("模型 verdict → 动作（FR-23）", () => {
  it("allow 且风险不超过门槛时放行", () => {
    for (const riskLevel of ["low", "medium"] as const) {
      const result = decision({}, {
        kind: "allow",
        verdict: verdict({ riskLevel }),
        reviewerModel: "test/reviewer",
        evidenceRounds: 0,
      });

      expect([riskLevel, result.action]).toEqual([riskLevel, "allow"]);
      expect(result.source).toBe("reviewer");
      expect(result.reviewerModel).toBe("test/reviewer");
    }
  });

  it("allow 但风险超过门槛时转人工（不让模型单独决定高风险放行）", () => {
    for (const riskLevel of ["high", "critical"] as const) {
      const result = decision({}, {
        kind: "allow",
        verdict: verdict({ riskLevel, rationale: "涉及生产凭据" }),
        reviewerModel: "test/reviewer",
        evidenceRounds: 2,
      });

      expect([riskLevel, result.action]).toEqual([riskLevel, "ask"]);
      expect(result.reason).toContain(riskLevel);
      expect(result.reason).toContain("涉及生产凭据");
      expect(result.evidenceRounds).toBe(2);
    }
  });

  it("门槛可放宽到 critical（配置驱动，不是硬编码）", () => {
    const result = decision(
      { global: { reviewer: { maxAllowRiskLevel: "critical" } } },
      { kind: "allow", verdict: verdict({ riskLevel: "high" }), reviewerModel: "m", evidenceRounds: 0 },
    );

    expect(result.action).toBe("allow");
  });

  it("deny 无条件拦截，并带上风险与授权评级", () => {
    const result = decision({}, {
      kind: "deny",
      verdict: verdict({ decision: "deny", riskLevel: "critical", userAuthorization: "unknown" }),
      reviewerModel: "test/reviewer",
      evidenceRounds: 1,
    });

    expect(result.action).toBe("deny");
    expect(result.source).toBe("reviewer");
    expect(result.verdict).toBe("deny");
    expect(result.reason).toContain("riskLevel".replace("riskLevel", "critical"));
    expect(result.reason).toContain("unknown");
  });

  it("deny 不受门槛配置影响", () => {
    const result = decision(
      { global: { reviewer: { maxAllowRiskLevel: "critical" } } },
      { kind: "deny", verdict: verdict({ decision: "deny" }), reviewerModel: "m", evidenceRounds: 0 },
    );

    expect(result.action).toBe("deny");
  });

  it("结论来源与审计字段都被带上", () => {
    const result = decision({}, {
      kind: "allow",
      verdict: verdict({ riskLevel: "low", userAuthorization: "medium", rationale: "理由" }),
      reviewerModel: "test/reviewer",
      evidenceRounds: 3,
    });

    expect(result).toMatchObject({
      action: "allow",
      source: "reviewer",
      verdict: "allow",
      reviewerModel: "test/reviewer",
      evidenceRounds: 3,
      riskLevel: "low",
      userAuthorization: "medium",
    });
  });
});

describe("评审不可用 → onReviewUnavailable（FR-27、D7）", () => {
  const causes = ["timeout", "cancelled", "provider-error", "invalid-output", "not-configured"] as const;

  it("默认拦截，理由说明「评审未完成、不代表因风险被拒」并给出替代路径", () => {
    for (const cause of causes) {
      const result = decision({}, { kind: "unavailable", cause, reason: "细节" });

      expect([cause, result.action]).toEqual([cause, "deny"]);
      expect(result.verdict).toBe("unavailable");
      expect(result.reason).toContain("评审未完成");
      expect(result.reason).toContain("这不代表该动作因风险被拒绝");
      expect(result.reason).toContain("可选的安全替代路径");
    }
  });

  it("各类原因在理由里可区分（FR-25）", () => {
    const labels = causes.map((cause) =>
      decision({}, { kind: "unavailable", cause, reason: "x" }).reason,
    );

    expect(labels[0]).toContain("评审超时");
    expect(labels[1]).toContain("评审被取消");
    expect(labels[2]).toContain("评审模型报错");
    expect(labels[3]).toContain("可解析的结论");
    expect(labels[4]).toContain("未配置或无法解析");
  });

  it("显式配 allow 时放行，但理由标明这是配置决定", () => {
    const result = decision(
      { global: { onReviewUnavailable: "allow" } },
      { kind: "unavailable", cause: "timeout", reason: "x" },
    );

    expect(result.action).toBe("allow");
    expect(result.source).toBe("policy");
    expect(result.reason).toContain("onReviewUnavailable=allow");
    expect(result.reason).toContain("不是评审结论");
  });

  it("显式配 ask 时转人工", () => {
    const result = decision(
      { global: { onReviewUnavailable: "ask" } },
      { kind: "unavailable", cause: "timeout", reason: "x" },
    );

    expect(result.action).toBe("ask");
    expect(result.source).toBe("policy");
  });

  it("配成 review 时按 fail-closed 拦截（评审已不可用，不能再评审一次）", () => {
    const result = decision(
      { global: { onReviewUnavailable: "review" } },
      { kind: "unavailable", cause: "timeout", reason: "x" },
    );

    expect(result.action).toBe("deny");
    expect(result.reason).toContain("无法执行");
  });

  it("外部可见理由不会泄露超长原始错误（受 boundText 约束）", () => {
    const result = decision({}, {
      kind: "unavailable",
      cause: "provider-error",
      reason: "e".repeat(2000),
    });

    expect(result.reason.length).toBeLessThan(1200);
  });
});
