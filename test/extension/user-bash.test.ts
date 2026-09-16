import type { UserBashEvent } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";

import { DECISION_ENTRY_TYPE } from "../../src/audit/entry.ts";
import type { DecisionOutcome } from "../../src/decision/outcome.ts";
import type { DecisionEngine, DecisionRequest } from "../../src/decision/pipeline.ts";
import { createRuntime, type GuardianRuntime } from "../../src/extension/state.ts";
import {
  USER_BASH_CLAIM_CHANNEL,
  createUserBashController,
} from "../../src/extension/user-bash.ts";
import { createFakeContext, type FakeContext } from "../support/fake-context.ts";
import { createFakePi, type FakePi } from "../support/fake-pi.ts";

/**
 * `user_bash` 适配（FR-60）。
 *
 * 这里只验证**映射**：允许交给 pi、拒绝返回替代 `BashResult`、失败 fail-closed，
 * 以及共存声明的最佳努力检测。裁决本身由 decision 层的测试覆盖，
 * 因此用桩引擎把"决策结果"当成输入。
 */

const ORDER: DecisionRequest[] = [];

function stubEngine(
  outcome: DecisionOutcome | (() => Promise<DecisionOutcome | undefined>) | undefined,
): DecisionEngine {
  const resolve = async (): Promise<DecisionOutcome | undefined> =>
    typeof outcome === "function" ? outcome() : outcome;
  return {
    decide: async (request): Promise<DecisionOutcome | undefined> => {
      ORDER.push(request);
      return resolve();
    },
    decideToolCall: async (): Promise<DecisionOutcome | undefined> => resolve(),
    handleToolCall: async (): Promise<undefined> => undefined,
  };
}

function allowOutcome(): DecisionOutcome {
  return { proposed: "allow", final: "allow", source: "policy", targets: [] };
}

function denyOutcome(reason = "命中规则"): DecisionOutcome {
  return { proposed: "deny", final: "deny", source: "policy", reason, targets: [] };
}

interface Harness {
  pi: FakePi;
  runtime: GuardianRuntime;
  controller: ReturnType<typeof createUserBashController>;
  warnings: string[];
}

function setup(
  engine: DecisionEngine,
  configure?: (runtime: GuardianRuntime) => void,
): Harness {
  const pi = createFakePi();
  const runtime = createRuntime();
  runtime.engaged = true;
  runtime.config = {
    userBashPolicy: { enabled: true, autoReview: true, model: null },
  } as unknown as GuardianRuntime["config"];
  configure?.(runtime);
  const warnings: string[] = [];
  const controller = createUserBashController({
    pi,
    runtime,
    engine,
    instanceId: "self-instance",
    warn: (message) => warnings.push(message),
  });
  return { pi, runtime, controller, warnings };
}

function event(command: string, excludeFromContext = false): UserBashEvent {
  return {
    type: "user_bash",
    command,
    excludeFromContext,
    cwd: "/repo/app",
  };
}

function context(hasUI = false): FakeContext {
  return createFakeContext({ cwd: "/repo/app", hasUI, selectResult: undefined });
}

beforeEach(() => {
  ORDER.length = 0;
});

describe("决策映射（FR-60）", () => {
  it("allow 时不拦截，交回 pi 的正常 shell 路径", async () => {
    const harness = setup(stubEngine(allowOutcome()));

    await expect(harness.controller.handler(event("echo hi"), context())).resolves.toBeUndefined();
  });

  it("未识别到结论时同样不拦截", async () => {
    const harness = setup(stubEngine(undefined));

    await expect(harness.controller.handler(event("echo hi"), context())).resolves.toBeUndefined();
  });

  it("deny 返回替代 BashResult：非零退出码 + 理由，且不提供 operations", async () => {
    const harness = setup(stubEngine(denyOutcome("rm -rf / 被拒绝")));

    const result = await harness.controller.handler(event("rm -rf /"), context());

    expect(result).toEqual({
      result: {
        output: "rm -rf / 被拒绝\n",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    });
    expect(result?.operations).toBeUndefined();
  });

  it("`!` 与 `!!` 走同一条裁决路径，替代结果一致（仅 context 语义不同）", async () => {
    const harness = setup(stubEngine(denyOutcome("拒绝")));

    const bang = await harness.controller.handler(event("rm -rf /", false), context());
    const doubleBang = await harness.controller.handler(event("rm -rf /", true), context());

    expect(bang).toEqual(doubleBang);
    expect(ORDER.map((request) => request.origin)).toEqual(["user_bash", "user_bash"]);
    expect(ORDER.map((request) => request.input)).toEqual([
      { command: "rm -rf /" },
      { command: "rm -rf /" },
    ]);
  });

  it("把事件里的命令与 cwd 原样交给决策内核", async () => {
    const harness = setup(stubEngine(allowOutcome()));

    await harness.controller.handler(event("git status"), context());

    expect(ORDER[0]).toMatchObject({
      origin: "user_bash",
      toolName: "bash",
      input: { command: "git status" },
      cwd: "/repo/app",
    });
  });

  it("userBashPolicy.enabled=false 时完全不介入", async () => {
    const harness = setup(stubEngine(denyOutcome()), (runtime) => {
      runtime.config = {
        userBashPolicy: { enabled: false, autoReview: true, model: null },
      } as unknown as GuardianRuntime["config"];
    });

    await expect(harness.controller.handler(event("rm -rf /"), context())).resolves.toBeUndefined();
    expect(ORDER).toHaveLength(0);
  });

  it("未启用与配置缺失都按 fail-closed 处理", async () => {
    const disabled = setup(stubEngine(denyOutcome()), (runtime) => {
      runtime.engaged = false;
    });
    await expect(
      disabled.controller.handler(event("rm -rf /"), context()),
    ).resolves.toBeUndefined();

    const unloaded = setup(stubEngine(denyOutcome()), (runtime) => {
      runtime.config = undefined;
    });
    const result = await unloaded.controller.handler(event("rm -rf /"), context());
    expect(result?.result?.exitCode).toBe(1);
    expect(result?.result?.output).toContain("配置尚未加载");
  });

  it("决策内核抛错时返回拒绝结果，而不是让命令照跑", async () => {
    const harness = setup(
      stubEngine(async () => {
        throw new Error("boom");
      }),
    );

    const result = await harness.controller.handler(event("rm -rf /"), context());

    expect(result?.result?.exitCode).toBe(1);
    expect(result?.result?.output).toContain("护栏内部异常");
    expect(result?.result?.output).toContain("反规避");
  });
});

describe("共存声明检测（FR-60）", () => {
  it("发布自己的声明时带实例 ID", () => {
    const harness = setup(stubEngine(allowOutcome()));

    harness.controller.publishClaim();

    expect(harness.pi.eventBusMessages).toEqual([
      {
        channel: USER_BASH_CLAIM_CHANNEL,
        data: { extension: "pi-permission-guardian", instanceId: "self-instance" },
      },
    ]);
  });

  it("忽略自己的回声，不产生冲突", () => {
    const harness = setup(stubEngine(allowOutcome()));
    harness.controller.watchClaims();

    harness.controller.publishClaim();

    expect(harness.runtime.userBashConflict).toBe(false);
    expect(harness.warnings).toHaveLength(0);
  });

  it("其他实例的声明只提示一次，并写进会话记录与状态位", () => {
    const harness = setup(stubEngine(allowOutcome()));
    const ctx = context(true);
    harness.controller.attachContext(ctx);
    harness.controller.watchClaims();

    harness.pi.emitOnBus(USER_BASH_CLAIM_CHANNEL, {
      extension: "pi-permission-guardian",
      instanceId: "other-instance",
    });
    harness.pi.emitOnBus(USER_BASH_CLAIM_CHANNEL, {
      extension: "pi-permission-guardian",
      instanceId: "third-instance",
    });

    expect(harness.runtime.userBashConflict).toBe(true);
    expect(ctx.uiCalls.notifications).toHaveLength(1);
    expect(ctx.uiCalls.notifications[0]?.type).toBe("warning");
    expect(ctx.uiCalls.notifications[0]?.message).toContain("other-instance");
    const conflictEntries = harness.pi.entries.filter(
      (entry) => entry.customType === DECISION_ENTRY_TYPE,
    );
    expect(conflictEntries).toHaveLength(1);
    expect(conflictEntries[0]?.data).toMatchObject({
      kind: "user-bash-conflict",
      conflict: true,
    });
  });

  it("没有 UI 时回落到 console.warn（不静默）", () => {
    const harness = setup(stubEngine(allowOutcome()));
    harness.controller.attachContext(context(false));
    harness.controller.watchClaims();

    harness.pi.emitOnBus(USER_BASH_CLAIM_CHANNEL, {
      extension: "pi-permission-guardian",
      instanceId: "other-instance",
    });

    expect(harness.warnings).toHaveLength(1);
    expect(harness.runtime.userBashConflict).toBe(true);
  });

  it("忽略无关频道消息与畸形载荷", () => {
    const harness = setup(stubEngine(allowOutcome()));
    harness.controller.watchClaims();

    harness.pi.emitOnBus("some-other-channel", { extension: "pi-permission-guardian" });
    harness.pi.emitOnBus(USER_BASH_CLAIM_CHANNEL, null);
    harness.pi.emitOnBus(USER_BASH_CLAIM_CHANNEL, { extension: "someone-else" });

    expect(harness.runtime.userBashConflict).toBe(false);
    expect(harness.warnings).toHaveLength(0);
  });

  it("取消订阅后不再接收声明", () => {
    const harness = setup(stubEngine(allowOutcome()));
    const stop = harness.controller.watchClaims();
    stop();

    harness.pi.emitOnBus(USER_BASH_CLAIM_CHANNEL, {
      extension: "pi-permission-guardian",
      instanceId: "other-instance",
    });

    expect(harness.runtime.userBashConflict).toBe(false);
  });
});
