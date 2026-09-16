# 配置说明

配套文件：

- 参考配置：[`config/config.json`](../config/config.json) —— **严格 JSON**（无注释），带 `$schema`，可直接复制后修改
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

config 解析失败时 fail-closed：该层的所有 `allow` 抬升为 `review`，并提示具体错误位置（FR-51）。

### 1.3 失效层的处理（FR-51）

一层配置坏掉时，处理目标是"既不静默放行，也不连带丢掉用户显式写的 `deny`"：

| 情况 | 处理 |
|---|---|
| JSON 语法错误（无法读出任何字段） | 该层整体不生效，报出原文行号；未命中规则的默认动作按保守侧处理 |
| JSON 合法但校验失败 | 把 `permission` 里的 `allow` 抬升为 `review`，再按"顶层字段 → surface → 单条模式规则"逐级重新校验：合法部分继续生效，非法部分被忽略并逐条列出 |
| 抬升后仍无任何可用字段 | 该层整体不生效，等同于上一条 |

抢救粒度是刻意的：`permission` 里写错一条规则，只会丢掉那一条，同一层里其余 `deny` 仍然生效。

三个失败分支开关不接受 `allow`（见 §4），写错时它们不会被抬升，而是直接被丢弃并落回更严格的默认值（`deny` / `review` / `deny`）。

"未命中规则的默认动作按保守侧处理"指：存在失效层时，未命中规则的调用不再用默认动作矩阵里的 `allow`，而是按 `review` 处理。原因很直接：坏配置里可能原本就有一条 `deny`，我们读不出来，就不能假定它不在。

被抬升的只有动作取值本身；规则模式、`reason` 文本与其余配置字段都原样保留。

## 2. 顶层开关

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。关闭后 `tool_call` 立即返回，等同未安装 |
| `yoloMode` | `false` | 逃生舱：把所有 `ask` / `review` 重写为 `allow`。开启时状态栏必须显著提示（FR-53） |
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

三个失败开关分别对应三类"不确定"状态，默认全部落在保守侧（FR-46、architecture §9）；`onMixedCommandActions` 处理确定的跨命令单元动作冲突（FR-59）。

| 字段 | 默认 | 触发场景 |
|---|---|---|
| `onReviewUnavailable` | `"deny"` | 评审超时 / 模型报错 / 输出无法解析 / `reviewer.model` 未配置（FR-19） |
| `onUnresolvedFacts` | `"review"` | bash 解析失败、包装器（`bash -c`、`sudo`、`xargs`）内部不可展开、路径非字面量（FR-12/14/15） |
| `onAskWithoutUI` | `"deny"` | 需要人工确认但没有交互界面：`print` / `json` 模式、无 UI 的子代理会话 |
| `onMixedCommandActions` | `"deny"` | 同一 shell 调用的多个已解析命令单元中，同时存在裁决结果为 `allow` 与 `deny` 的单元 |

这三个失败开关只接受 `"deny"` / `"ask"` / `"review"`，**不接受 `"allow"`**（D7）：它们描述的都是"本次没能得出安全结论"的情形，允许就地配成 `allow` 等于让"拔网线 / 写错模型名 / 解析不了"成为绕过手段。需要整体放宽时用 `yoloMode`，不要用这些开关。配置里写了 `allow` 会被当作非法值处理（该字段被忽略并落回默认值，同时提示配置失效）。

`onReviewUnavailable` 默认 `deny` 的理由：`unavailable` 是基础设施结果，不是安全结论。若放行，等于让"拔网线 / 配错模型名"成为绕过手段。

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
| `timeoutMs` | `20000` | 单次评审的硬性 deadline（FR-25） |
| `maxEvidenceRounds` | `3` | 评审模型调用只读证据工具的轮次上限，`0` 关闭证据循环（FR-24） |
| `evidenceTools` | `true` | 是否允许评审模型用 `read`/`grep`/`find`/`ls` 自行查证 |
| `transcript` | `true` | 是否把会话 transcript 提供给评审模型 |
| `transcriptBudgetChars` | `24000` | transcript 字符预算 |
| `maxAllowRiskLevel` | `"medium"` | 风险门槛（FR-23），见下 |

### 5.1 为什么 `model` 不回退到当前会话模型

评审模型必须显式配置，未配置时判为 `unavailable` 而不是拿当前会话模型顶上（D6）。理由是**审查独立性**：让被审查者用自己的模型批准自己，等于把授权与执行合并到同一主体，护栏在语义上就不成立了。

模型必须通过 `ctx.modelRegistry.find` 解析，再用 `ctx.modelRegistry.complete` 调用。请求协议沿用模型自身配置的 `api`，插件不提供 `api`、`baseUrl`、认证或 headers 覆盖项，因此实际请求协议不会与 pi 模型配置漂移。

### 5.2 风险门槛

模型给出 `allow` 时不会无条件放行：

| 模型 verdict | `riskLevel` | 结果 |
|---|---|---|
| `allow` | `low` / `medium` | 放行 |
| `allow` | `high` / `critical` | **转为人工确认**（无 UI 则按 `onAskWithoutUI`） |
| `deny` | 任意 | 拦截 |

`maxAllowRiskLevel` 就是这个分界线。把它调到 `"low"` 会让更多 allow 转人工；调到 `"high"` 则更信任模型。弱模型给出低质量 allow 的代价是安全侧的单向失败，所以默认不设在最高。

### 5.3 用户直接执行 `!command` / `!!command`

`!command` 是 pi 交互输入框中的用户直接 shell 命令，命令输出会在下一次模型请求时进入上下文；`!!command` 执行方式相同，但输出不加入模型上下文。两者都会触发 pi 的 `user_bash` 事件。

| 字段 | 默认 | 说明 |
|---|---|---|
| `userBashPolicy.enabled` | `true` | 是否让用户直接执行的命令经过本插件 |
| `userBashPolicy.autoReview` | `true` | `review` 动作是否自动调用评审模型；关闭时转人工确认 |
| `userBashPolicy.model` | `null` | 自动审核模型；只能引用 pi 模型配置中的模型，`null` 表示复用 `reviewer.model` |

`user_bash` 与 `tool_call` 复用同一 facts、规则、授权、评审和审计管线，仅最终执行适配不同：`allow` 返回正常 shell 执行，`deny` 返回替代 `BashResult` 并让真实命令不启动，`review` 按本节自动审核。用户直接输入命令本身不创建会话授权；只有人工确认对话框中的"本会话允许此类"才能创建。

跨全局/项目层合并时采用保守方向：任一层 `enabled=true` 时保持拦截；任一层 `autoReview=false` 时转人工确认；`model` 可由更具体的配置覆盖。

共存冲突只检测和提示，不强制。插件通过 `pi.events` 声明自己的 `user_bash` claim；检测到另一声明时在 UI/日志中提示，并在 `/perm status` 标记冲突。不会改变扩展加载顺序，也不会为了抢回事件而重复拦截。pi 当前不暴露扩展枚举，因此对“未声明且排在前面的拦截器”只能记录为不可观测边界。

## 6. 降本机制

### 6.1 非阻塞预评分

| 字段 | 默认 | 说明 |
|---|---|---|
| `classifier.enabled` | `false` | 见下方警告 |
| `classifier.model` | `null` | 缺省复用 `reviewer.model` |
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

父子会话的授权记忆、缓存和熔断始终不共享。`subagentPolicy` 只收紧规则未命中时的默认动作，不会放宽父配置中的显式规则；检测能力和加载方式取决于子代理实现，`/perm status` 必须显示当前子代理会话是否被识别及实际生效策略。

跨层合并时，任一层 `enabled=true` 时启用子代理策略；`defaultAction` 按 `deny > ask > review` 取最严格者；任一层 `allowSessionGrants=false` 时子代理都不能创建或使用会话授权。

v1 只兼容 `@gotgenes/pi-subagents` v21.7.1。父会话在 `bound` 后未收到子扩展握手时：有 UI 使用 warning 通知，无 UI 写入 `console.warn`，同时写入 `pi-permission-guardian.subagent-warning.v1` 会话条目，并把 `/perm status` 标为 `unguarded`。

## 7. 工作目录

| 字段 | 默认 | 说明 |
|---|---|---|
| `allowRoots` | `[]` | 视为"内部"的额外根目录 |
| `readOnlyCommands` | 内置高置信集合；显式配置时完整覆盖 | 只读命令白名单 |

`allowRoots` 用于 monorepo：把兄弟包路径加进来，避免项目间的正常读写被判定为外部目录访问。例如 `["../shared-lib", "~/dev/monorepo"]`。

`readOnlyCommands` 命中即 `allow`，不产生评审调用（FR-9）。匹配方式是**命令单元的可执行名 + 参数前缀**：`"git status"` 匹配 `git status --short`，但不匹配 `git push`。

内置默认集为：

```text
pwd, ls, cat, head, tail, wc, git status, git diff, git log, git show
```

内置集保持最小和通用，匹配严格使用“可执行名 + 参数前缀”，不为某个选项额外增加分支。省略 `readOnlyCommands` 时使用内置集；一旦显式配置数组，该数组**完整覆盖**内置集，而不是增量追加。`"readOnlyCommands": []` 可关闭默认白名单。`file`、`stat`、`which`、`whoami`、`date`、`echo`、`rg`、`grep`、`find`、`git branch` 及版本查询等命令不进入内置集，用户可以按项目需要显式加入。

两条护栏限制白名单的免评审范围，配自定义条目时需要知道：

- **带路径值的选项会取消免评审资格**：参数里出现 `--output=.env` 这种"带 `=` 且值像路径"的选项时，该次调用不算只读（因为白名单只看可执行名与参数前缀，看不出某个选项会写文件；`git diff --output=<file>` 实测会写文件）。因此往白名单里加命令时，只加**确实不会写文件**的命令。
- **解析没读懂的命令不算只读**：解析失败、opaque 包装器（`bash -c`、`eval`）、参数里带无法静态展开的取值时，单元一律不判只读，转而走 `onUnresolvedFacts`（默认 `review`）。

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
