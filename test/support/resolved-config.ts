import {
  mergeLayers,
  type ConfigLayerStatus,
  type LoadedLayer,
  type ResolvedConfig,
} from "../../src/config/merge.ts";
import { guardianConfigSchema } from "../../src/config/schema.ts";

/**
 * 策略层与决策管线测试用的 `ResolvedConfig` 构造器。
 *
 * 直接走 `mergeLayers`（而不是手写 ResolvedConfig），保证测试看到的规则表、baseline 合成与
 * degraded 处理与生产路径完全一致——这几件事正是策略层最依赖的输入。
 */

export function makeLayer(
  layer: "global" | "project",
  raw: Record<string, unknown>,
  status: ConfigLayerStatus = "loaded",
): LoadedLayer {
  const base: LoadedLayer = {
    layer,
    path: `/tmp/${layer}/config.json`,
    status,
    diagnostics: [],
    raw,
  };
  if (status === "missing" || status === "skipped" || status === "invalid") {
    return base;
  }
  return { ...base, config: guardianConfigSchema.parse(raw) };
}

export interface ResolveOptions {
  global?: Record<string, unknown>;
  project?: Record<string, unknown>;
  globalStatus?: ConfigLayerStatus;
  projectStatus?: ConfigLayerStatus;
}

export function resolveConfig(options: ResolveOptions = {}): ResolvedConfig {
  const layers: LoadedLayer[] = [
    makeLayer("global", options.global ?? {}, options.globalStatus ?? "loaded"),
  ];
  if (options.project !== undefined || options.projectStatus !== undefined) {
    layers.push(
      makeLayer("project", options.project ?? {}, options.projectStatus ?? "loaded"),
    );
  }
  return mergeLayers(layers);
}
