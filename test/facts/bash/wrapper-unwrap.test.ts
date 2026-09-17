import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ResolvedConfig } from "../../../src/config/merge.ts";
import { disposeBashParser, ensureBashParser } from "../../../src/facts/bash/parser.ts";
import { extractFacts } from "../../../src/facts/extract.ts";
import type { CommandUnit, Facts } from "../../../src/facts/types.ts";
import { evaluateCall } from "../../../src/policy/evaluate.ts";
import { compileRuleTable } from "../../../src/policy/rules.ts";
import { resolveConfig } from "../../support/resolved-config.ts";

/**
 * 透明前缀内推（FR-12 修订，D33）。
 *
 * `timeout` / `nice` / `env` / `command` 这类前缀的规则固定、不改变后面的命令，因此知道怎么
 * 跳过自己的参数后就可以内推判定：`timeout 5 cat f` 与 `cat f` 同样免评审。
 * `sudo` / `xargs` / `bash -c` 仍是不透明的（换身份、拼新命令、代码文本）。
 *
 * 这些用例走真实解析器 + 真实配置：内推是事实层的行为，不能只在 argv 单测里验。
 */

const CWD = "/proj/app";
const GLOB = { home: "/home/u", platform: "linux" as NodeJS.Platform };

function contextFor(config: ResolvedConfig) {
  return {
    cwd: CWD,
    platform: "linux" as NodeJS.Platform,
    home: "/home/u",
    roots: [CWD],
    readOnlyCommands: config.workingDirectory.readOnlyCommands,
    readOnlyProfiles: config.readOnlyProfiles,
    writeSinks: config.writeSinks,
  };
}

async function factsFor(command: string, config: ResolvedConfig): Promise<Facts> {
  return extractFacts("bash", { command }, contextFor(config));
}

function actionFor(facts: Facts, config: ResolvedConfig) {
  return evaluateCall({
    facts,
    toolName: "bash",
    config,
    table: compileRuleTable(config, GLOB),
  }).action;
}

describe("透明前缀内推：内层命令的只读资格", () => {
  it("内层命令决定免评审：`timeout` / `nice` / `env` / `command` / `time` / `nohup` / `stdbuf`", async () => {
    const config = resolveConfig();
    const cases: Array<[string, string]> = [
      ["timeout 5 cat f.txt", "cat f.txt"],
      ["timeout 30 rg -n x src", "rg -n x src"],
      ["timeout -s KILL 5 cat f.txt", "cat f.txt"],
      ["timeout --signal=KILL 5s cat f.txt", "cat f.txt"],
      ["timeout -k 1 -s KILL 5 cat f.txt", "cat f.txt"],
      ["nice -n 5 cat f.txt", "cat f.txt"],
      ["env FOO=1 rg -n x src", "rg -n x src"],
      ["command cat f.txt", "cat f.txt"],
      ["time cat f.txt", "cat f.txt"],
      ["nohup cat f.txt", "cat f.txt"],
      ["stdbuf -o0 cat f.txt", "cat f.txt"],
      ["timeout 5 cat f.txt > /dev/null", "cat f.txt"],
    ];

    for (const [command, inner] of cases) {
      const facts = await factsFor(command, config);
      const unit = facts.commands[0] as CommandUnit;
      expect(unit.unwrappedText, command).toBe(inner);
      expect(unit.viaWrapper, command).toBeUndefined();
      expect(unit.unresolved, command).toBeUndefined();
      expect(unit.readOnly, command).toBe(true);
      expect(actionFor(facts, config), command).toBe("allow");
    }
  });

  it("前缀自己的参数不成为路径目标（`env FOO=1`、`timeout 5`）", async () => {
    const config = resolveConfig();
    const facts = await factsFor("env FOO=1 timeout 5 cat f.txt", config);
    expect(facts.paths.map((path) => `${path.direction}:${path.lexical}`)).toEqual([
      "read:/proj/app/f.txt",
    ]);
  });

  it("`command -v` / `-V` 是查询：不内推、不执行参数", async () => {
    const config = resolveConfig();
    for (const command of ["command -v rg", "command -V rg", "command -p -v rg"]) {
      const facts = await factsFor(command, config);
      const unit = facts.commands[0] as CommandUnit;
      expect(unit.unwrappedText, command).toBeUndefined();
      expect(unit.unresolved, command).toBeUndefined();
      expect(unit.readOnly, command).toBe(true);
      expect(actionFor(facts, config), command).toBe("allow");
    }
  });

  it("内推后仍是外部/写目标时照常降级", async () => {
    const config = resolveConfig();
    const facts = await factsFor("timeout 5 cat /etc/hosts", config);
    const unit = facts.commands[0] as CommandUnit;
    expect(unit.readOnly).toBe(true);
    // 命令对象免评审，但路径对象独立投票：外部目录读仍走 `external_directory_read`。
    expect(facts.paths.map((path) => `${path.direction}:${path.external}`)).toEqual([
      "read:true",
    ]);
    expect(actionFor(facts, config)).toBe("review");
  });
});

describe("透明前缀内推：不透明的仍然不透明（FR-12 的边界）", () => {
  it("`sudo` / `xargs` / `bash -c` / 动态内层命令一律不内推", async () => {
    const config = resolveConfig();
    const cases: Array<[string, string]> = [
      ["sudo cat f.txt", "indirection-wrapper"],
      ["xargs rm", "indirection-wrapper"],
      ["bash -c 'cat f.txt'", "opaque-wrapper"],
      ["sh -c 'rm x'", "opaque-wrapper"],
      ["timeout 5 $CMD f.txt", "indirection-wrapper"],
      ["timeout 5", "indirection-wrapper"],
    ];

    for (const [command, cause] of cases) {
      const facts = await factsFor(command, config);
      const unit = facts.commands[0] as CommandUnit;
      expect(unit.unwrappedText, command).toBeUndefined();
      expect(unit.unresolved, command).toBe(cause);
      expect(unit.viaWrapper, command).toBe(cause === "opaque-wrapper" ? "opaque" : "indirection");
      expect(unit.readOnly, command).toBe(false);
      expect(actionFor(facts, config), command).toBe("review");
    }
  });

  it("`timeout 5 sudo rm -rf /tmp/x` 只内推一层，里面仍是包装器", async () => {
    const config = resolveConfig();
    const facts = await factsFor("timeout 5 sudo rm -rf /tmp/x", config);
    const unit = facts.commands[0] as CommandUnit;
    expect(unit.unwrappedText).toBe("sudo rm -rf /tmp/x");
    expect(unit.readOnly).toBe(false);
  });
});

describe("透明前缀内推：规则匹配面", () => {
  it("外层文本仍然能命中规则（`timeout *`）", async () => {
    const config = resolveConfig({ global: { permission: { bash: { "timeout *": "deny" } } } });
    const facts = await factsFor("timeout 5 cat f.txt", config);
    expect(actionFor(facts, config)).toBe("deny");
  });

  it("内层命令文本也参与规则匹配（`rm -rf ./dist*` 不再被包装器绕过）", async () => {
    const config = resolveConfig({
      global: { permission: { bash: { "rm -rf ./dist*": "deny" } } },
    });

    const facts = await factsFor("timeout 30 rm -rf ./dist", config);
    expect(actionFor(facts, config)).toBe("deny");

    // 没有规则时同一个调用只是默认矩阵的 review：说明 deny 确实来自“内层文本”这条规则。
    const plain = resolveConfig();
    const factsPlain = await factsFor("timeout 30 rm -rf ./dist", plain);
    expect(actionFor(factsPlain, plain)).toBe("review");
    expect(factsPlain.paths.map((path) => `${path.direction}:${path.lexical}`)).toEqual([
      "write:/proj/app/dist",
    ]);
  });
});

// WASM 首次加载在并行 worker 里可能超过默认 5s hook 超时，显式放宽。
beforeAll(async () => {
  await ensureBashParser();
}, 30_000);

afterAll(() => {
  disposeBashParser();
});
