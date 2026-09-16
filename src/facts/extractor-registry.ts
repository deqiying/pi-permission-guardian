import { makePathTarget } from "./path-value.ts";
import { readStringField } from "./readonly-paths.ts";
import type { FactsContext, PathTarget } from "./types.ts";

/**
 * 第三方工具路径提取器注册（FR-18）。
 *
 * 未注册的工具回退到 `input.path`：这是 pi 工具的通用约定（`read` / `write` / `edit` 等同名），
 * 因此自定义工具只要沿用 `path` 字段就自动获得路径判定，不必注册。
 * 注册项按注册顺序生效，同名后注册者覆盖前者（便于用户扩展覆盖内置约定）。
 */

export type ToolPathExtractor = (
  input: unknown,
  context: FactsContext,
) => readonly PathTarget[] | undefined;

const registry = new Map<string, ToolPathExtractor>();

/** 注册自定义工具路径提取器。返回取消注册的函数。 */
export function registerToolPathExtractor(
  toolName: string,
  extractor: ToolPathExtractor,
): () => void {
  registry.set(toolName, extractor);
  return () => {
    if (registry.get(toolName) === extractor) {
      registry.delete(toolName);
    }
  };
}

export function lookupToolPathExtractor(
  toolName: string,
): ToolPathExtractor | undefined {
  return registry.get(toolName);
}

/** 未注册工具的兜底：`input.path`，方向按需求默认视为 write（未知工具可能写入）。 */
export function extractFallbackPaths(
  input: unknown,
  context: FactsContext,
): PathTarget[] {
  const raw = readStringField(input, "path");
  if (raw === undefined || raw.length === 0) {
    return [];
  }
  return [
    makePathTarget(raw, "write", "tool-input", {
      cwd: context.cwd,
      platform: context.platform,
      roots: context.roots,
    }),
  ];
}

/** 仅供测试：清空注册表。 */
export function clearToolPathExtractors(): void {
  registry.clear();
}
