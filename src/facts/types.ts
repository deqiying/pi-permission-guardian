/**
 * 事实层类型（architecture §5）。
 *
 * 事实层是纯函数：输入 = 工具名 + 原始输入 + 一份**显式**上下文（cwd / home / platform /
 * roots / 只读白名单），输出 = 可序列化的 facts。它不读配置、不碰 UI、不调用模型，
 * 因此可以用语料离线单测（architecture §2.1 的依赖边界）。
 */

/** 路径的读写方向。同一个路径在两个方向上独立裁决。 */
export type Direction = "read" | "write";

/**
 * facts 不可信的原因。
 *
 * 每一个都对应一种"静态上无法得出安全结论"的情形，由 M3 统一映射到 `onUnresolvedFacts`；
 * 但明确 `deny` 的优先级更高（FR-61）。
 */
export type UnresolvedCause =
  /** tree-sitter 报错，或解析结果含 ERROR / missing 节点。 */
  | "parse-error"
  /** `bash -c` / `eval` / `source` 等内部不可静态展开。 */
  | "opaque-wrapper"
  /** `sudo` / `xargs` / `env` / `find -exec` 等间接执行。 */
  | "indirection-wrapper"
  /** 路径非字面量（`$DIR/file`、命令替换结果、参数拼接）。 */
  | "dynamic-path"
  /** `<>`：语法上不区分读写，方向不可证（FR-13）。 */
  | "ambiguous-direction"
  /** 该语言的解析器不存在（PowerShell 在 v1 没有解析器）：整条命令无法静态展开。 */
  | "unparsed-language"
  /** 解析器本身不可用（WASM 加载失败）：基础设施故障，与"语言不支持"必须区分。 */
  | "parser-unavailable";

export type PathSource = "arg" | "redirect" | "tool-input";

export interface PathTarget {
  /**
   * 已展开、去引号后的字面文本（不再做归一）。审计与语料断言以它为准，
   * 例如 `cat "$HOME/.x"` 的 `raw` 是 `/home/u/.x` 而不是原文。动态路径时它就是唯一可靠信息。
   */
  raw: string;
  /**
   * 词法归一形：展开 `~` / `$HOME` / `$PWD`、统一分隔符、折叠 `.` / `..`，
   * 相对路径按 cwd 展开。
   *
   * 动态路径（`$DIR/x`）无法归一，此时 `lexical` 保持字面文本，且所属 command unit 必带
   * `unresolved`——M3 不得把它当作真实路径去匹配外部目录。
   */
  lexical: string;
  /** 符号链接解析后的真实路径；解析失败则缺省（FR-16 的双形匹配只保证 lexical 必有）。 */
  canonical?: string;
  direction: Direction;
  source: PathSource;
  /** 是否落在允许根目录（cwd + `workingDirectory.allowRoots`）之外。 */
  external: boolean;
}

export interface CommandUnit {
  /** 用于 `bash` 面规则匹配的文本（可执行名 + 参数，含包装器前缀）。 */
  text: string;
  /** 可执行文件 basename；无法确定时缺省。 */
  executable?: string;
  paths: PathTarget[];
  viaWrapper?: "opaque" | "indirection";
  /**
   * 透明前缀内推（FR-12 修订）时内层命令的文本（`timeout 5 cat f` → `cat f`）。
   *
   * 它作为规则匹配的**额外目标**，因此外层包装不会让 `rm -rf` 这类用户规则失效；
   * 与 `viaWrapper` 互斥：内推成功就不再是不透明对象。
   */
  unwrappedText?: string;
  unresolved?: UnresolvedCause;
  /** 命中只读命令档案且没有写副作用（FR-9 / FR-65），命中即可免评审放行。 */
  readOnly: boolean;
  /**
   * 命中了档案但免评审被取消的原因（FR-69），格式 `kind` 或 `kind:detail`。
   *
   * 与 `readOnly=false` 的区别：`readOnly=false && readOnlyCancel === undefined` 表示
   * “没有命中任何档案”（本来就不在白名单里），有 `readOnlyCancel` 才说明“本来能免评审，但被这条挡住了”。
   */
  readOnlyCancel?: string;
}

/** 只读档案里位置参数的角色（FR-65）。 */
export type ReadOnlyRole =
  /** 搜索模式、正则等“不是文件”的取值：不产出路径目标，动态取值也不影响免评审。 */
  | "pattern"
  /** 文件/目录路径：产出 read 方向的路径目标；动态取值时必须降级。 */
  | "paths"
  /** 一段**脚本代码**（如 `sed` 的程序体）：必须整体命中 `script` 模式集，否则取消免评审。 */
  | "script";

/**
 * 一条只读命令档案（FR-65）。
 *
 * 字符串形态（旧的 `readOnlyCommands` 条目）等价于 `{ argv: [...], roles: ["paths"] }`，
 * 因此旧配置的语义完全保留。字段全部可选的部分含义是“缺省即旧行为”。
 */
export interface ReadOnlyCommandProfile {
  /** argv 前缀（可执行名 + 参数），与旧白名单条目同语义：“可执行名 + 参数前缀”。 */
  argv: readonly string[];
  /** 位置参数角色序列；缺省 `["paths"]`。最后一项吸收剩余位置参数。 */
  roles?: readonly ReadOnlyRole[];
  /** `script` 角色必须整体命中的正则集合（白名单式：不匹配即取消）。 */
  script?: readonly string[];
  /** 选项策略；缺省 `deny-list`（未列出的选项默认安全）。 */
  optionPolicy?: "deny-list" | "allow-list";
  /** allow-list 下视为安全的选项；在 deny-list 下同时豁免“值像路径的 `--opt=value`”。 */
  safeOptions?: readonly string[];
  /** 命中即取消免评审的选项（写文件、执行程序、改工作目录）。按词前缀匹配。 */
  unsafeOptions?: readonly string[];
  /** 档案来源：内置分组名 / `user` / `readOnlyCommands`（旧键展开）。用于审计展示。 */
  group?: string;
  /**
   * 免评审要求**目标必须在项目根目录内**（缺省 `false`）。
   *
   * 用于 `cd` / `pushd` 这类“去哪里”的命令：进项目内部目录是只读操作，出到项目外
   * （`cd /tmp`、`cd ~`、`cd ..`）就不是。要求同时满足“**至少一个位置参数**”与“**全部路径目标都非
   * external**”；`cd` 无参数 = 回家目录、`popd` 的目标在栈顶不可知，两者都不满足。
   */
  onlyWithinRoots?: boolean;
  /** 给人看的依据，展示在审计与人工确认提示里。 */
  reason?: string;
}

export interface Facts {
  /**
   * 需要参与规则求值的 surface 列表：工具面 + 由路径派生的方向面
   * （`path_read` / `external_directory_write` 等）。`*` 兜底面由 M3 追加。
   */
  surfaces: string[];
  commands: CommandUnit[];
  paths: PathTarget[];
  /**
   * 调用级匹配目标：容器节点的规范化文本（整条命令、管道、`&&`/`||`/`;` 序列、子 shell、
   * 命令替换……）。M3 的规则匹配目标是 `commands[].text` 与这里的并集，
   * 使 `curl * | sh` 这类跨单元模式能命中（FR-62）。只有命令类 surface 会提供。
   */
  compositeTexts?: string[];
  /** 整体不可信时的原因（取最保守的一个）。 */
  unresolved?: UnresolvedCause;
  /** 具体哪些命令单元不可信，便于评审提示词与日志定位。 */
  unresolvedAt?: string[];
}

/** 事实层运行所需的上下文。全部来自配置与会话，事实层自己不读配置。 */
export interface FactsContext {
  /** 会话工作目录，相对路径以此为基准展开。 */
  cwd: string;
  platform: NodeJS.Platform;
  /** 用户主目录，用于展开 `~` / `$HOME`。 */
  home: string;
  /** 允许根目录（cwd + `allowRoots`），用于判定路径是否属于外部目录。 */
  roots: string[];
  /** 只读命令白名单（FR-9）；空数组表示关闭白名单。 */
  readOnlyCommands: string[];
  /**
   * 结构化只读档案（FR-65）；缺省表示只有 `readOnlyCommands` 的旧口径。
   *
   * 由配置层展开（内置分组 + 用户条目 + 旧键等价档案），事实层只按它判定，不读配置。
   */
  readOnlyProfiles?: readonly ReadOnlyCommandProfile[];
  /** 写入这些**额外**目标不算写副作用（FR-67）；内置空设备由事实层按平台补充。 */
  writeSinks?: readonly string[];
}
