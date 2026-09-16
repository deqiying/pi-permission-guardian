import {
  type GuardianConfig,
  guardianConfigSchema,
  mostRestrictiveAction,
} from "./schema.ts";
import {
  countRules,
  type LayerRules,
  normalizeLayerRules,
} from "./normalize.ts";

/**
 * 跨层合并（FR-6、FR-59、FR-60、FR-56）。
 *
 * 合并的总原则：
 * - **规则（`permission`）不在这里消除**。跨层取"最严格者胜"是逐对象求值时的动作合成（M3），
 *   这里只保留每层有序的规则表，顺序为 global → project，因此规则不会丢失书写顺序。
 * - **其余标量字段上层覆盖**：同名字段项目层写了就用项目层，没写才落到全局层，最后才落到默认值。
 *   判断"写没写"必须看原始 JSON，不能看 zod 解析结果 —— 解析结果里所有字段都有默认值。
 * - **安全敏感字段跨层收紧**：`onMixedCommandActions`（默认 `deny`，项目层只能收紧）、
 *   `userBashPolicy`（任一层开启则保持拦截、任一层关闭自动审核则转人工）、
 *   `subagentPolicy`（任一层开启则启用、默认动作取最严格者、任一层禁止则禁止会话授权）。
 */

export type ConfigLayerName = "global" | "project";

/** 一层的加载状态。`degraded` = 文件可解析但校验失败，已按 FR-51 抬升 `allow` 后继续使用。 */
export type ConfigLayerStatus =
  | "loaded"
  | "degraded"
  | "invalid"
  | "missing"
  /** 存在但按规则刻意未加载（例如项目未受信任）。 */
  | "skipped";

/** 配置诊断：位置信息用于把错误指回原文。 */
export interface ConfigDiagnostic {
  layer: ConfigLayerName;
  path: string;
  message: string;
  line?: number;
  column?: number;
  snippet?: string;
  /** zod 校验失败时的字段路径。 */
  fields?: string[];
}

/** 已加载的一层配置，由 `load.ts` 生产。 */
export interface LoadedLayer {
  layer: ConfigLayerName;
  path: string;
  status: ConfigLayerStatus;
  /** 未加载或被拒绝时的可读原因，`/perm status` 直接展示。 */
  detail?: string;
  diagnostics: ConfigDiagnostic[];
  /** 通过校验（或降级后仍可用）的单层配置，缺省值已填充。 */
  config?: GuardianConfig;
  /** 通过校验的原始 JSON 对象，用于区分"显式设置"与"默认值"。 */
  raw?: Record<string, unknown>;
}

/** 合并结果：单层形态的标量字段 + 每层规则表 + 加载状态。 */
export interface ResolvedConfig extends Omit<GuardianConfig, "permission"> {
  /** 上一层覆盖后的规则表，顺序 global → project。 */
  rules: LayerRules[];
  layers: Record<ConfigLayerName, LoadedLayer>;
  /**
   * 至少一层配置不可用（FR-51）。
   *
   * 为真时未命中规则的**默认动作**必须按保守侧处理（`allow` → `review`），
   * 因为损坏的配置里可能原本存在 `deny` 规则，我们无法读出来。
   */
  degraded: boolean;
  /** 规则条数，供 `/perm status` 报告。 */
  ruleCount: number;
}

/** 由合并逻辑显式接管、不参与通用深合并的顶层键。 */
const SPECIAL_KEYS = new Set([
  "permission",
  "onMixedCommandActions",
  "userBashPolicy",
  "subagentPolicy",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 深合并原始 JSON 对象：对象递归、数组与标量整体覆盖。 */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const previous = merged[key];
    merged[key] =
      isPlainObject(previous) && isPlainObject(value)
        ? deepMerge(previous, value)
        : value;
  }
  return merged;
}

/** 一层原始配置里是否显式设置了某个顶层字段。 */
function rawHasTop(layer: LoadedLayer, key: string): boolean {
  return layer.raw !== undefined && Object.hasOwn(layer.raw, key);
}

/** 一层原始配置里某段是否显式设置了某个字段。 */
function rawHas(
  layer: LoadedLayer,
  section: string,
  field: string,
): boolean {
  const sectionValue = layer.raw?.[section];
  return isPlainObject(sectionValue) && Object.hasOwn(sectionValue, field);
}

function sectionField(layer: LoadedLayer, section: string, field: string): unknown {
  const sectionValue = layer.raw?.[section];
  return isPlainObject(sectionValue) ? sectionValue[field] : undefined;
}

/** 取最具体的一层显式设置的字段值（后传的层优先），都没有显式设置时返回 undefined。 */
function pickMostSpecific(
  layers: readonly LoadedLayer[],
  section: string,
  field: string,
): unknown {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i] as LoadedLayer;
    if (rawHas(layer, section, field)) {
      return sectionField(layer, section, field);
    }
  }
  return undefined;
}

/**
 * 收集各层对某个安全敏感字段的**显式**取值。
 *
 * 跨层收紧只让真正写了该字段的层投票：没写就是没表态，不能用 schema 默认值去压低或抬高另一层的选择。
 * 否则“全局层关掉 user_bash 拦截”会被一个只改了 model 的项目层默认值反向打开。
 */
function explicitVotes(
  layers: readonly LoadedLayer[],
  section: string,
  field: string,
): unknown[] {
  const votes: unknown[] = [];
  for (const layer of layers) {
    if (rawHas(layer, section, field)) {
      votes.push(sectionField(layer, section, field));
    }
  }
  return votes;
}

/** 收集各层对某个顶层字段的显式取值。 */
function explicitTopVotes(layers: readonly LoadedLayer[], key: string): unknown[] {
  const votes: unknown[] = [];
  for (const layer of layers) {
    if (rawHasTop(layer, key)) {
      votes.push(layer.raw?.[key]);
    }
  }
  return votes;
}

/** 只留下取值在允许集合内的票；非法值不应该出现（层已校验），出现了也不能当成有效配置使用。 */
function onlyAllowed<T extends string>(
  votes: readonly unknown[],
  allowed: readonly T[],
): T[] {
  return votes.filter(
    (vote): vote is T =>
      typeof vote === "string" && (allowed as readonly string[]).includes(vote),
  );
}

const MIXED_ACTIONS = ["deny", "ask", "review"] as const;
const SUBAGENT_DEFAULT_ACTIONS = ["deny", "ask", "review"] as const;

/** schema 默认值：显式投票为空时的落点。 */
const DEFAULTS = guardianConfigSchema.parse({});

/**
 * 合并各层，产出最终生效配置。
 *
 * `layers` 按"宽泛在前、具体在后"传入（global → project），只有带 `config` 的层参与合并。
 */
export function mergeLayers(layers: readonly LoadedLayer[]): ResolvedConfig {
  const contributing = layers.filter(
    (layer): layer is LoadedLayer & { config: GuardianConfig; raw: Record<string, unknown> } =>
      layer.config !== undefined && layer.raw !== undefined,
  );

  const scalars: Record<string, unknown> = {};
  for (const layer of contributing) {
    for (const [key, value] of Object.entries(layer.raw)) {
      if (SPECIAL_KEYS.has(key)) {
        continue;
      }
      const previous = scalars[key];
      scalars[key] = isPlainObject(previous) && isPlainObject(value)
        ? deepMerge(previous, value)
        : value;
    }
  }

  const merged = guardianConfigSchema.parse(scalars);

  if (contributing.length > 0) {
    // 调用级冲突策略（FR-59、architecture §4.2）：基线 = 全局层的显式取值，全局层没写就是 `deny`；
    // 项目层只能在此基础上按 deny > ask > review 收紧。
    // 基线始终参与比较，因此只写了项目层 `review` 不能把默认或全局的 `deny` 放宽。
    const globalMixed = onlyAllowed(
      explicitTopVotes(
        contributing.filter((layer) => layer.layer === "global"),
        "onMixedCommandActions",
      ),
      MIXED_ACTIONS,
    );
    const baselineMixed: "deny" | "ask" | "review" =
      globalMixed[0] ?? DEFAULTS.onMixedCommandActions;
    const projectMixed = onlyAllowed(
      explicitTopVotes(
        contributing.filter((layer) => layer.layer === "project"),
        "onMixedCommandActions",
      ),
      MIXED_ACTIONS,
    );
    merged.onMixedCommandActions = mostRestrictiveAction(
      [baselineMixed, ...projectMixed],
      baselineMixed,
    );

    // user_bash：任一层显式开启则保持拦截，任一层显式关闭自动审核则转人工；
    // 模型取更具体的一层（含显式 null）。
    const userBashEnabled = explicitVotes(contributing, "userBashPolicy", "enabled");
    merged.userBashPolicy.enabled =
      userBashEnabled.length === 0
        ? DEFAULTS.userBashPolicy.enabled
        : userBashEnabled.some((value) => value === true);
    const autoReviewVotes = explicitVotes(contributing, "userBashPolicy", "autoReview");
    merged.userBashPolicy.autoReview =
      autoReviewVotes.length === 0
        ? DEFAULTS.userBashPolicy.autoReview
        : autoReviewVotes.every((value) => value === true);
    const userBashModel = pickMostSpecific(contributing, "userBashPolicy", "model");
    if (typeof userBashModel === "string" || userBashModel === null) {
      merged.userBashPolicy.model = userBashModel;
    }

    // 子代理：任一层显式启用则启用，默认动作取最严格者，任一层显式禁止即禁止会话授权。
    const subagentEnabled = explicitVotes(contributing, "subagentPolicy", "enabled");
    merged.subagentPolicy.enabled =
      subagentEnabled.length === 0
        ? DEFAULTS.subagentPolicy.enabled
        : subagentEnabled.some((value) => value === true);
    merged.subagentPolicy.defaultAction = mostRestrictiveAction(
      onlyAllowed(
        explicitVotes(contributing, "subagentPolicy", "defaultAction"),
        SUBAGENT_DEFAULT_ACTIONS,
      ),
      DEFAULTS.subagentPolicy.defaultAction,
    );
    const grantVotes = explicitVotes(
      contributing,
      "subagentPolicy",
      "allowSessionGrants",
    );
    merged.subagentPolicy.allowSessionGrants =
      grantVotes.length === 0
        ? DEFAULTS.subagentPolicy.allowSessionGrants
        : grantVotes.every((value) => value === true);
  }

  const rules = contributing.map((layer) =>
    normalizeLayerRules(layer.layer, layer.path, layer.config.permission),
  );

  const degraded = layers.some(
    (layer) => layer.status === "degraded" || layer.status === "invalid",
  );

  const { permission: _permission, ...rest } = merged;

  return {
    ...rest,
    rules,
    layers: layerRecord(layers),
    degraded,
    ruleCount: countRules(rules),
  };
}

function layerRecord(layers: readonly LoadedLayer[]): Record<ConfigLayerName, LoadedLayer> {
  const fallback = (layer: ConfigLayerName): LoadedLayer => ({
    layer,
    path: "",
    status: "missing",
    detail: "未加载",
    diagnostics: [],
  });
  return {
    global: layers.find((layer) => layer.layer === "global") ?? fallback("global"),
    project: layers.find((layer) => layer.layer === "project") ?? fallback("project"),
  };
}
