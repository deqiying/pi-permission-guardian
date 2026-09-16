import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { disposeBashParser, ensureBashParser } from "../src/facts/bash/parser.ts";
import { extractFacts } from "../src/facts/extract.ts";
import type { FactsContext } from "../src/facts/types.ts";

/**
 * 生成 bash 语料期望值（`test/fixtures/bash/corpus.json`）。
 *
 * 用法：`node --experimental-strip-types scripts/gen-bash-corpus.ts`
 *
 * 重要：本脚本只做"把当前 facts 填进 JSON"，**不做任何判断**。生成结果必须逐条人工审阅：
 * 语料记录的是"我们承诺的行为"，不是"当前实现碰巧的输出"。审阅后如有不符，改的是实现
 * 或语料行，而不是把期望值调成现状。
 *
 * 只补齐 `corpus.txt` 里已有的行，不会删除已存在的条目（删条目要手工确认）。
 */

interface CorpusCase {
  units?: string[];
  unresolved?: string;
  unresolvedUnits?: number[];
  wrappers?: Record<string, "opaque" | "indirection">;
  readOnly?: number[];
  paths?: string[];
}

interface CorpusFile {
  context: FactsContext;
  cases: Record<string, CorpusCase>;
}

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const corpusPath = `${repoRoot}test/fixtures/bash/corpus.json`;
const listPath = `${repoRoot}test/fixtures/bash/corpus.txt`;

const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as CorpusFile;
const lines = readFileSync(listPath, "utf8")
  .split("\n")
  .map((line) => line.trimEnd())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

async function factsFor(command: string): Promise<CorpusCase> {
  const facts = await extractFacts("bash", { command }, corpus.context);
  const entry: CorpusCase = { units: facts.commands.map((unit) => unit.text) };
  if (facts.unresolved !== undefined) {
    entry.unresolved = facts.unresolved;
  }
  const unresolvedUnits = facts.commands
    .map((unit, index) => (unit.unresolved === undefined ? -1 : index))
    .filter((index) => index >= 0);
  if (unresolvedUnits.length > 0) {
    entry.unresolvedUnits = unresolvedUnits;
  }
  const wrappers: Record<string, "opaque" | "indirection"> = {};
  facts.commands.forEach((unit, index) => {
    if (unit.viaWrapper !== undefined) {
      wrappers[String(index)] = unit.viaWrapper;
    }
  });
  if (Object.keys(wrappers).length > 0) {
    entry.wrappers = wrappers;
  }
  const readOnly = facts.commands
    .map((unit, index) => (unit.readOnly ? index : -1))
    .filter((index) => index >= 0);
  if (readOnly.length > 0) {
    entry.readOnly = readOnly;
  }
  const paths = facts.commands.flatMap((unit) =>
    unit.paths.map((path) => `${path.direction}:${path.raw}`),
  );
  if (paths.length > 0) {
    entry.paths = paths;
  }
  return entry;
}

await ensureBashParser();
const added: string[] = [];
for (const line of lines) {
  if (corpus.cases[line] !== undefined) {
    continue;
  }
  corpus.cases[line] = await factsFor(line);
  added.push(line);
}
disposeBashParser();

// 输出顺序与 corpus.txt 一致；语料文件之外的多余条目会被删掉（发现残留正是重点）。
const ordered: Record<string, CorpusCase> = {};
for (const line of lines) {
  const entry = corpus.cases[line];
  if (entry !== undefined) {
    ordered[line] = entry;
  }
}
const dropped = Object.keys(corpus.cases).filter((key) => ordered[key] === undefined);
corpus.cases = ordered;
writeFileSync(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
console.log(`语料条目 ${lines.length} 行，本次补齐 ${added.length} 条：`);
if (dropped.length > 0) {
  console.log(`已移除 corpus.txt 中不存在的条目 ${dropped.length} 条：${dropped.join(" / ")}`);
}
for (const line of added) {
  console.log(`  ${JSON.stringify(line)} → ${JSON.stringify(corpus.cases[line])}`);
}
