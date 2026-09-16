import { describe, expect, it, vi } from "vitest";

/**
 * 解析器不可用时的降级路径（FR-14 / FR-46 的第二道防线）。
 *
 * 这里把 parser 模块整体替换成"永远初始化失败"，验证：
 * - 不抛异常，而是产出保守 facts；
 * - 命令原文仍参与 bash surface 规则匹配（比如 `rm -rf /` 的 deny 规则仍能命中）；
 * - 绝不把命令标成只读（否则 `cat x` 会变成免评审放行）。
 */

vi.mock("../../src/facts/bash/parser.ts", () => ({
  getBashParser: () => undefined,
  ensureBashParser: async () => {
    throw new Error("wasm 加载失败");
  },
  parseBashWith: () => undefined,
  bashParserStatus: () => ({ state: "idle", attempts: 1, lastError: "wasm 加载失败" }),
  warmupBashParser: async () => ({ state: "idle", attempts: 1 }),
  disposeBashParser: () => {},
}));

const { extractFacts, extractFactsSync } = await import("../../src/facts/extract.ts");
const { ensureBashParser, getBashParser } = await import("../../src/facts/bash/parser.ts");
import type { FactsContext } from "../../src/facts/types.ts";

const context: FactsContext = {
  cwd: "/proj/app",
  platform: "linux",
  home: "/home/u",
  roots: ["/proj/app"],
  readOnlyCommands: ["cat", "ls"],
};

describe("bash facts：解析器不可用", () => {
  it("mock 生效：解析器确实不可用", async () => {
    expect(getBashParser()).toBeUndefined();
    await expect(ensureBashParser()).rejects.toThrow("wasm 加载失败");
  });

  it("不抛异常，返回不可静态展开的保守事实", async () => {
    const facts = await extractFacts("bash", { command: "rm -rf /" }, context);
    expect(facts.parserUsed).toBe("unavailable");
    expect(facts.unresolved).toBe("parser-unavailable");
    expect(facts.commands).toHaveLength(1);
    expect(facts.commands[0]?.text).toBe("rm -rf /");
    // 基础设施故障必须与"该语言没有解析器"区分：评审提示词与自检要能说清是哪一种。
    expect(facts.commands[0]?.unresolved).toBe("parser-unavailable");
    expect(facts.commands[0]?.executable).toBe("rm");
    expect(facts.surfaces).toContain("bash");
  });

  it("白名单命令不能被误判为只读（否则等于免评审放行）", async () => {
    const facts = await extractFacts("bash", { command: "cat secrets.pem" }, context);
    expect(facts.commands[0]?.readOnly).toBe(false);
    expect(facts.commands[0]?.paths).toEqual([]);
  });

  it("空命令不产生命令单元，也不算不可信", async () => {
    const facts = await extractFacts("bash", { command: "   " }, context);
    expect(facts.commands).toEqual([]);
    expect(facts.unresolved).toBeUndefined();
  });

  it("同步入口在解析器未就绪时返回 undefined，交给调用方走异步路径", () => {
    expect(extractFactsSync("bash", { command: "rm x" }, context)).toBeUndefined();
  });
});
