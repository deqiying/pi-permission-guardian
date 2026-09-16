import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const GUARDIAN_EVENTS = [
  "session_start",
  "before_agent_start",
  "turn_start",
  "tool_call",
  "tool_result",
  "user_bash",
  "session_shutdown",
] as const;

export const GUARDIAN_COMMAND = "perm";
export const GUARDIAN_FLAG = "perm";

const inertHandler = (): undefined => undefined;
const commandHandler = async (): Promise<void> => {};

export function registerGuardian(pi: ExtensionAPI): void {
  // M0 wires inert hooks only. Later milestones replace these with the real
  // lifecycle, decision and user_bash handlers without changing the entry point.
  pi.on("session_start", inertHandler);
  pi.on("before_agent_start", inertHandler);
  pi.on("turn_start", inertHandler);
  pi.on("tool_call", inertHandler);
  pi.on("tool_result", inertHandler);
  pi.on("user_bash", inertHandler);
  pi.on("session_shutdown", inertHandler);

  pi.registerCommand(GUARDIAN_COMMAND, {
    description: "管理 pi-permission-guardian",
    handler: commandHandler,
  });

  pi.registerFlag(GUARDIAN_FLAG, {
    description: "启动时启用 pi-permission-guardian",
    type: "boolean",
    default: false,
  });
}
