import type { Node as SyntaxNode, Tree } from "web-tree-sitter";

import { analyzeCommandArgs } from "./path-tokens.ts";
import { analyzeRedirect, collectRedirects, type RedirectOptions } from "./redirects.ts";
import { matchReadOnlyCommands } from "./readonly-commands.ts";
import { classifyWrapper, executableName, unresolvedCauseForWrapper } from "./wrappers.ts";
import type { CommandUnit, FactsContext, PathTarget, UnresolvedCause } from "../types.ts";

/**
 * 命令单元枚举（FR-11、FR-14、architecture §5.2）。
 *
 * 枚举原则是 **never-weaker**：内层构造（命令替换、进程替换、子 shell、heredoc 正文里的替换）
 * 一律额外枚举，外层命令保留；已经枚举出的命令不会被它的外层掩盖。
 *
 * 降级原因按保守程度择一上报：
 * `parse-error` > `opaque-wrapper` > `indirection-wrapper` > `ambiguous-direction` > `dynamic-path`。
 */

/** 能作为"一条命令"上报的节点类型。 */
const EXECUTABLE_NODE_TYPES: ReadonlySet<string> = new Set([
  "command",
  "test_command",
  "declaration_command",
  "unset_command",
]);

export interface BashEnumeration {
  commands: CommandUnit[];
  /** 整体不可信时的原因（目前只在整体解析报错时出现）。 */
  unresolved?: UnresolvedCause;
  unresolvedAt?: string[];
}

export function enumerateBashUnits(
  tree: Tree,
  context: FactsContext,
): BashEnumeration {
  const redirectOptions: RedirectOptions = {
    cwd: context.cwd,
    home: context.home,
    platform: context.platform,
    roots: context.roots,
  };

  const commands: CommandUnit[] = [];
  const root = tree.rootNode;
  walk(root, redirectOptions, context, commands, []);

  // 整棵解析树里有 ERROR / missing 时，**所有**命令单元都不可信：
  // 这条命令的语法我们没读懂，就不应该有任何单元被当作"已确认只读"而直接放行。
  if (root.hasError) {
    for (const command of commands) {
      command.unresolved ??= "parse-error";
      // 同理：语法没读懂时，"命中了只读白名单"不能作为放行依据。
      command.readOnly = false;
    }
  }

  const unresolvedAt = commands
    .filter((command) => command.unresolved !== undefined)
    .map((command) => command.text);
  const enumeration: BashEnumeration = { commands };
  if (root.hasError) {
    enumeration.unresolved = "parse-error";
  }
  if (unresolvedAt.length > 0) {
    enumeration.unresolvedAt = unresolvedAt;
  }
  return enumeration;
}

function walk(
  node: SyntaxNode,
  redirectOptions: RedirectOptions,
  context: FactsContext,
  commands: CommandUnit[],
  inheritedRedirects: readonly SyntaxNode[],
): void {
  let redirects = inheritedRedirects;
  if (node.type === "redirected_statement") {
    // 复合语句（子 shell、`{ ...; }`）的重定向作用于内部所有命令，一并传下去。
    redirects = [...inheritedRedirects, ...collectRedirects(node)];
  }

  if (EXECUTABLE_NODE_TYPES.has(node.type)) {
    commands.push(
      buildUnit(node, [...redirects, ...collectRedirects(node)], redirectOptions, context),
    );
  }

  const nextInherited = node.type === "redirected_statement" ? redirects : inheritedRedirects;
  for (const child of node.namedChildren) {
    walk(child, redirectOptions, context, commands, nextInherited);
  }
}

function buildUnit(
  node: SyntaxNode,
  redirectNodes: readonly SyntaxNode[],
  redirectOptions: RedirectOptions,
  context: FactsContext,
): CommandUnit {
  const executable = findExecutable(node);

  // 文本用于 bash surface 规则匹配，因此**不含重定向**：
  // `rm -rf / > /dev/null` 必须仍然能命中 `rm -rf /` 的 deny 规则。
  const text = commandText(node, redirectNodes);

  const args = analyzeCommandArgs(node, executable, {
    cwd: context.cwd,
    home: context.home,
    platform: context.platform,
    roots: context.roots,
    readOnlyCommands: context.readOnlyCommands,
  });

  const wrapper = classifyWrapper(executable, args.words);

  // opaque 包装器的参数是**代码文本**（`bash -c 'rm -rf /'`），把它当路径会造出假目标。
  // indirection 包装器的参数仍然是真实参数（`sudo rm -rf /tmp/x`），照常提取。
  const paths: PathTarget[] = wrapper === "opaque" ? [] : [...args.paths];
  let ambiguous = false;
  let redirectDynamic = false;
  for (const redirect of redirectNodes) {
    const analysis = analyzeRedirect(redirect, redirectOptions);
    if (wrapper !== "opaque") {
      paths.push(...analysis.paths);
    }
    ambiguous = ambiguous || analysis.ambiguous;
    redirectDynamic = redirectDynamic || analysis.dynamic;
  }

  const unresolved = pickCause({
    parseError: node.hasError,
    wrapper,
    ambiguous,
    dynamic: args.dynamic || redirectDynamic,
  });

  const readOnlyMatch = matchReadOnlyCommands(args.words, context.readOnlyCommands);
  // 不可信的单元不能算只读：白名单命中的是 `cat $f`，而 `$f` 具体是什么并不知道。
  const readOnly =
    unresolved === undefined &&
    readOnlyMatch !== undefined &&
    paths.every((path) => path.direction === "read");

  const unit: CommandUnit = {
    text,
    paths,
    readOnly,
  };
  if (executable !== undefined) {
    unit.executable = executable;
  }
  if (wrapper !== undefined) {
    unit.viaWrapper = wrapper;
  }
  if (unresolved !== undefined) {
    unit.unresolved = unresolved;
  }
  return unit;
}

interface CauseInput {
  parseError: boolean;
  wrapper: "opaque" | "indirection" | undefined;
  ambiguous: boolean;
  dynamic: boolean;
}

function pickCause(input: CauseInput): UnresolvedCause | undefined {
  if (input.parseError) {
    return "parse-error";
  }
  if (input.wrapper !== undefined) {
    return unresolvedCauseForWrapper(input.wrapper);
  }
  if (input.ambiguous) {
    return "ambiguous-direction";
  }
  if (input.dynamic) {
    return "dynamic-path";
  }
  return undefined;
}

/**
 * 可执行名：`command_name` 的第一个词；前导赋值（`FOO=1 rm x`）由语法树单独给出，天然被跳过。
 */
function findExecutable(node: SyntaxNode): string | undefined {
  const commandName = node.childForFieldName("name");
  if (commandName === null) {
    return undefined;
  }
  const first = commandName.namedChildren.length > 0 ? commandName.namedChildren[0] : commandName;
  if (first === undefined) {
    return undefined;
  }
  const word = first.text.trim();
  return word.length === 0 ? undefined : executableName(word);
}

/**
 * 命令文本：节点原文去掉**前导赋值**与**重定向**片段，并去掉首尾空白。
 *
 * 去掉前导赋值是 architecture §5.2 的明确要求：否则 `FOO=1 rm -rf /` 匹配不上 `rm *` 这类规则。
 * 只在首尾裁剪空白，不动中间：折叠中间空白会改写引号内的内容，让文本与用户实际写的命令不一致。
 */
function commandText(node: SyntaxNode, redirectNodes: readonly SyntaxNode[]): string {
  const source = node.text;
  const start = node.startIndex;
  const ranges = [
    ...node.namedChildren
      .filter((child) => child.type === "variable_assignment")
      .map((child) => ({ from: child.startIndex - start, to: child.endIndex - start })),
    ...redirectNodes
      .filter((redirect) => redirect.startIndex >= start && redirect.endIndex <= node.endIndex)
      .map((redirect) => ({
        from: redirect.startIndex - start,
        to: redirect.endIndex - start,
      })),
  ]
    .sort((a, b) => a.from - b.from);

  if (ranges.length === 0) {
    return source.trim();
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.from > cursor) {
      parts.push(source.slice(cursor, range.from));
    }
    cursor = Math.max(cursor, range.to);
  }
  parts.push(source.slice(cursor));
  return parts.join("").trim();
}
