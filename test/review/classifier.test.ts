import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  buildClassifierPrompt,
  classifierAllows,
  createClassifierState,
  parseClassifierText,
  runClassifier,
  type ClassifierState,
} from "../../src/review/classifier.ts";
import type { ReviewerRegistry } from "../../src/review/reviewer.ts";
import { assistantMessage, createFakeReview, reviewRegistry } from "../support/fake-review.ts";

/**
 * 非阻塞预评分（FR-36~38）。
 *
 * 最关键的三条：失败必须清空上一份评分（FR-37）、单飞（FR-38）、滞后 / 授权版本不匹配即失活（FR-37）。
 */

const PROMPT = { toolName: "bash", toolInput: { command: "ls" }, cwd: "/repo" };

function run(
  state: ClassifierState,
  fake: ReturnType<typeof createFakeReview>,
  overrides: Partial<Parameters<typeof runClassifier>[0]> = {},
): ReturnType<typeof runClassifier> {
  return runClassifier({
    state,
    registry: reviewRegistry(fake),
    modelSpec: "test/reviewer",
    prompt: PROMPT,
    callIndex: 1,
    authorizationVersion: "v1",
    timeoutMs: 5_000,
    ...overrides,
  });
}

describe("预评分输出解析（FR-36）", () => {
  it("只接受唯一一个 low / high", () => {
    expect(parseClassifierText("low")).toBe("low");
    expect(parseClassifierText(" HIGH. ")).toBe("high");
    expect(parseClassifierText("结论是 low")).toBe("low");
  });

  it("两者都出现或都没有都被判为无法解析", () => {
    expect(parseClassifierText("low or high")).toBeUndefined();
    expect(parseClassifierText("maybe")).toBeUndefined();
    expect(parseClassifierText("")).toBeUndefined();
  });
});

describe("预评分执行（FR-36~38）", () => {
  it("低风险记入状态，携带调用序与授权版本", async () => {
    const state = createClassifierState();
    const fake = createFakeReview({ responses: [{ text: "low" }] });

    await expect(run(state, fake)).resolves.toBe("low");

    expect(state.last).toEqual({ score: "low", callIndex: 1, authorizationVersion: "v1" });
    expect(state.failure).toBeUndefined();
    expect(state.inFlight).toBe(false);
  });

  it("高分同样记录，但不构成放行依据", async () => {
    const state = createClassifierState();
    const fake = createFakeReview({ responses: [{ text: "high" }] });

    await expect(run(state, fake)).resolves.toBe("high");

    expect(state.last?.score).toBe("high");
    expect(classifierAllows(state, 1, "v1", 2)).toBe(false);
  });

  it("失败记为 failure 并清空上一份低风险评分（FR-37）", async () => {
    const state = createClassifierState();
    await run(state, createFakeReview({ responses: [{ text: "low" }] }));
    expect(state.last?.score).toBe("low");

    await expect(
      run(state, createFakeReview({ responses: [{ text: "无法判断" }] })),
    ).resolves.toBe("failure");

    expect(state.last).toBeUndefined();
    expect(state.failure?.reason).toContain("唯一可解析");
    expect(classifierAllows(state, 2, "v1", 2)).toBe(false);
  });

  it("provider 报错与超时都记为 failure，不放行", async () => {
    const errored = createClassifierState();
    await expect(
      run(errored, createFakeReview({ responses: [{ stopReason: "error", errorMessage: "502" }] })),
    ).resolves.toBe("failure");
    expect(errored.failure?.reason).toContain("502");

    const timedOut = createClassifierState();
    await expect(
      run(timedOut, createFakeReview({ responses: [{ hangUntilAborted: true }] }), {
        timeoutMs: 10,
      }),
    ).resolves.toBe("failure");
    expect(timedOut.failure?.reason).toContain("超过 10ms");
  });

  it("模型未配置时记为 failure，而不是当作低风险", async () => {
    const state = createClassifierState();
    const fake = createFakeReview({ responses: [{ text: "low" }] });

    await expect(run(state, fake, { modelSpec: undefined })).resolves.toBe("failure");

    expect(state.last).toBeUndefined();
    expect(state.failure?.reason).toContain("classifier.model");
  });

  it("配置了推理强度时按协议写入请求字段（FR-19）", async () => {
    const state = createClassifierState();
    const fake = createFakeReview({
      api: "openai-completions",
      reasoning: true,
      responses: [{ text: "low" }],
    });

    await expect(run(state, fake, { reasoningEffort: "medium" })).resolves.toBe("low");

    expect(fake.calls[0]?.options).toMatchObject({ reasoningEffort: "medium" });
  });

  it("协议表达不了推理强度时记为 failure，且不发起调用", async () => {
    const state = createClassifierState();
    const fake = createFakeReview({
      api: "google-generative-ai",
      reasoning: true,
      responses: [{ text: "low" }],
    });

    await expect(run(state, fake, { reasoningEffort: "high" })).resolves.toBe("failure");

    expect(state.last).toBeUndefined();
    expect(state.failure?.reason).toContain("google-generative-ai");
    expect(fake.calls).toHaveLength(0);
  });

  it("单飞：同时刻至多一个评分请求（FR-38）", async () => {
    const state = createClassifierState();
    let release: (message: AssistantMessage) => void = () => {};
    const pending = new Promise<AssistantMessage>((resolve) => {
      release = resolve;
    });
    const registry: ReviewerRegistry = {
      find: (): Model<Api> =>
        ({ provider: "test", id: "reviewer", api: "openai-responses" }) as unknown as Model<Api>,
      complete: (): Promise<AssistantMessage> => pending,
    };

    const first = runClassifier({
      state,
      registry,
      modelSpec: "test/reviewer",
      prompt: PROMPT,
      callIndex: 1,
      authorizationVersion: "v1",
      timeoutMs: 5_000,
    });
    const second = await runClassifier({
      state,
      registry,
      modelSpec: "test/reviewer",
      prompt: PROMPT,
      callIndex: 2,
      authorizationVersion: "v1",
      timeoutMs: 5_000,
    });

    expect(second).toBe("skipped");
    expect(state.inFlight).toBe(true);

    release(assistantMessage({ text: "low" }));
    await expect(first).resolves.toBe("low");
    expect(state.inFlight).toBe(false);
  });
});

describe("预评分放行判据（FR-37）", () => {
  it("滞后超过 maxLag 即失活", () => {
    const state = createClassifierState();
    state.last = { score: "low", callIndex: 3, authorizationVersion: "v1" };

    expect(classifierAllows(state, 5, "v1", 2)).toBe(true);
    expect(classifierAllows(state, 6, "v1", 2)).toBe(false);
  });

  it("授权版本变化即失活", () => {
    const state = createClassifierState();
    state.last = { score: "low", callIndex: 3, authorizationVersion: "v1" };

    expect(classifierAllows(state, 3, "v2", 2)).toBe(false);
  });

  it("没有评分或评分为高时不放行", () => {
    const state = createClassifierState();
    expect(classifierAllows(state, 1, "v1", 2)).toBe(false);

    state.last = { score: "high", callIndex: 1, authorizationVersion: "v1" };
    expect(classifierAllows(state, 1, "v1", 2)).toBe(false);
  });
});

describe("预评分提示词", () => {
  it("带上受限的工具结果，不做无界拼接", () => {
    const prompt = buildClassifierPrompt({
      ...PROMPT,
      toolResult: "x".repeat(5_000),
    });

    expect(prompt).toContain("执行结果：");
    expect(prompt.length).toBeLessThan(3_000);
  });
});
