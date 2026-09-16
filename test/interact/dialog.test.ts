import { describe, expect, it } from "vitest";

import {
  askHuman,
  buildAskTitle,
  CHOICE_DENY,
  CHOICE_DENY_NOTE,
  CHOICE_ONCE,
  CHOICE_SESSION,
} from "../../src/interact/dialog.ts";
import { createFakeContext } from "../support/fake-context.ts";

/**
 * 人工确认对话框（FR-29/30）。
 *
 * 选项集合本身就是契约：没有授权建议时不得出现"本会话允许此类"，否则等于给了一条
 * 不展示作用域的授权入口。
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
      summary: "工具 bash 提议动作 review，需要确认。",
      detail: "- command rm -rf ./dist → review",
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
      summary: "需要确认。",
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

    const decision = await askHuman(ctx, { summary: "需要确认。", suggestions: [] });

    expect(decision).toEqual({ choice: "deny-with-note", note: "这条命令会覆盖生产数据" });
  });

  it("取消对话框不给结论（调用方按拒绝处理）", async () => {
    const ctx = createFakeContext({ hasUI: true, selectResult: undefined });

    await expect(askHuman(ctx, { summary: "需要确认。", suggestions: [] })).resolves.toBeUndefined();
  });

  it("buildAskTitle 省略空 detail", () => {
    const title = buildAskTitle({ summary: "摘要", suggestions: [] });

    expect(title).toBe("pi-permission-guardian：需要人工确认\n\n摘要");
  });
});
