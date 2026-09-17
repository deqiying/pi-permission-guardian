import type {
  ExtensionAPI,
  ExtensionContext,
  UserBashEvent,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

import { DECISION_ENTRY_TYPE } from "../audit/entry.ts";
import type { DecisionEngine } from "../decision/pipeline.ts";
import { withAntiCircumvention } from "../decision/outcome.ts";
import type { GuardianRuntime } from "./state.ts";

/**
 * `user_bash` 适配（FR-60、architecture §4.0.1）。
 *
 * `!command` 与 `!!command` 不会产生 `tool_call`；pi 在执行前触发 `user_bash`，
 * 事件带命令、cwd 与 `excludeFromContext`。这里用同一个决策内核裁决，再映射执行结果：
 *
 * - `allow` → 返回 `undefined`，交给 pi 的正常 shell 路径；
 * - `deny` → 返回替代 `BashResult`（非零 exitCode + 理由），pi 记录结果但不启动真实命令；
 * - `ask` / `review` 已在管线内落地（人工确认或评审），到这里同样只剩 allow / deny。
 *
 * `!!` 与 `!` 的安全裁决完全相同：`excludeFromContext` 由 pi 在记录结果时处理，
 * 替代结果不参与这件事，因此两种写法共用一条代码路径。
 */

/** 共存声明频道（architecture §4.0.1）。 */
export const USER_BASH_CLAIM_CHANNEL = "pi-permission-guardian:user-bash-claim";

export interface UserBashClaim {
  extension: "pi-permission-guardian";
  instanceId: string;
}

export interface UserBashDeps {
  pi: ExtensionAPI;
  runtime: GuardianRuntime;
  engine: DecisionEngine;
  /** 本实例标识，用于识别并忽略自己的声明事件。 */
  instanceId: string;
  warn?: (message: string) => void;
}

export interface UserBashController {
  /** `user_bash` 事件入口。 */
  handler(
    event: UserBashEvent,
    ctx: ExtensionContext,
  ): Promise<UserBashEventResult | undefined>;
  /** 订阅其他实例的共存声明；返回取消订阅函数。 */
  watchClaims(): () => void;
  /** 发布本实例声明（`session_start`）。 */
  publishClaim(): void;
  /** 保存/清除当前上下文（冲突提示与 appendEntry 需要）。 */
  attachContext(ctx: ExtensionContext | undefined): void;
}

/** 替代结果类型取自事件结果的组成部分，避开 pi 的内部路径（`BashResult` 未从包根导出）。 */
export type ReplacementBashResult = NonNullable<UserBashEventResult["result"]>;

/** 替代执行结果：非零退出码 + 理由，`cancelled=false`（这不是用户取消，是护栏拦截）。 */
export function replacementResult(reason: string): ReplacementBashResult {
  return {
    output: `${reason}\n`,
    exitCode: 1,
    cancelled: false,
    truncated: false,
  };
}

export function createUserBashController(deps: UserBashDeps): UserBashController {
  const warn = deps.warn ?? ((message: string): void => console.warn(message));
  let currentContext: ExtensionContext | undefined;
  let reportedConflict = false;

  /**
   * 记录共存冲突。
   *
   * best-effort：**只提示，不调整加载顺序、不阻止其他 handler、不去"抢回"事件**。
   * pi 的 runner 只返回第一个非空 `user_bash` 结果，且没有扩展枚举或 post-user_bash 事件，
   * 因此"不参与声明且排在前面提前返回"的拦截器无法被可靠观测——这是明确保留的已知边界。
   */
  function markConflict(source: string): void {
    deps.runtime.userBashConflict = true;
    if (reportedConflict) {
      return;
    }
    reportedConflict = true;
    const message = `[pi-permission-guardian] 检测到另一个 user_bash 拦截器声明（${source}）：两者都会拦截用户手输命令，实际生效顺序取决于扩展加载顺序。`;
    if (currentContext?.hasUI === true) {
      currentContext.ui.notify(message, "warning");
    } else {
      warn(message);
    }
    try {
      deps.pi.appendEntry(DECISION_ENTRY_TYPE, {
        timestamp: new Date().toISOString(),
        kind: "user-bash-conflict",
        conflict: true,
        source,
      });
    } catch (error) {
      warn(
        `[pi-permission-guardian] 冲突记录写入失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    attachContext(ctx): void {
      currentContext = ctx;
    },

    publishClaim(): void {
      try {
        deps.pi.events.emit(USER_BASH_CLAIM_CHANNEL, {
          extension: "pi-permission-guardian",
          instanceId: deps.instanceId,
        } satisfies UserBashClaim);
      } catch (error) {
        // 事件总线不可用不该影响护栏本身；共存检测本来就是 best-effort。
        warn(
          `[pi-permission-guardian] 发布 user_bash 声明失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },

    watchClaims(): () => void {
      return deps.pi.events.on(USER_BASH_CLAIM_CHANNEL, (data) => {
        if (typeof data !== "object" || data === null) {
          return;
        }
        const claim = data as Partial<UserBashClaim>;
        if (claim.extension !== "pi-permission-guardian") {
          return;
        }
        if (claim.instanceId === deps.instanceId) {
          // 自己的声明：忽略，否则单实例也会自我报警。
          return;
        }
        markConflict(`instanceId=${String(claim.instanceId ?? "(未知)")}`);
      });
    },

    async handler(
      event: UserBashEvent,
      ctx: ExtensionContext,
    ): Promise<UserBashEventResult | undefined> {
      try {
        const config = deps.runtime.config;
        if (!deps.runtime.engaged) {
          return undefined;
        }
        if (config !== undefined && !config.userBashPolicy.enabled) {
          // 关闭后用户直接执行的命令完全不经过本插件（FR-60）。
          return undefined;
        }
        // `config === undefined` 时不在这里短接：交给同一个决策内核按 FR-64 处理
        // （人工确认；无 UI 时 deny），否则两个入口会长出两套“配置未加载”语义。

        const outcome = await deps.engine.decide(
          {
            origin: "user_bash",
            toolName: "bash",
            toolCallId: `user_bash#${deps.runtime.callIndex + 1}`,
            input: { command: event.command },
            cwd: event.cwd,
          },
          ctx,
        );
        if (outcome === undefined || outcome.final === "allow") {
          return undefined;
        }
        return {
          result: replacementResult(
            outcome.reason ?? "被 pi-permission-guardian 拦截。",
          ),
        };
      } catch (error) {
        // 与 tool_call 同一条底线：异常必须变成拦截，而不是让命令照跑。
        const reason = withAntiCircumvention(
          `护栏内部异常，按 fail-closed 拦截：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        warn(`[pi-permission-guardian] ${reason}`);
        return { result: replacementResult(reason) };
      }
    },
  };
}
