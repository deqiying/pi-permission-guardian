import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";

import { MAX_EVIDENCE_RESULT_CHARS, boundText } from "./types.ts";

/**
 * 评审模型的只读证据工具（FR-24）。
 *
 * 直接复用 pi 的 `createReadOnlyTools(cwd)`，再按**白名单**过滤出 `read` / `grep` / `find` / `ls`：
 * 即使上游以后往只读集合里加了别的工具，评审侧的能力面也不会跟着变宽。
 *
 * 两个关键约束：
 * - 执行是**进程内直接调用**，不经过 pi 的工具执行路径，因此不会触发本插件的 `tool_call` 钩子
 *   （FR-28：评审不能递归进评审）。
 * - 结果按 `MAX_EVIDENCE_RESULT_CHARS` 截断后回喂，防止长文件挤占判定上下文。
 */

export const EVIDENCE_TOOL_NAMES: readonly string[] = ["read", "grep", "find", "ls"];

export interface EvidenceTool {
  name: string;
  description: string;
  /** pi-ai `Tool.parameters` 原样透传给 provider。 */
  parameters: unknown;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

function contentToText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) {
        return "";
      }
      const record = block as Record<string, unknown>;
      if (record["type"] === "text" && typeof record["text"] === "string") {
        return record["text"];
      }
      if (record["type"] === "image") {
        return "[image omitted]";
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * 构造评审可用的证据工具集。
 *
 * `cwd` 固定为本次调用的工作目录：评审查证的是"这条命令在哪个目录下执行"，
 * 而不是插件进程的当前目录。
 */
export function createEvidenceTools(cwd: string): EvidenceTool[] {
  const allowed = new Set(EVIDENCE_TOOL_NAMES);
  return createReadOnlyTools(cwd)
    .filter((tool) => allowed.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
        const result = await tool.execute(`evidence-${tool.name}`, args, signal);
        return boundText(contentToText(result.content), MAX_EVIDENCE_RESULT_CHARS);
      },
    }));
}

/** 把证据工具转成 provider 侧的工具声明（只留 name / description / parameters）。 */
export function toProviderTools(
  tools: readonly EvidenceTool[],
): Array<{ name: string; description: string; parameters: unknown }> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
