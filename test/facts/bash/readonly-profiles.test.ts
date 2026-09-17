import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mergeLayers, type ResolvedConfig } from "../../../src/config/merge.ts";
import { extractFacts } from "../../../src/facts/extract.ts";
import { disposeBashParser, ensureBashParser } from "../../../src/facts/bash/parser.ts";
import type { FactsContext } from "../../../src/facts/types.ts";
import { evaluateCall } from "../../../src/policy/evaluate.ts";
import { compileRuleTable } from "../../../src/policy/rules.ts";
import { makeLayer, resolveConfig } from "../../support/resolved-config.ts";

/**
 * 只读免评审的端到端行为（FR-9、FR-65~FR-70）。
 *
 * 这些用例走**真实解析器 + 真实配置展开 + 真实求值器**，记录的是“我们承诺的行为”：
 * 每条命令的免评审资格、被取消的原因、路径归因与最终动作。行为变化必须显式改这个文件。
 *
 * 上下文固定为 linux + `/proj/app`，与 `test/fixtures/bash/corpus.json` 的做法一致：
 * 路径断言不应随开发机平台变化。
 */

const CWD = "/proj/app";
const HOME = "/home/u";
const GLOB = { home: HOME, platform: "linux" as NodeJS.Platform };

function contextFor(config: ResolvedConfig): FactsContext {
  return {
    cwd: CWD,
    platform: "linux",
    home: HOME,
    roots: [CWD],
    readOnlyCommands: config.workingDirectory.readOnlyCommands,
    readOnlyProfiles: config.readOnlyProfiles,
    writeSinks: config.writeSinks,
  };
}

interface Expectation {
  /** 期望的调用级动作。 */
  action: "allow" | "review" | "deny" | "ask";
  /** 每个命令单元的免评审状态与取消原因（顺序与 units 一致）。 */
  units: Array<{ readOnly: boolean; cancel?: string }>;
  /** 期望的路径目标（`方向:词法形`）。 */
  paths?: string[];
}

/** 默认配置（`search` + `vcs-read` 两个内置分组开启）。 */
const DEFAULTS: Array<[string, Expectation]> = [
  ['rg -n "readOnly" src/', { action: "allow", units: [{ readOnly: true }], paths: ["read:/proj/app/src"] }],
  ['rg -n "\\.env" src/', { action: "allow", units: [{ readOnly: true }], paths: ["read:/proj/app/src"] }],
  ["rg -n a f.txt", { action: "allow", units: [{ readOnly: true }], paths: ["read:/proj/app/f.txt"] }],
  ['rg "$PAT" src/', { action: "allow", units: [{ readOnly: true }], paths: ["read:/proj/app/src"] }],
  ["rg --files src", { action: "allow", units: [{ readOnly: true }] }],
  ["rg --glob='src/**/*.ts' -n x src", { action: "allow", units: [{ readOnly: true }], paths: ["read:/proj/app/src"] }],
  ["grep -rn readOnly src", { action: "allow", units: [{ readOnly: true }], paths: ["read:/proj/app/src"] }],
  ["find src -name '*.ts'", { action: "allow", units: [{ readOnly: true }] }],
  ["git status --short", { action: "allow", units: [{ readOnly: true }] }],
  ["git log --oneline -5", { action: "allow", units: [{ readOnly: true }] }],
  ["git diff -- src/x.ts", { action: "allow", units: [{ readOnly: true }], paths: ["read:/proj/app/src/x.ts"] }],
  ["git grep -n readOnly", { action: "allow", units: [{ readOnly: true }] }],
  ["git branch --show-current", { action: "allow", units: [{ readOnly: true }] }],
  // 空设备：写 `/dev/null` 不算写副作用（FR-67）。
  ["ls 2>/dev/null", { action: "allow", units: [{ readOnly: true }] }],
  ["cat f.txt 2>/dev/null", { action: "allow", units: [{ readOnly: true }], paths: ["read:/proj/app/f.txt"] }],
  ["git diff > /dev/null", { action: "allow", units: [{ readOnly: true }] }],
  ["cat < in.txt", { action: "allow", units: [{ readOnly: true }], paths: ["read:/proj/app/in.txt"] }],
  // 写真实文件仍然算写副作用，并说明取消原因（FR-69）。
  ["ls > out.txt", { action: "review", units: [{ readOnly: false, cancel: "redirect-write:/proj/app/out.txt" }], paths: ["write:/proj/app/out.txt"] }],
  // 项目里叫 `dev/null` 的文件不是空设备。
  // `echo` 已进 `print` 分组：它会命中档案，然后因“写真实文件”被取消免评审（原因可查）。
  ["echo x > src/dev/null", { action: "review", units: [{ readOnly: false, cancel: "redirect-write:/proj/app/src/dev/null" }], paths: ["write:/proj/app/src/dev/null"] }],
  // `echo` 的位置参数是**文本而不是文件**（`pattern` 角色），因此不会造出读路径。
  ["echo note.env", { action: "allow", units: [{ readOnly: true }], paths: [] }],
  ["printf '%s\\n' done", { action: "allow", units: [{ readOnly: true }] }],
  ["which node", { action: "allow", units: [{ readOnly: true }] }],
  ["command -v rg", { action: "allow", units: [{ readOnly: true }] }],
  ["date", { action: "allow", units: [{ readOnly: true }] }],
  ["date -s '2026-01-01'", { action: "review", units: [{ readOnly: false, cancel: "unsafe-option:-s" }] }],
  // 选项即程序（实测）：`--pre` 会 spawn 任意程序。
  ["rg --pre x -n a src", { action: "review", units: [{ readOnly: false, cancel: "unsafe-option:--pre" }] }],
  ["rg --$OPT x src", { action: "review", units: [{ readOnly: false, cancel: "option-not-allowed:--$OPT" }] }],
  // find 的危险选项不在 allow-list 里。
  ["find . -name '*.log' -delete", { action: "review", units: [{ readOnly: false, cancel: "option-not-allowed:-delete" }] }],
  // git 的执行 / 写文件类选项（git 级选项靠前缀匹配挡住，见 GROUP_PROFILES 的说明）。
  ["git -c core.fsmonitor=x status", { action: "review", units: [{ readOnly: false }] }],
  ["git -C src status", { action: "review", units: [{ readOnly: false }] }],
  ["git log --output at.txt", { action: "review", units: [{ readOnly: false, cancel: "unsafe-option:--output" }] }],
  ["git log --ext-diff", { action: "review", units: [{ readOnly: false, cancel: "unsafe-option:--ext-diff" }] }],
  ["git branch -D feature", { action: "review", units: [{ readOnly: false, cancel: "option-not-allowed:-D" }] }],
  ["git branch newbranch", { action: "review", units: [{ readOnly: false, cancel: "unexpected-arg:newbranch" }] }],
  // 子命令之后的 `-c` / `-C` / `-o` 实测都是合法无害选项，不能进黑名单：
  ["git log -c --oneline -1", { action: "allow", units: [{ readOnly: true }] }],
  ["git log -C --oneline -1", { action: "allow", units: [{ readOnly: true }] }],
  ["git ls-files -o", { action: "allow", units: [{ readOnly: true }] }],
  // 目录导航：进项目内目录免评审（FR-65 的 `nav` 分组 + `onlyWithinRoots`），出项目外不免。
  ["cd src && rg -n x", { action: "allow", units: [{ readOnly: true }, { readOnly: true }], paths: ["read:/proj/app/src"] }],
  ["cd src && git status", { action: "allow", units: [{ readOnly: true }, { readOnly: true }], paths: ["read:/proj/app/src"] }],
  ["cd . && rg -n x", { action: "allow", units: [{ readOnly: true }, { readOnly: true }] }],
  ["pushd src && rg -n x", { action: "allow", units: [{ readOnly: true }, { readOnly: true }], paths: ["read:/proj/app/src"] }],
  ["cd ..", { action: "review", units: [{ readOnly: false, cancel: "outside-roots" }] }],
  ["cd /tmp", { action: "review", units: [{ readOnly: false, cancel: "outside-roots" }] }],
  ["cd", { action: "review", units: [{ readOnly: false, cancel: "no-path-target" }] }],
  // 组合命令逐单元独立判断：cd 免评审不再拖累后半段，而真正需要评审的单元仍然生效。
  ["cd src && npm test", { action: "review", units: [{ readOnly: true }, { readOnly: false }], paths: ["read:/proj/app/src"] }],
  ["rg -n x && echo done", { action: "allow", units: [{ readOnly: true }, { readOnly: true }] }],
  ["rg -n x > /dev/null && git status", { action: "allow", units: [{ readOnly: true }, { readOnly: true }] }],
  // 未声明档案的命令保持旧行为（D29）：不因为“看起来只读”就免评审。
  ["sed -n 1,10p f.txt", { action: "review", units: [{ readOnly: false }] }],
  ["sort in.txt", { action: "review", units: [{ readOnly: false }] }],
  // 未声明档案的命令仍走默认矩阵（`meta` / `text-tools` 分组默认关闭）。
  ["node --version", { action: "review", units: [{ readOnly: false }] }],
  // 路径位置动态取值仍然降级（未声明的读目标必须交给 onUnresolvedFacts）。
  ['cat "$FILE"', { action: "review", units: [{ readOnly: false }], paths: ["read:$FILE"] }],
  // 旧白名单条目（字符串形态）语义不变。
  ["pwd", { action: "allow", units: [{ readOnly: true }] }],
  ["head -n 5 src/index.ts", { action: "allow", units: [{ readOnly: true }] }],
];

describe("只读免评审：默认配置（search + vcs-read）", () => {
  it.each(DEFAULTS)("%s", async (command, expected) => {
    const config = resolveConfig();
    const table = compileRuleTable(config, GLOB);
    const facts = await extractFacts("bash", { command }, contextFor(config));
    const call = evaluateCall({ facts, toolName: "bash", config, table });

    expect(call.action).toBe(expected.action);
    expect(
      facts.commands.map((unit) => ({
        readOnly: unit.readOnly,
        ...(unit.readOnlyCancel === undefined ? {} : { cancel: unit.readOnlyCancel }),
      })),
    ).toEqual(expected.units);
    if (expected.paths !== undefined) {
      expect(facts.paths.map((path) => `${path.direction}:${path.lexical}`)).toEqual(
        expected.paths,
      );
    }
  });
});

describe("cd 追踪：相对路径按 bash 作用域解析（FR-70）", () => {
  it("同一 shell 里 `cd src` 之后的相对路径落在 src 下", async () => {
    const config = resolveConfig();
    const facts = await extractFacts("bash", { command: "cd src && cat .env" }, contextFor(config));
    expect(facts.paths.map((path) => `${path.direction}:${path.lexical}`)).toEqual([
      "read:/proj/app/src",
      "read:/proj/app/src/.env",
    ]);
    // `cd src` 进项目内目录，命中 `nav` 档案 → 两个单元都免评审，整条命令 allow（见本文件的组合命令表）。
    expect(facts.commands.map((unit) => unit.readOnly)).toEqual([true, true]);
  });

  it("`cd` 出项目根、`cd -` 与 `popd` 仍不免评审", async () => {
    const config = resolveConfig();
    const cases = [
      ["cd ..", "outside-roots", false],
      ["cd /tmp", "outside-roots", false],
      ["cd ~", "outside-roots", false],
      ["cd", "no-path-target", false],
      ["cd -", undefined, true],
      ["popd", undefined, true],
      ["cd $DIR", "outside-roots", true],
    ] as const;

    for (const [command, cancel, unresolved] of cases) {
      const facts = await extractFacts("bash", { command }, contextFor(config));
      const unit = facts.commands[0];
      expect(unit?.readOnly, command).toBe(false);
      expect(unit?.readOnlyCancel, command).toBe(cancel);
      expect(unit?.unresolved === undefined, command).toBe(!unresolved);
    }
  });

  it("`pushd <项目内目录>` 与 `cd` 同待遇；无参数 `pushd` 的目标在栈顶，不可知", async () => {
    const config = resolveConfig();
    const pushdIn = await extractFacts("bash", { command: "pushd src" }, contextFor(config));
    expect(pushdIn.commands[0]?.readOnly).toBe(true);

    const bare = await extractFacts("bash", { command: "pushd" }, contextFor(config));
    expect(bare.commands[0]?.readOnly).toBe(false);
    expect(bare.commands[0]?.unresolved).toBe("dynamic-path");
  });

  it("子 shell 与管道各自独立：`(cd /tmp && rm x)` 只影响子 shell", async () => {
    const config = resolveConfig();
    const facts = await extractFacts("bash", { command: "(cd /tmp && rm x)" }, contextFor(config));
    expect(facts.paths.map((path) => `${path.direction}:${path.lexical}`)).toEqual([
      "read:/tmp",
      "write:/tmp/x",
    ]);
  });

  it("管道元素是独立进程：`cd /tmp | cat x` 不改变第二个元素的 cwd", async () => {
    const config = resolveConfig();
    const facts = await extractFacts("bash", { command: "cd /tmp | cat x" }, contextFor(config));
    expect(facts.paths.map((path) => `${path.direction}:${path.lexical}`)).toEqual([
      "read:/tmp",
      "read:/proj/app/x",
    ]);
  });

  it("`cd` 目标不可静态确定时，后续单元的相对路径降级为不可信", async () => {
    const config = resolveConfig();
    const facts = await extractFacts("bash", { command: "cd $DIR && cat x" }, contextFor(config));
    expect(facts.commands.map((unit) => unit.unresolved)).toEqual([
      "dynamic-path",
      "dynamic-path",
    ]);
    expect(facts.commands.every((unit) => unit.readOnly)).toBe(false);
  });
});

describe("自定义档案：角色、脚本白名单与全局选项黑名单", () => {
  const sedProfile = {
    argv: ["sed"],
    roles: ["script", "paths"],
    script: ["^[0-9]+(,[0-9]+)?p$"],
    optionPolicy: "allow-list",
    safeOptions: ["-n", "--quiet", "--silent", "--posix"],
    unsafeOptions: ["-i", "--in-place", "-e", "--expression", "-f", "--file"],
    reason: "只放行 sed -n 'N,Mp' <file>",
  };

  function sedConfig(extra: Record<string, unknown> = {}): ResolvedConfig {
    return mergeLayers([
      makeLayer("global", {
        workingDirectory: { readOnly: { commands: [sedProfile], ...extra } },
      }),
    ]);
  }

  const CASES: Array<[string, Expectation]> = [
    ["sed -n '1,10p' f.txt", { action: "allow", units: [{ readOnly: true }], paths: ["read:/proj/app/f.txt"] }],
    ["sed -n 'e echo X' f.txt", { action: "review", units: [{ readOnly: false, cancel: "script-not-allowed" }] }],
    ["sed -n '1w out.txt' f.txt", { action: "review", units: [{ readOnly: false, cancel: "script-not-allowed" }] }],
    ["sed -i 's/a/b/' f.txt", { action: "review", units: [{ readOnly: false, cancel: "unsafe-option:-i" }] }],
    ["sed -n -e '1,10p' f.txt", { action: "review", units: [{ readOnly: false, cancel: "unsafe-option:-e" }] }],
    ["sed --version", { action: "review", units: [{ readOnly: false, cancel: "option-not-allowed:--version" }] }],
    ['sed -n "$SCRIPT" f.txt', { action: "review", units: [{ readOnly: false, cancel: "dynamic-arg" }] }],
  ];

  it.each(CASES)("%s", async (command, expected) => {
    const config = sedConfig();
    const table = compileRuleTable(config, GLOB);
    const facts = await extractFacts("bash", { command }, contextFor(config));
    const call = evaluateCall({ facts, toolName: "bash", config, table });
    expect(call.action).toBe(expected.action);
    expect(
      facts.commands.map((unit) => ({
        readOnly: unit.readOnly,
        ...(unit.readOnlyCancel === undefined ? {} : { cancel: unit.readOnlyCancel }),
      })),
    ).toEqual(expected.units);
  });

  it("用户条目排在分组前面：更严的条目可以压住内置档案", async () => {
    const config = mergeLayers([
      makeLayer("global", {
        workingDirectory: {
          readOnly: { commands: [{ argv: ["rg"], roles: [], unsafeOptions: ["-n"] }] },
        },
      }),
    ]);
    const facts = await extractFacts("bash", { command: "rg -n a src" }, contextFor(config));
    expect(facts.commands[0]?.readOnlyCancel).toBe("unsafe-option:-n");
  });

  it("全局 unsafeOptions 对所有档案（含旧字符串条目）生效", async () => {
    const config = mergeLayers([
      makeLayer("global", {
        workingDirectory: { readOnly: { unsafeOptions: ["-i"] } },
      }),
    ]);
    const facts = await extractFacts("bash", { command: "ls -i" }, contextFor(config));
    expect(facts.commands[0]?.readOnly).toBe(false);
    expect(facts.commands[0]?.readOnlyCancel).toBe("unsafe-option:-i");
  });

  it("关掉全部分组后只剩旧字符串白名单", async () => {
    const config = mergeLayers([
      makeLayer("global", {
        workingDirectory: { readOnly: { profiles: [] } },
      }),
    ]);
    const facts = await extractFacts(
      "bash",
      { command: "rg -n a src" },
      contextFor(config),
    );
    expect(facts.commands[0]?.readOnly).toBe(false);
    expect(facts.commands[0]?.readOnlyCancel).toBeUndefined();
  });

  it("额外 sink 可声明（容器里的 /dev/fd/3 等）", async () => {
    const config = mergeLayers([
      makeLayer("global", {
        workingDirectory: { readOnly: { sinks: ["/dev/fd/3"] } },
      }),
    ]);
    const facts = await extractFacts("bash", { command: "ls > /dev/fd/3" }, contextFor(config));
    expect(facts.commands[0]?.readOnly).toBe(true);
    expect(facts.paths).toEqual([]);
  });
});

describe("只读免评审与用户规则的优先级（不变量：用户规则在免评审之前）", () => {
  it("用户为同一命令写了 deny 时，免评审不会把它放行", async () => {
    const config = resolveConfig({ global: { permission: { bash: { "rg *": "deny" } } } });
    const table = compileRuleTable(config, GLOB);
    const facts = await extractFacts("bash", { command: "rg -n a src" }, contextFor(config));
    const call = evaluateCall({ facts, toolName: "bash", config, table });
    expect(call.action).toBe("deny");
  });

  it("模式里的 `*.env` 不会因为被当成路径而误拦（FR-65）", async () => {
    const config = resolveConfig({ global: { permission: { path: { "*.env": "deny" } } } });
    const table = compileRuleTable(config, GLOB);
    const facts = await extractFacts("bash", { command: 'rg -n "\\.env" src' }, contextFor(config));
    const call = evaluateCall({ facts, toolName: "bash", config, table });
    expect(call.action).toBe("allow");
  });

  it("真正的读目标仍然受路径规则约束（`rg x .env`）", async () => {
    const config = resolveConfig({ global: { permission: { path: { "*.env": "deny" } } } });
    const table = compileRuleTable(config, GLOB);
    const facts = await extractFacts("bash", { command: "rg x .env" }, contextFor(config));
    const call = evaluateCall({ facts, toolName: "bash", config, table });
    expect(call.action).toBe("deny");
  });
});

// WASM 首次加载在并行 worker 里可能超过默认 5s hook 超时，显式放宽。
beforeAll(async () => {
  await ensureBashParser();
}, 30_000);

afterAll(() => {
  disposeBashParser();
});
