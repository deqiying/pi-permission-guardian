import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

import { AuditLogger } from "../audit/logger.ts";
import { createCommandHandler } from "./commands.ts";
import { createSessionController } from "./startup.ts";
import { createRuntime, type GuardianRuntime } from "./state.ts";

export const GUARDIAN_EVENTS = [
  "session_start",
  "before_agent_start",
  "turn_start",
  "tool_call",
  "tool_result",
  "user_bash",
  "session_shutdown",
] as const;

export const GUARDIAN_COMMAND = "perm";
export const GUARDIAN_FLAG = "perm";

/** 可注入的接缝：生产环境取值与 pi 的默认位置一致，测试可完全脱离真实环境。 */
export interface GuardianDeps {
  getAgentDir?: () => string;
  now?: () => Date;
  warn?: (message: string) => void;
}

/** 尚未接入决策的入口：M5 接入熔断器重置，M3/M4 接入 tool_call 与 user_bash。 */
const inertHandler = (_event: unknown, _ctx: ExtensionContext): undefined =>
  undefined;

/**
 * 唯一的组合根（architecture §2）。工厂阶段只做注册与构造：
 * 不读配置、不访问 `ctx`，因为此时项目信任状态与 cwd 都还不可用。
 *
 * 返回会话运行时：`extensions/guardian.ts` 忽略它，测试与后续里程碑的装配（M6 子代理）需要它。
 */
export function registerGuardian(
  pi: ExtensionAPI,
  deps: GuardianDeps = {},
): GuardianRuntime {
  const runtime = createRuntime();
  const audit = new AuditLogger({
    // 目录在首次配置刷新时写入；启用前不会产生任何 I/O。
    dir: "",
    enabled: false,
    now: deps.now,
    warn: deps.warn,
  });

  const controller = createSessionController({
    pi,
    runtime,
    audit,
    getAgentDir: deps.getAgentDir ?? ((): string => getAgentDir()),
    warn: deps.warn,
  });

  const commandHandler = createCommandHandler({
    runtime,
    audit,
    reloadConfig: (ctx) => {
      controller.refreshConfig(ctx);
    },
    updateStatusBar: (ctx) => {
      controller.updateStatusBar(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => controller.sessionStart(ctx));
  pi.on("before_agent_start", (_event, ctx) => controller.beforeAgentStart(ctx));
  // M5 接入熔断器重置；M3/M4 接入 tool_call 与 user_bash 决策入口。
  pi.on("turn_start", inertHandler);
  pi.on("tool_call", inertHandler);
  pi.on("tool_result", inertHandler);
  pi.on("user_bash", inertHandler);
  pi.on("session_shutdown", (_event, ctx) => controller.sessionShutdown(ctx));

  pi.registerCommand(GUARDIAN_COMMAND, {
    description:
      "管理 pi-permission-guardian（on/off/status/reload/grants/clear-grants）",
    handler: commandHandler,
  });

  pi.registerFlag(GUARDIAN_FLAG, {
    description: "启动时启用 pi-permission-guardian",
    type: "boolean",
    default: false,
  });

  return runtime;
}
