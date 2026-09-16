import type { PathTarget } from "./types.ts";

/**
 * 工具名 → surface 映射（FR-2、FR-17、architecture §6.4）。
 *
 * 规则表按 surface 组织：内置工具各占一个面，未知工具用工具名本身作为面（catchall），
 * `*` 兜底面由求值器统一处理。这里只做映射，不做任何裁决。
 */

/** pi 内置工具与它们各自的面（默认动作矩阵见 architecture §6.4）。 */
export const BUILTIN_TOOL_SURFACES: Readonly<Record<string, string>> = {
  read: "read",
  write: "write",
  edit: "edit",
  find: "find",
  grep: "grep",
  ls: "ls",
  bash: "bash",
  powershell: "powershell",
};

/** pi 内置工具名集合，供 gate=side-effect 判定使用。 */
export const BUILTIN_TOOLS: readonly string[] = Object.keys(BUILTIN_TOOL_SURFACES);

/** 已知内置工具用固定面，其余工具用工具名本身作为面（FR-2 catchall）。 */
export function toolSurface(toolName: string): string {
  return BUILTIN_TOOL_SURFACES[toolName] ?? toolName;
}

export function isBuiltinTool(toolName: string): boolean {
  return toolName in BUILTIN_TOOL_SURFACES;
}

/** 方向面对应的 surface 名。 */
export const PATH_SURFACE: Readonly<Record<PathTarget["direction"], string>> = {
  read: "path_read",
  write: "path_write",
};

/** 外部目录方向面对应的 surface 名。 */
export const EXTERNAL_DIRECTORY_SURFACE: Readonly<
  Record<PathTarget["direction"], string>
> = {
  read: "external_directory_read",
  write: "external_directory_write",
};

/**
 * 由路径派生需要参与求值的 surface。
 *
 * `path_read` / `path_write` 是"用户按敏感路径写的规则"，只有存在对应方向的路径候选时才可能出现命中；
 * `external_directory_*` 只对确实在工作目录之外的目标参与求值——否则用户为外部目录写的规则
 * 会顺带作用于工作目录内的文件。
 */
export function pathSurfaces(paths: readonly PathTarget[]): string[] {
  const surfaces = new Set<string>();
  for (const path of paths) {
    surfaces.add(PATH_SURFACE[path.direction]);
    if (path.external) {
      surfaces.add(EXTERNAL_DIRECTORY_SURFACE[path.direction]);
    }
  }
  return [...surfaces];
}

/** 工具面 + 路径派生面的完整列表（顺序稳定，便于快照测试与日志）。 */
export function collectSurfaces(
  toolName: string,
  paths: readonly PathTarget[],
): string[] {
  const ordered = new Set<string>([toolSurface(toolName), ...pathSurfaces(paths)]);
  return [...ordered];
}
