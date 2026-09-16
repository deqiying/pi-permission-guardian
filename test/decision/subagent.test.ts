import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { AuditLogger } from "../../src/audit/logger.ts";
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
 * 子代理会话策略（FR-56）。
 *
 * 三条不变量在这里固化：
 * - 子代理默认动作只**收紧**默认动作矩阵，用户显式规则（allow 与 deny）都不受影响；
 * - 只读白名单与 `onUnresolvedFacts` 不属于默认动作，保持原语义（已文档化的边界）；
 * - `allowSessionGrants=false`（默认）时子代理既不能用也不能创建会话授权。
 */

const CWD = "/repo";
const HOME = "/home/u";
const REVIEW_MODEL = "test/reviewer";

interface Harness {
  engine: DecisionEngine;
  runtime: GuardianRuntime;
  pi: FakePi;
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
  /** 模拟"本会话已被识别为子代理会话"。 */
  subagent?: boolean;
}

function setup(options: SetupOptions = {}): Harness {
  const runtime = createRuntime();
  const dir = createTempDir("guardian-subagent-");
  const pi = createFakePi();
  const engine = createDecisionEngine({
    pi,
    runtime,
    audit: new AuditLogger({ dir, enabled: false }),
    env: { home: HOME, platform: "linux" },
  });
  runtime.config = resolveConfig(options);
  runtime.configVersion = 1;
  runtime.engaged = true;
  runtime.isSubagentSession = options.subagent ?? false;
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return { engine, runtime, pi, review: options.review };
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

function reviewAllowing(): FakeReview {
  return createFakeReview({
    responses: [{ toolCalls: [verdictToolCall({ decision: "allow", riskLevel: "low" })] }],
  });
}

function reviewConfig(extra: Record<string, unknown> = {}): ResolveOptions {
  return {
    global: {
      reviewer: { model: REVIEW_MODEL, evidenceTools: false, transcript: false },
      ...extra,
    },
  };
}

function readEvent(path = "/repo/a.txt"): ToolCallEvent {
  return {
    type: "tool_call",
    toolName: "read",
    toolCallId: `call-read-${path}`,
    input: { path },
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

describe("子代理默认动作（FR-56）", () => {
  it("默认矩阵的 allow 被抬到 subagentPolicy.defaultAction", async () => {
    const review = reviewAllowing();
    const harness = setup({ ...reviewConfig(), review, subagent: true });

    // 只读文件工具在父会话里默认 allow；子代理会话里默认 review。
    const parent = setup({ ...reviewConfig(), review: reviewAllowing() });
    expect(await parent.engine.handleToolCall(readEvent(), context(parent))).toBeUndefined();

    const outcome = await harness.engine.decideToolCall(readEvent(), context(harness));

    expect(outcome?.proposed).toBe("review");
    expect(outcome?.source).toBe("reviewer");
    expect(outcome?.final).toBe("allow");
    expect(review.calls).toHaveLength(1);
  });

  it("defaultAction 配置为 deny 时默认动作直接拦截", async () => {
    const harness = setup({
      global: { subagentPolicy: { defaultAction: "deny" } },
      subagent: true,
    });

    const outcome = await harness.engine.decideToolCall(readEvent(), context(harness));

    expect(outcome?.proposed).toBe("deny");
    expect(outcome?.final).toBe("deny");
    expect(outcome?.reason).toContain("subagentPolicy.defaultAction");
  });

  it("subagentPolicy.enabled=false 时不适用子代理策略", async () => {
    const harness = setup({
      global: { subagentPolicy: { enabled: false, defaultAction: "deny" } },
      subagent: true,
    });

    expect(await harness.engine.handleToolCall(readEvent(), context(harness))).toBeUndefined();
  });

  it("父配置里的显式规则不被子代理策略放宽或覆盖（FR-54）", async () => {
    const allowed = setup({
      global: {
        permission: { read: "allow" },
        subagentPolicy: { defaultAction: "deny" },
      },
      subagent: true,
    });
    expect(
      await allowed.engine.handleToolCall(readEvent(), context(allowed)),
    ).toBeUndefined();

    const denied = setup({
      global: {
        permission: { bash: { "rm -rf /": "deny" } },
        subagentPolicy: { defaultAction: "review" },
      },
      subagent: true,
    });
    const outcome = await denied.engine.decideToolCall(
      bashEvent("rm -rf /"),
      context(denied),
    );
    expect(outcome?.final).toBe("deny");
    expect(outcome?.source).toBe("policy");
  });

  it("只读白名单不受子代理默认动作影响（已文档化的边界）", async () => {
    const harness = setup({
      global: { subagentPolicy: { defaultAction: "deny" } },
      subagent: true,
    });

    expect(
      await harness.engine.handleToolCall(bashEvent("ls -la"), context(harness)),
    ).toBeUndefined();
  });
});

describe("子代理会话授权（FR-56）", () => {
  function askConfig(): ResolveOptions {
    return {
      global: { permission: { read: "ask" } },
    };
  }

  it("allowSessionGrants=false 时已有的授权键不放行子代理调用", async () => {
    const harness = setup({ ...askConfig(), subagent: true });
    harness.runtime.grants.keys.add(
      encodeGrantKey({ surface: "read", pattern: "read *" }),
    );

    const outcome = await harness.engine.decideToolCall(
      readEvent(),
      context(harness, { hasUI: true, selectResult: CHOICE_DENY }),
    );

    expect(outcome?.source).toBe("human");
    expect(outcome?.final).toBe("deny");
  });

  it("allowSessionGrants=false 时对话框不提供「本会话允许此类」，也不写入授权", async () => {
    const harness = setup({ ...askConfig(), subagent: true });
    const ctx = context(harness, { hasUI: true, selectResult: CHOICE_SESSION });

    const outcome = await harness.engine.decideToolCall(readEvent(), ctx);

    expect(ctx.uiCalls.selects[0]?.options).toEqual([
      CHOICE_ONCE,
      CHOICE_DENY,
      "拒绝并说明…",
    ]);
    expect(harness.runtime.grants.keys.size).toBe(0);
    // 即使（在真实 UI 上不可能地）选出未提供的选项，也不得静默建授权或降级放行。
    expect(outcome?.final).toBe("deny");
    expect(outcome?.reason).toContain("不允许创建会话授权");
  });

  it("allowSessionGrants=true 时子代理可以使用并创建自己的授权", async () => {
    const harness = setup({
      global: {
        permission: { read: "ask" },
        subagentPolicy: { allowSessionGrants: true },
      },
      subagent: true,
    });

    const created = await harness.engine.decideToolCall(
      readEvent(),
      context(harness, { hasUI: true, selectResult: CHOICE_SESSION }),
    );
    expect(created?.source).toBe("human");
    expect(harness.runtime.grants.keys.size).toBeGreaterThan(0);

    const reuse = await harness.engine.decideToolCall(
      readEvent(),
      context(harness, { hasUI: true, selectResult: CHOICE_DENY }),
    );
    expect(reuse?.source).toBe("session-grant");
    expect(reuse?.final).toBe("allow");
  });
});
