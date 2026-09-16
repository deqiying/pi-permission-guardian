import { existsSync, readFileSync } from "node:fs";

import {
  type ConfigDiagnostic,
  type LoadedLayer,
  mergeLayers,
  type ResolvedConfig,
} from "./merge.ts";
import { isActionValueShape } from "./normalize.ts";
import { globalConfigPath, projectConfigPath } from "./paths.ts";
import { guardianConfigSchema } from "./schema.ts";
import { parseJsonc } from "./jsonc.ts";

/**
 * 配置加载（FR-47/48/49/50/51/52）。
 *
 * 每层独立读取与校验，再交给 `merge.ts` 合并。任何一层的失败都不会让插件"静默放行"：
 * - JSON 语法错误（读不出任何字段）：该层不参与合并，报出原文行列号。
 * - JSON 合法但校验失败：按 FR-51 把 `permission` 里的 `allow` 抬升为 `review`，再逐字段 / 逐 surface / 逐规则抢救；
 *   合法部分继续生效，非法部分被忽略并逐条记录。
 * 两种情况都会把 `ResolvedConfig.degraded` 置真，策略层据此把未命中规则的默认动作收紧到保守侧。
 */

export interface LoadConfigOptions {
  cwd: string;
  agentDir: string;
  /** `ctx.isProjectTrusted()`：为假时项目层完全不加载（FR-48）。 */
  projectTrusted: boolean;
}

export function loadConfig(options: LoadConfigOptions): ResolvedConfig {
  const globalLayer = loadLayer("global", globalConfigPath(options.agentDir));

  const projectPath = projectConfigPath(options.cwd);
  const projectLayer: LoadedLayer = options.projectTrusted
    ? loadLayer("project", projectPath)
    : skippedProjectLayer(projectPath);

  return mergeLayers([globalLayer, projectLayer]);
}

/**
 * 项目未受信任（FR-48）。
 *
 * 只有项目里确实存在配置文件时才记录诊断：否则每打开一个未受信任的项目都会产生一条无意义的告警。
 */
function skippedProjectLayer(path: string): LoadedLayer {
  let exists = false;
  try {
    exists = existsSync(path);
  } catch {
    // 路径不可达（权限 / 非法路径）时按不存在处理，不影响全局层生效。
    exists = false;
  }
  return {
    layer: "project",
    path,
    status: "skipped",
    detail: "项目未受信任，项目层未加载（FR-48）",
    diagnostics: exists
      ? [
          {
            layer: "project",
            path,
            message:
              "项目配置存在，但项目未受信任，因此未加载；信任项目后重载即可生效（FR-48）",
          },
        ]
      : [],
  };
}

function loadLayer(layer: "global" | "project", path: string): LoadedLayer {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return missingLayer(layer, path, error);
  }

  const parsed = parseJsonc(text);
  if (!parsed.ok) {
    const diagnostic: ConfigDiagnostic = {
      layer,
      path,
      message: `JSON 解析失败：${parsed.error.message}`,
      line: parsed.error.line,
      column: parsed.error.column,
      snippet: parsed.error.snippet,
    };
    return {
      layer,
      path,
      status: "invalid",
      detail: "JSON 解析失败，该层未生效",
      diagnostics: [diagnostic],
    };
  }

  const result = guardianConfigSchema.safeParse(parsed.value);
  if (result.success) {
    return {
      layer,
      path,
      status: "loaded",
      diagnostics: [],
      config: result.data,
      raw: parsed.value as Record<string, unknown>,
    };
  }

  return degradeLayer(layer, path, parsed.value, result.error.issues);
}

/**
 * FR-51 的降级路径：把该层所有 `allow` 抬升为 `review`，再逐层抢救。
 *
 * 关键点是不能因为一个字段写错就丢掉整层：那会连带丢掉用户显式写的 `deny` 规则，
 * 反而比坏配置更不安全。抢救粒度依次为**顶层字段 → surface → 单条模式规则**，
 * 所以最坏情况只损失一条写坏的规则，同一层里其余 `deny` 仍然生效。
 * 抬升只作用于动作取值本身，不碰 `reason` 文本，也不放宽任何取值。
 */
function degradeLayer(
  layer: "global" | "project",
  path: string,
  raw: unknown,
  issues: readonly { path: PropertyKey[]; message: string }[],
): LoadedLayer {
  const diagnostics: ConfigDiagnostic[] = [
    {
      layer,
      path,
      message: `配置校验失败：${issues
        .map((issue) => `${formatPath(issue.path)} ${issue.message}`)
        .join("；")}`,
      fields: issues.map((issue) => formatPath(issue.path)),
    },
  ];

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      layer,
      path,
      status: "invalid",
      detail: "配置不是对象，该层未生效",
      diagnostics,
    };
  }

  const elevated = elevateAllows(raw as Record<string, unknown>);
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(elevated)) {
    if (key === "permission") {
      const salvaged = salvagePermission(value);
      const ignored = [
        ...salvaged.droppedSurfaces,
        ...salvaged.droppedPatterns,
      ];
      if (ignored.length > 0) {
        diagnostics.push({
          layer,
          path,
          message: `permission 中以下条目不合法已被忽略：${ignored.join("、")}`,
          fields: salvaged.droppedSurfaces.map((surface) => `permission.${surface}`),
        });
      }
      if (Object.keys(salvaged.kept).length === 0) {
        dropped.push("permission");
      } else {
        kept["permission"] = salvaged.kept;
      }
      continue;
    }
    // 单字段重新校验：合法就保留（`allow` 已在上面被抬升）。
    if (guardianConfigSchema.safeParse({ [key]: value }).success) {
      kept[key] = value;
    } else {
      dropped.push(key);
    }
  }

  if (dropped.length > 0) {
    diagnostics.push({
      layer,
      path,
      message: `以下字段不合法已被忽略：${dropped.join("、")}`,
      fields: dropped,
    });
  }

  if (Object.keys(kept).length === 0) {
    diagnostics.push({
      layer,
      path,
      message:
        "提高 allow 后仍无任何字段可用，该层整体不生效；未命中规则的默认动作按保守侧处理（FR-51）",
    });
    return {
      layer,
      path,
      status: "invalid",
      detail: "配置校验失败，该层未生效",
      diagnostics,
    };
  }

  diagnostics.push({
    layer,
    path,
    message: "已把该层所有 allow 抬升为 review，其余合法字段继续生效（FR-51）",
  });
  return {
    layer,
    path,
    status: "degraded",
    detail: "配置校验失败，已按 FR-51 抬升 allow 并逐字段抢救",
    diagnostics,
    config: guardianConfigSchema.parse(kept),
    raw: kept,
  };
}

/**
 * 逐 surface → 逐 pattern 抢救 `permission`。
 *
 * 一个写的 `deny` 规则不应该因为同一个 surface 里另一条规则写错而消失，
 * 所以规则映射按单个模式逐个重新校验；面级动作（字符串或 `{action,reason}`）不拆。
 */
function salvagePermission(value: unknown): {
  kept: Record<string, unknown>;
  droppedSurfaces: string[];
  droppedPatterns: string[];
} {
  const kept: Record<string, unknown> = {};
  const droppedSurfaces: string[] = [];
  const droppedPatterns: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    // 整块不是对象：交给上层的"字段不合法已被忽略：permission"报告，不在这里再报一次。
    return { kept, droppedSurfaces, droppedPatterns };
  }

  for (const [surface, surfaceValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const isMap =
      typeof surfaceValue === "object" &&
      surfaceValue !== null &&
      !Array.isArray(surfaceValue) &&
      !isActionValueShape(surfaceValue);

    if (!isMap) {
      if (validSurface(surface, surfaceValue)) {
        kept[surface] = surfaceValue;
      } else {
        droppedSurfaces.push(surface);
      }
      continue;
    }

    const keptPatterns: Record<string, unknown> = {};
    for (const [pattern, ruleValue] of Object.entries(
      surfaceValue as Record<string, unknown>,
    )) {
      if (validSurface(surface, { [pattern]: ruleValue })) {
        keptPatterns[pattern] = ruleValue;
      } else {
        droppedPatterns.push(`${surface}[${pattern}]`);
      }
    }
    if (Object.keys(keptPatterns).length > 0) {
      kept[surface] = keptPatterns;
    } else {
      droppedSurfaces.push(surface);
    }
  }

  return { kept, droppedSurfaces, droppedPatterns };
}

/** 用同一份 schema 校验单个 surface 取值，保证抢救不会放宽校验。 */
function validSurface(surface: string, value: unknown): boolean {
  return guardianConfigSchema.safeParse({ permission: { [surface]: value } }).success;
}

/**
 * 只抬升 `permission` 规则里的 `allow`。
 *
 * 三个失败分支开关不接受 `allow`（见 schema），配成 `allow` 时它们会被逐字段校验直接丢掉并
 * 落回默认值（`deny` / `review` / `deny`）——这比抬升成 `review` 更严格，也是这里不预设它们的理由。
 */
function elevateAllows(raw: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw };
  const permission = next["permission"];
  if (permission !== undefined) {
    next["permission"] = elevateSurfaceValue(permission);
  }
  return next;
}

/**
 * 抬升一个 surface 取值，只碰动作位置：
 * - 字符串 → 它本身就是动作；
 * - `{action, reason}` 形态 → 只改 `action`，`reason` 文本原样保留；
 * - 其余对象（模式映射） → 逐个模式值递归。
 */
function elevateSurfaceValue(value: unknown): unknown {
  if (value === "allow") {
    return "review";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (isActionValueShape(record)) {
    return record["action"] === "allow" ? { ...record, action: "review" } : value;
  }
  const next: Record<string, unknown> = {};
  for (const [pattern, ruleValue] of Object.entries(record)) {
    next[pattern] = elevateSurfaceValue(ruleValue);
  }
  return next;
}

function missingLayer(
  layer: "global" | "project",
  path: string,
  error: unknown,
): LoadedLayer {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") {
    return {
      layer,
      path,
      status: "missing",
      detail: "配置文件不存在，使用默认值",
      diagnostics: [],
    };
  }
  return {
    layer,
    path,
    status: "invalid",
    detail: "配置读取失败，该层未生效",
    diagnostics: [
      {
        layer,
        path,
        message: `读取失败：${error instanceof Error ? error.message : String(error)}`,
      },
    ],
  };
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return "(根)";
  }
  return path.map((segment) => String(segment)).join(".");
}
