import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load.ts";
import {
  createWorkspace,
  type TempWorkspace,
  writeGlobalConfig,
  writeProjectConfig,
} from "../support/tmp.ts";

const REFERENCE_CONFIG = JSON.stringify({
  enabled: true,
  gate: "side-effect",
  reviewer: { model: "deepseek/deepseek-flash" },
  permission: {
    read: "allow",
    path: { "*.env": "deny" },
    bash: { "rm *": "review", "rm -rf /*": "deny" },
  },
});

let workspace: TempWorkspace | undefined;

afterEach(() => {
  workspace?.cleanup();
  workspace = undefined;
});

function newWorkspace(): TempWorkspace {
  workspace = createWorkspace();
  return workspace;
}

function load(ws: TempWorkspace, projectTrusted = false) {
  return loadConfig({ cwd: ws.cwd, agentDir: ws.agentDir, projectTrusted });
}

describe("配置加载与合并（FR-47/48/51/52）", () => {
  it("两层都不存在时使用默认值，且不报错（不写盘）", () => {
    const ws = newWorkspace();

    const config = load(ws);

    expect(config.layers.global.status).toBe("missing");
    expect(config.layers.global.detail).toBe("配置文件不存在，使用默认值");
    expect(config.layers.project.status).toBe("skipped");
    expect(config.enabled).toBe(true);
    expect(config.ruleCount).toBe(0);
    expect(config.degraded).toBe(false);
    expect(config.rules).toEqual([]);
  });

  it("全局层加载参考配置：规则展开、顺序与层来源正确", () => {
    const ws = newWorkspace();
    writeGlobalConfig(ws, REFERENCE_CONFIG);

    const config = load(ws);

    expect(config.layers.global.status).toBe("loaded");
    expect(config.degraded).toBe(false);
    expect(config.rules.map((layer) => layer.layer)).toEqual(["global"]);
    expect(config.ruleCount).toBe(2 + 1 + 2); // path 展开到读写两向 + read + bash 两条

    const surfaces = config.rules[0]?.surfaces;
    expect([...(surfaces?.get("path_read") ?? [])].map((rule) => rule.pattern)).toEqual([
      "*.env",
    ]);
    expect([...(surfaces?.get("path_write") ?? [])].map((rule) => rule.pattern)).toEqual([
      "*.env",
    ]);
  });

  it("项目未受信任：即使项目配置存在也不加载，并给出原因", () => {
    const ws = newWorkspace();
    writeGlobalConfig(ws, REFERENCE_CONFIG);
    writeProjectConfig(ws, JSON.stringify({ enabled: false }));

    const config = load(ws, false);

    expect(config.layers.project.status).toBe("skipped");
    expect(config.layers.project.detail).toBe("项目未受信任，项目层未加载（FR-48）");
    expect(config.layers.project.diagnostics).toHaveLength(1);
    expect(config.layers.project.diagnostics[0]?.message).toContain(
      "项目未受信任",
    );
    expect(config.rules.map((layer) => layer.layer)).toEqual(["global"]);
    expect(config.enabled).toBe(true);
  });

  it("未受信任但不存在项目配置时不产生诊断噪声", () => {
    const ws = newWorkspace();

    expect(load(ws, false).layers.project.diagnostics).toEqual([]);
  });

  it("项目受信任：两层都参与合并，规则按 global → project 排列", () => {
    const ws = newWorkspace();
    writeGlobalConfig(ws, REFERENCE_CONFIG);
    writeProjectConfig(
      ws,
      JSON.stringify({ permission: { bash: { "rm -rf ./dist": "allow" } } }),
    );

    const config = load(ws, true);

    expect(config.rules.map((layer) => layer.layer)).toEqual([
      "global",
      "project",
    ]);
    expect(config.ruleCount).toBe(5 + 1);
  });

  it("显式设置的标量由项目层覆盖，未设置的字段保留全局层取值", () => {
    const ws = newWorkspace();
    writeGlobalConfig(ws, JSON.stringify({ gate: "all", debugLog: true }));
    writeProjectConfig(ws, JSON.stringify({ debugLog: false }));

    const config = load(ws, true);

    expect(config.debugLog).toBe(false);
    expect(config.gate).toBe("all");
  });

  it("数组字段整体覆盖：项目层的 readOnlyCommands 完整替换默认集", () => {
    const ws = newWorkspace();
    writeGlobalConfig(ws, REFERENCE_CONFIG);
    writeProjectConfig(
      ws,
      JSON.stringify({ workingDirectory: { readOnlyCommands: ["git status"] } }),
    );

    expect(load(ws, true).workingDirectory.readOnlyCommands).toEqual([
      "git status",
    ]);
  });

  it("onMixedCommandActions：基线 = 全局层显式取值，全局层未写则为 deny", () => {
    const absent = newWorkspace();
    writeGlobalConfig(absent, REFERENCE_CONFIG);
    expect(load(absent, false).onMixedCommandActions).toBe("deny");

    workspace?.cleanup();
    const relaxed = newWorkspace();
    writeGlobalConfig(relaxed, JSON.stringify({ onMixedCommandActions: "review" }));
    expect(load(relaxed, false).onMixedCommandActions).toBe("review");

    // 基线仍参与比较：项目层只能收紧
    writeProjectConfig(relaxed, JSON.stringify({ onMixedCommandActions: "ask" }));
    expect(load(relaxed, true).onMixedCommandActions).toBe("ask");

    writeProjectConfig(relaxed, JSON.stringify({ onMixedCommandActions: "deny" }));
    expect(load(relaxed, true).onMixedCommandActions).toBe("deny");
  });

  it("onMixedCommandActions：只写项目层不能放宽默认的 deny（FR-59）", () => {
    const ws = newWorkspace();
    writeGlobalConfig(ws, REFERENCE_CONFIG);
    writeProjectConfig(ws, JSON.stringify({ onMixedCommandActions: "review" }));

    expect(load(ws, true).onMixedCommandActions).toBe("deny");
  });

  it("onMixedCommandActions：项目层不能放宽全局层的 deny", () => {
    const ws = newWorkspace();
    writeGlobalConfig(ws, JSON.stringify({ onMixedCommandActions: "deny" }));
    writeProjectConfig(ws, JSON.stringify({ onMixedCommandActions: "review" }));

    expect(load(ws, true).onMixedCommandActions).toBe("deny");
  });

  it("userBashPolicy：任一层保持拦截、任一层关闭自动审核即转人工，模型更具体者胜", () => {
    const ws = newWorkspace();
    writeGlobalConfig(
      ws,
      JSON.stringify({
        userBashPolicy: { enabled: false, autoReview: true, model: "a/one" },
      }),
    );

    // 只有全局层：其自身取值生效
    expect(load(ws, false).userBashPolicy).toMatchObject({
      enabled: false,
      autoReview: true,
      model: "a/one",
    });

    // 项目层显式开启 + 关闭自动审核 + 覆盖模型
    writeProjectConfig(
      ws,
      JSON.stringify({
        userBashPolicy: { enabled: true, autoReview: false, model: "b/two" },
      }),
    );
    expect(load(ws, true).userBashPolicy).toEqual({
      enabled: true,
      autoReview: false,
      model: "b/two",
    });

    // 项目层只覆盖模型，不改变 enabled / autoReview
    writeProjectConfig(ws, JSON.stringify({ userBashPolicy: { model: null } }));
    expect(load(ws, true).userBashPolicy).toEqual({
      enabled: false,
      autoReview: true,
      model: null,
    });
  });

  it("subagentPolicy：默认动作取最严格者，任一层显式禁止即禁止会话授权", () => {
    const ws = newWorkspace();
    writeGlobalConfig(
      ws,
      JSON.stringify({
        subagentPolicy: { enabled: true, defaultAction: "review", allowSessionGrants: true },
      }),
    );
    writeProjectConfig(
      ws,
      JSON.stringify({
        subagentPolicy: { defaultAction: "deny", allowSessionGrants: false },
      }),
    );

    const config = load(ws, true);

    expect(config.subagentPolicy.defaultAction).toBe("deny");
    expect(config.subagentPolicy.enabled).toBe(true);
    expect(config.subagentPolicy.allowSessionGrants).toBe(false);
  });

  it("未表态的层不参与安全敏感字段的相收敛（不会用默认值压低另一层的选择）", () => {
    const ws = newWorkspace();
    writeGlobalConfig(
      ws,
      JSON.stringify({
        subagentPolicy: { enabled: false, allowSessionGrants: true },
      }),
    );
    writeProjectConfig(ws, JSON.stringify({ subagentPolicy: { defaultAction: "ask" } }));

    const config = load(ws, true);

    expect(config.subagentPolicy.enabled).toBe(false);
    expect(config.subagentPolicy.allowSessionGrants).toBe(true);
    expect(config.subagentPolicy.defaultAction).toBe("ask");
  });

  it("配置校验失败：抬升 allow 为 review 并逐字段抢救（FR-51）", () => {
    const ws = newWorkspace();
    writeGlobalConfig(
      ws,
      JSON.stringify({
        debugLog: "yes",
        permission: {
          read: "allow",
          bash: {
            "rm *": "allow",
            "rm -rf /*": { action: "deny", reason: "破坏性" },
          },
        },
      }),
    );

    const config = load(ws);

    expect(config.layers.global.status).toBe("degraded");
    expect(config.degraded).toBe(true);
    expect(config.layers.global.diagnostics[0]?.message).toContain("配置校验失败");
    expect(config.layers.global.diagnostics[1]?.message).toContain(
      "以下字段不合法已被忽略：debugLog",
    );
    expect(config.layers.global.diagnostics.at(-1)?.message).toContain(
      "抬升为 review",
    );

    // 合法字段继续生效（否则用户显式写的 deny 会一起丢失）
    expect(config.rules[0]?.surfaces.get("read")).toEqual([
      { pattern: "*", action: "review", index: 0 },
    ]);
    expect(config.rules[0]?.surfaces.get("bash")?.map((rule) => rule.action)).toEqual([
      "review",
      "deny",
    ]);
    // 非法字段被丢弃，落到 schema 默认值
    expect(config.debugLog).toBe(false);
  });

  it("JSON 语法错误：该层不生效，标记 degraded 与原文行列号（FR-51/50）", () => {
    const ws = newWorkspace();
    writeGlobalConfig(
      ws,
      ['{', '  "enabled": true,', "  // 注释", '  "gate": all', "}"].join("\n"),
    );

    const config = load(ws);

    expect(config.layers.global.status).toBe("invalid");
    expect(config.degraded).toBe(true);
    const diagnostic = config.layers.global.diagnostics[0];
    expect(diagnostic?.message).toContain("JSON 解析失败");
    expect(diagnostic?.line).toBe(4);
    expect(diagnostic?.snippet).toBe('  "gate": all');
    // 该层不参与合并，但"存在失效层"必须可见
    expect(config.rules).toEqual([]);
    expect(config.enabled).toBe(true);
  });

  it("JSONC 注释与尾逗号可以正常加载（FR-49）", () => {
    const ws = newWorkspace();
    writeGlobalConfig(
      ws,
      ['{', '  // 说明', '  "gate": "all",', '  "extraTools": ["subagent",]', "}"].join(
        "\n",
      ),
    );

    const config = load(ws);

    expect(config.layers.global.status).toBe("loaded");
    expect(config.gate).toBe("all");
    expect(config.extraTools).toEqual(["subagent"]);
  });

  it("单条坏规则只丢自己，同层显式 deny 继续生效（FR-51）", () => {
    const ws = newWorkspace();
    writeGlobalConfig(
      ws,
      JSON.stringify({
        permission: {
          read: "allow",
          bash: {
            "rm *": "review",
            "rm -rf /*": { action: "deny", reason: "破坏性" },
            "bad ((": "alloww",
          },
        },
      }),
    );

    const config = load(ws);

    expect(config.layers.global.status).toBe("degraded");
    expect(config.degraded).toBe(true);
    expect(
      config.layers.global.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("bash[bad ((]"),
      ),
    ).toBe(true);
    expect(config.rules[0]?.surfaces.get("bash")?.map((rule) => rule.action)).toEqual([
      "review",
      "deny",
    ]);
    // read 的 allow 被抬升，而不是被丢掉
    expect(config.rules[0]?.surfaces.get("read")).toEqual([
      { pattern: "*", action: "review", index: 0 },
    ]);
  });

  it("抬升只改动作取值，不改写 reason 文本（FR-51）", () => {
    const ws = newWorkspace();
    writeGlobalConfig(
      ws,
      JSON.stringify({
        debugLog: "yes",
        permission: { bash: { x: { action: "deny", reason: "allow" } } },
      }),
    );

    const config = load(ws);

    expect(config.layers.global.status).toBe("degraded");
    expect(config.rules[0]?.surfaces.get("bash")?.[0]).toMatchObject({
      pattern: "x",
      action: "deny",
      reason: "allow",
    });
  });

  it("permission 整块不是对象时该字段被忽略，不会凭空产生规则（FR-51）", () => {
    const ws = newWorkspace();
    writeGlobalConfig(ws, JSON.stringify({ permission: [] }));

    const config = load(ws);

    expect(config.layers.global.status).toBe("invalid");
    expect(config.degraded).toBe(true);
    expect(config.ruleCount).toBe(0);
    expect(
      config.layers.global.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("以下字段不合法已被忽略：permission"),
      ),
    ).toBe(true);
  });

  it("项目层失效也置 degraded，且只保留全局层规则", () => {
    const ws = newWorkspace();
    writeGlobalConfig(ws, REFERENCE_CONFIG);
    writeProjectConfig(ws, "{ // 坏掉的 JSON\n\"gate\": all\n}");

    const config = load(ws, true);

    expect(config.layers.project.status).toBe("invalid");
    expect(config.layers.project.diagnostics[0]?.line).toBe(2);
    expect(config.degraded).toBe(true);
    expect(config.rules.map((layer) => layer.layer)).toEqual(["global"]);
    expect(config.ruleCount).toBe(5);
  });

  it("失败分支开关配成 allow 时该字段被丢弃，落回更严格的默认值", () => {
    const ws = newWorkspace();
    writeGlobalConfig(
      ws,
      JSON.stringify({
        onReviewUnavailable: "allow",
        onUnresolvedFacts: "allow",
        permission: { bash: { "rm *": "review" } },
      }),
    );

    const config = load(ws);

    expect(config.layers.global.status).toBe("degraded");
    expect(config.onReviewUnavailable).toBe("deny");
    expect(config.onUnresolvedFacts).toBe("review");
    expect(
      config.layers.global.diagnostics.some((diagnostic) =>
        diagnostic.message.includes(
          "以下字段不合法已被忽略：onReviewUnavailable、onUnresolvedFacts",
        ),
      ),
    ).toBe(true);
    // permission 仍然生效
    expect(config.ruleCount).toBe(1);
  });

  it("CRLF 配置可加载，错误行号仍对齐（FR-49/50）", () => {
    const lineEnding = "\r\n";
    const valid = ["{", '  "gate": "all",', "}"].join(lineEnding);
    const broken = ["{", '  "gate": "all",', '  "debugLog": nope', "}"].join(
      lineEnding,
    );

    const okWorkspace = newWorkspace();
    writeGlobalConfig(okWorkspace, valid);
    expect(load(okWorkspace).gate).toBe("all");

    workspace?.cleanup();
    const brokenWorkspace = newWorkspace();
    writeGlobalConfig(brokenWorkspace, broken);
    const config = load(brokenWorkspace);

    expect(config.layers.global.diagnostics[0]?.line).toBe(3);
    expect(config.layers.global.diagnostics[0]?.snippet).toBe('  "debugLog": nope');
  });

  it("非法动作值不会被放行，而是降级为 review（FR-51）", () => {
    const ws = newWorkspace();
    writeGlobalConfig(
      ws,
      JSON.stringify({ permission: { read: "alloww", bash: { "rm *": "review" } } }),
    );

    const config = load(ws);

    expect(config.degraded).toBe(true);
    // read 这个 surface 整体不合法而丢掉，bash 保留
    expect(config.layers.global.status).toBe("degraded");
    expect(
      config.layers.global.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("以下条目不合法已被忽略：read"),
      ),
    ).toBe(true);
    expect(config.rules[0]?.surfaces.has("read")).toBe(false);
    expect(config.rules[0]?.surfaces.get("bash")).toEqual([
      { pattern: "rm *", action: "review", index: 0 },
    ]);
  });
});
