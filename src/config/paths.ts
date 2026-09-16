import { join } from "node:path";

/**
 * 配置与日志的路径解析（FR-47、FR-43）。
 *
 * 目录名固定为包名 `pi-permission-guardian`，全局层挂在 `<agentDir>/extensions/` 下，
 * 项目层挂在 `<cwd>/.pi/extensions/` 下 —— 与 pi 的扩展发现规则一致。
 */

export const EXTENSION_DIR_NAME = "pi-permission-guardian";
export const CONFIG_FILE_NAME = "config.json";

/** `<agentDir>/extensions/pi-permission-guardian` */
export function globalExtensionDir(agentDir: string): string {
  return join(agentDir, "extensions", EXTENSION_DIR_NAME);
}

/** `<cwd>/.pi/extensions/pi-permission-guardian` */
export function projectExtensionDir(cwd: string): string {
  return join(cwd, ".pi", "extensions", EXTENSION_DIR_NAME);
}

/** 全局配置：始终加载（FR-47）。 */
export function globalConfigPath(agentDir: string): string {
  return join(globalExtensionDir(agentDir), CONFIG_FILE_NAME);
}

/** 项目配置：仅当 `ctx.isProjectTrusted()` 为真时加载（FR-48）。 */
export function projectConfigPath(cwd: string): string {
  return join(projectExtensionDir(cwd), CONFIG_FILE_NAME);
}

/** 审计日志目录：`<agentDir>/extensions/pi-permission-guardian/logs/`。 */
export function auditLogDir(agentDir: string): string {
  return join(globalExtensionDir(agentDir), "logs");
}

/** 日志文件名前缀，完整形式为 `guardian-YYYY-MM-DD.jsonl`。 */
export const LOG_FILE_PREFIX = "guardian-";
export const LOG_FILE_EXTENSION = ".jsonl";

/** 进程本地日期（非 UTC）：`2026-09-16`。 */
export function localDateStamp(now: Date): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 与 `localDateStamp` 配套的日志文件名。 */
export function dailyLogFileName(stamp: string): string {
  return `${LOG_FILE_PREFIX}${stamp}${LOG_FILE_EXTENSION}`;
}
