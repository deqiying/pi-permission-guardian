import type { Action, GuardianConfig } from "./schema.ts";

/**
 * 配置规范化（FR-3）：把 `path` / `external_directory` 语法糖展开为读写方向键，
 * 并把每层的 `permission` 整理成有序规则表。
 *
 * 保留顺序是关键：同一 surface 内后写的规则覆盖先写的（last-match-wins，FR-5）。
 * 跨层不在这里消除，由 M3 的求值器按"先层内最后命中、再跨层取最严格者"处理（FR-6）。
 *
 * 关于 baseline：默认动作矩阵与 `permission["*"]` 是"没有任何规则命中时的兜底"，**不能**合成为
 * `*` 模式的规则。否则跨层最严格者合并会让兜底 `review` 压过用户在更具体模式上显式写的 `allow`，
 * 直接推翻参考配置未段的"明确放行"。因此这里只输出用户显式写的规则；
 * 兜底顺序、`permission["*"]` 覆盖默认值以及 `degraded` 时的收紧都由 M3 求值器负责（FR-8、FR-51）。
 */

/** 规则表的一层来源。baseline 刻意不在这里：见文件头说明。 */
export type RuleLayer = "global" | "project";

/** 一条可求值规则。`index` 是同层同 surface 内的写入序号，用于 last-match-wins。 */
export interface RuleEntry {
  pattern: string;
  action: Action;
  reason?: string;
  index: number;
}

/** 一层配置的规则表：surface → 有序规则。 */
export interface LayerRules {
  layer: RuleLayer;
  sourcePath: string;
  surfaces: Map<string, RuleEntry[]>;
}

/** 语法糖键到方向键的展开表（FR-3、D13）。 */
const SURFACE_SUGAR: Record<string, readonly [string, string]> = {
  path: ["path_read", "path_write"],
  external_directory: [
    "external_directory_read",
    "external_directory_write",
  ],
};

type SurfaceValue = NonNullable<GuardianConfig["permission"]>[string];
type RuleMapValue = Action | { action: Action; reason?: string };

const ACTIONS: readonly string[] = ["allow", "deny", "ask", "review"];

function isAction(value: unknown): value is Action {
  return typeof value === "string" && ACTIONS.includes(value);
}

/**
 * 判断一个值是否按"带理由的动作"解释。
 *
 * 与 zod union 顺序、求值器保持同一判据：只有 `action` 是合法动作、且除它之外只允许 `reason`
 * 时才是单动作；否则按模式映射处理。配置降级路径也复用它，避免两处消歧规则漂移。
 */
export function isActionValueShape(
  value: unknown,
): value is { action: Action; reason?: string } {
  return asActionValue(value) !== undefined;
}

/**
 * 判断一个对象是不是"带理由的动作"。
 *
 * 与 zod 的 union 顺序保持一致（先 `actionValue`、后 `ruleMap`）：只有当 `action` 是合法动作、
 * 且其余键仅允许 `reason` 时，才按单动作解释；否则按模式映射解释。
 * 这消掉了 `{"action": "deny"}` 同时属于两个分支的歧义。
 */
function asActionValue(value: unknown): { action: Action; reason?: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (!isAction(record["action"])) {
    return undefined;
  }
  for (const key of Object.keys(record)) {
    if (key === "action") {
      continue;
    }
    if (key !== "reason" || typeof record["reason"] !== "string") {
      return undefined;
    }
  }
  const action = record["action"] as Action;
  return typeof record["reason"] === "string"
    ? { action, reason: record["reason"] }
    : { action };
}

/** 把一个 surface 值展开成规则列表（不含 surface 归属）。 */
function surfaceValueToRules(value: SurfaceValue): Array<Omit<RuleEntry, "index">> {
  if (isAction(value)) {
    // 面级动作等价于该 surface 的全匹配规则。
    return [{ pattern: "*", action: value }];
  }
  const actionValue = asActionValue(value);
  if (actionValue !== undefined) {
    return [
      actionValue.reason === undefined
        ? { pattern: "*", action: actionValue.action }
        : { pattern: "*", action: actionValue.action, reason: actionValue.reason },
    ];
  }
  const rules: Array<Omit<RuleEntry, "index">> = [];
  for (const [pattern, ruleValue] of Object.entries(value as Record<string, RuleMapValue>)) {
    if (isAction(ruleValue)) {
      rules.push({ pattern, action: ruleValue });
      continue;
    }
    rules.push(
      ruleValue.reason === undefined
        ? { pattern, action: ruleValue.action }
        : { pattern, action: ruleValue.action, reason: ruleValue.reason },
    );
  }
  return rules;
}

/**
 * 展开某一层的 `permission`。
 *
 * 同一 surface 内的顺序即规则优先级，因此遍历顺序必须稳定：zod 解析后命名键按 schema 声明顺序排列、
 * 其余工具名追加在后，所以语法糖 `path` / `external_directory` 总是展开在显式 `*_read` / `*_write`
 * 之前 —— 显式方向键可以覆盖语法糖产生的同名模式，与书写顺序无关。
 */
export function normalizePermission(
  permission: GuardianConfig["permission"],
): Map<string, RuleEntry[]> {
  const surfaces = new Map<string, RuleEntry[]>();
  for (const [key, value] of Object.entries(permission)) {
    if (value === undefined) {
      continue;
    }
    const targets = SURFACE_SUGAR[key] ?? [key];
    const rules = surfaceValueToRules(value);
    for (const surface of targets) {
      const list = surfaces.get(surface) ?? [];
      for (const rule of rules) {
        list.push({ ...rule, index: list.length });
      }
      surfaces.set(surface, list);
    }
  }
  return surfaces;
}

/** 构造一层的完整规则表。 */
export function normalizeLayerRules(
  layer: RuleLayer,
  sourcePath: string,
  permission: GuardianConfig["permission"],
): LayerRules {
  return { layer, sourcePath, surfaces: normalizePermission(permission) };
}

/** 规则总数，供 `/perm status` 报告。 */
export function countRules(rules: readonly LayerRules[]): number {
  let total = 0;
  for (const layer of rules) {
    for (const entries of layer.surfaces.values()) {
      total += entries.length;
    }
  }
  return total;
}
