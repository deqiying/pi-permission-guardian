import { createRequire } from "node:module";
import type { Language, Parser, Tree } from "web-tree-sitter";

/**
 * tree-sitter-bash 的 WASM 解析器初始化与预热（FR-11、architecture §5.1）。
 *
 * 设计要点：
 * - `web-tree-sitter` 与 `tree-sitter-bash` 的 `.wasm` 随包发布，因此必须是运行时依赖，
 *   路径用 `createRequire(import.meta.url)` 解析（打包与安装位置都不会让它漂移）；
 * - **失败不缓存**：一次 WASM 加载抖动不应该永久毒化解析器，下次调用继续重试；
 * - 解析器无状态（`parse` 是输入的纯函数），可在模块级缓存供同步取用；
 * - 预热在 `before_agent_start` 完成，让第一个命令不承担 WASM 加载延迟。
 */

export interface BashParserHandle {
  parser: Parser;
  language: Language;
}

export interface BashParserStatus {
  state: "idle" | "loading" | "ready";
  /** 累计初始化尝试次数（含失败）。 */
  attempts: number;
  /** 最近一次失败原因；成功后清空。 */
  lastError?: string;
  /** 语言与 ABI 版本，便于排查 wasm 与运行时版本不匹配。 */
  language?: string;
  abiVersion?: number;
  treeSitterWasm?: string;
  bashWasm?: string;
}

type ParserState =
  | { kind: "idle" }
  | { kind: "loading"; promise: Promise<BashParserHandle> }
  | { kind: "ready"; handle: BashParserHandle };

let state: ParserState = { kind: "idle" };
let attempts = 0;
let lastError: string | undefined;
let wasmPaths: { treeSitter: string; bash: string } | undefined;
/** dispose 的代次：用于识别"加载还没完成就被释放"。 */
let generation = 0;

/**
 * 取得已就绪的解析器；尚未完成初始化时返回 undefined。
 *
 * 同步入口供 `tool_call` 使用：预热完成后这就是常态，未完成时调用方回退到异步解析。
 */
export function getBashParser(): BashParserHandle | undefined {
  return state.kind === "ready" ? state.handle : undefined;
}

/**
 * 确保解析器可用。并发调用共享同一次加载；失败后状态回到 idle，下次调用重新尝试。
 */
export function ensureBashParser(): Promise<BashParserHandle> {
  if (state.kind === "ready") {
    return Promise.resolve(state.handle);
  }
  if (state.kind === "loading") {
    return state.promise;
  }
  attempts += 1;
  state = { kind: "loading", promise: loadParser() };
  return state.promise;
}

/** 预热：失败只记录状态，不抛出（调用方是生命周期钩子）。 */
export async function warmupBashParser(): Promise<BashParserStatus> {
  try {
    await ensureBashParser();
  } catch {
    // 具体原因已记录在 lastError，由 /perm status 与日志呈现。
  }
  return bashParserStatus();
}

export function bashParserStatus(): BashParserStatus {
  const status: BashParserStatus = { state: state.kind, attempts };
  if (lastError !== undefined) {
    status.lastError = lastError;
  }
  if (wasmPaths !== undefined) {
    status.treeSitterWasm = wasmPaths.treeSitter;
    status.bashWasm = wasmPaths.bash;
  }
  if (state.kind === "ready") {
    const name = state.handle.language.name;
    if (name !== null) {
      status.language = name;
    }
    status.abiVersion = state.handle.language.abiVersion;
  }
  return status;
}

/** 释放 WASM 资源（`session_shutdown`）。释放后可再次初始化。 */
export function disposeBashParser(): void {
  // 代次递增：万一当前正在加载，加载完成的回调会发现自己的代次已经过期，
  // 于是直接释放刚建好的资源。否则 `/perm reload` 后立即退出会"释放后又变就绪"，
  // 等于没释放。
  generation += 1;
  if (state.kind === "ready") {
    state.handle.parser.delete();
  }
  state = { kind: "idle" };
}

/** 解析一段 shell 文本；解析器未就绪时返回 undefined（调用方决定是否等待）。 */
export function parseBashWith(handle: BashParserHandle, text: string): Tree | undefined {
  return handle.parser.parse(text) ?? undefined;
}

async function loadParser(): Promise<BashParserHandle> {
  const startedAt = generation;
  try {
    const require = createRequire(import.meta.url);
    const treeSitterWasm = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
    const bashWasm = require.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
    wasmPaths = { treeSitter: treeSitterWasm, bash: bashWasm };

    const { Parser: TreeSitterParser, Language: TreeSitterLanguage } =
      await import("web-tree-sitter");
    await TreeSitterParser.init({ locateFile: () => treeSitterWasm });
    const parser = new TreeSitterParser();
    const language = await TreeSitterLanguage.load(bashWasm);
    parser.setLanguage(language);

    const handle: BashParserHandle = { parser, language };
    if (startedAt !== generation) {
      // 加载期间被 dispose：不复活，直接释放。
      parser.delete();
      throw new Error("解析器在加载期间被释放");
    }
    state = { kind: "ready", handle };
    lastError = undefined;
    return handle;
  } catch (error) {
    // 关键：失败不缓存成 ready，状态回到 idle，下一次调用可重试。
    lastError = error instanceof Error ? error.message : String(error);
    state = { kind: "idle" };
    throw error;
  }
}
