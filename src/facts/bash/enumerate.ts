import { posix, win32 } from "node:path";

import type { Node as SyntaxNode, Tree } from "web-tree-sitter";

import { analyzeCommandArgs } from "./path-tokens.ts";
import { analyzeRedirect, collectRedirects, isRedirectNode, type RedirectOptions } from "./redirects.ts";
import { isReadOnlyUnit, rootsCancelReason, type ReadOnlyPlan } from "./readonly-commands.ts";
import { argumentNodesOf, argumentWord } from "./argv.ts";
import {
  classifyWrapper,
  executableName,
  transparentPrefixStart,
  unresolvedCauseForWrapper,
} from "./wrappers.ts";
import type { CommandUnit, FactsContext, PathTarget, UnresolvedCause } from "../types.ts";

/**
 * 命令单元枚举（FR-11、FR-14、architecture §5.2）。
 *
 * 枚举原则是 **never-weaker**：内层构造（命令替换、进程替换、子 shell、heredoc 正文里的替换）
 * 一律额外枚举，外层命令保留；已经枚举出的命令不会被它的外层掩盖。
 *
 * 降级原因按保守程度择一上报：
 * `parse-error` > `opaque-wrapper` > `indirection-wrapper` > `ambiguous-direction` > `dynamic-path`。
 *
 * 工作目录按 bash 的作用域跟踪（FR-70）：`cd <字面路径>` 之后的相对路径按新目录解析；
 * 管道元素、子 shell、命令替换各有自己的作用域（bash 里它们都是子进程）；
 * `cd` 的目标不可静态确定（`cd -`、`cd $DIR`、`pushd` / `popd`）时，该作用域里后续单元的
 * 相对路径不可解析，一律标记 `dynamic-path` 降级，而不是拿旧 cwd 猜一个"看起来真实的路径"。
 */

/** 能作为"一条命令"上报的节点类型。 */
const EXECUTABLE_NODE_TYPES: ReadonlySet<string> = new Set([
  "command",
  "test_command",
  "declaration_command",
  "unset_command",
]);

/** 自带独立 shell 作用域的节点（bash 里这些内部不是当前 shell 的 cwd）。 */
const SUBSHELL_NODE_TYPES: ReadonlySet<string> = new Set([
  "subshell",
  "command_substitution",
  "process_substitution",
]);

export interface BashEnumeration {
  commands: CommandUnit[];
  /** 整体不可信时的原因（目前只在整体解析报错时出现）。 */
  unresolved?: UnresolvedCause;
  unresolvedAt?: string[];
}

/** 工作目录作用域：随 `cd` 推进，进入子 shell 时派生新的作用域。 */
interface DirectoryScope {
  cwd: string;
  /** 该作用域的 cwd 已不可静态确定（`cd -`、`cd $DIR`、`pushd` / `popd`）。 */
  poisoned: boolean;
}

/** 导航类命令的作用域更新信息（由 `buildUnit` 报出，由 `walk` 应用）。 */
interface NavigationEffect {
  kind: "cd" | "pushd" | "popd";
  /** 字面目标（已按当前 cwd 解析为绝对路径）；缺省表示不可静态确定。 */
  target?: string;
  dynamic: boolean;
}

interface BuiltUnit {
  unit: CommandUnit;
  navigation?: NavigationEffect;
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
    ...(context.writeSinks === undefined ? {} : { writeSinks: context.writeSinks }),
  };

  const commands: CommandUnit[] = [];
  const root = tree.rootNode;
  const scope: DirectoryScope = { cwd: context.cwd, poisoned: false };
  walk(root, redirectOptions, context, commands, [], scope);

  // 整棵解析树里有 ERROR / missing 时，**所有**命令单元都不可信：
  // 这条命令的语法我们没读懂，就不应该有任何单元被当作"已确认只读"而直接放行。
  if (root.hasError) {
    for (const command of commands) {
      command.unresolved ??= "parse-error";
      // 同理：语法没读懂时，"命中了只读白名单"不能作为放行依据。
      command.readOnly = false;
    }
    if (commands.length === 0 && root.text.trim().length > 0) {
      // `((` / `if true` 这类：报错了，但语法树上没有任何可当命令的对象。
      // 必须留下一个"整条命令不可信"的保守对象，否则 §4.2 规则 5（有 unresolved 对象
      // 就走 onUnresolvedFacts）无从生效，决定权会落到 surface 默认动作上——用户一旦把
      // `permission.bash` 配成 allow，解析失败就变成了静默放行。
      commands.push({
        text: root.text.trim(),
        paths: [],
        readOnly: false,
        readOnlyCancel: "parse-error",
        unresolved: "parse-error",
      });
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
  scope: DirectoryScope,
): void {
  let redirects = inheritedRedirects;
  if (node.type === "redirected_statement") {
    // 复合语句（子 shell、`{ ...; }`）的重定向作用于内部所有命令，一并传下去。
    redirects = [...inheritedRedirects, ...collectRedirects(node)];
    if (node.childForFieldName("body") === null) {
      // `> .env` 这类**没有 body 的重定向语句**是合法的：bash 会真的截断/创建那个文件，
      // 只是什么都没执行。不给它生成对象，写目标就对规则完全不可见。
      // （写空设备的 `> /dev/null` 无持久副作用，不会被产出。）
      const unit = buildRedirectOnlyUnit(node, redirects, redirectOptions);
      if (unit !== undefined) {
        commands.push(unit);
      }
    }
  }

  if (EXECUTABLE_NODE_TYPES.has(node.type)) {
    const built = buildUnit(
      node,
      [...redirects, ...collectRedirects(node)],
      redirectOptions,
      context,
      scope,
    );
    commands.push(built.unit);
    if (built.navigation !== undefined) {
      applyNavigation(scope, built.navigation, context.platform);
    }
  }

  const nextInherited = node.type === "redirected_statement" ? redirects : inheritedRedirects;
  // 子 shell / 命令替换：内部共享一个派生作用域（`$(cd x && cat y)` 里的 cd 对 y 生效）。
  const subScope = SUBSHELL_NODE_TYPES.has(node.type)
    ? { cwd: scope.cwd, poisoned: scope.poisoned }
    : undefined;
  for (const child of node.namedChildren) {
    // 管道：每个元素都是独立进程（`cd x | cat` 不改变第二个元素的 cwd）。
    const childScope =
      node.type === "pipeline"
        ? { cwd: scope.cwd, poisoned: scope.poisoned }
        : subScope ?? scope;
    // 重定向节点内部是重定向**目标**（`> >(cat)`），它自己的命令不继承外层重定向。
    walk(
      child,
      redirectOptions,
      context,
      commands,
      isRedirectNode(child) ? inheritedRedirects : nextInherited,
      isRedirectNode(child) ? scope : childScope,
    );
  }
}

/** 应用 `cd` / `pushd` / `popd` 对当前作用域的影响。 */
function applyNavigation(
  scope: DirectoryScope,
  effect: NavigationEffect,
  platform: NodeJS.Platform,
): void {
  if (effect.kind === "popd" || effect.dynamic || effect.target === undefined) {
    scope.poisoned = true;
    return;
  }
  const paths = platform === "win32" ? win32 : posix;
  scope.cwd = paths.isAbsolute(effect.target)
    ? paths.normalize(effect.target)
    : paths.resolve(scope.cwd, effect.target);
}

/**
 * 只有重定向、没有命令的语句：产出写/读目标，且明确不是只读。
 *
 * 没有任何可报告的东西时（`2>&1` 这种描述符复制、写空设备的 `> /dev/null`）返回 undefined：
 * 凭空造一个单元只会让每条无害语句都招来一次评审。
 */
function buildRedirectOnlyUnit(
  node: SyntaxNode,
  redirectNodes: readonly SyntaxNode[],
  redirectOptions: RedirectOptions,
): CommandUnit | undefined {
  const paths: PathTarget[] = [];
  let ambiguous = false;
  let dynamic = false;
  for (const redirect of redirectNodes) {
    const analysis = analyzeRedirect(redirect, redirectOptions);
    paths.push(...analysis.paths);
    ambiguous = ambiguous || analysis.ambiguous;
    dynamic = dynamic || analysis.dynamic;
  }
  if (paths.length === 0 && !ambiguous && !dynamic) {
    return undefined;
  }
  const unresolved = pickCause({ parseError: node.hasError, wrapper: undefined, ambiguous, dynamic });
  const unit: CommandUnit = { text: node.text.trim(), paths, readOnly: false };
  if (unresolved !== undefined) {
    unit.unresolved = unresolved;
  }
  return unit;
}

function buildUnit(
  node: SyntaxNode,
  redirectNodes: readonly SyntaxNode[],
  redirectOptions: RedirectOptions,
  context: FactsContext,
  scope: DirectoryScope,
): BuiltUnit {
  const executableInfo = findExecutable(node);
  const executable = executableInfo.name;

  // 文本用于 bash surface 规则匹配，因此**不含重定向**：
  // `rm -rf / > /dev/null` 必须仍然能命中 `rm -rf /` 的 deny 规则。
  const text = commandText(node, redirectNodes);

  // 透明前缀内推（FR-12 修订）先于参数分析：算不清它就是普通的不透明包装器，
  // 算清了就把内层命令当作本单元的命令（`timeout 5 cat f` → `cat f`）。
  const argumentNodes = argumentNodesOf(node);
  const argumentWords = argumentNodes.map((child) => argumentWord(child));
  const chain = resolveUnwrapChain(executable, argumentWords, executableInfo.dynamic);
  const innerExecutable = chain?.executable ?? executable;

  const args = analyzeCommandArgs(node, innerExecutable, {
    // 相对路径按**当前作用域**的 cwd 解析（`cd src && cat .env` 里的 `.env` 在 src 下）；
    // 但"哪些目录算内部"仍按会话根目录判断，`cd /tmp` 不会把 /tmp 变成内部目录。
    cwd: scope.cwd,
    home: context.home,
    platform: context.platform,
    roots: context.roots,
    readOnlyCommands: context.readOnlyCommands,
    ...(chain === undefined ? {} : { startArgument: chain.startArgument }),
    ...(context.readOnlyProfiles === undefined
      ? {}
      : { readOnlyProfiles: context.readOnlyProfiles }),
  });

  // 包装器判断用**内层**命令名：`env X=1 sudo rm y` 内推一层后剩下的还是 `sudo`，仍是不透明的。
  const wrapper = classifyWrapper(innerExecutable, args.words);

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
    // 可执行名本身是动态的（`$X -rf /`）时，整条命令的"要点"就不在明面上。
    dynamic: args.dynamic || redirectDynamic || executableInfo.dynamic,
  });

  // 作用域的 cwd 已被 `cd $DIR` 之类破坏时，本单元的相对路径解析结果不可信（FR-70）。
  const finalUnresolved = unresolved ?? (scope.poisoned ? "dynamic-path" : undefined);

  const plan = args.readOnlyPlan;
  const navigation = navigationEffectFor(
    executable,
    args.words,
    args.paths,
    args.dynamic,
    context.home,
  );
  // 导航命令的目标不可静态确定（`cd -`、无参数 `pushd`、`popd`）时，连它自己也不能算“读懂了”：
  // `cd -` 会跳到未知目录，`popd` 恢复的是栈顶（未知），这种“看不透”必须走 onUnresolvedFacts，
  // 而不是因为参数里没有动态取值就当成干净的只读命令。
  const navigationUnknown =
    navigation !== undefined && (navigation.dynamic || navigation.kind === "popd");
  const finalCause = finalUnresolved ?? (navigationUnknown ? "dynamic-path" : undefined);
  const readOnly = isReadOnlyUnit({
    plan,
    paths,
    ...(finalCause === undefined ? {} : { unresolved: finalCause }),
  });

  const unit: CommandUnit = {
    text,
    paths,
    readOnly,
  };
  if (executable !== undefined) {
    unit.executable = innerExecutable;
  }
  if (chain !== undefined) {
    unit.unwrappedText = argumentNodes
      .slice(chain.startArgument)
      .map((child) => child.text)
      .filter((part) => part.length > 0)
      .join(" ");
  }
  if (wrapper !== undefined) {
    unit.viaWrapper = wrapper;
  }
  if (finalCause !== undefined) {
    unit.unresolved = finalCause;
  }
  const cancel = readOnlyCancelFor(plan, paths, readOnly);
  if (cancel !== undefined) {
    unit.readOnlyCancel = cancel;
  }

  const built: BuiltUnit = { unit };
  if (navigation !== undefined) {
    built.navigation = navigation;
  }
  return built;
}

/**
 * 免评审被取消的原因（FR-69），只为"本来能免评审"的情况记录。
 *
 * 没有命中档案时返回 undefined：那不是"被取消"，而是本来就不在白名单里。
 */
function readOnlyCancelFor(
  plan: ReadOnlyPlan | undefined,
  paths: readonly PathTarget[],
  readOnly: boolean,
): string | undefined {
  if (plan === undefined || readOnly) {
    return undefined;
  }
  if (plan.cancel !== undefined) {
    return plan.cancel;
  }
  // 档案要求目标在项目根内、但目标在外部（`cd /tmp`）或没有目标（`cd` 无参数）时，也要能解释。
  const roots = rootsCancelReason(plan, paths);
  if (roots !== undefined) {
    return roots;
  }
  const write = paths.find((path) => path.direction === "write");
  return write === undefined ? undefined : `redirect-write:${write.lexical}`;
}

/**
 * 导航命令的 cwd 变更（`cd` / `pushd` / `popd`，FR-70）。
 *
 * 目标取**已经展开与归一**的路径目标（`cd ~/x` 的 `~` 在 `buildArgv` 阶段已展开），
 * 因此这里不需要再处理引号与 `~`。
 */
function navigationEffectFor(
  executable: string | undefined,
  words: readonly string[],
  paths: readonly PathTarget[],
  dynamic: boolean,
  home: string,
): NavigationEffect | undefined {
  if (executable === "popd") {
    return { kind: "popd", dynamic: true };
  }
  if (executable !== "cd" && executable !== "pushd") {
    return undefined;
  }
  const kind = executable;
  if (dynamic) {
    return { kind, dynamic: true };
  }
  if (words.length === 1) {
    // `cd` 无参数 = 回家目录（已知）；`pushd` 无参数 = 交换栈顶两个目录（未知）。
    return kind === "cd" ? { kind, target: home, dynamic: false } : { kind, dynamic: true };
  }
  // `cd -` = 上一个目录，静态不可知；`cd <多个参数>` 在 bash 里只用第一个。
  if (words[1] === "-") {
    return { kind, dynamic: true };
  }
  const first = paths[0];
  if (first === undefined) {
    return { kind, dynamic: true };
  }
  return { kind, target: first.lexical, dynamic: false };
}

interface CauseInput {
  parseError: boolean;
  wrapper: "opaque" | "indirection" | undefined;
  ambiguous: boolean;
  dynamic: boolean;
}

/**
 * 把透明前缀判断给出的（过滤空词后的）下标换算回**参数词**下标，并取出内层命令名。
 *
 * 内层可执行名不可静态确定（`timeout 5 $CMD`）或为空时返回 undefined：那还是“看不懂”，
 * 继续按不透明包装器处理。
 */
function resolveUnwrapWord(
  words: readonly string[],
  filteredIndex: number,
): { nodeIndex: number; executable: string } | undefined {
  let seen = -1;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    if (word.length === 0) {
      continue;
    }
    seen += 1;
    if (seen !== filteredIndex) {
      continue;
    }
    // 变量/命令替换/反引号/通配符都是运行期才知道的值，不可当作内层命令名。
    if (/[$`*]/.test(word)) {
      return undefined;
    }
    const name = executableName(word);
    return name.length === 0 ? undefined : { nodeIndex: index, executable: name };
  }
  return undefined;
}

/** 内推层数上限：`env X=1 timeout 5 cat f` 是两层，再深基本只能是写错了。 */
const MAX_UNWRAP_DEPTH = 3;

/**
 * 逐层内推透明前缀（FR-12 修订），返回**最内层**命令与它在参数节点里的绝对下标。
 *
 * 每层都重新判断：`command cat f` → `cat f`；`env X=1 timeout 5 cat f` → `cat f`；
 * 停在第一个“不是透明前缀”的命令上（`env X=1 sudo rm y` 停在 `sudo`，由调用方标记为不透明）。
 * 全程看不透（`sudo` / `xargs` / `bash -c` / `timeout 5 $CMD`）时返回 undefined，行为不变。
 */
function resolveUnwrapChain(
  executable: string | undefined,
  argumentWords: readonly string[],
  dynamicExecutable: boolean,
): { startArgument: number; executable: string } | undefined {
  if (executable === undefined || dynamicExecutable) {
    return undefined;
  }
  let start = -1;
  let current = executable;
  let unwrapped = false;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    const words = argumentWords.slice(start + 1);
    const filtered = words.filter((word) => word.length > 0);
    const index = transparentPrefixStart(current, filtered);
    if (index === undefined) {
      break;
    }
    const next = resolveUnwrapWord(words, index);
    if (next === undefined) {
      break;
    }
    start = start + 1 + next.nodeIndex;
    current = next.executable;
    unwrapped = true;
  }
  return unwrapped ? { startArgument: start, executable: current } : undefined;
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
 *
 * 同时报出可执行名是否**本身就是动态**（`$X -rf /`、`$(echo rm) -rf /`）：这时命令文本匹配不上
 * 任何具体规则，单元必须按 FR-15 降级。
 */
function findExecutable(node: SyntaxNode): { name?: string; dynamic: boolean } {
  const commandName = node.childForFieldName("name");
  if (commandName === null) {
    return { dynamic: false };
  }
  const first = commandName.namedChildren.length > 0 ? commandName.namedChildren[0] : commandName;
  if (first === undefined) {
    return { dynamic: false };
  }
  const word = first.text.trim();
  if (word.length === 0) {
    return { dynamic: false };
  }
  const dynamic =
    first.type === "command_substitution" ||
    first.type === "expansion" ||
    first.type === "simple_expansion" ||
    /(^|[^\\])[$`]/.test(word);
  return { name: executableName(word), dynamic };
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
