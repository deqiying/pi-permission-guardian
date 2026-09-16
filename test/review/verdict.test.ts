import { describe, expect, it } from "vitest";

import { MAX_RATIONALE_CHARS } from "../../src/review/types.ts";
import {
  VERDICT_JSON_SCHEMA,
  VERDICT_TOOL_NAME,
  parseVerdictText,
  verdictFromToolArguments,
} from "../../src/review/verdict.ts";

/**
 * verdict 解析（FR-21、FR-22）。
 *
 * 重点是两件容易被写反的事：**失败绝不猜成 allow**，以及缺字段时的**保守回填**——
 * riskLevel 缺失必须回到 `high`，否则一次契约违规会变成静默放行。
 */

describe("verdict schema（FR-21）", () => {
  it("五个字段全部 required 且不允许额外属性（provider 严格子集的要求）", () => {
    expect(VERDICT_JSON_SCHEMA.required).toEqual([
      "decision",
      "riskLevel",
      "userAuthorization",
      "reversible",
      "rationale",
    ]);
    expect(VERDICT_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(Object.keys(VERDICT_JSON_SCHEMA.properties).sort()).toEqual([
      "decision",
      "rationale",
      "reversible",
      "riskLevel",
      "userAuthorization",
    ]);
    // `strict: "prefer"` 会走 pi-ai 的严格子集转换，不能出现它不支持的键。
    for (const unsupported of ["$ref", "anyOf", "oneOf", "allOf", "$defs"]) {
      expect(JSON.stringify(VERDICT_JSON_SCHEMA)).not.toContain(`"${unsupported}"`);
    }
  });

  it("verdict 工具名固定", () => {
    expect(VERDICT_TOOL_NAME).toBe("submit_verdict");
  });
});

describe("结构化路径：verdictFromToolArguments（FR-22 第一段）", () => {
  it("完整结论原样读出", () => {
    expect(
      verdictFromToolArguments({
        decision: "allow",
        riskLevel: "medium",
        userAuthorization: "high",
        reversible: true,
        rationale: "用户明确要求的构建步骤",
      }),
    ).toEqual({
      decision: "allow",
      riskLevel: "medium",
      userAuthorization: "high",
      reversible: true,
      rationale: "用户明确要求的构建步骤",
    });
  });

  it("riskLevel 缺失或非法时回到 `high`（保守回填，让 allow 转人工）", () => {
    expect(verdictFromToolArguments({ decision: "allow" })?.riskLevel).toBe("high");
    expect(
      verdictFromToolArguments({ decision: "allow", riskLevel: "very-high" })?.riskLevel,
    ).toBe("high");
  });

  it("userAuthorization 缺失时回到 `unknown`", () => {
    expect(verdictFromToolArguments({ decision: "deny" })?.userAuthorization).toBe("unknown");
  });

  it("reversible 缺失时跟随结论，仅用于审计", () => {
    expect(verdictFromToolArguments({ decision: "allow" })?.reversible).toBe(true);
    expect(verdictFromToolArguments({ decision: "deny" })?.reversible).toBe(false);
  });

  it("rationale 缺失/空白时给占位理由，超长时截断", () => {
    expect(verdictFromToolArguments({ decision: "allow" })?.rationale).toContain("未提供理由");
    expect(verdictFromToolArguments({ decision: "deny", rationale: "   " })?.rationale).toContain(
      "未提供理由",
    );

    const long = verdictFromToolArguments({ decision: "allow", rationale: "字".repeat(500) });
    expect(long?.rationale.length).toBe(MAX_RATIONALE_CHARS);
  });

  it("decision 非法或参数不是对象时判为无法解析", () => {
    expect(verdictFromToolArguments({ decision: "maybe" })).toBeUndefined();
    expect(verdictFromToolArguments({})).toBeUndefined();
    expect(verdictFromToolArguments("allow")).toBeUndefined();
    expect(verdictFromToolArguments(undefined)).toBeUndefined();
    expect(verdictFromToolArguments(["allow"])).toBeUndefined();
  });
});

describe("文本路径：parseVerdictText（FR-22 第二段）", () => {
  it("容忍 ```json 围栏、整段 JSON 与前后缀包裹", () => {
    const body = '{"decision":"deny","riskLevel":"high","userAuthorization":"low","reversible":false,"rationale":"外泄凭据"}';

    expect(parseVerdictText(`\`\`\`json\n${body}\n\`\`\``)?.decision).toBe("deny");
    expect(parseVerdictText(body)?.decision).toBe("deny");
    expect(parseVerdictText(`我的结论是：${body}\n以上。`)?.decision).toBe("deny");
  });

  it("只给 decision 也算成功，但风险等级保守回填为 high", () => {
    const verdict = parseVerdictText('{"decision":"allow"}');

    expect(verdict?.decision).toBe("allow");
    expect(verdict?.riskLevel).toBe("high");
  });

  it("无法解析、或 JSON 里没有合法 decision 时返回 undefined（不猜成 allow）", () => {
    expect(parseVerdictText("我觉得可以放行")).toBeUndefined();
    expect(parseVerdictText("{ 不是 JSON }")).toBeUndefined();
    expect(parseVerdictText('{"outcome":"allow"}')).toBeUndefined();
    expect(parseVerdictText('{"decision":"ALLOW"}')).toBeUndefined();
    expect(parseVerdictText("")).toBeUndefined();
  });

  it("围栏内容非法时继续尝试后面的候选（不会一票否决）", () => {
    const text = `\`\`\`json\n{nope}\n\`\`\`\n{"decision":"deny"}`;

    expect(parseVerdictText(text)?.decision).toBe("deny");
  });
});
