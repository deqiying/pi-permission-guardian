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
  unresolved?: UnresolvedCause;
  /** 命中只读命令白名单且没有写副作用（FR-9），命中即可免评审放行。 */
  readOnly: boolean;
}

export interface Facts {
  /**
   * 需要参与规则求值的 surface 列表：工具面 + 由路径派生的方向面
   * （`path_read` / `external_directory_write` 等）。`*` 兜底面由 M3 追加。
   */
  surfaces: string[];
  commands: CommandUnit[];
  paths: PathTarget[];
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
}
