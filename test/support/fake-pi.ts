import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type RecordedHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => unknown;

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type FlagOptions = Parameters<ExtensionAPI["registerFlag"]>[1];

export interface FakePi {
  handlers: Map<string, RecordedHandler[]>;
  commands: Map<string, CommandOptions>;
  flags: Map<string, FlagOptions>;
  /** `pi.appendEntry` 收到的会话内记录（FR-45）。 */
  entries: Array<{ customType: string; data: unknown }>;
  /** 共存声明频道收到的消息（FR-60）。 */
  eventBusMessages: Array<{ channel: string; data: unknown }>;
  eventCalls: Array<{
    event: string;
    payload: unknown;
    result: unknown;
  }>;
  fire(event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown>;
  /** 模拟外部往事件总线发消息（其他扩展的 `user_bash` 声明）。 */
  emitOnBus(channel: string, data: unknown): void;
  invokeCommand(
    name: string,
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void>;
  /** 模拟命令行传入的 flag（例如 `--perm`）。 */
  setFlag(name: string, value: boolean | string | undefined): void;
}

export function createFakePi(): ExtensionAPI & FakePi {
  const handlers = new Map<string, RecordedHandler[]>();
  const commands = new Map<string, CommandOptions>();
  const flags = new Map<string, FlagOptions>();
  const flagValues = new Map<string, boolean | string | undefined>();
  const eventCalls: FakePi["eventCalls"] = [];
  const entries: FakePi["entries"] = [];
  const busHandlers = new Map<string, Array<(data: unknown) => void>>();
  const eventBusMessages: FakePi["eventBusMessages"] = [];

  const fake = {
    handlers,
    commands,
    flags,
    entries,
    eventBusMessages,
    eventCalls,
    events: {
      emit(channel: string, data: unknown): void {
        eventBusMessages.push({ channel, data });
        for (const handler of busHandlers.get(channel) ?? []) {
          handler(data);
        }
      },
      on(channel: string, handler: (data: unknown) => void): () => void {
        const list = busHandlers.get(channel) ?? [];
        list.push(handler);
        busHandlers.set(channel, list);
        return (): void => {
          const current = busHandlers.get(channel) ?? [];
          busHandlers.set(
            channel,
            current.filter((entry) => entry !== handler),
          );
        };
      },
    },
    emitOnBus(channel: string, data: unknown): void {
      for (const handler of busHandlers.get(channel) ?? []) {
        handler(data);
      }
    },
    async fire(
      event: string,
      payload: unknown,
      ctx: ExtensionContext,
    ): Promise<unknown> {
      const eventHandlers = handlers.get(event);
      if (eventHandlers === undefined || eventHandlers.length === 0) {
        throw new Error(`No handler registered for event "${event}"`);
      }

      let result: unknown;
      for (const handler of eventHandlers) {
        const current = await handler(payload, ctx);
        if (current !== undefined) {
          result = current;
        }
      }
      eventCalls.push({ event, payload, result });
      return result;
    },
    async invokeCommand(
      name: string,
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const command = commands.get(name);
      if (command === undefined) {
        throw new Error(`No command registered for "${name}"`);
      }
      await command.handler(args, ctx);
    },
    on(event: string, handler: RecordedHandler): void {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerCommand(name: string, options: CommandOptions): void {
      commands.set(name, options);
    },
    registerFlag(name: string, options: FlagOptions): void {
      flags.set(name, options);
      if (!flagValues.has(name)) {
        flagValues.set(name, options.default);
      }
    },
    setFlag(name: string, value: boolean | string | undefined): void {
      flagValues.set(name, value);
    },
    getFlag(name: string): boolean | string | undefined {
      return flagValues.get(name);
    },
    appendEntry(customType: string, data?: unknown): void {
      entries.push({ customType, data });
    },
  };

  return fake as unknown as ExtensionAPI & FakePi;
}
