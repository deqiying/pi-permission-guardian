import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compareKey,
  isExternal,
  isLiteralPathText,
  makePathValue,
  pathEquals,
  resetPathValueCache,
  toPosix,
} from "../../src/facts/path-value.ts";

const tempDirs: string[] = [];

afterEach(() => {
  resetPathValueCache();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  // 从真实形起算：windows-latest 的 %TEMP% 是 8.3 短名路径（`C:\Users\RUNNER~1\…`），
  // realpath 会把它还原成长名，于是「真实形 === 词法形」这类严格比较会被环境打脸，
  // 而不是反映被测逻辑。归一根目录后，词法形与真实形才在同一个基线上比较。
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "guardian-paths-")));
  tempDirs.push(dir);
  return dir;
}

const LINUX = {
  cwd: "/proj/app",
  platform: "linux" as NodeJS.Platform,
  home: "/home/u",
};

describe("path-value：词法归一", () => {
  it("相对路径按 cwd 展开", () => {
    expect(makePathValue("x/y.txt", LINUX).lexical).toBe("/proj/app/x/y.txt");
    expect(makePathValue("./x", LINUX).lexical).toBe("/proj/app/x");
  });

  it("折叠 `.` 与 `..`", () => {
    expect(makePathValue("../other/x", LINUX).lexical).toBe("/proj/other/x");
    expect(makePathValue("./a/../b", LINUX).lexical).toBe("/proj/app/b");
  });

  it("绝对路径原样保留（含根目录）", () => {
    expect(makePathValue("/etc/hosts", LINUX).lexical).toBe("/etc/hosts");
    expect(makePathValue("/", LINUX).lexical).toBe("/");
  });

  it("动态文本不拼接 cwd：造一个假路径会让外部目录判定失真", () => {
    const value = makePathValue("$DIR/x", LINUX);
    expect(value.lexical).toBe("$DIR/x");
    expect(value.canonical).toBeUndefined();
  });

  it("反引号与变量文本同样视为动态", () => {
    expect(isLiteralPathText("$DIR/x")).toBe(false);
    expect(isLiteralPathText("`pwd`/x")).toBe(false);
    // glob 不算动态：目录部分仍然可靠，只是文件名是模式。
    expect(isLiteralPathText("./dist/*")).toBe(true);
    expect(makePathValue("./dist/*", LINUX).lexical).toBe("/proj/app/dist/*");
  });
});

describe("path-value：Windows 语义", () => {
  const WIN = {
    cwd: "D:\\proj\\app",
    platform: "win32" as NodeJS.Platform,
    home: "C:\\Users\\u",
  };

  it("正向斜杠归一为反斜杠", () => {
    expect(makePathValue("C:/Users/x/f.txt", WIN).lexical).toBe("C:\\Users\\x\\f.txt");
    expect(makePathValue("sub/dir", WIN).lexical).toBe("D:\\proj\\app\\sub\\dir");
  });

  it("盘符绝对路径不被 cwd 影响", () => {
    expect(makePathValue("C:\\x", WIN).lexical).toBe("C:\\x");
  });

  it("比较键在 Windows 上不区分大小写", () => {
    expect(compareKey("D:\\Proj\\App", "win32")).toBe(compareKey("d:\\proj\\app", "win32"));
    expect(pathEquals("D:\\Proj", "d:\\proj", "win32")).toBe(true);
    expect(pathEquals("/Proj", "/proj", "linux")).toBe(false);
  });

  it("大小写不同的同一目录不算外部目录", () => {
    const value = makePathValue("d:\\PROJ\\APP\\x", WIN);
    expect(isExternal(value, ["D:\\proj\\app"], "win32")).toBe(false);
  });

  it("MSYS / Cygwin 盘符路径归一为 Windows 路径（仅 Windows 语义）", () => {
    // git-bash 里 `/c/Users/x` 就是 `C:\Users\x`；不归一就会变成拼在 cwd 下的假路径，
    // 用户针对 `C:\Users\**` 写的规则会静默失效。
    expect(makePathValue("/c/Users/x/f.txt", WIN).lexical).toBe("C:\\Users\\x\\f.txt");
    expect(makePathValue("/cygdrive/c/Users/x", WIN).lexical).toBe("C:\\Users\\x");
    expect(makePathValue("/c", WIN).lexical).toBe("C:\\");
    expect(makePathValue("/c/", WIN).lexical).toBe("C:\\");
    // 归一后不再落在 cwd 内，外部目录规则能正常生效。
    const value = makePathValue("/c/Users/x/f.txt", WIN);
    expect(isExternal(value, ["D:\\proj\\app"], "win32")).toBe(true);
  });

  it("MSYS 形状只认单个字母挂载点，且不影响相对形式", () => {
    expect(makePathValue("c/x", WIN).lexical).toBe("D:\\proj\\app\\c\\x");
    expect(makePathValue("./c/x", WIN).lexical).toBe("D:\\proj\\app\\c\\x");
    // UNC 在 Windows 路径实现里本来就是合法绝对路径，不参与盘符归一。
    expect(makePathValue("//server/share/x", WIN).lexical).toBe("\\\\server\\share\\x");
  });

  it("UNC 路径不解析真实路径（realpath 会阻塞在网络访问上）", () => {
    // 这条用例同时也是性能断言：真去 realpath 会对网络位置发起 SMB 访问，
    // 在 `tool_call` 里卡住几十秒（曾经把本测试压到 5s 超时）。
    const value = makePathValue("//server/share/x", WIN);
    expect(value.lexical).toBe("\\\\server\\share\\x");
    expect(value.canonical).toBeUndefined();
  });

  it("POSIX 语义下 `/c/…` 是普通绝对路径，不做盘符转换", () => {
    expect(makePathValue("/c/Users/x", LINUX).lexical).toBe("/c/Users/x");
  });

  it("目标平台与宿主不一致时不解析符号链接（真实路径是宿主属性）", () => {
    const dir = tempDir();
    const value = makePathValue(join(dir, "missing", "x.txt"), {
      cwd: dir,
      platform: process.platform === "win32" ? "linux" : "win32",
    });
    expect(value.canonical).toBeUndefined();
  });
});

describe("path-value：外部目录判定", () => {
  it("根目录自身与其内部路径都不算外部", () => {
    expect(isExternal(makePathValue("/proj/app", LINUX), ["/proj/app"], "linux")).toBe(false);
    expect(isExternal(makePathValue("/proj/app/a/b", LINUX), ["/proj/app"], "linux")).toBe(false);
  });

  it("前缀相同但不是子目录的路径算外部（`/proj/app2` ≠ `/proj/app`）", () => {
    const value = makePathValue("/proj/app2/x", LINUX);
    expect(isExternal(value, ["/proj/app"], "linux")).toBe(true);
  });

  it("多个根目录任一命中即算内部", () => {
    const value = makePathValue("/other/x", LINUX);
    expect(isExternal(value, ["/proj/app", "/other"], "linux")).toBe(false);
  });

  it("没有允许根目录时一切都在外面", () => {
    expect(isExternal(makePathValue("/proj/app/x", LINUX), [], "linux")).toBe(true);
  });
});

describe("path-value：符号链接", () => {
  const realpathPlatform = process.platform as NodeJS.Platform;

  it("相对路径里的 `..` 穿软链接时，按内核语义解析（不是先折叠）", () => {
    const dir = tempDir();
    const root = join(dir, "app");
    const outside = join(dir, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(
      outside,
      join(root, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    resetPathValueCache();

    const options = { cwd: root, platform: realpathPlatform, roots: [root] };
    const value = makePathValue("./link/../shadow", options);
    // 词法形是折叠结果（glob 匹配看到的就是它）。
    expect(toPosix(value.lexical)).toBe(toPosix(join(root, "shadow")));
    if (process.platform === "win32") {
      // 实测：Windows 在打开文件前就**文本折叠** `..`（`link\\..\\probe.txt` 读到的是
      // `app\\probe.txt`），所以真实形与词法形一致才是"系统真正会打开的位置"。
      expect(toPosix(value.canonical ?? "")).toBe(toPosix(join(root, "shadow")));
    } else {
      // POSIX：先解析软链接再处理 `..` → link 先到 outside，`..` 再回到 <dir>。
      expect(toPosix(value.canonical ?? "")).toBe(toPosix(join(realpathSync(dir), "shadow")));
      expect(isExternal(value, [root], realpathPlatform)).toBe(true);
    }
  });

  it("经由符号链接目录的路径会被解析到真实位置", () => {
    const dir = tempDir();
    const target = join(dir, "real");
    const link = join(dir, "link");
    mkdirSync(target);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    resetPathValueCache();

    const options = { cwd: dir, platform: realpathPlatform };
    const value = makePathValue(join(link, "x.txt"), options);
    expect(value.canonical).toBeDefined();
    expect(toPosix(value.canonical as string)).toContain("real");

    // 通过链接访问真实目录内的文件：真实形在根内 → 不算外部。
    expect(isExternal(value, [target], realpathPlatform)).toBe(false);
  });

  it("根目录自身是软链接时，两侧都取真实形比较", () => {
    const dir = tempDir();
    const realRoot = join(dir, "realroot");
    mkdirSync(realRoot);
    const linkedRoot = join(dir, "rootlink");
    symlinkSync(
      realRoot,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    resetPathValueCache();

    // 经由软链接根目录访问的文件仍算"根内"：只比较词法形/真实形任一侧都会误判。
    const value = makePathValue(join(linkedRoot, "y.txt"), {
      cwd: linkedRoot,
      platform: realpathPlatform,
    });
    expect(isExternal(value, [linkedRoot], realpathPlatform)).toBe(false);
  });

  it("相对形式的根目录不参与匹配（事实层拿不到会话 cwd，宁可判为外部）", () => {
    const value = makePathValue("./x", LINUX);
    expect(isExternal(value, ["../shared-lib"], "linux")).toBe(true);
  });

  it("写操作目标不存在时，解析到已存在的父目录", () => {
    const dir = tempDir();
    const target = join(dir, "real");
    mkdirSync(target);
    symlinkSync(target, join(dir, "link"), process.platform === "win32" ? "junction" : "dir");
    resetPathValueCache();

    const value = makePathValue(join(dir, "link", "new", "file.txt"), {
      cwd: dir,
      platform: realpathPlatform,
    });
    expect(toPosix(value.canonical ?? "")).toContain("real");
    expect(toPosix(value.canonical ?? "")).toContain("new/file.txt");
  });

  it("没有符号链接时，真实形与词法形一致", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "file.txt"), "x");
    const lexical = join(dir, "nope", "deeper", "x.txt");
    const value = makePathValue(lexical, { cwd: dir, platform: realpathPlatform });
    expect(value.lexical).toBe(lexical);
    expect(value.canonical).toBe(lexical);
  });
});
