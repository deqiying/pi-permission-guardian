import type {
  AssistantMessage,
  Context,
  Model,
  Api,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";

import type { ReviewerRegistry } from "../../src/review/reviewer.ts";
import type { FakeModelEntry } from "./fake-context.ts";

/**
 * 评审层的测试替身（FR-19~FR-28）。
 *
 * 组装的是 provider 面而不是插件内部：`models` 供 `modelRegistry.find` 使用（只暴露 `api`，
 * 正好够验证"协议来自模型自身配置"），`complete` 按脚本逐次返回响应，
 * 并把每次调用的 `context` 留档供断言提示词内容（FR-20/FR-24）。
 */

export interface ScriptedToolCall {
  name: string;
  id?: string;
  arguments?: Record<string, unknown>;
}

export type ScriptedStep =
  | AssistantMessage
  | {
      text?: string;
      toolCalls?: readonly ScriptedToolCall[];
      stopReason?: AssistantMessage["stopReason"];
      errorMessage?: string;
      /** 挂起直到 signal 被 abort，再以错误拒绝：模拟超时 / 取消（FR-25）。 */
      hangUntilAborted?: boolean;
    };

export interface ReviewCall {
  model: unknown;
  context: Context;
  /** 调用选项同时保留可枚举的额外字段，供断言协议字段（如推理强度）。 */
  options: ({ signal?: AbortSignal } & Record<string, unknown>) | undefined;
}

export interface FakeReview {
  /** 传给 `createFakeContext({ models })`。 */
  models: Record<string, FakeModelEntry>;
  complete(
    model: unknown,
    context: unknown,
    options: unknown,
  ): Promise<AssistantMessage>;
  calls: ReviewCall[];
  /** 每次调用收到的 context（提示词、工具集）。 */
  contexts(): Context[];
}

const DEFAULT_SPEC = "test/reviewer";

/**
 * 把假评审组装成 `ReviewerRegistry`（与生产路径同形的 find / complete 两个能力）。
 *
 * `find` 只合成 `provider` / `id` / `api`：正好够验证"协议取自模型自身配置"，
 * 又不给插件任何额外可覆盖的字段。
 */
export function reviewRegistry(fake: FakeReview): ReviewerRegistry {
  return {
    find(provider: string, modelId: string): Model<Api> | undefined {
      const entry = fake.models[`${provider}/${modelId}`];
      if (entry === undefined) {
        return undefined;
      }
      // 只带显式给出的可选项：断言里 `find` 返回值要与真实 registry 一样“刚好够用”。
      return {
        provider,
        id: modelId,
        api: entry.api,
        ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }),
        ...(entry.thinkingLevelMap === undefined
          ? {}
          : { thinkingLevelMap: entry.thinkingLevelMap }),
      } as unknown as Model<Api>;
    },
    complete(model, context, options) {
      return fake.complete(model, context, options);
    },
  };
}

export function createFakeReview(options: {
  /** 模型协议；断言"插件没有协议覆盖入口"时看它是否被原样使用。 */
  api?: string;
  /** 模型引用，格式 `provider/model-id`。 */
  spec?: string;
  /** 模型是否支持思考；配置了推理强度的用例需要它为 `true`，否则级别会被归一为 `off`。 */
  reasoning?: boolean;
  /** 模型自己的级别映射，`clampThinkingLevel` 与 anthropic 的 effort 归一都会读它。 */
  thinkingLevelMap?: ThinkingLevelMap;
  responses: readonly ScriptedStep[];
}): FakeReview {
  const api = options.api ?? "openai-responses";
  const spec = options.spec ?? DEFAULT_SPEC;
  const calls: ReviewCall[] = [];
  let index = 0;
  const model: FakeModelEntry = { api };
  if (options.reasoning !== undefined) {
    model.reasoning = options.reasoning;
  }
  if (options.thinkingLevelMap !== undefined) {
    model.thinkingLevelMap = options.thinkingLevelMap;
  }

  return {
    models: { [spec]: model },
    calls,
    contexts(): Context[] {
      return calls.map((call) => call.context);
    },
    async complete(
      model: unknown,
      context: unknown,
      opts: unknown,
    ): Promise<AssistantMessage> {
      const options_ = (opts ?? {}) as { signal?: AbortSignal } & Record<string, unknown>;
      calls.push({ model, context: context as Context, options: options_ });
      const step = options.responses[Math.min(index, options.responses.length - 1)];
      index += 1;
      if (step === undefined) {
        throw new Error("评审脚本没有更多响应");
      }
      if (!isScriptedMessage(step)) {
        if (step.hangUntilAborted === true) {
          return new Promise<AssistantMessage>((_resolve, reject) => {
            const signal = options_.signal;
            if (signal === undefined) {
              reject(new Error("测试脚本要求挂起，但没有收到 signal"));
              return;
            }
            const onAbort = (): void => {
              reject(new Error("aborted by signal"));
            };
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
          });
        }
        return assistantMessage({
          ...(step.text === undefined ? {} : { text: step.text }),
          ...(step.toolCalls === undefined ? {} : { toolCalls: step.toolCalls }),
          ...(step.stopReason === undefined ? {} : { stopReason: step.stopReason }),
          ...(step.errorMessage === undefined ? {} : { errorMessage: step.errorMessage }),
          api,
        });
      }
      return step;
    },
  };
}

/** 区分"测试直接给了一条完整消息"与"给了一个脚本步骤"。 */
function isScriptedMessage(step: ScriptedStep): step is AssistantMessage {
  return (step as AssistantMessage).role === "assistant";
}

export function assistantMessage(options: {
  text?: string;
  toolCalls?: readonly ScriptedToolCall[];
  stopReason?: AssistantMessage["stopReason"];
  errorMessage?: string;
  api?: string;
}): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (options.text !== undefined) {
    content.push({ type: "text", text: options.text });
  }
  for (const [index, call] of (options.toolCalls ?? []).entries()) {
    content.push({
      type: "toolCall",
      id: call.id ?? `call-${index}`,
      name: call.name,
      arguments: call.arguments ?? {},
    });
  }
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: options.api ?? "openai-responses",
    provider: "test",
    model: "reviewer",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: options.stopReason ?? (content.length > 0 ? "stop" : "stop"),
    timestamp: 1_700_000_000_000,
  };
  if (options.errorMessage !== undefined) {
    message.errorMessage = options.errorMessage;
  }
  return message;
}

/** 便捷构造：模型给出 allow / deny 的完整 verdict 工具调用。 */
export function verdictToolCall(verdict: {
  decision: "allow" | "deny";
  riskLevel?: string;
  userAuthorization?: string;
  reversible?: boolean;
  rationale?: string;
}): ScriptedToolCall {
  return {
    name: "submit_verdict",
    id: "verdict-1",
    arguments: {
      decision: verdict.decision,
      riskLevel: verdict.riskLevel ?? (verdict.decision === "allow" ? "low" : "high"),
      userAuthorization: verdict.userAuthorization ?? "medium",
      reversible: verdict.reversible ?? true,
      rationale: verdict.rationale ?? "测试结论",
    },
  };
}
