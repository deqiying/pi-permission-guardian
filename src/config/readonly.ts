import type { ReadOnlyCommandProfile } from "../facts/types.ts";
import {
  DEFAULT_READONLY_PROFILE_GROUPS,
  READONLY_PROFILE_GROUPS,
  type ReadOnlyProfileGroup,
} from "./schema.ts";

/**
 * 只读命令档案的内置数据与展开（FR-65~FR-67）。
 *
 * 数据属于**配置层**（默认配置的一部分），判定属于事实层：这里只负责把
 * “内置分组 + 用户条目 + 旧 `readOnlyCommands` 字符串”展开成事实层能直接用的档案列表。
 *
 * 顺序即优先级（第一个命中的档案生效），因此顺序是：**用户条目 → 内置分组 → 旧字符串条目**。
 * 用户可以写一条比内置更严的 `rg` 档案把它压住，旧字符串条目则永远排在最后兜底。
 *
 * 每条档案的 `reason` 都写下依据；§2.5 的实测结论（`--pre` 会 spawn 程序、`git -c` 是通用执行
 * 原语、`sort --compress-program` 会执行程序、`diff` 没有 `-o/--output`）直接体现在下面的选项名单里。
 */

/**
 * `git` 只读子命令共用的选项黑名单。
 *
 * 只有两类真的能出现在子命令**之后**：`--output`（写文件）与 `--ext-diff`（执行外部 diff 助手）。
 * `-c` / `-C` / `--git-dir` / `--work-tree` / `--exec-path` 是 **git 级**选项，实测写在子命令之后就报错，
 * 写在子命令之前（`git -c … status`）又会直接不命中 `argv` 前缀——因此它们靠“前缀匹配”挡着，
 * 而不是靠这个名单。反过来 `-c` / `-C` 在子命令之后是**合法且无害**的（`git log -c` 合并 diff、
 * `git log -C` 检测复制），列进名单只会误伤；`git ls-files -o` 同理（`-o` 并非 `--output` 的短选项）。
 *
 * 注意：**把档案前缀放宽到 `["git"]` 的人必须自己把这些 git 级选项补进 `unsafeOptions`**，
 * 否则 `git -c core.fsmonitor=<cmd> status` 这类调用会被免评审放行（实测会执行外部程序）。
 */
const GIT_UNSAFE_OPTIONS: readonly string[] = ["--output", "--ext-diff"];

/** `find` 的安全选项（allow-list）：只读判定类谓词与输出到 stdout 的动作。 */
const FIND_SAFE_OPTIONS: readonly string[] = [
  "-name",
  "-iname",
  "-lname",
  "-ilname",
  "-path",
  "-ipath",
  "-regex",
  "-iregex",
  "-type",
  "-xtype",
  "-fstype",
  "-maxdepth",
  "-mindepth",
  "-not",
  "-o",
  "-a",
  "-print",
  "-print0",
  "-printf",
  "-ls",
  "-empty",
  "-newer",
  "-mtime",
  "-atime",
  "-ctime",
  "-mmin",
  "-amin",
  "-cmin",
  "-size",
  "-perm",
  "-user",
  "-group",
  "-links",
  "-inum",
  "-samefile",
  "-readable",
  "-writable",
  "-executable",
  "-xdev",
  "-prune",
  "-depth",
  "-P",
  "-L",
  "-H",
];

/**
 * `find` 的“取值不是文件”选项（FR-65 的 `nonFileValueOptions`）：谓词、数值、类型名。
 *
 * 刻意**不含**以下三类：
 * - `-newer` / `-newermt` / `-samefile`：取值是真文件（必须继续产出读路径）；
 * - `-fprint` / `-fprintf`：取值是文件，且不在 allow-list 里（命中即取消）；
 * - `-exec` 一类：取值是程序（同样不在 allow-list 里）。
 */
const FIND_NON_FILE_VALUE_OPTIONS: readonly string[] = [
  "-name",
  "-iname",
  "-lname",
  "-ilname",
  "-path",
  "-ipath",
  "-regex",
  "-iregex",
  "-type",
  "-xtype",
  "-fstype",
  "-size",
  "-mtime",
  "-atime",
  "-ctime",
  "-mmin",
  "-amin",
  "-cmin",
  "-perm",
  "-user",
  "-group",
  "-links",
  "-inum",
  "-maxdepth",
  "-mindepth",
  "-printf",
];

/** `grep` 的取值选项：模式、数值、关键字。刻意不含 `-f FILE` 与 `--exclude-from=FILE`（取值是文件）。 */
const GREP_NON_FILE_VALUE_OPTIONS: readonly string[] = [
  "--include",
  "-include",
  "--exclude",
  "--exclude-dir",
  "-A",
  "-B",
  "-C",
  "-m",
  "--max-count",
  "--binary-files",
  "-D",
  "--devices",
  "-d",
  "--directories",
  "--color",
  "--colour",
];

/** `rg` 的取值选项：模式、数值、关键字。`--pre` / `--hostname-bin` 是程序（在 unsafeOptions 里）。 */
const RG_NON_FILE_VALUE_OPTIONS: readonly string[] = [
  "-g",
  "--glob",
  "--iglob",
  "-t",
  "--type",
  "-T",
  "--type-not",
  "-A",
  "-B",
  "-C",
  "--context",
  "-m",
  "--max-count",
  "--max-columns",
  "--max-depth",
  "--max-filesize",
  "--threads",
  "-j",
  "--color",
  "--colors",
  "--encoding",
  "--engine",
  "--sort",
  "--replace",
  "-r",
  "--path-separator",
  "--field-context-separator",
  "--field-match-separator",
  "--context-separator",
];

/** `head` / `tail` 的取值选项：数值与间隔。 */
const HEAD_TAIL_NON_FILE_VALUE_OPTIONS: readonly string[] = [
  "-n",
  "--lines",
  "-c",
  "--bytes",
  "-s",
  "--sleep-interval",
  "--pid",
  "--max-unchanged-stats",
];

/** `ls` 的取值选项：宽度、排序键、时间格式、颜色等（`-w 80` 的 `80` 不该成为读路径）。 */
const LS_NON_FILE_VALUE_OPTIONS: readonly string[] = [
  "-w",
  "--width",
  "-I",
  "--ignore",
  "--time-style",
  "--block-size",
  "--format",
  "--color",
  "--colour",
  "--sort",
  "--quoting-style",
  "--hide",
  "--indicator-style",
  "--tabsize",
  "--hyperlink",
];

/**
 * `git` 只读子命令的取值选项：数字、格式、过滤关键字、ref。
 *
 * 刻意不含 `--output`（写文件，在 unsafeOptions）与 `--file` / `--pathspec-from-file`（取值是文件）。
 */
const GIT_NON_FILE_VALUE_OPTIONS: readonly string[] = [
  "-n",
  "--max-count",
  "--skip",
  "-L",
  "-S",
  "-G",
  "--format",
  "--pretty",
  "--date",
  "--diff-filter",
  "--author",
  "--committer",
  "--grep",
  "--grep-reflog",
  "--abbrev",
  "--unified",
  "-U",
  "--since",
  "--until",
  "--sort",
  "--points-at",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--max-depth",
  "--exclude",
  "--column",
];

/**
 * `git grep` 另外需要的取值选项（上下文行数、并行度）。
 *
 * 刻意**不含** `-e` / `--regexp`：它的取值会自然地落在 `pattern` 角色槽上，
 * 声明反而会把后面的真实路径挤到 `pattern` 槽（`git grep -e x -- src` 的 `src` 会失去路径目标）。
 */
const GIT_GREP_NON_FILE_VALUE_OPTIONS: readonly string[] = [
  ...GIT_NON_FILE_VALUE_OPTIONS,
  "-A",
  "-B",
  "-C",
  "-m",
  "--max-count",
  "--threads",
  "-j",
];

/** `git branch` 的取值选项：ref 与排序键（`--contains HEAD` 的 `HEAD` 不是位置参数）。 */
const GIT_BRANCH_NON_FILE_VALUE_OPTIONS: readonly string[] = [
  "--show-current",
  "--list",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--sort",
  "--points-at",
  "--format",
  "--column",
];

/** `sort` 的取值选项：键、分隔符、缓冲区、并行度。`-o` / `--compress-program` 在 unsafeOptions 里。 */
const SORT_NON_FILE_VALUE_OPTIONS: readonly string[] = [
  "-k",
  "--key",
  "-t",
  "--field-separator",
  "-S",
  "--buffer-size",
  "--batch-size",
  "--parallel",
  "--sort",
  "--debug",
];

/** `cut` 的取值选项：分隔符与字段/字节范围。 */
const CUT_NON_FILE_VALUE_OPTIONS: readonly string[] = [
  "-d",
  "--delimiter",
  "-f",
  "--fields",
  "-c",
  "--characters",
  "-b",
  "--bytes",
  "--output-delimiter",
  "--complement",
];

/** `cmp` 的数值选项（`cmp` 本身在 text-tools 里；`uniq` 因第二个位置参数是输出文件而不列入）。 */
const CMP_NON_FILE_VALUE_OPTIONS: readonly string[] = [
  "-i",
  "--ignore-initial",
  "-n",
  "--bytes",
];

/** `diff` 的取值选项：上下文行数、标签、宽度。`--ed` 一类输出到 stdout，不涉文件。 */
const DIFF_NON_FILE_VALUE_OPTIONS: readonly string[] = [
  "-U",
  "--unified",
  "--label",
  "-I",
  "--ignore-matching-lines",
  "--tabsize",
  "--horizon-lines",
  "--width",
  "-W",
];

/** `comm` 的取值选项。 */
const COMM_NON_FILE_VALUE_OPTIONS: readonly string[] = [
  "--output-delimiter",
  "--check-order",
  "--nocheck-order",
];

/** `du` / `df` 的取值选项：深度、块大小、类型。 */
const DU_DF_NON_FILE_VALUE_OPTIONS: readonly string[] = [
  "-d",
  "--max-depth",
  "-B",
  "--block-size",
  "--exclude",
  "--time",
  "--time-style",
  "-t",
  "--type",
  "-x",
  "--exclude-type",
  "--output",
];

/** `lsof` / `ps` 的取值选项：PID、用户、格式、过滤。 */
const LSOF_NON_FILE_VALUE_OPTIONS: readonly string[] = [
  "-p",
  "-i",
  "-c",
  "-u",
  "-g",
  "-s",
  "-w",
];
const PS_NON_FILE_VALUE_OPTIONS: readonly string[] = [
  "-o",
  "--format",
  "-p",
  "--pid",
  "-t",
  "-C",
  "-u",
  "-U",
  "-G",
  "--sort",
];

/** 内置分组：名字是配置面的取值（`workingDirectory.readOnly.profiles`）。 */
const GROUP_PROFILES: Readonly<Record<ReadOnlyProfileGroup, readonly ReadOnlyCommandProfile[]>> = {
  // 搜索类：位置参数是“模式 + 路径”，模式不是文件（FR-65 的角色模型就是为它引入的）。
  search: [
    {
      argv: ["rg"],
      roles: ["pattern", "paths"],
      group: "search",
      unsafeOptions: ["--pre", "--hostname-bin"],
      safeOptions: ["-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not"],
      nonFileValueOptions: [...RG_NON_FILE_VALUE_OPTIONS],
      reason:
        "rg 默认只搜不写；--pre 实测会 spawn 任意程序（每个被搜文件一次）、--hostname-bin 同为选项即程序。--glob/--type 的取值是模式而不是文件，因此豁免形状规则也不占角色槽。",
    },
    {
      argv: ["grep"],
      roles: ["pattern", "paths"],
      group: "search",
      nonFileValueOptions: [...GREP_NON_FILE_VALUE_OPTIONS],
      reason: "grep 只读；GNU grep 实测没有执行类选项（执行类选项在 git grep 上）。",
    },
    {
      argv: ["find"],
      roles: ["paths"],
      optionPolicy: "allow-list",
      safeOptions: [...FIND_SAFE_OPTIONS],
      nonFileValueOptions: [...FIND_NON_FILE_VALUE_OPTIONS],
      group: "search",
      reason:
        "find 的危险选项密集（-delete / -fprint / -fprintf / -exec），因此只放行显式列出的只读谓词。谓词的取值是模式/数值而不是文件（`-name '*.pem'` 不该产出读路径）。",
    },
  ],

  // VCS 只读子命令：全部禁用写文件与执行类选项。
  "vcs-read": [
    ...["status", "diff", "log", "show", "ls-files", "ls-tree", "rev-parse", "blame", "shortlog", "describe", "cat-file", "for-each-ref"].map(
      (subcommand): ReadOnlyCommandProfile => ({
        argv: ["git", subcommand],
        roles: ["paths"],
        group: "vcs-read",
        unsafeOptions: [...GIT_UNSAFE_OPTIONS],
        nonFileValueOptions: [...GIT_NON_FILE_VALUE_OPTIONS],
        reason: `git ${subcommand} 是只读子命令；--output 会写文件，--ext-diff 会执行外部 diff 助手。数值/格式类取值（\`-n 5\`、\`-L 1,10\`）不占角色槽。`,
      }),
    ),
    {
      argv: ["git", "grep"],
      roles: ["pattern", "paths"],
      group: "vcs-read",
      unsafeOptions: [...GIT_UNSAFE_OPTIONS, "-O", "--ext-grep"],
      nonFileValueOptions: [...GIT_GREP_NON_FILE_VALUE_OPTIONS],
      reason: "git grep 只读；-O 打开 pager、--ext-grep 会调用外部 grep（均为选项即程序）。",
    },
    {
      argv: ["git", "branch"],
      roles: [],
      optionPolicy: "allow-list",
      safeOptions: ["--show-current", "-a", "--all", "-v", "--verbose", "--list", "--contains", "--merged", "--no-merged", "-r", "--remotes"],
      nonFileValueOptions: [...GIT_BRANCH_NON_FILE_VALUE_OPTIONS],
      group: "vcs-read",
      unsafeOptions: [...GIT_UNSAFE_OPTIONS],
      reason:
        "git branch 的写形态是位置参数（<新分支名>）与 -d/-D/-m/-M/-f，因此只放行显式列出的查询选项、且不允许位置参数（--contains <ref> 的 ref 因此被声明为取值）。",
    },
    {
      argv: ["git", "remote", "-v"],
      roles: [],
      group: "vcs-read",
      unsafeOptions: [...GIT_UNSAFE_OPTIONS],
      reason: "git remote -v 只列远端。",
    },
    {
      argv: ["git", "worktree", "list"],
      roles: [],
      group: "vcs-read",
      unsafeOptions: [...GIT_UNSAFE_OPTIONS],
      reason: "git worktree list 只列工作树。",
    },
    {
      argv: ["git", "stash", "list"],
      roles: [],
      group: "vcs-read",
      unsafeOptions: [...GIT_UNSAFE_OPTIONS],
      reason: "git stash list 只列 stash。",
    },
  ],

  // 文本读取：全部位置参数都是路径（旧白名单的口径，行为不变）。
  "text-read": [
    ...["cat", "wc", "nl", "od", "xxd", "file", "stat", "realpath"].map(
      (command): ReadOnlyCommandProfile => ({
        argv: [command],
        roles: ["paths"],
        group: "text-read",
        reason: `${command} 只读。`,
      }),
    ),
    {
      argv: ["head"],
      roles: ["paths"],
      group: "text-read",
      nonFileValueOptions: [...HEAD_TAIL_NON_FILE_VALUE_OPTIONS],
      reason: "head 只读；`-n 5` 的 5 是数字而不是文件（不产出读路径、不占角色槽）。",
    },
    {
      argv: ["tail"],
      roles: ["paths"],
      group: "text-read",
      nonFileValueOptions: [...HEAD_TAIL_NON_FILE_VALUE_OPTIONS],
      reason: "tail 只读；`-n 5` 的 5 是数字而不是文件。",
    },
    {
      argv: ["ls"],
      roles: ["paths"],
      group: "text-read",
      nonFileValueOptions: [...LS_NON_FILE_VALUE_OPTIONS],
      reason: "ls 只读；`-w 80` / `--time-style long-iso` 的取值不是文件。",
    },
    {
      argv: ["tree"],
      roles: ["paths"],
      group: "text-read",
      unsafeOptions: ["-o"],
      reason: "tree 只读；-o 会写文件（未实测，按保守处理）。",
    },
  ],

  // 文本处理（只读形态）：只读筛选/比较，写形态集中在少数选项上。
  "text-tools": [
    {
      argv: ["sort"],
      roles: ["paths"],
      group: "text-tools",
      unsafeOptions: ["-o", "--output", "--compress-program", "-T", "--temporary-directory"],
      nonFileValueOptions: [...SORT_NON_FILE_VALUE_OPTIONS],
      reason:
        "sort 只读；-o/--output 写文件，--compress-program 实测会执行传入的程序，-T 会在指定目录写临时文件。`-k 2` 的取值不是文件。",
    },
    // `uniq` **刻意不列**：`uniq [INPUT [OUTPUT]]` 的第二个位置参数是**输出文件**，
    // 而角色模型只能声明读路径（不声明写形态就不放行）——`sort -o` 同理已在 unsafeOptions 里。
    {
      argv: ["cut"],
      roles: ["paths"],
      group: "text-tools",
      nonFileValueOptions: [...CUT_NON_FILE_VALUE_OPTIONS],
      reason: "cut 只输出到 stdout；`-d :` / `-f 1,2` 的取值不是文件。",
    },
    {
      argv: ["comm"],
      roles: ["paths"],
      group: "text-tools",
      nonFileValueOptions: [...COMM_NON_FILE_VALUE_OPTIONS],
      reason: "comm 只比较两个文件并输出到 stdout。",
    },
    {
      argv: ["cmp"],
      // `cmp FILE1 [FILE2 [SKIP1 [SKIP2]]]`：后面的跳过字节数是数字，不是文件。
      roles: ["paths", "paths", "pattern"],
      group: "text-tools",
      nonFileValueOptions: [...CMP_NON_FILE_VALUE_OPTIONS],
      reason: "cmp 只比较并输出到 stdout；第 3/4 个位置参数是跳过字节数。",
    },
    {
      argv: ["diff"],
      roles: ["paths"],
      group: "text-tools",
      nonFileValueOptions: [...DIFF_NON_FILE_VALUE_OPTIONS],
      reason: "diff 只读（实测没有 -o/--output，--ed 一类也只写 stdout）；`-U 3` 的取值不是文件。",
    },
    {
      argv: ["tr"],
      roles: ["pattern"],
      group: "text-tools",
      reason: "tr 的两个位置参数都是字符集而不是路径（两个都是 pattern，不产出读目标）。",
    },
    {
      argv: ["jq"],
      roles: ["pattern", "paths"],
      group: "text-tools",
      nonFileValueOptions: ["--indent"],
      reason:
        "jq 只读：过滤器不是路径，输出只到 stdout（写文件要靠 shell 重定向，已由重定向层覆盖）。注意 --arg/--slurpfile 这类多取值选项未声明（只会让角色错位、多产出幽灵目标，不会放宽）。",
    },
  ],

  // 版本/元信息查询：argv 前缀限定到具体旗标，且不允许位置参数。
  meta: [
    ...([
      ["node", "--version"],
      ["node", "-v"],
      ["npm", "--version"],
      ["npm", "-v"],
      ["npx", "--version"],
      ["pnpm", "--version"],
      ["yarn", "--version"],
      ["python", "--version"],
      ["python", "-V"],
      ["python3", "--version"],
      ["tsc", "--version"],
      ["cargo", "--version"],
      ["go", "version"],
      ["git", "--version"],
      ["rg", "--version"],
    ] as const).map(
      (argv): ReadOnlyCommandProfile => ({
        argv: [...argv],
        roles: [],
        group: "meta",
        reason: "版本查询：只打印版本，没有位置参数。",
      }),
    ),
  ],

  // 目录导航：子命令的目标是“去哪里”，进项目内部目录是只读操作，出到项目外就不是。
  // 用 `onlyWithinRoots` 把“内部”这个条件交给事实层判定（它才知道 roots 与路径归一）。
  nav: [
    {
      argv: ["cd"],
      roles: ["paths"],
      group: "nav",
      onlyWithinRoots: true,
      reason:
        "cd 进项目内部目录只改 shell 的工作目录（且已被事实层跟踪，FR-70）；cd 到项目外、cd -、cd $DIR、无参数的 cd（回家目录）不免评审。",
    },
    {
      argv: ["pushd"],
      roles: ["paths"],
      group: "nav",
      onlyWithinRoots: true,
      reason:
        "pushd 与 cd 同级：同样只改工作目录与目录栈；无参数的 pushd 目标是栈顶（静态不可知），不免评审。",
    },
  ],

  // 只打印：位置参数是文本而不是文件（`echo note.env` 不应因为命中 `*.env` 规则而被拦，
  // 也不能被当成读路径去撞外部目录规则），因此角色是 pattern。
  print: [
    {
      argv: ["echo"],
      roles: ["pattern"],
      group: "print",
      reason: "echo 只把参数写到标准输出；参数是文本不是文件（重定向写文件由重定向层面判定）。",
    },
    {
      argv: ["printf"],
      roles: ["pattern"],
      group: "print",
      reason: "printf 只把格式化结果写到标准输出；`-v` 写的是 shell 变量，不涉文件。",
    },
  ],

  // 系统查询：只读状态查询，写形态（`date -s`、`hostname <新名>`）按取消处理。
  system: [
    {
      argv: ["date"],
      roles: ["pattern"],
      group: "system",
      unsafeOptions: ["-s", "--set"],
      reason: "date 只读地打印时间；-s/--set 会改系统时钟。",
    },
    {
      argv: ["du"],
      roles: ["paths"],
      group: "system",
      nonFileValueOptions: [...DU_DF_NON_FILE_VALUE_OPTIONS],
      reason: "du 只统计占用；`-d 1` / `--exclude '*.log'` 的取值不是文件。",
    },
    {
      argv: ["df"],
      roles: ["paths"],
      group: "system",
      nonFileValueOptions: [...DU_DF_NON_FILE_VALUE_OPTIONS],
      reason: "df 只统计文件系统容量；`-t ext4` / `-B 1M` 的取值不是文件。",
    },
    {
      argv: ["lsof"],
      roles: ["paths"],
      group: "system",
      nonFileValueOptions: [...LSOF_NON_FILE_VALUE_OPTIONS],
      reason: "lsof 只列出打开的文件；`-p 1234` / `-c name` 的取值不是文件。",
    },
    {
      argv: ["which"],
      roles: ["pattern"],
      group: "system",
      reason: "which 的位置参数是命令名而不是路径。",
    },
    {
      argv: ["type"],
      roles: ["pattern"],
      group: "system",
      reason: "type 的位置参数是命令名而不是路径。",
    },
    {
      argv: ["command", "-v"],
      roles: ["pattern"],
      group: "system",
      reason:
        "command -v 只查询命令路径，不执行它（与 which/type 同类）；位置参数是命令名而不是路径。",
    },
    {
      argv: ["command", "-V"],
      roles: ["pattern"],
      group: "system",
      reason: "command -V 只打印命令描述，不执行它；位置参数是命令名而不是路径。",
    },
    // `command` 只有 -p / -v / -V 三个旗标，组合空间是封闭的，因此把 `-p` 在前的两种也列上：
    // 否则 `command -p -v rg` 会因为前缀对不上而落回评审（无害但不必要）。
    {
      argv: ["command", "-p", "-v"],
      roles: ["pattern"],
      group: "system",
      reason: "command -p -v 同 command -v（-p 只改 PATH 查找）。",
    },
    {
      argv: ["command", "-p", "-V"],
      roles: ["pattern"],
      group: "system",
      reason: "command -p -V 同 command -V。",
    },
    {
      argv: ["ps"],
      roles: ["pattern"],
      group: "system",
      nonFileValueOptions: [...PS_NON_FILE_VALUE_OPTIONS],
      reason: "ps 的 BSD 风格参数（`ps aux`）不是路径；`-o pid,cmd` / `-p 1234` 的取值也不是文件。",
    },
    ...["uname", "id", "whoami", "uptime", "nproc"].map(
      (command): ReadOnlyCommandProfile => ({
        argv: [command],
        roles: [],
        group: "system",
        reason: `${command} 只读；不接受位置参数。`,
      }),
    ),
    {
      argv: ["hostname"],
      roles: [],
      group: "system",
      reason: "hostname 无参数时只打印主机名；`hostname <新名>` 是写系统状态，因此不允许位置参数。",
    },
  ],
};

/** 展开后的只读设置：档案列表 + “写入不算副作用”的目标。 */
export interface ExpandedReadOnly {
  profiles: ReadOnlyCommandProfile[];
  writeSinks: string[];
}

/** 展开一层配置里的 `workingDirectory`。 */
export function expandReadOnly(
  workingDirectory: {
    readOnly?: {
      profiles?: readonly ReadOnlyProfileGroup[];
      commands?: readonly (string | ReadOnlyCommandProfileInput)[];
      unsafeOptions?: readonly string[];
      sinks?: readonly string[];
    };
    readOnlyCommands?: readonly string[];
  },
): ExpandedReadOnly {
  const settings = workingDirectory.readOnly ?? {};
  const globalUnsafe = settings.unsafeOptions ?? [];
  const profiles: ReadOnlyCommandProfile[] = [];

  // 1) 用户条目优先：写一条更严的 `rg` 档案就能压住内置的那条。
  for (const entry of settings.commands ?? []) {
    profiles.push(withGlobalUnsafe(normalizeEntry(entry), globalUnsafe));
  }
  // 2) 内置分组。
  const groups = settings.profiles ?? DEFAULT_READONLY_PROFILE_GROUPS;
  for (const group of READONLY_PROFILE_GROUPS) {
    if (!groups.includes(group)) {
      continue;
    }
    for (const profile of GROUP_PROFILES[group]) {
      profiles.push(withGlobalUnsafe(profile, globalUnsafe));
    }
  }
  // 3) 旧字符串条目兜底（`readOnlyCommands` 的语义完全不变）。
  for (const entry of workingDirectory.readOnlyCommands ?? []) {
    profiles.push(
      withGlobalUnsafe(
        {
          argv: entry.trim().split(/\s+/).filter((word) => word.length > 0),
          roles: ["paths"],
          group: "readOnlyCommands",
          reason: "来自 workingDirectory.readOnlyCommands（字符串条目）。",
        },
        globalUnsafe,
      ),
    );
  }

  return {
    profiles,
    // 内置空设备（`/dev/null`、win32 的 `NUL`）由事实层按平台补充，这里只带用户追加的目标。
    writeSinks: [...(settings.sinks ?? [])],
  };
}

/** 结构化条目的输入形态（字符串 = `argv` 前缀 + 全部位置参数都是路径）。 */
export type ReadOnlyCommandProfileInput = Omit<ReadOnlyCommandProfile, "group" | "argv"> & {
  argv: readonly string[];
};

function normalizeEntry(entry: string | ReadOnlyCommandProfileInput): ReadOnlyCommandProfile {
  if (typeof entry === "string") {
    return {
      argv: entry.trim().split(/\s+/).filter((word) => word.length > 0),
      roles: ["paths"],
      group: "user",
      reason: "用户条目（字符串形态）。",
    };
  }
  return { ...entry, group: "user" };
}

/** 用户级全局选项黑名单对所有档案生效（只收紧，不会放宽任何条目）。 */
function withGlobalUnsafe(
  profile: ReadOnlyCommandProfile,
  globalUnsafe: readonly string[],
): ReadOnlyCommandProfile {
  if (globalUnsafe.length === 0) {
    return profile;
  }
  return {
    ...profile,
    unsafeOptions: [...(profile.unsafeOptions ?? []), ...globalUnsafe],
  };
}
