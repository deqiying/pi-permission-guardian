import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
    find(provider: string, modelId: string): undefined {
      modelRegistryCalls.find.push({ provider, modelId });
      return undefined;
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
