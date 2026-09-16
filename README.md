# pi-permission-guardian

pi agent 的命令执行护栏插件：**黑白名单快速裁决 + 名单外/需复查项交由模型判定**，在高风险操作与跨工作目录读写场景下减少人工介入。斜杠命令为 `/perm`。

> 当前状态：**需求与架构设计阶段**，尚未实现。

## 核心设计一句话

名单命中即裁决（零模型调用、零弹窗）；名单未命中或标记 `review` 时由配置指定的评审模型判断；任何不确定状态（解析失败、评审不可用、输出非法）都落到已知的安全分支，绝不静默放行。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/requirements.md](docs/requirements.md) | 背景、目标与非目标、用户场景、功能需求（FR-1~FR-61）、设计决策（D1~D25）、约束与已知限制 |
| [docs/architecture.md](docs/architecture.md) | 模块划分、决策管线、事实提取、规则引擎、评审器、降本机制、失败语义矩阵、打包与测试策略 |
| [docs/configuration.md](docs/configuration.md) | 全部配置字段的语义、规则编排顺序、surface 与默认动作矩阵 |

## 配置

参考配置：[`config/config.json`](config/config.json) —— **严格 JSON**，带 `$schema`，编辑器可直接补全与实时校验。

| 作用域 | 路径 | 生效条件 |
|---|---|---|
| 全局 | `<agentDir>/extensions/pi-permission-guardian/config.json` | 始终加载 |
| 项目 | `<cwd>/.pi/extensions/pi-permission-guardian/config.json` | 仅当项目被信任（`ctx.isProjectTrusted()`） |

**你手写的配置可以带注释与尾逗号**；官方参考配置不带注释，是为了让 `$schema` 保持有效——活的 schema 比死的注释更有用。理由与取舍见 [docs/configuration.md §1](docs/configuration.md)。

跨作用域合并时**最严格者胜**（`deny > ask > review > allow`）；同一作用域内**后写的规则覆盖先写的**（last-match-wins，所以具体规则必须写在宽泛规则之后）。

Schema：[`schemas/guardian.schema.json`](schemas/guardian.schema.json)。

## 许可证

本项目使用 Apache License 2.0，全文见 [`LICENSE`](LICENSE)。

## 参考源码

`reference/` 下为只读查阅用的第三方源码，**不是运行依赖**，已加入 `.gitignore`。来源与版本见 [reference/README.md](reference/README.md)。
