import type {
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export interface FakeUiCalls {
  notifications: Array<{
    message: string;
    type: "info" | "warning" | "error" | undefined;
  }>;
  statuses: Array<{
    key: string;
    text: string | undefined;
  }>;
  /** `ui.select` 收到的对话框（标题与选项），供断言人工确认的内文（FR-29/30）。 */
  selects: Array<{
    title: string;
    options: string[];
  }>;
}

export interface FakeModelRegistryCalls {
  find: Array<{
    provider: string;
    modelId: string;
  }>;
  complete: unknown[];
}

export interface FakeContext extends ExtensionContext {
  uiCalls: FakeUiCalls;
  modelRegistryCalls: FakeModelRegistryCalls;
}

export interface FakeContextOptions {
  cwd?: string;
  sessionId?: string;
  hasUI?: boolean;
  projectTrusted?: boolean;
  selectResult?: string;
  confirmResult?: boolean;
  inputResult?: string;
  /** 供 `modelRegistry.find` 命中，键为 `provider/model-id`。 */
  models?: Record<string, { api: string }>;
  /** 会话条目，供评审 transcript 使用（FR-20）。 */
  entries?: readonly SessionEntry[];
  /** `modelRegistry.complete` 的实现；缺省直接报错，避免测试意外走到真实评审。 */
  complete?: (
    model: unknown,
    context: unknown,
    options: unknown,
  ) => Promise<AssistantMessage>;
  /** 当前流的中断信号（FR-25）。 */
  signal?: AbortSignal;
}

const noop = (): void => {};

export function createFakeContext(
  options: FakeContextOptions = {},
): FakeContext {
  const cwd = options.cwd ?? process.cwd();
  const sessionId = options.sessionId ?? "fake-session";
  const hasUI = options.hasUI ?? false;
  const uiCalls: FakeUiCalls = {
    notifications: [],
    statuses: [],
    selects: [],
  };
  const modelRegistryCalls: FakeModelRegistryCalls = {
    find: [],
    complete: [],
  };

  const ui = {
    async select(title: string, choices: string[]): Promise<string | undefined> {
      uiCalls.selects.push({ title, options: choices });
      return options.selectResult;
    },
    async confirm(): Promise<boolean> {
      return options.confirmResult ?? false;
    },
    async input(): Promise<string | undefined> {
      return options.inputResult;
    },
    notify(
      message: string,
      type?: "info" | "warning" | "error",
    ): void {
      uiCalls.notifications.push({ message, type });
    },
    onTerminalInput(): () => void {
      return noop;
    },
    setStatus(key: string, text: string | undefined): void {
      uiCalls.statuses.push({ key, text });
    },
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    async custom(): Promise<never> {
      throw new Error("Fake UI does not implement custom components");
    },
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText: (): string => "",
    async editor(): Promise<string | undefined> {
      return undefined;
    },
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: (): undefined => undefined,
    get theme(): never {
      throw new Error("Fake UI has no theme");
    },
    getAllThemes: (): [] => [],
    getTheme: (): undefined => undefined,
    setTheme: (): { success: boolean } => ({ success: false }),
    getToolsExpanded: (): boolean => false,
    setToolsExpanded: noop,
  };

  const sessionManager = {
    getCwd: (): string => cwd,
    getSessionDir: (): string => cwd,
    getSessionId: (): string => sessionId,
    getSessionFile: (): undefined => undefined,
    getLeafId: (): undefined => undefined,
    getLeafEntry: (): undefined => undefined,
    getEntry: (): undefined => undefined,
    getLabel: (): undefined => undefined,
    getBranch: (): [] => [],
    buildContextEntries: (): [] => [],
    getHeader: (): undefined => undefined,
    getEntries: (): readonly SessionEntry[] => options.entries ?? [],
    getTree: (): [] => [],
    getSessionName: (): undefined => undefined,
  };

  const modelRegistry = {
    find(provider: string, modelId: string): { provider: string; id: string; api: string } | undefined {
      modelRegistryCalls.find.push({ provider, modelId });
      const entry = options.models?.[`${provider}/${modelId}`];
      return entry === undefined ? undefined : { provider, id: modelId, api: entry.api };
    },
    async complete(model: unknown, context: unknown, opts: unknown): Promise<AssistantMessage> {
      modelRegistryCalls.complete.push([model, context, opts]);
      if (options.complete === undefined) {
        throw new Error("Fake model registry does not implement complete()");
      }
      return options.complete(model, context, opts);
    },
  };

  const context = {
    ui,
    mode: hasUI ? "tui" : "print",
    hasUI,
    cwd,
    sessionManager,
    modelRegistry,
    model: undefined,
    scopedModels: [],
    isIdle: (): boolean => true,
    isProjectTrusted: (): boolean => options.projectTrusted ?? false,
    signal: options.signal,
    abort: noop,
    hasPendingMessages: (): boolean => false,
    shutdown: noop,
    getContextUsage: (): undefined => undefined,
    compact: noop,
    getSystemPrompt: (): string => "",
    uiCalls,
    modelRegistryCalls,
  };

  return context as unknown as FakeContext;
}

/**
 * 命令处理器需要的 `ExtensionCommandContext`。
 *
 * 扩展自己的命令只用 `ui` / `modelRegistry` / `cwd` / `isProjectTrusted`，其余会话控制方法给出桩实现，
 * 保证测试不会意外触发真实会话切换。
 */
export function createFakeCommandContext(
  options: FakeContextOptions = {},
): FakeContext {
  const context = createFakeContext(options);
  const stub = async (): Promise<{ cancelled: boolean }> => ({ cancelled: false });
  const extra: Partial<ExtensionCommandContext> = {
    getSystemPromptOptions: (): never => {
      throw new Error("Fake command context does not implement prompts");
    },
    waitForIdle: async (): Promise<void> => {},
    newSession: stub,
    fork: stub,
    navigateTree: stub,
    switchSession: stub,
    reload: async (): Promise<void> => {},
  };
  return Object.assign(context, extra) as FakeContext;
}
