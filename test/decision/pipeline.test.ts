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
import { createFakeContext, type FakeContext } from "../support/fake-context.ts";
import { createFakePi, type FakePi } from "../support/fake-pi.ts";
import { resolveConfig, type ResolveOptions } from "../support/resolved-config.ts";
import { createTempDir } from "../support/tmp.ts";

/**
 * 最小决策管线（M3，architecture §4）。
 *
 * facts 用**真实解析器**（bash 用例会先预热），因为这里验证的正是"facts → 规则 → 授权 → 人工"
 * 的整条链路，包括 unresolved、包装器与重定向这些只有真实 facts 才有的输入。
 */

const CWD = "/repo";
const HOME = "/home/u";

interface Harness {
  engine: DecisionEngine;
  runtime: GuardianRuntime;
  pi: FakePi;
  audit: AuditLogger;
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

function setup(options: ResolveOptions = {}): Harness {
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
  return { engine, runtime, pi, audit };
}

function context(options: Parameters<typeof createFakeContext>[0] = {}): FakeContext {
  return createFakeContext({ cwd: CWD, ...options });
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

    expect(await harness.engine.handleToolCall(bashEvent("rm -rf /"), context())).toBeUndefined();
  });

  it("gate 未覆盖的工具完全不参与", async () => {
    const harness = setup();

    expect(
      await harness.engine.handleToolCall(customEvent("mcp__x__y"), context()),
    ).toBeUndefined();
  });

  it("规则 allow 与默认矩阵 allow 都返回 undefined（不介入）", async () => {
    const allowed = setup({ global: { permission: { bash: { "echo *": "allow" } } } });
    expect(await allowed.engine.handleToolCall(bashEvent("echo hi"), context())).toBeUndefined();

    const readDefault = setup();
    expect(await readDefault.engine.handleToolCall(readEvent("/repo/a.txt"), context())).toBeUndefined();
  });

  it("deny 返回 block，理由含命中模式、自定义 reason 与反规避条款（FR-10/FR-26）", async () => {
    const harness = setup({
      global: {
        permission: { bash: { "rm -rf /": { action: "deny", reason: "根目录删除" } } },
      },
    });

    const result = await harness.engine.handleToolCall(bashEvent("rm -rf /"), context());

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("rm -rf /");
    expect(result?.reason).toContain("根目录删除");
    expect(result?.reason).toContain("反规避");
  });

  it("`read ./.env` 由敏感路径规则拒绝", async () => {
    const harness = setup({ global: { permission: { path: { "*.env": "deny" } } } });

    const outcome = await harness.engine.decideToolCall(readEvent("./.env"), context());

    expect(outcome?.proposed).toBe("deny");
    expect(outcome?.final).toBe("deny");
    expect(outcome?.targets).toContain("/repo/.env");
  });

  it("配置尚未加载时按 fail-closed 拦截", async () => {
    const harness = setup();
    harness.runtime.config = undefined;

    const result = await harness.engine.handleToolCall(bashEvent("echo hi"), context());

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("配置尚未加载");
  });

  it("护栏内部异常也返回 block（§9 最后一行）", async () => {
    const harness = setup({ global: { permission: { write: "review" } } });
    const ctx = context({ hasUI: true });
    ctx.ui.select = async (): Promise<string | undefined> => {
      throw new Error("ui boom");
    };

    const result = await harness.engine.handleToolCall(writeEvent("/repo/a.txt"), ctx);

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("护栏内部异常");
  });
});

describe("决策管线：review 与人工兜底（M3 不接评审层）", () => {
  it("review 转人工，选择「仅此次允许」放行且不创建授权", async () => {
    const harness = setup({ global: { permission: { write: "review" } } });
    const ctx = context({ hasUI: true, selectResult: CHOICE_ONCE });

    const outcome = await harness.engine.decideToolCall(writeEvent("/repo/a.txt"), ctx);

    expect(outcome?.proposed).toBe("review");
    expect(outcome?.final).toBe("allow");
    expect(outcome?.source).toBe("human");
    expect(harness.runtime.grants.keys.size).toBe(0);
  });

  it("取消对话框按拒绝处理（fail-closed）", async () => {
    const harness = setup({ global: { permission: { write: "review" } } });
    const ctx = context({ hasUI: true, selectResult: undefined });

    const outcome = await harness.engine.decideToolCall(writeEvent("/repo/a.txt"), ctx);

    expect(outcome?.final).toBe("deny");
    expect(outcome?.source).toBe("human");
    expect(outcome?.reason).toContain("人工拒绝");
  });

  it("「本会话允许此类」写入授权，等价调用走 session-grant 快路径（FR-29/30）", async () => {
    const harness = setup({ global: { permission: { write: "review" } } });

    const first = await harness.engine.decideToolCall(
      writeEvent("/repo/a.txt"),
      context({ hasUI: true, selectResult: CHOICE_SESSION }),
    );
    expect(first?.source).toBe("human");
    expect(harness.runtime.grants.keys.size).toBeGreaterThan(0);

    // 第二次：即使对话框默认选"拒绝"，也不应再被询问。
    const second = await harness.engine.decideToolCall(
      writeEvent("/repo/a.txt"),
      context({ hasUI: true, selectResult: CHOICE_DENY }),
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

    const outcome = await harness.engine.decideToolCall(bashEvent("rm -rf /"), context());

    expect(outcome?.final).toBe("deny");
    expect(outcome?.source).toBe("policy");
  });

  it("facts 带 unresolved 时跳过授权快路径", async () => {
    const harness = setup({ global: { onUnresolvedFacts: "review" } });
    harness.runtime.grants.keys.add(
      encodeGrantKey({ surface: "bash", pattern: 'bash -c "rm -rf /" *' }),
    );

    const outcome = await harness.engine.decideToolCall(
      bashEvent('bash -c "rm -rf /"'),
      context({ hasUI: true, selectResult: CHOICE_DENY }),
    );

    expect(outcome?.proposed).toBe("review");
    expect(outcome?.final).toBe("deny");
    expect(outcome?.source).toBe("human");
  });

  it("无 UI 时 ask 按 onAskWithoutUI 处理（FR-46）", async () => {
    const denied = await setup({ global: { permission: { write: "review" } } })
      .engine.decideToolCall(writeEvent("/repo/a.txt"), context({ hasUI: false }));
    expect(denied?.final).toBe("deny");
    expect(denied?.reason).toContain("onAskWithoutUI");

    const allowed = await setup({
      global: { permission: { write: "review" }, onAskWithoutUI: "allow" },
    }).engine.decideToolCall(writeEvent("/repo/a.txt"), context({ hasUI: false }));
    expect(allowed?.final).toBe("allow");
  });

  it("无 UI 且 onAskWithoutUI=review 时 fail-closed 到 deny", async () => {
    const harness = setup({
      global: { permission: { write: "review" }, onAskWithoutUI: "review" },
    });

    const outcome = await harness.engine.decideToolCall(
      writeEvent("/repo/a.txt"),
      context({ hasUI: false }),
    );

    expect(outcome?.final).toBe("deny");
    expect(outcome?.reason).toContain("onAskWithoutUI=review");
  });

  it("yoloMode 把 ask / review 放行且不弹窗（FR-53）", async () => {
    const harness = setup({ global: { yoloMode: true } });
    const ctx = context({ hasUI: true, selectResult: CHOICE_DENY });

    const outcome = await harness.engine.decideToolCall(writeEvent("/repo/a.txt"), ctx);

    expect(outcome?.proposed).toBe("review");
    expect(outcome?.final).toBe("allow");
    expect(outcome?.reason).toContain("yoloMode");
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
      context({ hasUI: false }),
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
      context({ hasUI: true, selectResult: CHOICE_ONCE }),
    );

    expect(outcome?.proposed).toBe("ask");
    expect(outcome?.final).toBe("allow");
    expect(outcome?.source).toBe("human");
  });

  it("自定义工具在 gate=all 下按 `tool` 哨兵默认 review", async () => {
    const harness = setup({ global: { gate: "all" } });

    const outcome = await harness.engine.decideToolCall(
      customEvent("mcp__x__y"),
      context({ hasUI: false }),
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

    await harness.engine.handleToolCall(bashEvent("rm -rf /"), context());
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
