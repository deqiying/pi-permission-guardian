#!/usr/bin/env node
// 从 zod 唯一真源重新生成 schemas/guardian.schema.json（FR-57）。
// 用法：npm run gen:schema。不要手工编辑生成的 JSON —— test/config/schema.test.ts
// 会比对提交版与生成结果，一旦漂移即失败。

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildGuardianJsonSchema } from "../src/config/schema.ts";

const outputPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "schemas",
  "guardian.schema.json",
);

const json = `${JSON.stringify(buildGuardianJsonSchema(), null, 2)}\n`;
writeFileSync(outputPath, json, "utf8");
console.log(`Wrote ${outputPath}`);
