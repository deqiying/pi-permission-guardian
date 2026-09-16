import { describe, expect, it } from "vitest";

import {
  BUILTIN_TOOLS,
  collectSurfaces,
  isBuiltinTool,
  pathSurfaces,
  toolSurface,
} from "../../src/facts/classify.ts";
import { makePathTarget } from "../../src/facts/path-value.ts";

const LINUX = {
  cwd: "/proj/app",
  platform: "linux" as NodeJS.Platform,
  home: "/home/u",
  roots: ["/proj/app"],
};

function target(raw: string, direction: "read" | "write") {
  return makePathTarget(raw, direction, "tool-input", LINUX);
}

describe("classify：工具到 surface 的映射", () => {
  it("内置工具各占一个面", () => {
    expect(toolSurface("read")).toBe("read");
    expect(toolSurface("bash")).toBe("bash");
    expect(toolSurface("powershell")).toBe("powershell");
  });

  it("未知工具用工具名本身作为面（catchall）", () => {
    expect(toolSurface("mcp__fs__write")).toBe("mcp__fs__write");
    expect(isBuiltinTool("mcp__fs__write")).toBe(false);
  });

  it("内置工具清单覆盖 gate=side-effect 的默认集合", () => {
    expect([...BUILTIN_TOOLS].sort()).toEqual(
      ["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"].sort(),
    );
  });
});

describe("classify：路径派生 surface", () => {
  it("读路径只产生 path_read，不产生 path_write", () => {
    expect(pathSurfaces([target("./x", "read")])).toEqual(["path_read"]);
  });

  it("外部目录 surface 只对根目录之外的路径出现", () => {
    expect(pathSurfaces([target("./x", "read")])).not.toContain("external_directory_read");
    expect(pathSurfaces([target("../x", "read")])).toContain("external_directory_read");
    expect(pathSurfaces([target("/etc/x", "write")])).toContain("external_directory_write");
  });

  it("两个方向的路径同时存在时两个面都出现，且顺序稳定", () => {
    const surfaces = pathSurfaces([target("./a", "read"), target("./b", "write")]);
    expect(surfaces).toEqual(["path_read", "path_write"]);
  });

  it("收集结果里工具面在最前，重复面被去掉", () => {
    expect(collectSurfaces("read", [target("./a", "read")])).toEqual(["read", "path_read"]);
    expect(collectSurfaces("bash", [])).toEqual(["bash"]);
  });
});
