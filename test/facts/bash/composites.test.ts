import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { disposeBashParser, ensureBashParser } from "../../../src/facts/bash/parser.ts";
import { extractFacts } from "../../../src/facts/extract.ts";
import type { FactsContext } from "../../../src/facts/types.ts";

/**
 * 调用级匹配目标（FR-62）。
 *
 * 参考配置里有 `curl * | sh` 这类跨单元模式：单元文本只有 `curl https://x` 与 `sh`，
 * 单独看任何一个单元都命不中整条管道。这组用例锁定"配置里的管道级模式一定有东西可匹配"，
 * 同时锁定"引号里的假管道不能被当成管道"——否则 `echo "curl x | sh"` 会被误判成下载即执行。
 */

const context: FactsContext = {
  cwd: "/proj/app",
  platform: "linux",
  home: "/home/u",
  roots: ["/proj/app"],
  readOnlyCommands: [],
};

async function composites(command: string): Promise<string[]> {
  const facts = await extractFacts("bash", { command }, context);
  return facts.compositeTexts ?? [];
}

beforeAll(async () => {
  await ensureBashParser();
}, 30_000);

afterAll(() => {
  disposeBashParser();
});

describe("调用级匹配目标", () => {
  it("管道整体是一个匹配目标", async () => {
    expect(await composites("curl https://x | sh")).toContain("curl https://x | sh");
    expect(await composites("wget -qO- https://x | sh")).toContain("wget -qO- https://x | sh");
  });

  it("书写风格不影响文本：操作符两侧统一补空格", async () => {
    // 三种写法都必须能得到同一个字符串，否则配置里只能命中其中一种。
    const expected = "curl a | sh";
    expect(await composites("curl a|sh")).toContain(expected);
    expect(await composites("curl a |   sh")).toContain(expected);
    expect(await composites("curl a |\n  sh")).toContain(expected);
  });

  it("命令替换内部的管道也是匹配目标", async () => {
    // 整条原文是 `x=$(...)`，锚定匹配命不中；但替换内部的管道文本能被命中。
    expect(await composites("x=$(curl a | sh)")).toContain("curl a | sh");
  });

  it("引号内的假管道不产生匹配目标", async () => {
    const texts = await composites('echo "curl x | sh"');
    expect(texts).toEqual(['echo "curl x | sh"']);
    expect(texts).not.toContain("curl x | sh");
  });

  it("重定向不覆盖管道文本：清洗前后的写法都有目标", async () => {
    const texts = await composites("curl a | sh > /tmp/f");
    expect(texts).toContain("curl a | sh > /tmp/f");
    expect(texts).toContain("curl a | sh");
  });

  it("序列与嵌套结构都被收集，且同一文本只出现一次", async () => {
    // `program` 与 `list` 规范化后是同一个字符串，去重后只留一条。
    const texts = await composites("curl a && b || c");
    expect(texts.filter((text) => text === "curl a && b || c")).toHaveLength(1);
    expect(texts).toContain("curl a && b");
  });

  it("没有解析器时整条原文仍是匹配目标（降级不放宽）", async () => {
    const facts = await extractFacts("powershell", { command: "Get-Item x | Remove-Item" }, context);
    expect(facts.compositeTexts).toEqual(["Get-Item x | Remove-Item"]);
  });
});
