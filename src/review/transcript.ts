import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  MAX_TRANSCRIPT_ENTRY_CHARS,
  MAX_TRANSCRIPT_RECENT_ENTRIES,
  MAX_TRANSCRIPT_TOOL_CHARS,
  TRUNCATION_MARKER,
  boundText,
} from "./types.ts";

/**
 * 会话摘要的构造（FR-20）。
 *
 * 预算分配照 Codex guardian 的做法：**用户话是锚点**，优先保留首条与最新一条（分别承载任务
 * 与当下的要求），工具与助手的证据另给一份更小的预算——冗长的命令输出不该把真正建立授权
 * 的人类对话挤出去。`[user]` 是唯一建立授权的角色标记，评审策略文本依赖它。
 */

export interface TranscriptLine {
  role: "user" | "assistant" | "tool";
  text: string;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
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
      if (record["type"] === "toolCall" && typeof record["name"] === "string") {
        const args = record["arguments"];
        const rendered =
          typeof args === "object" && args !== null ? JSON.stringify(args) : "";
        return `${record["name"]} ${rendered}`.trim();
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
}

/**
 * 把会话条目摊成评审可读的行。
 *
 * 非消息条目一律跳过，只有压缩摘要是例外：它是较早对话唯一幸存的视图，
 * 丢弃它会让评审看不到任务的最初授权。
 */
export function sessionEntriesToLines(entries: readonly SessionEntry[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const entry of entries) {
    if (entry.type === "compaction" && typeof entry.summary === "string") {
      const summary = boundText(entry.summary, MAX_TRANSCRIPT_ENTRY_CHARS);
      if (summary.length > 0) {
        lines.push({ role: "assistant", text: `[earlier conversation summary] ${summary}` });
      }
      continue;
    }
    if (entry.type !== "message") {
      continue;
    }
    const message = entry.message as { role?: unknown; content?: unknown };
    const text = textOfContent(message.content);
    if (text.length === 0) {
      continue;
    }
    if (message.role === "user") {
      lines.push({ role: "user", text });
    } else if (message.role === "assistant") {
      lines.push({ role: "assistant", text });
    } else if (message.role === "toolResult") {
      lines.push({ role: "tool", text });
    }
  }
  return lines;
}

export interface TranscriptBudget {
  maxTotalChars: number;
  maxToolChars?: number;
  maxRecentEntries?: number;
}

export interface BuiltTranscript {
  text: string;
  omitted: boolean;
  lineCount: number;
}

export function buildTranscript(
  lines: readonly TranscriptLine[],
  budget: TranscriptBudget,
): BuiltTranscript {
  const maxToolChars = budget.maxToolChars ?? MAX_TRANSCRIPT_TOOL_CHARS;
  const maxRecentEntries = budget.maxRecentEntries ?? MAX_TRANSCRIPT_RECENT_ENTRIES;

  const recent = lines.slice(-Math.max(1, maxRecentEntries));
  const omitted = recent.length < lines.length;

  const userIndexes: number[] = [];
  const otherIndexes: number[] = [];
  recent.forEach((line, index) => {
    if (line.role === "user") {
      userIndexes.push(index);
    } else {
      otherIndexes.push(index);
    }
  });

  const selected = new Set<number>();
  let userChars = 0;
  const userOrder = [
    userIndexes[0],
    userIndexes[userIndexes.length - 1],
    ...userIndexes.slice(1, -1).reverse(),
  ];
  for (const index of userOrder) {
    if (index === undefined || selected.has(index)) {
      continue;
    }
    const cost = recent[index]?.text.length ?? 0;
    if (userChars + cost > budget.maxTotalChars) {
      break;
    }
    selected.add(index);
    userChars += cost;
  }

  let otherChars = 0;
  for (const index of [...otherIndexes].reverse()) {
    const cost = recent[index]?.text.length ?? 0;
    if (otherChars + cost > maxToolChars) {
      continue;
    }
    if (userChars + otherChars + cost > budget.maxTotalChars) {
      continue;
    }
    selected.add(index);
    otherChars += cost;
  }

  const ordered = [...selected].sort((a, b) => a - b);
  const rendered = ordered.map((index) => {
    const line = recent[index];
    if (line === undefined) {
      return "";
    }
    return `[${index + 1}] [${line.role}]: ${boundText(line.text, MAX_TRANSCRIPT_ENTRY_CHARS)}`;
  });
  if (omitted) {
    rendered.unshift(`${TRUNCATION_MARKER} 更早的会话条目已省略。`);
  }
  return { text: rendered.join("\n"), omitted, lineCount: recent.length };
}

/** 直接从会话条目构造评审用 transcript。 */
export function transcriptFromEntries(
  entries: readonly SessionEntry[],
  budget: TranscriptBudget,
): BuiltTranscript {
  return buildTranscript(sessionEntriesToLines(entries), budget);
}
