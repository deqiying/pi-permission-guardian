import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureBashParser, disposeBashParser } from "../../src/facts/bash/parser.ts";
import { extractFacts } from "../../src/facts/extract.ts";
import type { FactsContext } from "../../src/facts/types.ts";

/**
 * 语料驱动测试（architecture §11 的 M2 门禁）。
 *
 * 每条语料都断言五件事：命令单元拆分、路径目标与读写方向、包装器标记、
 * unresolved 状态、只读判定。语料覆盖 architecture §11 列出的构造：
 * 单命令、管道、`&&`/`||`/`;`、`$()`、反引号、`<()`、`>()`、子 shell、heredoc、
 * 输入/输出/读写重定向、`<>`、`sudo`、`xargs`、`bash -c`、`sh -c`、`eval`、
 * 变量拼接、动态展开、未闭合引号、语法错误、Windows 盘符、正/反斜杠、MSYS 路径。
 *
 * 语料期望是**人工逐条审阅**过的：它记录的是"我们承诺的行为"，不是"当前实现碰巧的输出"。
 * 因此这里不做快照，而是逐字段比对，行为变化必须显式改这个文件。
 */

interface CorpusCase {
  units?: string[];
  unresolved?: string;
  unresolvedUnits?: number[];
  wrappers?: Record<string, "opaque" | "indirection">;
  /** 透明前缀内推（FR-12 修订）：下标 → 内层命令文本。 */
  unwrapped?: Record<string, string>;
  readOnly?: number[];
  paths?: string[];
}

interface CorpusFile {
  context: FactsContext;
  cases: Record<string, CorpusCase>;
}

const fixturesDir = fileURLToPath(new URL("../fixtures/bash/", import.meta.url));
const corpus = JSON.parse(
  readFileSync(`${fixturesDir}corpus.json`, "utf8"),
) as CorpusFile & { multiLineCases: Record<string, CorpusCase> };

/**
 * 多行命令（heredoc）无法用 corpus.txt 的"一行一条"表达，单独放在 `multiLineCases` 里。
 * 两份语料都会逐条断言；`cases` 的键必须与 corpus.txt 完全对应。
 */
const allCases: Array<[string, CorpusCase]> = [
  ...Object.entries(corpus.cases),
  ...Object.entries(corpus.multiLineCases),
];
const corpusLines = readFileSync(`${fixturesDir}corpus.txt`, "utf8")
  .split("\n")
  .map((line) => line.trimEnd())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

// WASM 首次加载在并行 worker 里可能超过默认 5s hook 超时，显式放宽。
beforeAll(async () => {
  await ensureBashParser();
}, 30_000);

afterAll(() => {
  disposeBashParser();
});

describe("bash 语料：断言与语料文件同步", () => {
  it("corpus.txt 的每一条都在 corpus.json 里有断言", () => {
    const missing = corpusLines.filter((line) => corpus.cases[line] === undefined);
    expect(missing).toEqual([]);
  });

  it("语料条数符合预期（防止文件被意外截断）", () => {
    expect(corpusLines.length).toBeGreaterThanOrEqual(90);
    expect(Object.keys(corpus.cases).length).toBeGreaterThanOrEqual(90);
    expect(Object.keys(corpus.multiLineCases).length).toBeGreaterThanOrEqual(4);
  });

  it("多行语料真的都是多行（否则它们应该放进 corpus.txt）", () => {
    for (const key of Object.keys(corpus.multiLineCases)) {
      expect(key).toContain("\n");
    }
  });
});

describe("bash 语料：逐条 facts 断言", () => {
  for (const [command, expected] of allCases) {
    it(JSON.stringify(command), async () => {
      const facts = await extractFacts("bash", { command }, corpus.context);

      expect(facts.commands.map((unit) => unit.text)).toEqual(expected.units ?? []);
      expect(facts.unresolved ?? null).toBe(expected.unresolved ?? null);

      const unresolvedUnits = facts.commands
        .map((unit, index) => (unit.unresolved === undefined ? -1 : index))
        .filter((index) => index >= 0);
      expect(unresolvedUnits).toEqual(expected.unresolvedUnits ?? []);

      const wrappers: Record<string, string> = {};
      facts.commands.forEach((unit, index) => {
        if (unit.viaWrapper !== undefined) {
          wrappers[String(index)] = unit.viaWrapper;
        }
      });
      expect(wrappers).toEqual(expected.wrappers ?? {});

      const unwrapped: Record<string, string> = {};
      facts.commands.forEach((unit, index) => {
        if (unit.unwrappedText !== undefined) {
          unwrapped[String(index)] = unit.unwrappedText;
        }
      });
      expect(unwrapped).toEqual(expected.unwrapped ?? {});

      const readOnly = facts.commands
        .map((unit, index) => (unit.readOnly ? index : -1))
        .filter((index) => index >= 0);
      expect(readOnly).toEqual(expected.readOnly ?? []);

      const paths = facts.commands.flatMap((unit) =>
        unit.paths.map((path) => `${path.direction}:${path.raw}`),
      );
      expect(paths).toEqual(expected.paths ?? []);

      // never-weaker：解析没读懂时，这条命令必须至少留下一个保守对象或降级标记。
      // （`2>&1` 这类没有可报告内容的语句例外：它不会执行任何命令、也不碰任何文件。）
      const reportable = facts.commands.length > 0 || facts.unresolved !== undefined;
      if (command.trim().length > 0 && !/^\d*[<>]&\d+$/.test(command.trim())) {
        expect(reportable).toBe(true);
      }
    });
  }
});

/**
 * 故意写坏的命令（语法错、未闭合）：这些必须降级，且**所有**单元都不可信。
 * 这是 never-weaker 的真实断言——不能写成"语料期望里有 units 所以应该有 units"那种循环。
 */
const MALFORMED = ['echo "unclosed', "(()", "if true"];

describe("bash 语料：语法坏掉的命令必须降级", () => {
  for (const command of MALFORMED) {
    it(JSON.stringify(command), async () => {
      const facts = await extractFacts("bash", { command }, corpus.context);
      expect(facts.unresolved).toBe("parse-error");
      expect(facts.commands.length).toBeGreaterThan(0);
      expect(facts.commands.every((unit) => unit.unresolved === "parse-error")).toBe(true);
      // 解析没读懂时，"命中只读白名单"不能作为放行依据。
      expect(facts.commands.some((unit) => unit.readOnly)).toBe(false);
    });
  }
});

describe("bash 语料：路径归一与外部目录判定", () => {
  it("相对路径按 cwd 展开，外部目录被标记", async () => {
    const facts = await extractFacts("bash", { command: "rm ../outside/x" }, corpus.context);
    const path = facts.commands[0]?.paths[0];
    expect(path?.lexical).toBe("/proj/outside/x");
    expect(path?.external).toBe(true);
  });

  it("工作目录内的路径不算外部目录", async () => {
    const facts = await extractFacts("bash", { command: "rm ./x/y" }, corpus.context);
    const path = facts.commands[0]?.paths[0];
    expect(path?.lexical).toBe("/proj/app/x/y");
    expect(path?.external).toBe(false);
  });

  it("`~` 展开到家目录，并因此落在外部目录", async () => {
    const facts = await extractFacts("bash", { command: "cat ~/x" }, corpus.context);
    const path = facts.commands[0]?.paths[0];
    expect(path?.lexical).toBe("/home/u/x");
    expect(path?.external).toBe(true);
  });

  it("外部目录 surface 只对确实在根目录之外的路径出现", async () => {
    const inside = await extractFacts("bash", { command: "cat ./x" }, corpus.context);
    expect(inside.surfaces).not.toContain("external_directory_read");

    const outside = await extractFacts("bash", { command: "cat ../x" }, corpus.context);
    expect(outside.surfaces).toContain("external_directory_read");
  });
});

describe("bash 语料：platform 语义与宿主无关", () => {
  const WINDOWS = {
    cwd: "D:\\proj\\app",
    platform: "win32" as const,
    home: "C:\\Users\\u",
    roots: ["D:\\proj\\app"],
    readOnlyCommands: [] as string[],
  };

  it("MSYS 形式的 `/c/...` 在 Windows 语义下归一为盘符路径", async () => {
    // git-bash 下 `/c/Users/x` 就是 `C:\\Users\\x`：不归一就会变成拼在 cwd 下的假路径，
    // 用户针对 `C:\\Users\\**` 写的规则会静默失效。
    const facts = await extractFacts("bash", { command: "rm /c/Users/x/f.txt" }, WINDOWS);
    const path = facts.commands[0]?.paths[0];
    expect(path?.raw).toBe("/c/Users/x/f.txt");
    expect(path?.lexical).toBe("C:\\Users\\x\\f.txt");
    expect(path?.external).toBe(true);
  });

  it("Windows 语义下盘符路径被识别并归一", async () => {
    const facts = await extractFacts(
      "bash",
      { command: "rm -rf C:/Users/x/f.txt" },
      {
        cwd: "D:\\proj\\app",
        platform: "win32",
        home: "C:\\Users\\u",
        roots: ["D:\\proj\\app"],
        readOnlyCommands: [],
      },
    );
    const path = facts.commands[0]?.paths[0];
    expect(path?.raw).toBe("C:/Users/x/f.txt");
    expect(path?.lexical).toBe("C:\\Users\\x\\f.txt");
    expect(path?.external).toBe(true);
  });
});
