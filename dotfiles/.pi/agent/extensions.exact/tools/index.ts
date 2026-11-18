import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentToolResult,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import {
  createGuardrailsAPI,
  normalizeToolPath,
  type GuardedToolRequest,
  type GuardrailsAPI,
} from "../guardrails/api.ts";
import { registerCodemode } from "./codemode.ts";
import { rewriteBashCommand } from "./rtk.ts";

export default function toolsExtension(pi: ExtensionAPI, configPath?: string): void {
  const { guardrails, initializationError } = initializeGuardrails(pi, configPath);
  registerCodemode(pi);
  const cwd = process.cwd();
  const bash = createBashTool(cwd);
  const definitions = [
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
    bash,
  ];
  for (const definition of definitions) {
    const execute = createGuardedExecutor(definition, guardrails, cwd, initializationError);
    registerGuardedTool(pi, definition, execute);
  }
}

type GuardedExecutor = (
  request: Omit<GuardedToolRequest, "toolName" | "executor">,
) => Promise<AgentToolResult<unknown>>;

function createGuardedExecutor(
  definition: ToolDefinition,
  guardrails: GuardrailsAPI,
  cwd: string,
  initializationError: unknown,
): GuardedExecutor {
  return async function execute(request) {
    const path = initializationError === undefined ? request.params.path : undefined;
    const executor =
      initializationError === undefined &&
      definition.name === "read" &&
      typeof path === "string" &&
      basename(resolve(cwd, normalizeToolPath(path))) === "SKILL.md"
        ? { entrypoint: fileURLToPath(new URL("./full-read.ts", import.meta.url)) }
        : undefined;
    return guardrails.execute({
      ...request,
      executor,
      toolName: definition.name,
    });
  };
}

function registerGuardedTool(
  pi: ExtensionAPI,
  definition: ToolDefinition,
  execute: GuardedExecutor,
): void {
  pi.registerTool({
    ...definition,
    description: definition.description + (TOOL_GUIDANCE[definition.name] ?? ""),
    ...(definition.name === "edit" ? { renderShell: "default" as const } : {}),
    async execute(id, params, signal, onUpdate, context) {
      const input = params as Record<string, unknown>;
      const guardedParams =
        definition.name === "bash" && typeof input.command === "string"
          ? { ...input, command: await rewriteBashCommand(input.command, context, signal) }
          : input;
      return execute({ id, params: guardedParams, signal, onUpdate, context });
    },
  });
}

function initializeGuardrails(
  pi: ExtensionAPI,
  configPath?: string,
): { guardrails: GuardrailsAPI; initializationError?: unknown } {
  try {
    return { guardrails: createGuardrailsAPI(pi, configPath) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pi.on("session_start", (_event, context) => {
      context.ui.notify(message, "error");
    });
    return {
      initializationError: error,
      guardrails: {
        async execute() {
          throw error;
        },
      },
    };
  }
}

const TOOL_GUIDANCE: Record<string, string> = {
  read: " Image files are returned as Vision input when the current model supports image input. A model without image input gets an error that directs delegation to the vision agent instead.",
  write:
    " Writing to a path whose effective action is ask or unset prompts the user for permission. Explicit deny and credentials paths are rejected without a prompt. Approval updates Guardrails write permissions for the selected scope for the rest of the session. All tools using those permissions share the grant. Explicit deny and credentials remain protected.",
  edit: " Editing a path whose effective action is ask or unset prompts the user for permission. Explicit deny and credentials paths are rejected without a prompt. Approval updates Guardrails write permissions for the selected scope for the rest of the session. All tools using those permissions share the grant. Explicit deny and credentials remain protected.",
  bash: ' The filesystem is sandboxed: writes outside approved paths fail with "Read-only file system". Do not retry such commands with bash. Request access with ask_permission only for paths whose effective write action is ask or unset; explicit deny and credentials paths cannot be granted. Approval updates Guardrails write permissions for the approved scope for all tools using those permissions; explicit deny and credentials remain protected. Commands rejected with "Command requires a reason" must be re-requested via ask_permission with that exact command and a reason; do not rewrite them to bypass the gate.',
};
