import { describe, expect, it } from "vitest";

import { expandReadOnly } from "../../src/config/readonly.ts";
import { guardianConfigSchema } from "../../src/config/schema.ts";
import { resolveConfig } from "../support/resolved-config.ts";

/**
 * 只读档案的展开与跨层合并（FR-65~FR-67）。
 *
 * 展开顺序是**契约的一部分**：用户条目 → 内置分组 → 旧字符串条目，
 * 因为事实层“第一个命中的档案生效”，顺序错了用户就压不住内置档案。
 */

function workingDirectoryOf(
  workingDirectory: Record<string, unknown>,
): ReturnType<typeof guardianConfigSchema.parse>["workingDirectory"] {
  return guardianConfigSchema.parse({ workingDirectory }).workingDirectory;
}

describe("expandReadOnly：展开顺序与来源", () => {
  it("顺序为用户条目 → 内置分组 → 旧字符串条目", () => {
    const expanded = expandReadOnly(
      workingDirectoryOf({
        readOnlyCommands: ["cat"],
        readOnly: { profiles: ["search"], commands: [{ argv: ["rg"], unsafeOptions: ["--pre"] }] },
      }),
    );

    const sources = expanded.profiles.map((profile) => ({
      key: profile.argv.join(" "),
      group: profile.group,
    }));
    expect(sources[0]).toEqual({ key: "rg", group: "user" });
    expect(sources.some((entry) => entry.group === "search")).toBe(true);
    expect(sources[sources.length - 1]).toEqual({ key: "cat", group: "readOnlyCommands" });
  });

  it("字符串条目等价于“全部位置参数都是路径”的档案", () => {
    const expanded = expandReadOnly(
      workingDirectoryOf({ readOnly: { profiles: [] }, readOnlyCommands: ["git status"] }),
    );

    expect(expanded.profiles).toEqual([
      {
        argv: ["git", "status"],
        roles: ["paths"],
        group: "readOnlyCommands",
        reason: "来自 workingDirectory.readOnlyCommands（字符串条目）。",
      },
    ]);
  });

  it("全局 unsafeOptions 追加到每一条档案（含内置与旧条目），只收紧", () => {
    const expanded = expandReadOnly(
      workingDirectoryOf({
        readOnly: { profiles: ["search"], unsafeOptions: ["-i"] },
        readOnlyCommands: ["cat"],
      }),
    );

    for (const profile of expanded.profiles) {
      expect(profile.unsafeOptions).toContain("-i");
    }
    // 内置的 unsafeOptions 不能被全局列表覆盖掉。
    const rg = expanded.profiles.find((profile) => profile.argv.join(" ") === "rg");
    expect(rg?.unsafeOptions).toEqual(["--pre", "--hostname-bin", "-i"]);
  });

  it("sinks 只带用户追加项：内置空设备由事实层按平台补充", () => {
    const expanded = expandReadOnly(
      workingDirectoryOf({ readOnly: { profiles: [], sinks: ["/dev/fd/3"] } }),
    );
    expect(expanded.writeSinks).toEqual(["/dev/fd/3"]);
  });

  it("关闭全部分组后不再有内置档案，只剩用户与旧条目", () => {
    const expanded = expandReadOnly(
      workingDirectoryOf({ readOnly: { profiles: [] }, readOnlyCommands: ["pwd"] }),
    );
    expect(expanded.profiles.map((profile) => profile.group)).toEqual(["readOnlyCommands"]);
  });

  it("内置分组的每条档案都带 reason（可审计、可复核）", () => {
    const expanded = expandReadOnly(
      workingDirectoryOf({
        readOnly: {
          profiles: [
            "search",
            "vcs-read",
            "nav",
            "text-read",
            "text-tools",
            "meta",
            "system",
          ],
        },
      }),
    );

    expect(expanded.profiles.length).toBeGreaterThan(20);
    for (const profile of expanded.profiles) {
      expect(profile.reason?.length ?? 0).toBeGreaterThan(0);
      expect(profile.group).not.toBe("user");
    }
  });
});

describe("跨层合并：白名单按项目层覆盖，收紧类名单只收紧（FR-65）", () => {
  it("profiles 与 commands 由更具体的层覆盖", () => {
    const config = resolveConfig({
      global: { workingDirectory: { readOnly: { profiles: ["search", "vcs-read"] } } },
      project: { workingDirectory: { readOnly: { profiles: [] } } },
    });

    expect(config.workingDirectory.readOnly.profiles).toEqual([]);
    // 关掉的只是内置分组；旧字符串白名单仍然生效（它有自己的开关）。
    expect(config.readOnlyProfiles.every((profile) => profile.group === "readOnlyCommands")).toBe(
      true,
    );
  });

  it("unsafeOptions 取各层并集：任一层写过的黑名单条目都生效", () => {
    const config = resolveConfig({
      global: { workingDirectory: { readOnly: { unsafeOptions: ["-i"] } } },
      project: { workingDirectory: { readOnly: { unsafeOptions: ["--pre"] } } },
    });

    expect(config.workingDirectory.readOnly.unsafeOptions.sort()).toEqual(["--pre", "-i"].sort());
    // 并集真的作用到了内置档案上（否则下层可以靠“没写这一条”绕开全局黑名单）。
    const rg = config.readOnlyProfiles.find((profile) => profile.argv.join(" ") === "rg");
    expect(rg?.unsafeOptions).toContain("--pre");
    expect(rg?.unsafeOptions).toContain("-i");
  });

  it("sinks 取各层交集：追加 sink 等于放宽，不能让下层单方面扩大", () => {
    const config = resolveConfig({
      global: { workingDirectory: { readOnly: { sinks: ["/dev/null", "/dev/fd/3"] } } },
      project: { workingDirectory: { readOnly: { sinks: ["/dev/fd/3"] } } },
    });

    expect(config.workingDirectory.readOnly.sinks).toEqual(["/dev/fd/3"]);
  });

  it("只有一层写 sinks 时用该层（未表态的层不投票）", () => {
    const config = resolveConfig({
      project: { workingDirectory: { readOnly: { sinks: ["/dev/fd/7"] } } },
    });

    expect(config.workingDirectory.readOnly.sinks).toEqual(["/dev/fd/7"]);
  });

  it("配置失效时只读档案仍然可用（事实层不需要配置内容）", () => {
    const config = resolveConfig({ globalStatus: "invalid" });

    expect(config.readOnlyProfiles.length).toBeGreaterThan(0);
    expect(config.writeSinks).toEqual([]);
  });
});
