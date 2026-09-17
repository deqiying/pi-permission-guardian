import { describe, expect, it } from "vitest";

import {
  INDIRECTION_WRAPPERS,
  OPAQUE_WRAPPERS,
  classifyWrapper,
  executableName,
  transparentPrefixStart,
  unresolvedCauseForWrapper,
} from "../../../src/facts/bash/wrappers.ts";

describe("executableName：可执行名归一", () => {
  it("去掉目录部分", () => {
    expect(executableName("/usr/bin/sudo")).toBe("sudo");
    expect(executableName("./scripts/run")).toBe("run");
    expect(executableName("C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
  });

  it("去掉 Windows 可执行扩展名（大小写不敏感）", () => {
    expect(executableName("sudo.exe")).toBe("sudo");
    expect(executableName("x.CMD")).toBe("x");
    expect(executableName("y.ps1")).toBe("y");
  });

  it("保留非可执行扩展名（`mkfs.ext4` 是一个命令名，不是扩展名）", () => {
    expect(executableName("mkfs.ext4")).toBe("mkfs.ext4");
    expect(executableName("/sbin/mkfs.ext4")).toBe("mkfs.ext4");
  });

  it("去掉前置反斜杠（用户想绕过别名时常用）", () => {
    expect(executableName("\\rm")).toBe("rm");
  });
});

describe("classifyWrapper：包装器识别（FR-12）", () => {
  it("代码文本类包装器标记为 opaque", () => {
    for (const name of ["bash", "sh", "zsh", "eval", "source", "."]) {
      expect(classifyWrapper(name, [name])).toBe("opaque");
    }
    expect(OPAQUE_WRAPPERS.has("bash")).toBe(true);
  });

  it("间接执行类包装器标记为 indirection", () => {
    for (const name of ["sudo", "doas", "env", "xargs", "timeout", "nohup", "nice", "command", "exec", "parallel"]) {
      expect(classifyWrapper(name, [name])).toBe("indirection");
    }
    expect(INDIRECTION_WRAPPERS.has("sudo")).toBe(true);
  });

  it("带路径或扩展名的包装器同样识别", () => {
    expect(classifyWrapper(executableName("/usr/bin/sudo"), ["sudo", "rm"])).toBe("indirection");
    expect(classifyWrapper(executableName("C:\\Program Files\\Git\\bin\\bash.exe"), [])).toBe("opaque");
  });

  it("普通命令不是包装器", () => {
    expect(classifyWrapper("rm", ["rm", "-rf", "/"])).toBeUndefined();
    expect(classifyWrapper("git", ["git", "status"])).toBeUndefined();
  });

  it("find 只有在带 -exec 一类参数时才算间接执行", () => {
    expect(classifyWrapper("find", ["find", ".", "-exec", "rm", "{}", ";"])).toBe("indirection");
    expect(classifyWrapper("find", ["find", ".", "-name", "x"])).toBeUndefined();
  });

  it("无法确定可执行名时不猜", () => {
    expect(classifyWrapper(undefined, ["sudo", "rm"])).toBeUndefined();
  });

  it("`command -v` / `-V` 是查询而不是包装器（不执行参数）", () => {
    expect(classifyWrapper("command", ["command", "-v", "rg"])).toBeUndefined();
    expect(classifyWrapper("command", ["command", "-p", "-V", "rg"])).toBeUndefined();
    // 不查询时仍然是包装器（可被透明前缀内推）。
    expect(classifyWrapper("command", ["command", "cat", "f"])).toBe("indirection");
  });

  it("降级原因与包装器类型一一对应", () => {
    expect(unresolvedCauseForWrapper("opaque")).toBe("opaque-wrapper");
    expect(unresolvedCauseForWrapper("indirection")).toBe("indirection-wrapper");
  });
});

describe("transparentPrefixStart：透明前缀内推（FR-12 修订）", () => {
  it("跳过自己的选项后，内层命令就是真正要执行的东西", () => {
    expect(transparentPrefixStart("nice", ["-n", "5", "cat", "f"])).toBe(2);
    expect(transparentPrefixStart("nice", ["cat", "f"])).toBe(0);
    expect(transparentPrefixStart("nohup", ["cat", "f"])).toBe(0);
    expect(transparentPrefixStart("time", ["-p", "cat", "f"])).toBe(1);
    expect(transparentPrefixStart("stdbuf", ["-o0", "cat", "f"])).toBe(1);
    expect(transparentPrefixStart("stdbuf", ["-o", "0", "cat", "f"])).toBe(2);
  });

  it("timeout 还要跳过一个时长", () => {
    expect(transparentPrefixStart("timeout", ["5", "cat", "f"])).toBe(1);
    expect(transparentPrefixStart("timeout", ["5s", "cat", "f"])).toBe(1);
    expect(transparentPrefixStart("timeout", ["--foreground", "5", "cat", "f"])).toBe(2);
    expect(transparentPrefixStart("timeout", ["-s", "KILL", "5", "cat", "f"])).toBe(3);
    expect(transparentPrefixStart("timeout", ["--signal=KILL", "5", "cat", "f"])).toBe(2);
    expect(transparentPrefixStart("timeout", ["-k", "1", "-s", "KILL", "5", "cat"])).toBe(5);
  });

  it("env 还要跳过 NAME=VALUE", () => {
    expect(transparentPrefixStart("env", ["-u", "FOO", "cat", "f"])).toBe(2);
    expect(transparentPrefixStart("env", ["FOO=1", "BAR=2", "cat", "f"])).toBe(2);
    expect(transparentPrefixStart("env", ["cat"])).toBe(0);
  });

  it("command 只在不是查询时内推", () => {
    expect(transparentPrefixStart("command", ["cat", "f"])).toBe(0);
    expect(transparentPrefixStart("command", ["-p", "cat", "f"])).toBe(1);
    expect(transparentPrefixStart("command", ["-v", "rg"])).toBeUndefined();
    expect(transparentPrefixStart("command", ["-p", "-V", "rg"])).toBeUndefined();
  });

  it("看不透参数布局时返回 undefined（继续按不透明处理）", () => {
    // 没有内层命令。
    expect(transparentPrefixStart("timeout", ["5"])).toBeUndefined();
    expect(transparentPrefixStart("env", [])).toBeUndefined();
    expect(transparentPrefixStart("nice", ["-n"])).toBeUndefined();
    // 不可静态确定的内层命令名由调用方拦（见 enumerate 的 resolveUnwrap）。
    expect(transparentPrefixStart("timeout", ["5", "$CMD"])).toBe(1);
  });

  it("不在透明名单里的包装器一律不内推", () => {
    for (const name of ["sudo", "xargs", "exec", "parallel", "setsid", "chroot", "builtin"]) {
      expect(transparentPrefixStart(name, ["cat", "f"])).toBeUndefined();
    }
    expect(transparentPrefixStart(undefined, ["cat", "f"])).toBeUndefined();
  });
});
