import { z } from "zod";

/**
 * 配置的 zod 唯一真源（FR-57）。
 *
 * 本文件有两个消费者：
 * 1. 运行时校验（`config/load.ts`），未知字段拒绝、动作枚举、数值边界都在这里定义；
 * 2. `scripts/generate-schema.ts` 据此生成 `schemas/guardian.schema.json`，供编辑器补全与实时校验。
 *
 * 生成 schema 时使用 `io: "input"`：全局层与项目层是合并的，局部配置必须能独立通过校验，
 * 因此带 `.default()` 的字段在发布的 schema 里不能出现在 `required` 中。
 */

/** 四种动作（FR-1）。严格度见 FR-6：`deny > ask > review > allow`。 */
export const actionSchema = z
  .enum(["allow", "deny", "ask", "review"])
  .meta({
    id: "action",
    title: "动作",
    description: "allow=静默放行；deny=直接拒绝；ask=人工确认；review=交评审模型判断",
  });

/**
 * 失败分支开关允许的动作。
 *
 * 刻意不含 `allow`：`onReviewUnavailable` / `onUnresolvedFacts` / `onAskWithoutUI` 描述的都是
 * "本次没能得出安全结论"的情形，允许配成 `allow` 等于把"拔网线、写错模型名、解析不了" 变成绕过手段。
 * 需要放宽护栏时用 `yoloMode`（它会写审计日志并在状态栏显著提示），而不是就地埋一个静默放行开关。
 */
export const failureBranchActionSchema = z
  .enum(["deny", "ask", "review"])
  .meta({
    id: "failureBranchAction",
    title: "失败分支动作",
    description: "不允许 allow：失败不能变成放行",
  });

/** 动作或带理由的动作（FR-10）。 */
export const actionValueSchema = z.union([
  actionSchema,
  z
    .strictObject({
      action: actionSchema,
      reason: z
        .string()
        .min(1)
        .meta({ description: "在拦截信息中向 agent 展示的理由（FR-10）" })
        .optional(),
    })
    .meta({ title: "带理由的动作" }),
])
  .meta({ id: "actionValue", title: "动作或带理由的动作" });

/** 模式到动作的映射；同层内后写的规则覆盖先写的（FR-5）。 */
export const ruleMapSchema = z
  .record(z.string().min(1), actionValueSchema)
  .meta({
    id: "ruleMap",
    title: "模式到动作的映射",
    description:
      '键为 glob 模式（* 跨路径分隔符，? 单字符，结尾 " *" 使参数可选）。同一 surface 内后写的规则覆盖先写的（last-match-wins，FR-5）。',
  });

/**
 * 面规则：单个动作，或模式到动作的映射（FR-3）。
 *
 * 注意 `{"action": "deny"}` 同时满足两个分支（"action" 也能当作模式键），发布 schema 因此使用
 * `anyOf`；解析时按"先动作、后映射"的顺序取第一个匹配结果，与 zod 的 union 处理一致。
 */
export const surfaceValueSchema = z
  .union([actionValueSchema, ruleMapSchema])
  .meta({ id: "surfaceValue", title: "面规则" });

/**
 * 内置只读命令白名单（FR-9 / D21）：保持尽可能小且通用。
 * 匹配方式固定为"可执行名 + 参数前缀"，不为特定选项增加例外。
 */
export const DEFAULT_READ_ONLY_COMMANDS: readonly string[] = [
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
];

const auditLogSchema = z
  .strictObject({
    enabled: z
      .boolean()
      .default(true)
      .meta({ description: "是否写入决策审计日志。" }),
    retentionDays: z
      .int()
      .min(1)
      .max(3650)
      .default(14)
      .meta({
        description:
          "保留的自然日数量，包含当天。启动及跨日写入前清理更早的 guardian-日期.jsonl。",
      }),
  })
  .meta({
    description:
      "决策审计日志（FR-43/44）。固定按进程本地日期切分，文件名为 guardian-YYYY-MM-DD.jsonl。",
  });

const reviewerSchema = z
  .strictObject({
    model: z
      .string()
      .min(3)
      .regex(/^[^/]+\/.+$/, '格式必须是 "provider/model-id"')
      .meta({
        description:
          '评审模型，格式 "provider/model-id"，只能引用 pi 模型配置文件中已存在的模型。通过 model registry 解析并使用模型配置的接口协议；插件不接受 api/baseUrl/认证/headers 覆盖。未配置或无法解析即 unavailable（FR-19、D6）。',
      })
      .optional(),
    timeoutMs: z
      .int()
      .min(1000)
      .max(120000)
      .default(20000)
      .meta({ description: "单次评审的硬性 deadline（FR-25）" }),
    maxEvidenceRounds: z
      .int()
      .min(0)
      .max(8)
      .default(3)
      .meta({
        description: "评审模型调用只读证据工具自行查证的轮次上限（FR-24）",
      }),
    evidenceTools: z.boolean().default(true).meta({
      description: "是否允许评审模型调用只读证据工具（read / grep / find / ls）",
    }),
    transcript: z
      .boolean()
      .default(true)
      .meta({ description: "是否把会话 transcript 提供给评审模型" }),
    transcriptBudgetChars: z
      .int()
      .min(2000)
      .default(24000)
      .meta({ description: "transcript 的字符预算上限" }),
    maxAllowRiskLevel: z
      .enum(["low", "medium", "high", "critical"])
      .default("medium")
      .meta({
        description:
          "风险等级门槛（FR-23）：模型给出 allow 但 riskLevel 高于此值时，不直接放行，转为人工确认。",
      }),
  })
  .meta({ description: "评审模型配置（FR-19~FR-28）" });

const userBashPolicySchema = z
  .strictObject({
    enabled: z
      .boolean()
      .default(true)
      .meta({
        description: "是否拦截 user_bash。关闭后用户直接执行的命令不经过本插件。",
      }),
    autoReview: z
      .boolean()
      .default(true)
      .meta({
        description:
          "user_bash 得到 review 动作时是否自动调用评审模型；关闭后转人工确认。",
      }),
    model: z
      .string()
      .regex(/^[^/]+\/.+$/, '格式必须是 "provider/model-id"')
      .nullable()
      .default(null)
      .meta({
        description:
          "user_bash 自动审核模型，格式 provider/model-id；只能引用 pi 模型配置中的模型，接口协议使用该模型自己的配置；null 表示复用 reviewer.model。",
      }),
  })
  .meta({
    description:
      "用户直接输入 !command / !!command 时的护栏策略（FR-60）。两者采用相同安全裁决，区别仅是 !! 的输出不进入模型上下文。",
  });

const classifierSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    model: z
      .string()
      .nullable()
      .default(null)
      .meta({ description: "缺省复用 reviewer.model" }),
    timeoutMs: z.int().min(1000).default(15000),
    maxLag: z
      .int()
      .min(0)
      .max(20)
      .default(2)
      .meta({
        description: "评分对应的调用序落后当前超过此值时，快路径失效（FR-37）",
      }),
  })
  .meta({
    description:
      '非阻塞预评分（FR-36~38）。语义是"先放行、后判定"，默认关闭（D8）。开启后只会放行、永不拒绝。',
  });

const circuitBreakerSchema = z
  .strictObject({
    consecutiveDenials: z
      .int()
      .min(0)
      .max(100)
      .default(3)
      .meta({ description: "同一轮内连续拒绝达到此值时拦截并提前结束本轮" }),
    recentDenials: z.int().min(0).max(100).default(10),
    windowSize: z.int().min(1).max(200).default(50),
  })
  .meta({ description: "熔断器（FR-34/35）。阈值设为 0 表示关闭该条件。" });

const cacheSchema = z
  .strictObject({
    enabled: z.boolean().default(true),
    ttlMs: z.int().min(0).default(300000),
    maxEntries: z.int().min(1).default(200),
  })
  .meta({
    description:
      "判定缓存（FR-31~33）。仅内存，仅缓存确定的 allow / deny，不缓存 unavailable。",
  });

const sessionGrantsSchema = z
  .strictObject({ enabled: z.boolean().default(true) })
  .meta({
    description: "会话授权记忆（FR-29/30）。仅内存，会话结束即失效，不落盘。",
  });

const subagentPolicySchema = z
  .strictObject({
    enabled: z
      .boolean()
      .default(true)
      .meta({ description: "检测到子代理会话时是否启用该策略。" }),
    defaultAction: z
      .enum(["deny", "ask", "review"])
      .default("review")
      .meta({
        description: "子代理中规则未命中时使用的默认动作；不允许 allow。",
      }),
    allowSessionGrants: z
      .boolean()
      .default(false)
      .meta({
        description:
          "子代理是否能创建或使用会话授权；默认 false，且父子会话状态始终不共享。",
      }),
  })
  .meta({
    description:
      "子代理会话的保守策略（FR-56）。v1 仅对接 @gotgenes/pi-subagents v21.7.1；仅收紧未命中规则的默认动作，不能放宽父配置中的显式规则。",
  });

const workingDirectorySchema = z.strictObject({
  allowRoots: z
    .array(z.string().min(1))
    .default([])
    .meta({
      description:
        '视为"内部"的额外根目录。monorepo 场景可加入兄弟包路径，避免被判定为外部目录。',
    }),
  readOnlyCommands: z
    .array(z.string().min(1))
    .default([...DEFAULT_READ_ONLY_COMMANDS])
    .meta({
      description:
        '只读命令白名单（FR-9）：命中即 allow，不产生评审调用。内置集保持尽可能小且通用，匹配固定为“可执行名 + 参数前缀”，不为特殊选项增加分支。省略时使用内置集；显式配置数组时完整覆盖默认集，配置 [] 可关闭。例如 "git status" 匹配 `git status --short`，不匹配 `git push`。',
    }),
});

/**
 * `permission` 规则表：命名 surface 让编辑器给出针对性补全，
 * `catchall` 允许任意已注册工具名（FR-2）。
 */
const permissionSchema = z
  .object({
    "*": surfaceValueSchema
      .meta({
        description:
          "通用兜底。未设置时按 surface 默认矩阵裁决：读取类 allow，其余 review。一旦设置，会覆盖全部默认值。",
      })
      .optional(),
    path: surfaceValueSchema
      .meta({
        description: "敏感路径（语法糖，展开为 path_read + path_write，方向独立判定）",
      })
      .optional(),
    external_directory: surfaceValueSchema
      .meta({
        description:
          "工作目录之外（语法糖，展开为 external_directory_read + external_directory_write）",
      })
      .optional(),
    path_read: surfaceValueSchema.optional(),
    path_write: surfaceValueSchema.optional(),
    external_directory_read: surfaceValueSchema.optional(),
    external_directory_write: surfaceValueSchema.optional(),
    bash: surfaceValueSchema.optional(),
    powershell: surfaceValueSchema.optional(),
    read: surfaceValueSchema.optional(),
    write: surfaceValueSchema.optional(),
    edit: surfaceValueSchema.optional(),
    find: surfaceValueSchema.optional(),
    grep: surfaceValueSchema.optional(),
    ls: surfaceValueSchema.optional(),
  })
  .catchall(surfaceValueSchema)
  .meta({
    title: "规则表",
    description:
      '按 surface 组织。键可以是 "*"、path / external_directory 语法糖、方向键（*_read / *_write）、内置工具名（read / write / edit / find / grep / ls / bash / powershell）或任意已注册工具名。值可以是单个动作，也可以是模式到动作的映射。',
  });

/**
 * 单层配置（全局或项目）。所有字段都可省略：两层独立校验后再合并。
 * `z.infer` 得到的是"缺省值已填充"的输出类型，因此它是各层的完整形态。
 */
export const guardianConfigSchema = z
  .strictObject({
    $schema: z
      .string()
      .meta({ description: "本文件的 schema 位置，用于编辑器补全与校验" })
      .optional(),

    enabled: z
      .boolean()
      .default(true)
      .meta({ description: "总开关。关闭后 tool_call 直接放行，等同未安装。" }),
    yoloMode: z
      .boolean()
      .default(false)
      .meta({
        description:
          "逃生舱：把所有 ask / review 重写为 allow（FR-53）。开启时状态栏必须显著提示。",
      }),
    auditLog: auditLogSchema.default(() => auditLogSchema.parse({})),
    debugLog: z
      .boolean()
      .default(false)
      .meta({
        description:
          "调试日志：额外记录 facts 全文与评审提示词，可能含会话内容，默认关闭。",
      }),

    gate: z
      .enum(["side-effect", "all"])
      .default("side-effect")
      .meta({
        description:
          "评估范围（architecture §4.0）。side-effect=全部 pi 内置工具；all=额外包含自定义工具与 MCP 工具。它决定哪些调用进入规则求值，不是哪些会被拦截。",
      }),
    extraTools: z
      .array(z.string().min(1))
      .default([])
      .meta({
        description: "在 gate 之外额外评估的工具名，例如 subagent。",
      }),

    onReviewUnavailable: failureBranchActionSchema
      .default("deny")
      .meta({
        description:
          "评审不可用（超时 / 模型报错 / 输出非法 / 模型未配置）时的动作（FR-19、§9）。不允许 allow。",
      }),
    onUnresolvedFacts: failureBranchActionSchema
      .default("review")
      .meta({
        description:
          "facts 不可信（bash 解析失败、包装器内部不可展开、路径非字面量）时的动作（FR-12、FR-14、FR-15）。不允许 allow。",
      }),
    onAskWithoutUI: failureBranchActionSchema
      .default("deny")
      .meta({
        description:
          "需要人工确认但没有交互界面（print / json 模式、后台子代理）时的动作（FR-46）。不允许 allow。",
      }),
    onMixedCommandActions: z
      .enum(["deny", "ask", "review"])
      .default("deny")
      .meta({
        description:
          "同一 shell 调用的多个已解析命令单元同时得到 allow 与 deny 时的调用级动作（FR-59）。不能配置为 allow；global/default 定义基线，project 仅能按 deny > ask > review 收紧。",
      }),

    reviewer: reviewerSchema.default(() => reviewerSchema.parse({})),
    userBashPolicy: userBashPolicySchema.default(() =>
      userBashPolicySchema.parse({}),
    ),
    classifier: classifierSchema.default(() => classifierSchema.parse({})),
    circuitBreaker: circuitBreakerSchema.default(() =>
      circuitBreakerSchema.parse({}),
    ),
    cache: cacheSchema.default(() => cacheSchema.parse({})),
    sessionGrants: sessionGrantsSchema.default(() =>
      sessionGrantsSchema.parse({}),
    ),
    subagentPolicy: subagentPolicySchema.default(() =>
      subagentPolicySchema.parse({}),
    ),
    workingDirectory: workingDirectorySchema.default(() =>
      workingDirectorySchema.parse({}),
    ),

    permission: permissionSchema.default({}),
  })
  .meta({
    title: "pi-permission-guardian 配置",
    description:
      "pi-permission-guardian 扩展的配置结构。字段语义见 docs/configuration.md，需求依据见 docs/requirements.md。所有字段均可省略，因为全局层与项目层是合并的，局部配置必须能独立通过校验。",
  });

/** 单层配置（缺省值已填充）。 */
export type GuardianConfig = z.infer<typeof guardianConfigSchema>;
/** 单层配置的输入形态（所有字段可选）。 */
export type GuardianConfigInput = z.input<typeof guardianConfigSchema>;

/** 四种动作的取值类型。 */
export type Action = z.infer<typeof actionSchema>;

/**
 * 动作严格度序（FR-6）：`deny > ask > review > allow`。
 *
 * `ask` 排在 `review` 之前：写 `ask` 的意图是"我要亲自看"，它必须能压过任何模型判定。
 * 这里与动作枚举定义放在一起，是为了让跨层合并且只有一个严格度来源；
 * M3 的 `policy/action.ts` 会把它作为面向策略层的入口再导出。
 */
const ACTION_STRICTNESS: Record<Action, number> = {
  deny: 0,
  ask: 1,
  review: 2,
  allow: 3,
};

/**
 * 比较两个动作的严格度：负数表示 a 更严格。
 */
export function compareActions(a: Action, b: Action): number {
  return ACTION_STRICTNESS[a] - ACTION_STRICTNESS[b];
}

/**
 * 取最严格者；空集合返回 `fallback`。
 *
 * `fallback` 必须由调用方显式给出，避免出现"默认放行"这种隐含失败方向；
 * 类型参数保留收窄后的联合类型（例如 `subagentPolicy.defaultAction` 不接受 `allow`）。
 */
export function mostRestrictiveAction<T extends Action>(
  actions: readonly T[],
  fallback: T,
): T {
  if (actions.length === 0) {
    return fallback;
  }
  let strictest = actions[0] as T;
  for (const action of actions) {
    if (ACTION_STRICTNESS[action] < ACTION_STRICTNESS[strictest]) {
      strictest = action;
    }
  }
  return strictest;
}

export const GUARDIAN_SCHEMA_ID =
  "https://raw.githubusercontent.com/deqiying/pi-permission-guardian/main/schemas/guardian.schema.json";

/**
 * 生成发布用 JSON Schema（Draft 2020-12）。
 *
 * `io: "input"` 是刻意的：输出形态会让带默认值的字段变成 `required`，而局部配置必须能省略任意字段。
 */
export function buildGuardianJsonSchema(): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(guardianConfigSchema, {
    target: "draft-2020-12",
    io: "input",
  });
  return { $schema, $id: GUARDIAN_SCHEMA_ID, ...rest };
}
