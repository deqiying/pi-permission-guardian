import { compileGlob, type GlobMatcher, type GlobOptions } from "./glob.ts";
import type { PolicyObject } from "./evaluate.ts";
import type { Direction } from "../facts/types.ts";

/**
 * 会话授权记忆（FR-29/30、architecture §8.1）。
 *
 * 三条硬约束：
 * 1. **只有人工对话框里的"本会话允许此类"才能创建**。评审模型 allow、缓存命中、自动审核与
 *    用户手输 `!command` 本身都不写入授权（FR-29）；本模块只提供键的生成与匹配，写入点唯一地
 *    放在 decision/pipeline 的人工确认分支里。
 * 2. **授权只能放宽 `ask` / `review`，永不覆盖 `deny`**，且 `unresolved` 的调用不享受授权
 *    （与缓存同一条理由：无法稳定复现的目标不该走快路径）。
 * 3. 键由 facts 生成**建议模式**并在提示里展示，让"批准一条命令"与"批准一类命令"的边界对用户可见。
 */

export interface GrantKey {
  /** 规范化后的 surface（路径对象用 `path_read` / `external_directory_write` 这类方向面）。 */
  surface: string;
  /** 由 facts 生成的建议模式，经用户确认。 */
  pattern: string;
  direction?: Direction;
}

/** 键编码分隔符：不可能出现在 surface 名里的控制字符。 */
const SEPARATOR = "\u0000";

export function encodeGrantKey(key: GrantKey): string {
  return `${key.surface}${SEPARATOR}${key.pattern}`;
}

export function decodeGrantKey(encoded: string): GrantKey | undefined {
  const index = encoded.indexOf(SEPARATOR);
  if (index <= 0 || index === encoded.length - 1) {
    return undefined;
  }
  return {
    surface: encoded.slice(0, index),
    pattern: encoded.slice(index + 1),
  };
}

/** 供 `/perm grants` 与人工提示展示：`bash：rm -rf ./dist *`。 */
export function formatGrantKey(encoded: string): string {
  const key = decodeGrantKey(encoded);
  return key === undefined ? encoded : `${key.surface}：${key.pattern}`;
}

/**
 * 由一个被裁决对象生成建议授权模式（FR-30）。
 *
 * 模式是「主目标 + 末尾 `" *"`」而不是「主目标 + `*`」：后者在 glob 里是 `.*`，
 * 会把 `sh` 批准成 `shutdown`、把 `rm -rf ./dist` 批准成 `rm -rf ./distant`。
 * 用 FR-4 已定义的"空格 + 参数可选"语义，则既覆盖追加参数的同一条命令，又不会跨到别的命令。
 */
export function suggestGrantKey(object: PolicyObject): GrantKey {
  const key: GrantKey = {
    surface: object.surfaces[0] ?? object.primary,
    pattern: `${object.primary} *`,
  };
  if (object.direction !== undefined) {
    key.direction = object.direction;
  }
  return key;
}

/** 为一组对象生成去重后的建议授权键。 */
export function grantKeysForObjects(objects: readonly PolicyObject[]): GrantKey[] {
  const keys = new Map<string, GrantKey>();
  for (const object of objects) {
    const key = suggestGrantKey(object);
    keys.set(encodeGrantKey(key), key);
  }
  return [...keys.values()];
}

interface CompiledGrant {
  surface: string;
  match: GlobMatcher;
}

/**
 * 调用是否被会话授权覆盖。
 *
 * 判定是"**每个**需要授权的对象都被覆盖"，而不是"任意一个对象被覆盖"：
 * `rm -rf ./dist && curl x | sh` 不应因为前半段被批准就整条放行。
 * 需要授权的对象由调用方给出（动作是 `ask` / `review` 的那些），因此已被告知放行或已被告知
 * 拒绝的对象不参与，判据与创建授权时用的对象集合一致。
 */
export function isCallGranted(
  objects: readonly PolicyObject[],
  grantedKeys: Iterable<string>,
  options: GlobOptions,
): boolean {
  if (objects.length === 0) {
    return false;
  }
  const grants: CompiledGrant[] = [];
  for (const encoded of grantedKeys) {
    const key = decodeGrantKey(encoded);
    if (key === undefined) {
      continue;
    }
    grants.push({
      surface: key.surface,
      match: compileGlob(key.pattern, options),
    });
  }
  if (grants.length === 0) {
    return false;
  }
  return objects.every((object) =>
    grants.some(
      (grant) =>
        object.surfaces.some(
          (surface) => grant.surface === "*" || grant.surface === surface,
        ) && object.targets.some((target) => grant.match(target)),
    ),
  );
}
