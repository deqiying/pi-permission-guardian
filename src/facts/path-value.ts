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
  const absolute = paths.isAbsolute(raw) ? raw : paths.resolve(cwd, raw);
  const lexical = normalizeSeparators(paths.normalize(absolute), platform);
  const canonical = options.resolveSymlinks === false ? undefined : canonicalizeFor(lexical, platform);
  return canonical === undefined ? { raw, lexical } : { raw, lexical, canonical };
}

/**
 * 只在目标平台与宿主平台一致时解析符号链接。
 *
 * 真实路径是宿主文件系统的属性：拿 Linux 语义去解析 Windows 上的路径只会得到无意义的结果。
 */
function canonicalizeFor(lexical: string, platform: NodeJS.Platform): string | undefined {
  return platform === process.platform ? canonicalizePath(lexical) : undefined;
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
 * 词法形与真实形都要看：`/tmp` 在很多平台上是指向 `/private/tmp` 的符号链接，
 * 只比较词法形会把根目录内部的路径误判成外部（或反之），所以任一侧判定在根内即视为内部。
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
    const rootLexical = normalizeSeparators(
      paths.isAbsolute(root) ? paths.normalize(root) : root,
      platform,
    );
    if (isUnder(rootLexical, value.lexical, platform)) {
      return false;
    }
    if (value.canonical !== undefined) {
      const rootCanonical = canonicalizeFor(rootLexical, platform);
      if (rootCanonical !== undefined && isUnder(rootCanonical, value.canonical, platform)) {
        return false;
      }
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
