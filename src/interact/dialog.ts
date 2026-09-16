import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * 人工确认对话框（FR-29/30/42、architecture §4 第 8 步）。
 *
 * 只有这里的 `session` 选项能创建会话授权——这是 FR-29 说的"模型 allow、缓存、自动审核和
 * 用户手输命令本身都不能创建授权"的落点，因此对话框必须能唯一地表达"批准一条"与"批准一类"。
 *
 * FR-42 要求对话框给出四件事：**待执行动作、命中规则、风险点、建议动作**。
 * 缺了"命中规则"用户不知道为什么被问，缺了"风险点"用户无法判断，缺了"建议动作"这条消息
 * 就只剩"被拦住了"。
 *
 * 取消对话框（返回 undefined）与"拒绝"在语义上等价，调用方按拒绝处理（fail-closed）。
 */

export type HumanChoice = "once" | "session" | "deny" | "deny-with-note";

export interface HumanDecision {
  choice: HumanChoice;
  note?: string;
}

export interface HumanAskRequest {
  /** 待执行动作：工具、目标与规则层提议的动作（FR-42）。 */
  action: string;
  /** 命中规则或触发人工确认的判定依据（FR-42）。 */
  rule?: string;
  /** 风险点：评审给出的评级与理由，或由 facts 推导出的风险（FR-42）。 */
  risk?: string;
  /** 需要额外解释的判定说明（例如评审未完成，不代表因风险被拒）。 */
  note?: string;
  /** 护栏建议的动作（FR-42）；缺省使用 `DEFAULT_SUGGESTION`。 */
  suggestion?: string;
  /** 建议的会话授权模式（FR-30）；空数组表示本次不提供"本会话允许此类"。 */
  suggestions: readonly string[];
}

export const CHOICE_ONCE = "仅此次允许";
export const CHOICE_SESSION = "本会话允许此类";
export const CHOICE_DENY = "拒绝";
export const CHOICE_DENY_NOTE = "拒绝并说明…";

/** 缺省的"建议动作"：护栏无法替用户判断范围时，给出可执行的下一步。 */
export const DEFAULT_SUGGESTION =
  "确认命令的目标与影响范围后再决定；不确定时选择「拒绝并说明原因」，让 agent 换一种范围更小、可复核的写法。";

/** 对话框正文：四要素 + 显式展示建议授权模式，避免"批准一条命令等于批准一整类命令"。 */
export function buildAskTitle(request: HumanAskRequest): string {
  const lines = [
    `pi-permission-guardian：需要人工确认`,
    "",
    `待执行动作：${request.action}`,
  ];
  if (request.rule !== undefined && request.rule.length > 0) {
    lines.push(`命中规则：${request.rule}`);
  }
  if (request.risk !== undefined && request.risk.length > 0) {
    lines.push(`风险点：${request.risk}`);
  }
  if (request.note !== undefined && request.note.length > 0) {
    lines.push(`判定说明：${request.note}`);
  }
  lines.push(`建议动作：${request.suggestion ?? DEFAULT_SUGGESTION}`);
  if (request.suggestions.length > 0) {
    lines.push(
      "",
      '选择"本会话允许此类"将记住以下模式：',
      ...request.suggestions.map((suggestion) => `- ${suggestion}`),
    );
  }
  return lines.join("\n");
}

export async function askHuman(
  ctx: ExtensionContext,
  request: HumanAskRequest,
): Promise<HumanDecision | undefined> {
  const options =
    request.suggestions.length > 0
      ? [CHOICE_ONCE, CHOICE_SESSION, CHOICE_DENY, CHOICE_DENY_NOTE]
      : [CHOICE_ONCE, CHOICE_DENY, CHOICE_DENY_NOTE];

  const selected = await ctx.ui.select(buildAskTitle(request), options);
  switch (selected) {
    case CHOICE_ONCE:
      return { choice: "once" };
    case CHOICE_SESSION:
      return { choice: "session" };
    case CHOICE_DENY:
      return { choice: "deny" };
    case CHOICE_DENY_NOTE: {
      const note = await ctx.ui.input("拒绝并说明", "可选：说明拒绝的原因");
      return note === undefined || note.trim().length === 0
        ? { choice: "deny-with-note" }
        : { choice: "deny-with-note", note: note.trim() };
    }
    default:
      // 取消 / 关闭对话框：不给结论，由调用方按拒绝处理。
      return undefined;
  }
}
