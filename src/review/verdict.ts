import {
  MAX_RATIONALE_CHARS,
  RISK_LEVELS,
  USER_AUTHORIZATIONS,
  boundText,
  type ReviewVerdict,
  type RiskLevel,
  type UserAuthorization,
} from "./types.ts";

/**
 * verdict 的获取与解析（FR-21、FR-22、architecture §7.2）。
 *
 * 三段式降级：
 * 1. 结构化输出——把 `VERDICT_JSON_SCHEMA` 声明成语义上的工具参数，配合
 *    `constrainedSampling: {type:"json_schema", strict:"prefer"}` 由 provider 侧做约束解码；
 * 2. 提示约束 + JSON 文本解析——容忍 ```json 围栏、整段 JSON、首个 `{…}` 子串；
 * 3. 都不成立即 `unavailable`，**任何一段都不把失败猜成 allow**。
 *
 * `strict: "prefer"` 是刻意的：schema 不在 provider 的严格子集内时，pi-ai 会静默退回普通
 * 工具调用（`resolveJsonSchemaStrictSampling`），而不是抛错；用 `"require"` 会让评审直接失败。
 */

/** 语义上的 verdict 工具名：模型"调用"它就是给出结论，插件不会真的执行它。 */
export const VERDICT_TOOL_NAME = "submit_verdict";

/**
 * verdict schema（FR-21）。
 *
 * 五个字段全部 `required` 且 `additionalProperties: false`：这是 pi-ai 严格子集的硬要求，
 * 也顺带保证结构化路径上模型不可能漏字段。不要加 `$ref` / `anyOf` / `oneOf` 等严格子集
 * 不支持的键，那会让 `strict: "prefer"` 静默退化为无约束。
 */
export const VERDICT_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["decision", "riskLevel", "userAuthorization", "reversible", "rationale"],
  properties: {
    decision: { type: "string", enum: ["allow", "deny"] },
    riskLevel: { type: "string", enum: [...RISK_LEVELS] },
    userAuthorization: { type: "string", enum: [...USER_AUTHORIZATIONS] },
    reversible: { type: "boolean" },
    rationale: {
      type: "string",
      maxLength: MAX_RATIONALE_CHARS,
    },
  },
});

function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === "string" && (RISK_LEVELS as readonly string[]).includes(value);
}

function isUserAuthorization(value: unknown): value is UserAuthorization {
  return (
    typeof value === "string" && (USER_AUTHORIZATIONS as readonly string[]).includes(value)
  );
}

/**
 * 从一段对象里读出 verdict；`decision` 是唯一的硬性要求。
 *
 * 缺字段的**保守回填**：
 * - `riskLevel` 缺失或非法 → `high`。风险等级是 FR-23 门槛的输入，缺了它就只能猜；
 *   猜 `low` 等于让一次契约违规变成静默放行，猜 `high` 只会多一次人工确认。
 * - `userAuthorization` 缺失 → `unknown`（策略要求：没有证据就是没有授权）。
 * - `reversible` 缺失 → 跟随结论（allow 视为可逆、deny 视为不可逆），仅用于审计。
 */
export function verdictFromRecord(record: Record<string, unknown>): ReviewVerdict | undefined {
  const decision = record["decision"];
  if (decision !== "allow" && decision !== "deny") {
    return undefined;
  }
  const rawRisk = record["riskLevel"];
  const rawAuthorization = record["userAuthorization"];
  const rawReversible = record["reversible"];
  const rawRationale = record["rationale"];

  return {
    decision,
    riskLevel: isRiskLevel(rawRisk) ? rawRisk : "high",
    userAuthorization: isUserAuthorization(rawAuthorization) ? rawAuthorization : "unknown",
    reversible: typeof rawReversible === "boolean" ? rawReversible : decision === "allow",
    rationale:
      typeof rawRationale === "string" && rawRationale.trim().length > 0
        ? boundText(rawRationale, MAX_RATIONALE_CHARS)
        : decision === "allow"
          ? "评审模型给出 allow，但未提供理由。"
          : "评审模型给出 deny，但未提供理由。",
  };
}

/** 结构化路径：模型调用 verdict 工具时，参数即结论。 */
export function verdictFromToolArguments(args: unknown): ReviewVerdict | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return undefined;
  }
  return verdictFromRecord(args as Record<string, unknown>);
}

/**
 * 按出现顺序取出文本里**平衡**的 `{…}` 对象（忽略字符串内的花括号）。
 *
 * 不用贪婪正则：`{nope}` 后面跟着真结论时，贪婪匹配会把两段拼成一个非法 JSON，
 * 从而白白丢掉一个本来可用的 verdict。
 */
function balancedObjectCandidates(text: string, limit = 8): string[] {
  const found: string[] = [];
  for (let i = 0; i < text.length && found.length < limit; i += 1) {
    if (text[i] !== "{") {
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j += 1) {
      const char = text[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          found.push(text.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return found;
}

/** 文本解析的候选串：围栏内容 → 整段文本 → 每个平衡的 `{…}` 子串。 */
function jsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1] !== undefined) {
    candidates.push(fenced[1].trim());
  }
  candidates.push(text.trim());
  candidates.push(...balancedObjectCandidates(text));
  return candidates;
}

/** 文本路径：从模型回复里解析 verdict（FR-22 第二段）。 */
export function parseVerdictText(text: string): ReviewVerdict | undefined {
  for (const candidate of jsonCandidates(text)) {
    if (candidate.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      continue;
    }
    const verdict = verdictFromRecord(parsed as Record<string, unknown>);
    if (verdict !== undefined) {
      return verdict;
    }
  }
  return undefined;
}
