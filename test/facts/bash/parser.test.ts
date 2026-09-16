import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bashParserStatus,
  disposeBashParser,
  ensureBashParser,
  getBashParser,
  parseBashWith,
  warmupBashParser,
} from "../../../src/facts/bash/parser.ts";

/**
 * 解析器生命周期（FR-11）。
 *
 * 关键不变量：
 * - 首次调用完成初始化，之后同步取用；并发调用共享同一次加载；
 * - 释放后可以重新初始化（会话重启）；
 * - 失败不被缓存成"就绪"——由 extract-degraded 测试覆盖失败分支。
 */

// WASM 首次加载在并行 worker 里可能超过默认 5s hook 超时，显式放宽。
beforeAll(async () => {
  await ensureBashParser();
}, 30_000);

afterAll(() => {
  disposeBashParser();
});

describe("bash parser：初始化与复用", () => {
  it("预热后处于就绪状态，并记录语言与 ABI 版本", () => {
    const status = bashParserStatus();
    expect(status.state).toBe("ready");
    expect(status.language).toBe("bash");
    expect(status.abiVersion).toBeGreaterThan(0);
    expect(status.attempts).toBeGreaterThanOrEqual(1);
    expect(status.lastError).toBeUndefined();
  });

  it("解析器随包发布：WASM 路径可解析", () => {
    const status = bashParserStatus();
    expect(status.treeSitterWasm).toContain("web-tree-sitter.wasm");
    expect(status.bashWasm).toContain("tree-sitter-bash.wasm");
  });

  it("同步入口在预热后就绪，且多次调用拿到同一实例", async () => {
    const first = getBashParser();
    const second = await ensureBashParser();
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("并发调用只触发一次加载", async () => {
    disposeBashParser();
    const before = bashParserStatus().attempts;
    const [a, b, c] = await Promise.all([
      ensureBashParser(),
      ensureBashParser(),
      ensureBashParser(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(bashParserStatus().attempts).toBe(before + 1);
  });

  it("能解析真实命令并给出 AST", () => {
    const handle = getBashParser();
    expect(handle).toBeDefined();
    const tree = parseBashWith(handle!, "rm -rf /");
    expect(tree?.rootNode.type).toBe("program");
    expect(tree?.rootNode.hasError).toBe(false);
  });

  it("语法错误体现在 hasError 上，而不是抛异常", () => {
    const handle = getBashParser();
    const tree = parseBashWith(handle!, 'echo "unclosed');
    expect(tree?.rootNode.hasError).toBe(true);
  });
});

describe("bash parser：释放与重启", () => {
  it("释放后回到 idle，可以再次初始化", async () => {
    disposeBashParser();
    expect(bashParserStatus().state).toBe("idle");
    expect(getBashParser()).toBeUndefined();

    const status = await warmupBashParser();
    expect(status.state).toBe("ready");
    expect(getBashParser()).toBeDefined();
  });
});
