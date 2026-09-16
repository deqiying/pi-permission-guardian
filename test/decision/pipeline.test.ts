import { readFileSync, rmSync } from "node:fs";

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DECISION_ENTRY_TYPE } from "../../src/audit/entry.ts";
import { AuditLogger } from "../../src/audit/logger.ts";
import {
  createDecisionEngine,
  expandRoots,
  isGated,
  type DecisionEngine,
} from "../../src/decision/pipeline.ts";
import { createRuntime, type GuardianRuntime } from "../../src/extension/state.ts";
import { ensureBashParser } from "../../src/facts/bash/parser.ts";
import { CHOICE_DENY, CHOICE_ONCE, CHOICE_SESSION } from "../../src/interact/dialog.ts";
import { encodeGrantKey } from "../../src/policy/session-grants.ts";
import {
  createFakeContext,
  type FakeContext,
  type FakeContextOptions,
} from "../support/fake-context.ts";
import { createFakePi, type FakePi } from "../support/fake-pi.ts";
import {
  createFakeReview,
  verdictToolCall,
  type FakeReview,
} from "../support/fake-review.ts";
import { resolveConfig, type ResolveOptions } from "../support/resolved-config.ts";
import { createTempDir } from "../support/tmp.ts";

/**
 * 决策管线（M3 规则层 + M4 评审层，architecture §4）。
 *
 * facts 用**真实解析器**（bash 用例会先预热），因为这里验证的正是"facts → 规则 → 授权 → 评审
 * → 人工"的整条链路，包括 unresolved、包装器与重定向这些只有真实 facts 才有的输入。
 * 评审侧则用脚本化的假 registry：它模拟的是 provider 面（返回 AssistantMessage），
 * 而不是插件内部，因此仍然覆盖模型解析、提示词构造与结论解析。
 */

const CWD = "/repo";
const HOME = "/home/u";

const REVIEW_MODEL = "test/reviewer";

interface Harness {
  engine: DecisionEngine;
  runtime: GuardianRuntime;
  pi: FakePi;
  audit: AuditLogger;
  review: FakeReview | undefined;
}

const cleanups: Array<() => void> = [];

beforeAll(async () => {
  // 预热真实解析器：bash 用例走的就是 extractFacts 的正常路径。
  await ensureBashParser();
});

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

interface SetupOptions extends ResolveOptions {
  review?: FakeReview;
}

function setup(options: SetupOptions = {}): Harness {
  const runtime = createRuntime();
  const dir = createTempDir("guardian-pipeline-");
  const audit = new AuditLogger({ dir, enabled: true });
  const pi = createFakePi();
  const engine = createDecisionEngine({
    pi,
    runtime,
    audit,
    env: { home: HOME, platform: "linux" },
  });
  runtime.config = resolveConfig(options);
  runtime.configVersion = 1;
  runtime.engaged = true;
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return { engine, runtime, pi, audit, review: options.review };
}

function context(
  harness: Harness,
  options: FakeContextOptions = {},
): FakeContext {
  return createFakeContext({
    cwd: CWD,
    ...(harness.review === undefined
      ? {}
      : { models: harness.review.models, complete: harness.review.complete }),
    ...options,
  });
}

/** 已配置评审模型 + 关闭证据工具与 transcript 的基础配置。 */
function reviewConfig(extra: Record<string, unknown> = {}): ResolveOptions {
  return {
    global: {
      reviewer: {
        model: REVIEW_MODEL,
        evidenceTools: false,
        transcript: false,
      },
      ...extra,
    },
  };
}

function bashEvent(command: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "call-bash",
    input: { command },
  } as ToolCallEvent;
}

function writeEvent(path: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolName: "write",
    toolCallId: "call-write",
    input: { path, content: "x" },
  } as ToolCallEvent;
}

function readEvent(path: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolName: "read",
    toolCallId: "call-read",
    input: { path },
  } as ToolCallEvent;
}

function customEvent(toolName: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolName,
    toolCallId: `call-${toolName}`,
    input: {},
  } as ToolCallEvent;
}

describe("gate（architecture §4.0）", () => {
  it("side-effect 只覆盖 pi 内置工具", () => {
    const config = resolveConfig();

    expect(isGated("bash", config)).toBe(true);
    expect(isGated("mcp__x__y", config)).toBe(false);
  });

  it("gate=all 与 extraTools 都能扩大评估范围", () => {
    expect(isGated("mcp__x__y", resolveConfig({ global: { gate: "all" } }))).toBe(true);
    expect(
      isGated("subagent", resolveConfig({ global: { extraTools: ["subagent"] } })),
    ).toBe(true);
  });
});

describe("allowRoots 展开（FR-16 的 facts 契约）", () => {
  it("相对路径按 cwd 展开，`~` 按 home 展开", () => {
    expect(expandRoots("/repo/apps/a", ["../shared", "~/dev", "/abs"], HOME, "linux")).toEqual(
      ["/repo/apps/a", "/repo/apps/shared", "/home/u/dev", "/abs"],
    );
  });
});

describe("决策管线：放行与拦截", () => {
  it("未启用时不参与裁决", async () => {
    const harness = setup();
    harness.runtime.engaged = false;

    expect(await harness.engine.handleToolCall(bashEvent("rm -rf /"), context(harness))).toBeUndefined();
  });

  it("gate 未覆盖的工具完全不参与", async () => {
    const harness = setup();

    expect(
      await harness.engine.handleToolCall(customEvent("mcp__x__y"), context(harness)),
    ).toBeUndefined();
  });

  it("规则 allow 与默认矩阵 allow 都返回 undefined（不介入）", async () => {
    const allowed = setup({ global: { permission: { bash: { "echo *": "allow" } } } });
    expect(
      await allowed.engine.handleToolCall(bashEvent("echo hi"), context(allowed)),
    ).toBeUndefined();

    const readDefault = setup();
    expect(
      await readDefault.engine.handleToolCall(readEvent("/repo/a.txt"), context(readDefault)),
    ).toBeUndefined();
  });

  it("deny 返回 block，理由含命中模式、自定义 reason 与反规避条款（FR-10/FR-26）", async () => {
    const harness = setup({
      global: {
        permission: { bash: { "rm -rf /": { action: "deny", reason: "根目录删除" } } },
      },
    });

    const result = await harness.engine.handleToolCall(bashEvent("rm -rf /"), context(harness));

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("rm -rf /");
    expect(result?.reason).toContain("根目录删除");
    expect(result?.reason).toContain("反规避");
  });

  it("`read ./.env` 由敏感路径规则拒绝", async () => {
    const harness = setup({ global: { permission: { path: { "*.env": "deny" } } } });

    const outcome = await harness.engine.decideToolCall(readEvent("./.env"), context(harness));

    expect(outcome?.proposed).toBe("deny");
    expect(outcome?.final).toBe("deny");
    expect(outcome?.targets).toContain("/repo/.env");
  });

  it("配置尚未加载时按 fail-closed 拦截", async () => {
    const harness = setup();
    harness.runtime.config = undefined;

    const result = await harness.engine.handleToolCall(bashEvent("echo hi"), context(harness));

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("配置尚未加载");
  });

  it("护栏内部异常也返回 block（§9 最后一行）", async () => {
    const harness = setup({ global: { permission: { write: "review" } } });
    const ctx = context(harness);
    // 会话摘要读取抛错：评审路径内部的异常必须变成拦截，而不是被忽略。
    (ctx.sessionManager as unknown as { getEntries: () => never }).getEntries = (): never => {
      throw new Error("ui boom");
    };

    const result = await harness.engine.handleToolCall(writeEvent("/repo/a.txt"), ctx);

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("护栏内部异常");
  });
});

describe("决策管线：评审层（FR-19~FR-28）", () => {
  it("评审 allow 且风险低时放行，并把评审元数据写进审计（FR-21/FR-43）", async () => {
    const review = createFakeReview({
      responses: [{ toolCalls: [verdictToolCall({ decision: "allow", riskLevel: "low" })] }],
    });
    const harness = setup({
      ...reviewConfig({ permission: { write: "review" } }),
      review,
    });

    const outcome = await harness.engine.decideToolCall(
      writeEvent("/repo/a.txt"),
      context(harness),
    );

    expect(outcome?.final).toBe("allow");
    expect(outcome?.source).toBe("reviewer");
    expect(outcome?.verdict).toBe("allow");
    expect(outcome?.reviewerModel).toBe(REVIEW_MODEL);
    expect(outcome?.evidenceRounds).toBe(0);

    await harness.audit.flush();
    const entry = JSON.parse(
      readFileSync(harness.audit.currentPath(), "utf8").trim().split("\n").at(-1) as string,
    ) as Record<string, unknown>;
    expect(entry).toMatchObject({
      source: "reviewer",
      verdict: "allow",
      model: REVIEW_MODEL,
      evidenceRounds: 0,
      action: "allow",
    });
  });

  it("模型只拿到 find/complete 两个能力，协议来自模型自身配置（FR-19/D6）", async () => {
    const review = createFakeReview({
      api: "anthropic-messages",
      responses: [{ toolCalls: [verdictToolCall({ decision: "allow" })] }],
    });
    const harness = setup({
      ...reviewConfig({ permission: { write: "review" } }),
      review,
    });

    const ctx = context(harness);

    await harness.engine.decideToolCall(writeEvent("/repo/a.txt"), ctx);

    expect(review.calls).toHaveLength(1);
    expect(review.calls[0]?.model).toEqual({
      provider: "test",
      id: "reviewer",
      api: "anthropic-messages",
    });
    // 插件没有协议覆盖入口：模型对象直接来自 find（协议取自模型自身配置），
    // 且传递给 complete 的选项里只有 signal 与 cacheRetention。
    expect(ctx.modelRegistryCalls.find).toEqual([{ provider: "test", modelId: "reviewer" }]);
    const completeCall = ctx.modelRegistryCalls.complete[0] as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(completeCall[0]).toEqual({
      provider: "test",
      id: "reviewer",
      api: "anthropic-messages",
    });
    expect(Object.keys(completeCall[2]).sort()).toEqual(["cacheRetention", "signal"]);
  });

  it("模型调用名与参数按 provider/model-id 拆分（FR-19）", async () => {
    const review = createFakeReview({
      responses: [{ toolCalls: [verdictToolCall({ decision: "allow" })] }],
    });
    const harness = setup({
      ...reviewConfig({ permission: { write: "review" } }),
      review,
    });
    const ctx = context(harness);

    await harness.engine.decideToolCall(writeEvent("/repo/a.txt"), ctx);

    expect(ctx.modelRegistryCalls.find).toEqual([
      { provider: "test", modelId: "reviewer" },
    ]);
  });

  it("评审 allow 但风险超过门槛时转人工（FR-23）", async () => {
    const review = createFakeReview({
      responses: [
        {
          toolCalls: [
            verdictToolCall({ decision: "allow", riskLevel: "high", rationale: "涉及生产数据" }),
          ],
        },
      ],
    });
    const harness = setup({
      ...reviewConfig({ permission: { write: "review" } }),
      review,
    });
    const ctx = context(harness, { hasUI: true, selectResult: CHOICE_ONCE });

    const outcome = await harness.engine.decideToolCall(writeEvent("/repo/a.txt"), ctx);
    expect(outcome?.source).toBe("human");
    expect(outcome?.final).toBe("allow");
    // 人工提示里要能看到模型的风险判断。
    expect(ctx.uiCalls.selects[0]?.title).toContain("涉及生产数据");
  });

  it("评审 allow 但风险超过门槛、又无 UI 时按 onAskWithoutUI 处理（FR-23/FR-46）", async () => {
    const review = createFakeReview({
      responses: [{ toolCalls: [verdictToolCall({ decision: "allow", riskLevel: "critical" })] }],
    });
    const harness = setup({
      ...reviewConfig({ permission: { write: "review" } }),
      review,
    });

    const outcome = await harness.engine.decideToolCall(
      writeEvent("/repo/a.txt"),
      context(harness, { hasUI: false }),
    );

    expect(outcome?.final).toBe("deny");
    expect(outcome?.source).toBe("policy");
    expect(outcome?.reason).toContain("onAskWithoutUI");
  });

  it("评审 deny 直接拦截，理由含模型判断与反规避条款（FR-23/FR-26）", async () => {
    const review = createFakeReview({
      responses: [
        {
          toolCalls: [
            verdictToolCall({ decision: "deny", riskLevel: "high", rationale: "会删除用户数据" }),
          ],
        },
      ],
    });
    const harness = setup({
      ...reviewConfig({ permission: { write: "review" } }),
      review,
    });

    const result = await harness.engine.handleToolCall(
      writeEvent("/repo/a.txt"),
      context(harness),
    );

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("会删除用户数据");
    expect(result?.reason).toContain("反规避");
  });

  it("评审模型 allow 不创建会话授权（FR-29）", async () => {
    const review = createFakeReview({
      responses: [{ toolCalls: [verdictToolCall({ decision: "allow" })] }],
    });
    const harness = setup({
      ...reviewConfig({ permission: { write: "review" } }),
      review,
    });

    await harness.engine.decideToolCall(writeEvent("/repo/a.txt"), context(harness));

    expect(harness.runtime.grants.keys.size).toBe(0);
  });

  it("评审未配置时按 onReviewUnavailable 处理，理由指出缺失的配置键（FR-19/FR-27）", async () => {
    const harness = setup({ global: { permission: { write: "review" } } });

    const outcome = await harness.engine.decideToolCall(
      writeEvent("/repo/a.txt"),
      context(harness),
    );

    expect(outcome?.final).toBe("deny");
    expect(outcome?.verdict).toBe("unavailable");
    expect(outcome?.reason).toContain("reviewer.model");
    expect(outcome?.reason).toContain("评审未完成");
    expect(outcome?.reason).toContain("不代表该动作因风险被拒绝");
    expect(outcome?.reason).toContain("onReviewUnavailable");
  });

  it("评审超时按 onReviewUnavailable 拦截（FR-25）", async () => {
    const review = createFakeReview({ responses: [{ hangUntilAborted: true }] });
    const harness = setup({
      global: {
        reviewer: { model: REVIEW_MODEL, timeoutMs: 1000, evidenceTools: false, transcript: false },
        permission: { write: "review" },
        onReviewUnavailable: "deny",
      },
      review,
    });
    (harness.runtime.config as { reviewer: { timeoutMs: number } }).reviewer.timeoutMs = 20;

    const outcome = await harness.engine.decideToolCall(
      writeEvent("/repo/a.txt"),
      context(harness),
    );

    expect(outcome?.final).toBe("deny");
    expect(outcome?.verdict).toBe("unavailable");
    expect(outcome?.reason).toContain("评审超时");
  });

  it("ctx.signal 取消时归为 cancelled（FR-25）", async () => {
    const controller = new AbortController();
    controller.abort();
    const review = createFakeReview({ responses: [{ hangUntilAborted: true }] });
    const harness = setup({
      ...reviewConfig({ permission: { write: "review" } }),
      review,
    });

    const outcome = await harness.engine.decideToolCall(
      writeEvent("/repo/a.txt"),
      context(harness, { signal: controller.signal }),
    );

    expect(outcome?.verdict).toBe("unavailable");
    expect(outcome?.reason).toContain("评审被取消");
  });

  it("provider 报错与畸形输出都不放行（FR-22/FR-25）", async () => {
    const providerError = setup({
      ...reviewConfig({ permission: { write: "review" } }),
      review: createFakeReview({ responses: [{ stopReason: "error", errorMessage: "502 bad gateway" }] }),
    });
    const failed = await providerError.engine.decideToolCall(
      writeEvent("/repo/a.txt"),
      context(providerError),
    );
    expect(failed?.final).toBe("deny");
    expect(failed?.reason).toContain("502 bad gateway");

    const malformed = setup({
      ...reviewConfig({ permission: { write: "review" } }),
      review: createFakeReview({ responses: [{ text: "我觉得应该可以吧" }] }),
    });
    const invalid = await malformed.engine.decideToolCall(
      writeEvent("/repo/a.txt"),
      context(malformed),
    );
    expect(invalid?.final).toBe("deny");
    expect(invalid?.reason).toContain("可解析的结论");
  });

  it("onReviewUnavailable=allow 时显式放行并说明来源（D7）", async () => {
    const harness = setup({
      global: { permission: { write: "review" }, onReviewUnavailable: "allow" },
    });

    const outcome = await harness.engine.decideToolCall(
      writeEvent("/repo/a.txt"),
      context(harness),
    );

    expect(outcome?.final).toBe("allow");
    expect(outcome?.reason).toContain("onReviewUnavailable=allow");
  });

  it("onReviewUnavailable=ask 时转人工（D7）", async () => {
    const harness = setup({
      global: {
        permission: { write: "review" },
        onReviewUnavailable: "ask",
      },
    });

    const outcome = await harness.engine.decideToolCall(
      writeEvent("/repo/a.txt"),
      context(harness, { hasUI: true, selectResult: CHOICE_DENY }),
    );

    expect(outcome?.source).toBe("human");
    expect(outcome?.final).toBe("deny");
  });

  it("评审调用不产生额外的审计条目（FR-28）", async () => {
    const review = createFakeReview({
      responses: [{ toolCalls: [verdictToolCall({ decision: "allow" })] }],
    });
    const harness = setup({
      ...reviewConfig({ permission: { write: "review" } }),
      review,
    });

    await harness.engine.decideToolCall(writeEvent("/repo/a.txt"), context(harness));
    await harness.audit.flush();

    expect(harness.audit.written).toBe(1);
    expect(harness.pi.entries).toHaveLength(1);
  });

  it("评审证据工具仅按白名单提供，未知工具调用被拒绝并回喂（FR-24）", async () => {
    const review = createFakeReview({
      responses: [
        { toolCalls: [{ name: "bash", arguments: { command: "rm -rf /" } }] },
        { toolCalls: [verdictToolCall({ decision: "deny" })] },
      ],
    });
    const harness = setup({
      global: {
        reviewer: { model: REVIEW_MODEL, evidenceTools: true, transcript: false },
        permission: { write: "review" },
      },
      review,
    });
    const ctx = context(harness);

    await harness.engine.decideToolCall(writeEvent("/repo/a.txt"), ctx);

    const tools = review.contexts()[0]?.tools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual([
      "submit_verdict",
      "read",
      "grep",
      "find",
      "ls",
    ]);
    // 第二轮的会话里必须出现"工具不可用"的错误结果，而不是静默忽略。
    const secondRound = review.contexts()[1]?.messages ?? [];
    const toolResult = secondRound.find((message) => message.role === "toolResult");
    expect(toolResult).toMatchObject({ toolName: "bash", isError: true });
  });

  it("超过查证轮次上限后强制无工具作答（FR-24）", async () => {
    const review = createFakeReview({
      responses: [
        { toolCalls: [{ name: "ls", arguments: { path: "." } }] },
        { text: '{"decision":"deny","riskLevel":"high","userAuthorization":"unknown","reversible":false,"rationale":"查不到足够信息"}' },
      ],
    });
    const harness = setup({
      global: {
        reviewer: {
          model: REVIEW_MODEL,
          evidenceTools: true,
          transcript: false,
          maxEvidenceRounds: 1,
        },
        permission: { write: "review" },
      },
      review,
    });

    const outcome = await harness.engine.decideToolCall(
      writeEvent("/repo/a.txt"),
      context(harness),
    );

    expect(outcome?.final).toBe("deny");
    expect(outcome?.evidenceRounds).toBe(1);
    // 最后一轮的 context 不带工具：模型必须直接作答。
    expect(review.contexts().at(-1)?.tools).toBeUndefined();
  });
});

describe("决策管线：review 转人工兜底（M3 行为在不可用时的落点）", () => {
  it("review 不可用且 onReviewUnavailable=ask 时，选择「仅此次允许」放行且不创建授权", async () => {
    const harness = setup({
      global: { permission: { write: "review" }, onReviewUnavailable: "ask" },
    });
    const ctx = context(harness, { hasUI: true, selectResult: CHOICE_ONCE });

    const outcome = await harness.engine.decideToolCall(writeEvent("/repo/a.txt"), ctx);

    expect(outcome?.proposed).toBe("review");
    expect(outcome?.final).toBe("allow");
    expect(outcome?.source).toBe("human");
    expect(harness.runtime.grants.keys.size).toBe(0);
  });

  it("取消对话框按拒绝处理（fail-closed）", async () => {
    const harness = setup({
      global: { permission: { write: "review" }, onReviewUnavailable: "ask" },
    });
    const ctx = context(harness, { hasUI: true, selectResult: undefined });

    const outcome = await harness.engine.decideToolCall(writeEvent("/repo/a.txt"), ctx);

    expect(outcome?.final).toBe("deny");
    expect(outcome?.source).toBe("human");
    expect(outcome?.reason).toContain("人工拒绝");
  });

  it("「本会话允许此类」写入授权，等价调用走 session-grant 快路径（FR-29/30）", async () => {
    const harness = setup({
      global: { permission: { write: "review" }, onReviewUnavailable: "ask" },
    });

    const first = await harness.engine.decideToolCall(
      writeEvent("/repo/a.txt"),
      context(harness, { hasUI: true, selectResult: CHOICE_SESSION }),
    );
    expect(first?.source).toBe("human");
    expect(harness.runtime.grants.keys.size).toBeGreaterThan(0);

    // 第二次：即使对话框默认选"拒绝"，也不应再被询问。
    const second = await harness.engine.decideToolCall(
      writeEvent("/repo/a.txt"),
      context(harness, { hasUI: true, selectResult: CHOICE_DENY }),
    );
    expect(second?.source).toBe("session-grant");
    expect(second?.final).toBe("allow");
  });

  it("会话授权永不覆盖 deny", async () => {
    const harness = setup({
      global: { permission: { bash: { "rm -rf /": "deny" } } },
    });
    harness.runtime.grants.keys.add(
      encodeGrantKey({ surface: "bash", pattern: "rm -rf / *" }),
    );

    const outcome = await harness.engine.decideToolCall(bashEvent("rm -rf /"), context(harness));

    expect(outcome?.final).toBe("deny");
    expect(outcome?.source).toBe("policy");
  });

  it("facts 带 unresolved 时跳过授权快路径", async () => {
    const harness = setup({
      global: { onUnresolvedFacts: "review", onReviewUnavailable: "ask" },
    });
    harness.runtime.grants.keys.add(
      encodeGrantKey({ surface: "bash", pattern: 'bash -c "rm -rf /" *' }),
    );

    const outcome = await harness.engine.decideToolCall(
      bashEvent('bash -c "rm -rf /"'),
      context(harness, { hasUI: true, selectResult: CHOICE_DENY }),
    );

    expect(outcome?.proposed).toBe("review");
    expect(outcome?.final).toBe("deny");
    expect(outcome?.source).toBe("human");
  });

  it("无 UI 时 ask 按 onAskWithoutUI 处理（FR-46）", async () => {
    const denied = await setup({
      global: { permission: { write: "review" }, onReviewUnavailable: "ask" },
    }).engine.decideToolCall(writeEvent("/repo/a.txt"), context(setupBase(), { hasUI: false }));
    expect(denied?.final).toBe("deny");
    expect(denied?.reason).toContain("onAskWithoutUI");
  });

  it("无 UI 且 onAskWithoutUI=review 时 fail-closed 到 deny", async () => {
    const harness = setup({
      global: {
        permission: { write: "review" },
        onReviewUnavailable: "ask",
        onAskWithoutUI: "review",
      },
    });

    const outcome = await harness.engine.decideToolCall(
      writeEvent("/repo/a.txt"),
      context(harness, { hasUI: false }),
    );

    expect(outcome?.final).toBe("deny");
    expect(outcome?.reason).toContain("onAskWithoutUI=review");
  });

  it("yoloMode 把 ask / review 放行且不调用评审、不弹窗（FR-53）", async () => {
    const harness = setup({ global: { yoloMode: true } });
    const ctx = context(harness, { hasUI: true, selectResult: CHOICE_DENY });

    const outcome = await harness.engine.decideToolCall(writeEvent("/repo/a.txt"), ctx);

    expect(outcome?.proposed).toBe("review");
    expect(outcome?.final).toBe("allow");
    expect(outcome?.reason).toContain("yoloMode");
    expect(ctx.uiCalls.selects).toHaveLength(0);
  });
});

describe("决策管线：调用级冲突与不可信 facts", () => {
  it("跨命令单元 allow / deny 冲突按 onMixedCommandActions 处理（FR-59）", async () => {
    const harness = setup({
      global: {
        permission: { bash: { "echo *": "allow", "rm -rf /": "deny" } },
      },
    });

    const outcome = await harness.engine.decideToolCall(
      bashEvent("echo ok && rm -rf /"),
      context(harness, { hasUI: false }),
    );

    expect(outcome?.proposed).toBe("deny");
    expect(outcome?.final).toBe("deny");
    expect(outcome?.reason).toContain("onMixedCommandActions");
  });

  it("unresolved + 可信 deny 固定转人工确认（FR-61）", async () => {
    const harness = setup({
      global: { permission: { bash: { "rm -rf /": "deny" } } },
    });

    const outcome = await harness.engine.decideToolCall(
      bashEvent("rm -rf / && bash -c hidden"),
      context(harness, { hasUI: true, selectResult: CHOICE_ONCE }),
    );

    expect(outcome?.proposed).toBe("ask");
    expect(outcome?.final).toBe("allow");
    expect(outcome?.source).toBe("human");
  });

  it("自定义工具在 gate=all 下按 `tool` 哨兵默认 review", async () => {
    const harness = setup({ global: { gate: "all" } });

    const outcome = await harness.engine.decideToolCall(
      customEvent("mcp__x__y"),
      context(harness, { hasUI: false }),
    );

    expect(outcome?.proposed).toBe("review");
    expect(outcome?.final).toBe("deny");
  });
});

describe("决策管线：观测面（FR-43/FR-45）", () => {
  it("审计日志与会话记录使用同一份结论", async () => {
    const harness = setup({
      global: { permission: { bash: { "rm -rf /": "deny" } } },
    });

    await harness.engine.handleToolCall(bashEvent("rm -rf /"), context(harness));
    await harness.audit.flush();

    expect(harness.audit.written).toBe(1);
    const entry = JSON.parse(
      readFileSync(harness.audit.currentPath(), "utf8").trim().split("\n").at(-1) as string,
    ) as Record<string, unknown>;
    expect(entry).toMatchObject({
      toolName: "bash",
      toolCallId: "call-bash",
      action: "deny",
      source: "policy",
      surface: "bash",
    });
    expect(entry["targets"]).toContain("rm -rf /");

    expect(harness.pi.entries).toHaveLength(1);
    expect(harness.pi.entries[0]?.customType).toBe(DECISION_ENTRY_TYPE);
    expect(harness.pi.entries[0]?.data).toMatchObject({
      toolName: "bash",
      decision: "deny",
      source: "policy",
    });
  });
});

/** 供"两个 setup 交叉"的用例占位；避免重复创建临时目录。 */
function setupBase(): Harness {
  return setup();
}
