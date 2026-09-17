# 配置说明

配套文件：

- 参考配置：[`config/config.json`](../config/config.json) —— **严格 JSON**（无注释），带 `$schema`，可直接复制后修改
- 逐字段讲解示例：[`config/config.example.jsonc`](../config/config.example.jsonc) —— 与本文档逐节对应的 JSONC 示例，每个字段带 `//` 说明；规则表只列代表项，完整清单与可直接使用的基线见参考配置
- Schema：[`schemas/guardian.schema.json`](../schemas/guardian.schema.json) —— 编辑器补全与实时校验的来源
- 需求依据：[`docs/requirements.md`](requirements.md)（FR 编号）、[`docs/architecture.md`](architecture.md)（章节编号）

---

## 1. 文件位置与加载

| 作用域 | 路径 | 生效条件 |
|---|---|---|
| 全局 | `<agentDir>/extensions/pi-permission-guardian/config.json` | 始终加载 |
| 项目 | `<cwd>/.pi/extensions/pi-permission-guardian/config.json` | 仅当 `ctx.isProjectTrusted()` 为真（FR-48） |

`<agentDir>` 默认为 `~/.pi/agent`（受 `PI_CODING_AGENT_DIR` 影响）。

**加载时机**：`session_start` 与 `before_agent_start` 各重读一次（重新读盘 + 重新合并），因此改配置不必重启会话；也可用 `/perm reload` 手动触发（FR-52）。

### 1.1 为什么参考配置没有注释

`config/config.json` 是严格 JSON，这是刻意的：

- 原生 `JSON.parse` 无法解析带注释的 JSON，注释必须靠前置剥离器绕开
- 更关键的是，带注释会让 `$schema`（编辑器补全 + 实时校验）失去价值，而**活的 schema 比死的注释更有用**
- 解释放在本文档，可以写得更长、更有组织，还能引用 FR 编号

### 1.2 输入侧的宽容度

**你手写的配置可以带注释与尾逗号**（FR-49）：支持 `//`、`/* */` 以及对象/数组末尾多余的逗号。字符串字面量内的 `//` 不会被误判。

一个实现约束（FR-49 的验收标准）：剥离注释后 `JSON.parse` 报出的行列号**必须与原文对齐**。因此剥离器会把被删除注释中的换行原样保留，而不是整段丢弃——否则你漏写一个引号，错误却指向十几行之外。

config 解析失败时 fail-closed：该层的所有 `allow` 抬升为 `ask`，并提示具体错误位置（FR-51）。

### 1.3 失效层的处理（FR-51 / FR-63）

一层配置坏掉时，处理目标是“既不静默放行，也不连带丢掉用户显式写的 `deny`，并且保守落点必须可执行”：

| 情况 | 处理 |
|---|---|
| JSON 语法错误（无法读出任何字段） | 该层整体不生效，报出原文行号；未命中规则的默认动作按保守侧处理（转人工确认） |
| JSON 合法但校验失败 | 把 `allow` 抬升为 `ask`（包括 `permission` 规则和三个失败分支开关），再按“顶层字段 → surface → 单条模式规则”逐级重新校验：合法部分继续生效，非法部分被忽略并逐条列出 |
| 抬升后仍无任何可用字段 | 该层整体不生效，等同于上一条 |

抢救粒度是刻意的：`permission` 里写错一条规则，只会丢掉那一条，同一层里其余 `deny` 仍然生效。

三个失败分支开关默认落在保守侧（见 §4），写错时（枚举之外的值）该字段被丢弃并落回更严格的默认值（`deny` / `review` / `deny`）；**在失效层里配了 `allow` 也会被抬升为 `ask`**，因为读不完整的配置层不可信。

“未命中规则的默认动作按保守侧处理”指：存在失效层时，未命中规则的调用一律转人工确认——默认动作矩阵里的 `allow` 与 `review` 都抬到 `ask`（`ask` 在 `deny > ask > review > allow` 里比 `review` 更严格）。原因很直接：坏配置里可能原本就有一条 `deny`，我们读不出来，就不能假定它不在；而**评审模型配置也来自同一份坏配置**，所以“交给模型复查”不能当保守侧用——`reviewer` 是 `strictObject`，段内任一字段写错就会整段被抢救掉，`review` 只会落成 `onReviewUnavailable`（默认 `deny`），把“配置写错”变成无差别拦截（D26 / FR-63）。

这条不靠求值器额外记一个"配置有坏层"的开关，而是落在合成结果里：`/perm status` 会直接显示合成默认已收紧（architecture §6.1）。

被抬升的只有动作取值本身；规则模式、`reason` 文本与其余配置字段都原样保留。

一条**默认值**例外（D26 / FR-63）：存在失效层且 `onReviewUnavailable` 未被任何层提供合法取值时，合成结果把它的默认值回退为 `ask`——失效层可能原本写着 `deny`，但也可能正是丢掉 `reviewer.model` 的那一层，此时 `deny` 只会把“配置写错”伪装成与评审模型相关的风险拦截。显式写过的**合法**取值（含 `deny` / `allow` / `review`）不受影响；写成枚举之外的值等价于未设置（该字段已被逐字段抢救丢弃）。

不受本机制影响的两处：内置只读命令白名单（FR-9）仍是 `allow`——它是**事实层**的“已证明对工作目录无副作用”，不是策略默认值；对象级 `onUnresolvedFacts` 分支也不参与默认矩阵的抬升，其落点由配置决定（默认 `review`）。

失效层也不参与 `yoloMode` 投票（D27）：`yoloMode: true` 写在一个失效层里不会生效，否则它会把上面的 `ask` 落点整个重写成 `allow`（同一份不可信配置里写的 `allow` 已经被抬成 `ask`，不能让同一个层再把它放开）。健康层里显式写的值不受影响。

### 1.4 配置根本没加载出来（FR-64）

`runtime.config === undefined` 表示会话未启动，或加载过程抛了异常（例如 `/perm on` 在加载前强制启用）。此时读不到任何字段，保守落点是：

- 按 schema 默认 `gate`（`side-effect`：pi 内置工具）纳入裁决的调用 → 转人工确认，理由写明“配置未加载”。
- 无交互界面 → `deny`（读不到 `onAskWithoutUI`，按 fail-closed）。
- 该状态下**不创建会话授权**：`sessionGrants` 读不出来，不猜。
- 不因为“配置读不出来”就把自定义 / MCP 工具也拉进裁决。安全方向应当是“转人工”，不是“扩大拦截面”。

## 2. 顶层开关

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。关闭后 `tool_call` 立即返回，等同未安装 |
| `yoloMode` | `false` | 逃生舱：把所有 `ask` / `review` 重写为 `allow`。开启时状态栏必须显著提示（FR-53）；失效层里的取值不参与（D27，见 §1.3） |
| `auditLog` | 对象 | 决策审计日志配置。固定按进程本地日期切分，默认保留 14 天（FR-43/44） |
| `debugLog` | `false` | 额外记录 facts 全文与评审提示词。**可能含会话内容**，默认关闭 |

`yoloMode` 与 `enabled` 的区别：`enabled: false` 让护栏完全不参与；`yoloMode: true` 让护栏继续评估、继续记账，只是不拦。排查"某条规则是否命中"时用 `yoloMode` 更合适。

`enabled: false` 是"默认不参与"，不是"永久失效"：`--perm` flag 或 `/perm on` 仍可让本会话参与裁决，实际是否生效按 `会话覆盖 > --perm / config.enabled` 的顺序决定。`/perm status` 会同时打印这四个值，便于确认当前状态。

审计日志字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `auditLog.enabled` | `true` | 是否写入 JSONL 审计日志 |
| `auditLog.retentionDays` | `14` | 保留的自然日数量，包含当天。启动及跨日首次写入前清理更早的日志 |

日志文件固定为 `guardian-YYYY-MM-DD.jsonl`，日期按 pi 进程本地时区计算。清理失败只记录告警，不影响工具裁决。

## 3. 评估范围

| 字段 | 默认 | 说明 |
|---|---|---|
| `gate` | `"side-effect"` | `side-effect` = 全部 pi 内置工具（`bash`/`powershell`/`read`/`write`/`edit`/`find`/`grep`/`ls`）；`all` = 额外包含自定义工具与 MCP 工具 |
| `extraTools` | `[]` | 在 `gate` 之外额外评估的工具名，例如 `"subagent"` |

**`gate` 决定"哪些工具调用进入规则求值"，不是"哪些会被拦截"**（architecture §4.0）。规则求值是内存 glob 匹配，成本可忽略；真正贵的是评审调用，由默认动作矩阵控制。

反例：不要为了"省成本"把读取类工具排除在 `gate` 之外 —— 那样 `path` 中的 `*.env → deny` 对 `read ./.env` 永远不会生效，敏感文件保护会出现真实缺口。

## 4. 失败与冲突语义

三个失败开关分别对应三类"不确定"状态，默认全部落在保守侧（FR-46、architecture §9）；`onMixedCommandActions` 处理确定的跨命令单元动作冲突（FR-59）。唯一的默认值例外是“存在失效层且 `onReviewUnavailable` 未被显式设置”时回退为 `ask`（§1.3、FR-63）。

| 字段 | 默认 | 触发场景 |
|---|---|---|
| `onReviewUnavailable` | `"deny"` | 评审超时 / 模型报错 / 输出无法解析 / `reviewer.model` 未配置（FR-19） |
| `onUnresolvedFacts` | `"review"` | bash 解析失败、包装器（`bash -c`、`sudo`、`xargs`）内部不可展开、路径非字面量（FR-12/14/15） |
| `onAskWithoutUI` | `"deny"` | 需要人工确认但没有交互界面：`print` / `json` 模式、无 UI 的子代理会话 |
| `onMixedCommandActions` | `"deny"` | 同一 shell 调用的多个已解析命令单元中，同时存在裁决结果为 `allow` 与 `deny` 的单元 |

这三个失败开关默认 fail-closed（`deny` / `review` / `deny`），但**允许显式配 `"allow"`**（D7）：配成 `allow` 后，评审不可用时直接放行——离线环境确实可能需要这个行为。要清楚这意味着什么：`unavailable` 是基础设施结果，不是安全结论，一旦配成 `allow`，“拔网线 / 配错模型名 / 解析不了”就成了绕过手段。整体放宽护栏时仍推荐 `yoloMode`（会写审计日志并在状态栏显著提示），而不是就地埋一个静默开关。枚举之外的值仍被当作非法值（该字段被忽略并落回默认值，同时提示配置失效）。

`onReviewUnavailable` 默认 `deny` 的理由：`unavailable` 是基础设施结果，不是安全结论。若放行，等于让"拔网线 / 配错模型名"成为绕过手段。**例外**：存在失效层且该字段未被任何层显式设置时，默认值回退为 `ask`（§1.3、FR-63）——因为此时“评审本来应该能用”这个前提本身就不成立。

四个取值的共同语义与各自的边界：

| 取值 | 行为 | 边界 |
|---|---|---|
| `deny`（默认） | 拦截 | 存在失效层且该字段未被显式设置时，默认值回退为 `ask`（§1.3、FR-63） |
| `ask` | 转人工确认 | 无 UI 时再由 `onAskWithoutUI` 接手 |
| `allow` | 放行 | 理由里显式标明“本次放行由配置决定，不是评审结论” |
| `review` | 同 `deny` | 评审已经不可用，“再评审一次”不是可执行的落点，因此 fail-closed |

拦截时的提示文案有硬要求（FR-27）：必须说明"评审未完成，不代表因风险被拒"，避免 agent 把基础设施故障学成"这个操作不安全"。

`unresolved` 不能覆盖明确 `deny`：如果同一调用中既有无法静态确定的 facts，又有至少一个可信对象明确命中 `deny`，最终动作固定为 `ask`（FR-61），而不是继续按 `onUnresolvedFacts` 的 `review` 处理。若没有明确 `deny`，才使用 `onUnresolvedFacts`。

### 4.1 多命令单元的 allow / deny 冲突

`onMixedCommandActions` 只允许配置为 `"deny"`、`"ask"` 或 `"review"`，不能配置为 `"allow"`。它不会改变单个对象内部的规则裁决，只负责给调用级的 `allow` / `deny` 冲突选择最终动作：

| 多个命令单元的动作组合 | 最终动作 |
|---|---|
| `allow + deny` | `onMixedCommandActions`，默认 `deny` |
| `allow + review` | `review` |
| `allow + ask` | `ask` |
| `deny + review` / `deny + ask` / 多个 `deny` | `deny` |

例如：

```bash
echo ok && rm -rf /
```

默认得到 `deny`；配置 `"onMixedCommandActions": "review"` 后，整条调用交给评审模型；配置为 `"ask"` 后交给人工确认。

该字段是安全敏感项，全局层未配置时基线为 `deny`，全局层可以显式选择 `ask` / `review` / `deny`；项目层再按 `deny > ask > review` 与全局层取最严格者。项目配置只能把全局的 `review` 收紧为 `ask` / `deny`，不能把默认或全局的 `deny` 放宽为 `ask` / `review`。`yoloMode=true` 仍可把所有 `ask` / `review` 重写为 `allow`，这是总逃生舱的既有语义。

### 4.2 安全敏感字段的跨层合并

`onMixedCommandActions`、`userBashPolicy`、`subagentPolicy` 都是"跨层只能收紧"的字段，合并规则如下（FR-56、FR-60）：

| 字段 | 合并规则 |
|---|---|
| `onMixedCommandActions` | 基线 = 全局层的显式取值（全局层没写就是 `deny`）；项目层只能在此基础上按 `deny > ask > review` 收紧 |
| `userBashPolicy.enabled` | 任一层显式配置为 `true` 即保持拦截 |
| `userBashPolicy.autoReview` | 任一层显式配置为 `false` 即转人工确认 |
| `userBashPolicy.model` | 更具体的一层覆盖（项目层写 `null` 表示显式回到 `reviewer.model`） |
| `subagentPolicy.enabled` | 任一层显式配置为 `true` 即启用子代理策略 |
| `subagentPolicy.defaultAction` | 在显式配置的层之间按 `deny > ask > review` 取最严格者 |
| `subagentPolicy.allowSessionGrants` | 任一层显式配置为 `false` 即禁止子代理创建或使用会话授权 |

`onMixedCommandActions` 的基线特殊：它始终参与比较，所以**只写项目层**的 `review` 不会把默认或全局的 `deny` 放宽；全局层写了 `review`、项目层写 `ask` 时结果为 `ask`。

其余字段遵循**"没有写该字段的层不投票"**：默认值不参与这些跨层收紧判断，否则会出现两个反直觉后果：全局层关掉 `userBashPolicy.enabled` 会被一个只改了 `model` 的项目层用默认值重新打开；项目层只是没写 `defaultAction`，却用默认 `review` 收紧了全局层显式配置的 `ask`。所有层都没写该字段时，才落到 schema 默认值。

## 5. 评审器

| 字段 | 默认 | 说明 |
|---|---|---|
| `model` | 无 | **使用评审即必填**。格式 `provider/model-id`，只能引用 pi 模型配置文件中已存在的模型 |
| `reasoningEffort` | `null` | 评审调用的推理强度，见 §5.1.1。`null` 表示不发送任何推理参数 |
| `timeoutMs` | `20000` | 单次评审的硬性 deadline（FR-25） |
| `maxEvidenceRounds` | `3` | 评审模型调用只读证据工具的轮次上限，`0` 关闭证据循环（FR-24） |
| `evidenceTools` | `true` | 是否允许评审模型用 `read`/`grep`/`find`/`ls` 自行查证 |
| `transcript` | `true` | 是否把会话 transcript 提供给评审模型 |
| `transcriptBudgetChars` | `24000` | transcript 字符预算 |
| `maxAllowRiskLevel` | `"medium"` | 风险门槛（FR-23），见下 |

### 5.1 为什么 `model` 不回退到当前会话模型

评审模型必须显式配置，未配置时判为 `unavailable` 而不是拿当前会话模型顶上（D6）。理由是**审查独立性**：让被审查者用自己的模型批准自己，等于把授权与执行合并到同一主体，护栏在语义上就不成立了。

模型必须通过 `ctx.modelRegistry.find` 解析，再用 `ctx.modelRegistry.complete` 调用。请求协议沿用模型自身配置的 `api`，插件不提供 `api`、`baseUrl`、认证或 headers 覆盖项，因此实际请求协议不会与 pi 模型配置漂移。

### 5.1.1 推理强度（`reasoningEffort`）

`reasoningEffort` 是插件唯一会自己写入的请求字段，取值与 pi 的思考级别一致：`minimal` / `low` / `medium` / `high` / `xhigh` / `max`。**默认 `null` 表示不发送任何推理参数**——插件没有自己的强度策略，不配就完全交给该模型与协议的默认行为（对 DeepSeek 这类在缺省时显式关闭思考的接口，也就是不思考）。

字段名由模型的 `api` 决定，插件不选择协议：

| `model.api` | 实际写入的请求字段 |
|---|---|
| `openai-completions` / `openai-responses` / `azure-openai-responses` / `openai-codex-responses` | `reasoningEffort` |
| `bedrock-converse-stream` / `pi-messages` | `reasoning` |
| `anthropic-messages` | `thinkingEnabled: true` + `effort`（`minimal` 归并为 `low`） |
| `google-generative-ai` / `google-vertex` / `mistral-conversations` | 不支持，配了即 `unavailable` |

级别会先按模型的 `thinkingLevelMap` 归一（与 pi 主会话同一套 clamp 规则），归一为 `off`（例如模型 `reasoning: false`）时不发送任何参数。若配置了强度而该协议表达不了它，评审判为 `unavailable`（`not-configured`）而不是静默忽略：把“要求的审慎程度”和实际发出的请求说成两回事，等于让一次弱评审冒充独立判断。

`reviewer.reasoningEffort` **不影响** `user_bash` 与预评分：两处各用自己的同名字段，见 §5.3 与 §6.1。

### 5.2 风险门槛

模型给出 `allow` 时不会无条件放行：

| 模型 verdict | `riskLevel` | 结果 |
|---|---|---|
| `allow` | `low` / `medium` | 放行 |
| `allow` | `high` / `critical` | **转为人工确认**（无 UI 则按 `onAskWithoutUI`） |
| `deny` | 任意 | 拦截 |

`maxAllowRiskLevel` 就是这个分界线。把它调到 `"low"` 会让更多 allow 转人工；调到 `"high"` 则更信任模型。弱模型给出低质量 allow 的代价是安全侧的单向失败，所以默认不设在最高。

`reviewer.model` 未配置、格式非法、或在 pi 模型配置里找不到时，不算“评审拒绝”，而是 `unavailable` → `onReviewUnavailable`。

模型输出缺字段时按保守方向补齐（FR-21）：**缺 `riskLevel` 的 allow 会被当成 `high`**，于是落到上表的“转为人工确认”一行；缺 `userAuthorization` 当作 `unknown`；`rationale` 缺失时用占位文本，避免审计与拦截理由出现空串。这套回填只影响缺失字段，不会把一个完整的 `deny` 改成别的。

### 5.3 用户直接执行 `!command` / `!!command`

`!command` 是 pi 交互输入框中的用户直接 shell 命令，命令输出会在下一次模型请求时进入上下文；`!!command` 执行方式相同，但输出不加入模型上下文。两者都会触发 pi 的 `user_bash` 事件。

| 字段 | 默认 | 说明 |
|---|---|---|
| `userBashPolicy.enabled` | `true` | 是否让用户直接执行的命令经过本插件 |
| `userBashPolicy.autoReview` | `true` | `review` 动作是否自动调用评审模型；关闭时转人工确认 |
| `userBashPolicy.model` | `null` | 自动审核模型；只能引用 pi 模型配置中的模型，`null` 表示复用 `reviewer.model` |
| `userBashPolicy.reasoningEffort` | `null` | 自动审核的推理强度，取值同 §5.1.1；`null` 表示不发送推理参数（不随 `model` 回落） |

`user_bash` 与 `tool_call` 复用同一 facts、规则、授权、评审和审计管线，仅最终执行适配不同：`allow` 返回正常 shell 执行；`deny` 返回替代 `BashResult`（`{output: "<理由>\n", exitCode: 1, cancelled: false, truncated: false}`）并让真实命令不启动；`review` 按本节自动审核。`!!` 与 `!` 的安全裁决与替代结果完全相同（`excludeFromContext` 由 pi 在记录结果时处理，不由插件改写）。用户直接输入命令本身不创建会话授权；只有人工确认对话框中的“本会话允许此类”才能创建。

跨全局/项目层合并时采用保守方向：任一层 `enabled=true` 时保持拦截；任一层 `autoReview=false` 时转人工确认；`model` 与 `reasoningEffort` 可由更具体的配置覆盖（显式 `null` 也按“更具体”生效）。

共存冲突只检测和提示，不强制。插件通过 `pi.events` 声明自己的 `user_bash` claim；检测到另一声明时在 UI/日志中提示，并在 `/perm status` 标记冲突。不会改变扩展加载顺序，也不会为了抢回事件而重复拦截。pi 当前不暴露扩展枚举，因此对“未声明且排在前面的拦截器”只能记录为不可观测边界。

## 6. 降本机制

### 6.1 非阻塞预评分

| 字段 | 默认 | 说明 |
|---|---|---|
| `classifier.enabled` | `false` | 见下方警告 |
| `classifier.model` | `null` | 缺省复用 `reviewer.model` |
| `classifier.reasoningEffort` | `null` | 预评分调用的推理强度，取值同 §5.1.1；`null` 表示不发送推理参数（预评分是便宜路径，不继承评审强度） |
| `classifier.timeoutMs` | `15000` | |
| `classifier.maxLag` | `2` | 评分对应的调用序落后当前超过此值时，快路径失效（FR-37） |

> **语义警告**：预评分的实际语义是"先放行、后判定"。它在 `tool_result` 之后异步给轨迹打分，打分低风险时让**下一次**调用走快路径直接放行。它与护栏的保守取向相反，因此默认关闭（D8）。

开启后的安全边界（FR-36~38）：预评分**只会放行，永不产生 deny**；评分失败记为 `failure` 而不是"低风险"；被 `deny` 过的工具在同一轮内不得享受快路径。

### 6.2 熔断器

| 字段 | 默认 | 说明 |
|---|---|---|
| `consecutiveDenials` | `3` | 同一轮内连续拒绝达到此值即拦截并提前结束本轮（FR-34） |
| `recentDenials` | `10` | 窗口内拒绝总数阈值 |
| `windowSize` | `50` | 上面那个窗口的大小 |

任一阈值设为 `0` 表示关闭该条件。熔断器每轮重置（`turn_start`）；被 `deny` 过的工具在同一轮内失去全部快路径（缓存 / 授权记忆 / 预评分），因为同轮重试最接近"换个写法绕过"。

### 6.3 缓存与会话授权

| 字段 | 默认 | 说明 |
|---|---|---|
| `cache.enabled` | `true` | 判定缓存（FR-31~33） |
| `cache.ttlMs` | `300000` | 存活时间 |
| `cache.maxEntries` | `200` | 容量上限 |
| `sessionGrants.enabled` | `true` | 会话授权记忆（FR-29/30） |

两者都**仅存在于内存**：缓存与授权记忆在 `session_shutdown` 时清空，不落盘。

缓存有两处刻意的不宽容：只缓存确定的 `allow` / `deny`，**不缓存 `unavailable`**（否则一次网络抖动会在 TTL 内固化成"这条路永远超时"）；facts 带 `unresolved` 时跳过缓存。

缓存与授权记忆都随**用户授权版本**失效——以用户消息文本指纹为准。你追加一句新指令后，此前基于旧前提的判定全部作废。

会话授权只能由人工确认创建。评审模型 allow、缓存命中、自动审核或用户手输 `!command` 本身都不会写入 grant（FR-29）。

### 6.4 子代理策略

| 字段 | 默认 | 说明 |
|---|---|---|
| `subagentPolicy.enabled` | `true` | 检测到子代理会话时启用独立策略 |
| `subagentPolicy.defaultAction` | `"review"` | 规则未命中时的子代理默认动作，可为 `deny` / `ask` / `review`，禁止 `allow` |
| `subagentPolicy.allowSessionGrants` | `false` | 子代理是否可创建或使用会话授权 |

父子会话的授权记忆、缓存和熔断始终不共享。`subagentPolicy` 只收紧**默认动作矩阵**那一层，不会放宽父配置中的显式规则：用户显式规则（`allow` 与 `deny` 都算）、只读命令白名单（FR-9）与 `onUnresolvedFacts` 的分支都保持原语义，`path_read` / `path_write` 也仍然不单独表态。检测能力和加载方式取决于子代理实现，`/perm status` 必须显示当前子代理会话是否被识别及实际生效策略。

跨层合并时，任一层 `enabled=true` 时启用子代理策略；`defaultAction` 按 `deny > ask > review` 取最严格者；任一层 `allowSessionGrants=false` 时子代理都不能创建或使用会话授权。

`yoloMode=true` 仍然只重写 `ask` / `review`（FR-53），因此 `defaultAction` 配成 `deny` 时产生的默认拦截不会被逃生舱放宽：逃生舱的语义是"不再为需要判断的动作停下来"，而不是"忽略一条默认动作"。要整体放行子代理，应改这个字段或把 `subagentPolicy.enabled` 配成 `false`（后者会回到父策略的默认动作矩阵）。

v1 只兼容 `@gotgenes/pi-subagents` v21.7.1。绑定握手与子会话 registry 都放在进程级存储里（父子扩展实例的事件总线是按会话的，不互通）。父会话在 `bound` 后未收到子扩展握手时：有 UI 使用 warning 通知（每个父会话只提示一次），无 UI 写入 `console.warn`，同时为每个受影响的子会话写入 `pi-permission-guardian.subagent-warning.v1` 会话条目，并把 `/perm status` 标为 `unguarded`。未识别（其他子代理实现或父实例未加载护栏）时显示“未识别，使用父策略”。

## 7. 工作目录与只读免评审

| 字段 | 默认 | 说明 |
|---|---|---|
| `allowRoots` | `[]` | 视为"内部"的额外根目录 |
| `readOnly.profiles` | `["search", "vcs-read", "nav", "text-read", "print", "system"]` | 启用的内置只读档案分组（FR-65 / D28） |
| `readOnly.commands` | `[]` | 自定义只读档案（字符串或对象），排在分组之前 |
| `readOnly.unsafeOptions` | `[]` | 用户级全局选项黑名单，对所有档案生效，跨层取并集 |
| `readOnly.commands[].onlyWithinRoots` | `false` | 免评审要求目标在项目根内（用于 `cd` 这类导航命令） |
| `readOnly.sinks` | `[]` | 额外的"写入不算副作用"的目标（FR-67），跨层取交集 |
| `readOnlyCommands` | 内置高置信集合；显式配置时完整覆盖 | 旧的字符串白名单（仍然有效，语义不变） |

`allowRoots` 用于 monorepo：把兄弟包路径加进来，避免项目间的正常读写被判定为外部目录访问。例如 `["../shared-lib", "~/dev/monorepo"]`。

### 7.1 免评审的两张名单

免评审（命中即 `allow`，不产生评审调用）由**档案 + 选项名单**共同决定：

- **档案**说明"这条命令本质只读"：`argv` 前缀（可执行名 + 参数）+ 每个位置参数的**角色**；
- **选项名单**说明"这些选项会写文件 / 执行程序 / 改工作目录"：命中即取消免评审。

只看前缀的旧做法有两个不可接受的后果：把 `rg` 关在白名单外，每次搜索都要一次模型评审；把 `rg` 放进去，`rg --pre <程序>` 就会直接放行（实测每个被搜文件 spawn 一次）。角色与选项名单让"默认免评审"和"不放行危险写法"同时成立。

档案来源有三类，**顺序即优先级**（第一个命中的档案生效）：

```text
用户条目（readOnly.commands） → 内置分组（readOnly.profiles） → 旧字符串白名单（readOnlyCommands）
```

因此想收紧某条内置档案，只要写一条更具体的同名 `argv` 条目即可（例如把 `rg` 的 `unsafeOptions` 写得更长）。

### 7.2 位置参数角色

| 角色 | 含义 | 例子 |
|---|---|---|
| `paths` | 文件/目录路径：产出 **read** 方向的路径目标；取值不可静态确定时整条命令降级为不可信 | `cat f.txt`、`rg -n x src/` 的 `src/` |
| `pattern` | 模式/正则/命令名，**不是文件**：不产出路径目标，取值动态也不影响免评审 | `rg -n "\.env" src/` 的 `"\.env"`、`which node` 的 `node` |
| `script` | 一段**脚本代码**：必须**整体命中** `script` 里的正则集，否则取消免评审 | `sed -n '1,10p' f` 的 `'1,10p'` |

角色缺省是 `["paths"]`（等价于旧字符串条目的行为）；序列最后一项吸收剩余位置参数；角色写 `[]` 表示**不允许位置参数**（`git branch <新分支名>` 会造分支，所以 `git branch` 档案就是这样写的）。

### 7.3 选项名单

档案对"选项"有三类声明，回答三个不同的问题：

| 声明 | 回答的问题 | 效果 |
|---|---|---|
| `unsafeOptions` | 这个选项会**写文件 / 执行程序 / 改工作目录**吗？ | 命中即取消免评审（`unsafe-option:<opt>`） |
| `safeOptions` | 这个选项键**安全**吗？ | `allow-list` 下只有列出的选项安全；`deny-list` 下它同时豁免"`--opt=<像路径>` 取消"的形状规则 |
| `nonFileValueOptions` | 这个选项的**取值是文件**吗？ | 取值为"不是文件"（模式、数字、类型名、关键字）时：不产出路径目标、不占位置参数角色槽、不因"取值像路径"取消免评审 |

选项策略（只有 `allow-list` / `deny-list` 两种）：

| 策略 | 含义 | 适用 |
|---|---|---|
| `deny-list`（默认） | 未列出的选项默认安全；命中 `unsafeOptions` 即取消 | 选项集合稳定的命令（`rg`、`grep`、`sort`、`cat`） |
| `allow-list` | **只有** `safeOptions` 列出的选项安全，其余一律取消 | 危险选项密集的命令（`find` 的 `-delete`/`-fprint`/`-exec`、`git branch` 的 `-d`/`-D`/`-m`/`-f`） |

要点：

- `unsafeOptions` / `safeOptions` / `nonFileValueOptions` 按**词前缀**匹配：`--pre` 同时覆盖 `--pre=x` 与 `--pre-glob`（宁可多取消）。
- `unsafeOptions` 的依据只有两类：**写文件**（`--output`、`sort -o`）与**执行程序**（`rg --pre`、`sort --compress-program`、`git --ext-diff`、`git grep -O`、`git -c`）。后者破坏面更大，也最容易漏。取消判定**先于**另外两类声明：同一选项同时列进 `unsafeOptions` 时仍然取消。
- `nonFileValueOptions` 解决的是"选项取值被当成文件"：`find . -name '*.pem'` 的 `'*.pem'` 是模式，声明后它不再变成读路径（不会撞上你自己的 `*.pem: deny`），`head -n 5 f` 的 `5`、`git blame -L 1,10 f` 的 `1,10` 也不再是幽灵路径。`-opt value` 与 `-opt=value` 两种写法都生效；`-A3` 这类粘写短选项不会被误当成"要吃下一个词"。
- **只声明取值确定不是文件的选项**：不确定就不声明，保持旧口径（取值像路径时取消免评审）。`find -newer f.txt` 的取值是真文件，因此 `-newer` 不在名单里，读路径照常产出。
- 有些选项**故意不声明**：`rg -e <pattern>` / `grep -e` / `git grep -e` 的取值会自然地落在 `pattern` 角色槽上，声明反而会把后面的真实路径挤到模式位置。判断规则是"这个取值在角色序列里会不会自然落在正确的位置"。
- 未声明档案的命令**不看**这些名单，行为与旧实现一致（D29）。

### 7.4 内置分组

| 分组 | 默认 | 内容与要点 |
|---|---|---|
| `search` | 开 | `rg`（`unsafeOptions: --pre / --hostname-bin`，`safeOptions: -g / --glob / --type`）、`grep`、`find`（allow-list；谓词取值声明为 `nonFileValueOptions`） |
| `nav` | 开 | `cd` / `pushd`，都带 `onlyWithinRoots`：**目标必须落在项目根内**免评审（`cd src` ✓、`cd ..` / `cd /tmp` / `cd ~` 不免）。要求至少一个位置参数且全部目标非 external，因此无参数 `cd`（回家目录）、`cd -`、`popd`（目标是栈顶）都不免 |
| `text-read` | 开 | `cat` `head` `tail` `wc` `nl` `od` `xxd` `file` `stat` `ls` `realpath` `tree`（`tree -o` 取消免评审；`head -n 5` / `ls -w 80` 的取值不是文件） |
| `print` | 开 | `echo` / `printf`，角色是 `pattern`：位置参数是**文本而不是文件**，因此不会产出读路径（`echo note.env` 不会撞 `*.env` 规则），写文件仍由重定向层面判定 |
| `system` | 开 | `date`（`-s`/`--set` 取消）、`du` `df` `lsof`、`which` `type`、`command -v` / `command -V`（查询，不执行参数）、`ps` `uname` `id` `whoami` `uptime` `nproc`、`hostname`（不允许位置参数） |
| `vcs-read` | 开 | `git status/diff/log/show/ls-files/ls-tree/rev-parse/blame/shortlog/describe/cat-file/for-each-ref/grep`（`unsafeOptions: --output / --ext-diff`，`git grep` 另加 `-O / --ext-grep`）、`git branch`（allow-list：只放行 `--show-current`、`-a`、`-v`、`--list` 等查询形式，且不允许位置参数）、`git remote -v`、`git worktree list`、`git stash list` |
| `text-tools` | **关** | `sort`（`-o`/`--output`/`--compress-program`/`-T` 取消）、`cut` `comm` `cmp` `diff` `tr` `jq`。**刻意不含 `uniq`**：`uniq [INPUT [OUTPUT]]` 的第二个位置参数是**输出文件**，而角色模型只能声明读路径，不声明写形态就不放行 |
| `meta` | **关** | 版本查询：`node --version`、`npm --version`、`python --version`、`tsc --version`、`git --version`、`rg --version` 等（前缀限定到具体旗标，因此裸 `node` **永远**不免评审） |

**明确不进内置分组**：`sed` / `awk` / `perl` / 裸 `node` / 裸 `python`（脚本体或程序体可写可执行）、`tee` / `unzip` / `tar`（写）、网络类命令（`curl` / `wget` / `gh` / `dig`）。判定方式是 argv，不是沙箱；别名、PATH 劫持、以及 `RIPGREP_CONFIG_PATH` 这类工具配置注入的执行点都在它的视野之外。

**透明前缀内推**（FR-12 修订 / D33）：`timeout` / `nice` / `ionice` / `stdbuf` / `nohup` / `time` / `env` / `command` 会被跳过，按**后面的命令**判定，最多 3 层：

| 调用 | 结果 |
|---|---|
| `timeout 5 cat f.txt`、`nice -n 5 cat f.txt`、`env FOO=1 rg -n x src`、`command cat f.txt` | 与内层命令同样免评审 |
| `timeout 30 rm -rf ./dist` | 外层文本与内层文本都参与规则匹配（`rm -rf ./dist*` 照样命中） |
| `sudo rm -rf /tmp/x`、`xargs rm`、`bash -c 'cat f'`、`timeout 5 $CMD f` | 仍是不透明包装器 → `onUnresolvedFacts`（默认 `review`） |
| `command -v rg` / `command -V rg` | 是**查询**而不是执行，由 `system` 分组的 `command -v` 档案免评审 |

跳过参数靠的是各命令文档化的语法（`timeout` 的 DURATION、`env` 的 `NAME=VALUE`、`-s KILL` 这类取值选项）；布局看不透时不内推，落到不透明分支。

### 7.5 自定义档案示例

只放行 `sed -n 'N,Mp' <file>` 这种形态（`sed` 默认不在内置分组里：`sed 'e …'` / `'s/x/y/e'` / `'1w out.txt'` / `-i` 实测都能执行命令或写文件）：

```json
{
  "workingDirectory": {
    "readOnly": {
      "commands": [
        {
          "argv": ["sed"],
          "roles": ["script", "paths"],
          "script": ["^[0-9]+(,[0-9]+)?p$", "^[0-9]+(,[0-9]+)?d$"],
          "optionPolicy": "allow-list",
          "safeOptions": ["-n", "--quiet", "--silent", "--posix"],
          "unsafeOptions": ["-i", "--in-place", "-e", "--expression", "-f", "--file"],
          "reason": "只放行 sed -n 'N,Mp' <file>"
        }
      ]
    }
  }
}
```

`script` 模式集是**白名单式**的（整体锚定，不匹配即取消），所以模式写松就等于失去保护；`-e` / `-f` 这类“换个地方给脚本”的选项必须同时进 `unsafeOptions`。配置层会拦住非法正则、以及“声明了 `script` 角色却没给模式集”这类写错。

### 7.6 空设备 sink（FR-67）

写 `/dev/null`（win32 还有 `NUL`）不产生路径目标、不算写副作用，因此 `ls 2>/dev/null`、`cat f > /dev/null` 免评审。要点：

- `/dev/null` 在 POSIX 与 win32 都是空设备（Windows 上的 pi 用 git-bash）；`NUL` **只有 win32** 是——POSIX 上的 `> NUL` 会真的在当前目录建一个叫 `NUL` 的文件，因此仍算写副作用。
- 项目里叫 `src/dev/null` 的文件**不是** sink。
- `readOnly.sinks` 只能**追加**额外目标（例如容器里的 `/dev/fd/3`），跨层取交集：追加 sink 等于放宽，下层不能单方面扩大。

### 7.7 旧字符串白名单 `readOnlyCommands`

`readOnlyCommands` 命中即 `allow`（FR-9），匹配方式是**命令单元的可执行名 + 参数前缀**：`"git status"` 匹配 `git status --short`，但不匹配 `git push`。它等价于一条 `roles: ["paths"]` 的档案，因此表达能力有限（说不出“这个参数是模式”，也没有选项名单）。

内置默认集为：

```text
pwd, ls, cat, head, tail, wc, git status, git diff, git log, git show
```

省略该字段时使用内置集；一旦显式配置数组，该数组**完整覆盖**内置集（不是增量追加），`"readOnlyCommands": []` 可关闭它。它在优先级上排在 `readOnly` 之后，因此默认配置下 `git status` 这类调用实际命中分组里的档案（带 `unsafeOptions`，`git diff --output out.txt` 因此被封住）。

### 7.8 cd 跟踪与相对路径（FR-70）

字面 `cd <路径>` / `pushd <路径>` 之后的相对路径按**新目录**解析（`cd src && cat .env` 读的是 `src/.env`）。要点：

- **进项目内目录免评审**（`nav` 分组，默认开启）：`cd src && rg -n x` 整条命令 `allow`。`cd ..` / `cd /tmp` / `cd ~` / 无参数 `cd` / `cd -` / `popd` 不免评审，原因写进 `readOnlyCancel`（`outside-roots` / `no-path-target`）。

- 管道元素、子 shell、命令替换各自独立：`(cd /tmp && cat x)` 读 `/tmp/x`，而 `cd /tmp | cat x` 的 `cat x` 仍按会话 cwd。
- `cd -` / `cd $DIR` / `popd` 之后，该作用域内后续单元的相对路径不可静态确定，一律走 `onUnresolvedFacts`（默认 `review`），而不是拿旧 cwd 猜一个看起来真实的路径。
- “哪些目录算内部”不受影响：`cd /tmp` 不会把 `/tmp` 变成内部目录（`external_directory_*` 仍按会话根目录判定）。

### 7.9 受免评审影响的三条护栏

- **解析没读懂的命令不算只读**：解析失败、opaque 包装器（`bash -c`、`eval`）、路径位置带无法静态展开的取值 → 走 `onUnresolvedFacts`（默认 `review`）。
- **用户规则优先**：显式 `permission.bash` 规则在免评审之前求值，因此 `"rg *": "deny"` 照样拦得住 `rg`；免评审只会把 `ask` / `review` 落点放宽为 `allow`，`deny` 永不被覆盖。
- **路径对象独立投票**：免评审只作用于命令对象，`rg x .env` 仍会被 `path` 里的 `*.env: deny` 拦住；只有**搜索模式**这类被声明为 `pattern` 的参数不会被误判成路径。

### 7.10 为什么又会去评审：`readOnlyCancel`

命中档案但免评审被取消时，审计条目会带 `readOnlyCancel`，判定理由与 `/perm status` 也能看到，取值形如：

| 值 | 含义 |
|---|---|
| `unsafe-option:--pre` | 命中 `unsafeOptions` |
| `option-not-allowed:-D` | `allow-list` 下未列出的选项（或带值选项的取值不可静态确定） |
| `unexpected-arg:HEAD` | 档案声明不允许位置参数（`roles: []`），但出现了位置参数 |
| `option-path-value:--output` | 未声明安全的 `--opt=<值像路径>` |
| `script-not-allowed` | `script` 角色未命中模式集（含脚本缺失） |
| `dynamic-arg` | 选项名或脚本本身不可静态确定 |
| `unexpected-arg:newbranch` | 档案声明了角色却出现了没被任何角色吸收的位置参数 |
| `redirect-write:/proj/app/out.txt` | 写了真实文件（不是空设备） |
| `outside-roots` | 档案要求目标在项目根内，但目标在外部（`cd /tmp`、`cd ..`） |
| `no-path-target` | 档案要求目标在项目根内，但命令没有位置参数（无参数 `cd` = 回家目录、无参数 `pushd` = 栈顶交换） |

没有命中档案时**不会**记取消原因：那不是“被取消”，而是本来就不在白名单里。

## 8. 规则表 `permission`

### 8.1 四种动作

| 动作 | 含义 |
|---|---|
| `allow` | 静默放行，无模型调用、无弹窗 |
| `deny` | 直接拒绝。可带 `reason`：`{"action": "deny", "reason": "..."}` |
| `ask` | 人工确认 |
| `review` | 交评审模型判断 |

### 8.2 两条裁决规则

1. **同一 surface 内：后写的规则覆盖先写的**（last-match-wins，FR-5）
2. **跨配置层（全局 vs 项目）：最严格者胜**，`deny > ask > review > allow`（FR-6）

第 2 条确保项目配置无法放宽全局的安全底线——否则任何 clone 来的仓库里的 `.pi/extensions/.../config.json` 都是一条提权路径。

命令单元之间的 `allow` / `deny` 冲突属于调用级策略，按 §4.1 的 `onMixedCommandActions` 处理；该字段由 global/default 定义基线，项目层只能收紧。

`ask` 排在 `review` 之前：写 `ask` 的意图是"我要亲自看"，它必须能压过任何模型判定。

### 8.3 规则编排顺序（最容易踩的坑）

因为 last-match-wins，具体规则**必须写在宽泛规则之后**才能生效。参考配置按四段编排：

```
① 宽泛基线      rm * → review
② 人工确认      sudo * → ask
③ 直接拒绝      rm -rf /* → deny
④ 明确放行      rm -rf ./dist → allow     ← 必须最后
```

如果把 `rm -rf /*` 写在 `rm *` 前面，它永远会被后者覆盖，护栏形同虚设。

### 8.4 pattern 语法

| 写法 | 含义 |
|---|---|
| `*` | 匹配任意字符，**跨路径分隔符**（`**` 不特殊） |
| `?` | 匹配单个字符 |
| 结尾 `" *"` | 使空格 + 参数可选，因此 `git *` 同时匹配裸 `git` |
| `~/`、`$HOME/` | 展开为用户主目录 |

模式整体锚定为 `^...$`。

一个值的形态按下面的顺序判定，这决定了 `permission.bash` 到底是"一条动作"还是"一组模式"：

1. 字符串 → 该 surface 的动作（等价于模式 `*`）；
2. 对象，且 `action` 是四种动作之一、除 `action` 外只允许 `reason` → 一条带理由的动作；
3. 其余对象 → 模式到动作的映射（`{"action": "deny"}` 之外的情况，例如 `{"rm *": "review"}`）。

第 2 条优先于第 3 条：`{ "action": "deny", "reason": "..." }` 会被当成"一条动作"，而不是模式 `action` 到动作 `deny` 的映射。要用名为 `action` 的模式，请另外加一个模式键，让它不满足"只有 action 与 reason"这个条件。

### 8.5 路径面的匹配细节

- 路径值会**同时以词法形与符号链接解析后的真实形**参与匹配，因此指向 `~/.ssh` 的软链也会被 `*/.ssh/*` 命中（FR-16）
- **Windows**：大小写不敏感，且 `/` 与 `\` 等价——所以模式统一用 `/` 书写即可跨平台
- **POSIX**：保持大小写敏感

### 8.6 surface 一览与默认动作

不设置 `permission["*"]` 时，按下表裁决（FR-8）。**一旦设置 `"*"`，它会覆盖全部默认值**——参考配置刻意不设它。

| surface | 覆盖的工具 | 默认动作 | 理由 |
|---|---|---|---|
| `read` | `read` | `allow` | 只读，风险最低 |
| `find` / `grep` / `ls` | 同名工具 | `allow` | 同上 |
| `write` | `write` | `review` | 覆盖难以回滚 |
| `edit` | `edit` | `review` | 同上 |
| `bash` | `bash` | `review` | 任意命令 |
| `powershell` | `powershell` | `review` | 同上 |
| `path_read` / `path_write` | 敏感路径（方向独立） | 由规则给出 | 读 `~/.ssh` 与写 `~/.ssh` 风险量级不同 |
| `external_directory_read` / `_write` | 工作目录之外 | `review` | 本插件要解决的核心场景 |
| 任意其他工具名 | 该工具 | `review` | 未知语义 |

`path` 与 `external_directory` 是**语法糖**：加载时展开为对应的 `*_read` / `*_write` 方向键（FR-3）。两个方向独立判定，`external_directory_read: allow` 不会顺带放行写操作。

语法糖的展开**总是排在对应的显式方向键之前**，与你在文件里的书写顺序无关。因此同一个 surface 内，显式 `path_read` / `path_write` 可以覆盖 `path` 产生的同名模式（last-match-wins），反之不成立：把 `path` 写到最后也压不过已写的 `path_read`。需要精确控制优先级时，直接用方向键、不要用语法糖。

### 8.7 参考配置中 bash 规则的分组说明

| 段 | 内容 | 意图 |
|---|---|---|
| ① | `rm`/`mv`/`cp -r`/`truncate`/`shred`/`rmdir`/`ln -sf`/`tee` | 删除、覆盖、移动类交模型复查 |
| ② | `git push`/`reset --hard`/`clean`/`restore`/`rebase`、`npm publish`、`npm install -g`、`pip install`、`gh release`、`sudo`、`curl ... \| sh` | 影响面超出当前工作目录，或产生对外副作用 |
| ③ | `rm -rf /`、`rm -rf /*`、`rm -rf ~*`、`rm -rf $HOME/*`、`mkfs`、`dd of=/dev/*`、`chmod -R 777 /`、`chown -R`、`shutdown`/`reboot`/`halt` | 不可回滚或明确的破坏性形态 |
| ④ | `rm -rf ./node_modules`、`./dist`、`./build`、`./out`、`./coverage`、`./tmp`、`./.cache`、`./.turbo`、`rm -f ./*.log` | 高频、可重建的构建产物，直接放行 |

**已知的取舍**：③ 中的 `rm -rf /*` 会连带拦下 `rm -rf /tmp/junk` 这类绝对路径递归删除。这是 fail-closed 的有意选择（D7）。如果你觉得误拦太多，两种调整方式：

- 降为 `"ask"` —— 保留人工判断
- 在 ④ 段追加例外，例如 `"rm -rf /tmp/*": "allow"`

## 9. 校验与自检

写配置时：

- 编辑器会依据 `$schema` 给出补全与校验。未知字段、非法动作值、越界数值都会当场标红
- 参考配置本身经过校验，可作为结构模板

安装后：

```
/perm status
```

输出应包含：开关状态、`gate` 覆盖面、评审模型与可用性、`userBashPolicy` 状态与冲突标记、`subagentCoverage`、tree-sitter 是否就绪、当前配置来源与规则条数、熔断与缓存计数。排查"为什么这条没被拦住"时，从这里开始。

决策依据则在审计日志里（`debugLog` 关闭时也有）：`<agentDir>/extensions/pi-permission-guardian/logs/`，记录了每条决策的来源（`policy` / `reviewer` / `cache` / `session-grant` / `human` / `circuit-breaker`）与命中规则。
