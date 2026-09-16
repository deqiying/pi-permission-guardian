import { describe, expect, it } from "vitest";

import type { CommandUnit, Facts, PathTarget } from "../../src/facts/types.ts";
import { buildPolicyObjects, type PolicyObject } from "../../src/policy/evaluate.ts";
import { compileGlob } from "../../src/policy/glob.ts";
import {
  decodeGrantKey,
  encodeGrantKey,
  formatGrantKey,
  grantKeysForObjects,
  isCallGranted,
  suggestGrantKey,
} from "../../src/policy/session-grants.ts";

/**
 * 会话授权（FR-29/30）。
 *
 * 重点是建议模式的作用域：`text + " *"` 必须只覆盖"同一条命令（可带追加参数）"，
 * 不能因为追加了一个 `*` 就把 `sh` 批准成 `shutdown`。
 */

const GLOB = { home: "/home/u", platform: "linux" as NodeJS.Platform };

function unit(text: string, extra: Partial<CommandUnit> = {}): CommandUnit {
  return { text, paths: [], readOnly: false, ...extra };
}

function target(
  lexical: string,
  direction: PathTarget["direction"] = "read",
): PathTarget {
  return { raw: lexical, lexical, direction, source: "arg", external: false };
}

function commandObjects(...texts: string[]): PolicyObject[] {
  const facts: Facts = {
    surfaces: ["bash"],
    commands: texts.map((text) => unit(text)),
    paths: [],
  };
  return buildPolicyObjects(facts, "bash");
}

function pathObjects(path: PathTarget): PolicyObject[] {
  return buildPolicyObjects({ surfaces: ["read"], commands: [], paths: [path] }, "read");
}

describe("授权键生成（FR-30）", () => {
  it("命令对象的建议模式是「命令文本 + 空格 *」", () => {
    const key = suggestGrantKey(commandObjects("rm -rf ./dist")[0] as PolicyObject);

    expect(key).toEqual({ surface: "bash", pattern: "rm -rf ./dist *" });
  });

  it("建议模式匹配同一条命令与追加参数，但不跨到其他命令", () => {
    const key = suggestGrantKey(commandObjects("rm -rf ./dist")[0] as PolicyObject);
    const match = compileGlob(key.pattern, GLOB);

    expect(match("rm -rf ./dist")).toBe(true);
    expect(match("rm -rf ./dist --force")).toBe(true);
    expect(match("rm -rf ./dist2")).toBe(false);
  });

  it("短命令名的建议模式不会泄漏到同前缀的其他命令", () => {
    const key = suggestGrantKey(commandObjects("sh")[0] as PolicyObject);
    const match = compileGlob(key.pattern, GLOB);

    expect(match("sh")).toBe(true);
    expect(match("sh -c 'echo x'")).toBe(true);
    expect(match("shutdown -h now")).toBe(false);
    expect(match("shred -u secret")).toBe(false);
  });

  it("路径对象的建议模式带方向面", () => {
    const object = pathObjects(target("/repo/notes.md"))[1] as PolicyObject;

    expect(suggestGrantKey(object)).toEqual({
      surface: "path_read",
      pattern: "/repo/notes.md *",
      direction: "read",
    });
  });

  it("同一次调用里的对象去重后按编码键唯一", () => {
    const keys = grantKeysForObjects(commandObjects("echo a", "echo a"));

    expect(keys).toHaveLength(1);
  });

  it("编码 / 解码 / 展示往返一致，畸形键不再解码", () => {
    const key = { surface: "bash", pattern: "rm -rf ./dist *" };

    expect(decodeGrantKey(encodeGrantKey(key))).toEqual(key);
    expect(formatGrantKey(encodeGrantKey(key))).toBe("bash：rm -rf ./dist *");
    expect(decodeGrantKey("no-separator")).toBeUndefined();
    expect(decodeGrantKey("bash\u0000")).toBeUndefined();
    expect(formatGrantKey("no-separator")).toBe("no-separator");
  });
});

describe("授权匹配（FR-29）", () => {
  it("覆盖同一条命令的再次调用", () => {
    const object = commandObjects("rm -rf ./dist")[0] as PolicyObject;
    const granted = grantKeysForObjects([object]).map((key) => encodeGrantKey(key));

    expect(isCallGranted([object], granted, GLOB)).toBe(true);
  });

  it("不覆盖同前缀的其他命令", () => {
    const grantedObject = commandObjects("sh")[0] as PolicyObject;
    const laterCall = commandObjects("shutdown -h now")[0] as PolicyObject;
    const granted = grantKeysForObjects([grantedObject]).map((key) => encodeGrantKey(key));

    expect(isCallGranted([laterCall], granted, GLOB)).toBe(false);
  });

  it("必须覆盖调用里的每个对象", () => {
    const grantedObject = commandObjects("echo a")[0] as PolicyObject;
    const granted = grantKeysForObjects([grantedObject]).map((key) => encodeGrantKey(key));
    const both = commandObjects("echo a", "echo b");

    expect(isCallGranted([both[0] as PolicyObject], granted, GLOB)).toBe(true);
    expect(isCallGranted(both, granted, GLOB)).toBe(false);
  });

  it("路径对象按方向面匹配", () => {
    const object = pathObjects(target("/repo/notes.md"))[1] as PolicyObject;
    const granted = grantKeysForObjects([object]).map((key) => encodeGrantKey(key));

    expect(isCallGranted([object], granted, GLOB)).toBe(true);

    const writeVersion = pathObjects(target("/repo/notes.md", "write"))[1] as PolicyObject;
    expect(isCallGranted([writeVersion], granted, GLOB)).toBe(false);
  });

  it("`*` 是合法授权面，可覆盖该调用任何对象", () => {
    const object = commandObjects("npm publish")[0] as PolicyObject;
    const granted = [encodeGrantKey({ surface: "*", pattern: "npm publish *" })];

    expect(isCallGranted([object], granted, GLOB)).toBe(true);
  });

  it("空对象集合与空授权集合都不算命中", () => {
    const object = commandObjects("echo a")[0] as PolicyObject;

    expect(isCallGranted([], [], GLOB)).toBe(false);
    expect(isCallGranted([object], [], GLOB)).toBe(false);
    expect(isCallGranted([object], ["broken-key"], GLOB)).toBe(false);
  });
});
