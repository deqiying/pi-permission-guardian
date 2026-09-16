import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface FakeUiCalls {
  notifications: Array<{
    message: string;
    type: "info" | "warning" | "error" | undefined;
  }>;
  statuses: Array<{
    key: string;
    text: string | undefined;
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
  };
  const modelRegistryCalls: FakeModelRegistryCalls = {
    find: [],
    complete: [],
  };

  const ui = {
    async select(): Promise<string | undefined> {
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
    getEntries: (): [] => [],
    getTree: (): [] => [],
    getSessionName: (): undefined => undefined,
  };

  const modelRegistry = {
    find(provider: string, modelId: string): { api: string } | undefined {
      modelRegistryCalls.find.push({ provider, modelId });
      return options.models?.[`${provider}/${modelId}`];
    },
    async complete(...args: unknown[]): Promise<never> {
      modelRegistryCalls.complete.push(args);
      throw new Error("Fake model registry does not implement complete()");
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
    signal: undefined,
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
