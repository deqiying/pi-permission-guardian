/**
 * 会话内决策记录（FR-45）。
 *
 * 条目类型带版本后缀：字段演进时新增版本号，旧条目在 TUI 里仍可区分。
 * 实际写入从 M3 起由决策管线调用 `pi.appendEntry(DECISION_ENTRY_TYPE, entry)`。
 */

export const DECISION_ENTRY_TYPE = "pi-permission-guardian.decision.v1";

/** 状态栏 key（FR-41）。 */
export const STATUS_BAR_KEY = "pi-permission-guardian:status";

/** 决策来源：谁批准了这次调用（G5）。 */
export type DecisionSource =
  | "policy"
  | "reviewer"
  | "cache"
  | "session-grant"
  | "human"
  | "circuit-breaker"
  /** 非阻塞预评分给出的快路径放行（FR-36）；默认关闭，且只用于放行。 */
  | "classifier";

export interface DecisionEntry {
  timestamp: string;
  toolName: string;
  toolCallId: string;
  decision: "allow" | "deny" | "ask" | "review";
  source: DecisionSource;
  surface: string;
  matchedPattern?: string;
  reviewerModel?: string;
  verdict?: "allow" | "deny" | "unavailable";
  evidenceRounds?: number;
  reason?: string;
  /** 命中只读档案但免评审被取消的原因（FR-69，`kind` 或 `kind:detail`）。 */
  readOnlyCancel?: string;
}
