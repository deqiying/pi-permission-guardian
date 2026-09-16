import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  ModelsApiStreamOptions,
  ThinkingLevel,
} from "@earendil-works/pi-ai";

import { planReasoning, type ReasoningPlan } from "./reasoning.ts";
import { buildReviewPrompt } from "./prompt.ts";
import { reviewerSystemPrompt } from "./prompt.ts";
import {
  VERDICT_JSON_SCHEMA,
  VERDICT_TOOL_NAME,
  parseVerdictText,
  verdictFromToolArguments,
} from "./verdict.ts";
import { toProviderTools, type EvidenceTool } from "./evidence.ts";
import {
  MAX_EVIDENCE_RESULT_CHARS,
  boundText,
  type ReviewFailureCause,
  type ReviewOutcome,
} from "./types.ts";

/**
 * 评审调用（FR-19、FR-24、FR-25、FR-28，architecture §7.1）。
 *
 * 三条不可让步的约束：
 * - 模型只通过 `registry.find` / `registry.complete` 使用，**协议由解析出的 `Model` 决定**；
 *   评审层没有 `api` / `baseUrl` / 认证 / headers 的入口（FR-19、D6）。
 * - 整个交换共用**一个 deadline**，并且桥接 `ctx.signal`（FR-25）；最后一轮强制无工具作答，
 *   所以"一直查证"的模型也一定会以结论或显式失败收场。
 * - 证据工具是**进程内直接调用**，不经过 pi 的工具执行路径，因此不会递归触发本插件（FR-28）。
 */

/**
 * 评审层需要的能力面。
 *
 * 刻意只取 `ModelRegistry` 的两个方法：这样"插件不能覆盖协议"在类型层面就是显然的，
 * 而且注入假 registry 时不需要伪造整个注册表。
 */
export interface ReviewerRegistry {
  find(provider: string, modelId: string): Model<Api> | undefined;
  complete(
    model: Model<Api>,
    context: Context,
    options?: ModelsApiStreamOptions<Api>,
  ): Promise<AssistantMessage>;
}

export interface ReviewParams {
  /** 入口来源，会写进提示词（用户手输与 agent 调用的授权前提不同）。 */
  origin: "tool_call" | "user_bash";
  toolName: string;
  toolInput: unknown;
  cwd: string;
  /** 为何需要复查：命中规则、失败分支或不可静态确定的原因。 */
  reason?: string;
  /** facts 摘要（逐对象一行）。 */
  factsSummary?: string;
  /** 会话摘要；缺省表示不提供 transcript（`reviewer.transcript = false`）。 */
  transcript?: string;
  /** 本会话已授予的授权键（只读摘要，用于让评审知道哪些模式已被人工批准）。 */
  grants?: readonly string[];

  registry: ReviewerRegistry;
  /** `provider/model-id`（FR-19）。 */
  modelSpec: string | undefined;
  /**
   * 评审调用的推理强度（FR-19 的边界内）；缺省不发送任何推理参数。
   *
   * 取值会按模型的 `thinkingLevelMap` 归一后交给该模型协议的请求字段，见 `reasoning.ts`。
   */
  reasoningEffort?: ThinkingLevel;
  timeoutMs: number;
  maxEvidenceRounds: number;
  evidenceTools?: readonly EvidenceTool[];
  signal?: AbortSignal;
  /** 时钟注入点，便于测试 deadline 行为。 */
  now?: () => number;
}

interface CompletionAttempt {
  response?: AssistantMessage;
  errorMessage?: string;
  timedOut: boolean;
  cancelled: boolean;
}

function failure(cause: ReviewFailureCause, reason: string): ReviewOutcome {
  return { kind: "unavailable", cause, reason: boundText(reason, 300) };
}

/** `provider/model-id` 解析；格式固定为"第一个 `/` 之前是 provider"（config schema 同规则）。 */
export function parseModelSpec(spec: string): { provider: string; modelId: string } | undefined {
  const index = spec.indexOf("/");
  if (index <= 0 || index === spec.length - 1) {
    return undefined;
  }
  return { provider: spec.slice(0, index), modelId: spec.slice(index + 1) };
}

/**
 * 单次完成调用，带剩余 deadline 与调用方 signal 的桥接。
 *
 * 超时与取消都用同一个 `controller.abort()`，靠**标志位**区分原因：`AbortError` 本身分不清
 * "谁先放弃的"，而 FR-25 要求把超时 / 取消 / provider 报错分别归类。
 */
async function completeBefore(
  params: ReviewParams,
  model: Model<Api>,
  context: Context,
  deadlineAt: number,
  reasoning: ReasoningPlan,
): Promise<CompletionAttempt> {
  const now = params.now ?? Date.now;
  const remaining = deadlineAt - now();
  if (remaining <= 0) {
    return { timedOut: true, cancelled: params.signal?.aborted === true };
  }

  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  const abortFromCaller = (): void => {
    cancelled = true;
    controller.abort();
  };
  if (params.signal?.aborted === true) {
    cancelled = true;
    controller.abort();
  } else {
    params.signal?.addEventListener("abort", abortFromCaller);
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, remaining);

  try {
    const response = await params.registry.complete(model, context, {
      signal: controller.signal,
      cacheRetention: "none",
      ...(reasoning.kind === "send" ? reasoning.fragment : {}),
    });
    return { response, timedOut, cancelled };
  } catch (error) {
    return {
      errorMessage: error instanceof Error ? error.message : String(error),
      timedOut,
      cancelled,
    };
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", abortFromCaller);
  }
}

interface ToolCallBlock {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

function toolCallBlocks(message: AssistantMessage): ToolCallBlock[] {
  const calls: ToolCallBlock[] = [];
  for (const block of message.content) {
    if (block.type !== "toolCall") {
      continue;
    }
    const args = (block as { arguments?: unknown }).arguments;
    calls.push({
      id: block.id,
      name: block.name,
      arguments:
        typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
    });
  }
  return calls;
}

function textBlocks(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function toolResultMessage(
  call: { id: string; name: string },
  text: string,
  isError: boolean,
): Message {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: boundText(text, MAX_EVIDENCE_RESULT_CHARS) }],
    isError,
    timestamp: Date.now(),
  };
}

function verdictTool(): {
  name: string;
  description: string;
  parameters: unknown;
  constrainedSampling: { type: "json_schema"; strict: "prefer" };
} {
  return {
    name: VERDICT_TOOL_NAME,
    description:
      "提交本次审批结论。结构化输出能力可用时，结论必须通过这个工具提交。",
    parameters: VERDICT_JSON_SCHEMA,
    // `prefer` 而非 `require`：schema 不在 provider 的严格子集内时静默退化，
    // 由第二段（文本 JSON 解析）兜住，而不是让评审直接失败（FR-22）。
    constrainedSampling: { type: "json_schema", strict: "prefer" },
  };
}

/**
 * 请求一次评审（FR-19~FR-28）。
 *
 * 返回 `unavailable` 表示评审**没有完成**，调用方必须按 `onReviewUnavailable` 处理；
 * 它绝不是"允许"的另一种写法。
 */
export async function requestReview(params: ReviewParams): Promise<ReviewOutcome> {
  const spec = params.modelSpec;
  if (spec === undefined || spec.length === 0) {
    return failure("not-configured", "未配置 reviewer.model，无法完成评审。");
  }
  const parsed = parseModelSpec(spec);
  if (parsed === undefined) {
    return failure("not-configured", `reviewer.model "${boundText(spec, 80)}" 不是 provider/model-id 格式。`);
  }
  const model = params.registry.find(parsed.provider, parsed.modelId);
  if (model === undefined) {
    return failure(
      "not-configured",
      `reviewer.model "${boundText(spec, 80)}" 在 pi 模型配置里找不到，无法完成评审。`,
    );
  }
  const reviewerModel = boundText(`${model.provider}/${model.id}`, 200);
  const reasoning = planReasoning(model, params.reasoningEffort);
  if (reasoning.kind === "unsupported") {
    return failure(
      "not-configured",
      `reviewer.reasoningEffort 无法映射到模型 api "${boundText(reasoning.api, 60)}"：该协议没有可用的推理强度字段。请改用支持该配置的模型，或去掉这一项。`,
    );
  }

  const now = params.now ?? Date.now;
  const evidenceTools = params.evidenceTools ?? [];
  const maxRounds = Math.max(0, params.maxEvidenceRounds);
  const useTools = evidenceTools.length > 0 && maxRounds > 0;
  const toolByName = new Map(evidenceTools.map((tool) => [tool.name, tool]));
  const providerTools = [
    verdictTool(),
    ...toProviderTools(evidenceTools),
  ] as Context["tools"];

  const deadlineAt = now() + params.timeoutMs;
  const messages: Message[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: buildReviewPrompt({
            origin: params.origin,
            toolName: params.toolName,
            toolInput: params.toolInput,
            cwd: params.cwd,
            ...(params.transcript === undefined ? {} : { transcript: params.transcript }),
            ...(params.reason === undefined ? {} : { reason: params.reason }),
            ...(params.factsSummary === undefined ? {} : { factsSummary: params.factsSummary }),
            ...(params.grants === undefined ? {} : { grants: params.grants }),
          }),
        },
      ],
      timestamp: now(),
    },
  ];

  let evidenceRounds = 0;
  for (let round = 0; ; round += 1) {
    const forceAnswer = !useTools || round >= maxRounds;
    const context: Context = {
      systemPrompt: reviewerSystemPrompt(useTools),
      messages,
      ...(forceAnswer ? {} : { tools: providerTools }),
    };

    const attempt = await completeBefore(params, model, context, deadlineAt, reasoning);
    if (attempt.cancelled) {
      return failure("cancelled", "评审在完成前被取消。");
    }
    if (attempt.timedOut) {
      return failure("timeout", `评审超过 ${params.timeoutMs}ms 未完成。`);
    }
    if (attempt.errorMessage !== undefined) {
      return failure("provider-error", attempt.errorMessage);
    }
    const response = attempt.response;
    if (response === undefined) {
      return failure("provider-error", "评审模型没有返回消息。");
    }
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return failure(
        "provider-error",
        response.errorMessage ?? `评审以 "${response.stopReason}" 结束。`,
      );
    }

    const calls = toolCallBlocks(response);
    // 第一段：模型直接提交了结构化 verdict。
    const verdictCall = calls.find((call) => call.name === VERDICT_TOOL_NAME);
    if (verdictCall !== undefined) {
      const verdict = verdictFromToolArguments(verdictCall.arguments);
      if (verdict === undefined) {
        return failure("invalid-output", "评审结论结构非法，无法解析。");
      }
      return {
        kind: verdict.decision === "allow" ? "allow" : "deny",
        verdict,
        reviewerModel,
        evidenceRounds,
      };
    }

    if (!forceAnswer && calls.length > 0) {
      messages.push(response);
      evidenceRounds += 1;
      for (const call of calls) {
        if (params.signal?.aborted === true) {
          return failure("cancelled", "评审在查证过程中被取消。");
        }
        const tool = toolByName.get(call.name);
        if (tool === undefined) {
          messages.push(
            toolResultMessage(call, `工具 "${call.name}" 不在评审可用的只读工具集内。`, true),
          );
          continue;
        }
        try {
          const text = await tool.execute(call.arguments, params.signal);
          messages.push(toolResultMessage(call, text, false));
        } catch (error) {
          messages.push(
            toolResultMessage(
              call,
              error instanceof Error ? error.message : String(error),
              true,
            ),
          );
        }
      }
      continue;
    }

    // 第二段：文本 JSON 解析。
    const verdict = parseVerdictText(textBlocks(response));
    if (verdict === undefined) {
      return failure("invalid-output", "评审没有给出可解析的 allow / deny 结论。");
    }
    return {
      kind: verdict.decision === "allow" ? "allow" : "deny",
      verdict,
      reviewerModel,
      evidenceRounds,
    };
  }
}
