import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { GuardianRuntime } from "./state.ts";

/**
 * 子代理会话识别（FR-54~FR-56、architecture §8.5）。
 *
 * 对接基线是 `@gotgenes/pi-subagents` v21.7.1 的 child lifecycle：核心在父会话的事件总线上
 * 依次发布 `subagents:child:session-created`（`bindExtensions()` 之前）、
 * `subagents:child:bound`（子扩展全部绑定完成之后）、`subagents:child:disposed`（运行结束的 finally）。
 *
 * 为什么走 `globalThis` 而不是 `pi.events`：
 *
 * pi 0.85.1 的 `pi.events` 是**按会话**的（`DefaultResourceLoader` 在没拿到 `eventBus` 时
 * 自己 `createEventBus()`；子代理实现用 `new DefaultResourceLoader(opts)` 造子会话的 loader，
 * 不传 `eventBus`），因此子实例发布的东西父实例听不到。父子之间真正共享的只有进程本身，
 * 所以"父实例写、子实例读"（子会话 ID registry）与"子实例写、父实例读"（绑定握手）都必须
 * 落在进程级存储上。这与 `pi-permission-system` 用 `Symbol.for()` + `globalThis`
 * 解决同一问题的做法一致。
 *
 * 存储刻意没有 shutdown 钩子：子会话的 `session_shutdown` 不能清掉父实例的注册。写入只有两个
 * 来源——父实例的 `session-created` / `disposed` 订阅，以及子实例自己的握手。
 */

/** 与 `@gotgenes/pi-subagents` v21.7.1 的发布端逐字一致的频道名。 */
export const SUBAGENT_SESSION_CREATED = "subagents:child:session-created";
export const SUBAGENT_BOUND = "subagents:child:bound";
export const SUBAGENT_DISPOSED = "subagents:child:disposed";

/** 缺失握手的会话条目类型（FR-45 的版本化约定）。 */
export const SUBAGENT_WARNING_ENTRY_TYPE =
  "pi-permission-guardian.subagent-warning.v1";

/** 固定的告警原因取值：子会话绑定了扩展，但没有收到本插件的握手指纹。 */
export const UNGUARDED_REASON = "guard-not-bound";

/** 进程级存储槽；用 `Symbol.for` 让同一进程里的每个模块实例拿到同一个槽。 */
const STORE_KEY = Symbol.for("pi-permission-guardian:subagent-registry");

interface SubagentStore {
  /** 子会话 ID → 父会话信息。只由父实例的 `session-created` / `disposed` 写。 */
  children: Map<string, { parentSessionId?: string }>;
  /** 已完成绑定的子会话 ID（子实例在自身 `session_start` 写入的握手）。 */
  handshakes: Set<string>;
}

function store(): SubagentStore {
  const slot = globalThis as Record<symbol, unknown>;
  const existing = slot[STORE_KEY] as SubagentStore | undefined;
  if (existing !== undefined) {
    return existing;
  }
  const created: SubagentStore = { children: new Map(), handshakes: new Set() };
  slot[STORE_KEY] = created;
  return created;
}

/** 清空进程级存储。仅供测试隔离使用：生产路径只按事件增删条目。 */
export function resetSubagentStore(): void {
  const current = store();
  current.children.clear();
  current.handshakes.clear();
}

/** 只读快照，供测试与排查确认注册状态。 */
export function subagentStoreSnapshot(): {
  children: string[];
  handshakes: string[];
} {
  const current = store();
  return {
    children: [...current.children.keys()],
    handshakes: [...current.handshakes],
  };
}

/** 无护栏子会话的固定告警文本。 */
export function unguardedMessage(
  sessionId: string,
  parentSessionId: string | undefined,
): string {
  const parent = parentSessionId === undefined ? "" : `（父会话 ${parentSessionId}）`;
  return (
    `[pi-permission-guardian] 子代理会话 ${sessionId}${parent} 运行在无护栏状态：` +
    "该子会话没有加载本插件，它的工具调用不受护栏约束。" +
    "最常见的原因是 pi-subagents 的 excludedExtensionPackages 把 pi-permission-guardian 排除了；" +
    "加载失败会造成同样的结果。后续受影响的子会话仍会写入会话记录。"
  );
}

/** `session-created` 载荷中我们读取的字段。 */
interface ChildSessionCreatedEvent {
  sessionId?: unknown;
  parentSessionId?: unknown;
}

/** `bound` 载荷中我们读取的字段。 */
interface ChildBoundEvent {
  sessionId?: unknown;
  parentSessionId?: unknown;
}

/** `disposed` 载荷中我们读取的字段。 */
interface ChildDisposedEvent {
  sessionId?: unknown;
}

export interface SubagentDeps {
  pi: ExtensionAPI;
  runtime: GuardianRuntime;
  warn?: (message: string) => void;
}

export interface SubagentController {
  /** 订阅 child lifecycle。在组合阶段就位（早于任何会话）。 */
  watchLifecycle(): void;
  /** 保存/清除当前上下文（缺失握手的告警需要 UI 出口）。 */
  attachContext(ctx: ExtensionContext | undefined): void;
  /**
   * 子实例在自身 `session_start` 调用：发布绑定握手，并在命中 registry 时把本会话标记为
   * 子代理会话。返回是否命中。
   */
  detectSelf(ctx: ExtensionContext): boolean;
}

export function createSubagentController(deps: SubagentDeps): SubagentController {
  const warn = deps.warn ?? ((message: string): void => console.warn(message));
  let currentContext: ExtensionContext | undefined;
  /** 可见告警每个父会话只发一次：原因通常只有一行配置，扇出十个子会话不该刷十条。 */
  let warnedUnguarded = false;

  /**
   * 子扩展没有绑定本插件时的固定合同：始终写会话记录并标记覆盖率，可见告警只发一次。
   *
   * 父实例无法区分"刻意排除"与"加载失败"——两者留下的都是完全相同的缺席，所以文本同时给出两种可能。
   */
  function reportUnguarded(sessionId: string, parentSessionId: string | undefined): void {
    deps.runtime.subagentCoverage = "unguarded";
    deps.runtime.unguardedChildren.add(sessionId);
    try {
      deps.pi.appendEntry(SUBAGENT_WARNING_ENTRY_TYPE, {
        sessionId,
        parentSessionId,
        reason: UNGUARDED_REASON,
      });
    } catch (error) {
      warn(
        `[pi-permission-guardian] 子代理告警记录写入失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (warnedUnguarded) {
      return;
    }
    warnedUnguarded = true;
    const message = unguardedMessage(sessionId, parentSessionId);
    if (currentContext?.hasUI === true) {
      currentContext.ui.notify(message, "warning");
    } else {
      warn(message);
    }
  }

  /** 载荷字段的读取纪律：只接受非空字符串，其余（含缺失与错误类型）一律当没有。 */
  function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  return {
    attachContext(ctx): void {
      currentContext = ctx;
    },

    watchLifecycle(): void {
      deps.pi.events.on(SUBAGENT_SESSION_CREATED, (data) => {
        const event = (data ?? {}) as ChildSessionCreatedEvent;
        const sessionId = nonEmptyString(event.sessionId);
        if (sessionId === undefined) {
          return;
        }
        // 必须保持同步：核心在 `bindExtensions()` 之前发出，子实例的 `session_start`
        // 随即会来查这张表。这里没有 await，所以注册一定早于子实例的读取。
        const parentSessionId = nonEmptyString(event.parentSessionId);
        store().children.set(
          sessionId,
          parentSessionId === undefined ? {} : { parentSessionId },
        );
      });

      deps.pi.events.on(SUBAGENT_BOUND, (data) => {
        const event = (data ?? {}) as ChildBoundEvent;
        const sessionId = nonEmptyString(event.sessionId);
        if (sessionId === undefined) {
          return;
        }
        if (store().handshakes.has(sessionId)) {
          return;
        }
        reportUnguarded(sessionId, nonEmptyString(event.parentSessionId));
      });

      deps.pi.events.on(SUBAGENT_DISPOSED, (data) => {
        const event = (data ?? {}) as ChildDisposedEvent;
        const sessionId = nonEmptyString(event.sessionId);
        if (sessionId === undefined) {
          return;
        }
        const current = store();
        current.children.delete(sessionId);
        current.handshakes.delete(sessionId);
      });
    },

    detectSelf(ctx): boolean {
      const sessionId = ctx.sessionManager.getSessionId();
      const current = store();
      const link = current.children.get(sessionId);
      if (link === undefined) {
        // 不是已注册的子会话：不写握手（也不会因普通会话不断累积无用的指纹）。
        // `session-created` 在 `bindExtensions()` 之前同步发出，因此真子会话走到这里时
        // 注册一定已经就位。
        return false;
      }
      // 绑定握手：父实例的 `bound` 校对据此判断"子会话是否真的加载了本插件"。
      current.handshakes.add(sessionId);
      deps.runtime.isSubagentSession = true;
      deps.runtime.subagentParentSessionId = link.parentSessionId;
      return true;
    },
  };
}
