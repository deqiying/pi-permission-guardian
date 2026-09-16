import { describe, expect, it } from "vitest";

import {
  isReadOnlyUnit,
  matchReadOnlyCommands,
  matchesReadOnlyPrefix,
} from "../../../src/facts/bash/readonly-commands.ts";
import { makePathTarget } from "../../../src/facts/path-value.ts";

const DEFAULT_WHITELIST = [
  "pwd",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "git status",
  "git diff",
  "git log",
  "git show",
];

const pathOptions = {
  cwd: "/proj/app",
  platform: "linux" as NodeJS.Platform,
  home: "/home/u",
  roots: ["/proj/app"],
};

describe("matchesReadOnlyPrefix：固定为 argv 前缀匹配", () => {
  it("单命令命中带参数的调用", () => {
    expect(matchesReadOnlyPrefix("cat", ["cat", "file.txt"])).toBe(true);
    expect(matchesReadOnlyPrefix("cat", ["cat"])).toBe(true);
  });

  it("多词条目命中带子命令与选项的调用", () => {
    expect(matchesReadOnlyPrefix("git status", ["git", "status", "--short"])).toBe(true);
    expect(matchesReadOnlyPrefix("git diff", ["git", "diff", "HEAD~1"])).toBe(true);
  });

  it("不同子命令不命中", () => {
    expect(matchesReadOnlyPrefix("git status", ["git", "push"])).toBe(false);
    expect(matchesReadOnlyPrefix("git diff", ["git", "clean", "-fd"])).toBe(false);
  });

  it("只写了前缀的一部分时不命中", () => {
    expect(matchesReadOnlyPrefix("git status", ["git"])).toBe(false);
    expect(matchesReadOnlyPrefix("cat", [])).toBe(false);
  });

  it("argv 更长时不算越界命中（`git statusx` 不等于 `git status`）", () => {
    expect(matchesReadOnlyPrefix("git status", ["git", "statusx"])).toBe(false);
  });

  it("大小写敏感：匹配不上只会变严，不会多放行", () => {
    expect(matchesReadOnlyPrefix("cat", ["Cat", "x"])).toBe(false);
  });
});

describe("matchReadOnlyCommands", () => {
  it("返回命中的条目，便于日志与审计", () => {
    expect(matchReadOnlyCommands(["git", "log", "-n", "5"], DEFAULT_WHITELIST)).toBe("git log");
    expect(matchReadOnlyCommands(["rm", "-rf", "/"], DEFAULT_WHITELIST)).toBeUndefined();
  });

  it("白名单为空时永不命中（配置 [] 可关闭）", () => {
    expect(matchReadOnlyCommands(["cat", "x"], [])).toBeUndefined();
  });
});

describe("isReadOnlyUnit：只读还需要没有写副作用、单元可信、没有带路径值的选项", () => {
  const base = { matchedEntry: "cat" as string | undefined, pathValuedOption: false };

  it("命中白名单且全是读路径时为真", () => {
    const paths = [makePathTarget("a.txt", "read", "arg", pathOptions)];
    expect(isReadOnlyUnit({ ...base, paths })).toBe(true);
  });

  it("有写路径时为假（`cat > out.txt`）", () => {
    const paths = [makePathTarget("out.txt", "write", "redirect", pathOptions)];
    expect(isReadOnlyUnit({ ...base, paths })).toBe(false);
  });

  it("单元不可信时为假（`cat $f` 不能因为 cat 在白名单里就放行）", () => {
    const paths = [makePathTarget("$f", "read", "arg", pathOptions)];
    expect(isReadOnlyUnit({ ...base, paths, unresolved: "dynamic-path" })).toBe(false);
  });

  it("带路径值的选项时为假（`git diff --output=.env` 会真的写文件）", () => {
    const paths = [makePathTarget(".env", "read", "arg", pathOptions)];
    expect(
      isReadOnlyUnit({ matchedEntry: "git diff", paths, pathValuedOption: true }),
    ).toBe(false);
  });

  it("没有路径值的选项不影响（`git status --short`）", () => {
    expect(isReadOnlyUnit({ matchedEntry: "git status", paths: [], pathValuedOption: false })).toBe(
      true,
    );
  });

  it("没命中白名单时为假", () => {
    expect(isReadOnlyUnit({ matchedEntry: undefined, paths: [], pathValuedOption: false })).toBe(
      false,
    );
  });
});
