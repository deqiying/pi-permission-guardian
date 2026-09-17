import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { STATUS_BAR_KEY } from "../../src/audit/entry.ts";
import { authorizationFingerprint } from "../../src/decision/cache.ts";
import { GUARDIAN_COMMAND, registerGuardian } from "../../src/extension/register.ts";
import type { GuardianRuntime } from "../../src/extension/state.ts";
import {
  createFakeCommandContext,
  type FakeContextOptions,
} from "../support/fake-context.ts";
import { createFakePi, type FakePi } from "../support/fake-pi.ts";
import { createFakeReview } from "../support/fake-review.ts";
import {
  createWorkspace,
  type TempWorkspace,
  writeGlobalConfig,
} from "../support/tmp.ts";

/**
 * M5 在扩展层的接线（FR-33/36~38/41）。
 *
 * 这里验证的是"生命周期事件到底有没有把状态接上"：授权版本来自用户消息（`before_agent_start`
 * 与 `message_end`），预评分只在 `tool_result` 之后异步调度，状态栏与 `appendEntry` 共用一份结论。
 */

let harness: Harness | undefined;

afterEach(async () => {
  const current = harness;
  harness = undefined;
  // 审计日志是异步落盘（`AuditLogger.record` 只入队，`flush` 由 `session_shutdown` 触发）：
  // 不排空就直接删临时目录，删除动作会和 `appendFile` 抢同一个目录。Ubuntu runner 上表现为
  // `ENOTEMPTY: directory not empty, rmdir '…/extensions/pi-permission-guardian'`。
  if (current?.ctx !== undefined) {
    await current.pi.fire(
      "session_shutdown",
      { type: "session_shutdown", reason: "quit" },
      current.ctx,
    );
  }
  current?.workspace.cleanup();
});

interface Harness {
  pi: FakePi;
  runtime: GuardianRuntime;
  workspace: TempWorkspace;
  /** 最近一次 `session_start` 的上下文；收尾拿它跑 `session_shutdown`。 */
  ctx?: ReturnType<typeof createFakeCommandContext>;
}

function setup(): Harness {
  const workspace = createWorkspace();
  const pi = createFakePi();
  const runtime = registerGuardian(pi, {
    getAgentDir: () => workspace.agentDir,
    now: () => new Date(2026, 8, 16, 9, 0, 0),
    warn: () => {},
  });
  harness = { pi, runtime, workspace };
  return harness;
}

async function startSession(
  harness: Harness,
  options: FakeContextOptions = {},
): Promise<ReturnType<typeof createFakeCommandContext>> {
  const ctx = createFakeCommandContext({
    cwd: harness.workspace.cwd,
    hasUI: true,
    ...options,
  });
  await harness.pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  harness.ctx = ctx;
  return ctx;
}

function statusBar(ctx: ReturnType<typeof createFakeCommandContext>): string | undefined {
  return ctx.uiCalls.statuses.filter((status) => status.key === STATUS_BAR_KEY).at(-1)?.text;
}

describe("用户授权版本（FR-33）", () => {
  it("before_agent_start 用本轮 prompt 更新指纹", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, JSON.stringify({}));
    const ctx = await startSession(harness);
    expect(harness.runtime.authorizationVersion).toBe("");

    await harness.pi.fire(
      "before_agent_start",
      { type: "before_agent_start", prompt: "清理 dist 目录" },
      ctx,
    );

    expect(harness.runtime.authorizationVersion).toBe(
      authorizationFingerprint("清理 dist 目录"),
    );
  });

  it("指纹变化即清空会话授权与缓存", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, JSON.stringify({}));
    const ctx = await startSession(harness);
    await harness.pi.fire(
      "before_agent_start",
      { type: "before_agent_start", prompt: "清理 dist" },
      ctx,
    );
    harness.runtime.grants.keys.add("bash\u0000rm -rf ./dist *");
    harness.runtime.cache.entries.set("k", {
      outcome: { proposed: "review", final: "allow", source: "reviewer", targets: [] },
      storedAt: 0,
    });

    // 会话中途追加的用户消息（steer / followUp）走 message_end。
    await harness.pi.fire(
      "message_end",
      {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "顺便把 build 也删了" }] },
      },
      ctx,
    );

    expect(harness.runtime.authorizationVersion).toBe(
      authorizationFingerprint("顺便把 build 也删了"),
    );
    expect(harness.runtime.grants.keys.size).toBe(0);
    expect(harness.runtime.cache.entries.size).toBe(0);
  });

  it("相同的用户消息不重复清空", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, JSON.stringify({}));
    const ctx = await startSession(harness);
    const event = { type: "before_agent_start", prompt: "清理 dist" } as const;

    await harness.pi.fire("before_agent_start", event, ctx);
    harness.runtime.grants.keys.add("bash\u0000rm -rf ./dist *");
    await harness.pi.fire("before_agent_start", event, ctx);

    expect(harness.runtime.grants.keys.size).toBe(1);
  });

  it("assistant / toolResult 消息不参与授权版本", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, JSON.stringify({}));
    const ctx = await startSession(harness);
    harness.runtime.grants.keys.add("bash\u0000ls *");

    await harness.pi.fire(
      "message_end",
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "好" }] } },
      ctx,
    );

    expect(harness.runtime.authorizationVersion).toBe("");
    expect(harness.runtime.grants.keys.size).toBe(1);
  });
});

describe("状态栏与决策观测（FR-41）", () => {
  it("tool_call 之后状态栏显示最近一次决策来源", async () => {
    const harness = setup();
    writeGlobalConfig(
      harness.workspace,
      JSON.stringify({ permission: { bash: { "rm -rf /": "deny" } } }),
    );
    const ctx = await startSession(harness);
    expect(statusBar(ctx)).toBe("perm: on");

    await harness.pi.fire(
      "tool_call",
      { type: "tool_call", toolName: "bash", toolCallId: "c1", input: { command: "rm -rf /" } },
      ctx,
    );

    const text = statusBar(ctx) ?? "";
    expect(text).toContain("perm: on");
    expect(text).toContain("最近 bash → deny（policy）");
    // 会话内记录与状态栏来自同一份结论。
    expect(harness.pi.entries.at(-1)?.data).toMatchObject({
      toolName: "bash",
      decision: "deny",
      source: "policy",
    });
  });
});

describe("预评分接线（FR-36~38）", () => {
  const CLASSIFIER_CONFIG = JSON.stringify({
    reviewer: { model: "test/reviewer", transcript: false, evidenceTools: false },
    classifier: { enabled: true, model: "test/reviewer" },
    permission: { bash: { "npm *": "review" } },
  });

  it("tool_result 之后异步打分，下一次同类调用走快路径放行", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, CLASSIFIER_CONFIG);
    const review = createFakeReview({ responses: [{ text: "low" }] });
    const ctx = await startSession(harness, {
      models: review.models,
      complete: review.complete,
    });

    await harness.pi.fire(
      "tool_result",
      { type: "tool_result", toolName: "bash", toolCallId: "c1", input: {}, content: [] },
      ctx,
    );
    await vi.waitFor(() => {
      expect(harness.runtime.classifier.last?.score).toBe("low");
    });

    const result = await harness.pi.fire(
      "tool_call",
      { type: "tool_call", toolName: "bash", toolCallId: "c2", input: { command: "npm install" } },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(harness.runtime.lastDecision?.source).toBe("classifier");
    expect(review.calls).toHaveLength(1);

    await harness.pi.invokeCommand(
      GUARDIAN_COMMAND,
      "status",
      ctx as unknown as ExtensionCommandContext,
    );
    expect(ctx.uiCalls.notifications.at(-1)?.message).toContain("预评分 启用");
  });

  it("预评分失败记为 failure，不放行也不拒绝后续调用", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, CLASSIFIER_CONFIG);
    const review = createFakeReview({ responses: [{ text: "说不准" }] });
    const ctx = await startSession(harness, {
      models: review.models,
      complete: review.complete,
    });

    await harness.pi.fire(
      "tool_result",
      { type: "tool_result", toolName: "bash", toolCallId: "c1", input: {}, content: [] },
      ctx,
    );
    await vi.waitFor(() => {
      expect(harness.runtime.classifier.failure).toBeDefined();
    });

    expect(harness.runtime.classifier.last).toBeUndefined();
    // 失败不影响正常评审路径：没有 reviewer 响应可用时会变成 unavailable。
    const outcome = await harness.pi.fire(
      "tool_call",
      { type: "tool_call", toolName: "bash", toolCallId: "c2", input: { command: "npm install" } },
      ctx,
    );
    expect(outcome).toMatchObject({ block: true });
  });

  it("熔断器在 turn_start 重置，熔断后本轮提前结束", async () => {
    const harness = setup();
    writeGlobalConfig(
      harness.workspace,
      JSON.stringify({ permission: { bash: { "rm *": "deny", "echo *": "allow" } } }),
    );
    const ctx = await startSession(harness);

    const fire = (command: string): Promise<unknown> =>
      harness.pi.fire(
        "tool_call",
        { type: "tool_call", toolName: "bash", toolCallId: `c-${command}`, input: { command } },
        ctx,
      );

    await fire("rm -rf /tmp/a");
    await fire("rm -rf /tmp/b");
    const third = (await fire("rm -rf /tmp/c")) as { block?: boolean; terminate?: boolean };
    expect(third).toMatchObject({ block: true, terminate: true });

    await harness.pi.fire("turn_start", { type: "turn_start", turnIndex: 2 }, ctx);
    expect(harness.runtime.breaker.tripped).toBe(false);

    const afterReset = await fire("echo hi");
    expect(afterReset).toBeUndefined();
  });
});
