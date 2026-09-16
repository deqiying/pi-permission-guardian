import { describe, expect, it } from "vitest";

import { expandToken } from "../../../src/facts/bash/expansion.ts";

const options = { home: "/home/u", cwd: "/proj/app" } as const;

function none(text: string) {
  return expandToken(text, { ...options, quoting: "none" });
}

function double(text: string) {
  return expandToken(text, { ...options, quoting: "double" });
}

describe("expandToken：已知展开", () => {
  it("`~` 在词首展开为家目录", () => {
    expect(none("~/x")).toEqual({ text: "/home/u/x", dynamic: false });
    expect(none("~")).toEqual({ text: "/home/u", dynamic: false });
    expect(none("~\\x").text).toBe("/home/u\\x");
  });

  it("`~` 不在词首时不展开（`a~b` 是普通文件名）", () => {
    expect(none("a~b")).toEqual({ text: "a~b", dynamic: false });
  });

  it("`=` 之后的 `~` 仍然展开（`--prefix=~/x`）", () => {
    expect(none("--prefix=~/x")).toEqual({ text: "--prefix=/home/u/x", dynamic: false });
  });

  it("双引号内 `~` 不展开", () => {
    expect(double("~/x")).toEqual({ text: "~/x", dynamic: false });
  });

  it("$HOME / ${HOME} / $PWD 展开", () => {
    expect(none("$HOME/x")).toEqual({ text: "/home/u/x", dynamic: false });
    expect(none("${HOME}/x")).toEqual({ text: "/home/u/x", dynamic: false });
    expect(none("$PWD/x")).toEqual({ text: "/proj/app/x", dynamic: false });
  });

  it("转义后的 `$` 不展开", () => {
    expect(none("\\$HOME/x")).toEqual({ text: "$HOME/x", dynamic: false });
  });
});

describe("expandToken：不可静态确定的部分", () => {
  it("未知变量保持字面并标记动态", () => {
    expect(none("$DIR/x")).toEqual({ text: "$DIR/x", dynamic: true });
    expect(none("${DIR}/x")).toEqual({ text: "${DIR}/x", dynamic: true });
  });

  it("变量默认值、截取等扩展形态不可静态确定", () => {
    expect(none("${DIR:-/tmp}/x").dynamic).toBe(true);
    expect(none("${#DIR}").dynamic).toBe(true);
  });

  it("命令替换与反引号不可静态确定", () => {
    expect(none("$(pwd)/x")).toEqual({ text: "$(pwd)/x", dynamic: true });
    expect(none("`pwd`/x")).toEqual({ text: "`pwd`/x", dynamic: true });
  });

  it("`~user/x` 无法得知 user 的家目录", () => {
    expect(none("~user/x")).toEqual({ text: "~user/x", dynamic: true });
  });
});

describe("expandToken：引号语义", () => {
  it("单引号内一切都不展开", () => {
    const result = expandToken("$HOME/~/x", { ...options, quoting: "single" });
    expect(result).toEqual({ text: "$HOME/~/x", dynamic: false });
  });

  it("双引号内 $HOME 展开、`~` 不展开", () => {
    expect(double("$HOME/~/x")).toEqual({ text: "/home/u/~/x", dynamic: false });
  });
});
