import { afterEach, describe, expect, it } from "vitest";

import { clearToolPathExtractors, registerToolPathExtractor } from "../../src/facts/extractor-registry.ts";
import { extractFacts, extractFactsSync } from "../../src/facts/extract.ts";
import { hasToolPathRule } from "../../src/facts/readonly-paths.ts";
import type { FactsContext } from "../../src/facts/types.ts";

const context: FactsContext = {
  cwd: "/proj/app",
  platform: "linux",
  home: "/home/u",
  roots: ["/proj/app"],
  readOnlyCommands: [],
};

afterEach(() => {
  clearToolPathExtractors();
});

describe("工具路径提取（FR-17）", () => {
  it("read 是读方向，write/edit 是写方向", async () => {
    const read = await extractFacts("read", { path: "a.txt" }, context);
    expect(read.paths[0]?.direction).toBe("read");
    expect(read.surfaces).toEqual(["read", "path_read"]);

    const write = await extractFacts("write", { path: "a.txt", content: "x" }, context);
    expect(write.paths[0]?.direction).toBe("write");
    expect(write.surfaces).toEqual(["write", "path_write"]);

    const edit = await extractFacts("edit", { path: "a.txt", edits: [] }, context);
    expect(edit.paths[0]?.direction).toBe("write");
  });

  it("find/grep/ls 未给路径时按 cwd 处理", async () => {
    for (const tool of ["find", "grep", "ls"]) {
      const facts = await extractFacts(tool, {}, context);
      expect(facts.paths.map((path) => path.lexical)).toEqual(["/proj/app"]);
      expect(facts.paths[0]?.direction).toBe("read");
    }
  });

  it("find/grep/ls 显式给了路径就用它", async () => {
    const facts = await extractFacts("grep", { pattern: "x", path: "../other" }, context);
    expect(facts.paths[0]?.lexical).toBe("/proj/other");
    expect(facts.paths[0]?.external).toBe(true);
  });

  it("path 缺失或类型不对时不猜路径（写类退到 surface 默认动作）", async () => {
    const missing = await extractFacts("write", {}, context);
    expect(missing.paths).toEqual([]);
    expect(missing.surfaces).toEqual(["write"]);

    const wrongType = await extractFacts("write", { path: 42 }, context);
    expect(wrongType.paths).toEqual([]);
  });

  it("read 没有 path 时不退到 cwd（读取必须显式指定文件）", async () => {
    const facts = await extractFacts("read", {}, context);
    expect(facts.paths).toEqual([]);
    expect(hasToolPathRule("read")).toBe(true);
  });

  it("工具输入是 null / 字符串等异常形状时不抛异常", async () => {
    for (const input of [null, "str", 42, []]) {
      const facts = await extractFacts("write", input, context);
      expect(facts.paths).toEqual([]);
    }
  });
});

describe("工具路径提取（FR-18）：注册表与兜底", () => {
  it("未注册工具回退到 input.path，并按写方向处理", async () => {
    const facts = await extractFacts("mcp__fs__save", { path: "/etc/x" }, context);
    expect(facts.surfaces).toEqual(["mcp__fs__save", "path_write", "external_directory_write"]);
    expect(facts.paths[0]?.direction).toBe("write");
  });

  it("未注册且没有 path 字段时不出路径", async () => {
    const facts = await extractFacts("custom", { query: "x" }, context);
    expect(facts.paths).toEqual([]);
    expect(facts.surfaces).toEqual(["custom"]);
  });

  it("注册的提取器优先生效，注销后回到兜底", async () => {
    const unregister = registerToolPathExtractor("mytool", (input) => {
      const value = (input as { target?: string }).target;
      return value === undefined
        ? undefined
        : [
            {
              raw: value,
              lexical: `/resolved/${value}`,
              direction: "read" as const,
              source: "tool-input" as const,
              external: false,
            },
          ];
    });

    const registered = await extractFacts("mytool", { target: "x" }, context);
    expect(registered.paths[0]?.lexical).toBe("/resolved/x");
    expect(registered.paths[0]?.direction).toBe("read");

    unregister();
    const fallback = await extractFacts("mytool", { target: "x" }, context);
    expect(fallback.paths).toEqual([]);
  });
});

describe("powershell 事实（v1 无解析器）", () => {
  it("整条命令是一条不可静态展开的单元，且绝不只读", async () => {
    const facts = await extractFacts("powershell", { command: "Remove-Item -Recurse ./dist" }, context);
    expect(facts.unresolved).toBe("unparsed-language");
    expect(facts.commands).toHaveLength(1);
    expect(facts.commands[0]?.text).toBe("Remove-Item -Recurse ./dist");
    expect(facts.commands[0]?.unresolved).toBe("unparsed-language");
    expect(facts.commands[0]?.readOnly).toBe(false);
    expect(facts.surfaces).toEqual(["powershell"]);
  });

  it("空命令不产生单元", async () => {
    const facts = await extractFacts("powershell", { command: "  " }, context);
    expect(facts.commands).toEqual([]);
    expect(facts.unresolved).toBeUndefined();
  });
});

describe("非 bash 工具的同步入口", () => {
  it("不需要解析器，直接返回结果", () => {
    const facts = extractFactsSync("read", { path: "a.txt" }, context);
    expect(facts?.paths[0]?.direction).toBe("read");
  });
});
