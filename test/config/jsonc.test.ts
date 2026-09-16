import { describe, expect, it } from "vitest";

import { parseJsonc, stripJsonComments } from "../../src/config/jsonc.ts";

describe("JSONC 输入（FR-49/50）", () => {
  it("支持 // 与 /* */ 注释、对象与数组末尾多余逗号", () => {
    const text = [
      "{",
      "  // 行注释",
      '  "a": 1, /* 块注释 */',
      '  "b": [1, 2,],',
      "}",
    ].join("\n");

    expect(parseJsonc(text)).toEqual({ ok: true, value: { a: 1, b: [1, 2] } });
  });

  it("字符串字面量内的 // 与 /* 不被误判", () => {
    const text = '{"cmd": "a // b", "url": "https://example.com/*", "re": "\\\\"}';

    expect(parseJsonc(text)).toEqual({
      ok: true,
      value: { cmd: "a // b", url: "https://example.com/*", re: "\\" },
    });
  });

  it("转义引号不会提前结束字符串", () => {
    const text = '{"a": "he said \\"// no\\" ok"}';

    expect(parseJsonc(text)).toEqual({
      ok: true,
      value: { a: 'he said "// no" ok' },
    });
  });

  it("剥离后逐字符对齐原文：注释只被替换为空白", () => {
    const stripped = stripJsonComments('{"a": 1, // x\n "b": 2}');

    expect(stripped).toHaveLength('{"a": 1, // x\n "b": 2}'.length);
    expect(stripped.split("\n")).toHaveLength(2);
  });

  it("块注释内的换行原样保留，错误行号与原文一致（FR-50）", () => {
    const text = [
      "{",
      "  /* 多行注释",
      "     仍然是注释 */",
      '  "a": 1',
      '  "b": 2',
      "}",
    ].join("\n");

    const result = parseJsonc(text);

    expect(result.ok).toBe(false);
    // 缺少逗号的位置在原文第 5 行
    expect(result.ok ? undefined : result.error.line).toBe(5);
    expect(result.ok ? undefined : result.error.column).toBe(3);
    expect(result.ok ? undefined : result.error.snippet).toBe('  "b": 2');
  });

  it("漏写引号时报出原文行号，而不是被注释挤到别处", () => {
    const text = [
      "{",
      "  // 顶部的说明",
      "  // 第二行说明",
      '  "a": 1,',
      "  b: 2",
      "}",
    ].join("\n");

    const result = parseJsonc(text);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.line).toBe(5);
    expect(result.ok ? undefined : result.error.column).toBe(3);
    expect(result.ok ? undefined : result.error.snippet).toBe("  b: 2");
  });

  it("文件被截断时把位置指到末尾", () => {
    const text = '{\n  "a": 1,\n';

    const result = parseJsonc(text);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.position).toBe(text.length);
  });

  it("BOM 与行尾注释不会破坏解析", () => {
    expect(parseJsonc('\uFEFF{"a": 1} // 尾注释')).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it("空白输入报错且不抛异常", () => {
    const result = parseJsonc("   ");

    expect(result.ok).toBe(false);
  });

  it("`[,]` 与 `{,}` 不被当成尾逗号，直接报错", () => {
    // 否则明显写坏的配置会被读成"空数组/空对象"，静默变成"没有规则"
    expect(parseJsonc('{"a": [,]}').ok).toBe(false);
    expect(parseJsonc("{,}").ok).toBe(false);
    expect(parseJsonc("[1,,]").ok).toBe(false);
    // 真正的尾逗号仍然宽容
    expect(parseJsonc('{"a": [1,]}')).toEqual({ ok: true, value: { a: [1] } });
  });

  it("CRLF 输入可解析，行号仍对齐", () => {
    const text = ["{", '  "a": 1,', '  "b" 2', "}"].join("\r\n");
    const result = parseJsonc(text);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.line).toBe(3);
    expect(result.ok ? undefined : result.error.snippet).toBe('  "b" 2');

    expect(parseJsonc(['{', '  "a": 1,', "}"].join("\r\n"))).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it("无法可靠定位时宁可不给行列号", () => {
    // V8 对行尾截断的裸字面量只给一个换行 token，猜出来的行号会指到更早的行
    const result = parseJsonc('{\n  "a": true,\n  "b": tru\n}');

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.line).toBeUndefined();
    expect(result.ok ? undefined : result.error.column).toBeUndefined();
    expect(result.ok ? undefined : result.error.snippet).toBeUndefined();
    expect(result.ok ? undefined : result.error.message).toContain("Unexpected token");
  });
});
