import type { AssistantMessage, Context } from "@earendil-works/pi-ai";

import { parseModelSpec, type ReviewerRegistry } from "./reviewer.ts";
import { MAX_INPUT_CHARS, boundText } from "./types.ts";

/**
 * 非阻塞预评分（FR-36~38、architecture §8.4、默认关闭）。
 *
 * 语义是**先放行、后判定**：`tool_result` 之后异步给刚发生的轨迹打一个低/高风险分，
 * 打分低风险时允许**下一次**调用走快路径直接放行。它与护栏的保守取向相反，因此默认关闭（D8）。
 *
 * 三条安全边界必须保持：
 * - **只用于放行，永不产生 deny**（FR-36）。它是"省一次评审"，不是"多一道拒绝"。
 * - **失败记为 `failure`，不是"低风险"**（FR-37）。失败会清空上一份评分，绝不让旧的低分继续生效。
 * - **滞后即失活**（FR-37）：评分对应的调用序落后当前超过 `maxLag`，或用户授权版本已变，
 *   这份评分就不再代表"现在"。
 *
 * 模型只通过 `registry.find` / `registry.complete` 使用，协议由模型自身配置决定（FR-19/D6），
 * 与评审层同一条约束。
 */

export interface ClassifierScore {
  score: "low" | "high";
  /** 打分所依据的调用序；与 `GuardianRuntime.callIndex` 同一计数。 */
  callIndex: number;
  /** 打分时的用户授权版本（FR-33/37）。 */
  authorizationVersion: string;
}

export interface ClassifierState {
  /** 最近一次**成功**的评分；失败时被清空，避免旧低分继续放行。 */
  last?: ClassifierScore;
  /** 最近一次失败的原因，供 `/perm status` 观察。 */
  failure?: { reason: string };
  /** 单飞标志（FR-38）：同一时刻至多一个评分请求。 */
  inFlight: boolean;
}

export function createClassifierState(): ClassifierState {
  return { inFlight: false };
}

/** 预评分提示词里工具结果的上限：评分要便宜，不值得把整段输出塞进去。 */
export const MAX_CLASSIFIER_RESULT_CHARS = 2_000;

export const CLASSIFIER_SYSTEM_PROMPT = [
  "你是权限护栏的非阻塞预评分器，只判断最近一次工具调用所代表的轨迹风险。",
  "只输出一个词：low 或 high。不要输出解释、标点或其他任何内容。",
  "low：常规的读取、查询、构建或与用户明确要求一致的小范围修改。",
  "high：破坏性操作、触及敏感数据或凭据、越出工作目录、与用户要求不符、无法判断。",
].join("\n");

export interface ClassifierPromptInput {
  toolName: string;
  toolInput: unknown;
  cwd: string;
  /** 工具执行结果（有界截断）；"轨迹"的另一半。 */
  toolResult?: string;
  /** 触发本次调用的规则 / 失败分支理由（可为空）。 */
  reason?: string;
}

/** 构造评分提示词：只带有界的事实，不塞整段会话（评分的价值在于便宜）。 */
export function buildClassifierPrompt(input: ClassifierPromptInput): string {
  let renderedInput: string;
  try {
    renderedInput = boundText(JSON.stringify(input.toolInput ?? null), MAX_INPUT_CHARS);
  } catch {
    renderedInput = boundText(String(input.toolInput), MAX_INPUT_CHARS);
  }
  const lines = [
    `工具：${boundText(input.toolName, 200)}`,
    `工作目录：${boundText(input.cwd, 500)}`,
    `输入：${renderedInput}`,
  ];
  if (input.toolResult !== undefined && input.toolResult.length > 0) {
    lines.push(`执行结果：${boundText(input.toolResult, MAX_CLASSIFIER_RESULT_CHARS)}`);
  }
  if (input.reason !== undefined && input.reason.length > 0) {
    lines.push(`护栏触发理由：${boundText(input.reason, 500)}`);
  }
  return lines.join("\n");
}

export interface ClassifierRunParams {
  state: ClassifierState;
  registry: ReviewerRegistry;
  /** `provider/model-id`；缺省由调用方回落到 `reviewer.model`。 */
  modelSpec: string | undefined;
  prompt: ClassifierPromptInput;
  /** 打分对应的调用序（`GuardianRuntime.callIndex`）。 */
  callIndex: number;
  authorizationVersion: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type ClassifierRunResult = "low" | "high" | "failure" | "skipped";

/** 解析评分输出：只接受唯一一个 low / high 词，其余（含两者都出现）都算失败。 */
export function parseClassifierText(text: string): "low" | "high" | undefined {
  const matches = text.toLowerCase().match(/\b(low|high)\b/g) ?? [];
  const unique = new Set(matches);
  return unique.size === 1 ? ([...unique][0] as "low" | "high") : undefined;
}

/**
 * 执行一次评分（FR-36~38）。
 *
 * 非阻塞：调用方在 `tool_result` 里发起后立即返回，不等这个 Promise。
 * 返回值只用于测试与观测。
 */
export async function runClassifier(params: ClassifierRunParams): Promise<ClassifierRunResult> {
  const { state } = params;
  if (state.inFlight) {
    // 单飞：并发调度直接丢弃，而不是排队堆积请求（FR-38）。
    return "skipped";
  }
  state.inFlight = true;
  try {
    const spec = params.modelSpec;
    if (spec === undefined || spec.length === 0) {
      return fail(state, "未配置 classifier.model，也没有可回落的 reviewer.model。");
    }
    const parsed = parseModelSpec(spec);
    if (parsed === undefined) {
      return fail(state, `classifier.model "${boundText(spec, 80)}" 不是 provider/model-id 格式。`);
    }
    const model = params.registry.find(parsed.provider, parsed.modelId);
    if (model === undefined) {
      return fail(state, `classifier.model "${boundText(spec, 80)}" 在 pi 模型配置里找不到。`);
    }

    const remaining = Math.max(1, params.timeoutMs);
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

    let response: AssistantMessage;
    try {
      response = await params.registry.complete(model, scoreContext(params.prompt), {
        signal: controller.signal,
        cacheRetention: "none",
      });
    } catch (error) {
      if (timedOut) {
        return fail(state, `预评分超过 ${remaining}ms 未完成。`);
      }
      if (cancelled) {
        return fail(state, "预评分在完成前被取消。");
      }
      return fail(
        state,
        `预评分模型报错：${boundText(error instanceof Error ? error.message : String(error), 200)}`,
      );
    } finally {
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", abortFromCaller);
    }

    if (timedOut) {
      return fail(state, `预评分超过 ${remaining}ms 未完成。`);
    }
    if (cancelled) {
      return fail(state, "预评分在完成前被取消。");
    }
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return fail(
        state,
        `预评分以 "${response.stopReason}" 结束：${boundText(response.errorMessage ?? "", 200)}`,
      );
    }
    const score = parseClassifierText(textOf(response));
    if (score === undefined) {
      return fail(state, "预评分没有给出唯一可解析的 low / high 结论。");
    }

    state.failure = undefined;
    state.last = {
      score,
      callIndex: params.callIndex,
      authorizationVersion: params.authorizationVersion,
    };
    return score;
  } finally {
    state.inFlight = false;
  }
}

function fail(state: ClassifierState, reason: string): "failure" {
  // 失败必须清空上一次评分（FR-37）：否则被拒绝的路径会继续吃到旧的低风险分。
  state.last = undefined;
  state.failure = { reason: boundText(reason, 300) };
  return "failure";
}

function scoreContext(prompt: ClassifierPromptInput): Context {
  return {
    systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: buildClassifierPrompt(prompt) }],
        timestamp: Date.now(),
      },
    ],
  };
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/**
 * 评分是否可以用作本次调用的放行依据（FR-36/37）。
 *
 * 四个条件缺一不可：最近一次评分是低风险、用户授权版本未变、调用序没有超过 `maxLag`、
 * 该工具没有被 deny 过（FR-35）。任一不满足就回到正常的规则/评审路径。
 */
export function classifierAllows(
  state: ClassifierState,
  callIndex: number,
  authorizationVersion: string,
  maxLag: number,
): boolean {
  const last = state.last;
  if (last === undefined || last.score !== "low") {
    return false;
  }
  if (last.authorizationVersion !== authorizationVersion) {
    return false;
  }
  return callIndex - last.callIndex <= Math.max(0, maxLag);
}
