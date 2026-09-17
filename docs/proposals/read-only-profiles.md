# 只读命令与选项名单优化提案

- 状态：**已实现（2026-09）**。落地结果：`docs/requirements.md` FR-65~FR-70 + D21 修订 + D28~D32、`docs/architecture.md` §5.2/§5.3/§5.4、`docs/configuration.md` §7、`docs/implementation-plan.md` §11（M8）；代码在 `src/facts/bash/argv.ts`、`readonly-commands.ts`、`path-tokens.ts`、`redirects.ts`、`enumerate.ts`、`src/config/readonly.ts`、`src/config/schema.ts`；行为表见 `test/facts/bash/readonly-profiles.test.ts`。
- **未实现（有意留待用户裁决）**：P2a 透明前缀包装器内推（`timeout` / `nice` / `env` / `command`）——它要求修订 FR-12“indirection 包装器不得放行”的既有契约，属**放宽**而非精化，因此单独提请确认；`cd` / `pushd` 进入默认免评审集同样待裁决（见 `docs/requirements.md` Q9）。
- 关联需求与决策：FR-9、FR-13、FR-15、FR-62、D21、`docs/requirements.md` §8.2、`docs/architecture.md` §5.3。
- 证据环境：Windows 11 + Node 26，仓库当前源码与 `config/config.json`；实测脚本见 §10。文中结论一律标注「实测」或「待核实」，未实测项不得当成依据。
- 范围（2026-09 用户确认）：**P0 + P1 + P2 一次交付**；内置档案按 D28 取**最小集默认开启**；`sed` 不默认收录，只在示例配置里给保守形态。

## 1. 问题陈述

现象（用户报告）：`rg` 这类常见只读命令也会走评审，agent 执行命令时大量时间耗在审核只读命令上。

事实层面的原因不是「白名单条目太少」，而是**只读判定只用了「argv 前缀」一个维度**，把 tree-sitter 解析树里已经拿到的结构信息全部丢弃了。因此出现 5 类缺陷，其中 3 类即使把 `rg` 加进白名单也不会消失，1 类还会因为盲目扩表而**开出口子**：

| 编号 | 缺陷 | 后果 |
|---|---|---|
| R1 | 内置集只有 10 条，且「显式配置即完整覆盖」 | 未列出的命令一律 `review`（同步模型调用） |
| R2 | 参数角色缺失：命令级统一方向归因 | 模式/数值参数被当成路径（幽灵目标）、误 `deny`、脏审计与缓存键；`--opt=<像路径>` 一刀切取消免评审 |
| R3 | 重定向写入空设备也计为写副作用 | `cmd 2>/dev/null` 把只读命令降级为 `review` |
| R4 | `unresolved` 与只读判定耦合 | 非路径位置的动态取值（搜索模式）、无害包装器一并降级 |
| R5 | 只匹配 argv 前缀 | 带全局选项的形态不命中（`git -C dir status`、`git --no-pager log`） |

成本放大器（读码确认）：`review` 落在关键路径上是同步模型调用（`reviewer.timeoutMs` 默认 20s、`maxEvidenceRounds` 默认 3、transcript 预算 24k），而判定缓存 key 含 `authorizationVersion`＝用户消息文本指纹（`src/decision/pipeline.ts:502` `cacheKeyForCall`），**每个新用户轮整批失效**。所以「每次搜索都等一次审核」不是错觉。

## 2. 实测证据

### 2.1 只读命令一律走评审（R1）

| 命令 | 现状 | 说明 |
|---|---|---|
| `rg -n "readOnly" src/` | `review` | 未命中白名单 → baseline `bash: review` |
| `grep -rn x src/`、`find src -name '*.ts'`、`sed -n '1,10p' f`、`sort in.txt`、`diff -u a b`、`tsc --noEmit -p x`、`node --version`、`which node`、`date` | `review` | 同上 |

### 2.2 免评审被重定向与动态参数取消（R3、R4）

| 命令 | 现状 | 机制 |
|---|---|---|
| `ls 2>/dev/null`、`cat f 2>/dev/null`、`git diff > /dev/null` | `review` | `/dev/null` 产出 `direction: "write"` 的路径；`isReadOnlyUnit` 要求 `paths.every(read)`（`src/facts/bash/readonly-commands.ts:62`） |
| `rg "$PAT" src/`、`rg -n "$(cat p)" src/` | `review` + `unresolved=dynamic-path` | 任一参数动态 ⇒ 单元级 `unresolved`（`src/facts/bash/enumerate.ts:192`） |
| `env`、`command -v rg`、`timeout 5 cat f.txt`、`nice -n 5 sed -n 1p f` | `review` + `indirection-wrapper` | 包装器一律降级 |

补充实测（win32 目标平台）：`/dev/null` 会被归一为 `D:\dev\null`，`config/config.json` 里的 `"*/dev/null": "allow"` 能命中该路径对象，但**救不了只读判定**——命令对象仍因 `readOnly=false` 落到 baseline `review`。

### 2.3 参数角色缺失（R2）

| 命令 | 现状 | 机制 |
|---|---|---|
| `rg -n "\.env" src/`（用户有 `path: {"*.env": "deny"}`） | **`deny`** | 白名单命令「全部非选项参数都是路径」（`src/facts/bash/path-tokens.ts:109`），搜索**模式**被当成 read 路径 |
| `head -n 5 src/index.ts` → 目标 `…\5`；`git show --stat HEAD` → `…\HEAD` | 幽灵目标进 `targets` 与缓存键 | 同上 |
| `rg --glob=src/**/*.ts -n x` | `review` | `--opt=<像路径>` 形状规则取消免评审（`:140`） |
| `git log --output out.txt` / `--output=out.txt`（在默认集内） | `allow`（实测两种写法都真写文件） | 已知残余面，`docs/requirements.md` §8.2 |

### 2.4 盲目扩表的直接后果（安全）

把 `rg`/`find`/`sort`/`git branch` 直接加入白名单后，实测：

| 命令 | 结果 | 真实副作用 |
|---|---|---|
| `find . -name '*.log' -delete` | `allow` | 删除文件 |
| `sort -o out.txt in.txt` | `allow` | 写文件 |
| `rg --pre 'sh -c cat' x` | `allow` | `--pre` 会执行命令 |
| `git branch -D feature` | `allow` | 删除分支 |

⇒ **扩白名单必须与选项黑名单同批落地**，这正是「黑、白名单」双名单模型的由来。

### 2.5 「参数即程序」家族（决定了 `sed` 不能进内置表）

实测（GNU sed 4.9，本机）：

```text
sed 'e echo SED_E_RAN' in.txt            → 输出 SED_E_RAN     （e 命令执行任意命令）
sed 's/aaa/echo SED_S_FLAG_RAN/e' in.txt → 输出 SED_S_FLAG_RAN（s///e 标志执行替换结果）
sed -n '1w out_w.txt' in.txt             → out_w.txt 被真实创建（w 命令写字）
sed -i 's/aaa/zzz/' in2.txt              → 原地改写文件
```

同类形态（逐条标注证据等级：**实测** / 帮助文档 / 未实测）：

| 形态 | 证据 | 性质 |
|---|---|---|
| `rg --pre=CMD` | **实测**（ripgrep 15.2.0）：`rg --pre hostname …` 的报错回显了真实 spawn 命令行 `'"C:\…\hostname.exe" "in.txt"'`；`rg --pre 'D:\tmp\pre.cmd' …` 真的执行了该 `.cmd` 并产生副作用文件 | 选项即程序，每个被搜文件 spawn 一次，其 stdout 被当作文件内容搜索 |
| `sort --compress-program=PROG` | **实测**：`seq 1 40000 \| sort -S 1K --compress-program=hostname` 真的以 `hostname -d` 调起它（多轮，sort 报 `'hostname' [-d] terminated abnormally`） | 选项即程序（外部排序的压缩程序） |
| `git -c <key>=<val>` | **实测**：`git -c core.fsmonitor=<cmd> status --short` 触发 1 次 spawn；`git -c alias.x='!cmd' x` 直接执行 | **通用执行原语**：只读子命令（`git status`）加上 `-c` 就变成代码执行；argv 可见，必须进 `unsafeOptions` |
| `git diff --ext-diff`（配合 `-c diff.external=`） | **实测**：外部 diff 助手被调用（spawn 记录带 7 个参数） | 选项即程序 |
| `GIT_EXTERNAL_DIFF=<cmd> git diff --ext-diff` | **实测**：同样 spawn | **argv 看不到的层**（环境变量/配置注入） |
| `fd -x CMD` | **实测**：`fd in.txt -x echo FD_RAN_PROBE` 输出 `FD_RAN_PROBE ./in.txt` | 选项即程序，每命中一次 |
| `rg --hostname-bin=CMD` | 帮助文本明确「ripgrep will run this executable, with no arguments…uses your system's hostname for producing hyperlinks」；本机未能触发（连 OSC-8 超链接本身都未输出） | 选项即程序（触发条件未核实） |
| `rg -z/--search-zip` | 帮助文本：需 PATH 里的 gzip／bzip2／xz／lz4／lzma／brotli／zstd | 从 PATH 取解压程序 |
| `sort -T DIR` | 帮助文本 | 在 DIR 写临时文件 |
| `git grep -O[=<pager>]` | 帮助文本「show matching files in the pager」；本机非 tty 未触发 | 选项即程序（需终端） |
| `git grep --ext-grep` | 帮助文本「allow calling of grep(1)（ignored by this build）」 | 选项即程序（本机构建忽略） |
| `diff -o/--output` | **实测不存在**（只有 `-e/--ed` 输出 ed 脚本到 stdout） | ⇒ `diff` 进表只需 deny-list |
| GNU `grep -O` | **实测不存在**（`grep --help` 里没有 `-O`） | ⇒ 本提案旧稿的「`grep: -O`」是笔误，正确的是 `git grep -O`／`--ext-grep`（已在 §6.1 修正） |
| `date -s/--set` | 帮助文本 `-s, --set=STRING`；**未实测**（改系统时钟属禁止操作） | 改系统状态 |
| `tree -o FILE` | **未实测**（本机未安装 tree） | 待核实 |

汇总结论：**一个「只读子命令」在其 argv 允许 `-c`／`--ext-diff` 一类选项时就会变成代码执行**（`git status` 实测）。因此 `git` 系列档案的 `unsafeOptions` 必须至少包含 `-c` `-C` `--git-dir` `--work-tree` `--exec-path` `--ext-diff` `-O` `--ext-grep`。

`--pre` 的实战含义：即使 `rg` 的其余参数完全正常，`rg --pre <程序> PATTERN PATH` 就能把搜索变成「枚举目录下每个文件 × 执行一遍 <程序>」——这是「选项即程序」里危害最直接的一种，因此 `--pre` 必须进 `unsafeOptions`。

结论：`sed` 的**脚本体是数据但语义上是代码**，而且脚本来源多样（位置参数、`-e`、`--expression`、`-f 文件`），静态检查必须覆盖 `e`／`w`／`W`／`r`／`R` 命令与 `s///` 的 `e` 标志，还要处理转义与多行脚本——**不存在可靠的静态边界**，因此 `sed`、`awk`、`node`、`python` 一律不进内置表。

还有一个必须写进文档的根本边界：档案匹配只基于 argv，不建模 shell 别名/函数、PATH 劫持，也不建模工具自身配置里的执行点（git 的 `core.pager`、`GIT_EXTERNAL_DIFF`、`LESSOPEN` 等）。**「只读免评审」始终是启发式，不是沙箱**。

## 3. 代码定位

| 关注点 | 位置 |
|---|---|
| 默认只读集（10 条） | `src/config/schema.ts:87` `DEFAULT_READ_ONLY_COMMANDS` |
| 前缀匹配与四条件判定 | `src/facts/bash/readonly-commands.ts:14`、`:62` `isReadOnlyUnit` |
| 方向与「全部参数都是路径」 | `src/facts/bash/path-tokens.ts:108-109`、`:140`（`pathValuedOption`） |
| 单元 `unresolved` 与 `readOnly` 赋值 | `src/facts/bash/enumerate.ts:192-205` |
| 重定向方向 | `src/facts/bash/redirects.ts:47` |
| 免评审的求值落点（用户规则之后、`unresolved` 之前） | `src/policy/evaluate.ts:262` |
| 评审调用与缓存 key | `src/decision/pipeline.ts:502`、`:769` |
| 包装器集合 | `src/facts/bash/wrappers.ts`、`docs/architecture.md` §5.2 |
| 归因取舍的现状说明 | `docs/architecture.md:465`、`:479`（「未知命令按 write 归因」为有意选择） |

## 4. 设计目标与必须保持的不变量

目标：**把「免评审」从单一维度（argv 前缀）升级为「解析结果 + 命令档案」的双名单模型**，在不降低 fail-closed 强度的前提下，让高频只读命令默认免评审。

不变量（本提案的任何一项都不得破坏）：

1. 求值顺序不变：**用户层规则 > 只读白名单 > `unresolved` > baseline**（`src/policy/evaluate.ts` 步骤 1~4）；`deny` 永不被免评审或会话授权覆盖。
2. 免评审**只作用于命令对象**；路径对象独立投票 ⇒ `cat .env` 仍命中 `*.env: deny`，`rg x /other/repo` 仍因 `external_directory_read` 默认 `review`（跨目录搜索仍要评审是有意行为，正解是 `allowRoots`）。
3. 解析失败（`parse-error`）、PowerShell（`unparsed-language`）、opaque 包装器（`bash -c`/`eval`）一律不判只读；整树 `hasError` 时所有单元 `readOnly=false`。
4. 路径位置出现动态取值 ⇒ 仍降级为 `unresolved`（未知读目标必须交给 `onUnresolvedFacts`）。
5. 未声明档案的命令 ⇒ 行为与当前实现完全一致（不扩表就不放宽）。
6. 档案表是**数据**：每条 `unsafeOptions`／allow-list 都必须有负向测试与依据；新增命令必须同时补负向用例。

## 5. 方案

### 5.1 总览

```text
bash 文本 → tree-sitter AST（不变）
        → 命令单元枚举（不变）
        → 【新】命令档案匹配：argv 前缀 + 位置参数角色 + 选项名单 + 重定向 sink
        → readOnly 判定（含「免评审被取消的原因」）
        → 规则求值（顺序不变）
```

### 5.2 档案条目字段

字符串写法（现状）等价于 `{"argv": [..], "args": "all"}`。

```jsonc
{
  "argv": ["rg"],                     // argv 前缀，与字符串写法同语义（保证「裸 node 绝不进表」这类粒度）
  "roles": ["pattern", "paths"],      // 位置参数角色序列，默认 ["paths"]
  "script": null,                     // 仅 "script" 角色使用：整体锚定的正则白名单（§6.3）
  "optionPolicy": "deny-list",        // "deny-list"（默认）| "allow-list"
  "unsafeOptions": ["--pre"],         // 命中即取消免评审；支持 --opt 前缀覆盖 --opt=x
  "safeValueOptions": ["--glob", "-g"], // 值可能像路径但无写/执行语义，豁免 §5.4 的形状规则
  "reason": "rg 默认只搜不写；--pre 会执行外部程序" // 审计与评审提示里展示
}
```

### 5.3 参数角色模型（`roles`）

| `roles` 取值 | 语义 | 典型命令 |
|---|---|---|
| `["paths"]` | 全部非选项参数都是 read 路径 ——**现状**（原 `args:"all"`） | `cat` `head` `tail` `wc` `ls` `stat` `du` |
| `[]` | 不产出路径目标 | `node --version`、`which`、`date` |
| `["pattern", "paths"]` | 第 1 个位置参数是模式（非路径），其余是 read 路径 | `rg` `grep` |
| `["script", "paths"]` | 第 1 个位置参数是脚本，必须**整体命中**档案的 `script` 模式集（§6.3），其余是 read 路径 | 用户声明的 `sed` |

规则细节：序列最后一项吸收剩余位置参数；`--` 之后一律按位置参数处理；`-`（stdin）不算路径；选项的值（`--glob=x`）默认不产出路径目标。

收益：一次消掉幽灵目标与「模式撞路径规则」两个缺陷（`rg -n "\.env" src/` 恢复为 `allow`；`head -n 5 f` 不再产生 `…\5`）。
`script` 角色是**白名单式**约束（不匹配即取消免评审），因此天然 fail-closed：只要模式集写的是完整脚本形态（如 `^[0-9]+(,[0-9]+)?p$`），就不可能表达出 `e`／`w` 这类 sed 命令位。

已知代价（可接受且可观测）：空格写法的选项值（`rg --max-columns 200 x` 里的 `200`）仍可能成为幽灵 **read** 目标。read 方向的幽灵目标只会造成「过严」（撞上 `path_read` 用户规则），不会放宽任何东西；需要精化的档案可后续增加 `optionValues` 声明（§11 P2）。

### 5.4 选项名单（`optionPolicy` + 两个列表）

- `deny-list`（默认）：未列出的选项**默认安全**；命中 `unsafeOptions` 即取消免评审。适合 `rg` `grep` `sort` `cat` `diff`。
- `allow-list`：只有列出的选项算安全，其余一律取消。适合「危险选项多且语义杂」的命令：`find`（`-delete`、`-fprint`、`-fprintf`、`-exec`…）、`git branch`（`-D`/`-d`/`-m`/`-f`…）。
- 词级匹配优于文本 glob：`unsafeOptions: ["--pre"]` 覆盖 `--pre` 与 `--pre=x`，且不会误伤 `rg --glob='*--pre*'` 这种「值里出现选项名」的写法（文本 glob `*--pre*` 会误匹配）。
- `unsafeOptions` 的**依据必须逐条写清**，并区分两类风险：**写文件**（`sort -o`、`sed -i`）与**执行程序**（`--pre`、`--compress-program`、`git -c`、`--ext-diff`、`git grep -O`）。后面这类破坏面更大，却最容易被漏：§2.5 实测了「只读子命令 + `-c`」就能执行任意程序（`git -c core.fsmonitor=<cmd> status`、`git -c alias.x='!cmd' x`）。
- 顺带封死已知残余面：`git diff`/`git log`/`git show` 档案加 `unsafeOptions: ["--output", "-o"]`，空格写法与「值不像路径」写法都能取消免评审。

### 5.5 重定向 sink

在 `analyzeRedirect` 识别空设备目标：POSIX `/dev/null`、Windows `NUL`（大小写不敏感）、win32 目标平台上的字面 `/dev/null`（git-bash）。写入 sink **不产出 PathTarget**（与 `2>&1` 同处理），于是 `isReadOnlyUnit` 的「全部路径 read」条件自然成立。

边界：`> real.txt`、`2> log.txt` 仍算写副作用；`< /dev/null` 不变；`<>` 仍 `ambiguous-direction`。默认 sink 集合固定为「空设备」，可通过配置追加（例如容器里的 `/dev/stdout`）。

### 5.6 动态参数按角色分流

把「参数含动态取值」从单元级一票否决改为**按角色**升级：

- 动态值落在**路径位置** ⇒ 仍标 `unresolved=dynamic-path`（`cat $FILE`、`ls $DIR` 行为不变）；
- 动态值落在**非路径位置**（`rg "$PAT" src/` 的模式、`--glob=$G`）⇒ 不再把单元标记为不可信。

这是精确化而非放宽：能放行的前提是「哪些位置是路径」由档案显式声明；未声明档案的命令仍然走今天的最严格路径。

### 5.7 与现有求值顺序的关系

`evaluateObject` 的四个步骤与优先级**完全不变**，只改变「步骤 2 的输入」（`object.readOnly` 的判定依据）与「步骤 3 的触发条件」（动态参数按角色分流）。`onUnresolvedFacts`、`onMixedCommandActions`、授权、缓存、熔断、子代理收紧（`defaultActionFloor` 只作用于 baseline 层）全部保持既有语义。

### 5.8 可观测

「为什么又审核了」必须能回答：审计条目在 `matchedPattern` 旁增加 `readOnlyCancel`（`redirect-write`／`unsafe-option:<opt>`／`dynamic-path-arg`／`option-path-value`／`wrapper`），`/perm status` 汇总免评审命中与取消原因计数，人工确认与拦截提示同源展示。

## 6. 档案分组与建议清单

分组名（`readOnly.profiles` 的取值）：`search`、`vcs-read`、`text-read`、`text-tools`、`meta`、`system`。
每条都要「依据 + 负向测试」；下表给出关键声明，不是最终实现清单。

### 6.1 默认开启（D28：最小集）

默认值 = `["search", "vcs-read"]`。

| 分组 | 命令 | 关键声明 |
|---|---|---|
| `search` | `rg` `grep` | `roles: ["pattern","paths"]`；`optionPolicy: deny-list`；`rg: unsafeOptions ["--pre", "--hostname-bin"]`（`--pre` 实测会 spawn 程序，见 §2.5；前缀匹配同时覆盖 `--pre-glob`，过严但安全）；`-z/--search-zip` 允许但需注明会从 PATH 取解压程序；GNU `grep` 实测**没有** `-O`（执行类选项在 `git grep` 上，见下行） |
| `search` | `find` | `roles: ["paths"]` + **allow-list**，安全选项集：`-name -iname -path -ipath -regex -iregex -type -maxdepth -mindepth -not -o -a -print -print0 -ls -empty -newer -mtime -size -perm -user -group -links -inum -samefile -readable -writable -executable -xdev -prune -depth -P -L -H`；未列出的一律取消（`-delete`／`-fprint`／`-fprintf`／`-fls`／`-exec`／`-ok` 天然落在名单之外） |
| `vcs-read` | `git status` `git diff` `git log` `git show` `git ls-files` `git rev-parse` `git ls-tree` `git blame` `git cat-file` `git shortlog` `git describe` `git for-each-ref` `git worktree list` `git stash list` `git remote -v`（argv 前缀） | 全部：`unsafeOptions: ["--output", "-o"]`；`git` 级前缀（**均为实测执行/重定向类**，见 §2.5）：`-c` `-C` `--git-dir` `--work-tree` `--exec-path`；`git diff: --ext-diff`；`git grep: -O` `--ext-grep` |
| `vcs-read` | `git branch` | **allow-list**：`--show-current` `-a` `--all` `-v` `--verbose` `--list` `--contains` `--merged` `--no-merged` `-r`；其余取消（`-D`／`-d`／`-m`／`-M`／`-f`／`--edit-description`） |

### 6.2 可选分组（用户显式声明才生效）

| 分组 | 命令 | 关键声明 |
|---|---|---|
| `text-read` | `cat` `head` `tail` `wc` `nl` `od` `xxd` `file` `stat` `ls` `pwd` `realpath` `tree` | `roles: ["paths"]`；`tree: -o`（**待核实**） |
| `text-tools` | `sort` `uniq` `cut` `tr` `comm` `cmp` `diff` | `sort: --compress-program`（执行程序）、`-T`（写临时文件）；`diff` **无** `-o/--output`（实测） |
| `text-tools` | `jq` | allow-list（`-n` `--null-input` `-r` `-c` `-f` `-e` `-S` `-j`…） |
| `meta` | `node --version`／`-v`、`npm --version`／`-v`、`npx --version`、`python --version`／`-V`、`tsc --version`、`cargo --version`、`go version`、`git --version`、`rg --version` | `argv` 前缀限定到版本旗标 + `roles: []` + allow-list。**绝不能写成裸 `node`**（`node -e 'require("fs").rmSync(…)'` 会被放行） |
| `system` | `which` `type` `uname` `id` `whoami` `uptime` `nproc` `ps` `lsof`（`roles: []`）；`du` `df`（`roles: ["paths"]`）；`date` | `date` 需 `unsafeOptions: ["-s", "--set"]`（改系统时钟）；`hostname NEWNAME` 属改系统状态，不写进 bare 形态（**待核实**） |

### 6.3 用户自定义的保守示例（`sed`，用户已确认政策）

`sed` **不默认收录**（§2.5 实测 `e`／`s///e`／`w`／`-i`），只在 `config.example.jsonc` 与 `docs/configuration.md` 里给出可复制的保守形态：

```jsonc
{
  "argv": ["sed"],
  "roles": ["script", "paths"],
  "script": ["^[0-9]+(,[0-9]+)?p$", "^[0-9]+(,[0-9]+)?d$"],
  "optionPolicy": "allow-list",
  "safeOptions": ["-n", "--quiet", "--silent", "--posix"],
  "unsafeOptions": ["-i", "--in-place", "-e", "--expression", "-f", "--file"],
  "reason": "只放行 `sed -n 'N,Mp' <file>` 形态；脚本必须整体命中 script 模式集"
}
```

必须同时写进文档的警告：

1. `script` 模式集是**整体锚定**的正则白名单，不匹配即取消免评审（fail-closed）；
2. **不要**把含 `e`／`w`／`W`／`r`／`R` 的宽松模式写进去——那是 sed 的「执行命令」与「写/读文件」命令位；
3. `-e`／`-f`／`--expression`／`--file`（脚本来源）与 `-i`（原地写）必须同时进 `unsafeOptions`；
4. 模式写松即失去保护：这条路径的保护强度完全取决于用户写的正则。

### 6.4 明确不进表

`awk`／`perl`／`ruby`（程序体可写可执行）、裸 `node`／`python`（`node -e` 可直接写盘）、`tee`／`unzip`／`tar`（写）、网络类命令（`curl` `wget` `gh` `dig` `ping`）——FR-9 的定义是「命令本身不改文件」，网络外发属于另一维度的策略，留给用户显式声明。

## 7. 配置面草案（schema）

`src/config/schema.ts` 是唯一真源，`schemas/guardian.schema.json` 由 `npm run gen:schema` 生成（漂移由 `test/config/schema.test.ts` 捕获），不得手改 JSON。

```jsonc
"workingDirectory": {
  "allowRoots": [],
  // 旧键：语义完全不变（字符串数组 = argv 前缀白名单；显式数组仍完整覆盖内置字符串集）
  "readOnlyCommands": ["git status", "git diff"],
  // 新键：结构化档案
  "readOnly": {
    "profiles": "builtin",      // "builtin" | [] | ["search","vcs-read","meta","system"] 分组名数组
    "commands": [ /* 字符串或 §5.2 对象条目 */ ],
    "unsafeOptions": [],        // 用户级全局选项黑名单（词级前缀；命中即取消，与档案取并集）
    "sinks": ["/dev/null", "NUL"]
  }
}
```

- `profiles` 与旧键互不覆盖：`readOnlyCommands: []` 只关掉旧的字符串集；要整体关闭用 `readOnly.profiles: []`（文档必须写清这层区分，避免 `[]` 的期望落空）。
- 跨层合并沿用现有安全方向：白名单类字段**只允许收紧**（项目层不能放宽全局层），`unsafeOptions` 取并集。
- 用户若要自加 `sed` 一类命令，文档必须同时给出残余风险说明（§2.5）。

## 8. 兼容性、迁移与文档影响

| 影响对象 | 变更 |
|---|---|
| 默认行为 | 若 `profiles` 默认 `"builtin"`：**默认免评审面扩大**，属于安全相关的默认值变更，release note 必须显式写出 |
| 现有配置 | `readOnlyCommands` 语义不变；`config/config.json` 里 `"*/dev/null": "allow"` 在新 sink 语义下变成冗余（可保留） |
| 文档 | `docs/requirements.md`（新 FR-65~FR-69、**修订 D21**）、`docs/architecture.md` §5.2/§5.3 归因表、`docs/configuration.md` §7 重写、`docs/implementation-plan.md` 新里程碑 + 门禁、`README.md` |
| 生成物 | `schemas/guardian.schema.json` 重新生成 |
| 语料 | `test/fixtures/bash/corpus.txt` + `corpus.json` 增加本提案全部证据行（`npm run gen:corpus` 只填不判，期望值需人工审阅） |

建议的新需求编号（待确认）：FR-65 命令档案；FR-66 选项名单（deny-list／allow-list 与词级匹配）；FR-67 重定向 sink；FR-68 动态参数按角色分流；FR-69 免评审取消原因可观测。
建议的新决策（待确认）：D28 内置档案默认开启；D29 选项语义只对「声明过档案的命令」生效（未声明命令保持现状）；D30 sink 集合固定为空设备、可配置追加；D31 只用 `allow-list` 处理「危险选项密集」的命令。

## 9. 验证计划与门禁

- 单测：`test/facts/bash/readonly-commands.test.ts` 改为档案表驱动（角色／选项策略／sink 各一组正反用例）；`test/facts/bash/enumerate.test.ts`（幽灵目标、角色断言）；`test/policy/evaluate.test.ts`（白名单 vs 路径规则 vs 用户 bash 规则）；`test/decision/pipeline.test.ts`（免评审不产生模型调用）。
- 语料：本节 §2 的每一行都必须进 `corpus.txt`/`corpus.json`；负向用例固定包含 `find . -delete`、`sort -o`、`rg --pre`、`git branch -D`、`git -c`、`sed -i`、`node -e`、`git -C`。
- 配置面：`test/config/schema.test.ts`、`load.test.ts`、`normalize.test.ts`；`npm run gen:schema` 后提交生成物。
- 门禁（CI 只在 tag 与手动触发，交付前本地跑全）：`npm run typecheck && npm test && npm run gen:schema && npm run validate:config && npm run check:pack`。
- 真实 pi 冒烟：按 `docs/smoke-test.md` §2 的临时 `PI_CODING_AGENT_DIR` 隔离法，用 RPC 驱动确认 `rg`／`cmd 2>/dev/null` 走 `source=read-only`。注意：本机桌面安全策略会拦截 `rm -rf` 形态的命令，冒烟脚本改用普通 `rm` 形态。

## 10. 复现方式（本次实测用）

探针脚本（临时文件，未入库）通过仓库源码直接调用事实层与求值器，零模型调用：

```ts
const { mergeLayers } = await import("…/src/config/merge.ts");
const { extractFacts } = await import("…/src/facts/extract.ts");
const { compileRuleTable } = await import("…/src/policy/rules.ts");
const { evaluateCall } = await import("…/src/policy/evaluate.ts");

const config = mergeLayers([]);                       // 或注入 config/config.json 作为 global 层
const table = compileRuleTable(config, { home, platform });
const facts = await extractFacts("bash", { command }, ctx);
console.log(evaluateCall({ facts, toolName: "bash", config, table }));
```

## 11. 分批交付与待确认决策点

| 批次 | 内容 | 状态 |
|---|---|---|
| P0 | §5.5 sink、§5.6 动态参数分流、§5.2~§5.4 档案与选项名单、§5.8 最小可观测 | 用户已选 |
| P1 | §7 结构化配置面、文档与参考配置回写、schema 再生 | **范围待确认**（若不做，P0 的档案只能硬编码，用户无法自定义，与「灵活配置黑/白名单」的诉求冲突） |
| P2 | 透明前缀包装器内推（`timeout N`、`nice -n N`、`env VAR=1`、`command`；`sudo`／`xargs`／`bash -c` 保持不透明） | 用户已选 |
| P2 | `cd` 工作目录追踪（实测 `cd src && cat .env` 的路径仍按会话 cwd 归一，`cd` 单元恒 `review`） | 用户已选 |

待确认决策点：

1. **D28 内置档案默认开启？** 默认开启直接解决当前痛点，但属安全相关默认值变更；备选是仅写进 `config/config.json` 与示例（用户须自行开启）。
2. **P1 是否并入本次交付？**（见上表）
3. **`sed` 政策定稿**：默认不进内置表（本提案推荐）；是否提供可选的脚本文本 guard（实现成本与误判风险高，本提案不建议在 P0/P2 内做）。
4. P2 两项（包装器内推、`cd` 追踪）是否都做，还是先做包装器内推。

## 12. 残余面与风险

- 未声明档案的命令仍恒 `review`（有意保留，避免「未知即安全」）。
- 空格写法的选项值仍可能成为幽灵 **read** 目标（只造成过严，不放宽）。
- `sed`／`awk`／裸解释器／网络类命令永不进表；用户自行加入时风险自负（文档必须写明）。
- 档案表是长期维护面：新命令、新选项（尤其「选项即程序」类）需要持续补充，缺一条就多一次评审或（若写成 allow-list 之外的默认安全）开一个口子——因此 `deny-list` 只用于**选项集合稳定**的命令，其余一律 allow-list。
- 根本边界不变：argv 匹配不建模别名、PATH 劫持与工具自身配置注入的执行点；免评审是启发式，不是沙箱。
- **环境变量/配置文件注入是 argv 名单看不到的层**：`RIPGREP_CONFIG_PATH` 指向的配置文件里写 `--pre=…` 就能在 argv 完全干净的情况下获得执行能力（`rg --no-config` 可关闭它；`rg --help` 第 1597~1599 行实测确认该变量存在）。同类：git 的 `GIT_EXTERNAL_DIFF`／`core.pager`、`LESSOPEN`。这类入口无法靠档案表解决，只能靠文档说清「免评审不覆盖它」，并把 `--no-config` 一类开关写进需要极致收紧的用户的配置建议里。
