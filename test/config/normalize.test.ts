import { describe, expect, it } from "vitest";

import { guardianConfigSchema } from "../../src/config/schema.ts";
import {
  countRules,
  normalizePermission,
} from "../../src/config/normalize.ts";

function permissionOf(raw: Record<string, unknown>): ReturnType<typeof normalizePermission> {
  const parsed = guardianConfigSchema.parse({ permission: raw });
  return normalizePermission(parsed.permission);
}

describe("规则规范化（FR-3/FR-5）", () => {
  it("语法糖 path / external_directory 展开为读写方向键", () => {
    const surfaces = permissionOf({
      path: { "*.env": "deny" },
      external_directory: { "*": "review" },
    });

    expect([...surfaces.keys()].sort()).toEqual([
      "external_directory_read",
      "external_directory_write",
      "path_read",
      "path_write",
    ]);
    expect(surfaces.get("path_read")).toEqual([
      { pattern: "*.env", action: "deny", index: 0 },
    ]);
    expect(surfaces.get("path_write")).toEqual([
      { pattern: "*.env", action: "deny", index: 0 },
    ]);
  });

  it("面级动作等价于该 surface 的全匹配规则", () => {
    const surfaces = permissionOf({ read: "allow" });

    expect(surfaces.get("read")).toEqual([
      { pattern: "*", action: "allow", index: 0 },
    ]);
  });

  it("带理由的动作保留 reason", () => {
    const surfaces = permissionOf({
      bash: { "rm *": { action: "deny", reason: "删除需人工确认" } },
    });

    expect(surfaces.get("bash")).toEqual([
      { pattern: "rm *", action: "deny", reason: "删除需人工确认", index: 0 },
    ]);
  });

  it("同 surface 内保留书写顺序，index 单调递增（last-match-wins）", () => {
    const surfaces = permissionOf({
      bash: { "rm *": "review", "rm -rf /*": "deny", "rm -rf ./dist": "allow" },
    });

    expect(surfaces.get("bash")?.map((rule) => [rule.pattern, rule.index])).toEqual([
      ["rm *", 0],
      ["rm -rf /*", 1],
      ["rm -rf ./dist", 2],
    ]);
  });

  it("语法糖总是展开在显式方向键之前，因此显式键可覆盖同名模式", () => {
    const surfaces = permissionOf({
      path_read: { "*.env": "review" },
      path: { "*.env": "deny" },
    });

    expect(surfaces.get("path_read")?.map((rule) => rule.action)).toEqual([
      "deny",
      "review",
    ]);
  });

  it("未知工具名按原样成为 surface（FR-2）", () => {
    const surfaces = permissionOf({ mcp__foo__bar: "deny" });

    expect(surfaces.get("mcp__foo__bar")).toEqual([
      { pattern: "*", action: "deny", index: 0 },
    ]);
  });

  it("通用兜底键 `*` 独立保留", () => {
    const surfaces = permissionOf({ "*": "ask" });

    expect(surfaces.get("*")).toEqual([{ pattern: "*", action: "ask", index: 0 }]);
  });

  it("规则计数覆盖所有 surface", () => {
    const parsed = guardianConfigSchema.parse({
      permission: { path: { "*.env": "deny" }, bash: { "rm *": "review" } },
    });

    const rules = [
      {
        layer: "global" as const,
        sourcePath: "/tmp/config.json",
        surfaces: normalizePermission(parsed.permission),
      },
    ];

    expect(countRules(rules)).toBe(3);
  });
});
