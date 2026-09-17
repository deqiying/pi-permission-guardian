import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

import type { PathSource, PathTarget } from "./types.ts";

/**
 * 路径值的词法/真实双形归一（FR-15、FR-16）。
 *
 * 归一化的目标是"让规则匹配与外部目录判定有一致的比较基准"，因此：
 * - 词法形总是存在（纯字符串运算，不碰文件系统），相对路径按 cwd 展开；
 * - 真实形尽力而为：解析符号链接，失败就缺省（文件不存在、权限不足、路径超长都可能失败）；
 * - Windows 上分隔符归一、比较不区分大小写；POSIX 保持大小写敏感。
 */

export interface PathValue {
  raw: string;
  lexical: string;
  canonical?: string;
}

export interface PathValueOptions {
  cwd: string;
  platform: NodeJS.Platform;
  /** 是否尝试解析符号链接（默认 true）。批量分析时可关闭以省系统调用。 */
  resolveSymlinks?: boolean;
}

/** realpath 结果缓存：同一次调用里同一个目录会被反复解析（每个目标都要解析父目录）。 */
const canonicalCache = new Map<string, string | undefined>();
const CANONICAL_CACHE_LIMIT = 4096;
const WINDOWS = "win32";

/**
 * 按**目标平台**取路径实现，而不是 `node:path` 的宿主默认实现。
 *
 * 这样同一份 facts 逻辑在 Linux/macOS/Windows 上对同一输入给出同一结果：Windows 的
 * 盘符、反斜杠与大小写语义可以被跨平台单测覆盖，而不是"本机是什么就按什么算"。
 */
function pathModule(platform: NodeJS.Platform): typeof posix {
  return platform === WINDOWS ? (win32 as typeof posix) : posix;
}

export function isCaseInsensitive(platform: NodeJS.Platform): boolean {
  return platform === WINDOWS;
}

/** 统一分隔符为平台原生形式（Windows 下 `/` → `\`）。 */
export function normalizeSeparators(value: string, platform: NodeJS.Platform): string {
  return platform === WINDOWS ? value.replaceAll("/", "\\") : value;
}

/** 转为 `/` 分隔，便于 glob 匹配、日志与跨平台比较。 */
export function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

/** 比较键：Windows 下大小写不敏感（FR-16）。 */
export function compareKey(value: string, platform: NodeJS.Platform): string {
  const native = normalizeSeparators(value, platform);
  return isCaseInsensitive(platform) ? native.toLowerCase() : native;
}

/** 两个路径是否指向同一位置（按平台的大小写规则）。 */
export function pathEquals(
  a: string,
  b: string,
  platform: NodeJS.Platform,
): boolean {
  return compareKey(a, platform) === compareKey(b, platform);
}

/** `target` 是否位于 `root` 之内（含 root 自身）。 */
export function isUnder(
  root: string,
  target: string,
  platform: NodeJS.Platform,
): boolean {
  const rootKey = compareKey(root, platform);
  const targetKey = compareKey(target, platform);
  if (targetKey === rootKey) {
    return true;
  }
  const separator = pathModule(platform).sep;
  const withSeparator = rootKey.endsWith(separator) ? rootKey : `${rootKey}${separator}`;
  return targetKey.startsWith(withSeparator);
}

/**
 * `raw` 是否是一个能在词法上定出的路径写法。
 *
 * `$` 与反引号意味着取值取决于运行时（变量、命令替换），按 FR-15 必须保持字面并标记 unresolved。
 * glob 通配符（`*` / `?`）不算：它给出的是同一目录下的一组确定路径，目录部分仍然可靠。
 */
export function isLiteralPathText(raw: string): boolean {
  return !raw.includes("$") && !raw.includes("`");
}

/**
 * 计算一个路径候选的归一化结果。
 *
 * 动态路径（`$DIR/x`）按 FR-15 保持字面：此时不把 cwd 拼接上去——拼接会造出一个
 * 看起来真实、实际不存在的路径，反而让"外部目录"判定失真。
 */
export function makePathValue(raw: string, options: PathValueOptions): PathValue {
  const { cwd, platform } = options;
  const paths = pathModule(platform);
  if (!isLiteralPathText(raw)) {
    return { raw, lexical: normalizeSeparators(raw, platform) };
  }
  // MSYS / Cygwin 形式的盘符路径（git-bash 下 `/c/Users/x` 就是 `C:\Users\x`）先归一，
  // 否则它会变成一个拼在 cwd 下的假路径，用户的显式路径规则（`C:\Users\**`）命不中。
  const literal = platform === WINDOWS ? msysToWindows(raw) : raw;
  const lexical = normalizeSeparators(paths.normalize(paths.resolve(cwd, literal)), platform);
  const canonical =
    options.resolveSymlinks === false
      ? undefined
      : canonicalizeFor(unfoldedAbsolute(cwd, literal, platform), platform);
  return canonical === undefined ? { raw, lexical } : { raw, lexical, canonical };
}

/**
 * MSYS / Cygwin 盘符路径归一（仅 Windows 目标平台）：
 * `/c/Users/x` → `C:\Users\x`，`/cygdrive/c/x` → `C:\x`，`/c` 与 `/c/` → `C:\`。
 *
 * 只认"单个字母的挂载点"这一形状：`c/x`（相对）、`./c/x`、UNC（`//server/share`）都不在这里处理，
 * 后者在 Windows 路径实现里本来就是合法绝对路径。
 */
export function msysToWindows(text: string): string {
  const match = /^\/(?:cygdrive\/)?([a-zA-Z])(?=\/|$)/.exec(text);
  if (match === null) {
    return text;
  }
  const rest = text.slice(match[0].length);
  const drive = `${(match[1] as string).toUpperCase()}:`;
  return rest.length === 0 || rest === "/" ? `${drive}\\` : `${drive}${rest}`;
}

/**
 * 拼出"未折叠 `..` 的绝对路径"，专供 realpath 用。
 *
 * `path.resolve` / `path.normalize` 会先做词法折叠，而内核是**先解析软链接再处理 `..`**：
 * `cat ./link/../shadow`（`link` 指向别处）实际打开的是软链接目标旁边的 `shadow`，
 * 而不是 `<cwd>/shadow`。先折叠会让真实形与词法形一起错，并把路径错判成"根目录内"，
 * 从而绕过外部目录规则（FR-16）。因此这里只做拼接与分隔符归一，不碰 `..`。
 */
function unfoldedAbsolute(cwd: string, raw: string, platform: NodeJS.Platform): string {
  const paths = pathModule(platform);
  if (paths.isAbsolute(raw)) {
    return raw;
  }
  const tail = raw.replace(/[\/]+/g, paths.sep);
  return cwd.endsWith(paths.sep) ? cwd + tail : cwd + paths.sep + tail;
}

/**
 * 真实路径：对未折叠的绝对路径做 realpath。
 */
function canonicalizeFor(absolute: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== process.platform) {
    return undefined;
  }
  if (isUncPath(absolute, platform)) {
    // UNC（`\\server\share\x`）不解析真实路径：realpath 会对网络位置发起 SMB 访问，
    // 可能卡住几十秒、而 `tool_call` 里不能阻塞。它本来就不在任何本地根目录内，
    // 词法形比较已经足够（根目录也可以是 UNC，那时同样按词法比）。
    return undefined;
  }
  const native = normalizeSeparators(absolute, platform);
  return canonicalizePath(native) ?? canonicalizePath(normalizeNative(native));
}

/** Windows UNC 路径（`\\server\share` 与 `//server/share` 两种写法）。 */
function isUncPath(value: string, platform: NodeJS.Platform): boolean {
  return platform === WINDOWS && /^[\\/]{2}/.test(value);
}

function normalizeNative(absolute: string): string {
  return pathModule(process.platform as NodeJS.Platform).normalize(absolute);
}

/** 只是把 `raw` 包成 PathTarget，附带外部目录判定。 */
export function makePathTarget(
  raw: string,
  direction: PathTarget["direction"],
  source: PathSource,
  options: PathValueOptions & { roots: readonly string[] },
): PathTarget {
  const value = makePathValue(raw, options);
  return {
    ...value,
    direction,
    source,
    external: isExternal(value, options.roots, options.platform),
  };
}

/**
 * 路径是否在允许根目录之外。
 *
 * 有真实形时**只信真实形**：真实形是内核真正打开的位置，词法形只能作为拿不到真实形时的退路。
 * 两侧都拿真实形再比（根目录自己也可能是个软链接，例如 macOS 的 `/tmp → /private/tmp`），
 * 否则"根内 + `..` 穿软链接"的路径会被误判成根内而绕过外部目录规则。
 *
 * 相对路径形式的根目录（`../shared-lib`）在这里**不参与匹配**：解析它需要会话 cwd，
 * 而事实层拿不到会话 cwd（用宿主进程 cwd 解析会得到静默错误的根）。调用方应在组装
 * FactsContext 时把 `allowRoots` 展开为绝对路径（`~` 用 home、相对路径用会话 cwd）。
 */
export function isExternal(
  value: PathValue,
  roots: readonly string[],
  platform: NodeJS.Platform,
): boolean {
  if (roots.length === 0) {
    return true;
  }
  const paths = pathModule(platform);
  for (const root of roots) {
    if (!paths.isAbsolute(root)) {
      continue;
    }
    const rootLexical = normalizeSeparators(paths.normalize(root), platform);
    if (value.canonical !== undefined) {
      const rootCanonical = canonicalizeFor(rootLexical, platform);
      if (rootCanonical !== undefined && isUnder(rootCanonical, value.canonical, platform)) {
        return false;
      }
      continue;
    }
    if (isUnder(rootLexical, value.lexical, platform)) {
      return false;
    }
  }
  return true;
}

/**
 * 尽力而为的真实路径：自下而上找到第一个存在的祖先目录做 realpath，再接回剩余片段。
 *
 * 直接 `realpathSync` 只能处理已存在的路径，而写操作的目标通常还不存在；不解析父目录的话，
 * 通过符号链接目录访问的外部路径就绕不过外部目录判定。
 */
export function canonicalizePath(absolute: string): string | undefined {
  const cached = canonicalCache.get(absolute);
  if (cached !== undefined || canonicalCache.has(absolute)) {
    return cached;
  }
  const result = resolveSymlinksBestEffort(absolute);
  if (canonicalCache.size >= CANONICAL_CACHE_LIMIT) {
    canonicalCache.clear();
  }
  canonicalCache.set(absolute, result);
  return result;
}

function resolveSymlinksBestEffort(absolute: string): string | undefined {
  const paths = pathModule(process.platform as NodeJS.Platform);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    const real = tryRealpath(current);
    if (real !== undefined) {
      return missing.length === 0 ? real : paths.join(real, ...missing.reverse());
    }
    const parent = paths.dirname(current);
    if (parent === current) {
      return undefined;
    }
    missing.push(paths.basename(current));
    current = parent;
  }
}

function tryRealpath(target: string): string | undefined {
  try {
    return realpathSync.native(target);
  } catch {
    // 不存在 / 权限不足 / 路径过长都归为"解析不了"，由上层退回词法形。
    return undefined;
  }
}

/** 仅供测试：清空 realpath 缓存。 */
export function resetPathValueCache(): void {
  canonicalCache.clear();
}

/** URL 形态（`https://host/path`）：不是文件路径，当作路径候选会产生误判。 */
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * 看起来像路径：含分隔符、以 `~` / `.` / `/` 开头、或带盘符。
 *
 * 这是**形状启发式**，不是判定：未知命令的参数靠它筛出路径候选（FR-15 的旧口径），
 * 声明了只读档案的命令则不靠它——那些命令的路径位置由档案的 `roles` 显式给出（FR-65）。
 */
export function looksLikePath(text: string): boolean {
  if (text.length === 0 || URL_PATTERN.test(text)) {
    return false;
  }
  if (text.includes("/") || text.includes("\\")) {
    return true;
  }
  if (text.startsWith("~")) {
    return true;
  }
  if (text.startsWith(".")) {
    return true;
  }
  return /^[A-Za-z]:$/.test(text) || /^[A-Za-z]:[^\\/]/.test(text);
}
