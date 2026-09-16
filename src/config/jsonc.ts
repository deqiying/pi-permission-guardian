/**
 * JSONC 输入侧宽容度（FR-49/50）。
 *
 * 两遍扫描，都是"位置保留替换"：注释和被删掉的尾逗号一律替换为等量空白（换行原样保留），
 * 因此处理后的文本与原文逐字符对齐 —— `JSON.parse` 报出的位置可以直接用来定位原文的行列号，
 * 不会出现"漏写一个引号，错误却指向十几行之外"的情况。
 */

/** JSON 语法错误的位置信息。`line`/`column` 为 1 起始，指向原始文本。 */
export interface JsonSyntaxError {
  message: string;
  position?: number;
  /** 无法定位时字段缺省：宁可不给行列号，也不能给一个误导的位置。 */
  line?: number;
  column?: number;
  /** 出错位置所在行的原文；无法定位时缺省。 */
  snippet?: string;
}

export type JsoncParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: JsonSyntaxError };

/** 剥离 `//`、`/* *\/` 注释与对象/数组末尾多余逗号，保留原始换行与列位置。 */
export function stripJsonComments(input: string): string {
  return blankTrailingCommas(blankComments(stripBom(input)));
}

export function parseJsonc(input: string): JsoncParseResult {
  const prepared = stripJsonComments(input);
  try {
    return { ok: true, value: JSON.parse(prepared) as unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: describeSyntaxError(prepared, message) };
  }
}

/** BOM 只占一个字符，替换为空格以保持列对齐。 */
function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? ` ${input.slice(1)}` : input;
}

/** 第一遍：注释替换为空格，其中的换行保留。 */
function blankComments(input: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i] as string;
    const next = input[i + 1] ?? "";

    if (char === "/" && next === "/") {
      // 行注释：直到换行前全部变空白，换行本身保留。
      while (i < input.length && input[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      out.push("  ");
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        out.push(input[i] === "\n" ? "\n" : " ");
        i++;
      }
      // 未闭合的块注释：一路吞到文件末尾，让 JSON.parse 在注释起点附近报错。
      if (i < input.length) {
        out.push("  ");
        i += 2;
      }
      continue;
    }
    if (char === '"') {
      i = copyString(input, i, out);
      continue;
    }
    out.push(char);
    i++;
  }
  return out.join("");
}

/** 第二遍：`,` 之后（跳过空白）紧跟 `}` / `]`、且逗号前面已有元素时，把逗号替换为空格。 */
function blankTrailingCommas(input: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i] as string;
    if (char === '"') {
      i = copyString(input, i, out);
      continue;
    }
    if (char === "," && nextNonSpace(input, i + 1) !== undefined) {
      const following = input[nextNonSpace(input, i + 1) as number];
      const isTrailing = following === "}" || following === "]";
      out.push(isTrailing && hasPrecedingValue(out) ? " " : char);
      i++;
      continue;
    }
    out.push(char);
    i++;
  }
  return out.join("");
}

/**
 * 逗号之前是否已有真实元素。
 *
 * 少了这个判断，`[,]` / `{,}` 会被当成"多余的尾逗号"而静默变成空数组/空对象，
 * 把明显写坏的配置读成"没有规则"。
 */
function hasPrecedingValue(out: readonly string[]): boolean {
  for (let i = out.length - 1; i >= 0; i--) {
    const char = out[i] as string;
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      continue;
    }
    return char !== "," && char !== "{" && char !== "[" && char !== ":";
  }
  return false;
}

function nextNonSpace(input: string, from: number): number | undefined {
  for (let i = from; i < input.length; i++) {
    if (input[i] !== " " && input[i] !== "\t" && input[i] !== "\n" && input[i] !== "\r") {
      return i;
    }
  }
  return undefined;
}

/** 原样复制一个字符串字面量（含引号），返回下一个待扫描位置。 */
function copyString(input: string, start: number, out: string[]): number {
  let i = start;
  let escaping = false;
  out.push(input[i] as string);
  i++;
  while (i < input.length) {
    const char = input[i] as string;
    out.push(char);
    i++;
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === '"') {
      break;
    }
  }
  return i;
}

/**
 * 把 `JSON.parse` 的错误映射回原文位置。
 *
 * 按可靠性递减依次尝试：
 * 1. V8 的 `at position N`：精确偏移；
 * 2. V8 的 `(line L column C)`：信息量同上，只是这里只有行列；
 * 3. `Unexpected token '<c>'` 的字面量搜索，仅用于非空白 token。
 * 都不成立时不报位置——例如"行尾截断的裸字面量"只会给出一个换行 token，猜出来的行号会指到更早的行。
 */
function describeSyntaxError(prepared: string, message: string): JsonSyntaxError {
  const positioned = /at position (\d+)/.exec(message);
  if (positioned?.[1] !== undefined) {
    return withPosition(message, prepared, Number(positioned[1]));
  }

  const lineColumn = /\(line (\d+) column (\d+)\)/.exec(message);
  if (lineColumn?.[1] !== undefined && lineColumn[2] !== undefined) {
    const line = Number(lineColumn[1]);
    const column = Number(lineColumn[2]);
    const position = positionOf(prepared, line, column);
    return position === undefined
      ? { message, line, column, snippet: lineText(prepared, line) }
      : withPosition(message, prepared, position, { line, column });
  }

  const token = /Unexpected token '([^']*)'/.exec(message);
  const needle = token?.[1];
  if (needle !== undefined && /\S/.test(needle)) {
    const found = indexOutsideStrings(prepared, needle);
    if (found !== undefined) {
      return withPosition(message, prepared, found);
    }
  }

  if (message.includes("Unexpected end of JSON input")) {
    return withPosition(message, prepared, prepared.length);
  }
  return { message };
}

function withPosition(
  message: string,
  prepared: string,
  position: number,
  known?: { line: number; column: number },
): JsonSyntaxError {
  const located = known ?? lineColumnAt(prepared, position);
  return {
    message,
    position,
    line: located.line,
    column: located.column,
    snippet: lineText(prepared, located.line),
  };
}

/** 行列号 → 偏移量；行列超出实际范围时返回 undefined。 */
function positionOf(
  input: string,
  line: number,
  column: number,
): number | undefined {
  let currentLine = 1;
  let lineStart = 0;
  for (let i = 0; i <= input.length; i++) {
    if (i === input.length || input[i] === "\n") {
      if (currentLine === line) {
        const position = lineStart + (column - 1);
        // 只接受落在该行范围内的列号（列号在行尾之后视为不可靠）。
        return position <= i ? position : undefined;
      }
      currentLine++;
      lineStart = i + 1;
    }
  }
  return undefined;
}

function indexOutsideStrings(input: string, token: string): number | undefined {
  let i = 0;
  while (i < input.length) {
    const char = input[i] as string;
    if (char === '"') {
      // 跳过整个字符串字面量，避免命中字符串里的同名片段。
      let escaping = false;
      i++;
      while (i < input.length) {
        const current = input[i] as string;
        i++;
        if (escaping) {
          escaping = false;
          continue;
        }
        if (current === "\\") {
          escaping = true;
          continue;
        }
        if (current === '"') {
          break;
        }
      }
      continue;
    }
    if (input.startsWith(token, i)) {
      return i;
    }
    i++;
  }
  return undefined;
}

function lineColumnAt(input: string, position: number): { line: number; column: number } {
  const before = input.slice(0, position);
  const lastNewline = before.lastIndexOf("\n");
  return {
    line: countNewlines(before) + 1,
    column: position - lastNewline,
  };
}

function countNewlines(input: string): number {
  let count = 0;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === "\n") {
      count++;
    }
  }
  return count;
}

/** 第 `line` 行的原文，最多截取 200 字符以控制日志体积。 */
function lineText(input: string, line: number): string {
  const lines = input.split("\n");
  const text = lines[line - 1] ?? "";
  const trimmed = text.replace(/\r?$/, "").trimEnd();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}
