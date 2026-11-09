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
import { Value } from "typebox/value";
import {
  createGuardrailsAPI,
  normalizeToolPath,
  type GuardedToolRequest,
  type GuardrailsAPI,
} from "../guardrails/api.ts";
import { registerBackgroundBash } from "./background-bash.ts";
import { registerCodemode } from "./codemode.ts";

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
    if (definition.name !== "bash") continue;

    const backgroundSchema = { ...bash.parameters, additionalProperties: false };
    const dispose = registerBackgroundBash(pi.events, async (request) => {
      if (initializationError !== undefined) throw initializationError;
      if (!Value.Check(backgroundSchema, request.params))
        throw new Error("Invalid background Bash arguments: expected command and optional timeout");
      return execute({
        id: request.id,
        params: request.params,
        context: { ...request.context, hasUI: false },
        signal: request.signal,
        approvalMode: "existing-only",
      });
    });
    pi.on("session_shutdown", dispose);
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
      return execute({ id, params: params as Record<string, unknown>, signal, onUpdate, context });
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
    " Writing to a path whose effective action is ask or unset prompts the user for permission. Explicit deny and credentials paths are rejected without a prompt. Once approved, the path becomes writable for the rest of the session. Paths resolving to ask in the config stay read-only in the bash sandbox.",
  edit: " Editing a path whose effective action is ask or unset prompts the user for permission. Explicit deny and credentials paths are rejected without a prompt. Once approved, the path becomes writable for the rest of the session. Paths resolving to ask in the config stay read-only in the bash sandbox.",
  bash: ' The filesystem is sandboxed: writes outside approved paths fail with "Read-only file system". Do not retry such commands with bash. Request access with ask_permission only for paths whose effective write action is ask or unset; explicit deny and credentials paths cannot be granted. Respect whether the permission result allows bash writes. Commands rejected with "Command requires a reason" must be re-requested via ask_permission with that exact command and a reason; do not rewrite them to bypass the gate.',
};
