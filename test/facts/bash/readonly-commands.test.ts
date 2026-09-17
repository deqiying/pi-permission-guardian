import type { Node as SyntaxNode } from "web-tree-sitter";

import { describe, expect, it } from "vitest";

import {
  isReadOnlyUnit,
  legacyProfiles,
  matchesProfilePrefix,
  planReadOnly,
  prefixPositionalCount,
  roleAt,
} from "../../../src/facts/bash/readonly-commands.ts";
import { embeddedOptionValue, isOptionLike, type Argv, type ArgvToken } from "../../../src/facts/bash/argv.ts";
import { makePathTarget } from "../../../src/facts/path-value.ts";
import type { ReadOnlyCommandProfile } from "../../../src/facts/types.ts";

/**
 * 只读档案的匹配与判定（FR-65~FR-69）。
 *
 * 这些用例只用手写 argv（不经过解析器）：档案逻辑是 argv 的纯函数，绑上解析器只会把
 * facts 层的回归带进这里。真实命令的端到端断言在 `readonly-profiles.test.ts`。
 */

const pathOptions = {
  cwd: "/proj/app",
  platform: "linux" as NodeJS.Platform,
  home: "/home/u",
  roots: ["/proj/app"],
};

/** 依据 `buildArgv` 的分类规则手写一份 argv（`node` 字段对档案逻辑无意义）。 */
function argvOf(...words: string[]): Argv {
  const tokens: ArgvToken[] = [];
  let positionalIndex = 0;
  let pastDoubleDash = false;
  for (const word of words.slice(1)) {
    if (!pastDoubleDash && word === "--") {
      pastDoubleDash = true;
      continue;
    }
    const option = !pastDoubleDash && isOptionLike(word);
    const embedded = option ? embeddedOptionValue(word) : undefined;
    tokens.push({
      text: word,
      raw: word,
      node: {} as SyntaxNode,
      kind: option ? "option" : "positional",
      dynamic: false,
      ...(option ? {} : { positionalIndex: positionalIndex++ }),
      ...(embedded === undefined
        ? {}
        : { embedded: { text: embedded.text, dynamic: false, quoting: embedded.quoting } }),
    });
  }
  return { words, tokens, executable: words[0] };
}

function profile(extra: Partial<ReadOnlyCommandProfile> = {}): ReadOnlyCommandProfile {
  return { argv: ["rg"], ...extra };
}

describe("matchesProfilePrefix：固定为 argv 前缀匹配", () => {
  it("单命令命中带参数的调用", () => {
    expect(matchesProfilePrefix(["cat"], ["cat", "file.txt"])).toBe(true);
    expect(matchesProfilePrefix(["cat"], ["cat"])).toBe(true);
  });

  it("多词前缀命中子命令与选项", () => {
    expect(matchesProfilePrefix(["git", "status"], ["git", "status", "--short"])).toBe(true);
    expect(matchesProfilePrefix(["git", "diff"], ["git", "diff", "HEAD~1"])).toBe(true);
  });

  it("不同子命令不命中", () => {
    expect(matchesProfilePrefix(["git", "status"], ["git", "push"])).toBe(false);
    expect(matchesProfilePrefix(["git", "diff"], ["git", "clean", "-fd"])).toBe(false);
    expect(matchesProfilePrefix(["git", "status"], ["git"])).toBe(false);
    expect(matchesProfilePrefix(["cat"], [])).toBe(false);
  });

  it("argv 更长时不算越界命中（`git statusx` 不等于 `git status`）", () => {
    expect(matchesProfilePrefix(["git", "status"], ["git", "statusx"])).toBe(false);
  });

  it("大小写敏感：匹配不上只会变严，不会多放行", () => {
    expect(matchesProfilePrefix(["cat"], ["Cat", "x"])).toBe(false);
  });

  it("空前缀永不命中（防止写成 [] 意外放行一切）", () => {
    expect(matchesProfilePrefix([], ["cat", "x"])).toBe(false);
  });
});

describe("legacyProfiles：旧白名单字符串条目等价于“全部位置参数都是路径”的档案", () => {
  it("按空白切词并标记来源", () => {
    expect(legacyProfiles(["git status", "cat"])).toEqual([
      { argv: ["git", "status"], roles: ["paths"], group: "readOnlyCommands" },
      { argv: ["cat"], roles: ["paths"], group: "readOnlyCommands" },
    ]);
  });
});

describe("角色序列与前缀消耗的词", () => {
  it("最后一项吸收剩余位置参数", () => {
    expect(roleAt(["pattern", "paths"], 0)).toBe("pattern");
    expect(roleAt(["pattern", "paths"], 1)).toBe("paths");
    expect(roleAt(["pattern", "paths"], 7)).toBe("paths");
  });

  it("空角色序列不表态（配合 unexpected-arg 取消免评审）", () => {
    expect(roleAt([], 0)).toBeUndefined();
    expect(roleAt(["paths"], undefined)).toBeUndefined();
  });

  it("前缀里的位置参数被排除在路径归因之外", () => {
    expect(prefixPositionalCount(profile({ argv: ["git", "grep"] }))).toBe(1);
    expect(prefixPositionalCount(profile({ argv: ["git", "worktree", "list"] }))).toBe(2);
    expect(prefixPositionalCount(profile({ argv: ["git", "remote", "-v"] }))).toBe(1);
    expect(prefixPositionalCount(profile())).toBe(0);
  });
});

describe("planReadOnly：角色 + 选项名单 + 脚本白名单", () => {
  it("未命中档案时返回 undefined", () => {
    expect(planReadOnly(argvOf("cat", "x"), [profile({ argv: ["rg"] })])).toBeUndefined();
  });

  it("命中档案且没有取消原因为通过；角色从档案前缀之后开始编号", () => {
    const plan = planReadOnly(
      argvOf("git", "grep", "-n", "readOnly"),
      [profile({ argv: ["git", "grep"], roles: ["pattern", "paths"] })],
    );
    expect(plan?.cancel).toBeUndefined();
    expect(plan?.roles).toEqual(["pattern", "paths"]);
  });

  it("deny-list：未列出的选项默认安全", () => {
    const plan = planReadOnly(argvOf("rg", "-n", "--color=never", "x", "src"), [
      profile({ roles: ["pattern", "paths"] }),
    ]);
    expect(plan?.cancel).toBeUndefined();
  });

  it("deny-list：命中 unsafeOptions 即取消（`--pre` 覆盖 `--pre=x`）", () => {
    expect(
      planReadOnly(argvOf("rg", "--pre=x", "x", "src"), [profile({ unsafeOptions: ["--pre"] })])
        ?.cancel,
    ).toBe("unsafe-option:--pre");
    expect(
      planReadOnly(argvOf("rg", "--pre", "x", "src"), [profile({ unsafeOptions: ["--pre"] })])
        ?.cancel,
    ).toBe("unsafe-option:--pre");
  });

  it("allow-list：只有列出的选项安全，未列出的一律取消", () => {
    const find = profile({
      argv: ["find"],
      roles: ["paths"],
      optionPolicy: "allow-list",
      safeOptions: ["-name", "-type"],
    });
    expect(planReadOnly(argvOf("find", ".", "-name", "*.log"), [find])?.cancel).toBeUndefined();
    expect(planReadOnly(argvOf("find", ".", "-name", "*.log", "-delete"), [find])?.cancel).toBe(
      "option-not-allowed:-delete",
    );
  });

  it("roles 为空表示不允许位置参数（`git branch <新分支名>` 会造分支）", () => {
    const plan = planReadOnly(argvOf("git", "branch", "newbranch"), [
      profile({ argv: ["git", "branch"], roles: [] }),
    ]);
    expect(plan?.cancel).toBe("unexpected-arg:newbranch");
  });

  it("script：整体命中模式集才通过，不匹配/缺失/动态取值都取消", () => {
    const sed = profile({
      argv: ["sed"],
      roles: ["script", "paths"],
      script: ["^[0-9]+(,[0-9]+)?p$"],
    });
    expect(planReadOnly(argvOf("sed", "-n", "1,10p", "f.txt"), [sed])?.cancel).toBeUndefined();
    expect(planReadOnly(argvOf("sed", "-n", "e echo X", "f.txt"), [sed])?.cancel).toBe(
      "script-not-allowed",
    );
    expect(planReadOnly(argvOf("sed", "--version"), [sed])?.cancel).toBe("script-not-allowed");
  });

  it("未声明安全的 `--opt=<值像路径>` 取消免评审并保留取值（旧口径）", () => {
    const plan = planReadOnly(argvOf("git", "diff", "--output=.env"), [
      profile({ argv: ["git", "diff"], roles: ["paths"], unsafeOptions: ["--output"] }),
    ]);
    expect(plan?.cancel).toBe("unsafe-option:--output");
  });

  it("safeOptions 豁免“值像路径”的形状规则（`--glob=<glob>`）", () => {
    const plan = planReadOnly(argvOf("rg", "--glob=src/**/*.ts", "-n", "x", "src"), [
      profile({ roles: ["pattern", "paths"], safeOptions: ["--glob"] }),
    ]);
    expect(plan?.cancel).toBeUndefined();
    expect(plan?.optionPathValues).toEqual([]);
  });

  it("未声明安全的带值选项：“值像路径”时取消并保留取值（形状规则）", () => {
    const plan = planReadOnly(argvOf("cat", "--out=.env", "in.txt"), [profile({ argv: ["cat"] })]);
    expect(plan?.cancel).toBe("option-path-value:--out");
    expect(plan?.optionPathValues).toEqual([".env"]);
  });

  it("值不像路径的带值选项不会取消（`--output=out.txt` 是已知残余面，因此内置 git 档案用 unsafeOptions 封死）", () => {
    // 形状规则只能看“像不像路径”，所以 `out.txt` 不在它的射程内；这条用例同时固定两件事：
    // 残余面真实存在，以及声明 unsafeOptions 后它会被封住。
    expect(
      planReadOnly(argvOf("cat", "--output=out.txt", "in.txt"), [profile({ argv: ["cat"] })])
        ?.cancel,
    ).toBeUndefined();
    expect(
      planReadOnly(argvOf("git", "diff", "--output=out.txt"), [
        profile({ argv: ["git", "diff"], unsafeOptions: ["--output"] }),
      ])?.cancel,
    ).toBe("unsafe-option:--output");
  });

  it("选项名本身动态时无法比对名单，按取消处理", () => {
    const argv = argvOf("rg", "--$OPT", "x", "src");
    const dynamic = argv.tokens[0] as ArgvToken;
    dynamic.dynamic = true;
    expect(planReadOnly(argv, [profile()])?.cancel).toBe("option-not-allowed:--$OPT");
  });

  it("取消原因只记第一个：先出现的更具体（避免被后面的覆盖）", () => {
    const plan = planReadOnly(argvOf("rg", "--pre=x", "--unknown=y", "x"), [
      profile({ unsafeOptions: ["--pre"] }),
    ]);
    expect(plan?.cancel).toBe("unsafe-option:--pre");
  });
});

describe("isReadOnlyUnit：命中且通过 + 单元可信 + 没有写路径", () => {
  const readOnlyPlan = planReadOnly(argvOf("cat", "a.txt"), [profile({ argv: ["cat"] })]);

  it("命中且全是读路径时为真", () => {
    expect(
      isReadOnlyUnit({
        plan: readOnlyPlan,
        paths: [makePathTarget("a.txt", "read", "arg", pathOptions)],
      }),
    ).toBe(true);
  });

  it("有写路径时为假（`cat > out.txt`）", () => {
    expect(
      isReadOnlyUnit({
        plan: readOnlyPlan,
        paths: [makePathTarget("out.txt", "write", "redirect", pathOptions)],
      }),
    ).toBe(false);
  });

  it("单元不可信时为假（`cat $f` 不能因为 cat 只读就放行）", () => {
    expect(
      isReadOnlyUnit({
        plan: readOnlyPlan,
        paths: [makePathTarget("$f", "read", "arg", pathOptions)],
        unresolved: "dynamic-path",
      }),
    ).toBe(false);
  });

  it("档案检查未通过时为假（`rg --pre`）", () => {
    const cancelled = planReadOnly(argvOf("rg", "--pre=x", "x"), [
      profile({ unsafeOptions: ["--pre"] }),
    ]);
    expect(isReadOnlyUnit({ plan: cancelled, paths: [] })).toBe(false);
  });

  it("没有命中档案时为假（不在白名单里就没资格免评审）", () => {
    expect(isReadOnlyUnit({ plan: undefined, paths: [] })).toBe(false);
  });
});
