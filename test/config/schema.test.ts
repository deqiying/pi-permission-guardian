import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildGuardianJsonSchema,
  compareActions,
  GUARDIAN_SCHEMA_ID,
  guardianConfigSchema,
  mostRestrictiveAction,
} from "../../src/config/schema.ts";

const SCHEMA_PATH = new URL("../../schemas/guardian.schema.json", import.meta.url);
const CONFIG_PATH = new URL("../../config/config.json", import.meta.url);

function readJson(path: URL): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** 用提交的 schema 文件本身构造校验器，证明这份产物确实可用来校验配置。 */
function validatorFromCommittedSchema(): z.ZodType {
  return z.fromJSONSchema(readJson(SCHEMA_PATH) as never);
}

describe("配置 schema（FR-57/58）", () => {
  it("提交版 schema 与 zod 生成结果一致", () => {
    const generated = `${JSON.stringify(buildGuardianJsonSchema(), null, 2)}\n`;
    expect(readFileSync(SCHEMA_PATH, "utf8")).toBe(generated);
  });

  it("schema 暴露 $id 与复用定义，且不要求任何字段", () => {
    const schema = readJson(SCHEMA_PATH) as Record<string, unknown>;
    expect(schema["$id"]).toBe(GUARDIAN_SCHEMA_ID);
    expect(schema["additionalProperties"]).toBe(false);
    expect(schema["required"]).toBeUndefined();
    // 比较集合而非顺序：$defs 的排序属于 zod 内部实现细节，不应成为契约。
    expect(Object.keys(schema["$defs"] as object).sort()).toEqual([
      "action",
      "actionValue",
      "failureBranchAction",
      "ruleMap",
      "surfaceValue",
    ]);
  });

  it("官方参考配置是严格 JSON 且通过提交的 schema 校验", () => {
    const text = readFileSync(CONFIG_PATH, "utf8");
    // 严格 JSON：不能有注释与尾逗号，JSON.parse 必须直接成功。
    const parsed = JSON.parse(text) as Record<string, unknown>;

    expect(guardianConfigSchema.safeParse(parsed).success).toBe(true);
    const result = validatorFromCommittedSchema().safeParse(parsed);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(parsed["$schema"]).toBe("../schemas/guardian.schema.json");
  });

  it("拒绝未知字段、非法动作与越界数值", () => {
    const validator = guardianConfigSchema;

    expect(validator.safeParse({ unknownField: true }).success).toBe(false);
    expect(validator.safeParse({ permission: { read: "nope" } }).success).toBe(
      false,
    );
    expect(validator.safeParse({ auditLog: { retentionDays: 0 } }).success).toBe(
      false,
    );
    expect(
      validator.safeParse({ auditLog: { retentionDays: 99999 } }).success,
    ).toBe(false);
    expect(
      validator.safeParse({ subagentPolicy: { defaultAction: "allow" } }).success,
    ).toBe(false);
    expect(
      validator.safeParse({ onMixedCommandActions: "allow" }).success,
    ).toBe(false);
    expect(
      validator.safeParse({ reviewer: { model: "no-slash" } }).success,
    ).toBe(false);
    expect(
      validator.safeParse({ circuitBreaker: { windowSize: 0 } }).success,
    ).toBe(false);
  });

  it("三个失败分支开关不接受 allow：失败不能变成放行", () => {
    for (const key of [
      "onReviewUnavailable",
      "onUnresolvedFacts",
      "onAskWithoutUI",
    ]) {
      expect(guardianConfigSchema.safeParse({ [key]: "allow" }).success).toBe(false);
      // 更严格的方向仍然可用
      expect(guardianConfigSchema.safeParse({ [key]: "deny" }).success).toBe(true);
    }
  });

  it("提交的 schema 拒绝同一批负向用例", () => {
    const validator = validatorFromCommittedSchema();

    expect(validator.safeParse({ unknownField: true }).success).toBe(false);
    expect(validator.safeParse({ permission: { read: "nope" } }).success).toBe(
      false,
    );
    expect(validator.safeParse({ auditLog: { retentionDays: 0 } }).success).toBe(
      false,
    );
    expect(
      validator.safeParse({ subagentPolicy: { defaultAction: "allow" } }).success,
    ).toBe(false);
    expect(validator.safeParse({ onReviewUnavailable: "allow" }).success).toBe(
      false,
    );
  });

  it("接受带理由的动作与模式映射两种写法", () => {
    const result = guardianConfigSchema.safeParse({
      permission: {
        // 只有 action 键的对象按"带理由的动作"解释
        read: { action: "deny" },
        bash: {
          "rm *": { action: "review", reason: "删除操作需复查" },
          "git status": "allow",
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.data?.permission.read).toEqual({ action: "deny" });
  });

  it("缺省值：内置只读命令白名单最小且固定（FR-9/D21）", () => {
    const config = guardianConfigSchema.parse({});

    expect(config.workingDirectory.readOnlyCommands).toEqual([
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
    ]);
    expect(config.enabled).toBe(true);
    expect(config.gate).toBe("side-effect");
    expect(config.onReviewUnavailable).toBe("deny");
    expect(config.onUnresolvedFacts).toBe("review");
    expect(config.onAskWithoutUI).toBe("deny");
    expect(config.onMixedCommandActions).toBe("deny");
    expect(config.userBashPolicy).toEqual({
      enabled: true,
      autoReview: true,
      model: null,
    });
    expect(config.subagentPolicy).toEqual({
      enabled: true,
      defaultAction: "review",
      allowSessionGrants: false,
    });
    expect(config.reviewer).toEqual({
      timeoutMs: 20000,
      maxEvidenceRounds: 3,
      evidenceTools: true,
      transcript: true,
      transcriptBudgetChars: 24000,
      maxAllowRiskLevel: "medium",
    });
  });

  it("显式空数组可关闭只读命令白名单", () => {
    const config = guardianConfigSchema.parse({
      workingDirectory: { readOnlyCommands: [] },
    });

    expect(config.workingDirectory.readOnlyCommands).toEqual([]);
  });

  it("动作严格度序为 deny > ask > review > allow（FR-6）", () => {
    expect(compareActions("deny", "ask")).toBeLessThan(0);
    expect(compareActions("ask", "review")).toBeLessThan(0);
    expect(compareActions("review", "allow")).toBeLessThan(0);

    expect(mostRestrictiveAction(["allow", "review", "ask"], "allow")).toBe("ask");
    expect(mostRestrictiveAction(["allow", "review"], "allow")).toBe("review");
    expect(mostRestrictiveAction(["deny", "allow"], "allow")).toBe("deny");
    expect(mostRestrictiveAction(["review"], "allow")).toBe("review");
    // 空集合必须落到调用方给的兜底值，而不是被兜底值参与比较
    expect(mostRestrictiveAction([], "review")).toBe("review");
    expect(mostRestrictiveAction([], "deny")).toBe("deny");
  });
});
