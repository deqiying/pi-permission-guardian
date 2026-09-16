import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { AuditLogger } from "../audit/logger.ts";
import type { LayerRules } from "../config/normalize.ts";
import type { GuardianRuntime } from "./state.ts";

/**
 * `/perm` 命令面（FR-39/40/41）与状态输出。
 *
 * 状态文本是"安装后自检"的第一手材料（architecture §11.3）：
 * 规则条数、评审是否可用、配置是否失效应能直接从输出里读到。
 */

export interface CommandDeps {
  runtime: GuardianRuntime;
  audit: AuditLogger;
  /** 走与 `session_start` 相同的加载路径，避免出现第二条配置读取分支。 */
  reloadConfig: (ctx: ExtensionCommandContext) => void;
  updateStatusBar: (ctx: ExtensionCommandContext) => void;
}

/** 只需要 `find` 的极小接口，便于测试注入。 */
export interface ModelRegistryLike {
  find(provider: string, modelId: string): { api: string } | undefined;
}

export const COMMAND_USAGE =
  "用法：/perm [on|off|status|reload|grants|clear-grants]";

export function createCommandHandler(
  deps: CommandDeps,
): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
  return async (args, ctx) => {
    const subcommand = args.trim().split(/\s+/)[0] ?? "";
    switch (subcommand) {
      case "":
      case "status": {
        ctx.ui.notify(renderStatusReport(deps, ctx.modelRegistry), "info");
        return;
      }
      case "on": {
        deps.runtime.engagedOverride = true;
        deps.runtime.engaged = true;
        deps.updateStatusBar(ctx);
        ctx.ui.notify("pi-permission-guardian 已启用（本会话）", "info");
        return;
      }
      case "off": {
        deps.runtime.engagedOverride = false;
        deps.runtime.engaged = false;
        deps.updateStatusBar(ctx);
        ctx.ui.notify("pi-permission-guardian 已关闭（本会话）", "info");
        return;
      }
      case "reload": {
        deps.reloadConfig(ctx);
        deps.updateStatusBar(ctx);
        ctx.ui.notify(
          `配置已重新加载：版本 ${deps.runtime.configVersion}，规则 ${
            deps.runtime.config?.ruleCount ?? 0
          } 条`,
          "info",
        );
        return;
      }
      case "grants": {
        const keys = [...deps.runtime.grants.keys];
        ctx.ui.notify(
          keys.length === 0
            ? "本会话没有授权记忆"
            : `本会话授权记忆（${keys.length} 条）：\n${keys
                .map((key) => `- ${key}`)
                .join("\n")}`,
          "info",
        );
        return;
      }
      case "clear-grants": {
        const count = deps.runtime.grants.keys.size;
        deps.runtime.grants.keys.clear();
        ctx.ui.notify(`已清空本会话授权记忆（${count} 条）`, "info");
        return;
      }
      default: {
        ctx.ui.notify(`未知子命令 "${subcommand}"。${COMMAND_USAGE}`, "warning");
      }
    }
  };
}

/**
 * 状态栏文本（FR-41）：模式 + 最近一次决策来源。
 * M1 尚无决策来源，因此只显示模式；`yoloMode` 与配置失效都必须显著提示（FR-53）。
 */
export function renderStatusBar(runtime: GuardianRuntime): string | undefined {
  if (runtime.config === undefined) {
    return "perm: 未初始化";
  }
  if (!runtime.engaged) {
    return "perm: off";
  }
  const flags: string[] = [];
  if (runtime.yolo) {
    flags.push("YOLO");
  }
  if (runtime.config.degraded) {
    flags.push("配置失效");
  }
  return flags.length === 0 ? "perm: on" : `perm: on [${flags.join(" ")}]`;
}

/**
 * `/perm status` 的完整报告（M1 初始合同）。
 *
 * TODO(M2)：tree-sitter 行现在只是占位，接入 parser 预热后改成读真实状态。
 */
export function renderStatusReport(
  deps: CommandDeps,
  registry?: ModelRegistryLike,
): string {
  const { runtime } = deps;
  const config = runtime.config;
  const lines: string[] = ["pi-permission-guardian 状态"];

  if (config === undefined) {
    lines.push("- 配置尚未加载（会话未启动）");
    return lines.join("\n");
  }

  lines.push(
    `- 总开关：${config.enabled ? "开" : "关"}（config.enabled）｜--perm：${
      runtime.flagEngaged ? "是" : "否"
    }｜会话覆盖：${runtime.engagedOverride === undefined ? "无" : runtime.engagedOverride ? "开" : "关"}｜实际：${
      runtime.engaged ? "参与裁决" : "不参与裁决"
    }`,
  );
  lines.push(`- yoloMode：${config.yoloMode ? "开（ask/review 全部放行）" : "关"}`);
  lines.push(
    `- 配置版本：${runtime.configVersion}｜规则总数：${config.ruleCount} 条${
      config.degraded ? "｜存在失效层" : ""
    }`,
  );

  for (const name of ["global", "project"] as const) {
    const layer = config.layers[name];
    const rules = config.rules.find((entry) => entry.layer === name);
    const ruleCount = rules === undefined ? 0 : countLayerRules(rules);
    const label = name === "global" ? "全局配置" : "项目配置";
    lines.push(
      `- ${label}：${layer.path || "(未解析)"}｜状态 ${layer.status}${
        layer.detail === undefined ? "" : `：${layer.detail}`
      }｜surface ${rules?.surfaces.size ?? 0} 个｜规则 ${ruleCount} 条`,
    );
  }

  for (const name of ["global", "project"] as const) {
    for (const diagnostic of config.layers[name].diagnostics) {
      const position =
        diagnostic.line === undefined
          ? ""
          : ` 第 ${diagnostic.line} 行第 ${diagnostic.column ?? 1} 列`;
      lines.push(`  ! ${name}${position}：${diagnostic.message}`);
      if (diagnostic.snippet !== undefined && diagnostic.snippet !== "") {
        lines.push(`    > ${diagnostic.snippet}`);
      }
    }
  }

  lines.push(
    `- gate：${config.gate}${
      config.extraTools.length === 0
        ? ""
        : `｜额外工具：${config.extraTools.join(", ")}`
    }`,
  );
  lines.push(`- 评审模型：${describeReviewer(config.reviewer.model, registry)}`);
  lines.push(
    `- userBashPolicy：enabled=${config.userBashPolicy.enabled} autoReview=${
      config.userBashPolicy.autoReview
    } model=${config.userBashPolicy.model ?? "复用 reviewer.model"}｜冲突：${
      runtime.userBashConflict ? "检测到其他拦截器声明" : "无"
    }`,
  );
  lines.push(
    `- subagentPolicy：enabled=${config.subagentPolicy.enabled} defaultAction=${
      config.subagentPolicy.defaultAction
    } allowSessionGrants=${config.subagentPolicy.allowSessionGrants}`,
  );
  lines.push(`- subagentCoverage：${describeSubagentCoverage(deps)}`);
  lines.push("- tree-sitter：未预热");
  lines.push(
    `- 计数器：grants ${runtime.grants.keys.size}｜cache ${runtime.cache.entries.size}｜熔断 连续 ${runtime.breaker.consecutiveDenials} / 窗口 ${runtime.breaker.recentDenials}`,
  );
  lines.push(
    `- 审计日志：${
      deps.audit.isEnabled ? "启用" : "关闭"
    }｜保留 ${deps.audit.retention} 天｜已写 ${deps.audit.written} 条｜写盘失败 ${deps.audit.failures} 次${
      deps.audit.isEnabled ? `｜目录 ${deps.audit.directory}` : ""
    }`,
  );
  lines.push(
    `- 失败分支：onReviewUnavailable=${config.onReviewUnavailable} onUnresolvedFacts=${config.onUnresolvedFacts} onAskWithoutUI=${config.onAskWithoutUI} onMixedCommandActions=${config.onMixedCommandActions}`,
  );

  return lines.join("\n");
}

/**
 * 评审模型的可解析性。协议只来自模型自身配置，这里如实回报，便于确认"插件没有协议覆盖入口"。
 */
function describeReviewer(
  spec: string | undefined,
  registry: ModelRegistryLike | undefined,
): string {
  if (spec === undefined) {
    return "未配置（需要评审时判为 unavailable，按 onReviewUnavailable 处理）";
  }
  const resolved = resolveModel(spec, registry);
  return resolved === undefined
    ? `${spec}（未在 pi 模型配置中找到，需要评审时判为 unavailable）`
    : `${spec}（可用，协议 ${resolved}）`;
}

function resolveModel(
  spec: string,
  registry: ModelRegistryLike | undefined,
): string | undefined {
  const separator = spec.indexOf("/");
  if (separator <= 0 || registry === undefined) {
    return undefined;
  }
  return registry.find(spec.slice(0, separator), spec.slice(separator + 1))?.api;
}

function describeSubagentCoverage(deps: CommandDeps): string {
  if (!deps.runtime.isSubagentSession) {
    return "未识别，使用父策略";
  }
  return deps.runtime.config?.subagentPolicy.enabled === true
    ? "已识别，启用 subagentPolicy"
    : "已识别，但 subagentPolicy 已关闭，使用父策略";
}

/** 一层的规则总条数。 */
function countLayerRules(rules: LayerRules): number {
  let total = 0;
  for (const entries of rules.surfaces.values()) {
    total += entries.length;
  }
  return total;
}
