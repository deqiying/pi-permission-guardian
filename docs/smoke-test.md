# M7 手动冒烟与平台边界

> 状态：**部分执行**。已在 Windows 11 + pi 0.85.1 上跑完所有不依赖评审模型、弹窗与真实子代理会话的环节（安装 / 自动发现加载 / 自检 / 只读放行 / 规则拦截 / 评审不可用 / 非法配置 / 审计落盘 / 卸载），以及 M8（只读档案与免评审）的真实会话复现（§3.10）。
> 需要真实评审模型、交互弹窗与真实子代理会话的场景（S3、S4 的工具路径、S5、S7 及 S6 的真实超时分支）**尚未执行**，见 §4。

本文件对应 `docs/implementation-plan.md` §10（M7 工作项 5）与 `docs/requirements.md` §10 的验收总纲，给出 S1~S7 的复现步骤、已观察结果和未覆盖边界。自动化门禁（typecheck / test / schema 与配置校验 / 打包内容校验）见 §6，不在此处重复。

## 1. 环境

| 项 | 本次取值 |
|---|---|
| 平台 | Windows 11（本机），Git Bash 驱动命令 |
| pi | 0.85.1（`pi --version`） |
| Node | 26.8.2（npm 11.19.1）；`engines` 只要求 ≥ 22 |
| 插件来源 | 本仓库源码目录，以及由 `npm pack` 产出的 tarball 解包目录 |

## 2. 隔离原则

验证过程**不触碰真实的 `~/.pi/agent`**：让 pi 把配置目录指向临时目录，再用临时项目目录承载项目级配置。

```bash
TMP="$(mktemp -d)"
AGENT="$TMP/agent"          # 冒充 <agentDir>：设置文件、日志、npm 缓存都落在临时目录
PROJ="$TMP/proj"            # 冒充项目根：项目级配置与设置写在这里
mkdir -p "$AGENT" "$PROJ"
export PI_CODING_AGENT_DIR="$AGENT" PI_OFFLINE=1
```

两个必须知道的约定：

- **项目级配置需要信任**：pi 只在 `ctx.isProjectTrusted()` 为真时加载项目层配置，脚本化验证要加 `--approve`（`-a`）。`pi remove -l` 同样需要 `-a`，否则提示 `Project is not trusted`。
- **RPC 驱动要留住 stdin**：`pi --mode rpc` 读到 stdin EOF 就会收尾退出。一次性 `echo` 进去的命令可能来不及产生响应；复现时每条命令后保留几秒（本文用 `sleep 4`）。

## 3. 已执行项与结果

### 3.1 打包内容（M7 工作项 1）

```bash
npm run check:pack        # 内部执行 `npm pack --dry-run --json` 后断言内容
```

观察：`58 个文件，189 KB`；`必需文件 7 项均在 tarball 内`；`未包含 test/ scripts/ reference/ node_modules/ .github/ dist/`；`入口闭包 48 个文件全部在 tarball 内`。

负向复核（改坏后再恢复）：

| 制造的问题 | 结果 |
|---|---|
| 从 `files` 移除 `src` | `FAIL tarball 缺少入口闭包中的文件：src/extension/register.ts、… 等 48 项`，退出码 1 |
| 手工在 `schemas/guardian.schema.json` 尾部插入一个换行 | `FAIL 提交版 schemas/guardian.schema.json 与 zod 输出漂移：prepack 已就地重新生成`，退出码 1；随后文件内容与生成结果一致 |

### 3.2 tarball 可安装、可加载

```bash
npm pack --pack-destination "$TMP"                 # 产出 pi-permission-guardian-0.1.0.tgz
mkdir -p "$TMP/extract" && tar -xzf "$TMP"/*.tgz -C "$TMP/extract"
cd "$TMP/extract/package" && npm install --omit=dev --no-audit --no-fund   # 只装 dependencies，模拟 pi 的安装
pi install "$TMP/extract/package"                  # 注册到临时 <agentDir> 的 settings.json
cd "$PROJ" && { printf '%s\n' '{"id":"s","type":"prompt","message":"/perm status"}'; sleep 4; } \
  | pi --mode rpc --no-session -a
```

观察：解包目录只含 `LICENSE README.md config docs extensions package.json schemas src`；`npm install --omit=dev` 成功（说明运行时依赖都在 `dependencies` 里）；RPC 会话返回完整 `/perm status` 报告与 `setStatus perm: on`，即**从 tarball 安装的包能被真实 pi 加载并裁决**。

### 3.3 安装 / 卸载（全局与项目作用域）

| 操作 | 观察 |
|---|---|
| `pi install <path>` | 写入 `<agentDir>/settings.json` 的 `packages`；`pi list` 列出该包 |
| `pi remove <path>` | `packages` 变为 `[]`；`pi list` 显示 `No packages installed.` |
| `pi install -l <path>` | 写入 `<cwd>/.pi/settings.json` 的 `packages` |
| `pi remove -l <path>`（未信任项目） | 被拒：`Project is not trusted. Use --approve to modify local package config.`；加 `-a` 后成功 |
| 卸载后 `<agentDir>/extensions/pi-permission-guardian/` | **仍存在**（配置与审计日志是插件自己的数据，`pi remove` 只改设置文件） |

### 3.4 `/perm status` 自检覆盖面

RPC 会话里的实际输出行：

```text
- 总开关：开（config.enabled）｜--perm：否｜会话覆盖：无｜实际：参与裁决
- yoloMode：关
- 配置版本：1｜规则：用户 0 条 + 合成默认 11 条
- 合成默认（baseline）：surface 11 个｜只在用户层全未命中时参与
- 全局配置：<agentDir>/extensions/pi-permission-guardian/config.json｜状态 missing｜surface 0 个｜规则 0 条
- 项目配置：<cwd>/.pi/extensions/pi-permission-guardian/config.json｜状态 loaded｜surface 1 个｜规则 1 条
- gate：side-effect
- 评审模型：未配置（需要评审时判为 unavailable，按 onReviewUnavailable 处理）
- userBashPolicy：enabled=true autoReview=true model=复用 reviewer.model｜冲突：无
- subagentPolicy：enabled=true defaultAction=review allowSessionGrants=false
- subagentCoverage：未识别，使用父策略
- bash 解析器：未就绪（命令会按不可静态展开处理）
- 计数器：grants 0｜cache 0（TTL 300000ms / 上限 200）｜熔断 连续 0 / 窗口 0
- 降本机制：预评分 关闭（默认；开启后只会放行，永不拒绝）
- 审计日志：启用｜保留 14 天｜已写 0 条｜写盘失败 0 次｜目录 <agentDir>/extensions/pi-permission-guardian/logs
- 失败分支：onReviewUnavailable=deny onUnresolvedFacts=review onAskWithoutUI=deny onMixedCommandActions=deny
```

（审计那行的 `已写 0 条` 是会话刚启动就查询的结果；此后每一条裁决都会递增，落盘样例见 §3.9。）

结论：规则来源与条数、评审模型可用性、parser 就绪状态、`user_bash` 冲突标记、子代理覆盖状态都能从这一条输出定位，符合 M7 验收要求。

两个已知的显示语义（不是缺陷）：

- `bash 解析器：未就绪`：预热发生在 `before_agent_start`（本轮第一次模型轮次开始前）。没有模型轮次的会话里它就一直是"未就绪"，此时命令按不可静态展开处理（fail-closed）。
- `subagentCoverage：未识别，使用父策略`：普通会话的预期值；真实子代理会话见 §4。

### 3.5 S1 只读命令免评审

```bash
{ printf '%s\n' '{"id":"b","type":"bash","command":"ls -la"}'; sleep 4; } | pi --mode rpc --no-session -a
```

观察：`pi-permission-guardian.decision.v1` 会话条目为 `decision: allow, source: policy, surface: bash, reason: 命中只读命令白名单（FR-9）`，命令真实执行（`exitCode: 0`、有输出），全程**零模型调用**。

同一会话里 `echo hello-guardian` 不属于白名单：默认动作为 `review`，而本次没有配置评审模型，于是落到 `onReviewUnavailable=deny`。即 S1 的"零弹窗"只对白名单/`allow` 规则成立，其它命令仍按默认动作与失败分支裁决。

### 3.6 S2 明确 deny 且命令未执行

```bash
mkdir -p "$PROJ/dist" && touch "$PROJ/dist/sentinel.txt"
mkdir -p "$PROJ/.pi/extensions/pi-permission-guardian"
cat > "$PROJ/.pi/extensions/pi-permission-guardian/config.json" <<'EOF'
{ "permission": { "bash": { "rm -rf ./dist*": "deny" } } }
EOF
{ printf '%s\n' '{"id":"b","type":"bash","command":"rm -rf ./dist"}'; sleep 4; } | pi --mode rpc --no-session -a
```

观察：条目为 `decision: deny, source: policy, matchedPattern: rm -rf ./dist*`，reason 含反规避条款；RPC 的 bash 响应是护栏返回的替代结果（`exitCode: 1`），`$PROJ/dist/sentinel.txt` **仍然存在** —— 拦截发生在执行前。

### 3.7 S6 评审不可用（未配置分支）：不放行

在没有 `reviewer.model` 的会话里执行任意非白名单命令，观察：`decision: deny, source: policy, verdict: unavailable`，理由明确写"评审未完成……**不代表该动作因风险被拒绝**"，并给出安全替代路径。即 fail-closed 且不会让 agent 学到"因风险被拒"的错误结论。

### 3.8 FR-51 非法配置：坏层不生效、不放宽

```bash
cat > "$PROJ/.pi/extensions/pi-permission-guardian/config.json" <<'EOF'
{ "permission": { "bash": { "rm -rf ./dist": "yolo" } } }
EOF
```

观察：会话内出现四条告警（配置校验失败 → 逐字段忽略 → `提高 allow 后仍无任何字段可用，该层整体不生效；未命中规则的默认动作按保守侧处理（FR-51）`）；`/perm status` 报 `配置版本：1｜…｜存在失效层（默认动作已收紧）` 与 `项目配置：状态 invalid：配置校验失败，该层未生效｜规则 0 条`。

同会话里 `ls` 仍按内置只读白名单 `allow`：白名单是**配置无关的内置默认**，坏层既不能放宽它也不能收紧它。当时被收紧的是合成默认动作矩阵：`degraded` 时其中的 `allow` 抬升为 `review`（`docs/architecture.md` §6.1 当时语义，本次未单独构造用例）。

> **已于 D26 修正（FR-51 / FR-63）**：失效层的保守落点改为 `ask`（人工确认）。“抬到 `review`”在 `reviewer.model` 未配置、或恰好在失效层里被逐字段抢救掉时会落成 `onReviewUnavailable`（默认 `deny`），使**配置错误表现为无差别拦截，且理由指向评审模型**。新语义下本节场景的期望是：非白名单调用（含内置 `read`）落 `ask` 并弹人工确认，理由写明“存在失效配置层”；`ls`（只读白名单）仍 `allow`。本节已观察结果对应修正前的代码，下一次冒烟按新期望执行。

### 3.9 审计日志（FR-43 / FR-45）

观察：条目同时出现在两处 —— 会话内的 `pi-permission-guardian.decision.v1` `entry_appended` 事件，以及落盘文件

```text
<agentDir>/extensions/pi-permission-guardian/logs/guardian-2026-09-16.jsonl
```

实际落盘字段（真实样例，已截断 reason）：

```json
{"ts":"…","sessionId":"…","toolCallId":"user_bash#2","callIndex":2,"toolName":"bash","surface":"bash","targets":["rm -rf ./dist"],"matchedPattern":"rm -rf ./dist*","action":"deny","source":"policy","latencyMs":2,"reason":"命中规则 …"}
{"ts":"…","sessionId":"…","toolCallId":"user_bash#1","callIndex":1,"toolName":"bash","surface":"bash","targets":["echo hello-guardian"],"matchedPattern":"*","action":"deny","source":"policy","latencyMs":26,"reason":"评审模型未配置或无法解析…","verdict":"unavailable"}
```

### 3.10 M8 只读档案与免评审（真实会话，2026-09，零模型调用）

目标：在真实 pi 会话里确认 FR-65~FR-70 的落地效果 —— 高频只读命令免评审、危险写法仍被拦住、取消原因可在审计里读到。

```bash
export PI_CODING_AGENT_DIR=/tmp/agent PI_OFFLINE=1     # 隔离的 <agentDir>，内含参考配置
{
  printf '%s
' '{"id":"b1","type":"bash","command":"rg -n readOnlyProfiles src | head -2"}'; sleep 5
  printf '%s
' '{"id":"b2","type":"bash","command":"ls 2>/dev/null | head -2"}'; sleep 5
  printf '%s
' '{"id":"b3","type":"bash","command":"rg --pre echo -n x src/config | head -2"}'; sleep 6
} | pi --mode rpc --no-session -a -e <仓库路径>
```

观察到的裁决条目：

| 命令 | 结果 |
|---|---|
| `rg -n readOnlyProfiles src \| head -2` | `decision: allow, source: policy, reason: 命中只读命令档案（FR-9 / FR-65）`，命令真实执行（`exitCode: 0` + 输出），**零模型调用** |
| `ls 2>/dev/null \| head -2` | `decision: allow, source: policy`，同样真实执行（FR-67 的空设备 sink 生效） |
| `rg --pre echo -n x src/config \| head -2` | `decision: deny, matchedPattern: "*", verdict: unavailable, readOnlyCancel: unsafe-option:--pre` —— 档案检查取消免评审（FR-66），随后评审不可用 → `onReviewUnavailable=deny`（fail-closed），命令未执行（替代结果 `exitCode: 1`） |

审计落盘（`<agentDir>/extensions/pi-permission-guardian/logs/guardian-<date>.jsonl`）同样带 `readOnlyCancel: "unsafe-option:--pre"`，即"为什么又去评审"可以直接查（FR-69）。

`/perm status` 新增行：

```text
- 只读档案：内置分组 [search, vcs-read]｜自定义 0 条｜旧白名单 10 条｜共展开 30 条档案｜额外写入 sink 0 个（内置 /dev/null、win32 下的 NUL 始终生效）
```

未在真实会话里覆盖：`git` 子命令族与自定义档案（已由 `test/facts/bash/readonly-profiles.test.ts` 的逐条行为表覆盖，含 `find -delete`、`git branch -D`、`git -c … status`、`sed -i` 等负向用例）。

### 3.11 常见组合命令与透明前缀（真实会话，2026-09，零模型调用）

目标：确认 D28 修订（默认六组）与 D33（透明前缀内推）在真实会话里的效果。

```bash
{
  printf '%s
' '{"id":"b1","type":"bash","command":"rg -n readOnlyProfiles src && echo done"}'; sleep 5
  printf '%s
' '{"id":"b2","type":"bash","command":"timeout 5 rg -n readOnlyProfiles src/config"}'; sleep 5
  printf '%s
' '{"id":"b3","type":"bash","command":"which node && date"}'; sleep 5
  printf '%s
' '{"id":"b4","type":"bash","command":"cat package.json | sort"}'; sleep 5
} | pi --mode rpc --no-session -a -e <仓库路径>
```

| 命令 | 结果 |
|---|---|
| `rg -n readOnlyProfiles src && echo done` | `allow, source: policy`，两个单元都免评审（`print` 分组），命令真实执行 |
| `timeout 5 rg -n readOnlyProfiles src/config` | `allow, source: policy`（透明前缀内推后按 `rg` 判定） |
| `which node && date` | `allow, source: policy`（`system` 分组） |
| `cat package.json \| sort` | `deny`（`sort` 在默认关闭的 `text-tools` 分组里 → `review` → 评审不可用 → fail-closed），**未执行** |

最后一行是**预期边界**：未声明档案的命令仍然逐次评审（D29），把 `text-tools` 加进 `readOnly.profiles` 即可放行。

## 4. 待人工执行（需要真实模型 / 交互 UI / 真实子代理）

| 场景 | 为什么不能脚本化 | 最小步骤 | 期望 |
|---|---|---|---|
| **S3** 名单外命令交评审模型 | 需要真实评审模型调用 | 配 `reviewer.model`，在真实会话里让 agent 跑一条非白名单命令（如 `npx some-tool --fix .`） | 不弹窗；审计 `source=reviewer`、记录模型名、`verdict` 与耗时 |
| **S4** 跨工作目录读写 | 需要真实 `read`/`write`/`ls` 工具调用 | 让 agent 读 `~/.pi/agent/` 下文件、写 `../other-project/` 下文件 | 读按 `external_directory_read`、写按 `external_directory_write` 独立裁决；`.env`/`.ssh` 直接 `deny` |
| **S5** 人工兜底与记忆 | 需要交互式对话框 | 让 agent 触发 `ask`，选"本会话允许此类" | 等价 intent 不再询问、不再走模型；`/perm grants` 可见；会话结束失效 |
| **S6 真实失败分支** | 需要真实超时/断网 | 配一个不可达的 `reviewer.model`，或运行中掐网 | 与 §3.7 相同的不放行语义，且 `latencyMs` 反映 deadline |
| **S7** 子代理 | 需要 `@gotgenes/pi-subagents` v21.7.1 真实子会话 | 在配好该插件与评审模型的会话里派生子代理并执行 `rm -rf` 类命令 | 拦截生效；`/perm status` 的 `subagentCoverage` 不再是"未识别"；未加载护栏时可见告警 + `guardian-warning` 条目 |
| **`--perm` flag / TUI 状态栏** | 需要真实 TUI 会话 | `pi --perm`（配置 `enabled: false` 时） | 会话参与裁决；状态栏显示 `perm: on` 与最近决策 |
| 交互式 UI 的确认框外观 | 需要真实 TUI | 触发一次 `ask` | 弹窗给出建议动作与依据，"仅此次允许" / "本会话允许此类" 两个选项 |

`/perm on | off | reload | grants | clear-grants` 的行为由 `test/extension/` 与 `test/extension/reduction.test.ts` 的集成用例覆盖（假 `ExtensionAPI`/`ExtensionContext`），但**未在真实会话里逐条执行**。

## 5. 平台与已知边界

| 边界 | 状态 |
|---|---|
| Windows 11 + pi 0.85.1 真实会话 | 已执行（§3 各项） |
| Linux / macOS 真实会话 | **未验证**：CI 在 `ubuntu-latest` 跑 typecheck/test/打包校验，但不跑真实 pi 会话冒烟 |
| Windows CI（`windows-latest`） | 覆盖 typecheck/test/打包校验；真实 pi 会话冒烟同样未纳入 CI |
| 真实子代理生命周期 | **未验证**：仅单测 + 假事件覆盖（`@gotgenes/pi-subagents` v21.7.1 是唯一兼容目标） |
| 其他 `user_bash` 拦截器的加载顺序 | **不可观测边界**：只提示冲突，不调整加载顺序、不强制接管 |
| PowerShell | 没有解析器：命令整体 `unparsed-language`，规则最多给到 `review`/`ask` |
| UNC 路径（`\\server\share\x`） | 只做词法归一，不做 realpath（避免 SMB 阻塞） |
| Windows 日志文件权限 | `mode: 0600` 在 Windows 被忽略（POSIX 生效）；保护依赖用户主目录 ACL |
| 审计日志落盘的时机 | `record()` 只入队，`session_shutdown` 才 `flush()`；进程被强杀时尾部条目可能缺失（不影响裁决，只影响可追溯性） |
| bash 静态分析固有边界 | 别名不展开、`eval`/`bash -c` 内部不可知、非字面 `cd` 之后的相对路径不可解析 → 一律 `unresolved` → `onUnresolvedFacts`（默认 `review`），**不放行**；完整清单见 `docs/requirements.md` §8.2 |
| 子命令族的写文件选项 | `git diff`/`git log`/`git show` 按用户决策保留在免评审白名单内；`--output <file>` 空格写法与值不像路径的写法是已知残余面，可用 `"git diff --output*": "review"` 封死 |

## 6. 自动化门禁与本文件的关系

```bash
npm run typecheck        # 严格 TS 检查（src/ scripts/ test/）
npm test                 # vitest：含 schema 漂移、负向测试与集成用例
npm run validate:config  # 参考配置是严格 JSON 且通过 zod 与提交版 schema
npm run check:pack       # npm pack --dry-run + tarball 内容断言 + schema 漂移检测
```

前三条在 `.github/workflows/ci.yml` 里于 `ubuntu-latest` 与 `windows-latest` 双平台执行，最后一条放在末尾（`prepack` 会重新生成 schema，漂移检测必须先跑完）。CI 由发布版本 tag（`v*`）触发，PR 与 `main` 直推不触发，所以这些命令也是 PR 交付前的本地门禁。本文件记录的真实会话冒烟不在 CI 内，属于交付前的人工门禁。

双平台注意：`.gitattributes` 把文本文件钉在 LF（`core.autocrlf` 会把 schema 改成 CRLF，使漂移检测假失败）；`test/facts/path-value.test.ts` 的临时目录从真实形起算（windows-latest 的 `%TEMP%` 是 `C:\Users\RUNNER~1\…` 这类 8.3 短名，realpath 会还原成长名）。
