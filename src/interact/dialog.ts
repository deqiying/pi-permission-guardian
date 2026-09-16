import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * 人工确认对话框（FR-29/30、architecture §4 第 8 步）。
 *
 * 只有这里的 `session` 选项能创建会话授权——这是 FR-29 说的"模型 allow、缓存、自动审核和
 * 用户手输命令本身都不能创建授权"的落点，因此对话框必须能唯一地表达"批准一条"与"批准一类"。
 *
 * 取消对话框（返回 undefined）与"拒绝"在语义上等价，调用方按拒绝处理（fail-closed）。
 */

export type HumanChoice = "once" | "session" | "deny" | "deny-with-note";

export interface HumanDecision {
  choice: HumanChoice;
  note?: string;
}

export interface HumanAskRequest {
  /** 需要确认的动作摘要。 */
  summary: string;
  /** 判定依据等补充信息（命中的规则、不可信原因、提议动作）。 */
  detail?: string;
  /** 建议的会话授权模式（FR-30）；空数组表示本次不提供"本会话允许此类"。 */
  suggestions: readonly string[];
}

export const CHOICE_ONCE = "仅此次允许";
export const CHOICE_SESSION = "本会话允许此类";
export const CHOICE_DENY = "拒绝";
export const CHOICE_DENY_NOTE = "拒绝并说明…";

/** 对话框正文：把建议模式显式展示给用户，避免"批准一条命令等于批准一整类命令"的隐性扩张。 */
export function buildAskTitle(request: HumanAskRequest): string {
  const lines = [`pi-permission-guardian：需要人工确认`, "", request.summary];
  if (request.detail !== undefined && request.detail.length > 0) {
    lines.push("", request.detail);
  }
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
