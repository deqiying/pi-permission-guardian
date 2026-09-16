import {
  type ExtensionAPI,
  type ExtensionContext,
  type MessageEndEvent,
  type ToolResultEvent,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

import { AuditLogger } from "../audit/logger.ts";
import { resetBreaker } from "../decision/breaker.ts";
import { createDecisionEngine } from "../decision/pipeline.ts";
import { runClassifier } from "../review/classifier.ts";
import type { ReviewerRegistry } from "../review/reviewer.ts";
import { textOfContent } from "../review/transcript.ts";
import { createCommandHandler } from "./commands.ts";
import { createSessionController } from "./startup.ts";
import { createRuntime, type GuardianRuntime } from "./state.ts";
import { createSubagentController } from "./subagents.ts";
import { createUserBashController } from "./user-bash.ts";

export const GUARDIAN_EVENTS = [
  "session_start",
  "before_agent_start",
  "message_end",
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
  const warn = deps.warn ?? ((message: string): void => console.warn(message));

  const controller = createSessionController({
    pi,
    runtime,
    audit,
    getAgentDir: deps.getAgentDir ?? ((): string => getAgentDir()),
    warn: deps.warn,
  });

  const engine = createDecisionEngine({
    pi,
    runtime,
    audit,
    warn: deps.warn,
    // 状态栏与 appendEntry 共用同一份结论（M5 门禁）：两个入口不再各自拼装观测字段。
    onDecision: (_outcome, ctx) => controller.updateStatusBar(ctx),
  });

  const userBash = createUserBashController({
    pi,
    runtime,
    engine,
    // 实例标识：区分"其他实例的声明"与自己的回声。
    instanceId: `pi-permission-guardian-${randomUUID().slice(0, 8)}`,
    warn: deps.warn,
  });
  // 订阅在组合阶段就位（早于任何会话），以便捕获后加载的同类扩展在 session_start 发的声明。
  userBash.watchClaims();

  const subagents = createSubagentController({ pi, runtime, warn: deps.warn });
  // 同理：父实例必须从第一会话起就在听子代理生命周期（FR-55）。
  subagents.watchLifecycle();

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

  /**
   * 非阻塞预评分调度（FR-36~38）。
   *
   * 默认关闭时不发起任何额外模型调用（M5 门禁）；单飞标志在 `runClassifier` 内部，
   * 这里只做"是否该调度"的判定。返回值永远不参与 `tool_result` 的结果。
   */
  function scheduleClassifier(event: ToolResultEvent, ctx: ExtensionContext): void {
    const config = runtime.config;
    if (config === undefined || !config.classifier.enabled) {
      return;
    }
    const registry: ReviewerRegistry = {
      find: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
      complete: (model, context, options) =>
        ctx.modelRegistry.complete(model, context, options),
    };
    void runClassifier({
      state: runtime.classifier,
      registry,
      modelSpec: config.classifier.model ?? config.reviewer.model,
      reasoningEffort: config.classifier.reasoningEffort ?? undefined,
      prompt: {
        toolName: event.toolName,
        toolInput: event.input,
        cwd: ctx.cwd,
        toolResult: textOfContent(event.content),
      },
      callIndex: runtime.callIndex,
      authorizationVersion: runtime.authorizationVersion,
      timeoutMs: config.classifier.timeoutMs,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    }).catch((error: unknown) => {
      warn(
        `[pi-permission-guardian] 预评分调度失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    userBash.attachContext(ctx);
    subagents.attachContext(ctx);
    userBash.publishClaim();
    await controller.sessionStart(ctx);
    // 识别子代理会话（FR-56）：必须在 runtime 重置之后，否则标记会被清掉。
    // 命中时重新渲染状态栏，让“子代理”这个前提下当下可见。
    if (subagents.detectSelf(ctx)) {
      controller.updateStatusBar(ctx);
    }
  });
  pi.on("before_agent_start", (event, ctx) => controller.beforeAgentStart(ctx, event));
  // 会话中途追加的用户消息（steer / followUp）也要参与授权版本（FR-33）。
  pi.on("message_end", (event: MessageEndEvent) => {
    const message = event.message as { role?: unknown; content?: unknown } | undefined;
    if (message?.role !== "user") {
      return;
    }
    controller.recordUserMessage(textOfContent(message.content));
  });
  // 熔断器每轮重置（FR-34/35）。
  pi.on("turn_start", () => {
    resetBreaker(runtime.breaker);
  });
  pi.on("tool_call", (event, ctx) => engine.handleToolCall(event, ctx));
  pi.on("tool_result", (event, ctx) => {
    scheduleClassifier(event, ctx);
  });
  pi.on("user_bash", (event, ctx) => userBash.handler(event, ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    userBash.attachContext(undefined);
    subagents.attachContext(undefined);
    await controller.sessionShutdown(ctx);
  });

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
