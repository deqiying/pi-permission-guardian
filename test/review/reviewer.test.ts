import { mkdirSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createEvidenceTools, EVIDENCE_TOOL_NAMES } from "../../src/review/evidence.ts";
import { requestReview, type ReviewParams } from "../../src/review/reviewer.ts";
import { MAX_EVIDENCE_RESULT_CHARS } from "../../src/review/types.ts";
import { createFakeReview, reviewRegistry, verdictToolCall } from "../support/fake-review.ts";
import { createTempDir } from "../support/tmp.ts";

/**
 * 评审调用（FR-19、FR-22、FR-24、FR-25、FR-28）。
 *
 * 这一层直接面对 provider 面：脚本化的假 registry 返回 `AssistantMessage`，
 * 因此可以精确构造超时、取消、报错与畸形输出这些"绝不能变成放行"的路径。
 */

const SPEC = "test/reviewer";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function params(
  review: ReturnType<typeof createFakeReview>,
  overrides: Partial<ReviewParams> = {},
): ReviewParams {
  return {
    origin: "tool_call",
    toolName: "bash",
    toolInput: { command: "rm -rf ./dist" },
    cwd: "/repo",
    registry: reviewRegistry(review),
    modelSpec: SPEC,
    timeoutMs: 20_000,
    maxEvidenceRounds: 3,
    ...overrides,
  };
}

describe("模型解析（FR-19）", () => {
  it("未配置时是 not-configured", async () => {
    const review = createFakeReview({ responses: [] });

    const outcome = await requestReview(params(review, { modelSpec: undefined }));

    expect(outcome).toMatchObject({ kind: "unavailable", cause: "not-configured" });
    expect(review.calls).toHaveLength(0);
  });

  it("格式非法时是 not-configured", async () => {
    const review = createFakeReview({ responses: [] });

    const outcome = await requestReview(params(review, { modelSpec: "nope" }));

    expect(outcome).toMatchObject({ kind: "unavailable", cause: "not-configured" });
    expect(outcome.kind === "unavailable" ? outcome.reason : "").toContain(
      "provider/model-id",
    );
  });

  it("模型在 pi 配置里找不到时是 not-configured，并指出缺失的键", async () => {
    const review = createFakeReview({ responses: [] });

    const outcome = await requestReview(params(review, { modelSpec: "other/missing" }));

    expect(outcome).toMatchObject({ kind: "unavailable", cause: "not-configured" });
    expect(outcome.kind === "unavailable" ? outcome.reason : "").toContain("other/missing");
  });

  it("成功时回报实际使用的模型标识（provider/id）", async () => {
    const review = createFakeReview({
      responses: [{ toolCalls: [verdictToolCall({ decision: "allow" })] }],
    });

    const outcome = await requestReview(params(review));

    expect(outcome).toMatchObject({ kind: "allow", reviewerModel: "test/reviewer" });
  });
});

describe("verdict 三段式（FR-22）", () => {
  it("第一段：模型调用 verdict 工具即结论", async () => {
    const review = createFakeReview({
      responses: [
        {
          toolCalls: [
            verdictToolCall({ decision: "deny", riskLevel: "critical", rationale: "外泄密钥" }),
          ],
        },
      ],
    });

    const outcome = await requestReview(params(review));

    expect(outcome).toMatchObject({ kind: "deny", evidenceRounds: 0 });
    expect(outcome.kind === "deny" ? outcome.verdict.rationale : "").toBe("外泄密钥");
  });

  it("第二段：没有工具调用时解析文本 JSON", async () => {
    const review = createFakeReview({
      responses: [
        {
          text: '```json\n{"decision":"allow","riskLevel":"low","userAuthorization":"high","reversible":true,"rationale":"常规构建"}\n```',
        },
      ],
    });

    const outcome = await requestReview(params(review));

    expect(outcome).toMatchObject({ kind: "allow", evidenceRounds: 0 });
    expect(outcome.kind === "allow" ? outcome.verdict.userAuthorization : "").toBe("high");
  });

  it("第三段：畸形输出是 invalid-output，绝不猜成 allow", async () => {
    const review = createFakeReview({ responses: [{ text: "我觉得可以" }] });

    const outcome = await requestReview(params(review));

    expect(outcome).toMatchObject({ kind: "unavailable", cause: "invalid-output" });
  });

  it("模型调用 verdict 工具但参数非法时同样是 invalid-output", async () => {
    const review = createFakeReview({
      responses: [{ toolCalls: [{ name: "submit_verdict", arguments: { decision: "maybe" } }] }],
    });

    expect(await requestReview(params(review))).toMatchObject({
      kind: "unavailable",
      cause: "invalid-output",
    });
  });
});

describe("失败分类（FR-25）", () => {
  it("超时归为 timeout，且评测有硬 deadline", async () => {
    const review = createFakeReview({ responses: [{ hangUntilAborted: true }] });

    const outcome = await requestReview(params(review, { timeoutMs: 20 }));

    expect(outcome).toMatchObject({ kind: "unavailable", cause: "timeout" });
    expect(outcome.kind === "unavailable" ? outcome.reason : "").toContain("20ms");
  });

  it("调用方 signal 取消归为 cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const review = createFakeReview({ responses: [{ hangUntilAborted: true }] });

    expect(
      await requestReview(params(review, { signal: controller.signal })),
    ).toMatchObject({ kind: "unavailable", cause: "cancelled" });
  });

  it("complete 抛错归为 provider-error 并保留原始信息", async () => {
    const review = createFakeReview({ responses: [] });
    const registry = {
      find: reviewRegistry(review).find,
      complete: async (): Promise<never> => {
        throw new Error("429 rate limited");
      },
    };

    const outcome = await requestReview(params(review, { registry }));

    expect(outcome).toMatchObject({ kind: "unavailable", cause: "provider-error" });
    expect(outcome.kind === "unavailable" ? outcome.reason : "").toContain("429");
  });

  it("stopReason=error 的消息也归为 provider-error", async () => {
    const review = createFakeReview({
      responses: [{ stopReason: "error", errorMessage: "context length exceeded" }],
    });

    const outcome = await requestReview(params(review));

    expect(outcome).toMatchObject({ kind: "unavailable", cause: "provider-error" });
    expect(outcome.kind === "unavailable" ? outcome.reason : "").toContain(
      "context length exceeded",
    );
  });

  it("超时与取消都不放行，且 `unavailable` 不是 deny", async () => {
    const review = createFakeReview({ responses: [{ hangUntilAborted: true }] });

    const outcome = await requestReview(params(review, { timeoutMs: 20 }));

    expect(outcome.kind).toBe("unavailable");
  });
});

describe("只读证据循环（FR-24）", () => {
  it("首轮提供 verdict 工具与白名单证据工具，verdict 工具声明结构化输出", async () => {
    const review = createFakeReview({
      responses: [{ toolCalls: [verdictToolCall({ decision: "allow" })] }],
    });

    await requestReview(
      params(review, { evidenceTools: createEvidenceTools(process.cwd()) }),
    );

    const tools = review.contexts()[0]?.tools ?? [];
    expect(tools[0]).toMatchObject({
      name: "submit_verdict",
      constrainedSampling: { type: "json_schema", strict: "prefer" },
    });
    expect(tools.slice(1).map((tool) => tool.name)).toEqual([...EVIDENCE_TOOL_NAMES]);
  });

  it("没有证据工具时不把工具声明给模型", async () => {
    const review = createFakeReview({
      responses: [{ toolCalls: [verdictToolCall({ decision: "allow" })] }],
    });

    await requestReview(params(review));

    expect(review.contexts()[0]?.tools).toBeUndefined();
    expect(review.contexts()[0]?.systemPrompt).not.toContain("你有只读工具");
  });

  it("maxEvidenceRounds=0 时直接无工具作答", async () => {
    const review = createFakeReview({
      responses: [{ toolCalls: [verdictToolCall({ decision: "allow" })] }],
    });

    await requestReview(
      params(review, { evidenceTools: createEvidenceTools(process.cwd()), maxEvidenceRounds: 0 }),
    );

    expect(review.contexts()).toHaveLength(1);
    expect(review.contexts()[0]?.tools).toBeUndefined();
  });

  it("真实执行只读工具并把结果回喂（进程内直接调用，FR-28）", async () => {
    const dir = createTempDir("guardian-evidence-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(`${dir}/sub`, { recursive: true });
    writeFileSync(`${dir}/sub/notes.txt`, "hello evidence");

    const review = createFakeReview({
      responses: [
        { toolCalls: [{ name: "read", id: "r1", arguments: { path: `${dir}/sub/notes.txt` } }] },
        { toolCalls: [verdictToolCall({ decision: "allow" })] },
      ],
    });

    const outcome = await requestReview(
      params(review, { cwd: dir, evidenceTools: createEvidenceTools(dir) }),
    );

    expect(outcome).toMatchObject({ kind: "allow", evidenceRounds: 1 });
    const secondRound = review.contexts()[1]?.messages ?? [];
    const result = secondRound.find((message) => message.role === "toolResult");
    expect(result).toMatchObject({ toolName: "read", isError: false });
    expect(JSON.stringify(result)).toContain("hello evidence");
  });

  it("未知工具调用被拒绝并回喂错误结果", async () => {
    const review = createFakeReview({
      responses: [
        { toolCalls: [{ name: "write", id: "w1", arguments: { path: "/tmp/x", content: "y" } }] },
        { toolCalls: [verdictToolCall({ decision: "allow" })] },
      ],
    });

    await requestReview(params(review, { evidenceTools: createEvidenceTools(process.cwd()) }));

    const secondRound = review.contexts()[1]?.messages ?? [];
    const result = secondRound.find((message) => message.role === "toolResult");
    expect(result).toMatchObject({ toolName: "write", isError: true });
    expect(JSON.stringify(result)).toContain("不在评审可用的只读工具集内");
  });

  it("证据结果按预算截断", async () => {
    const dir = createTempDir("guardian-evidence-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(`${dir}/big.txt`, "z".repeat(MAX_EVIDENCE_RESULT_CHARS * 3));

    const review = createFakeReview({
      responses: [
        { toolCalls: [{ name: "read", id: "r1", arguments: { path: `${dir}/big.txt` } }] },
        { toolCalls: [verdictToolCall({ decision: "allow" })] },
      ],
    });

    await requestReview(params(review, { cwd: dir, evidenceTools: createEvidenceTools(dir) }));

    const result = (review.contexts()[1]?.messages ?? []).find(
      (message) => message.role === "toolResult",
    );
    const text = JSON.stringify(result);
    expect(text.length).toBeLessThan(MAX_EVIDENCE_RESULT_CHARS * 2);
    expect(text).toContain("...");
  });

  it("轮次用尽后强制无工具作答，模型仍会终止", async () => {
    const review = createFakeReview({
      responses: [
        { toolCalls: [{ name: "ls", id: "l1", arguments: { path: "." } }] },
        { text: '{"decision":"deny"}' },
      ],
    });

    const outcome = await requestReview(
      params(review, { evidenceTools: createEvidenceTools(process.cwd()), maxEvidenceRounds: 1 }),
    );

    expect(outcome).toMatchObject({ kind: "deny", evidenceRounds: 1 });
    expect(review.contexts()).toHaveLength(2);
    expect(review.contexts()[1]?.tools).toBeUndefined();
  });

  it("证据工具的 parameters 原样透传给 provider", async () => {
    const review = createFakeReview({
      responses: [{ toolCalls: [verdictToolCall({ decision: "allow" })] }],
    });
    const evidence = createEvidenceTools(process.cwd());

    await requestReview(params(review, { evidenceTools: evidence }));

    const tools = review.contexts()[0]?.tools ?? [];
    expect(tools.slice(1).map((tool) => tool.parameters)).toEqual(
      evidence.map((tool) => tool.parameters),
    );
  });
});
