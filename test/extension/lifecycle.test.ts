import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { afterEach, describe, expect, it } from "vitest";

import { STATUS_BAR_KEY } from "../../src/audit/entry.ts";
import { GUARDIAN_COMMAND, GUARDIAN_FLAG, registerGuardian } from "../../src/extension/register.ts";
import type { GuardianRuntime } from "../../src/extension/state.ts";
import { createFakeCommandContext } from "../support/fake-context.ts";
import { createFakePi, type FakePi } from "../support/fake-pi.ts";
import {
  createWorkspace,
  type TempWorkspace,
  writeGlobalConfig,
  writeProjectConfig,
} from "../support/tmp.ts";

const SESSION_START = { type: "session_start", reason: "startup" } as const;

const REFERENCE_LIKE = JSON.stringify({
  gate: "side-effect",
  reviewer: { model: "deepseek/deepseek-flash" },
  permission: { read: "allow", bash: { "rm *": "review" } },
});

interface Harness {
  pi: ExtensionAPIWithFake;
  runtime: GuardianRuntime;
  workspace: TempWorkspace;
  warnings: string[];
}

type ExtensionAPIWithFake = FakePi;

let workspace: TempWorkspace | undefined;

afterEach(() => {
  workspace?.cleanup();
  workspace = undefined;
});

function setup(): Harness {
  workspace = createWorkspace();
  const warnings: string[] = [];
  const pi = createFakePi();
  const runtime = registerGuardian(pi, {
    getAgentDir: () => (workspace as TempWorkspace).agentDir,
    now: () => new Date(2026, 8, 16, 9, 0, 0),
    warn: (message) => warnings.push(message),
  });
  return { pi, runtime, workspace, warnings };
}

function context(harness: Harness, options: { projectTrusted?: boolean; models?: Record<string, { api: string }>; hasUI?: boolean } = {}) {
  return createFakeCommandContext({
    cwd: harness.workspace.cwd,
    projectTrusted: options.projectTrusted ?? false,
    models: options.models,
    hasUI: options.hasUI ?? true,
  });
}

async function startSession(
  harness: Harness,
  options: { projectTrusted?: boolean; models?: Record<string, { api: string }>; hasUI?: boolean } = {},
): Promise<ReturnType<typeof createFakeCommandContext>> {
  const ctx = context(harness, options);
  await harness.pi.fire("session_start", SESSION_START, ctx);
  return ctx;
}

function statusBar(ctx: ReturnType<typeof createFakeCommandContext>): string | undefined {
  return ctx.uiCalls.statuses
    .filter((status) => status.key === STATUS_BAR_KEY)
    .at(-1)?.text;
}

function lastNotification(ctx: ReturnType<typeof createFakeCommandContext>): string {
  return ctx.uiCalls.notifications.at(-1)?.message ?? "";
}

function asCommandContext(
  ctx: ReturnType<typeof createFakeCommandContext>,
): ExtensionCommandContext {
  return ctx as unknown as ExtensionCommandContext;
}

describe("会话生命周期与 /perm 命令面（M1）", () => {
  it("session_start 读配置、置位开关并更新状态栏", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, REFERENCE_LIKE);

    const ctx = await startSession(harness);

    expect(harness.runtime.config?.layers.global.status).toBe("loaded");
    expect(harness.runtime.config?.ruleCount).toBe(2);
    expect(harness.runtime.configVersion).toBe(1);
    expect(harness.runtime.engaged).toBe(true);
    expect(statusBar(ctx)).toBe("perm: on");
  });

  it("配置 enabled=false 时默认不参与裁决，--perm 可启用", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, JSON.stringify({ enabled: false }));

    const ctx = await startSession(harness);
    expect(harness.runtime.engaged).toBe(false);
    expect(statusBar(ctx)).toBe("perm: off");

    harness.pi.setFlag(GUARDIAN_FLAG, true);
    const flagged = await startSession(harness);
    expect(harness.runtime.engaged).toBe(true);
    expect(statusBar(flagged)).toBe("perm: on");
  });

  it("/perm off 与 /perm on 立即生效（FR-39/40）", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, REFERENCE_LIKE);
    const ctx = await startSession(harness);

    await harness.pi.invokeCommand(GUARDIAN_COMMAND, "off", asCommandContext(ctx));
    expect(harness.runtime.engaged).toBe(false);
    expect(statusBar(ctx)).toBe("perm: off");
    expect(lastNotification(ctx)).toContain("已关闭");

    await harness.pi.invokeCommand(GUARDIAN_COMMAND, "on", asCommandContext(ctx));
    expect(harness.runtime.engaged).toBe(true);
    expect(statusBar(ctx)).toBe("perm: on");
  });

  it("before_agent_start 与 /perm reload 都会刷新配置版本（FR-52）", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, REFERENCE_LIKE);
    const ctx = await startSession(harness);
    expect(harness.runtime.configVersion).toBe(1);

    await harness.pi.fire("before_agent_start", { type: "before_agent_start" }, ctx);
    expect(harness.runtime.configVersion).toBe(2);

    writeGlobalConfig(harness.workspace, JSON.stringify({ gate: "all" }));
    await harness.pi.invokeCommand(GUARDIAN_COMMAND, "reload", asCommandContext(ctx));
    expect(harness.runtime.configVersion).toBe(3);
    expect(harness.runtime.config?.gate).toBe("all");
    expect(lastNotification(ctx)).toContain("版本 3");
  });

  it("/perm status 覆盖初始合同要求的全部字段", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, REFERENCE_LIKE);
    const ctx = await startSession(harness, {
      models: { "deepseek/deepseek-flash": { api: "openai-responses" } },
    });

    await harness.pi.invokeCommand(GUARDIAN_COMMAND, "status", asCommandContext(ctx));
    const report = lastNotification(ctx);

    for (const expected of [
      "总开关",
      "--perm",
      "yoloMode",
      "合成默认（baseline）",
      "只在用户层全未命中时参与",
      "全局配置",
      "项目配置",
      "gate：side-effect",
      "deepseek/deepseek-flash（可用，协议 openai-responses）",
      "userBashPolicy",
      "冲突：无",
      "subagentPolicy",
      "subagentCoverage：未识别，使用父策略",
      "bash 解析器",
      "计数器：grants 0",
      "审计日志",
      "失败分支",
    ]) {
      expect(report).toContain(expected);
    }
    // 协议来自模型自身配置，插件没有协议覆盖入口（FR-19）
    expect(ctx.modelRegistryCalls.find).toEqual([
      { provider: "deepseek", modelId: "deepseek-flash" },
    ]);
  });

  it("/perm status 显示项目配置未加载的原因（FR-48）", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, REFERENCE_LIKE);
    writeProjectConfig(harness.workspace, JSON.stringify({ gate: "all" }));
    const ctx = await startSession(harness, { projectTrusted: false });

    await harness.pi.invokeCommand(GUARDIAN_COMMAND, "status", asCommandContext(ctx));
    const report = lastNotification(ctx);

    expect(report).toContain("项目未受信任，项目层未加载（FR-48）");
    expect(report).toContain("项目配置存在，但项目未受信任");
    expect(harness.runtime.config?.gate).toBe("side-effect");
  });

  it("受信任项目的项目层生效（FR-48）", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, REFERENCE_LIKE);
    writeProjectConfig(harness.workspace, JSON.stringify({ gate: "all" }));

    await startSession(harness, { projectTrusted: true });

    expect(harness.runtime.config?.gate).toBe("all");
    expect(
      harness.runtime.config?.rules
        .filter((layer) => layer.layer !== "baseline")
        .map((layer) => layer.layer),
    ).toEqual(["global", "project"]);
    // baseline 永远是表中的第一层（§6.1 的合成顺序）
    expect(harness.runtime.config?.rules[0]?.layer).toBe("baseline");
  });

  it("配置损坏时告警并指明行号，且保持 engaged", async () => {
    const harness = setup();
    writeGlobalConfig(
      harness.workspace,
      ['{', '  "gate": "all",', "  // 注释", '  "debugLog": nope', "}"].join("\n"),
    );

    const ctx = await startSession(harness);

    expect(harness.runtime.config?.degraded).toBe(true);
    expect(harness.runtime.engaged).toBe(true);
    const warnings = ctx.uiCalls.notifications.map((notification) => notification.message);
    expect(warnings.some((message) => message.includes("JSON 解析失败"))).toBe(true);
    expect(warnings.some((message) => message.includes("第 4 行"))).toBe(true);
  });

  it("配置诊断只在内容变化时提示一次", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, "{");
    const ctx = await startSession(harness);
    const firstCount = ctx.uiCalls.notifications.length;

    await harness.pi.fire("before_agent_start", { type: "before_agent_start" }, ctx);

    expect(ctx.uiCalls.notifications.length).toBe(firstCount);
  });

  it("yoloMode 在状态栏显著提示（FR-53）", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, JSON.stringify({ yoloMode: true }));

    const ctx = await startSession(harness);

    expect(statusBar(ctx)).toBe("perm: on [YOLO]");
    expect(
      ctx.uiCalls.notifications.some((notification) =>
        notification.message.includes("yoloMode 已开启"),
      ),
    ).toBe(true);
  });

  it("无 UI 时诊断走 console.warn 出口（FR-46 的观测面）", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, "{");

    await startSession(harness, { hasUI: false });

    expect(harness.warnings.some((message) => message.includes("JSON 解析失败"))).toBe(
      true,
    );
  });

  it("grants 查看与清空与会话态一致（FR-29/39）", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, REFERENCE_LIKE);
    const ctx = await startSession(harness);

    await harness.pi.invokeCommand(GUARDIAN_COMMAND, "grants", asCommandContext(ctx));
    expect(lastNotification(ctx)).toBe("本会话没有授权记忆");

    harness.runtime.grants.keys.add("rm -rf ./dist");
    await harness.pi.invokeCommand(GUARDIAN_COMMAND, "grants", asCommandContext(ctx));
    expect(lastNotification(ctx)).toContain("rm -rf ./dist");

    await harness.pi.invokeCommand(GUARDIAN_COMMAND, "clear-grants", asCommandContext(ctx));
    expect(harness.runtime.grants.keys.size).toBe(0);
    expect(lastNotification(ctx)).toContain("已清空");
  });

  it("session_shutdown 清空会话态并释放配置（FR-52 的收尾）", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, REFERENCE_LIKE);
    const ctx = await startSession(harness);

    harness.runtime.grants.keys.add("git status");
    harness.runtime.cache.entries.set("key", {});
    harness.runtime.breaker.consecutiveDenials = 2;
    harness.runtime.callIndex = 9;

    await harness.pi.fire(
      "session_shutdown",
      { type: "session_shutdown", reason: "quit" },
      ctx,
    );

    expect(harness.runtime.config).toBeUndefined();
    expect(harness.runtime.grants.keys.size).toBe(0);
    expect(harness.runtime.cache.entries.size).toBe(0);
    expect(harness.runtime.breaker.consecutiveDenials).toBe(0);
    expect(harness.runtime.callIndex).toBe(0);
    expect(statusBar(ctx)).toBeUndefined();
  });

  it("未接入的入口保持惰性，不产生副作用", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, REFERENCE_LIKE);
    const ctx = await startSession(harness);

    for (const event of [
      "turn_start",
      "tool_call",
      "tool_result",
      "user_bash",
    ] as const) {
      await expect(harness.pi.fire(event, {}, ctx)).resolves.toBeUndefined();
    }
  });

  it("/perm off 的会话覆盖能跨配置刷新存活，新会话开始时重置", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, REFERENCE_LIKE);
    const ctx = await startSession(harness);

    await harness.pi.invokeCommand(GUARDIAN_COMMAND, "off", asCommandContext(ctx));
    expect(harness.runtime.engaged).toBe(false);

    await harness.pi.fire("before_agent_start", { type: "before_agent_start" }, ctx);
    expect(harness.runtime.engaged).toBe(false);

    await harness.pi.invokeCommand(GUARDIAN_COMMAND, "reload", asCommandContext(ctx));
    expect(harness.runtime.engaged).toBe(false);

    // 新会话：覆盖被重置，回到配置默认
    const next = await startSession(harness);
    expect(harness.runtime.engagedOverride).toBeUndefined();
    expect(harness.runtime.engaged).toBe(true);
    expect(statusBar(next)).toBe("perm: on");
  });

  it("无 UI 时 /perm status 与状态栏更新都不抛出（FR-39/41 的降级路径）", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, REFERENCE_LIKE);
    const ctx = await startSession(harness, { hasUI: false });

    await expect(
      harness.pi.invokeCommand(GUARDIAN_COMMAND, "status", asCommandContext(ctx)),
    ).resolves.toBeUndefined();
    // 命令只有在有 UI 的会话里才能被调用，因此 notify 本身仍走 UI 出口；
    // 这里只要求"不因缺少 UI 而抛出"，生命周期诊断走 console.warn 已由上一个用例覆盖。
    expect(harness.warnings).toEqual([]);
  });

  it("/perm status 逐层给出规则条数与审计目录（自检用）", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, REFERENCE_LIKE);
    const ctx = await startSession(harness);

    await harness.pi.invokeCommand(GUARDIAN_COMMAND, "status", asCommandContext(ctx));
    const report = lastNotification(ctx);

    expect(report).toContain("surface 2 个｜规则 2 条");
    expect(report).toContain("目录 ");
    expect(report).toContain("logs");
  });

  it("未知子命令给出用法提示", async () => {
    const harness = setup();
    const ctx = await startSession(harness);

    await harness.pi.invokeCommand(GUARDIAN_COMMAND, "bogus", asCommandContext(ctx));

    expect(lastNotification(ctx)).toContain("未知子命令");
    expect(ctx.uiCalls.notifications.at(-1)?.type).toBe("warning");
  });
});
