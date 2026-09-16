import { describe, expect, it } from "vitest";

import {
  askHuman,
  buildAskTitle,
  CHOICE_DENY,
  CHOICE_DENY_NOTE,
  CHOICE_ONCE,
  CHOICE_SESSION,
  DEFAULT_SUGGESTION,
} from "../../src/interact/dialog.ts";
import { createFakeContext } from "../support/fake-context.ts";

/**
 * 人工确认对话框（FR-29/30/42）。
 *
 * 选项集合本身就是契约：没有授权建议时不得出现"本会话允许此类"，否则等于给了一条
 * 不展示作用域的授权入口。正文四要素（待执行动作、命中规则、风险点、建议动作）同样是契约。
 */

describe("人工确认对话框", () => {
  it("有建议模式时给出四选项，并在正文里展示作用域", async () => {
    const seen: string[][] = [];
    const ctx = createFakeContext({ hasUI: true, selectResult: CHOICE_SESSION });
    ctx.ui.select = async (title: string, options: string[]): Promise<string> => {
      seen.push(options);
      expect(title).toContain("rm -rf ./dist *");
      return CHOICE_SESSION;
    };

    const decision = await askHuman(ctx, {
      action: "工具 bash，规则层提议动作 review；目标：rm -rf ./dist",
      rule: '命中规则 "rm *"（项目配置）→ review',
      risk: "评审模型（风险 high／授权 unknown）：会删除构建产物之外的文件",
      suggestion: "请确认目标目录。",
      suggestions: ["bash：rm -rf ./dist *"],
    });

    expect(seen).toEqual([[CHOICE_ONCE, CHOICE_SESSION, CHOICE_DENY, CHOICE_DENY_NOTE]]);
    expect(decision).toEqual({ choice: "session" });
  });

  it("没有建议模式时不提供会话授权入口", async () => {
    const seen: string[][] = [];
    const ctx = createFakeContext({ hasUI: true, selectResult: CHOICE_DENY });
    ctx.ui.select = async (_title: string, options: string[]): Promise<string> => {
      seen.push(options);
      return CHOICE_DENY;
    };

    const decision = await askHuman(ctx, {
      action: "工具 write，规则层提议动作 review；目标：/repo/a.txt",
      suggestions: [],
    });

    expect(seen).toEqual([[CHOICE_ONCE, CHOICE_DENY, CHOICE_DENY_NOTE]]);
    expect(decision).toEqual({ choice: "deny" });
  });

  it("「拒绝并说明」带回用户填写的理由", async () => {
    const ctx = createFakeContext({
      hasUI: true,
      selectResult: CHOICE_DENY_NOTE,
      inputResult: "  这条命令会覆盖生产数据  ",
    });

    const decision = await askHuman(ctx, { action: "需要确认。", suggestions: [] });

    expect(decision).toEqual({ choice: "deny-with-note", note: "这条命令会覆盖生产数据" });
  });

  it("取消对话框不给结论（调用方按拒绝处理）", async () => {
    const ctx = createFakeContext({ hasUI: true, selectResult: undefined });

    await expect(
      askHuman(ctx, { action: "需要确认。", suggestions: [] }),
    ).resolves.toBeUndefined();
  });

  it("FR-42 的四要素齐全，缺省补充建议动作", () => {
    const title = buildAskTitle({
      action: "工具 bash，规则层提议动作 review；目标：rm -rf /",
      rule: '命中规则 "rm -rf /"（全局配置）→ deny',
      risk: "会删除根目录。",
      note: "评审超时，不代表该动作因风险被拒绝。",
      suggestions: [],
    });

    expect(title).toContain("待执行动作：工具 bash");
    expect(title).toContain("命中规则：命中规则");
    expect(title).toContain("风险点：会删除根目录。");
    expect(title).toContain("判定说明：评审超时");
    expect(title).toContain(`建议动作：${DEFAULT_SUGGESTION}`);
  });

  it("buildAskTitle 省略空的可选要素，并保留建议动作", () => {
    const title = buildAskTitle({ action: "摘要", suggestions: [] });

    expect(title).toBe(
      [
        "pi-permission-guardian：需要人工确认",
        "",
        "待执行动作：摘要",
        `建议动作：${DEFAULT_SUGGESTION}`,
      ].join("\n"),
    );
  });
});
