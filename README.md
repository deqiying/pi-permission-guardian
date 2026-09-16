# pi-permission-guardian

pi agent 的命令执行护栏插件：**黑白名单快速裁决 + 名单外/需复查项交由模型判定**，在高风险操作与跨工作目录读写场景下减少人工介入。斜杠命令为 `/perm`。

> 当前状态：**M4 评审层与 `user_bash` 已实现**（配置加载/合并/规范化、`/perm` 命令、会话状态与审计日志、tree-sitter 事实提取、glob 规则求值、跨层最严格者合并、会话授权、`tool_call` 与 `user_bash` 端到端裁决、独立评审模型接入与 FR-23 风险门槛）。尚未实现的是降本机制（缓存、熔断、预评分）与子代理覆盖，见 `docs/implementation-plan.md` 的 M5/M6。

## 核心设计一句话

名单命中即裁决（零模型调用、零弹窗）；名单未命中或标记 `review` 时由配置指定的评审模型判断；任何不确定状态（解析失败、评审不可用、输出非法）都落到已知的安全分支，绝不静默放行。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/requirements.md](docs/requirements.md) | 背景、目标与非目标、用户场景、功能需求（FR-1~FR-62）、设计决策（D1~D25）、约束与已知限制 |
| [docs/architecture.md](docs/architecture.md) | 模块划分、决策管线、事实提取、规则引擎、评审器、降本机制、失败语义矩阵、打包与测试策略 |
| [docs/configuration.md](docs/configuration.md) | 全部配置字段的语义、规则编排顺序、surface 与默认动作矩阵 |
| [docs/implementation-plan.md](docs/implementation-plan.md) | M0~M7 实施顺序、逐阶段文件范围、测试门禁与完成定义 |

## 配置

参考配置：[`config/config.json`](config/config.json) —— **严格 JSON**，带 `$schema`，编辑器可直接补全与实时校验。

| 作用域 | 路径 | 生效条件 |
|---|---|---|
| 全局 | `<agentDir>/extensions/pi-permission-guardian/config.json` | 始终加载 |
| 项目 | `<cwd>/.pi/extensions/pi-permission-guardian/config.json` | 仅当项目被信任（`ctx.isProjectTrusted()`） |

**你手写的配置可以带注释与尾逗号**；官方参考配置不带注释，是为了让 `$schema` 保持有效——活的 schema 比死的注释更有用。理由与取舍见 [docs/configuration.md §1](docs/configuration.md)。

跨作用域合并时**最严格者胜**（`deny > ask > review > allow`）；同一作用域内**后写的规则覆盖先写的**（last-match-wins，所以具体规则必须写在宽泛规则之后）。

Schema：[`schemas/guardian.schema.json`](schemas/guardian.schema.json)。

### `/perm` 子命令

| 子命令 | 行为 |
|---|---|
| `/perm`、`/perm status` | 打印完整自检报告：总开关、配置路径与状态、规则条数、评审模型可用性、`userBashPolicy` / 子代理覆盖、grants / cache / 熔断计数、审计日志 |
| `/perm on` / `/perm off` | 仅本会话启用/停用护栏，优先于配置总开关与 `--perm` |
| `/perm reload` | 重新读盘、重新合并配置，规则条数与配置版本号会在 `status` 中变化 |
| `/perm grants` | 列出本会话的人工授权记忆（仅内存，会话结束失效） |
| `/perm clear-grants` | 清空本会话的授权记忆 |

`--perm` 命令行 flag 可在配置 `enabled: false` 时仍让会话参与裁决；实际是否生效按 `会话覆盖 > --perm / config.enabled` 的顺序决定。

## 开发

| 命令 | 用途 |
|---|---|
| `npm run typecheck` | 严格 TypeScript 检查（含测试与脚本） |
| `npm test` | vitest 单元测试 |
| `npm run gen:schema` | 从 `src/config/schema.ts`（zod 唯一真源）重新生成 `schemas/guardian.schema.json` |
| `npm run validate:config` | 校验官方参考配置是严格 JSON、且同时通过 zod 与提交版 schema |

修改配置结构时必须先改 zod schema，再跑 `gen:schema`；提交版 schema 与生成结果不一致时测试会失败（FR-57）。
运行时依赖只有 `zod`（配置 schema 的单一真源）；pi 相关包均为 `peerDependencies`，由宿主提供。

## 许可证

本项目使用 Apache License 2.0，全文见 [`LICENSE`](LICENSE)。

## 参考源码

`reference/` 下为只读查阅用的第三方源码，**不是运行依赖**，已加入 `.gitignore`。来源与版本见 [reference/README.md](reference/README.md)。
