#!/usr/bin/env node
// 校验仓库内的官方参考配置 config/config.json（FR-57/58）：
// 1) 必须是严格 JSON（无注释、无尾逗号），JSON.parse 直接可解析；
// 2) 必须通过 zod 唯一真源（src/config/schema.ts）；
// 3) 必须通过提交的 schemas/guardian.schema.json —— 编辑器看到的就是这一份。
// 用法：npm run validate:config。任一步失败即以非零码退出。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { guardianConfigSchema } from "../src/config/schema.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(root, "config", "config.json");
const schemaPath = join(root, "schemas", "guardian.schema.json");

const failures: string[] = [];
const notes: string[] = [];

const text = readFileSync(configPath, "utf8");
let parsed: unknown;
try {
  parsed = JSON.parse(text) as unknown;
  notes.push(`${configPath} 是严格 JSON`);
} catch (error) {
  failures.push(
    `${configPath} 不是严格 JSON：${error instanceof Error ? error.message : String(error)}`,
  );
}

if (failures.length === 0) {
  const zodResult = guardianConfigSchema.safeParse(parsed);
  if (zodResult.success) {
    notes.push("通过 zod 唯一真源校验");
  } else {
    failures.push(
      `未通过 zod 校验：${zodResult.error.issues
        .map((issue) => `${issue.path.join(".") || "(根)"} ${issue.message}`)
        .join("；")}`,
    );
  }

  const committedSchema = JSON.parse(readFileSync(schemaPath, "utf8")) as never;
  const result = z.fromJSONSchema(committedSchema).safeParse(parsed);
  if (result.success) {
    notes.push("通过提交版 schema 校验");
  } else {
    failures.push(
      `未通过 ${schemaPath} 校验：${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(根)"} ${issue.message}`)
        .join("；")}`,
    );
  }
}

for (const note of notes) {
  console.log(`ok   ${note}`);
}
for (const failure of failures) {
  console.error(`FAIL ${failure}`);
}

if (failures.length > 0) {
  process.exitCode = 1;
}
