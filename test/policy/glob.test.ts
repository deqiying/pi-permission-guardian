import { describe, expect, it } from "vitest";

import { compileGlob, globToRegExpSource } from "../../src/policy/glob.ts";

const POSIX = { home: "/home/u", platform: "linux" as NodeJS.Platform };
const WINDOWS = { home: "C:\\Users\\u", platform: "win32" as NodeJS.Platform };

describe("glob 语义（FR-4、architecture §6.3）", () => {
  it("`*` 跨路径分隔符，`**` 不特殊", () => {
    const match = compileGlob("*.env", POSIX);

    expect(match("/repo/.env")).toBe(true);
    expect(match("a/b/c/.env")).toBe(true);

    const starStar = compileGlob("a/**/b", POSIX);
    // `**` 与 `*` 等价，中间的 `/` 必须字面出现："a//b" 才匹配。
    expect(starStar("a/x/y/b")).toBe(true);
    expect(starStar("a/b")).toBe(false);
    expect(starStar("a//b")).toBe(true);
  });

  it("`?` 匹配单字符", () => {
    const match = compileGlob("a?b", POSIX);

    expect(match("aXb")).toBe(true);
    expect(match("a b")).toBe(true);
    expect(match("aXYb")).toBe(false);
    // `?` 也跨分隔符（与 `*` 一致：不做路径语义）。
    expect(match("a/b")).toBe(true);
  });

  it("整体锚定：模式必须完整覆盖取值", () => {
    const match = compileGlob("rm", POSIX);

    expect(match("rm")).toBe(true);
    expect(match("rm -rf /")).toBe(false);
    expect(match("xrm")).toBe(false);
  });

  it("末尾 ` *` 让空格 + 参数整体可选（FR-4 的裸命令用例）", () => {
    const match = compileGlob("git *", POSIX);

    expect(match("git")).toBe(true);
    expect(match("git status --short")).toBe(true);
    expect(match("github")).toBe(false);
    expect(match("gitz")).toBe(false);
  });

  it("末尾 ` *` 不跨到同前缀的其他命令（授权建议模式依赖这一点，FR-30）", () => {
    const match = compileGlob("sh *", POSIX);

    expect(match("sh")).toBe(true);
    expect(match("sh -c echo")).toBe(true);
    expect(match("shutdown -h now")).toBe(false);
  });

  it("正则元字符按字面处理", () => {
    const match = compileGlob("a.b+c", POSIX);

    expect(match("a.b+c")).toBe(true);
    expect(match("axbbc")).toBe(false);
  });

  it("展开 `~/`、`$HOME/`、`${HOME}/` 开头的模式", () => {
    expect(compileGlob("~/.ssh/*", POSIX)("/home/u/.ssh/id_rsa")).toBe(true);
    expect(compileGlob("$HOME/.env", POSIX)("/home/u/.env")).toBe(true);
    expect(compileGlob("${HOME}/.env", POSIX)("/home/u/.env")).toBe(true);
    expect(compileGlob("~", POSIX)("/home/u")).toBe(true);
    // 非开头的 `~` 不展开（事实层同样只展开路径开头的写法）。
    expect(compileGlob("a/~/b", POSIX)("a/~/b")).toBe(true);
  });

  it("Windows 下双侧折叠：大小写不敏感 + 分隔符归一", () => {
    expect(compileGlob("C:\\Users\\*", WINDOWS)("c:/users/x")).toBe(true);
    expect(compileGlob("*.ENV", WINDOWS)("C:\\repo\\.env")).toBe(true);
    expect(compileGlob("~/.ssh/*", WINDOWS)("c:\\users\\u\\.ssh\\id_rsa")).toBe(true);
  });

  it("POSIX 保持大小写敏感", () => {
    expect(compileGlob("*.ENV", POSIX)("/repo/.env")).toBe(false);
    expect(compileGlob("*.env", POSIX)("/repo/.env")).toBe(true);
  });

  it("`globToRegExpSource` 给出可断言的锚定正则", () => {
    expect(globToRegExpSource("git *")).toBe("^git(?: .*)?$");
    expect(globToRegExpSource("*")).toBe("^.*$");
    expect(globToRegExpSource("a.b")).toBe("^a\\.b$");
    expect(globToRegExpSource("rm -rf /")).toBe("^rm -rf /$");
  });

  it("`if` 这类多行命令文本可以整体匹配（`.*` 跨行）", () => {
    const match = compileGlob("if *", POSIX);

    expect(match("if true\nthen rm -rf /\nfi")).toBe(true);
  });
});
