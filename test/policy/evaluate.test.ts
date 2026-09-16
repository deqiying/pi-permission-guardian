import { describe, expect, it } from "vitest";

import type { CommandUnit, Facts, PathTarget } from "../../src/facts/types.ts";
import {
  buildPolicyObjects,
  evaluateCall,
  evaluateObject,
  SUBAGENT_FLOOR_REASON,
  type CallEvaluation,
  type PolicyObject,
} from "../../src/policy/evaluate.ts";
import { BASELINE_REASON } from "../../src/config/normalize.ts";
import { compileRuleTable } from "../../src/policy/rules.ts";
import type { Action } from "../../src/policy/action.ts";
import { resolveConfig, type ResolveOptions } from "../support/resolved-config.ts";

/**
 * 规则求值（FR-1~FR-10、FR-59、FR-61、FR-62）。
 *
 * 这些用例刻意**手写 facts**而不是解析真实命令：策略层是 facts 的纯函数，用真实解析器
 * 只会把 facts 层的回归绑进策略层测试。facts 的构造在 facts/*.test.ts 里覆盖。
 */

const GLOB = { home: "/home/u", platform: "linux" as NodeJS.Platform };

function unit(text: string, extra: Partial<CommandUnit> = {}): CommandUnit {
  return { text, paths: [], readOnly: false, ...extra };
}

function target(
  lexical: string,
  direction: PathTarget["direction"] = "write",
  extra: Partial<PathTarget> = {},
): PathTarget {
  return {
    raw: lexical,
    lexical,
    direction,
    source: "arg",
    external: false,
    ...extra,
  };
}

function commandFacts(
  toolName: string,
  units: CommandUnit[],
  compositeTexts?: string[],
): Facts {
  const facts: Facts = {
    surfaces: [toolName],
    commands: units,
    paths: units.flatMap((entry) => entry.paths),
  };
  if (compositeTexts !== undefined) {
    facts.compositeTexts = compositeTexts;
  }
  return facts;
}

function toolFacts(toolName: string, paths: PathTarget[] = []): Facts {
  return { surfaces: [toolName], commands: [], paths };
}

function evaluate(
  toolName: string,
  facts: Facts,
  options: ResolveOptions = {},
  defaultActionFloor?: Action,
): { call: CallEvaluation } {
  const config = resolveConfig(options);
  return {
    call: evaluateCall({
      facts,
      toolName,
      config,
      table: compileRuleTable(config, GLOB),
      ...(defaultActionFloor === undefined ? {} : { defaultActionFloor }),
    }),
  };
}

describe("被裁决对象构造（architecture §6.2）", () => {
  it("bash 以命令单元为对象，不再额外补工具对象", () => {
    const objects = buildPolicyObjects(commandFacts("bash", [unit("echo ok")]), "bash");

    expect(objects.map((object) => object.kind)).toEqual(["command"]);
    expect(objects[0]?.surfaces).toEqual(["bash"]);
  });

  it("路径类工具补工具对象，并为每个路径建方向对象", () => {
    const objects = buildPolicyObjects(
      toolFacts("read", [target("/repo/a.env", "read")]),
      "read",
    );

    expect(objects.map((object) => object.kind)).toEqual(["tool", "path"]);
    expect(objects[1]?.surfaces).toEqual(["path_read"]);
  });

  it("外部路径追加外部目录面", () => {
    const objects = buildPolicyObjects(
      toolFacts("read", [target("/etc/passwd", "read", { external: true })]),
      "read",
    );

    expect(objects[1]?.surfaces).toEqual(["path_read", "external_directory_read"]);
  });

  it("未识别工具的 surface 追加 `tool` 哨兵，同时保留工具名本身（FR-2）", () => {
    const objects = buildPolicyObjects(toolFacts("mcp__x__y"), "mcp__x__y");

    expect(objects[0]?.surfaces).toEqual(["mcp__x__y", "tool"]);
  });
});

describe("规则求值（FR-1~FR-10）", () => {
  it("四种动作都能从规则得出（FR-1）", () => {
    const cases = [
      ["cmd allow", "allow"],
      ["cmd deny", "deny"],
      ["cmd ask", "ask"],
      ["cmd review", "review"],
    ] as const;

    for (const [command, action] of cases) {
      const { call } = evaluate("bash", commandFacts("bash", [unit(command)]), {
        global: {
          permission: {
            bash: {
              "cmd allow": "allow",
              "cmd deny": "deny",
              "cmd ask": "ask",
              "cmd review": "review",
            },
          },
        },
      });
      expect([command, call.action]).toEqual([command, action]);
    }
  });

  it("未命中规则时按 surface 默认矩阵裁决（FR-7/FR-8）", () => {
    expect(
      evaluate("read", toolFacts("read", [target("/repo/a.txt", "read")])).call.action,
    ).toBe("allow");
    expect(evaluate("write", toolFacts("write", [target("/repo/a.txt")])).call.action).toBe(
      "review",
    );
    expect(evaluate("bash", commandFacts("bash", [unit("echo ok")])).call.action).toBe(
      "review",
    );
    expect(
      evaluate(
        "powershell",
        commandFacts("powershell", [
          unit("Get-ChildItem", { unresolved: "unparsed-language", viaWrapper: "opaque" }),
        ]),
      ).call.action,
    ).toBe("review");
    expect(evaluate("mcp__x__y", toolFacts("mcp__x__y")).call.action).toBe("review");
  });

  it("按工具名写规则，未写规则的自定义工具落到 `tool` 哨兵（FR-2）", () => {
    expect(
      evaluate("read", toolFacts("read"), { global: { permission: { read: "deny" } } }).call
        .action,
    ).toBe("deny");
    expect(
      evaluate("mcp__x__y", toolFacts("mcp__x__y"), {
        global: { permission: { mcp__x__y: "allow" } },
      }).call.action,
    ).toBe("allow");
  });

  it("`permission[\"*\"]` 一旦设置就覆盖默认矩阵（FR-8、§6.4）", () => {
    expect(
      evaluate("read", toolFacts("read"), { global: { permission: { "*": "review" } } }).call
        .action,
    ).toBe("review");
    expect(
      evaluate("mcp__x__y", toolFacts("mcp__x__y"), {
        global: { permission: { "*": "deny" } },
      }).call.action,
    ).toBe("deny");
  });

  it("配置失效时 baseline 把 allow 收紧为 review（FR-51）", () => {
    const { call } = evaluate("read", toolFacts("read"), {
      global: {},
      globalStatus: "degraded",
    });

    expect(call.action).toBe("review");
    expect(call.decisive?.source).toBe("baseline");
  });

  it("同层 last-match-wins：后写的具体规则覆盖先写的宽泛规则（FR-5）", () => {
    const { call } = evaluate("bash", commandFacts("bash", [unit("rm -rf ./dist")]), {
      global: { permission: { bash: { "rm *": "review", "rm -rf ./dist": "allow" } } },
    });

    expect(call.action).toBe("allow");
    expect(call.decisive?.matchedPattern).toBe("rm -rf ./dist");
  });

  it("跨层最严格者胜：项目层不能放宽全局层（FR-6）", () => {
    const { call } = evaluate("bash", commandFacts("bash", [unit("rm -rf x")]), {
      global: { permission: { bash: { "rm *": "deny" } } },
      project: { permission: { bash: { "*": "allow" } } },
    });

    expect(call.action).toBe("deny");
  });

  it("baseline 兜底不得压过用户显式写的 allow（M3 门禁）", () => {
    const { call } = evaluate("bash", commandFacts("bash", [unit("rm -rf ./dist")]), {
      global: { permission: { bash: { "rm -rf ./dist": "allow" } } },
    });

    expect(call.action).toBe("allow");
    expect(call.decisive?.source).toBe("rule");
  });

  it("规则 reason 保留在决定性对象上（FR-10）", () => {
    const { call } = evaluate("bash", commandFacts("bash", [unit("rm -rf /")]), {
      global: {
        permission: {
          bash: { "rm -rf /": { action: "deny", reason: "删除需人工确认" } },
        },
      },
    });

    expect(call.decisive?.action).toBe("deny");
    expect(call.decisive?.reason).toBe("删除需人工确认");
  });

  it("只读白名单命中的命令单元免评审放行（FR-9）", () => {
    const { call } = evaluate(
      "bash",
      commandFacts("bash", [unit("git status --short", { readOnly: true })]),
    );

    expect(call.action).toBe("allow");
    expect(call.decisive?.source).toBe("read-only");
  });

  it("用户显式规则优先于只读白名单", () => {
    const { call } = evaluate(
      "bash",
      commandFacts("bash", [unit("git diff --output out.txt", { readOnly: true })]),
      { global: { permission: { bash: { "git diff --output*": "review" } } } },
    );

    expect(call.action).toBe("review");
    expect(call.decisive?.source).toBe("rule");
  });
});

describe("路径面求值（FR-3/FR-16/FR-17）", () => {
  it("path 语法糖在求值里按方向生效，读写独立", () => {
    const writeSide = evaluate("write", toolFacts("write", [target("/repo/x.pem", "write")]), {
      global: { permission: { path: { "*.pem": "deny" } } },
    });
    expect(writeSide.call.action).toBe("deny");

    const readSide = evaluate("read", toolFacts("read", [target("/repo/x.pem", "read")]), {
      global: { permission: { path_write: { "*.pem": "deny" } } },
    });
    expect(readSide.call.action).toBe("allow");
  });

  it("`read ./.env` 由工具面与路径面各自投票，取最严格者", () => {
    const { call } = evaluate("read", toolFacts("read", [target("/repo/.env", "read")]), {
      global: { permission: { path: { "*.env": "deny" } } },
    });

    expect(call.action).toBe("deny");
    expect(call.evaluations.find((entry) => entry.object.kind === "tool")?.action).toBe(
      "allow",
    );
  });

  it("路径对象按词法形与真实形双形匹配（FR-16）", () => {
    const { call } = evaluate(
      "read",
      toolFacts("read", [
        target("/repo/link/secret.key", "read", { canonical: "/real/secret.key" }),
      ]),
      { global: { permission: { path: { "*/secret.key": "deny" } } } },
    );

    expect(call.action).toBe("deny");
  });

  it("external_directory 只对允许根目录之外的目标参与求值", () => {
    const options = {
      global: { permission: { external_directory: { "*": "deny" } } },
    } as const;

    expect(
      evaluate("read", toolFacts("read", [target("/repo/a.txt", "read")]), options).call
        .action,
    ).toBe("allow");
    expect(
      evaluate(
        "read",
        toolFacts("read", [target("/etc/passwd", "read", { external: true })]),
        options,
      ).call.action,
    ).toBe("deny");
  });
});

describe("调用级合成（FR-59/FR-61/FR-62）", () => {
  it("命令类规则同时匹配命令单元文本与调用级文本（FR-62）", () => {
    const rule = { global: { permission: { bash: { "curl * | sh": "ask" } } } };

    const withComposite = evaluate(
      "bash",
      commandFacts("bash", [unit("curl http://x"), unit("sh")], ["curl http://x | sh"]),
      rule,
    );
    expect(withComposite.call.action).toBe("ask");

    // 只有单元文本时命不中：这正是 FR-62 要求"两者缺一不可"的原因。
    const unitsOnly = evaluate(
      "bash",
      commandFacts("bash", [unit("curl http://x"), unit("sh")]),
      rule,
    );
    expect(unitsOnly.call.action).toBe("review");
  });

  it("`echo ok && rm -rf /` 的 allow 不能掩盖 deny（FR-59 默认 deny）", () => {
    const facts = commandFacts("bash", [unit("echo ok"), unit("rm -rf /")]);
    const config = {
      global: { permission: { bash: { "echo *": "allow", "rm -rf /": "deny" } } },
    };

    const { call } = evaluate("bash", facts, config);
    expect(call.cause).toBe("mixed");
    expect(call.action).toBe("deny");

    expect(
      evaluate("bash", facts, {
        global: { ...config.global, onMixedCommandActions: "ask" },
      }).call.action,
    ).toBe("ask");
    expect(
      evaluate("bash", facts, {
        global: { ...config.global, onMixedCommandActions: "review" },
      }).call.action,
    ).toBe("review");
  });

  it("`deny + review` 不含 allow，不触发混合命令策略（FR-59）", () => {
    const { call } = evaluate(
      "bash",
      commandFacts("bash", [unit("cat x"), unit("rm -rf /")]),
      {
        global: {
          permission: { bash: { "cat *": "review", "rm -rf /": "deny" } },
          onMixedCommandActions: "ask",
        },
      },
    );

    expect(call.cause).toBe("objects");
    expect(call.action).toBe("deny");
  });

  it("unresolved + 可信 deny 固定为 ask，不被 onUnresolvedFacts 放宽（FR-61）", () => {
    const facts = commandFacts("bash", [
      unit("rm -rf /"),
      unit("bash -c hidden", { unresolved: "opaque-wrapper", viaWrapper: "opaque" }),
    ]);

    const { call } = evaluate("bash", facts, {
      global: {
        permission: { bash: { "rm -rf /": "deny" } },
        onUnresolvedFacts: "allow",
      },
    });

    expect(call.cause).toBe("unresolved-deny");
    expect(call.action).toBe("ask");
  });

  it("unresolved 且没有 deny 时走 onUnresolvedFacts（FR-61）", () => {
    const facts = commandFacts("bash", [
      unit("bash -c hidden", { unresolved: "opaque-wrapper", viaWrapper: "opaque" }),
    ]);

    const defaulted = evaluate("bash", facts);
    expect(defaulted.call.cause).toBe("unresolved");
    expect(defaulted.call.action).toBe("review");

    const explicitlyAllowed = evaluate("bash", facts, {
      global: { onUnresolvedFacts: "allow" },
    });
    expect(explicitlyAllowed.call.action).toBe("allow");
  });

  it("只有不可信对象 deny 时仍取最严格者，不进入 FR-61 的 ask", () => {
    const { call } = evaluate(
      "bash",
      commandFacts("bash", [unit("rm -rf /", { unresolved: "indirection-wrapper" })]),
      { global: { permission: { bash: { "rm -rf /": "deny" } } } },
    );

    expect(call.cause).toBe("objects");
    expect(call.action).toBe("deny");
  });

  it("不可信对象上的显式规则优先于 onUnresolvedFacts（PowerShell 恒为 unresolved）", () => {
    const facts = commandFacts("powershell", [
      unit("Remove-Item x", { unresolved: "unparsed-language", viaWrapper: "opaque" }),
    ]);

    // 显式 ask 不得被默认的 onUnresolvedFacts=review 放宽
    expect(
      evaluate("powershell", facts, { global: { permission: { powershell: "ask" } } }).call
        .action,
    ).toBe("ask");
    // 反过来，onUnresolvedFacts=allow 也不得推翻显式 review
    expect(
      evaluate("powershell", facts, {
        global: { permission: { powershell: "review" }, onUnresolvedFacts: "allow" },
      }).call.action,
    ).toBe("review");
  });

  it("onUnresolvedFacts 不会放宽同调用里已解析对象的结果", () => {
    const facts = commandFacts("bash", [
      unit("echo ok"),
      unit("bash -c hidden", { unresolved: "opaque-wrapper", viaWrapper: "opaque" }),
    ]);

    // `echo ok` 未命中规则 → 默认矩阵 review；不可信单元 → allow；最严格者仍是 review。
    const { call } = evaluate("bash", facts, {
      global: { onUnresolvedFacts: "allow" },
    });
    expect(call.action).toBe("review");
  });

  it("没有任何对象表态时按放行处理（空命令）", () => {
    const { call } = evaluate("bash", commandFacts("bash", []));

    expect(call.cause).toBe("objects");
    expect(call.action).toBe("allow");
    expect(call.decisive).toBeUndefined();
  });
});

describe("子代理默认动作下限（FR-56）", () => {
  it("把默认动作矩阵抬到 subagentPolicy.defaultAction（baseline allow → review）", () => {
    const { call } = evaluate(
      "read",
      toolFacts("read", [target("/repo/a.txt", "read")]),
      {},
      "review",
    );

    expect(call.action).toBe("review");
    expect(call.decisive?.source).toBe("baseline");
    expect(call.decisive?.reason).toContain(SUBAGENT_FLOOR_REASON);
    // 命中的仍是默认矩阵那条规则，只是动作被抬升。
    expect(call.decisive?.matchedLayer).toBe("baseline");
    expect(call.decisive?.matchedPattern).toBe("*");
  });

  it("下限只能收紧：不同取值都按最严格者生效", () => {
    const facts = toolFacts("read");
    expect(evaluate("read", facts, {}, "ask").call.action).toBe("ask");
    expect(evaluate("read", facts, {}, "deny").call.action).toBe("deny");
  });

  it("baseline 本来就达到下限时不改写理由", () => {
    const { call } = evaluate("write", toolFacts("write"), {}, "review");

    expect(call.action).toBe("review");
    expect(call.decisive?.reason).toBe(BASELINE_REASON);
    expect(call.decisive?.reason).not.toContain(SUBAGENT_FLOOR_REASON);
  });

  it("用户显式规则不受下限影响（既不放宽也不覆盖）", () => {
    const allowed = evaluate(
      "read",
      toolFacts("read"),
      { global: { permission: { read: "allow" } } },
      "deny",
    );
    expect(allowed.call.action).toBe("allow");
    expect(allowed.call.decisive?.source).toBe("rule");

    const denied = evaluate(
      "bash",
      commandFacts("bash", [unit("rm -rf /")]),
      { global: { permission: { bash: { "rm -rf /": "deny" } } } },
      "review",
    );
    expect(denied.call.action).toBe("deny");
    expect(denied.call.decisive?.source).toBe("rule");
  });

  it("只读白名单与失败分支不属于默认动作，不受下限影响（已文档化的边界）", () => {
    const readOnly = evaluate(
      "bash",
      commandFacts("bash", [unit("ls -la", { readOnly: true })]),
      {},
      "deny",
    );
    expect(readOnly.call.action).toBe("allow");
    expect(readOnly.call.decisive?.source).toBe("read-only");

    const unresolved = evaluate(
      "bash",
      commandFacts("bash", [unit("bash -c hidden", { unresolved: "opaque-wrapper" })]),
      { global: { onUnresolvedFacts: "allow" } },
      "deny",
    );
    expect(unresolved.call.action).toBe("allow");
    expect(unresolved.call.decisive?.source).toBe("unresolved");
  });

  it("path_read / path_write 仍然不表态，不因下限变成投票面", () => {
    const config = resolveConfig({});
    const objects = buildPolicyObjects(toolFacts("read", [target("/repo/a.txt", "read")]), "read");
    const table = compileRuleTable(config, GLOB);
    const path = objects.find((object) => object.kind === "path") as PolicyObject;

    const evaluation = evaluateObject(path, table, "review", "deny");
    expect(evaluation.action).toBeUndefined();
  });
});
