import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { disposeBashParser, ensureBashParser } from "../../../src/facts/bash/parser.ts";
import { extractFacts } from "../../../src/facts/extract.ts";
import type { FactsContext } from "../../../src/facts/types.ts";

/**
 * 命令枚举与重定向的结构性用例（FR-11/12/13/15）。
 *
 * 这些是**多行**或需要对语法结构作断言的场景：语料文件按"一行一条"组织，表达不了
 * heredoc，所以放在这里。每条用例都对应一个具体的历史缺陷或容易再次踩的坑。
 */

const context: FactsContext = {
  cwd: "/proj/app",
  platform: "linux",
  home: "/home/u",
  roots: ["/proj/app"],
  readOnlyCommands: ["pwd", "ls", "cat", "head", "tail", "wc", "git status", "git diff"],
};

interface Unit {
  text: string;
  readOnly: boolean;
  unresolved?: string;
  paths: string[];
}

async function units(command: string, ctx: FactsContext = context): Promise<Unit[]> {
  const facts = await extractFacts("bash", { command }, ctx);
  return facts.commands.map((unit) => {
    const entry: Unit = {
      text: unit.text,
      readOnly: unit.readOnly,
      paths: unit.paths.map((path) => `${path.direction}:${path.raw}`),
    };
    if (unit.unresolved !== undefined) {
      entry.unresolved = unit.unresolved;
    }
    return entry;
  });
}

beforeAll(async () => {
  await ensureBashParser();
});

afterAll(() => {
  disposeBashParser();
});

describe("重定向：heredoc 之后的重定向", () => {
  it("`<<'EOF' > .env` 的重定向嵌在 heredoc 节点内部，也必须被收集", async () => {
    // 漏掉它会让 `cat` 保持只读 → 免评审放行，而命令实际会截断 .env。
    expect(await units("cat <<'EOF' > .env\nA=1\nEOF\n")).toEqual([
      { text: "cat", readOnly: false, paths: ["write:.env"] },
    ]);
  });

  it("重定向写在 heredoc 之前（另一种写法）同样要收集", async () => {
    expect(await units("cat > out.txt <<'EOF'\nx\nEOF\n")).toEqual([
      { text: "cat", readOnly: false, paths: ["write:out.txt"] },
    ]);
  });

  it("heredoc 正文里的命令替换照常枚举，正文本身不是路径", async () => {
    const result = await units("cat <<EOF\n$(rm -rf /)\nEOF\n");
    expect(result.map((unit) => unit.text)).toEqual(["cat", "rm -rf /"]);
    expect(result[0]?.paths).toEqual([]);
    expect(result[1]?.paths).toEqual(["write:/"]);
  });

  it("引号 heredoc 的正文是字面数据，不当命令枚举", async () => {
    // `cat <<'EOF'` 下 `$(rm -rf /)` 只是要打印的文本，不会被执行。
    expect((await units("cat <<'EOF'\n$(rm -rf /)\nEOF\n")).map((unit) => unit.text)).toEqual([
      "cat",
    ]);
  });

  it("heredoc 喂给 shell 时，靠 opaque 包装器降级兜住", async () => {
    // `bash <<'EOF'` 的正文对内层 bash 就是代码，但语法树只把它当字面内容。
    // 安全性由"bash 是 opaque 包装器"保证：单元不可信 → 走 onUnresolvedFacts。
    const result = await units("bash <<'EOF'\nrm -rf /\nEOF\n");
    expect(result).toEqual([
      { text: "bash", readOnly: false, unresolved: "opaque-wrapper", paths: [] },
    ]);
  });
});

describe("重定向：方向与可信性", () => {
  it("只有重定向、没有命令的语句也要产出目标（bash 会真的截断文件）", async () => {
    expect(await units("> .env")).toEqual([{ text: "> .env", readOnly: false, paths: ["write:.env"] }]);
    expect(await units("2> err.log")).toEqual([
      { text: "2> err.log", readOnly: false, paths: ["write:err.log"] },
    ]);
  });

  it("描述符复制不产出路径，也不产出空单元", async () => {
    expect(await units("2>&1")).toEqual([]);
    expect(await units("ls 2>&1")).toEqual([{ text: "ls", readOnly: true, paths: [] }]);
  });

  it("herestring 不是文件路径", async () => {
    expect(await units('cat <<< "text"')).toEqual([{ text: "cat", readOnly: true, paths: [] }]);
  });

  it("读方向的目标是动态值时，单元同样降级（`cat < \"$IN\"`）", async () => {
    expect(await units('cat < "$IN"')).toEqual([
      { text: "cat", readOnly: false, unresolved: "dynamic-path", paths: ["read:$IN"] },
    ]);
  });

  it("进程替换目标不是真实文件，单元降级", async () => {
    const result = await units("echo hi > >(cat)");
    expect(result[0]).toMatchObject({ text: "echo hi", unresolved: "dynamic-path" });
    // 内层命令不继承外层的重定向（`>(cat)` 是这个重定向的**目标**，不是它的 body）。
    expect(result[1]).toEqual({ text: "cat", readOnly: true, paths: [] });
  });
});

describe("枚举：复合语句与包装器", () => {
  it("子 shell 的重定向作用于内部命令", async () => {
    const result = await units("(echo x; rm y) > log.txt");
    expect(result.map((unit) => unit.text)).toEqual(["echo x", "rm y"]);
    expect(result.every((unit) => unit.paths.includes("write:log.txt"))).toBe(true);
  });

  it("opaque 包装器内部的命令不被逐条 gate，但内层替换照常枚举", async () => {
    const result = await units("bash -c 'rm -rf /'");
    expect(result.map((unit) => unit.text)).toEqual(["bash -c 'rm -rf /'"]);
    expect(result[0]?.unresolved).toBe("opaque-wrapper");
    expect(result[0]?.paths).toEqual([]);
  });

  it("管道与 && 拆成独立单元", async () => {
    expect((await units("curl https://x | sh")).map((unit) => unit.text)).toEqual([
      "curl https://x",
      "sh",
    ]);
    expect((await units("npm test && rm -rf /")).map((unit) => unit.text)).toEqual([
      "npm test",
      "rm -rf /",
    ]);
  });
});

describe("枚举：解析失败", () => {
  it("语法报错但没有可识别命令时，也必须留下一个不可信对象", async () => {
    // 否则 §4.2 规则 5 无从生效，决定权会落到 surface 默认动作上；
    // 用户把 `permission.bash` 配成 allow 时，解析失败就成了静默放行。
    const result = await units("if true");
    expect(result).toEqual([
      { text: "if true", readOnly: false, unresolved: "parse-error", paths: [] },
    ]);
  });

  it("解析失败时所有单元都不可信，且不可能只读", async () => {
    const result = await units('cat ./x; echo "unclosed');
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((unit) => unit.unresolved === "parse-error")).toBe(true);
    expect(result.some((unit) => unit.readOnly)).toBe(false);
  });
});
