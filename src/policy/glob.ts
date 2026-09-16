import { toPosix } from "../facts/path-value.ts";

/**
 * 规则值的 glob 编译与匹配（FR-4、architecture §6.3）。
 *
 * 语义固定为：
 * - `*` → `.*`（**跨**路径分隔符；`**` 不特殊）
 * - `?` → 单字符
 * - 末尾 `" *"` → 让"空格 + 参数"整体可选（`git *` 匹配裸 `git`）
 * - 开头的 `~/`、`$HOME/`、`${HOME}/` 展开为用户主目录
 * - Windows 下模式与值**双侧折叠**（大小写不敏感 + 分隔符归一为 `/`）；POSIX 保持大小写敏感
 * - 整体模式锚定为 `^…$`
 *
 * 末尾 `" *"` 的语义不只是语法糖：授权建议模式（FR-30）必须靠它把"批准一条命令"限制成
 * "同一条命令（可带追加参数）"，否则把 `sh` 追加一个 `*` 就会连 `shutdown` 一起批准。
 */

export interface GlobOptions {
  /** 用户主目录，用于展开 `~/` 与 `$HOME/`。 */
  home: string;
  /** 目标平台，决定是否做大小写与分隔符折叠。 */
  platform: NodeJS.Platform;
}

export type GlobMatcher = (value: string) => boolean;

/** 需要转义的 PCRE 元字符（不处理字符类，因为编译结果里不会产生字符类）。 */
const REGEX_SPECIAL = new Set([".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

const WINDOWS = "win32";

/**
 * 展开模式开头的 home 写法。
 *
 * 只认"开头"这一种位置：中间出现的 `~` / `$HOME` 不是路径展开语境（事实层也只展开路径开头的写法），
 * 把它当普通字符处理更安全。
 */
function expandHome(pattern: string, home: string): string {
  const trimmed = home.replace(/[\\/]+$/, "");
  for (const prefix of ["~/", "$HOME/", "${HOME}/"]) {
    if (pattern.startsWith(prefix)) {
      return `${trimmed}/${pattern.slice(prefix.length)}`;
    }
  }
  for (const exact of ["~", "$HOME", "${HOME}"]) {
    if (pattern === exact) {
      return trimmed;
    }
  }
  return pattern;
}

/** 把 glob 模式转成锚定正则源码；导出以便对边界用例做纯函数断言。 */
export function globToRegExpSource(pattern: string): string {
  let body = pattern;
  let optionalArgs = false;
  if (body.endsWith(" *")) {
    optionalArgs = true;
    body = body.slice(0, -2);
  }
  let source = "";
  for (const char of body) {
    if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else {
      source += REGEX_SPECIAL.has(char) ? `\\${char}` : char;
    }
  }
  if (optionalArgs) {
    source += "(?: .*)?";
  }
  return `^${source}$`;
}

/** 折叠取值：Windows 下分隔符归一 + 大小写不敏感（FR-16）。 */
function foldValue(value: string, platform: NodeJS.Platform): string {
  return platform === WINDOWS ? toPosix(value).toLowerCase() : value;
}

export function compileGlob(pattern: string, options: GlobOptions): GlobMatcher {
  const folded = foldValue(expandHome(pattern, options.home), options.platform);
  // `s` 让 `.*` 也能跨行：命令文本里可能有 heredoc 正文。
  const regex = new RegExp(globToRegExpSource(folded), "s");
  return (value: string): boolean => regex.test(foldValue(value, options.platform));
}
