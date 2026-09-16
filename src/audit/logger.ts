import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { dailyLogFileName, localDateStamp } from "../config/paths.ts";

/**
 * 审计日志（FR-43）：JSONL 落盘、按进程本地日期切分、默认保留 14 个自然日。
 *
 * 三条硬约束：
 * - **写盘不进入决策关键路径**：`record()` 只入队，调用方不等 I/O。
 * - **失败只告警**：日志写不出去不能让工具裁决跟着失败，也不能把失败伪装成成功。
 * - **POSIX 下文件权限 0600**：由 `appendFile` 的 `mode` 在创建时生效。
 *   Windows 不支持 POSIX 权限位，`mode` 被忽略，这是已记录的平台限制；
 *   日志目录本身位于 `<agentDir>` 之下，其保护依赖用户主目录的默认 ACL。
 */

/** 审计条目字段（FR-43）。 */
export interface AuditEntry {
  ts: string;
  sessionId?: string;
  toolCallId?: string;
  callIndex?: number;
  toolName: string;
  surface: string;
  targets: string[];
  matchedPattern?: string;
  action: string;
  source: string;
  latencyMs?: number;
  reason?: string;
  model?: string;
  verdict?: string;
  evidenceRounds?: number;
}

export interface AuditLoggerOptions {
  dir: string;
  enabled?: boolean;
  retentionDays?: number;
  /** 可注入时钟，便于测试跨日切分与保留期边界。 */
  now?: () => Date;
  /** 告警出口；缺省 `console.warn`。 */
  warn?: (message: string) => void;
}

const LOG_FILE_PATTERN = /^guardian-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface AuditLoggerSettings {
  /** 日志目录。必须在 `init()` 之前设置。 */
  dir: string;
  enabled: boolean;
  retentionDays: number;
}

export class AuditLogger {
  private dir: string;
  private enabled: boolean;
  private retentionDays: number;
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;

  private currentStamp: string | undefined;
  private pending: Promise<void> = Promise.resolve();
  private errorCount = 0;
  private writeCount = 0;

  constructor(options: AuditLoggerOptions) {
    this.dir = options.dir;
    this.enabled = options.enabled ?? true;
    this.retentionDays = options.retentionDays ?? 14;
    this.now = options.now ?? ((): Date => new Date());
    this.warn = options.warn ?? ((message): void => console.warn(message));
  }

  /** 配置刷新时同步开关、保留期与目录（`/perm reload` 后立即生效）。 */
  configure(settings: Partial<AuditLoggerSettings>): void {
    if (settings.dir !== undefined) {
      this.dir = settings.dir;
    }
    if (settings.enabled !== undefined) {
      this.enabled = settings.enabled;
    }
    if (settings.retentionDays !== undefined) {
      this.retentionDays = settings.retentionDays;
    }
  }

  /** 已成功入队的条目数（供 `/perm status` 与测试）。 */
  get written(): number {
    return this.writeCount;
  }

  /** 写盘失败次数；`/perm status` 用它说明"日志可能不完整"。 */
  get failures(): number {
    return this.errorCount;
  }

  /** 当前日志文件的绝对路径（测试与状态输出用）。 */
  currentPath(): string {
    return join(this.dir, dailyLogFileName(this.stampForNow()));
  }

  /** 是否启用落盘，供 `/perm status` 报告。 */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 保留期，供 `/perm status` 报告。 */
  get retention(): number {
    return this.retentionDays;
  }

  /** 当前日志目录，供 `/perm status` 自检时直接给出查文件的位置。 */
  get directory(): string {
    return this.dir;
  }

  /** 会话启动时的保留期清理。失败只告警。 */
  async init(): Promise<void> {
    this.currentStamp = this.stampForNow();
    if (!this.enabled) {
      return;
    }
    await this.prune();
  }

  /** 入队一条条目；不等待落盘。 */
  record(entry: AuditEntry): void {
    if (!this.enabled) {
      return;
    }
    const stamp = this.stampForNow();
    const rollover = stamp !== this.currentStamp;
    this.currentStamp = stamp;
    this.writeCount++;

    const line = `${JSON.stringify(entry)}\n`;
    this.pending = this.pending
      .then(async () => {
        if (rollover) {
          await this.prune();
        }
        await mkdir(this.dir, { recursive: true });
        // POSIX：创建时写入 0600；Windows：mode 被忽略（见文件头说明）。
        await appendFile(join(this.dir, dailyLogFileName(stamp)), line, {
          encoding: "utf8",
          mode: 0o600,
        });
      })
      .catch((error: unknown) => {
        this.errorCount++;
        this.warn(
          `[pi-permission-guardian] 审计日志写入失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  /** 等待已完成入队的写入（会话关闭与测试退出前调用）。 */
  async flush(): Promise<void> {
    await this.pending;
  }

  private stampForNow(): string {
    return localDateStamp(this.now());
  }

  /** 删除保留期之外的 `guardian-YYYY-MM-DD.jsonl`；只处理自己命名的文件。 */
  private async prune(): Promise<void> {
    const cutoff = this.cutoffStamp();
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.warn(
          `[pi-permission-guardian] 审计日志清理失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return;
    }

    for (const name of names) {
      const match = LOG_FILE_PATTERN.exec(name);
      const stamp = match?.[1];
      if (stamp === undefined || stamp >= cutoff) {
        continue;
      }
      try {
        await rm(join(this.dir, name), { force: true });
      } catch (error) {
        this.warn(
          `[pi-permission-guardian] 审计日志清理失败（${name}）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** 保留期最早一天：`retentionDays` 个自然日，含当天。日期串可直接按字典序比较。 */
  private cutoffStamp(): string {
    const today = this.now();
    const cutoff = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - (this.retentionDays - 1),
    );
    return localDateStamp(cutoff);
  }
}
