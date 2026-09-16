# pi-permission-guardian 需求规格说明

- 状态：待评审（核心决策已定稿，见 §7）
- 目标运行环境：pi coding agent ≥ 0.85.1（本机实测 0.85.1），Windows 为主的跨平台
- 参考源码：`reference/`（仅供查阅，**不是依赖**；来源与版本见 `reference/README.md`）

---

## 1. 背景与问题

pi agent 自身只提供 `project_trust`，而它控制的是**项目资源是否加载**，不限制工具调用，官方文档明确声明它"非沙箱"（`pi-coding-agent/docs/security.md`）。因此高风险命令、跨工作目录读写都没有内置的拦截点。

自行搭建护栏时，两条路线各自都有天然缺口：

| 路线 | 单独使用时的缺口 |
|---|---|
| 静态黑白名单 | 规则要人工穷举。未命中的条目只能选一种兜底：放行（等于没有护栏）或询问（等于每次弹窗）。两者都与"减少人工介入"相反 |
| 逐次模型判定 | 每次调用都付出模型延迟与费用，常规开发（`git status`、读文件）也被拖慢；且缺少"这条绝对不行"的硬约束，判定权完全落在模型质量上 |

结论：需要的是一套**分层护栏**——先由黑白名单快速裁决掉绝大多数调用，只在名单未覆盖或显式标记"需复查"时才付出模型判断成本，最后保留人工兜底。

## 2. 目标

**G1** 用配置化的黑白名单直接裁决工具调用，命中即放行或拦截，不产生模型调用与人工交互。

**G2** 对名单未命中的调用，以及名单中显式标记 `review` 的调用，交由评审模型判断放行/拦截，从而避免每次弹窗。

**G3** 在高风险操作（删除、覆盖、破坏性 git 操作、权限变更、对外发送）与**跨工作目录读写**场景下，默认不依赖人的即时确认即可安全推进；人工介入只在名单显式要求或模型判定风险过高时发生。

**G4** 任何不确定状态（解析失败、模型不可用、结果无法解析）都必须落到已知的安全分支，不允许"因为不确定所以放行"。

**G5** 每一次放行/拦截都可审计：谁批准的（名单/模型/缓存/会话授权/人工/熔断），依据是什么。

## 3. 非目标

- **N1** 不是沙箱或 OS 级隔离。护栏只在 `tool_call` 决策层工作，无法阻止扩展自身、`pi.exec` 或用户直连 shell 的行为。
- **N2** 不拦截 pi 内部模型调用（compaction、分支摘要、skills 等），只拦截工具调用。
- **N3** 不替换 pi 的 `project_trust` 机制，两者互补。
- **N4** v1 不做跨会话的授权转发（父子子代理会话各自独立判定，见 §8.4）。
- **N5** 不重写用户手工输入 `!command` / `!!command` 的命令文本；只在 `user_bash` 决策边界允许、拒绝或转交评审，不提供独立 shell 包装器或 OS 级隔离。
- **N6** 不提供策略 DSL/脚本表达式；规则就是 glob + 四种动作。

## 4. 术语

| 术语 | 定义 |
|---|---|
| **surface（工具面）** | 护栏的判定维度之一：`bash`、`path`、`external_directory`、`read`、`write`、`tool`（按工具名的通用面）。 |
| **fact（事实）** | 从一次工具调用中静态提取出的、可被判定的客观信息：命令单元、涉及路径、读写方向、重定向目标、解析可信度。 |
| **action（动作）** | 名单对一条规则给出的裁决：`allow` / `deny` / `ask` / `review`。 |
| **intent（意图）** | 一次工具调用对应的待裁决对象集合（命令单元列表 / 路径列表 + 方向）。 |
| **review（复查）** | 把 intent 连同上下文交给评审模型，得到 `allow` / `deny` 的结构化结论。 |
| **grant（授权记忆）** | 只有人工确认"本会话允许此类"后，才会在本次会话内对等价 intent 直接放行的记忆。 |
| **unavailable** | 评审未能产出结论的状态（超时、取消、模型报错、输出无法解析、模型未配置）。它是基础设施结果，**不是安全结论**。 |

## 5. 用户场景

**S1 常规开发不被打断**
开发者在项目内执行 `npm test`、`git status`、`rg`、读写源码文件。期望：全部静默放行，零弹窗、零模型调用。
验收：`bash` 命令命中只读命令白名单或 `allow` 规则时不产生模型请求，状态栏不出现等待态。

**S2 高风险删除被拦下**
agent 执行 `rm -rf ./dist` 或跨盘 `rm -rf D:/work`。期望：前者命中局部删除规则按配置裁决，后者命中破坏性规则被 `deny`，agent 收到明确理由且被告知不得用变通手段绕过。
验收：拦截在工具执行前发生（工具未运行），返回理由包含命中的规则与风险点。

**S3 名单外的命令由模型判断**
agent 执行一条名单完全没写的命令（如 `npx some-tool --fix .`）。期望：不弹窗，由评审模型结合对话上下文判断是否在用户授权的任务范围内，给出结论与理由。
验收：产生一次评审调用，审计日志记录 `source=reviewer`、模型名、verdict 与耗时。

**S4 跨工作目录访问**
agent 读取 `~/.pi/agent/` 下的会话文件，或写入 `../other-project/` 下的文件。期望：读取类按 `external_directory` 的读方向规则裁决；写入类默认 `review`；敏感路径（`.env`、`.ssh`、认证文件）直接 `deny`。
验收：`external_directory_read` / `external_directory_write` 方向独立判定，write 不会被 read 的 allow 顺带放行。

**S5 人工兜底与记忆**
规则显式标记 `ask` 的命令，或模型判定"风险高但用户已授权"的命令。期望：弹窗给出建议动作与依据；用户可选择"仅此次允许"或"本会话允许此类"，后者在此后不再询问。
验收：选择"本会话允许此类"后，等价 intent 不再触发弹窗与模型调用；会话结束即失效。

**S6 评审不可用**
评审模型超时或网络不可用。期望：不放行，拦截并告知用户"评审未完成"，同时说明这不是"因风险被拒"，避免 agent 学到错误结论。
验收：审计日志 `source=policy`、`decision=unavailable-blocked`；无 UI 环境下行为一致。

**S7 子代理**
子代理会话执行 `rm -rf` 类命令。期望：同一套规则生效，不允许"派生子代理"成为绕过护栏的手段，并用更保守的 `subagentPolicy` 覆盖未命中默认动作。
验收：见 §8.4 的覆盖范围与限制说明。

## 6. 功能需求

### 6.1 规则与裁决

| 编号 | 需求 | 验收标准 |
|---|---|---|
| FR-1 | 支持 `allow` / `deny` / `ask` / `review` 四种动作 | 四种动作各有一条测试用例覆盖 |
| FR-2 | 规则按 surface 组织，支持通用兜底 `"*"` 与按工具名 `read` `write` `grep` `find` `ls` `bash` 等 | surface 判定由工具名映射得出，映射表可配置 |
| FR-3 | 路径类规则同时提供语法糖面 `path` / `external_directory` 与方向面 `path_read` `path_write` `external_directory_read` `external_directory_write` | 语法糖展开为方向键，读写方向独立判定 |
| FR-4 | 规则值为 glob：`*` 匹配任意字符（含路径分隔符）、`?` 匹配单字符；末尾 `" *"` 使参数可选（`git *` 同时匹配裸 `git`） | 边界用例齐全：裸命令、跨分隔符、大小写、锚定 |
| FR-5 | 同一 surface 内多规则命中时 **last-match-wins**（后写的规则可覆盖先写的宽泛规则） | 提供正反用例 |
| FR-6 | 跨配置层（全局 / 项目）合并时 **最严格者胜**：`deny > ask > review > allow` | 合并结果有测试；理由见 §7 决策 D5 |
| FR-7 | 未命中任何规则时按 surface 默认动作裁决（见 FR-8），而非统一兜底 | 默认动作矩阵有测试 |
| FR-8 | 提供按 surface 的默认动作矩阵，默认值：读取类 `allow`；`write` / `edit` / `bash` / `external_directory` / 未识别工具 `review` | 默认矩阵写入架构文档并在 `defaultAction` 未配置时生效 |
| FR-9 | 支持"只读命令白名单"：内置集合保持尽可能小且通用，命中即 `allow` 免评审；匹配方式固定为“可执行名 + 参数前缀”，不为特殊选项增加专用例外；用户显式配置 `workingDirectory.readOnlyCommands` 时以该数组**完整覆盖**内置默认集，配置空数组可关闭默认白名单 | 未配置时使用最小内置集；显式数组完全替换而非增量合并；参数前缀匹配有边界用例；白名单内命令不产生模型调用 |
| FR-10 | 规则可携带 `reason`，在拦截信息中展示 | `deny` 的返回 `reason` 含自定义理由 |
| FR-59 | 同一 shell 调用的多个命令单元同时得到 `allow` 与 `deny` 时，允许通过 `onMixedCommandActions` 将调用级冲突配置为 `ask` / `review` / `deny` | 三种配置各有测试；默认 `deny`；仅跨命令单元同时出现 `allow` 与 `deny` 时触发，`deny` 与其他非 `allow` 动作组合仍按最严格者裁决 |

> **gate 与默认动作是两个不同的概念**。gate 决定"哪些工具调用进入规则求值"，默认 `side-effect` = 全部 pi 内置工具（`bash`/`powershell`/`read`/`write`/`edit`/`find`/`grep`/`ls`），`all` 额外包含自定义工具与 MCP 工具。规则求值只是内存 glob 匹配，成本可忽略；真正的开销在评审调用，由 FR-8 的默认动作矩阵控制（读取类默认 `allow`，不进评审）。
>
> 反例：若把读取类工具排除在 gate 之外以"省成本"，`path` 中的 `*.env → deny` 对 `read ./.env` 就永远不会生效。

### 6.2 事实提取

| 编号 | 需求 | 验收标准 |
|---|---|---|
| FR-11 | `bash` 命令使用 tree-sitter-bash 解析为 AST，并枚举出全部**命令单元**：顶层命令、管道、`&&` / `||` / `;` 序列、子 shell、命令替换 `$(…)` 与反引号、进程替换 `<(…)` / `>(…)` | 每种构造有单测，断言枚举结果包含内层命令 |
| FR-12 | 识别并标注**包装器**：opaque（`bash -c`、`sh -c`、`eval`）与 indirection（`sudo`、`env`、`xargs`、`nohup`、`timeout`、`find -exec` 等）。opaque 包装器内部无法静态展开，必须按 `onUnresolvedFacts` 处理，**不得放行** | 包装器用例断言产生的 intent 带 `unresolved` 标记 |
| FR-13 | 分析重定向：`>` `>>` 为写、`<` 为读、`<>` 为读写不可证 | 各构造有单测 |
| FR-14 | 解析失败的子树必须降级：整条命令标记 `unresolved`，按 `onUnresolvedFacts` 处理 | 构造已知解析失败样例（如 heredoc + `2>&1` + pipe）验证降级 |
| FR-15 | 从命令单元中提取路径候选并按读/写效应归因；展开 `$HOME` / `${HOME}` / `$PWD` / `~`；非字面量（`"$DIR"`、命令替换结果）保持字面并标记 `unresolved` | 路径提取与归因有单测 |
| FR-16 | 路径归一化：同时产出 lexical 形与 canonical（符号链接解析后）形并双形匹配；Windows 下 `/` 与 `\` 归一且大小写不敏感，POSIX 保持大小写敏感 | Windows 用例覆盖大小写与分隔符 |
| FR-17 | 内置工具路径提取：`read` / `write` / `edit` → `input.path`；`find` / `grep` → `input.path ?? cwd`；`ls` → `input.path ?? cwd`；`bash` 走 FR-11~FR-15 | 各工具有单测 |
| FR-18 | 提供 `registerToolPathExtractor` 供其他扩展注册自定义工具的路径提取器；未注册的工具回退到 `input.path` | 注册 API 有测试；未注册时行为明确 |

### 6.3 模型评审

| 编号 | 需求 | 验收标准 |
|---|---|---|
| FR-19 | 评审模型由配置 `reviewer.model` 指定（`provider/model-id` 格式），只能来自 pi 模型配置文件并经 `ctx.modelRegistry.find` / `complete` 使用；接口协议必须采用解析后 `Model` 自带的配置协议，插件不得自行选择 wire API 或覆盖 `baseUrl`、认证和 headers | 未配置或无法解析时行为为 `unavailable`；测试确认 `openai-responses` 等协议来自模型配置而非插件硬编码 |
| FR-20 | 评审输入包含：待执行动作原文（置于消息末尾）、工作目录、命中的规则与为何需复查、facts 摘要、受预算约束的会话 transcript、本会话已授予的授权键摘要 | prompt 构造有快照测试 |
| FR-21 | 评审输出为结构化 verdict：`decision`（`allow` / `deny`）、`riskLevel`（`low`/`medium`/`high`/`critical`）、`userAuthorization`（`unknown`/`low`/`medium`/`high`）、`reversible`（bool）、`rationale`（≤300 字） | 解析器对各种畸形输出有测试 |
| FR-22 | verdict 获取采用三段式降级：① 优先使用结构化输出能力（`Tool.constrainedSampling` 的 `json_schema`）；② 退化为提示约束 + JSON 文本解析（容忍代码围栏与前后缀）；③ 仍失败即 `unavailable`，**绝不猜成 allow** | 三段各自有用例 |
| FR-23 | 裁决规则在模型结论之上再叠加底线（不得让模型单独决定高风险放行）：`allow` 且 `riskLevel ∈ {low, medium}` → 放行；`allow` 且 `riskLevel ∈ {high, critical}` → 不直接放行，转人工 `ask`（无 UI 则按 `onAskWithoutUI`）；`deny` → 拦截 | 四种组合有测试 |
| FR-24 | 评审模型可选地调用**只读证据工具**（`createReadOnlyTools(cwd)` 提供的 `read` / `grep` / `find` / `ls`）自行查证，轮次上限可配置，默认 3；达到上限强制无工具作答 | 证据循环有用例；未知工具调用被拒绝并回喂错误结果 |
| FR-25 | 评审调用有单一 deadline（`reviewer.timeoutMs`，默认 20000ms），桥接 `ctx.signal`；超时/取消/模型报错/输出非法分别归类 | 各类失败有用例 |
| FR-26 | `deny` 的返回理由必须包含反规避约束：不得通过改写、拆分、间接执行、重命名等方式达成同一结果 | 理由文本有断言 |
| FR-27 | `unavailable` 的理由必须明确说明"评审未完成，不代表因风险被拒"，并给出可选的安全替代路径 | 理由文本有断言 |
| FR-28 | 评审调用本身不得触发本插件的 `tool_call` 钩子（证据工具为进程内直接调用） | 用例断言不产生递归与额外审计条目 |

### 6.4 降本增效机制

| 编号 | 需求 | 验收标准 |
|---|---|---|
| FR-29 | **会话授权记忆**：只有人工在确认对话框中选择"本会话允许此类"才能创建会话授权，之后等价 intent 直接 `allow`；评审模型 allow、缓存命中、自动审核和用户手输 `!command` 本身都不能创建授权。会话结束清空，不落盘 | 会话内二次调用无弹窗无评审；模型 allow 不产生 grant；`session_shutdown` 后清空 |
| FR-30 | 授权键由 facts 生成建议模式（如 `rm -rf ./dist` → `rm -rf ./dist*`），并在提示中展示供用户确认 | 建议模式生成有单测 |
| FR-31 | **判定缓存**：key = hash(surface + 规范化目标集合 + 方向 + cwd + 规则集版本 + 用户授权版本 + 评审模型)，命中即复用结论 | 相同 key 二次调用不产生评审；key 任一维度变化即失效 |
| FR-32 | 缓存只存确定结论（`allow` / `deny`），**不存** `unavailable`；TTL 与容量可配置（默认 300000ms / 200 条），仅内存 | 有用例验证 unavailable 不入缓存 |
| FR-33 | 缓存与授权记忆的失效必须响应"用户授权前提变化"：以用户消息文本指纹作为授权版本，指纹变化即全部失效 | 用户追加新指令后缓存失效有用例 |
| FR-34 | **熔断器**：同一轮内连续 `deny` 达到阈值（默认 3）或窗口内 `deny` 达到阈值（默认 10/50）时，拦截并 `terminate` 本轮，指示 agent 停下并向用户说明阻碍 | 连续 deny 达阈值后本轮提前结束 |
| FR-35 | 熔断器每轮重置；被 `deny` 过的工具在同一轮内不享受任何快路径（防规避） | 有用例 |
| FR-36 | **非阻塞预评分（可选，默认关闭）**：在 `tool_result` 后异步为轨迹打低/高风险分，评分低风险时允许下一次调用走快路径放行 | 默认 `classifier.enabled=false`；开启后仅用于放行，永不产生 deny |
| FR-37 | 预评分失败必须记为 `failure` 而非"低风险"；评分引用的调用序落后于当前超过 `maxLag` 时不得使用 | 失败与滞后有用例 |
| FR-38 | 预评分与评审共用模型配置时可独立指定；单飞（同一时刻至多一个评分请求） | 并发用例 |

### 6.5 交互与观测

| 编号 | 需求 | 验收标准 |
|---|---|---|
| FR-39 | 提供 `/perm` 命令：`on` / `off` / `status` / `reload` / `grants`（列出会话授权） / `clear-grants` | 每个子命令有行为说明与测试 |
| FR-40 | 提供 CLI flag `--perm` 使会话启动即启用；`/perm off` 可关闭 | flag 生效；关闭后 `tool_call` 立即返回 `undefined` |
| FR-41 | 状态栏显示当前模式与最近一次决策来源 | `ctx.ui.setStatus` 被调用；无 UI 时不报错 |
| FR-42 | 人工确认对话框给出：待执行动作、命中规则、风险点、建议动作，以及选项 `仅此次允许` / `本会话允许此类` / `拒绝` / `拒绝并说明原因` | 对话框选项可测；选择结果写入授权记忆或拒绝理由 |
| FR-43 | 审计日志：JSONL 落盘至 `<agentDir>/extensions/pi-permission-guardian/logs/`，按进程本地日期切分为 `guardian-YYYY-MM-DD.jsonl`，默认保留 14 个自然日且可通过 `auditLog.retentionDays` 配置；字段含时间、会话、工具调用 id、工具名、surface、目标、命中规则、动作、来源、模型、verdict、耗时、理由；文件权限 0600 | 跨日写入新文件；过期日志自动清理；保留期边界有测试；字段完整；清理失败不影响决策 |
| FR-44 | 审计日志的敏感信息处理：`write` / `edit` 的 `content` 只记录长度与哈希；命中敏感路径规则时不记录内容；路径与命令原文记录（审计必需） | 有脱敏用例 |
| FR-45 | 通过 `pi.appendEntry` 写入会话内决策记录（类型版本化），可在 TUI 中查看 | 条目类型与字段稳定并版本化 |
| FR-46 | `ctx.hasUI === false`（print / json 模式）时：`ask` 按 `onAskWithoutUI`（默认 `deny`）处理；`review` 仍照常执行（模型调用不需要 UI）；`unavailable` 按 `onReviewUnavailable` | 三种模式各有用例 |

### 6.6 配置

| 编号 | 需求 | 验收标准 |
|---|---|---|
| FR-47 | 配置文件位置：全局 `<agentDir>/extensions/pi-permission-guardian/config.json`，项目 `<cwd>/.pi/extensions/pi-permission-guardian/config.json` | 两处均可被读取 |
| FR-48 | 项目级配置仅当 `ctx.isProjectTrusted()` 为真时加载（与 pi 的信任机制一致） | 未信任项目不加载项目配置 |
| FR-49 | **输入侧**支持 JSONC：`//` 与 `/* */` 注释、对象/数组末尾多余逗号；字符串字面量内的 `//` 不得被误判为注释 | 带注释与尾逗号的配置可加载；`"a // b"` 这类值保持原样 |
| FR-50 | 剥离注释后 `JSON.parse` 报出的错误**行列号必须与原文对齐**（被删除注释中的换行原样保留，而非整段丢弃） | 在带注释配置的指定行制造语法错误，报错行号与编辑器显示一致 |
| FR-51 | 配置解析失败时 fail-closed：把 `allow` 抬升为 `review`，并提示用户配置有误 | 畸形配置下不出现静默放行 |
| FR-52 | 配置在 `session_start` 与 `before_agent_start` 重新读取，支持 `/perm reload` 手动重载 | 修改配置后无需重启会话 |
| FR-53 | 提供 `yoloMode`（把所有 `ask` / `review` 重写为 `allow`）作为显式逃生舱，默认 `false`，启用时状态栏显著提示 | 开启后无拦截；状态栏有提示 |
| FR-57 | 使用 zod 作为 schema 唯一真源，并生成 `schemas/guardian.schema.json` 供编辑器补全与实时校验 | 生成的 schema 可通过校验；非法配置给出可定位的错误；提交版 schema 与 zod 生成结果一致 |
| FR-58 | 仓库内**官方参考配置 `config/config.json` 必须是严格 JSON**（无注释、无尾逗号），并带 `$schema` 指向生成的 schema | `JSON.parse` 直接可解析；编辑器据 `$schema` 提供补全。见决策 D17 |

### 6.7 子代理

| 编号 | 需求 | 验收标准 |
|---|---|---|
| FR-54 | 护栏同样作用于子代理会话内部的工具调用，不允许通过派生子代理绕过 | 子代理会话中触发 `deny` 规则时确实被拦截 |
| FR-55 | 对接 `@gotgenes/pi-subagents` v21.7.1 的 child lifecycle：`session-created` 注册子会话，子扩展于 `session_start` 发送绑定握手，`bound` 校验握手并告警缺失，`disposed` 清理；v1 不扩大兼容范围到其他子代理实现。缺少握手时通过 UI/`console.warn` 告警、写 `appendEntry`，并把 `/perm status` 标为 `unguarded` | 子会话识别测试；未加载护栏时产生可见告警、会话条目和状态标记；文档记录唯一验证版本 |
| FR-56 | 子代理会话与父会话的授权记忆、缓存、熔断互不共享；子代理内策略应可单独配置更保守的默认动作 | 提供 `subagentPolicy`（`enabled`、`defaultAction`、`allowSessionGrants`）；默认 `defaultAction=review`、`allowSessionGrants=false`；文档说明差异 |

### 6.8 用户直接执行

| 编号 | 需求 | 验收标准 |
|---|---|---|
| FR-60 | 支持 `user_bash`：用户输入 `!command` / `!!command` 时复用同一 facts、规则、授权、评审和审计管线；`allow` 交给 pi 正常执行，`deny` 返回替代 `BashResult` 阻止真实执行，`review` 可使用 `userBashPolicy.model`（缺省复用 `reviewer.model`）自动审核；`!!` 仍保持输出不进入模型上下文。检测到其他 `user_bash` 拦截器声明冲突时只提示，不调整加载顺序或强制接管 | `!` / `!!` 均有测试；deny 时真实命令未执行；review 模型 allow 不创建 grant；冲突时会话条目、UI/日志和 `/perm status` 均有提示；未参与声明的先前拦截器属于已知不可观测边界 |

### 6.9 不确定与明确拒绝的组合

| 编号 | 需求 | 验收标准 |
|---|---|---|
| FR-61 | 同一调用中同时存在 `unresolved` facts 和至少一个可信对象明确得到 `deny` 时，最终动作固定为 `ask`；若没有明确 `deny`，仍按 `onUnresolvedFacts` 处理 | 有 `unresolved + deny`、`unresolved + allow/review` 两类测试；前者不得被 `onUnresolvedFacts` 放宽为 `review` |

## 7. 关键设计决策

以下 D1–D25 为当前设计决策；D1–D10、D16–D25 已由用户确认，D11–D15 为调研与评审后新增。

| 编号 | 决策 | 理由与影响 |
|---|---|---|
| **D1** | 实现路线：**全新独立插件，自研规则引擎 + 模型评审** | 名单裁决与模型判定必须合成到同一条决策链上（"为何被复查"是评审的关键输入），而现成的权限扩展只回答"这条规则怎么判"，无法承载这条链。代价：bash 事实提取需自行实现 |
| **D2** | 拦截方式：只通过 `tool_call` 返回 `{block:true}` 拒绝，**不替换内置工具、不做命令改写或净化** | 改写命令会让 agent 的意图与实际执行不一致，审计也会失真；替换内置工具会与其他扩展争抢同一工具名。护栏只做决策，执行留给 pi |
| **D3** | bash 解析采用**完整 tree-sitter-bash AST 解析** | 简单 glob 匹配命令文本存在大量绕过空间（`sudo rm -rf /`、`bash -c '...'`、命令替换）。安全护栏必须建立在"实际会执行什么"之上 |
| **D4** | 覆盖面：`bash`/`powershell`、`write`/`edit`、`read`/`find`/`grep`/`ls`、`external_directory`、子代理 | `read` 面纳入是因为"外部目录读取"是真实的信息泄露面（`~/.ssh`、`.env`、认证文件），而它不写任何东西，单看写操作面很容易漏掉 |
| **D5** | 跨层合并用最严格者胜，顺序 **`deny > ask > review > allow`** | `ask` 排在 `review` 之前，因为"用户要求亲自确认"比"交给模型判断"更保守；`review` 让模型有拒绝能力，因此比 `allow` 严格 |
| **D6** | 评审模型只能来自 pi 模型配置文件，通过 model registry 解析，并沿用该模型配置的接口协议；不回退到当前会话模型 | 审查主体必须独立配置；插件不自行选择 wire API、不覆盖认证/headers，避免配置文件与真实请求协议漂移 |
| **D7** | 评审不可用时 **fail-closed（默认 `deny`）** | `unavailable` 是基础设施结果，不是安全结论。放行等于让"拔网线"成为绕过手段。三个失败分支开关（`onReviewUnavailable` / `onUnresolvedFacts` / `onAskWithoutUI`）只能配 `deny` / `ask` / `review`，**不接受 `allow`**：需要放宽护栏时使用 `yoloMode`（会写审计日志并在状态栏显著提示），而不是就地埋一个静默放行开关 |
| **D8** | 启用全部降本机制：会话授权记忆、判定缓存、熔断器、审计日志、非阻塞预评分 | 前四项是"减少人工介入开销"的直接手段；预评分因其"先放行、后判定"的实际语义与护栏的保守取向相反，**默认关闭**，由用户显式开启 |
| **D9** | 交付物分两份：需求文档 + 架构设计文档 | 先对齐"做什么"，再对齐"怎么做"；实施计划另行产出 |
| **D10** | 参考源码拉取到项目内 `reference/` 并加入 `.gitignore`；插件从一开始按 **pi package** 组织 | `reference/` 便于离线查阅且不污染仓库；package 形态保证依赖声明（tree-sitter-bash、zod）与分发路径从第一天就正确 |
| **D11** | verdict 获取优先用结构化输出（`constrainedSampling`），退化到 JSON 文本解析 | pi 的 `ModelRegistry.complete` 支持 `Context.tools`，且 `Tool` 支持 `constrainedSampling: {type:"json_schema", strict}`，可由 provider 侧做约束解码，显著降低解析失败率。**注意**：`StreamOptions.toolChoice` 仅支持 `"auto" \| "none"`（无法强制调用某个工具），因此仍需文本兜底（FR-22） |
| **D12** | 模型 `allow` 不无条件放行：`riskLevel ∈ {high, critical}` 的 allow 升级为人工 `ask` | 弱模型给出低质量 allow 的代价是安全侧的单向失败，且无法事后发现。把"最终授权"留给风险等级门槛，只多一次交互 |
| **D13** | 路径类规则把读写方向拆成独立键 | 读写不可能用同一套阈值：读 `~/.ssh` 与写 `~/.ssh` 风险量级不同。`path` / `external_directory` 仅作为语法糖，加载时展开为 `*_read` / `*_write` 方向键 |
| **D14** | 审计日志默认开启，debug 日志默认关闭 | "为什么放行"是护栏可被信任的前提；每条决策都要能回答来源（名单/缓存/授权/模型/人工）。debug 日志会记录提示词与 facts 全文，可能含会话内容，因此默认关闭 |
| **D15** | v1 不做跨进程授权转发 | 跨进程授权转发（请求/响应文件、心跳存活判定、超时放弃、权限归属）会引入一个独立子系统，复杂度与 v1 收益不成比例。v1 用"子代理独立判定 + 更保守默认"替代 |
| **D16** | `deny` 不提供人工申诉通道 | `deny` 来自明确规则（或模型判定 + 风险门槛），改配置才是正解。若保留"当场同意放行"，任何误判都能被顺手绕过，规则形同虚设 |
| **D17** | **官方参考配置用严格 JSON + `$schema`，解释放文档；输入侧仍容忍 JSONC** | 原生 `JSON.parse` 解析不了带注释的 JSON，必须前置剥离（且剥离后错误行号会偏移）。更关键的是带注释会读 `$schema` 失去价值，而**活的 schema（补全 + 实时校验）比死的注释更有用**，且解释放文档里能写得更长、能引用 FR 编号。同时保留输入侧宽容度，不阻碍用户自己写注释（与 pi 生态的实际习惯一致：`models.json` 支持注释、`settings.json` 不支持） |
| **D18** | 跨命令单元的 `allow` / `deny` 冲突不强制固定为 `deny`，新增 `onMixedCommandActions`：默认 `deny`，可配置 `ask` / `review` / `deny` | 同一条 shell 调用可能由多个独立命令单元组成，固定整条拒绝会损失可重建或低风险子操作的执行能力；把冲突消解策略显式配置，同时默认保持原行为。为保证项目配置不能借混合命令放宽全局底线，该字段跨层按 `deny > ask > review` 合并，项目层只能收紧，不能放宽 |
| **D19** | 项目许可证使用 **Apache License 2.0** | 允许商业使用、修改、分发，并包含明确的专利授权条款；仓库提交完整 `LICENSE`，未来 `package.json` 使用 `"license": "Apache-2.0"` |
| **D20** | 审计日志按进程本地日期切分，默认保留 14 天，保留期可配置 | 避免单文件无限增长；可通过 `auditLog.retentionDays` 调整；清理失败只告警，不影响工具裁决 |
| **D21** | 内置只读集合保持尽可能小且通用；匹配固定为“可执行名 + 参数前缀”；用户显式配置 `readOnlyCommands` 时完整覆盖内置默认集 | `[]` 可明确关闭；不做特殊选项白名单分支，边界行为保持可解释；完整替换避免默认集悄悄扩张 |
| **D22** | `unresolved` 与明确 `deny` 同时出现时最终采用 `ask` | 保留对同一调用中高风险意图的人工确认机会；没有明确 `deny` 时仍按 `onUnresolvedFacts` |
| **D23** | 只有人工确认才能创建会话授权 | 模型 allow、缓存和自动审核都不等于用户授权；避免把模型判断放大为本会话内长期放行 |
| **D24** | `!command` / `!!command` 纳入 `user_bash` 护栏；`userBashPolicy` 默认开启，自动审核默认开启，模型缺省复用 `reviewer.model`；检测到其他拦截器冲突时只提示，不强制顺序 | 用户直接执行不再形成默认绕过通道；共存冲突可见，同时避免插件争抢扩展加载顺序 |
| **D25** | 新增 `subagentPolicy`：子代理默认动作可取 `deny` / `ask` / `review`，默认 `review`，默认不允许会话授权继承或创建；v1 只兼容 `@gotgenes/pi-subagents` v21.7.1，且护栏缺失时必须告警 | 子代理会话与父会话状态隔离，并可用更保守的默认策略运行；兼容范围与未覆盖风险保持显式 |

## 8. 约束与已知限制

### 8.1 平台事实（已核实，附证据）

| 事实 | 证据 |
|---|---|
| `tool_call` 事件可返回 `{block, reason, terminate}`；handler 抛错会阻断该工具（fail-safe） | `pi-coding-agent/dist/core/extensions/types.d.ts:818-827`；`docs/extensions.md` |
| `terminate` 只在同一批内**所有**结果都置位时才提前结束本轮 | 同上 :822-826 |
| 扩展内独立调用模型的路径是 `ctx.modelRegistry.complete(model, context, options)`，`options.signal` 可用 | `dist/core/model-registry.d.ts:33`；`pi-ai/dist/types.d.ts:52-53`；`pi-openai-toolkit/src/auto-mode/reviewer.ts` 实际用法 |
| 无法强制工具调用：`ToolChoice = "auto" \| "none"` | `pi-ai/dist/types.d.ts:23` |
| `ctx.hasUI` 在 `tui`/`rpc` 为 true，在 `print`/`json` 为 false | `dist/core/extensions/types.d.ts:217`；`docs/extensions.md` |
| 扩展经 jiti 直接加载 TS，无需编译；`package.json` 的 `pi.extensions` 声明入口；运行时依赖必须放 `dependencies` | `docs/extensions.md`；`docs/packages.md` |
| `/reload` 只对自动发现位置的扩展生效 | `docs/extensions.md:7` |

### 8.2 bash 静态分析的固有边界

必须承认护栏不是完备的：shell 别名不展开、`eval` 与 `bash -c` 内的字符串无法静态得知、非字面 `cd` 之后的相对路径无法解析、变量拼接的路径不可知。设计上的应对是**降级而非放行**：任何 `unresolved` 事实一律走 `onUnresolvedFacts`（默认 `review`），由模型在上下文里判断，而不是当作安全。

已核实的解析器边界（实现在 `src/facts/bash/`）：

| 边界 | 影响 |
|---|---|
| tree-sitter-bash 0.25.1 对 `<>` 直接报错（`file_redirect(<, ERROR(>), word)`） | `<>` 走 `parse-error` 降级（整条命令按不可信处理），不会出现"只记读方向"的偏宽结果 |
| v1 没有 PowerShell 解析器 | `powershell` 命令整体标记 `unparsed-language`，因此 PowerShell 规则最多产生 `review` / `ask`，不会单独给出 `allow` / `deny`（fail-closed） |
| `~user/x`、`${VAR:-default}`、`$((…))` 等取值不在需求可展开范围内 | 保持字面并标记 `dynamic-path`，不猜值 |
| 大括号展开 `{a,b}` 与 glob 通配符不做展开 | 按字面文本参与匹配；globs 的目录部分仍可靠，可参与外部目录判定 |
| `cmd <<'EOF'` 的引号 heredoc 正文是字面数据，不是命令 | 不逐条枚举正文（`cat <<'EOF'` 下 `$(rm -rf /)` 不会被执行）；若正文其实会被执行（`bash <<EOF`），由 opaque 包装器降级兜住 |
| `> file`（合法但无 body 的重定向语句） | 产出写目标：bash 会真的截断/创建文件，不产出对象就会让写目标对规则不可见 |
| UNC 路径（`\\server\share\x`） | 只做词法归一，**不**解析真实路径：realpath 会对网络位置发起 SMB 访问，可能阻塞数十秒，而 `tool_call` 不能阻塞 |
| 子命令族带写文件选项（`git diff --output=<file>`） | 前缀匹配无法验证“不会写文件”，因此 `git diff` / `git log` / `git show` 不进内置只读集；`--output=.env` 这类“带路径值的选项”会额外取消免评审资格 |

### 8.3 性能预算

评审在关键路径上同步执行，直接决定用户感知的等待时间。必须满足：

- 名单命中路径：无模型调用、无磁盘 I/O，判定延迟 < 5ms（不含 tree-sitter 首次预热）。
- tree-sitter 解析器在 `before_agent_start` 预热，避免首个命令承担 WASM 加载延迟。
- 评审路径：默认 20s deadline；超时即 `unavailable`，不无限等待。
- 缓存与授权记忆命中路径不得触发任何模型调用。

### 8.4 子代理覆盖范围（重要）

当前设计以 `reference/pi-packages` 中的 `@gotgenes/pi-subagents` **v21.7.1** 为对接版本。它在同一 pi runtime 内运行前台/后台子代理，子会话默认继承父 extensions，并通过 `pi.events` 发布可确定识别的 child lifecycle：

| 事件 | 用途 |
|---|---|
| `subagents:child:session-created` | 在 `bindExtensions()` 前同步注册子 `sessionId` |
| `subagents:child:bound` | 子扩展绑定完成后校验护栏是否实际加载 |
| `subagents:child:disposed` | 清理进程级子会话 registry |

证据：`reference/pi-packages/packages/pi-subagents/README.md:5-7`、`:252`、`:278-279`；`src/lifecycle/child-lifecycle.ts:18-80`；`src/lifecycle/create-subagent-session.ts:289-308`。

父会话与子会话的 grants / cache / breaker 不共享。`excludedExtensionPackages` 可以把本插件从子会话中排除，因此 `bound` 后必须显式告警，不能把"子代理继承 extensions 的默认值"当作永久安全保证。

## 9. 待确认问题

| 编号 | 问题 | 备选 |
|---|---|---|
| ~~Q1~~ | ~~默认动作矩阵~~ **已确认（2026-09-16）**：采用 FR-8 的 surface 矩阵——读取类 `allow`，`write` / `edit` / `bash` / `external_directory` / 未识别工具 `review` | — |
| ~~Q2~~ | ~~`deny` 后的人工申诉~~ **已确认（2026-09-16）**：不提供，见 D16 | — |
| ~~Q3~~ | ~~是否需要 `user_bash` 事件支持（拦截用户手输 `!command`）？~~ **已确认（2026-09-16）**：v1 支持，见 FR-60 / D24 | — |
| ~~Q4~~ | ~~审计日志是否需要轮转与保留策略？~~ **已确认（2026-09-16）**：按日切分，默认保留 14 天，可配置，见 FR-43 / D20 | — |
| ~~Q5~~ | ~~是否需要"只读命令白名单"的内置默认集？~~ **已确认（2026-09-16）**：内置一小组高置信命令；显式数组完整覆盖，见 FR-9 / D21 | — |
| ~~Q6~~ | ~~插件标识符命名~~ **已确认（2026-09-16）**：见下表 | — |

### 命名定稿（2026-09-16）

| 用途 | 取值 | 影响面 |
|---|---|---|
| npm 包名 / 仓库名 | `pi-permission-guardian` | 安装命令、`package.json`、`pi.extensions` 声明 |
| 配置目录名 | `pi-permission-guardian` | 全局 `<agentDir>/extensions/pi-permission-guardian/config.json`（FR-47）与项目级路径 |
| 日志目录名 | `pi-permission-guardian` | `<agentDir>/extensions/pi-permission-guardian/logs/`（FR-43） |
| 扩展入口文件 | `extensions/guardian.ts` | `package.json` 的 `pi.extensions` |
| 斜杠命令 | `/perm` | FR-39 全部子命令 |
| CLI flag | `--perm` | FR-40 |
| `appendEntry` 类型 | `pi-permission-guardian.decision.v1` | FR-45，需版本化且全局唯一 |
| 状态栏 key | `pi-permission-guardian:status` | FR-41 |

## 10. 验收总纲

除各条 FR 的验收标准外，整体交付需满足：

1. **不回归**：在启用本插件的会话中，S1 场景（常规读写与只读命令）不产生任何弹窗与模型调用。
2. **不静默放行**：任何 `unresolved` 事实、任何 `unavailable` 状态，都可从审计日志中追溯到"为什么这一步没有被拦住"。
3. **可解释**：每次拦截都能回答"命中了哪条规则"或"模型给出的理由是什么"。
4. **可关闭**：`/perm off` 后立即恢复到无护栏行为，且开关状态可见。
5. **可自检**：`/perm status` 能完整回答"当前规则集是什么、评审是否可用、tree-sitter 是否就绪"，不依赖查阅文档。
