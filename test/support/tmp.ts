import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { globalConfigPath, projectConfigPath } from "../../src/config/paths.ts";

/**
 * 临时工作区：一对 `<agentDir>` 与 `<cwd>`，用于配置加载与审计日志测试。
 * 不触碰真实的 `~/.pi/agent`。
 */
export interface TempWorkspace {
  agentDir: string;
  cwd: string;
  cleanup(): void;
}

export function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function createWorkspace(): TempWorkspace {
  const agentDir = createTempDir("guardian-agent-");
  const cwd = createTempDir("guardian-cwd-");
  return {
    agentDir,
    cwd,
    cleanup(): void {
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

/** 写入全局层配置原文（字符串按原样落盘，便于测试 JSONC 与语法错误）。 */
export function writeGlobalConfig(workspace: TempWorkspace, content: string): void {
  writeConfigFile(globalConfigPath(workspace.agentDir), content);
}

/** 写入项目层配置原文。 */
export function writeProjectConfig(workspace: TempWorkspace, content: string): void {
  writeConfigFile(projectConfigPath(workspace.cwd), content);
}

export function writeConfigFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}
