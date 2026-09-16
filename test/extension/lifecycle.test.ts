import type {
  ExtensionCommandContext,
  UserBashEvent,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

import { afterEach, describe, expect, it } from "vitest";

import { STATUS_BAR_KEY } from "../../src/audit/entry.ts";
import { GUARDIAN_COMMAND, GUARDIAN_FLAG, registerGuardian } from "../../src/extension/register.ts";
import {
  resetSubagentStore,
  SUBAGENT_BOUND,
  SUBAGENT_DISPOSED,
  SUBAGENT_SESSION_CREATED,
  SUBAGENT_WARNING_ENTRY_TYPE,
  subagentStoreSnapshot,
  UNGUARDED_REASON,
} from "../../src/extension/subagents.ts";
import { USER_BASH_CLAIM_CHANNEL } from "../../src/extension/user-bash.ts";
import type { GuardianRuntime } from "../../src/extension/state.ts";
import { createFakeCommandContext, type FakeContextOptions } from "../support/fake-context.ts";
import { createFakePi, type FakePi } from "../support/fake-pi.ts";
import { createFakeReview, verdictToolCall } from "../support/fake-review.ts";
import {
  createWorkspace,
  type TempWorkspace,
  writeGlobalConfig,
  writeProjectConfig,
} from "../support/tmp.ts";

const SESSION_START = { type: "session_start", reason: "startup" } as const;

const REFERENCE_LIKE = JSON.stringify({
  gate: "side-effect",
  reviewer: { model: "deepseek/deepseek-flash", reasoningEffort: "high" },
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
  // 子代理 registry 是进程级存储，用例之间必须清空，否则 sessionId 复用会造成假命中。
  resetSubagentStore();
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

function context(
  harness: Harness,
  options: {
    projectTrusted?: boolean;
    models?: Record<string, { api: string }>;
    hasUI?: boolean;
    complete?: FakeContextOptions["complete"];
    entries?: FakeContextOptions["entries"];
    /** 会话 ID；子代理用例用它模拟"本实例运行在子会话里"。 */
    sessionId?: string;
  } = {},
) {
  return createFakeCommandContext({
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    cwd: harness.workspace.cwd,
    projectTrusted: options.projectTrusted ?? false,
    models: options.models,
    hasUI: options.hasUI ?? true,
    ...(options.complete === undefined ? {} : { complete: options.complete }),
    ...(options.entries === undefined ? {} : { entries: options.entries }),
  });
}

async function startSession(
  harness: Harness,
  options: Parameters<typeof context>[1] = {},
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
      "deepseek/deepseek-flash（可用，协议 openai-responses）｜推理强度=high",
      "userBashPolicy",
      // userBashPolicy 与 classifier 的强度各自独立，未配置时如实回报“不发送”
      "推理强度=不发送",
      "预评分 关闭",
      "失败分支",
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

  it("sessionGrants.enabled=false 时 /perm grants 如实说明已关闭（M5）", async () => {
    const harness = setup();
    writeGlobalConfig(
      harness.workspace,
      JSON.stringify({ sessionGrants: { enabled: false } }),
    );
    const ctx = await startSession(harness);

    await harness.pi.invokeCommand(GUARDIAN_COMMAND, "grants", asCommandContext(ctx));

    expect(lastNotification(ctx)).toContain("sessionGrants.enabled=false");
  });

  it("session_shutdown 清空会话态并释放配置（FR-52 的收尾）", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, REFERENCE_LIKE);
    const ctx = await startSession(harness);

    harness.runtime.grants.keys.add("git status");
    harness.runtime.cache.entries.set("key", {
      outcome: { proposed: "deny", final: "deny", source: "policy", targets: [] },
      storedAt: Date.now(),
    });
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

  it("tool_call 进入决策管线（M3）", async () => {
    const harness = setup();
    writeGlobalConfig(
      harness.workspace,
      JSON.stringify({ permission: { bash: { "rm -rf /": "deny" } } }),
    );
    const ctx = await startSession(harness);

    const blocked = await harness.pi.fire(
      "tool_call",
      { type: "tool_call", toolName: "bash", toolCallId: "c1", input: { command: "rm -rf /" } },
      ctx,
    );
    expect(blocked).toMatchObject({ block: true });

    const allowed = await harness.pi.fire(
      "tool_call",
      { type: "tool_call", toolName: "read", toolCallId: "c2", input: { path: "a.txt" } },
      ctx,
    );
    expect(allowed).toBeUndefined();
  });

  it("turn_start 重置熔断，tool_result 在预评分关闭时不调用模型（M5）", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, REFERENCE_LIKE);
    const ctx = await startSession(harness);

    harness.runtime.breaker.consecutiveDenials = 2;
    harness.runtime.breaker.deniedTools.add("bash");
    await expect(harness.pi.fire("turn_start", { type: "turn_start" }, ctx)).resolves.toBeUndefined();
    expect(harness.runtime.breaker.consecutiveDenials).toBe(0);
    expect(harness.runtime.breaker.deniedTools.size).toBe(0);

    const review = createFakeReview({ responses: [{ text: "low" }] });
    const classifierCtx = await startSession(harness, {
      models: review.models,
      complete: review.complete,
    });
    await expect(
      harness.pi.fire(
        "tool_result",
        { type: "tool_result", toolName: "bash", toolCallId: "c1", input: {}, content: [] },
        classifierCtx,
      ),
    ).resolves.toBeUndefined();
    // classifier.enabled 默认 false：不得发起任何额外模型调用（M5 门禁）。
    expect(review.calls).toHaveLength(0);
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

describe("user_bash 端到端（M4，FR-60）", () => {
  const USER_BASH_CONFIG = JSON.stringify({
    gate: "side-effect",
    reviewer: { model: "test/reviewer", transcript: false, evidenceTools: false },
    permission: {
      bash: {
        "rm -rf /": "deny",
        "echo *": "allow",
        "npm *": { action: "review", reason: "安装依赖会改动工作区" },
      },
    },
  });

  function userBash(command: string, excludeFromContext = false): UserBashEvent {
    return { type: "user_bash", command, excludeFromContext, cwd: "IGNORED" };
  }

  it("!rm -rf / 被拦截：返回替代执行结果，且不提供 operations（真实命令不会跑）", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, USER_BASH_CONFIG);
    const ctx = await startSession(harness, { hasUI: false });

    const result = (await harness.pi.fire(
      "user_bash",
      userBash("rm -rf /"),
      ctx,
    )) as UserBashEventResult | undefined;

    expect(result?.result?.exitCode).toBe(1);
    expect(result?.result?.cancelled).toBe(false);
    expect(result?.result?.output).toContain("rm -rf /");
    expect(result?.result?.output).toContain("反规避");
    expect(result?.operations).toBeUndefined();
  });

  it("!! 与 ! 的安全裁决与替代结果完全相同（FR-60）", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, USER_BASH_CONFIG);
    const ctx = await startSession(harness, { hasUI: false });

    const bang = (await harness.pi.fire("user_bash", userBash("rm -rf /"), ctx)) as UserBashEventResult;
    const doubleBang = (await harness.pi.fire(
      "user_bash",
      userBash("rm -rf /", true),
      ctx,
    )) as UserBashEventResult;

    expect(doubleBang).toEqual(bang);
  });

  it("未被规则命中的命令不拦截", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, USER_BASH_CONFIG);
    const ctx = await startSession(harness, { hasUI: false });

    await expect(
      harness.pi.fire("user_bash", userBash("echo hi"), ctx),
    ).resolves.toBeUndefined();
  });

  it("review 类命令交给评审模型，allow 后不拦截", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, USER_BASH_CONFIG);
    const review = createFakeReview({
      responses: [{ toolCalls: [verdictToolCall({ decision: "allow", riskLevel: "low" })] }],
    });
    const ctx = await startSession(harness, {
      hasUI: false,
      models: review.models,
      complete: review.complete,
    });

    await expect(
      harness.pi.fire("user_bash", userBash("npm install"), ctx),
    ).resolves.toBeUndefined();
    expect(review.calls).toHaveLength(1);
    // 评审提示词要说明来源是用户手输命令（授权前提不同）。
    expect(JSON.stringify(review.contexts()[0]?.messages)).toContain("来源：用户手输命令");
  });

  it("userBashPolicy.autoReview=false 时不调用评审模型，转人工（无 UI → deny）", async () => {
    const harness = setup();
    writeGlobalConfig(
      harness.workspace,
      JSON.stringify({ ...JSON.parse(USER_BASH_CONFIG), userBashPolicy: { autoReview: false } }),
    );
    const review = createFakeReview({
      responses: [{ toolCalls: [verdictToolCall({ decision: "allow" })] }],
    });
    const ctx = await startSession(harness, {
      hasUI: false,
      models: review.models,
      complete: review.complete,
    });

    const result = (await harness.pi.fire(
      "user_bash",
      userBash("npm install"),
      ctx,
    )) as UserBashEventResult;

    expect(review.calls).toHaveLength(0);
    expect(result?.result?.exitCode).toBe(1);
    expect(result?.result?.output).toContain("autoReview=false");
  });

  it("userBashPolicy.enabled=false 时用户命令完全不经过插件", async () => {
    const harness = setup();
    writeGlobalConfig(
      harness.workspace,
      JSON.stringify({ ...JSON.parse(USER_BASH_CONFIG), userBashPolicy: { enabled: false } }),
    );
    const ctx = await startSession(harness, { hasUI: false });

    await expect(
      harness.pi.fire("user_bash", userBash("rm -rf /"), ctx),
    ).resolves.toBeUndefined();
  });

  it("检测到其他实例的声明后，/perm status 会提示冲突（FR-60）", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, USER_BASH_CONFIG);
    const ctx = await startSession(harness);

    harness.pi.emitOnBus(USER_BASH_CLAIM_CHANNEL, {
      extension: "pi-permission-guardian",
      instanceId: "other-instance",
    });
    await harness.pi.invokeCommand(GUARDIAN_COMMAND, "status", asCommandContext(ctx));

    expect(harness.runtime.userBashConflict).toBe(true);
    expect(lastNotification(ctx)).toContain("检测到其他拦截器声明");
  });

  it("自己的声明不产生冲突提示", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, USER_BASH_CONFIG);
    await startSession(harness);

    expect(harness.runtime.userBashConflict).toBe(false);
    expect(harness.warnings).toEqual([]);
  });
});

describe("M6 子代理会话接线（FR-54~FR-56）", () => {
  const CHILD_ID = "child-session-1";

  /** 模拟父实例收到子代理生命周期的 `session-created` 公告。 */
  function announceChild(harness: Harness, parentSessionId: string | undefined): void {
    harness.pi.emitOnBus(SUBAGENT_SESSION_CREATED, {
      sessionId: CHILD_ID,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
    });
  }

  it("父会话在子会话未加载护栏时给出四处一致证据（UI/条目/状态）", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, REFERENCE_LIKE);
    const ctx = await startSession(harness);
    expect(statusBar(ctx)).toBe("perm: on");

    announceChild(harness, "parent-1");
    harness.pi.emitOnBus(SUBAGENT_BOUND, {
      sessionId: CHILD_ID,
      parentSessionId: "parent-1",
    });

    // 1) 可见告警；2) 会话记录；3) runtime 标记；4) /perm status 反映。
    const warnings = ctx.uiCalls.notifications.filter((entry) => entry.type === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain(CHILD_ID);
    expect(harness.pi.entries.at(-1)?.customType).toBe(SUBAGENT_WARNING_ENTRY_TYPE);
    expect(harness.pi.entries.at(-1)?.data).toMatchObject({
      sessionId: CHILD_ID,
      reason: UNGUARDED_REASON,
    });
    expect(harness.runtime.subagentCoverage).toBe("unguarded");

    await harness.pi.invokeCommand(GUARDIAN_COMMAND, "status", asCommandContext(ctx));
    expect(lastNotification(ctx)).toContain("unguarded");
    expect(lastNotification(ctx)).toContain(CHILD_ID);

    harness.pi.emitOnBus(SUBAGENT_DISPOSED, { sessionId: CHILD_ID });
  });

  it("子会话识别后启用 subagentPolicy 并在状态栏标出", async () => {
    const harness = setup();
    writeGlobalConfig(
      harness.workspace,
      JSON.stringify({ subagentPolicy: { defaultAction: "deny" } }),
    );
    // 子实例：自己的 sessionId 已在 registry 中，session_start 时写下绑定握手。
    announceChild(harness, "parent-1");
    const ctx = await startSession(harness, { sessionId: CHILD_ID });

    expect(harness.runtime.isSubagentSession).toBe(true);
    expect(harness.runtime.subagentParentSessionId).toBe("parent-1");
    expect(statusBar(ctx)).toBe("perm: on [子代理]");
    // 子实例的握手让父实例的 bound 校对通过（这里以存储状态断言同一事实）。
    expect(subagentStoreSnapshot().handshakes).toEqual([CHILD_ID]);

    await harness.pi.invokeCommand(GUARDIAN_COMMAND, "status", asCommandContext(ctx));
    expect(lastNotification(ctx)).toContain("已识别（父会话 parent-1）");
    expect(lastNotification(ctx)).toContain("启用 subagentPolicy");

    harness.pi.emitOnBus(SUBAGENT_DISPOSED, { sessionId: CHILD_ID });
  });

  it("subagentPolicy.enabled=false 时识别为子会话但仍用父策略", async () => {
    const harness = setup();
    writeGlobalConfig(
      harness.workspace,
      JSON.stringify({ subagentPolicy: { enabled: false } }),
    );
    announceChild(harness, "parent-1");
    const ctx = await startSession(harness, { sessionId: CHILD_ID });

    expect(harness.runtime.isSubagentSession).toBe(true);
    await harness.pi.invokeCommand(GUARDIAN_COMMAND, "status", asCommandContext(ctx));
    expect(lastNotification(ctx)).toContain("已识别（父会话 parent-1）");
    expect(lastNotification(ctx)).toContain("使用父策略");

    harness.pi.emitOnBus(SUBAGENT_DISPOSED, { sessionId: CHILD_ID });
  });

  it("非子代理会话仍然显示「未识别，使用父策略」", async () => {
    const harness = setup();
    writeGlobalConfig(harness.workspace, REFERENCE_LIKE);
    const ctx = await startSession(harness);

    await harness.pi.invokeCommand(GUARDIAN_COMMAND, "status", asCommandContext(ctx));

    expect(lastNotification(ctx)).toContain("subagentCoverage：未识别，使用父策略");
  });
});
