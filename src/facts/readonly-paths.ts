import { makePathTarget } from "./path-value.ts";
import type { Direction, FactsContext, PathTarget } from "./types.ts";

/**
 * 内置工具的路径提取（FR-17）。
 *
 * | 工具 | 路径来源 | 方向 |
 * |---|---|---|
 * | `read` | `input.path` | read |
 * | `write` / `edit` | `input.path` | write |
 * | `find` / `grep` / `ls` | `input.path ?? cwd` | read |
 * | `bash` | 由 `bash/` 子模块从命令中提取 | — |
 *
 * 这里的 path 一律视为路径候选，不做"看起来像不像路径"的判断：工具自己的参数就是路径，
 * 相对路径由工具按 cwd 解析。
 */

interface ToolPathRule {
  field: string;
  direction: Direction;
  /** 未提供路径时是否回退到 cwd（搜索类工具默认搜当前目录）。 */
  fallbackCwd: boolean;
}

const TOOL_PATH_RULES: Readonly<Record<string, ToolPathRule>> = {
  read: { field: "path", direction: "read", fallbackCwd: false },
  write: { field: "path", direction: "write", fallbackCwd: false },
  edit: { field: "path", direction: "write", fallbackCwd: false },
  find: { field: "path", direction: "read", fallbackCwd: true },
  grep: { field: "path", direction: "read", fallbackCwd: true },
  ls: { field: "path", direction: "read", fallbackCwd: true },
};

export function hasToolPathRule(toolName: string): boolean {
  return toolName in TOOL_PATH_RULES;
}

/**
 * 提取内置只读/写入工具的路径候选。
 *
 * 输入形状不符合预期（`path` 不是字符串）时返回空数组而不是猜一个路径：调用方会落到该
 * surface 的默认动作，写类默认 `review`，比猜错方向安全。
 */
export function extractToolPaths(
  toolName: string,
  input: unknown,
  context: FactsContext,
): PathTarget[] {
  const rule = TOOL_PATH_RULES[toolName];
  if (rule === undefined) {
    return [];
  }
  const raw = readStringField(input, rule.field);
  if (raw !== undefined && raw.length > 0) {
    return [
      makePathTarget(raw, rule.direction, "tool-input", {
        cwd: context.cwd,
        platform: context.platform,
        roots: context.roots,
      }),
    ];
  }
  if (!rule.fallbackCwd) {
    return [];
  }
  return [
    makePathTarget(context.cwd, rule.direction, "tool-input", {
      cwd: context.cwd,
      platform: context.platform,
      roots: context.roots,
    }),
  ];
}

/** 读取对象里的字符串字段；不是字符串时返回 undefined。 */
export function readStringField(input: unknown, field: string): string | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}
