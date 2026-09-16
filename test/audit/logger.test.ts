import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuditLogger, type AuditEntry } from "../../src/audit/logger.ts";
import { createTempDir } from "../support/tmp.ts";

const dirs: string[] = [];

afterEach(() => {
  dirs.length = 0;
});

function tempDir(): string {
  const dir = createTempDir("guardian-log-");
  dirs.push(dir);
  return dir;
}

/** 可控时钟：从本地时间 2026-09-16T09:00 起算。 */
function clock(start: Date): { now: () => Date; set: (date: Date) => void } {
  let current = start;
  return {
    now: () => current,
    set: (date: Date) => {
      current = date;
    },
  };
}

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: "2026-09-16T01:00:00.000Z",
    toolName: "bash",
    surface: "bash",
    targets: ["rm -rf ./dist"],
    action: "allow",
    source: "policy",
    ...overrides,
  };
}

describe("审计日志（FR-43）", () => {
  it("按本地日期切分文件并写入 JSONL", async () => {
    const dir = tempDir();
    const time = clock(new Date(2026, 8, 16, 9, 0, 0));
    const logger = new AuditLogger({ dir, now: time.now });

    await logger.init();
    logger.record(entry({ callIndex: 1 }));
    logger.record(entry({ callIndex: 2 }));
    await logger.flush();

    expect(readdirSync(dir)).toEqual(["guardian-2026-09-16.jsonl"]);
    const lines = readFileSync(join(dir, "guardian-2026-09-16.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      toolName: "bash",
      callIndex: 1,
    });
    expect(logger.written).toBe(2);
    expect(logger.failures).toBe(0);
  });

  it("跨日写入新文件", async () => {
    const dir = tempDir();
    const time = clock(new Date(2026, 8, 16, 23, 59, 0));
    const logger = new AuditLogger({ dir, now: time.now });

    await logger.init();
    logger.record(entry());
    await logger.flush();

    time.set(new Date(2026, 8, 17, 0, 1, 0));
    logger.record(entry());
    await logger.flush();

    expect(readdirSync(dir).sort()).toEqual([
      "guardian-2026-09-16.jsonl",
      "guardian-2026-09-17.jsonl",
    ]);
  });

  it("保留期边界：默认 14 个自然日（含当天）", async () => {
    const dir = tempDir();
    const time = clock(new Date(2026, 8, 16, 9, 0, 0));
    mkdirSync(dir, { recursive: true });
    for (const name of [
      "guardian-2026-09-16.jsonl", // 今天：保留
      "guardian-2026-09-03.jsonl", // 第 14 天：保留
      "guardian-2026-09-02.jsonl", // 第 15 天：删除
      "guardian-2026-08-30.jsonl", // 更早：删除
      "other.jsonl", // 非本插件文件：不动
    ]) {
      writeFileSync(join(dir, name), "{}\n", "utf8");
    }

    const logger = new AuditLogger({ dir, now: time.now });
    await logger.init();

    expect(readdirSync(dir).sort()).toEqual([
      "guardian-2026-09-03.jsonl",
      "guardian-2026-09-16.jsonl",
      "other.jsonl",
    ]);
  });

  it("保留期可配置", async () => {
    const dir = tempDir();
    const time = clock(new Date(2026, 8, 16, 9, 0, 0));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "guardian-2026-09-15.jsonl"), "{}\n", "utf8");

    const logger = new AuditLogger({ dir, now: time.now, retentionDays: 1 });
    await logger.init();

    expect(readdirSync(dir)).toEqual([]);
  });

  it("关闭时不产生任何文件", async () => {
    const dir = tempDir();
    const logger = new AuditLogger({ dir, enabled: false });

    await logger.init();
    logger.record(entry());
    await logger.flush();

    expect(logger.written).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("清理失败只告警，不影响初始化", async () => {
    const dir = tempDir();
    const warnings: string[] = [];
    // 目录位置被一个普通文件占用 → readdir 报 ENOTDIR
    writeFileSync(join(dir, "blocker"), "", "utf8");
    const logger = new AuditLogger({
      dir: join(dir, "blocker"),
      now: () => new Date(2026, 8, 16, 9, 0, 0),
      warn: (message) => warnings.push(message),
    });

    await expect(logger.init()).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("审计日志清理失败");
  });

  it("写盘失败只告警并计数，绝不抛出", async () => {
    const dir = tempDir();
    const warnings: string[] = [];
    writeFileSync(join(dir, "blocker"), "", "utf8");
    const logger = new AuditLogger({
      dir: join(dir, "blocker", "logs"),
      now: () => new Date(2026, 8, 16, 9, 0, 0),
      warn: (message) => warnings.push(message),
    });

    await logger.init();
    expect(() => logger.record(entry())).not.toThrow();
    await expect(logger.flush()).resolves.toBeUndefined();

    expect(logger.failures).toBe(1);
    expect(warnings.some((message) => message.includes("写入失败"))).toBe(true);
  });

  it("POSIX 下日志文件权限为 0600", async () => {
    if (process.platform === "win32") {
      // Windows 不支持 POSIX 权限位，mode 被忽略：这是已记录的平台限制。
      return;
    }
    const dir = tempDir();
    const logger = new AuditLogger({
      dir,
      now: () => new Date(2026, 8, 16, 9, 0, 0),
    });

    await logger.init();
    logger.record(entry());
    await logger.flush();

    const mode = statSync(join(dir, "guardian-2026-09-16.jsonl")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
