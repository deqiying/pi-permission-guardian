import { collectSurfaces } from "./classify.ts";
import { resetPathValueCache } from "./path-value.ts";
import { ensureBashParser, getBashParser, parseBashWith } from "./bash/parser.ts";
import { enumerateBashUnits, type BashEnumeration } from "./bash/enumerate.ts";
import { executableName } from "./bash/wrappers.ts";
import { extractFallbackPaths, lookupToolPathExtractor } from "./extractor-registry.ts";
import { extractToolPaths, hasToolPathRule, readStringField } from "./readonly-paths.ts";
import type { CommandUnit, Facts, FactsContext, PathTarget } from "./types.ts";

/**
 * 事实层入口：把一次工具调用变成 facts。
 *
 * 路由：
 * - `bash` → tree-sitter 解析 + 命令单元枚举（FR-11~15）；
 * - `powershell` → v1 没有 PowerShell 解析器，整条命令按不可静态展开处理（`unparsed-language`），
 *   因此 PowerShell 规则最多产生 `review` / `ask`，不会单独给出 `allow` / `deny`；
 * - `read`/`write`/`edit`/`find`/`grep`/`ls` → 工具路径提取（FR-17）；
 * - 其他工具 → 注册过的提取器（FR-18），未注册则回退到 `input.path`。
 *
 * 解析器不可用时**不抛异常**：退回"整条命令不可静态展开"的保守 facts，让决策层照常降级。
 */

export interface ExtractResult extends Facts {
  /** 解析器实际来源，便于审计与自检区分"真解析过"和"降级过"。 */
  parserUsed?: "tree-sitter" | "unavailable";
}

/** 同步提取：仅在 bash 解析器已预热时可用，否则返回 undefined 让调用方改走异步路径。 */
export function extractFactsSync(
  toolName: string,
  input: unknown,
  context: FactsContext,
): ExtractResult | undefined {
  // realpath 缓存只在**单次提取**内有效：跨调用复用会把"当时"的真实路径当成现在的事实
  // （软链接目标变了、文件被删了都不会失效），事实层就不再是输入的纯函数。
  resetPathValueCache();
  if (toolName === "bash") {
    const handle = getBashParser();
    if (handle === undefined) {
      return undefined;
    }
    const command = readStringField(input, "command");
    if (command === undefined) {
      return undefined;
    }
    return extractBashFacts(command, context, () => handle);
  }
  return extractNonBashFacts(toolName, input, context);
}

export async function extractFacts(
  toolName: string,
  input: unknown,
  context: FactsContext,
): Promise<ExtractResult> {
  resetPathValueCache();
  if (toolName === "bash") {
    const command = readStringField(input, "command") ?? "";
    let getHandle = getBashParser();
    if (getHandle === undefined) {
      try {
        getHandle = await ensureBashParser();
      } catch {
        // 解析器不可用：保留原文，按"不可静态展开"降级。
        return opaqueBashFacts(command, "unavailable");
      }
    }
    return extractBashFacts(command, context, () => getBashParser());
  }
  return extractNonBashFacts(toolName, input, context);
}

function extractBashFacts(
  command: string,
  context: FactsContext,
  getHandle: () => ReturnType<typeof getBashParser>,
): ExtractResult {
  const handle = getHandle();
  if (handle === undefined) {
    return opaqueBashFacts(command, "unavailable");
  }
  const tree = parseBashWith(handle, command);
  if (tree === undefined) {
    return opaqueBashFacts(command, "unavailable");
  }
  let enumeration: BashEnumeration;
  try {
    enumeration = enumerateBashUnits(tree, context);
  } finally {
    // WASM 线性内存只有显式 delete 才会回收：不释放的话每次 bash 调用都漏一棵语法树。
    // 枚举是同步且已完成拷贝的，这里释放安全。
    tree.delete();
  }
  const paths = enumeration.commands.flatMap((unit) => unit.paths);

  const facts: ExtractResult = {
    surfaces: collectSurfaces("bash", paths),
    commands: enumeration.commands,
    paths,
    parserUsed: "tree-sitter",
  };
  const unresolved = overallCause(enumeration.unresolved, enumeration.commands);
  if (unresolved !== undefined) {
    facts.unresolved = unresolved;
  }
  if (enumeration.unresolvedAt !== undefined) {
    facts.unresolvedAt = enumeration.unresolvedAt;
  }
  return facts;
}

/**
 * 整体是否不可信：整体解析报错时必然不可信；否则命令单元全不可信时才算整体不可信。
 *
 * 只要还有一个可静态确定的命令单元，就把判断留给 M3 的对象级求值（never-weaker：
 * 已解析的部分不能被未解析的部分抹掉，反之亦然）。
 */
function overallCause(
  rootCause: ExtractResult["unresolved"],
  commands: readonly CommandUnit[],
): ExtractResult["unresolved"] {
  if (rootCause !== undefined) {
    return rootCause;
  }
  if (commands.length === 0) {
    // 解析成功但没有任何命令单元（例如只有注释）：没有可信对象，也没有可疑对象。
    return undefined;
  }
  return commands.every((command) => command.unresolved !== undefined)
    ? commands[0]?.unresolved
    : undefined;
}

function opaqueBashFacts(
  command: string,
  parserUsed: "tree-sitter" | "unavailable",
): ExtractResult {
  if (command.trim().length === 0) {
    return { surfaces: collectSurfaces("bash", []), commands: [], paths: [], parserUsed };
  }
  const unit: CommandUnit = {
    text: command.trim(),
    paths: [],
    readOnly: false,
    // 两种原因必须分开：`parser-unavailable` 是基础设施故障（提示词与 /perm status
    // 不能把它说成"这个语言不支持"）。
    unresolved: parserUsed === "unavailable" ? "parser-unavailable" : "unparsed-language",
  };
  const executable = command.trim().split(/\s+/)[0];
  if (executable !== undefined && executable.length > 0) {
    unit.executable = executableName(executable);
  }
  return {
    surfaces: collectSurfaces("bash", []),
    commands: [unit],
    paths: [],
    unresolved: unit.unresolved,
    unresolvedAt: [unit.text],
    parserUsed,
  };
}

function extractNonBashFacts(
  toolName: string,
  input: unknown,
  context: FactsContext,
): ExtractResult {
  if (toolName === "powershell") {
    return powershellFacts(input);
  }
  let paths: PathTarget[];
  if (hasToolPathRule(toolName)) {
    paths = extractToolPaths(toolName, input, context);
  } else {
    const registered = lookupToolPathExtractor(toolName);
    const fromRegistry = registered?.(input, context);
    paths = fromRegistry === undefined ? extractFallbackPaths(input, context) : [...fromRegistry];
  }
  return { surfaces: collectSurfaces(toolName, paths), commands: [], paths };
}

/**
 * PowerShell：v1 没有解析器，因此整条命令是一条不可静态展开的单元。
 *
 * 这是有意的 fail-closed 选择：宁可让 PowerShell 规则只产生 `review` / `ask`，
 * 也不假装读懂了命令文本。
 */
function powershellFacts(input: unknown): ExtractResult {
  const command = (readStringField(input, "command") ?? "").trim();
  if (command.length === 0) {
    return { surfaces: collectSurfaces("powershell", []), commands: [], paths: [] };
  }
  const unit: CommandUnit = {
    text: command,
    executable: executableName(command.split(/\s+/)[0] as string),
    paths: [],
    viaWrapper: "opaque",
    readOnly: false,
    unresolved: "unparsed-language",
  };
  return {
    surfaces: collectSurfaces("powershell", []),
    commands: [unit],
    paths: [],
    unresolved: "unparsed-language",
    unresolvedAt: [unit.text],
  };
}
