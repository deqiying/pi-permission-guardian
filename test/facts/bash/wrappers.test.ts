import { describe, expect, it } from "vitest";

import {
  INDIRECTION_WRAPPERS,
  OPAQUE_WRAPPERS,
  classifyWrapper,
  executableName,
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

  it("降级原因与包装器类型一一对应", () => {
    expect(unresolvedCauseForWrapper("opaque")).toBe("opaque-wrapper");
    expect(unresolvedCauseForWrapper("indirection")).toBe("indirection-wrapper");
  });
});
