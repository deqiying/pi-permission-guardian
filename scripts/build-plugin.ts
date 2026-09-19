#!/usr/bin/env node

import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = join(root, "package.json");
const manifestPath = join(root, "pi-desktop", "manifest.json");
const sourceMainPath = join(root, "pi-desktop", "main.js");
const outputPath = join(root, "dist", "pi-desktop");
const extensionOutputPath = join(outputPath, "extensions", "guardian.js");
const assetsOutputPath = join(outputPath, "extensions", "assets");
const require = createRequire(import.meta.url);

const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
  name?: unknown;
  version?: unknown;
};
const sourceManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  main?: unknown;
  contributes?: { agentExtensions?: unknown };
};

const version = packageJson.version;
if (typeof version !== "string" || !version) {
  throw new Error("package.json.version must be a non-empty string");
}
if (packageJson.name !== "pi-permission-guardian") {
  throw new Error(`unexpected package name: ${String(packageJson.name)}`);
}
if (sourceManifest.id !== "deqiying.pi-permission-guardian") {
  throw new Error(`unexpected PI-Desktop plugin id: ${String(sourceManifest.id)}`);
}
if (sourceManifest.name !== "pi-permission-guardian") {
  throw new Error(`unexpected PI-Desktop plugin name: ${String(sourceManifest.name)}`);
}
if (sourceManifest.version !== version) {
  throw new Error(
    `pi-desktop/manifest.json version ${String(sourceManifest.version)} does not match package.json version ${version}`,
  );
}
if (sourceManifest.main !== "main.js") {
  throw new Error(`PI-Desktop manifest main must be main.js, got ${String(sourceManifest.main)}`);
}
if (
  !Array.isArray(sourceManifest.contributes?.agentExtensions) ||
  sourceManifest.contributes.agentExtensions.length !== 1 ||
  sourceManifest.contributes.agentExtensions[0] !== "extensions/guardian.js"
) {
  throw new Error("PI-Desktop manifest must contribute extensions/guardian.js");
}

await rm(outputPath, { recursive: true, force: true });
await mkdir(assetsOutputPath, { recursive: true });

const manifest = {
  ...sourceManifest,
  version,
};
await writeFile(join(outputPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await copyFile(sourceMainPath, join(outputPath, "main.js"));

await build({
  entryPoints: [join(root, "extensions", "guardian.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  outfile: extensionOutputPath,
  logLevel: "info",
  // PI-Desktop supplies kernel modules through the agent sidecar's virtual
  // module table. Only the read-only tool implementation is bundled from the
  // coding-agent package; importing its root would pull terminal UI modules.
  plugins: [
    {
      name: "pi-coding-agent-read-only-tools",
      setup(buildContext) {
        buildContext.onResolve(
          { filter: /^@earendil-works\/pi-coding-agent$/ },
          () => ({
            path: join(
              root,
              "node_modules",
              "@earendil-works",
              "pi-coding-agent",
              "dist",
              "core",
              "tools",
              "index.js",
            ),
          }),
        );
      },
    },
  ],
  external: [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-tui",
    "typebox",
    "typebox/*",
  ],
  banner: {
    js: "import { createRequire as __piCreateRequire } from 'node:module'; const __piRequire = __piCreateRequire(import.meta.url);",
  },
});

const assets = [
  ["web-tree-sitter/web-tree-sitter.wasm", "web-tree-sitter.wasm"],
  ["tree-sitter-bash/tree-sitter-bash.wasm", "tree-sitter-bash.wasm"],
] as const;
for (const [specifier, fileName] of assets) {
  const source = require.resolve(specifier) as string;
  await copyFile(source, join(assetsOutputPath, fileName));
}

console.log(`Prepared PI-Desktop plugin staging directory: ${outputPath}`);
console.log(`Version: ${version}`);
