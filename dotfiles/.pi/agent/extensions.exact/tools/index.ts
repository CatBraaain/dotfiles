import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { createGuardrailsAPI, type GuardrailsAPI } from "../guardrails/api.ts";
import { registerCodemode } from "./codemode.ts";

export default function toolsExtension(pi: ExtensionAPI, configPath?: string): void {
  const guardrails = initializeGuardrails(pi, configPath);
  registerCodemode(pi);
  const cwd = process.cwd();
  const definitions = [
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
    createBashTool(cwd),
  ];
  for (const definition of definitions) registerGuardedTool(pi, definition, guardrails);
}

function registerGuardedTool(
  pi: ExtensionAPI,
  definition: ToolDefinition,
  guardrails: GuardrailsAPI,
): void {
  pi.registerTool({
    ...definition,
    description: definition.description + (TOOL_GUIDANCE[definition.name] ?? ""),
    ...(definition.name === "edit" ? { renderShell: "default" as const } : {}),
    async execute(id, params, signal, onUpdate, context) {
      return guardrails.execute({
        id,
        toolName: definition.name,
        params: params as Record<string, unknown>,
        signal,
        onUpdate,
        context,
      });
    },
  });
}

function initializeGuardrails(pi: ExtensionAPI, configPath?: string): GuardrailsAPI {
  try {
    return createGuardrailsAPI(pi, configPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pi.on("session_start", (_event, context) => {
      context.ui.notify(message, "error");
    });
    return {
      async execute() {
        throw new Error(message);
      },
    };
  }
}

const TOOL_GUIDANCE: Record<string, string> = {
  read: " Image files are returned as Vision input when the current model supports image input. A model without image input gets an error that directs delegation to the vision agent instead.",
  write:
    " Writing to a path whose effective action is ask or unset prompts the user for permission. Explicit deny and credentials paths are rejected without a prompt. Once approved, the path becomes writable for the rest of the session. Paths resolving to ask in the config stay read-only in the bash sandbox.",
  edit: " Editing a path whose effective action is ask or unset prompts the user for permission. Explicit deny and credentials paths are rejected without a prompt. Once approved, the path becomes writable for the rest of the session. Paths resolving to ask in the config stay read-only in the bash sandbox.",
  bash: ' The filesystem is sandboxed: writes outside approved paths fail with "Read-only file system". Do not retry such commands with bash. Request access with ask_permission only for paths whose effective write action is ask or unset; explicit deny and credentials paths cannot be granted. Respect whether the permission result allows bash writes. Commands rejected with "Command requires a reason" must be re-requested via ask_permission with the same command and a reason; do not rewrite them to bypass the gate.',
};
