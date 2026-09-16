import type { Node as SyntaxNode } from "web-tree-sitter";

import { normalizeCommandText } from "../command-text.ts";

/**
 * 组合节点：能容纳多个命令单元的语法节点。
 *
 * 收集这些节点的文本，是为了让配置里跨单元的模式（`curl * | sh`）有东西可以匹配 ——
 * 单元文本只有 `curl https://x` 与 `sh`，两条单独的模式都命不中整条管道。
 *
 * 只收"结构性容器"，不收 `command` / `word` 这类叶子：`command` 的文本就是单元文本，
 * 重复收集只会让匹配面变宽而没有新信息。
 */
const CONTAINER_TYPES: ReadonlySet<string> = new Set([
  "program",
  "pipeline",
  "list",
  "subshell",
  "compound_statement",
  "redirected_statement",
  "command_substitution",
  "process_substitution",
  "if_statement",
  "for_statement",
  "while_statement",
  "case_statement",
  "function_definition",
  "negated_command",
]);

/**
 * 收集调用级匹配目标：所有容器节点的规范化文本，按源码顺序、去重。
 *
 * 去重按规范化后的文本做，因为 `a && b` 的 `program` 与 `list` 会得到同一个字符串。
 */
export function collectCompositeTexts(root: SyntaxNode): string[] {
  const texts: string[] = [];
  const seen = new Set<string>();
  const visit = (node: SyntaxNode): void => {
    if (CONTAINER_TYPES.has(node.type)) {
      const text = normalizeCommandText(node.text);
      if (text.length > 0 && !seen.has(text)) {
        seen.add(text);
        texts.push(text);
      }
    }
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child !== null) {
        visit(child);
      }
    }
  };
  visit(root);
  return texts;
}
