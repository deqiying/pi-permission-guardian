import type { DecisionSource } from "../audit/entry.ts";
import type { Action } from "../policy/action.ts";

/**
 * 决策结果的统一形态（architecture §4 的第 9 步）。
 *
 * 它是 tool_call 与（M4 起的）user_bash 共用的中间表示：两个入口只负责把结果映射成各自的
 * 返回协议，不各自拼装理由与来源，否则审计日志与 `/perm status` 会按入口长出不同字段。
 */

/** 反规避条款（FR-26）：任何 `deny` 的返回理由都必须包含它。 */
export const ANTI_CIRCUMVENTION =
  "反规避：不得通过改写、拆分、间接执行、重命名等方式达成同一结果。";

export interface DecisionOutcome {
  /** 规则 / 授权层得出的动作（人工确认之前），用于审计区分"为什么被拦"。 */
  proposed: Action;
  /** 最终执行动作。`ask` 与 `review` 都必须在返回前落到 `allow` / `deny`。 */
  final: "allow" | "deny";
  source: DecisionSource;
  reason?: string;
  matchedPattern?: string;
  surface?: string;
  /** 参与裁决的目标主值，写入审计日志。 */
  targets: string[];
}

/** 给 `deny` 的理由补上反规避条款（FR-26）。 */
export function withAntiCircumvention(reason: string | undefined): string {
  const head = reason === undefined || reason.length === 0 ? "调用被拒绝。" : reason;
  return `${head} ${ANTI_CIRCUMVENTION}`;
}
