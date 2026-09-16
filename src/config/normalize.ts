import type { Action, GuardianConfig } from "./schema.ts";

/**
 * 配置规范化（FR-3）：把 `path` / `external_directory` 语法糖展开为读写方向键，
 * 把每层的 `permission` 整理成有序规则表，再合成 baseline 规则表。
 *
 * 保留顺序是关键：同一 surface 内后写的规则覆盖先写的（last-match-wins，FR-5）。
 * 跨层不在这里消除，由 M3 的求值器按"先层内最后命中、再跨层取最严格者"处理（FR-6）。
 *
 * baseline（默认动作矩阵）是**合成出来的规则**，与用户层同表但语义上是兜底层：
 * 只有当 global / project 都没有命中规则时才参与裁决（见 `buildBaselineRules`）。
 */

/** 规则表的一层来源。`baseline` 是合成层，不是用户写的配置。 */
export type RuleLayer = "baseline" | "global" | "project";

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

/**
 * 默认动作矩阵（FR-8、architecture §6.4）：surface → 默认动作。
 *
 * 只包含"有默认值"的 surface：
 * - `path_read` / `path_write` **刻意不在表内**。它们是叠加项（专门描述路径约束），
 *   给它俩定默认值会让每次带路径的调用都被路径面投一票：定 `review` 会直接推翻 `read` 的默认 `allow`，
 *   不命中就不表态才是正确语义。
 * - `tool` 是"未识别 / 自定义工具"的哨兵 surface，由 M3 在工具名不在已知工具表时使用。
 */
export const DEFAULT_ACTION_MATRIX: ReadonlyArray<readonly [string, Action]> = [
  ["read", "allow"],
  ["find", "allow"],
  ["grep", "allow"],
  ["ls", "allow"],
  ["write", "review"],
  ["edit", "review"],
  ["bash", "review"],
  ["powershell", "review"],
  ["external_directory_read", "review"],
  ["external_directory_write", "review"],
  ["tool", "review"],
];

/** baseline 合成规则的 `reason`：让审计日志与拦截提示能说清"这是默认值，不是我写的规则"。 */
export const BASELINE_REASON = "默认动作矩阵";
export const BASELINE_TIGHTENED_REASON = "配置存在失效层，默认动作收紧为 review";

/**
 * 合成 baseline 规则表（FR-8、FR-51）。
 *
 * 为什么是规则而不是"求值器里的兜底分支"：
 *
 * 1. 规则表是唯一决策权威（§6.2）：实际生效的东西全在表里，`/perm status`、审计与
 *    排查都只需要看一张表，不用再记住一段代码里的兜底顺序。
 * 2. `permission["*"]` 的语义自然成立：它是用户层里的一条 `*` surface 规则，总是能命中，
 *    因此 baseline 永远不会参与 ⇒ 自动覆盖默认矩阵（§6.4），不需要额外分支。
 * 3. `degraded` 时的收紧（configuration.md §3）也变成表里的事实：合成时把所有 `allow`
 *    抬升为 `review`，而不是让求值器记一个"配置有坏层"的开关。
 *
 * 但 baseline 是**兜底层，不是普通层**：只有当 global / project 都没命中规则时才参与。
 * 否则默认值会压过用户的显式决定 —— `permission.bash` 里写 `"rm -rf ./dist": "allow"`
 * 会被默认矩阵的 `review` 直接推翻，参考配置末段的"明确放行"整段失效。
 * 跨层取最严格者的意义是"下层不能放宽上层"，不是"默认值能压过用户"。
 *
 * 同时也刻意不合成一条 `*` surface 的兜底规则：那会连 `path_read` / `path_write`
 * 一起兜住，把它们变成永远投票的面。未识别工具由 `tool` 哨兵 rule 负责。
 *
 * `index` 即矩阵顺序，同 surface 内不会出现第二条 baseline 规则。
 */
export function buildBaselineRules(options: { tightened: boolean }): LayerRules {
  const surfaces = new Map<string, RuleEntry[]>();
  for (const [surface, action] of DEFAULT_ACTION_MATRIX) {
    // 只有真的被抬升（原本 allow）才换 reason：本来就 review 的 surface 没变过，
    // 给它挂"已收紧"的理由会误异审计日志与提示词。
    const lifted = options.tightened && action === "allow";
    surfaces.set(surface, [
      {
        pattern: "*",
        action: lifted ? "review" : action,
        reason: lifted ? BASELINE_TIGHTENED_REASON : BASELINE_REASON,
        index: 0,
      },
    ]);
  }
  return { layer: "baseline", sourcePath: "", surfaces };
}

/** 规则总数，供 `/perm status` 报告。 */
export function countRules(rules: readonly LayerRules[]): number {
  let total = 0;
  for (const layer of rules) {
    if (layer.layer === "baseline") {
      continue;
    }
    for (const entries of layer.surfaces.values()) {
      total += entries.length;
    }
  }
  return total;
}

/** baseline 合成规则的条数，供 `/perm status` 与测试报告。 */
export function countBaselineRules(rules: readonly LayerRules[]): number {
  let total = 0;
  for (const layer of rules) {
    if (layer.layer !== "baseline") {
      continue;
    }
    for (const entries of layer.surfaces.values()) {
      total += entries.length;
    }
  }
  return total;
}
