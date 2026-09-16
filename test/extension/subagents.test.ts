import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRuntime, type GuardianRuntime } from "../../src/extension/state.ts";
import {
  createSubagentController,
  resetSubagentStore,
  SUBAGENT_BOUND,
  SUBAGENT_DISPOSED,
  SUBAGENT_SESSION_CREATED,
  SUBAGENT_WARNING_ENTRY_TYPE,
  subagentStoreSnapshot,
  UNGUARDED_REASON,
  type SubagentController,
} from "../../src/extension/subagents.ts";
import { createFakeContext } from "../support/fake-context.ts";
import { createFakePi, type FakePi } from "../support/fake-pi.ts";

/**
 * 子代理会话识别与缺失握手告警（FR-54~FR-56、architecture §8.5）。
 *
 * 父子扩展实例在真实运行时各有自己的事件总线（`pi.events` 是按会话的），所以测试也用两个
 * 假 `pi` 模拟：父实例在父总线上听到 `subagents:child:*`，子实例只能在子总线上发布。
 * 两者唯一的交汇点是进程级 registry。
 */

interface Node {
  pi: FakePi;
  runtime: GuardianRuntime;
  controller: SubagentController;
  warnings: string[];
}

function node(): Node {
  const pi = createFakePi();
  const runtime = createRuntime();
  const warnings: string[] = [];
  const controller = createSubagentController({
    pi,
    runtime,
    warn: (message) => warnings.push(message),
  });
  controller.watchLifecycle();
  return { pi, runtime, controller, warnings };
}

beforeEach(() => {
  resetSubagentStore();
});

afterEach(() => {
  // 进程级存储跨用例共享，逐个用例清空，避免 sessionId 复用造成假命中。
  resetSubagentStore();
});

describe("子会话注册与绑定握手（FR-55）", () => {
  it("session-created 同步注册，子实例随后能识别自己", () => {
    const parent = node();
    const child = node();
    parent.controller.attachContext(createFakeContext({ sessionId: "parent-1", hasUI: true }));

    parent.pi.emitOnBus(SUBAGENT_SESSION_CREATED, {
      sessionId: "child-1",
      parentSessionId: "parent-1",
    });
    const detected = child.controller.detectSelf(
      createFakeContext({ sessionId: "child-1" }),
    );

    expect(detected).toBe(true);
    expect(child.runtime.isSubagentSession).toBe(true);
    expect(child.runtime.subagentParentSessionId).toBe("parent-1");
    expect(subagentStoreSnapshot()).toEqual({
      children: ["child-1"],
      handshakes: ["child-1"],
    });
  });

  it("握手到位时 bound 不产生任何告警", () => {
    const parent = node();
    const child = node();
    const ctx = createFakeContext({ sessionId: "parent-1", hasUI: true });
    parent.controller.attachContext(ctx);

    parent.pi.emitOnBus(SUBAGENT_SESSION_CREATED, {
      sessionId: "child-1",
      parentSessionId: "parent-1",
    });
    child.controller.detectSelf(createFakeContext({ sessionId: "child-1" }));
    parent.pi.emitOnBus(SUBAGENT_BOUND, { sessionId: "child-1", parentSessionId: "parent-1" });

    expect(parent.runtime.subagentCoverage).toBe("none");
    expect(parent.runtime.unguardedChildren.size).toBe(0);
    expect(parent.pi.entries).toHaveLength(0);
    expect(parent.warnings).toEqual([]);
    expect(ctx.uiCalls.notifications).toEqual([]);
  });

  it("缺失握手时 UI 只提示一次，但每个子会话都留下会话记录（unguarded）", () => {
    const parent = node();
    const ctx = createFakeContext({ sessionId: "parent-1", hasUI: true });
    parent.controller.attachContext(ctx);

    for (const sessionId of ["child-1", "child-2", "child-3"]) {
      parent.pi.emitOnBus(SUBAGENT_SESSION_CREATED, { sessionId, parentSessionId: "parent-1" });
      parent.pi.emitOnBus(SUBAGENT_BOUND, { sessionId, parentSessionId: "parent-1" });
    }

    // 可见告警只有一条（原因通常是一行配置，扇出十个子会话不该刷十条）。
    expect(ctx.uiCalls.notifications).toHaveLength(1);
    expect(ctx.uiCalls.notifications[0]?.type).toBe("warning");
    expect(ctx.uiCalls.notifications[0]?.message).toContain("child-1");
    expect(ctx.uiCalls.notifications[0]?.message).toContain("excludedExtensionPackages");

    // 但会话记录是每个受影响子会话一条，且固定带 reason。
    expect(parent.pi.entries.map((entry) => entry.customType)).toEqual([
      SUBAGENT_WARNING_ENTRY_TYPE,
      SUBAGENT_WARNING_ENTRY_TYPE,
      SUBAGENT_WARNING_ENTRY_TYPE,
    ]);
    expect(parent.pi.entries[1]?.data).toEqual({
      sessionId: "child-2",
      parentSessionId: "parent-1",
      reason: UNGUARDED_REASON,
    });

    expect(parent.runtime.subagentCoverage).toBe("unguarded");
    expect([...parent.runtime.unguardedChildren]).toEqual([
      "child-1",
      "child-2",
      "child-3",
    ]);
  });

  it("无 UI 时会话记录照写，提示走 console.warn", () => {
    const parent = node();
    parent.controller.attachContext(createFakeContext({ sessionId: "parent-1", hasUI: false }));

    parent.pi.emitOnBus(SUBAGENT_SESSION_CREATED, {
      sessionId: "child-1",
      parentSessionId: "parent-1",
    });
    parent.pi.emitOnBus(SUBAGENT_BOUND, { sessionId: "child-1", parentSessionId: "parent-1" });

    expect(parent.warnings).toHaveLength(1);
    expect(parent.warnings[0]).toContain("child-1");
    expect(parent.pi.entries).toHaveLength(1);
    expect(parent.runtime.subagentCoverage).toBe("unguarded");
  });

  it("disposed 清理注册与握手，同一 sessionId 不会被历史污染", () => {
    const parent = node();
    const child = node();
    parent.controller.attachContext(createFakeContext({ sessionId: "parent-1", hasUI: true }));

    parent.pi.emitOnBus(SUBAGENT_SESSION_CREATED, {
      sessionId: "child-1",
      parentSessionId: "parent-1",
    });
    child.controller.detectSelf(createFakeContext({ sessionId: "child-1" }));
    parent.pi.emitOnBus(SUBAGENT_DISPOSED, { sessionId: "child-1" });

    expect(subagentStoreSnapshot()).toEqual({ children: [], handshakes: [] });
    // 下一次复用同一 sessionId：没有新的 session-created，就不该再被识别为子会话。
    // （会话生命周期在任何 session_start 前先做 runtime 重置，所以这里用新会话代次的实例断言。）
    const next = node();
    expect(next.controller.detectSelf(createFakeContext({ sessionId: "child-1" }))).toBe(false);
    expect(next.runtime.isSubagentSession).toBe(false);
  });

  it("非子会话不写握手，普通会话不会累积无用指纹", () => {
    const solo = node();

    expect(solo.controller.detectSelf(createFakeContext({ sessionId: "solo-1" }))).toBe(false);
    expect(subagentStoreSnapshot()).toEqual({ children: [], handshakes: [] });
  });

  it("缺少 sessionId 的载荷被忽略，不产生告警与注册", () => {
    const parent = node();
    parent.controller.attachContext(createFakeContext({ sessionId: "parent-1", hasUI: true }));

    parent.pi.emitOnBus(SUBAGENT_SESSION_CREATED, { parentSessionId: "parent-1" });
    parent.pi.emitOnBus(SUBAGENT_BOUND, { sessionId: "" });
    parent.pi.emitOnBus(SUBAGENT_DISPOSED, null);

    expect(subagentStoreSnapshot()).toEqual({ children: [], handshakes: [] });
    expect(parent.pi.entries).toHaveLength(0);
    expect(parent.warnings).toEqual([]);
  });
});
