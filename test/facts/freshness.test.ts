import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extractFacts } from "../../src/facts/extract.ts";
import { disposeBashParser, ensureBashParser, getBashParser, bashParserStatus } from "../../src/facts/bash/parser.ts";
import type { FactsContext } from "../../src/facts/types.ts";

/**
 * 事实层的"时间维度"契约：每次提取都是新的观察。
 *
 * 这些用例保护两类容易被当成"优化"而回退掉的行为：
 * - realpath 缓存只在单次提取内有效（跨调用复用会把过期真实路径当成现在的事实）；
 * - 解析器释放期间完成的加载不"复活"（否则 `/perm reload` 后立即退出等于没释放）。
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "guardian-freshness-"));
  tempDirs.push(dir);
  return dir;
}

describe("每次提取都重新解析真实路径", () => {
  it("软链接目标改变后，同一条路径得到新的真实形", async () => {
    const dir = tempDir();
    const first = join(dir, "first");
    const second = join(dir, "second");
    mkdirSync(first);
    mkdirSync(second);
    const link = join(dir, "link");
    symlinkSync(first, link, process.platform === "win32" ? "junction" : "dir");

    const context: FactsContext = {
      cwd: dir,
      platform: process.platform as NodeJS.Platform,
      home: dir,
      roots: [dir],
      readOnlyCommands: [],
    };
    const target = join(link, "x.txt");

    const before = await extractFacts("read", { path: target }, context);
    expect(before.paths[0]?.canonical).toContain("first");

    // 换掉软链接目标：下一次提取必须看到新位置，而不是复用上一次的真实路径。
    rmSync(link, { force: true });
    symlinkSync(second, link, process.platform === "win32" ? "junction" : "dir");

    const after = await extractFacts("read", { path: target }, context);
    expect(after.paths[0]?.canonical).toContain("second");
  });
});

describe("解析器释放", () => {
  it("加载期间被释放时不复活：本次加载作废并抛错", async () => {
    disposeBashParser();
    const pending = ensureBashParser();
    // 加载还没完成（await 还没轮到），此时释放。
    disposeBashParser();
    await expect(pending).rejects.toThrow("解析器在加载期间被释放");
    expect(getBashParser()).toBeUndefined();
    expect(bashParserStatus().state).toBe("idle");
  });

  it("释放之后可以重新初始化（会话重启）", async () => {
    disposeBashParser();
    const handle = await ensureBashParser();
    expect(handle.parser).toBeDefined();
    expect(bashParserStatus().state).toBe("ready");
    disposeBashParser();
  });
});
