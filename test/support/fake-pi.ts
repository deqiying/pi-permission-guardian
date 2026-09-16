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
  eventCalls: Array<{
    event: string;
    payload: unknown;
    result: unknown;
  }>;
  fire(event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown>;
  invokeCommand(
    name: string,
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void>;
}

export function createFakePi(): ExtensionAPI & FakePi {
  const handlers = new Map<string, RecordedHandler[]>();
  const commands = new Map<string, CommandOptions>();
  const flags = new Map<string, FlagOptions>();
  const flagValues = new Map<string, boolean | string | undefined>();
  const eventCalls: FakePi["eventCalls"] = [];

  const fake = {
    handlers,
    commands,
    flags,
    eventCalls,
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
      flagValues.set(name, options.default);
    },
    getFlag(name: string): boolean | string | undefined {
      return flagValues.get(name);
    },
  };

  return fake as unknown as ExtensionAPI & FakePi;
}
