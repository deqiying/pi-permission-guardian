/**
 * 评审调用的推理强度（FR-19、D6）。
 *
 * 模型（以及它的请求协议 `model.api`）来自 pi 的模型配置，评审层只做一件事：把用户配置的
 * pi 级别翻译成**该协议自己的请求字段**。因此这里仍然没有 `api` / `baseUrl` / 认证 / headers
 * 覆盖入口，也没有插件自己的默认强度 —— 未配置时不构造任何推理参数。
 */

import {
  clampThinkingLevel,
  type AnthropicEffort,
  type Api,
  type Model,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";

export type { ThinkingLevel };

/** 各协议的推理请求片段；取值词汇表就是 pi 的 `ThinkingLevel`。 */
export type ReasoningFragment =
  /** `openai-completions` / `openai-responses` / `azure-openai-responses` / `openai-codex-responses`。 */
  | { reasoningEffort: ThinkingLevel }
  /** `bedrock-converse-stream` / `pi-messages`：这两个协议原生就用 pi 的级别词汇表。 */
  | { reasoning: ThinkingLevel }
  /** `anthropic-messages`：需要显式打开思考，再给自适应模型的 effort。 */
  | { thinkingEnabled: true; effort: AnthropicEffort };

export type ReasoningPlan =
  /** 未配置，或该模型不支持思考：不发送任何推理参数（保持现状）。 */
  | { kind: "none" }
  | { kind: "send"; fragment: ReasoningFragment }
  /**
   * 配置了强度，但该协议没有能表达它的请求字段。
   *
   * 调用方必须按**评审不可用**处理：静默丢掉这个配置，等于把"用户要求的审慎程度"和实际
   * 发出的请求说成两回事，也会让一次弱评审冒充有效的独立判断。
   */
  | { kind: "unsupported"; api: string };

const ANTHROPIC_EFFORTS: readonly AnthropicEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * 把配置的推理强度翻译成该模型的请求字段（FR-19、FR-24）。
 *
 * 级别先按 `clampThinkingLevel` 归一，与 pi 主会话对同一模型的归一规则一致（例如模型
 * `thinkingLevelMap` 里标为 `null` 的档位不会被发出去）；归一结果是 `off` 时不发送任何
 * 参数 —— 模型 `reasoning: false` 也走这一支，与"该模型本来就不会思考"一致。
 */
export function planReasoning(
  model: Model<Api>,
  level: ThinkingLevel | undefined,
): ReasoningPlan {
  if (level === undefined) {
    return { kind: "none" };
  }
  const clamped = clampThinkingLevel(model, level);
  if (clamped === "off") {
    return { kind: "none" };
  }
  switch (model.api) {
    case "openai-completions":
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return { kind: "send", fragment: { reasoningEffort: clamped } };
    case "bedrock-converse-stream":
    case "pi-messages":
      return { kind: "send", fragment: { reasoning: clamped } };
    case "anthropic-messages":
      return {
        kind: "send",
        fragment: { thinkingEnabled: true, effort: anthropicEffort(model, clamped) },
      };
    default:
      // google-generative-ai / google-vertex 需要按模型形态区分 level 与 token budget，
      // mistral-conversations 只有 none / high 两档，都没有可忠实表达 pi 级别的字段。
      return { kind: "unsupported", api: String(model.api) };
  }
}

/**
 * Anthropic 的 effort 归一，与 pi 的 `streamSimple` 同规则：
 * 模型自己的 `thinkingLevelMap` 优先，否则 `minimal` / `low` 归为 `low`，其余归为 `high`。
 *
 * 归一后仍不在 `AnthropicEffort` 里的映射值不采信（宁可退回档位归并，也不发出协议外的取值）。
 */
function anthropicEffort(model: Model<Api>, level: ThinkingLevel): AnthropicEffort {
  const mapped = model.thinkingLevelMap?.[level];
  if (typeof mapped === "string" && (ANTHROPIC_EFFORTS as readonly string[]).includes(mapped)) {
    return mapped as AnthropicEffort;
  }
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    default:
      return "high";
  }
}
