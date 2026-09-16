#!/usr/bin/env node
// 打包内容门禁（M7 工作项 1）：真实跑一次 `npm pack --dry-run --json`，然后断言：
// 1) tarball 里有跑起来必需的东西 —— `pi.extensions` 入口、它的相对 import 闭包、
//    生成的 schema、参考配置、README 与 LICENSE；
// 2) 只属于仓库的东西没有被打进去（test/ scripts/ reference/ node_modules/ .github/）；
// 3) `files` 漏掉 `src/` 这类致命失误会被拦住：typecheck 与单测都在源码树上跑，看不见它；
// 4) prepack 没有就地修掉漂移的提交版 schema —— 生成产物必须在提交时就是最新的。
// 用法：npm run check:pack。任一条不满足即非零退出。

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与 `files` 无关的必需项：跑得起来靠前者，看得懂靠后者。 */
const REQUIRED_FILES = [
  "package.json",
  "README.md",
  "LICENSE",
  "config/config.json",
  "schemas/guardian.schema.json",
  "docs/requirements.md",
  "docs/configuration.md",
];

/** 只属于仓库、不该出现在 tarball 里的目录前缀。 */
const FORBIDDEN_PREFIXES = [
  "test/",
  "scripts/",
  "reference/",
  "node_modules/",
  ".github/",
  "dist/",
];

const EXTENSION_FILE_PATTERN = /\.(?:ts|js)$/;

const RELATIVE_IMPORT_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g, // import … from "…" / export … from "…"
  /\bimport\s*\(\s*["']([^"']+)["']/g, // 动态 import("…")
  /\bimport\s*["']([^"']+)["']/g, // 副作用 import "…"
];

/** npm pack --json 的元素（只声明用得到的字段）。 */
interface PackEntry {
  filename: string;
  size: number;
  files: unknown[];
}

const failures: string[] = [];
const notes: string[] = [];

const schemaFile = "schemas/guardian.schema.json";
const schemaBefore = readFileSync(join(root, schemaFile), "utf8");

const pack = runPack();

if (pack !== undefined) {
  const packed = new Set(packFilePaths(pack.files));
  checkRequiredFiles(packed);
  checkForbiddenFiles(packed);
  checkEntryClosure(packed, readExtensionEntries());
  notes.push(
    `${pack.filename}：${pack.files.length} 个文件，${Math.round(pack.size / 1024)} KB`,
  );
}

checkSchemaFreshness();

for (const note of notes) {
  console.log(`ok   ${note}`);
}
for (const failure of failures) {
  console.error(`FAIL ${failure}`);
}

if (failures.length > 0) {
  process.exitCode = 1;
}

/** 执行 `npm pack --dry-run --json`；失败时记录原因并返回 undefined。 */
function runPack(): PackEntry | undefined {
  const result = spawnSync("npm pack --dry-run --json", {
    cwd: root,
    encoding: "utf8",
    // 整条命令串交给 shell：Windows 上 npm 是 npm.cmd，不经 shell 无法执行；
    // 参数数组配 shell:true 会触发 Node 的 DEP0190 警告，所以这里只有一个固定命令串。
    shell: true,
  });

  if (result.error !== undefined) {
    failures.push(`无法执行 npm pack --dry-run --json：${result.error.message}`);
    return undefined;
  }
  if (result.status !== 0) {
    failures.push(
      `npm pack --dry-run --json 退出码 ${String(result.status)}：${(result.stderr ?? "").trim()}`,
    );
    return undefined;
  }

  try {
    return parsePackOutput(result.stdout ?? "");
  } catch (error) {
    failures.push(
      `无法解析 npm pack --dry-run --json 输出：${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/**
 * prepack（`npm run gen:schema`）的 stdout 排在 JSON 数组之前，所以不能整体 `JSON.parse`：
 * 从每个 `[` 起往后试，取第一个能解析成 pack 结果的片段。
 */
function parsePackOutput(stdout: string): PackEntry {
  const end = stdout.lastIndexOf("]");
  if (end === -1) {
    throw new Error(`没有找到 JSON 输出：\n${stdout}`);
  }
  for (
    let start = stdout.indexOf("[");
    start !== -1 && start < end;
    start = stdout.indexOf("[", start + 1)
  ) {
    const parsed = tryParse(stdout.slice(start, end + 1));
    if (Array.isArray(parsed)) {
      const first: unknown = parsed[0];
      if (isPackEntry(first)) {
        return first;
      }
    }
  }
  throw new Error(`没有解析出 pack 结果：\n${stdout}`);
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isPackEntry(value: unknown): value is PackEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { filename?: unknown; files?: unknown; size?: unknown };
  return (
    typeof candidate.filename === "string" &&
    typeof candidate.size === "number" &&
    Array.isArray(candidate.files)
  );
}

function packFilePaths(files: unknown[]): string[] {
  const paths: string[] = [];
  for (const file of files) {
    const path = (file as { path?: unknown }).path;
    if (typeof path !== "string") {
      failures.push(`npm pack 条目缺少 path 字段：${JSON.stringify(file)}`);
      continue;
    }
    paths.push(path);
  }
  return paths;
}

/** 入口声明 → 具体文件；目录按 pi 的加载约定取顶层 `.ts` / `.js`。 */
function readExtensionEntries(): string[] {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    pi?: { extensions?: unknown };
  };
  const declared = manifest.pi?.extensions;
  if (!Array.isArray(declared) || declared.length === 0) {
    failures.push("package.json 的 pi.extensions 为空：安装后不会有任何扩展被加载");
    return [];
  }

  const files: string[] = [];
  for (const entry of declared) {
    if (typeof entry !== "string" || entry.includes("*")) {
      // glob 声明无法在这里静态展开，交给 pi 的加载规则；缺失会由下面的闭包检查兜住。
      continue;
    }
    const absolute = resolve(root, entry);
    if (!statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) {
      files.push(toRepoPath(absolute));
      continue;
    }
    for (const name of readdirSync(absolute)) {
      if (EXTENSION_FILE_PATTERN.test(name)) {
        files.push(toRepoPath(join(absolute, name)));
      }
    }
  }
  return files;
}

function checkRequiredFiles(packed: Set<string>): void {
  const missing = REQUIRED_FILES.filter((file) => !packed.has(file));
  if (missing.length > 0) {
    failures.push(
      `tarball 缺少必需文件：${summarize(missing)}（检查 package.json 的 files）`,
    );
    return;
  }
  notes.push(`必需文件 ${REQUIRED_FILES.length} 项均在 tarball 内`);
}

function checkForbiddenFiles(packed: Set<string>): void {
  const forbidden = [...packed].filter((path) =>
    FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix)),
  );
  if (forbidden.length > 0) {
    failures.push(
      `tarball 打进了只属于仓库的文件：${summarize(forbidden)}（检查 package.json 的 files）`,
    );
    return;
  }
  notes.push(`未包含 ${FORBIDDEN_PREFIXES.join(" ")}`);
}

/**
 * 从入口出发跟随相对 import，断言整条闭包都在 tarball 内。
 * 这是 `files` 漏配（例如漏掉 `src/`）唯一能被自动发现的信号。
 */
function checkEntryClosure(packed: Set<string>, entryFiles: string[]): void {
  const missingInRepo: string[] = [];
  const closed = new Set<string>();
  const queue = [...entryFiles];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || closed.has(current)) {
      continue;
    }
    closed.add(current);

    const absolute = join(root, current);
    if (!statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
      missingInRepo.push(current);
      continue;
    }
    for (const specifier of collectRelativeImports(readFileSync(absolute, "utf8"))) {
      const next = toRepoPath(resolve(dirname(absolute), specifier));
      if (!closed.has(next)) {
        queue.push(next);
      }
    }
  }

  if (missingInRepo.length > 0) {
    failures.push(`入口闭包引用了仓库里不存在的文件：${missingInRepo.join("、")}`);
    return;
  }

  const absent = [...closed].filter((path) => !packed.has(path));
  if (absent.length > 0) {
    failures.push(
      `tarball 缺少入口闭包中的文件：${summarize(absent)}（检查 package.json 的 files）`,
    );
    return;
  }
  notes.push(`入口闭包 ${closed.size} 个文件全部在 tarball 内`);
}

/** 失败列表可能很长（例如 `files` 漏掉整个 `src/`），保留前几项并给出总数。 */
function summarize(paths: string[]): string {
  const shown = paths.slice(0, 8).join("、");
  return paths.length > 8 ? `${shown} 等 ${paths.length} 项` : shown;
}

function collectRelativeImports(text: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of RELATIVE_IMPORT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined && specifier.startsWith(".")) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

/**
 * prepack 会在打包前重新生成 schema。提交版与 zod 输出不一致时，这次打包会就地修好它 ——
 * 也就是"提交的 schema 与生成结果一致"这条不变量在此刻被掩盖了，必须报出来。
 */
function checkSchemaFreshness(): void {
  const schemaAfter = readFileSync(join(root, schemaFile), "utf8");
  if (schemaAfter === schemaBefore) {
    notes.push(`${schemaFile} 与 zod 输出一致（prepack 未改写）`);
    return;
  }
  failures.push(
    `提交版 ${schemaFile} 与 zod 输出漂移：prepack 已就地重新生成，请检查并提交更新后的文件`,
  );
}

function toRepoPath(absolute: string): string {
  return relative(root, absolute).replaceAll("\\", "/");
}
