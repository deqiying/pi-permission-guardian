import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { STATUS_BAR_KEY } from "../audit/entry.ts";
import type { AuditLogger } from "../audit/logger.ts";
import { loadConfig } from "../config/load.ts";
import type { ResolvedConfig } from "../config/merge.ts";
import { auditLogDir } from "../config/paths.ts";
import { disposeBashParser, warmupBashParser } from "../facts/bash/parser.ts";
import { renderStatusBar } from "./commands.ts";
import { type GuardianRuntime, resetSessionState } from "./state.ts";

/**
 * 生命周期装配（architecture §3）。
 *
 * 配置只在 `session_start` 与 `before_agent_start` 刷新（FR-52），不在扩展工厂阶段读取：
 * 工厂运行时 `ctx` 还不可用，`isProjectTrusted()` 也就无从判断（FR-48）。
 * `/perm reload` 复用同一条 `refreshConfig` 路径，避免出现第二条配置读取分支。
 */

export interface SessionControllerDeps {
  pi: ExtensionAPI;
  runtime: GuardianRuntime;
  audit: AuditLogger;
  /** 延迟到真正需要时才读 `PI_CODING_AGENT_DIR`（与 pi 的全局配置位置一致）。 */
  getAgentDir: () => string;
  warn?: (message: string) => void;
}

export interface SessionController {
  /** 读盘 → 合并 → 应用到 runtime。`/perm reload` 与 `before_agent_start` 也走这里。 */
  refreshConfig(ctx: ExtensionContext): ResolvedConfig;
  updateStatusBar(ctx: ExtensionContext): void;
  sessionStart(ctx: ExtensionContext): Promise<void>;
  beforeAgentStart(ctx: ExtensionContext): void;
  sessionShutdown(ctx: ExtensionContext): Promise<void>;
}

export function createSessionController(
  deps: SessionControllerDeps,
): SessionController {
  const { runtime } = deps;
  const warn =
    deps.warn ?? ((message: string): void => console.warn(message));
  let reportedDiagnostics: string | undefined;
  /** 解析器告警每个会话只报一次，避免每次 before_agent_start 都刷屏。 */
  let reportedParserError = false;

  function refreshConfig(ctx: ExtensionContext): ResolvedConfig {
    const agentDir = deps.getAgentDir();
    const config = loadConfig({
      cwd: ctx.cwd,
      agentDir,
      projectTrusted: ctx.isProjectTrusted(),
    });

    runtime.config = config;
    runtime.configVersion += 1;
    runtime.yolo = config.yoloMode;
    deps.audit.configure({
      dir: auditLogDir(agentDir),
      enabled: config.auditLog.enabled,
      retentionDays: config.auditLog.retentionDays,
    });
    applyEngagement(config);
    reportDiagnostics(ctx, config);
    return config;
  }

  function applyEngagement(config: ResolvedConfig): void {
    // `/perm on|off` 的会话级覆盖优先；否则 `--perm` 或配置总开关任一开启即参与裁决。
    runtime.engaged =
      runtime.engagedOverride ?? (config.enabled || runtime.flagEngaged);
  }

  function reportDiagnostics(ctx: ExtensionContext, config: ResolvedConfig): void {
    const messages = [config.layers.global, config.layers.project].flatMap(
      (layer) =>
        layer.diagnostics.map((diagnostic) => {
          const position =
            diagnostic.line === undefined
              ? ""
              : `（第 ${diagnostic.line} 行第 ${diagnostic.column ?? 1} 列）`;
          return `[pi-permission-guardian] ${diagnostic.layer} 配置：${diagnostic.message}${position}`;
        }),
    );
    if (config.degraded) {
      messages.push(
        "[pi-permission-guardian] 存在失效配置层：未命中规则的默认动作按保守侧处理（FR-51）",
      );
    }
    if (config.yoloMode) {
      messages.push(
        "[pi-permission-guardian] yoloMode 已开启：所有 ask / review 都会被放行（FR-53）",
      );
    }

    const signature = messages.join("\n");
    if (signature === reportedDiagnostics) {
      return;
    }
    reportedDiagnostics = signature;
    for (const message of messages) {
      if (ctx.hasUI) {
        ctx.ui.notify(message, "warning");
      } else {
        warn(message);
      }
    }
  }

  function updateStatusBar(ctx: ExtensionContext): void {
    const text = renderStatusBar(runtime);
    try {
      ctx.ui.setStatus(STATUS_BAR_KEY, text);
    } catch (error) {
      // 状态栏只是观测面，不能因为 UI 不支持而影响裁决路径。
      warn(
        `[pi-permission-guardian] 状态栏更新失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    refreshConfig,
    updateStatusBar,

    async sessionStart(ctx: ExtensionContext): Promise<void> {
      runtime.flagEngaged = deps.pi.getFlag("perm") === true;
      resetSessionState(runtime);
      reportedDiagnostics = undefined;
      refreshConfig(ctx);
      await deps.audit.init();
      updateStatusBar(ctx);
    },

    async beforeAgentStart(ctx: ExtensionContext): Promise<void> {
      // 支持会话内改配置：重新读盘 + 重新合并。
      refreshConfig(ctx);
      // 预热解析器：让本次会话的第一条 bash 命令不承担 WASM 加载延迟（FR-11）。
      // 失败不影响裁决——事实层会退回"不可静态展开"的保守路径。
      const parser = await warmupBashParser();
      if (parser.lastError !== undefined && !reportedParserError) {
        reportedParserError = true;
        const message = `[pi-permission-guardian] bash 解析器不可用（${parser.lastError}）：命令将按不可静态展开处理（FR-14）`;
        if (ctx.hasUI) {
          ctx.ui.notify(message, "warning");
        } else {
          warn(message);
        }
      }
      updateStatusBar(ctx);
    },

    async sessionShutdown(ctx: ExtensionContext): Promise<void> {
      await deps.audit.flush();
      disposeBashParser();
      resetSessionState(runtime);
      runtime.config = undefined;
      reportedParserError = false;
      reportedDiagnostics = undefined;
      try {
        ctx.ui.setStatus(STATUS_BAR_KEY, undefined);
      } catch {
        // 关闭阶段的状态栏清理失败可忽略：会话态已经清空，不留残余授权与缓存。
      }
    },
  };
}
