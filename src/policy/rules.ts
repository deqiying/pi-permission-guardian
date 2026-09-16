import type { ResolvedConfig } from "../config/merge.ts";
import type { RuleLayer } from "../config/normalize.ts";
import type { Action } from "./action.ts";
import { compileGlob, type GlobMatcher, type GlobOptions } from "./glob.ts";

/**
 * 可求值规则表（architecture §6.2）。
 *
 * `ResolvedConfig.rules` 是"每层一张有序规则表"；这里把每层的模式编译成匹配器，
 * 拍平成一张**带层标记**的规则列表。求值器仍按 (layer, surface, index) 处理：
 * 层内 last-match-wins（FR-5）、跨层最严格者（FR-6）。
 *
 * 编译只需要 glob 选项（home / platform），与会话无关；调用方按配置版本缓存这张表即可。
 */

export interface CompiledRule {
  surface: string;
  pattern: string;
  matcher: GlobMatcher;
  action: Action;
  reason?: string;
  layer: RuleLayer;
  /** 同层同 surface 内的写入序号（last-match-wins 的比较依据）。 */
  index: number;
}

export interface CompiledRuleTable {
  rules: readonly CompiledRule[];
}

export function compileRuleTable(
  config: ResolvedConfig,
  options: GlobOptions,
): CompiledRuleTable {
  const rules: CompiledRule[] = [];
  for (const layer of config.rules) {
    for (const [surface, entries] of layer.surfaces) {
      for (const entry of entries) {
        rules.push({
          surface,
          pattern: entry.pattern,
          matcher: compileGlob(entry.pattern, options),
          action: entry.action,
          reason: entry.reason,
          layer: layer.layer,
          index: entry.index,
        });
      }
    }
  }
  return { rules };
}
