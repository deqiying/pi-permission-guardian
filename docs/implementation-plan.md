# pi-permission-guardian 实施计划

- 配套文档：`docs/requirements.md`、`docs/architecture.md`、`docs/configuration.md`
- 目标运行环境：pi coding agent ≥ 0.85.1、Node ≥ 22
- 当前参考实现：`reference/pi-packages/packages/pi-permission-system`、`reference/pi-openai-toolkit/src/auto-mode`
- 实施原则：先形成可测试的单一决策内核，再依次接入 tool_call、user_bash 和子代理；每个里程碑结束时必须保持类型检查、单元测试和参考配置校验通过

## 1. 实施边界

v1 只实现需求文档中的 FR-1 至 FR-61。计划不包含以下工作：

- 不把插件扩展为系统级沙箱，也不承诺完整解析所有 shell 动态行为。
- 不实现跨进程授权转发、远程权限服务或历史坏数据修复。
- 不扩大子代理兼容范围，v1 只对接 `@gotgenes/pi-subagents` v21.7.1。
- 不增加插件级模型协议配置。评审模型只能来自 pi 模型配置文件，并沿用解析后 `Model` 的协议、认证、baseUrl 和 headers。
- 不通过替代内置工具实现拦截。tool_call 只返回阻断结果，user_bash 只在明确拒绝时返回替代 `BashResult`。

实施期间以 `docs/requirements.md` 为行为权威，以 `docs/architecture.md` 为模块边界权威，以 `docs/configuration.md` 和 `schemas/guardian.schema.json` 为配置权威。若实现需要改变其中任意契约，先单独更新设计文档并重新确认，不在代码中静默偏移。

## 2. 交付顺序

```text
M0 工程骨架
  -> M1 配置、生命周期与命令面
  -> M2 Facts 事实层
  -> M3 规则层与最小决策管线
  -> M4 评审层与 user_bash
  -> M5 降本机制与人工交互
  -> M6 子代理覆盖
  -> M7 分发、文档与端到端验收
```

依赖关系如下：

| 阶段 | 前置条件 | 原因 |
|---|---|---|
| M1 | M0 | 所有后续模块都通过 `ResolvedConfig` 和会话生命周期取得状态 |
| M2 | M0 | Facts 层应能脱离 pi 会话独立测试 |
| M3 | M1、M2 | 规则求值依赖规范化 facts，不能只匹配原始输入文本 |
| M4 | M3 | 评审只处理规则层已经标记为 `review` 或转人工的调用 |
| M5 | M4 | 缓存、熔断和预评分不能绕过评审失败语义 |
| M6 | M3 | 子代理先切换保守策略，再复用完整决策管线 |
| M7 | M1 至 M6 | 分发验收必须覆盖完整链路 |

## 3. M0 工程骨架

### 目标

建立可被 pi 加载、可运行类型检查和测试的最小 package，不包含业务裁决逻辑。

### 主要文件

```text
package.json
tsconfig.json
tsconfig.check.json
vitest.config.ts
extensions/guardian.ts
src/extension/register.ts
test/support/fake-pi.ts
test/support/fake-context.ts
```

### 工作项

1. 按架构文档创建 pi package 元数据和 `pi.extensions` 入口。
2. 配置 ESM、Node ≥ 22 和严格 TypeScript 检查。
3. 引入 `vitest` 作为测试运行器，不引入完整插件框架之外的新运行时依赖。
4. 建立最小假 `ExtensionAPI` 与假 `ExtensionContext`，能记录事件处理结果并模拟 UI、session、modelRegistry。
5. 扩展入口只调用 `registerGuardian(pi)`；不在工厂阶段读取配置或访问 `ctx`。

### 验证门禁

- `npm run typecheck`
- `npm test`
- 构造的最小扩展能被假 pi 加载，并注册预期事件与命令，不产生真实命令执行。

## 4. M1 配置、生命周期与命令面

### 目标

完成配置唯一真源、跨层合并、fail-closed 降级、`/perm` 命令和进程内状态骨架。

### 主要文件

```text
src/config/schema.ts
src/config/paths.ts
src/config/jsonc.ts
src/config/load.ts
src/config/merge.ts
src/config/normalize.ts
src/extension/state.ts
src/extension/startup.ts
src/extension/commands.ts
src/audit/logger.ts
src/audit/entry.ts
scripts/generate-schema.ts
```

### 实现顺序

1. 用 zod 定义 `GuardianConfig`，补齐默认值、未知字段拒绝、动作枚举和数值边界。
2. 实现全局配置与项目配置路径解析。项目配置只在 `ctx.isProjectTrusted()` 为真时加载。
3. 实现 JSONC 预处理，替换注释和尾逗号时保留换行，确保校验错误能映射回原文件行号。
4. 同层规则保持 last-match-wins；跨层动作按 `deny > ask > review > allow` 合并；`onMixedCommandActions` 按 `deny > ask > review` 合并。
5. 将 `path` 和 `external_directory` 语法糖展开为读写方向键，合成 baseline 规则表（默认动作矩阵，§6.4）
   并放在规则表第一位；`degraded` 时把 baseline 里的 `allow` 抬升为 `review`。baseline 是**兜底层**：
   只在 global / project 都未命中时才参与裁决（architecture §6.1）。
6. 项目未受信任时跳过项目层，按全局配置继续并显式提示；配置解析失败时按 FR-51 将该层所有 `allow` 抬升为 `review`，不允许静默放行。
7. 在 `session_start` 和 `before_agent_start` 刷新配置；在 `session_shutdown` 清理会话态。
8. 实现 `/perm on|off|status|reload|grants|clear-grants` 和 `--perm` flag。
9. 实现审计日志基础写入：按本地日期切分、默认保留 14 个自然日、异步失败只告警。POSIX 下创建权限为 `0600`，Windows 下记录平台限制。

### `/perm status` 初始合同

输出必须至少包含：

- 总开关、`--perm` override、`yoloMode`
- 全局与项目配置路径、配置是否有效、实际规则条数
- `gate` 覆盖面
- 评审模型 spec 与可用性
- `userBashPolicy` 状态与冲突标记
- `subagentCoverage`
- tree-sitter 是否预热
- grants、cache、breaker 计数

### 验证门禁

- 参考配置是严格 JSON，并通过生成的 schema 校验。
- JSONC 注释、字符串内 `//`、尾逗号、非法语法行号均有测试。
- 未知字段、非法动作、`retentionDays=0`、`subagentPolicy.defaultAction=allow` 被拒绝。
- 未受信任项目的项目配置不生效，且 `/perm status` 明确显示原因。
- `/perm reload` 后配置版本号变化；`session_shutdown` 后会话态清空。

## 5. M2 Facts 事实层

### 目标

从 tool_call 和 user_bash 的原始输入得到稳定、可测试、可标记 unresolved 的 facts。

### 主要文件

```text
src/facts/types.ts
src/facts/classify.ts
src/facts/path-value.ts
src/facts/readonly-paths.ts
src/facts/extractor-registry.ts
src/facts/bash/parser.ts
src/facts/bash/enumerate.ts
src/facts/bash/wrappers.ts
src/facts/bash/redirects.ts
src/facts/bash/path-tokens.ts
src/facts/bash/expansion.ts
src/facts/bash/readonly-commands.ts
test/fixtures/bash/*.txt
test/fixtures/bash/*.json
```

### 实现顺序

1. 定义 `Facts`、`CommandUnit`、`PathTarget`、`Direction` 和 `UnresolvedFact` 类型。
2. 建立工具名到 surface 的映射，覆盖 `bash`、`powershell`、`read`、`write`、`edit`、`find`、`grep`、`ls`、`external_directory` 和未知工具。
3. 用 `web-tree-sitter` 与 `tree-sitter-bash` 初始化 WASM parser；通过 `createRequire(import.meta.url)` 定位两个 wasm 文件。
4. 在 `before_agent_start`（首次时）预热 parser，失败时每会话提示一次。初始化失败时保留可重试错误，不把失败缓存为永久成功状态。
5. 枚举 `&&`、`||`、管道、命令替换、进程替换、子 shell、compound statement、heredoc 和 redirect 中的执行单元。
6. 收集容器节点的规范化文本作为调用级匹配目标（FR-62），使配置里的 `curl * | sh` 这类跨单元模式能命中。
7. 对 parse error、动态命令名、不可解析包装器产生 unresolved 标记；不得将已解析部分当作完整事实。
8. 识别 `sudo`、`xargs`、`bash -c`、`eval` 等间接执行并保守降级。
9. 对命令和路径执行 `$HOME`、`$PWD`、`~/`、Windows 路径和 MSYS 形式（`/c/x` → `C:\x`，仅 Windows 目标平台）归一化。
10. 只读命令白名单严格使用“可执行名 + 参数前缀”，内置集合保持最小（面向工作目录的只读操作），不为特定选项增加例外；带路径值的 `--opt=value` 会取消该次调用的免评审资格。

### 测试语料

至少覆盖：

- 单命令、管道、`&&`、`||`、分号；管道级模式的命中（`curl * | sh`）与引号内假管道的不命中
- `$()`、反引号、`<()`、`>()`、子 shell
- heredoc、输入重定向、输出重定向、`<>`
- `sudo`、`xargs`、`bash -c`、`sh -c`、`eval`
- 变量拼接、动态变量展开、未闭合引号、语法错误
- Windows 盘符、正反斜杠、`/c/...` MSYS 形式

### 验证门禁

- 每条语料同时断言命令单元、路径目标、读写方向、wrapper 标记和 unresolved 状态。
- 解析错误必须产生保守事实，不能返回空 facts。
- parser 预热失败后下一次调用可重试。
- 内置 `readOnlyCommands` 的参数前缀边界有正向和负向测试。

## 6. M3 规则层与最小决策管线

### 目标

让插件能够仅依靠规则、默认动作、会话授权和人工兜底完成裁决，不调用模型。

### 主要文件

```text
src/policy/action.ts
src/policy/glob.ts
src/policy/rules.ts
src/policy/evaluate.ts
src/policy/session-grants.ts
src/decision/pipeline.ts
src/decision/outcome.ts
src/interact/dialog.ts
```

### 实现顺序

1. 定义动作严格度、同层 last-match-wins 和跨层最严格者合并。
2. 实现 glob 编译与匹配：命令类规则同时匹配命令单元文本与调用级文本（FR-62），路径类规则匹配路径对象，工具类规则匹配工具名，另有 `*` 兜底。
   层内 last-match-wins、跨层最严格者；**baseline 层只在用户层全未命中时参与**，未识别工具走 `tool` 哨兵 surface。
3. 每个命令单元或路径对象独立求值，再按调用级规则合并。
4. 实现固定优先级：`unresolved + trusted deny -> ask`，其次处理 `allow + deny` 的 `onMixedCommandActions`，最后处理普通 `unresolved`。
5. 会话授权只接受人工对话框确认；模型 allow、缓存、自动审核和用户手输命令本身不能创建 grant。授权在规则求值**之后**参与：只把 `ask` / `review` 放宽为 `allow`，不覆盖 `deny`，`unresolved` 调用不走授权快路径（见 architecture §4/§8.1）。
6. 建立最小 decision pipeline，按 order 处理 engaged、classify、facts、gate、rule、grant、review、ask 和 outcome（cache 与熔断属 M5，本阶段不预置空壳）。
7. 为后续评审接入保留窄接口，但本阶段所有 `review` 可先转 `ask`，避免提前耦合模型实现。

### 验证门禁

- FR-1 至 FR-10、FR-29、FR-30、FR-59、FR-61 全绿。
- `echo ok && rm -rf /` 不能由第一个 allow 覆盖第二个 deny。
- **baseline 兑底不得压过用户显式写的 `allow`**：global 层写 `"rm -rf ./dist": "allow"` 时最终必须是 `allow`，而不是默认矩阵的 `review`（baseline 只在用户层全未命中时参与）。
- `unresolved + deny` 固定为 `ask`，不受 `onUnresolvedFacts` 放宽。
- 项目层不能放宽全局层的安全底线。
- 人工会话授权可复用；模型和缓存来源不能创建授权；授权不覆盖 `deny`，且 `facts` 带 `unresolved` 时跳过授权。
- 只读白名单在未命中用户规则时免评审放行（FR-9）：命令类工具不再额外补工具对象，否则默认矩阵的 `review` 会把它压回评审。

## 7. M4 评审层与 user_bash

### 目标

接入配置指定的独立评审模型，并让 `!command` 与 `!!command` 复用同一决策内核。

### 主要文件

```text
src/review/types.ts
src/review/prompt.ts
src/review/transcript.ts
src/review/verdict.ts
src/review/evidence.ts
src/review/reviewer.ts
src/decision/policy.ts
src/extension/user-bash.ts
src/extension/register.ts
```

### 实现顺序

1. 解析 `provider/model-id`，只通过 `ctx.modelRegistry.find` 解析模型；无法解析直接产生 `unavailable`。
2. 通过 `ctx.modelRegistry.complete(model, context, options)` 调用；不得自行选择 wire API，也不得覆盖模型配置中的认证、headers 或 baseUrl。`ReviewerRegistry` 只声明 `find` / `complete` 两个方法，使这条约束在类型层面成立。
3. 构造受预算约束的 prompt：待执行动作放在消息末尾，包含 facts、命中规则、cwd、授权摘要和必要 transcript；会话摘要以 **`[user]` 条目为锚点**分配预算（首条 + 最新一条优先），工具证据另给更小预算，缺失时明说缺失。
4. verdict 按 `constrainedSampling json_schema`、JSON 文本解析、`unavailable` 三段式降级，任何失败都不能猜成 allow；`strict` 用 `"prefer"`（`"require"` 会在 provider 不支持时让评审直接失败）；缺字段保守回填（`riskLevel` → `high`、`userAuthorization` → `unknown`）。
5. 用 `createReadOnlyTools(cwd)` 构建只读证据工具，按 `read` / `grep` / `find` / `ls` 白名单过滤后直接 `execute()`；结果截断 4000 字符回喂，并设置轮次上限与**单一 deadline**。
6. 接入 `ctx.signal`，区分 timeout、cancelled、provider-error、invalid-output 和 not-configured；超时与取消靠标志位而非 `AbortError` 区分。
7. 模型 allow 仍经过风险门槛（`reviewer.maxAllowRiskLevel`，默认 `medium`）；超过门槛转人工 `ask`，`deny` 直接阻断，`unavailable` 走 `onReviewUnavailable`（其中 `review` 按 deny fail-closed）。
8. `tool_call` 的 deny 返回 `{ block: true, reason }`；异常路径也必须 fail-closed。
9. 把管线入口抽象成 `DecisionRequest`（`origin` 区分两个入口），使 `user_bash` 复用同一内核：allow 返回 `undefined`，deny 返回替代 `BashResult`（`{output, exitCode: 1, cancelled: false, truncated: false}`，**不提供 `operations`**）。
10. `user_bash` 的 `review` 先过 `userBashPolicy.autoReview`（`false` 时不调模型直接转人工），模型解析顺序 `userBashPolicy.model` → `reviewer.model`；事件 cwd 传给 facts 层。
11. 发布 `pi-permission-guardian:user-bash-claim` 做 best-effort 共存检测，claim 携带实例 ID，订阅在组合阶段就位、忽略自身回声；冲突写一次性提示 + `kind: "user-bash-conflict"` 的 `appendEntry` + `userBashConflict` 状态位，不改变 handler 顺序。

### 验证门禁

- FR-19 至 FR-28、FR-60 全绿（`test/review/` 40 例、`test/decision/review-policy.test.ts` 与管线评审段、`test/extension/user-bash.test.ts` 与生命周期端到端）。
- 不同 `Model.api` 的假 registry 均按模型自身配置调用，且传给 `complete` 的选项只有 `signal` / `cacheRetention`（无协议与认证覆盖入口）。
- 评审超时、取消、provider 错误、畸形输出都不放行；`unavailable` 的理由包含"评审未完成"与"不代表该动作因风险被拒绝"。
- 评审模型 allow 不创建 grant，也不写缓存（缓存属 M5）。
- 模型 allow 且 `riskLevel` 超过门槛时转人工；`unavailable` 的四种 `onReviewUnavailable` 取值都有用例（含 `review` → deny）。
- 查证轮次受 `maxEvidenceRounds` 限制，最后一轮强制无工具作答；未知工具调用被拒绝并回喂。
- `!rm -rf /` 的 deny 返回替代结果且不提供 `operations`，`!` 与 `!!` 的结果完全相等。
- 声明冲突产生一次提示（UI / console 二选一）、一条会话记录并反映到 `/perm status`；自己的声明不触发提示。

## 8. M5 降本机制与人工交互

### 目标

加入缓存、熔断、正式人工对话框和可选预评分，同时保持失败语义不被降本机制放宽。

### 主要文件

```text
src/decision/cache.ts
src/decision/breaker.ts
src/review/classifier.ts
src/interact/dialog.ts
src/extension/startup.ts
```

### 实现顺序

1. 缓存 key 包含 facts、surface、规则版本、模型配置和授权版本；`unavailable` 不写缓存。
2. 会话授权命中先于缓存；deny 后的同工具重试必须同步评审，不进入历史快路径。
3. 熔断器按 turn 重置，区分模型 deny、人工拒绝和基础设施失败。
4. 人工对话框提供仅此次、本会话允许此类、拒绝、拒绝并说明；只有本会话允许创建 grant。
5. 预评分默认关闭。启用后只允许低风险 allow 走滞后快路径，不能覆盖 deny、unresolved 或高风险管理要求。
6. 将状态栏和 `pi.appendEntry` 输出接到统一 outcome，防止不同入口生成不同字段。

### 验证门禁

- FR-31 至 FR-38、FR-41、FR-42 全绿。
- cache 不固化 `unavailable`、`ask` 或人工临时 allow。
- 熔断只影响允许的后续调用，不把基础设施失败伪装为风险 deny。
- `/perm grants` 与 `/perm clear-grants` 和真实会话态一致。
- 预评分关闭时不发起任何额外模型调用。

## 9. M6 子代理覆盖

### 目标

识别 `@gotgenes/pi-subagents` v21.7.1 的子会话，应用保守策略，并显式报告护栏缺失。

### 主要文件

```text
src/extension/subagents.ts
src/extension/register.ts
src/extension/startup.ts
src/policy/evaluate.ts
src/decision/pipeline.ts
```

### 实现顺序

1. `extension/subagents.ts` 在进程级存储（`globalThis` + `Symbol.for()`）中订阅 `subagents:child:session-created`、`bound` 和 `disposed`。
2. `session-created` 注册必须保持同步，确保子扩展绑定前已有 sessionId 记录（核心在 `bindExtensions()` 之前同步发出，事件总线同步派发）。
3. 子扩展在 `session_start` 把自己的 sessionId 写进同一个进程级存储作为绑定握手，并在命中 registry 时把 `runtime.isSubagentSession` 置位（必须在 `runtime` 重置之后）。
4. 父实例在 `bound` 时核对握手：有 UI 用 `ctx.ui.notify(..., "warning")`，无 UI 用 `console.warn`，可见告警每个父会话只发一次。
5. 每个受影响的子会话都追加 `pi-permission-guardian.subagent-warning.v1`，并把父会话 `subagentCoverage` 标为 `unguarded`。
6. 命中子会话且 `subagentPolicy.enabled` 时，把默认动作矩阵的动作抬到 `subagentPolicy.defaultAction`（取最严格者），只收紧默认动作，不放宽显式规则，也不影响只读白名单与 `onUnresolvedFacts`；父子不共享 grants / cache / breaker（后三者本来就是会话内存）。
7. `allowSessionGrants=false` 时子代理既不查询也不写入会话授权，对话框也不提供“本会话允许此类”。
8. 无法识别子代理时，`/perm status` 必须显示“未识别，使用父策略”；发现未加载护栏的子会话时显示 `unguarded` 并列出子会话 ID。

### 验证门禁

- FR-54 至 FR-56 全绿。
- 子会话中的 deny 规则不能被父策略或子代理绕过。
- 缺失握手产生 UI、console、appendEntry 和 status 四处一致证据。
- `disposed` 后 registry 清理，不污染相同 sessionId 的后续测试。

## 10. M7 分发、文档与端到端验收

### 目标

形成可安装、可自检、可回滚的 pi package。

### 主要文件

```text
package.json
.github/workflows/ci.yml
scripts/check-pack.ts
README.md
docs/smoke-test.md
schema generation script
```

### 工作项

1. `files` 覆盖 `extensions/`、`src/`、`schemas/`、`config/` 与文档（README、LICENSE、`docs/`）；由 `scripts/check-pack.ts`（`npm run check:pack`）真实执行一次 `npm pack --dry-run --json` 并断言：必需文件齐全、`pi.extensions` 入口的相对 import 闭包全在 tarball 内、不含 `test/` `scripts/` `reference/` `node_modules/` `.github/`。
2. `prepack` 在打包前重新生成 schema，保证发出去的那份永远与 zod 同步；“提交版 schema 与 zod 输出一致”的漂移门禁由 `test/config/schema.test.ts` 与 `check:pack` 的“prepack 是否就地改写”检测共同承担。
3. README 增加安装（npm / git / 本地路径、全局与 `-l` 项目级、`pi -e` 试用）、卸载回滚、`/perm` 命令、已知限制与平台验证范围。
4. CI（`.github/workflows/ci.yml`）在 `ubuntu-latest` 与 `windows-latest` 上依次执行 typecheck、test、`validate:config`、`check:pack`（含 package dry-run）；触发条件是推送发布版本 tag（`v*`）或手动 `workflow_dispatch`，PR 与 `main` 直推不触发（一次发布只跑一轮门禁）。
5. 真实 pi 0.85.1 会话冒烟：不依赖评审模型与交互 UI 的环节已在 Windows 执行并记录在 `docs/smoke-test.md`（安装/卸载、加载、`/perm status`、S1、S2、S6 未配置分支、非法配置 fail-closed、审计落盘）；S3、S4 的工具路径、S5、S7 与真实超时分支需人工执行，同文档给出步骤、期望与未验证的边界。

### 验证门禁

- `npm run typecheck`
- `npm test`
- `npm run validate:config`
- `npm run check:pack`（内部执行 `npm pack --dry-run`）

### 最终验收

- 全局安装和项目级加载均能工作。
- `/perm status` 足以定位规则、模型、parser、user_bash 冲突和子代理覆盖状态。
- 参考配置可直接加载，非法配置 fail-closed。
- 所有负向测试通过，尤其是 deny 绕过、评审不可用、异常路径和子代理缺口。

## 11. 测试分层与命令

| 层 | 主要方式 | 对应里程碑 |
|---|---|---|
| schema/config | 纯函数、临时目录、快照 | M1 |
| facts/bash | 语料驱动、AST 快照 | M2 |
| policy | 表驱动纯函数测试 | M3 |
| decision pipeline | 假 registry、假 UI、假 clock | M3 至 M5 |
| review | 假 `complete`、不同 Model.api、超时与畸形输出 | M4 |
| extension integration | 假 ExtensionAPI/Context 记录返回结果 | M4 至 M6 |
| package | schema 正负校验、`npm pack --dry-run` 内容断言（`npm run check:pack`） | M7 |
| 手动冒烟 | 真实 pi 会话（记录见 `docs/smoke-test.md`） | M7 |

每个里程碑合并前至少执行：

```bash
npm run typecheck
npm test
```

涉及 schema 或配置时额外执行：

```bash
npm run gen:schema
npm run validate:config
```

涉及 package 元数据时额外执行：

```bash
npm run check:pack
```

`check:pack` 内部执行 `npm pack --dry-run`，并断言 tarball 内容与 schema 漂移；CI 同样用它代替裸露的 dry-run。

命令名以 M0 实际 package scripts 为准；若调整，必须同步 CI 和本计划。

## 12. 代码审查重点

每个里程碑评审时优先检查以下不变量：

- 是否存在绕过统一 pipeline 的第二条裁决路径。
- 是否把 unresolved、评审失败、解析失败或配置失败放宽为 allow。
- 是否让模型、缓存或自动审核创建会话授权。
- 是否在插件中硬编码模型协议或自行处理认证。
- 是否用原始命令字符串替代 AST facts。
- 是否扩大内置只读集合或加入特定选项例外。
- 是否在父会话和子会话之间共享 grants、cache 或 breaker。
- 是否把不可观测的共存边界描述成已保证行为。

## 13. 完成定义

满足以下条件后，v1 才视为实施完成：

1. FR-1 至 FR-61 均有对应实现或明确的文档化边界。
2. 架构文档列出的所有负向测试均存在并稳定通过。
3. pi 0.85.1 下真实安装、加载、`/perm status` 和 S1 至 S7 冒烟通过（已执行范围与待人工场景见 `docs/smoke-test.md`）。
4. 参考配置、schema、README 和实现行为一致。
5. 不存在未说明的 fail-open 分支、未受控外部协议覆盖或绕过子代理护栏的已知路径。
