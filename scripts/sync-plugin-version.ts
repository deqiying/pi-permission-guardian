#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (version === undefined || version.length === 0) {
  throw new Error("usage: npm run sync:plugin-version -- <semver>");
}

const manifestPath = join(root, "pi-desktop", "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
  version?: unknown;
};
manifest.version = version;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
