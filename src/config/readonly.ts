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
  "-path",
  "-ipath",
  "-regex",
  "-iregex",
  "-type",
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
      reason:
        "rg 默认只搜不写；--pre 实测会 spawn 任意程序（每个被搜文件一次）、--hostname-bin 同为选项即程序。--glob/--type 的取值是模式而不是文件，因此豁免形状规则。",
    },
    {
      argv: ["grep"],
      roles: ["pattern", "paths"],
      group: "search",
      reason: "grep 只读；GNU grep 实测没有执行类选项（执行类选项在 git grep 上）。",
    },
    {
      argv: ["find"],
      roles: ["paths"],
      optionPolicy: "allow-list",
      safeOptions: [...FIND_SAFE_OPTIONS],
      group: "search",
      reason:
        "find 的危险选项密集（-delete / -fprint / -fprintf / -exec），因此只放行显式列出的只读谓词。",
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
        reason: `git ${subcommand} 是只读子命令；--output 会写文件，--ext-diff 会执行外部 diff 助手。`,
      }),
    ),
    {
      argv: ["git", "grep"],
      roles: ["pattern", "paths"],
      group: "vcs-read",
      unsafeOptions: [...GIT_UNSAFE_OPTIONS, "-O", "--ext-grep"],
      reason: "git grep 只读；-O 打开 pager、--ext-grep 会调用外部 grep（均为选项即程序）。",
    },
    {
      argv: ["git", "branch"],
      roles: [],
      optionPolicy: "allow-list",
      safeOptions: ["--show-current", "-a", "--all", "-v", "--verbose", "--list", "--contains", "--merged", "--no-merged", "-r", "--remotes"],
      group: "vcs-read",
      unsafeOptions: [...GIT_UNSAFE_OPTIONS],
      reason:
        "git branch 的写形态是位置参数（<新分支名>）与 -d/-D/-m/-M/-f，因此只放行显式列出的查询选项、且不允许位置参数。",
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
    ...["cat", "head", "tail", "wc", "nl", "od", "xxd", "file", "stat", "ls", "realpath"].map(
      (command): ReadOnlyCommandProfile => ({
        argv: [command],
        roles: ["paths"],
        group: "text-read",
        reason: `${command} 只读。`,
      }),
    ),
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
      reason:
        "sort 只读；-o/--output 写文件，--compress-program 实测会执行传入的程序，-T 会在指定目录写临时文件。",
    },
    ...["uniq", "cut", "comm", "cmp", "diff"].map(
      (command): ReadOnlyCommandProfile => ({
        argv: [command],
        roles: ["paths"],
        group: "text-tools",
        reason: `${command} 只读（diff 实测没有 -o/--output）。`,
      }),
    ),
    {
      argv: ["tr"],
      roles: ["pattern", "paths"],
      group: "text-tools",
      reason: "tr 的位置参数是字符集而不是路径。",
    },
    {
      argv: ["jq"],
      roles: ["pattern", "paths"],
      group: "text-tools",
      reason: "jq 只读：过滤器不是路径，输出只到 stdout（写文件要靠 shell 重定向，已由重定向层覆盖）。",
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
      reason: "du 只统计占用。",
    },
    {
      argv: ["df"],
      roles: ["paths"],
      group: "system",
      reason: "df 只统计文件系统容量。",
    },
    {
      argv: ["lsof"],
      roles: ["paths"],
      group: "system",
      reason: "lsof 只列出打开的文件。",
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
      reason: "ps 的 BSD 风格参数（`ps aux`）不是路径。",
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
