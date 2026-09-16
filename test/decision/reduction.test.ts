import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { AuditLogger } from "../../src/audit/logger.ts";
import { resetBreaker } from "../../src/decision/breaker.ts";
import type { DecisionOutcome } from "../../src/decision/outcome.ts";
import { createDecisionEngine, type DecisionEngine } from "../../src/decision/pipeline.ts";
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
import { createFakeReview, verdictToolCall, type FakeReview } from "../support/fake-review.ts";
import { resolveConfig, type ResolveOptions } from "../support/resolved-config.ts";
import { createTempDir } from "../support/tmp.ts";

/**
 * M5 降本机制（缓存 / 熔断 / 预评分）在真实管线里的行为（FR-31~FR-38、FR-41/42）。
 *
 * 这些用例守的是"降本不能放宽失败语义"：缓存不得固化 unavailable，被拒过的工具不得走快路径，
 * 预评分只放行、不拒绝，也不得把基础设施失败伪装成风险 deny。
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
  await ensureBashParser();
});

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

interface SetupOptions extends ResolveOptions {
  review?: FakeReview;
  onDecision?: (outcome: DecisionOutcome, ctx: ExtensionContext) => void;
}

function setup(options: SetupOptions = {}): Harness {
  const runtime = createRuntime();
  const dir = createTempDir("guardian-reduction-");
  const audit = new AuditLogger({ dir, enabled: false });
  const pi = createFakePi();
  const engine = createDecisionEngine({
    pi,
    runtime,
    audit,
    env: { home: HOME, platform: "linux" },
    ...(options.onDecision === undefined ? {} : { onDecision: options.onDecision }),
  });
  runtime.config = resolveConfig(options);
  runtime.configVersion = 1;
  runtime.engaged = true;
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return { engine, runtime, pi, audit, review: options.review };
}

function context(harness: Harness, options: FakeContextOptions = {}): FakeContext {
  return createFakeContext({
    cwd: CWD,
    ...(harness.review === undefined
      ? {}
      : { models: harness.review.models, complete: harness.review.complete }),
    ...options,
  });
}

function reviewConfig(extra: Record<string, unknown> = {}): ResolveOptions {
  return {
    global: {
      reviewer: { model: REVIEW_MODEL, evidenceTools: false, transcript: false },
      permission: { write: "review" },
      ...extra,
    },
  };
}

function writeEvent(path = "/repo/a.txt"): ToolCallEvent {
  return {
    type: "tool_call",
    toolName: "write",
    toolCallId: `call-${path}`,
    input: { path, content: "x" },
  } as ToolCallEvent;
}

function bashEvent(command: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolName: "bash",
    toolCallId: `call-${command}`,
    input: { command },
  } as ToolCallEvent;
}

describe("判定缓存（FR-31~33）", () => {
  it("相同 key 二次调用不产生评审，来源标为 cache", async () => {
    const review = createFakeReview({
      responses: [{ toolCalls: [verdictToolCall({ decision: "allow", riskLevel: "low" })] }],
    });
    const harness = setup({ ...reviewConfig(), review });

    const first = await harness.engine.decideToolCall(writeEvent(), context(harness));
    const second = await harness.engine.decideToolCall(writeEvent(), context(harness));

    expect(first?.source).toBe("reviewer");
    expect(second?.source).toBe("cache");
    expect(second?.final).toBe("allow");
    expect(second?.reason).toContain("命中判定缓存");
    expect(review.calls).toHaveLength(1);
  });

  it("不固化 unavailable：评审未完成不会在 TTL 内变成\"永远超时\"", async () => {
    const harness = setup({ global: { permission: { write: "review" } } });

    const first = await harness.engine.decideToolCall(writeEvent(), context(harness));
    const second = await harness.engine.decideToolCall(writeEvent(), context(harness));

    expect(first?.verdict).toBe("unavailable");
    expect(second?.source).toBe("policy");
    expect(second?.verdict).toBe("unavailable");
    expect(harness.runtime.cache.entries.size).toBe(0);
  });

  it("不固化 ask 与人工的临时允许", async () => {
    const harness = setup({ global: { permission: { write: "ask" } } });
    const ctx = context(harness, { hasUI: true, selectResult: CHOICE_ONCE });

    const outcome = await harness.engine.decideToolCall(writeEvent(), ctx);

    expect(outcome?.source).toBe("human");
    expect(harness.runtime.cache.entries.size).toBe(0);

    // 第二次仍要重新询问：人工的"仅此次"不能被缓存放大成"以后都行"。
    const second = await harness.engine.decideToolCall(
      writeEvent(),
      context(harness, { hasUI: true, selectResult: CHOICE_DENY }),
    );
    expect(second?.source).toBe("human");
    expect(second?.final).toBe("deny");
  });

  it("规则集版本与用户授权版本变化都会让缓存失效", async () => {
    const review = createFakeReview({
      responses: [{ toolCalls: [verdictToolCall({ decision: "allow" })] }],
    });
    const harness = setup({ ...reviewConfig(), review });

    await harness.engine.decideToolCall(writeEvent(), context(harness));
    const cached = await harness.engine.decideToolCall(writeEvent(), context(harness));
    expect(cached?.source).toBe("cache");

    harness.runtime.configVersion += 1;
    const afterConfig = await harness.engine.decideToolCall(writeEvent(), context(harness));
    expect(afterConfig?.source).toBe("reviewer");

    harness.runtime.authorizationVersion = "新指令指纹";
    const afterPrompt = await harness.engine.decideToolCall(writeEvent(), context(harness));
    expect(afterPrompt?.source).toBe("reviewer");
    expect(review.calls).toHaveLength(3);
  });

  it("会话授权命中先于缓存", async () => {
    const review = createFakeReview({
      responses: [{ toolCalls: [verdictToolCall({ decision: "allow" })] }],
    });
    const harness = setup({ ...reviewConfig(), review });

    await harness.engine.decideToolCall(writeEvent(), context(harness));
    expect(harness.runtime.cache.entries.size).toBe(1);
    harness.runtime.grants.keys.add(
      encodeGrantKey({ surface: "write", pattern: "write *" }),
    );

    const granted = await harness.engine.decideToolCall(writeEvent(), context(harness));

    expect(granted?.source).toBe("session-grant");
    expect(review.calls).toHaveLength(1);
  });
});

describe("熔断器（FR-34/35）", () => {
  it("连续 deny 达阈值时拦截并 terminate 本轮", async () => {
    const harness = setup({
      global: { permission: { bash: { "rm *": "deny", "echo *": "allow" } } },
    });

    const outcomes = [];
    for (let index = 0; index < 3; index += 1) {
      outcomes.push(await harness.engine.decideToolCall(bashEvent("rm -rf /tmp/x"), context(harness)));
    }

    expect(outcomes[0]?.terminate).toBeUndefined();
    expect(outcomes[2]?.terminate).toBe(true);
    expect(outcomes[2]?.reason).toContain("熔断");

    // 熔断后本轮所有进入评估范围的调用都被拦下，哪怕是本来允许的命令。
    const blocked = await harness.engine.handleToolCall(bashEvent("echo hi"), context(harness));
    expect(blocked).toMatchObject({ block: true, terminate: true });
    expect(blocked?.reason).toContain("熔断");

    const outcome = await harness.engine.decideToolCall(bashEvent("echo hi"), context(harness));
    expect(outcome?.source).toBe("circuit-breaker");

    // 每轮重置后恢复（`turn_start` 由扩展接线调用）。
    resetBreaker(harness.runtime.breaker);
    expect(
      await harness.engine.handleToolCall(bashEvent("echo hi"), context(harness)),
    ).toBeUndefined();
  });

  it("被 deny 过的工具在同一轮内失去缓存快路径（FR-35）", async () => {
    const review = createFakeReview({
      responses: [
        { toolCalls: [verdictToolCall({ decision: "deny", riskLevel: "high" })] },
        { toolCalls: [verdictToolCall({ decision: "allow", riskLevel: "low" })] },
      ],
    });
    const harness = setup({ ...reviewConfig(), review });

    const denied = await harness.engine.decideToolCall(writeEvent(), context(harness));
    expect(denied?.final).toBe("deny");

    // 同轮重试必须重新评审，而不是复用缓存的 deny。
    const retried = await harness.engine.decideToolCall(writeEvent(), context(harness));

    expect(retried?.source).toBe("reviewer");
    expect(retried?.verdict).toBe("allow");
    expect(review.calls).toHaveLength(2);
  });

  it("评审不可用产生的 deny 不计入风险阈值，也不被伪装成风险 deny", async () => {
    const harness = setup({ global: { permission: { write: "review" } } });

    for (let index = 0; index < 5; index += 1) {
      const outcome = await harness.engine.decideToolCall(writeEvent(), context(harness));
      expect(outcome?.verdict).toBe("unavailable");
      expect(outcome?.terminate).toBeUndefined();
      expect(outcome?.source).not.toBe("circuit-breaker");
    }

    expect(harness.runtime.breaker.tripped).toBe(false);
    expect(harness.runtime.breaker.consecutiveDenials).toBe(0);
    // 但该工具确实失去了快路径：deniedTools 被记录。
    expect(harness.runtime.breaker.deniedTools.has("write")).toBe(true);
  });
});

describe("非阻塞预评分（FR-36~38）", () => {
  function classifierConfig(): Record<string, unknown> {
    return { classifier: { enabled: true, model: REVIEW_MODEL } };
  }

  it("默认关闭时不发起任何额外模型调用", async () => {
    const review = createFakeReview({
      responses: [{ toolCalls: [verdictToolCall({ decision: "allow" })] }],
    });
    const harness = setup({ ...reviewConfig(), review });
    // 即使运行时残留一份低风险评分，classifier.enabled=false 时也不得放行。
    harness.runtime.classifier.last = {
      score: "low",
      callIndex: harness.runtime.callIndex,
      authorizationVersion: harness.runtime.authorizationVersion,
    };

    const outcome = await harness.engine.decideToolCall(writeEvent(), context(harness));

    expect(outcome?.source).toBe("reviewer");
    expect(review.calls).toHaveLength(1);
  });

  it("低风险评分让下一次调用走快路径放行，且不产生评审", async () => {
    const review = createFakeReview({
      responses: [{ toolCalls: [verdictToolCall({ decision: "allow" })] }],
    });
    const harness = setup({ ...reviewConfig(classifierConfig()), review });
    harness.runtime.classifier.last = {
      score: "low",
      callIndex: harness.runtime.callIndex,
      authorizationVersion: harness.runtime.authorizationVersion,
    };

    const outcome = await harness.engine.decideToolCall(writeEvent(), context(harness));

    expect(outcome?.source).toBe("classifier");
    expect(outcome?.final).toBe("allow");
    expect(outcome?.reason).toContain("只放行、不拒绝");
    expect(review.calls).toHaveLength(0);
  });

  it("预评分不能覆盖 deny，滞后或授权版本变化即失活", async () => {
    const harness = setup({
      global: {
        permission: { write: { action: "deny", reason: "敏感文件" } },
        classifier: { enabled: true },
      },
    });
    harness.runtime.classifier.last = {
      score: "low",
      callIndex: harness.runtime.callIndex,
      authorizationVersion: harness.runtime.authorizationVersion,
    };

    const denied = await harness.engine.decideToolCall(writeEvent(), context(harness));
    expect(denied?.final).toBe("deny");
    expect(denied?.source).toBe("policy");

    const stale = setup({ ...reviewConfig(classifierConfig()) });
    stale.runtime.classifier.last = {
      score: "low",
      callIndex: 0,
      authorizationVersion: "旧指纹",
    };

    const outcome = await stale.engine.decideToolCall(writeEvent(), context(stale));
    expect(outcome?.source).toBe("policy");
    expect(outcome?.verdict).toBe("unavailable");
  });

  it("预评分产生的放行不喂熔断器（不打断被拒绝的连续性）", async () => {
    const harness = setup({ ...reviewConfig(classifierConfig()) });
    harness.runtime.breaker.consecutiveDenials = 2;
    harness.runtime.classifier.last = {
      score: "low",
      callIndex: harness.runtime.callIndex,
      authorizationVersion: harness.runtime.authorizationVersion,
    };

    const outcome = await harness.engine.decideToolCall(writeEvent(), context(harness));

    expect(outcome?.source).toBe("classifier");
    expect(harness.runtime.breaker.consecutiveDenials).toBe(2);
  });
});

describe("人工对话框与状态栏（FR-41/42）", () => {
  it("对话框给出四要素，选中「本会话允许此类」写入授权", async () => {
    const harness = setup({
      global: {
        permission: {
          write: { action: "review", reason: "会改动工作区文件" },
        },
        onReviewUnavailable: "ask",
      },
    });
    const ctx = context(harness, { hasUI: true, selectResult: CHOICE_SESSION });

    await harness.engine.decideToolCall(writeEvent(), ctx);

    const title = ctx.uiCalls.selects[0]?.title ?? "";
    expect(title).toContain("待执行动作：");
    expect(title).toContain("命中规则：");
    expect(title).toContain("会改动工作区文件");
    expect(title).toContain("风险点：");
    expect(title).toContain("建议动作：");
    expect(title).toContain('选择"本会话允许此类"将记住以下模式');
    expect(harness.runtime.grants.keys.size).toBeGreaterThan(0);
  });

  it("最近一次决策写入运行时状态，供状态栏显示来源", async () => {
    const harness = setup({ global: { permission: { write: "ask" } } });
    const ctx = context(harness, { hasUI: true, selectResult: CHOICE_DENY });

    expect(harness.runtime.lastDecision).toBeUndefined();
    await harness.engine.decideToolCall(writeEvent(), ctx);

    expect(harness.runtime.lastDecision).toEqual({
      final: "deny",
      source: "human",
      toolName: "write",
    });
  });

  it("决策观测回调被调用，且不影响返回值", async () => {
    const seen: string[] = [];
    const harness = setup({
      global: { permission: { write: "ask" } },
      onDecision: (outcome, ctx) => {
        seen.push(`${outcome.final}:${ctx.cwd}`);
      },
    });

    const outcome = await harness.engine.decideToolCall(
      writeEvent(),
      context(harness, { hasUI: true, selectResult: CHOICE_ONCE }),
    );

    expect(outcome?.final).toBe("allow");
    expect(seen).toEqual([`allow:${CWD}`]);
  });
});
