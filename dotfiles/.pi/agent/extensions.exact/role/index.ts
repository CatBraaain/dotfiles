import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parse as parseYaml } from "yaml";

export type Role = string;

export interface RoleDefinition {
  model: string;
  tools: readonly string[];
  subagents: readonly Role[];
  systemPrompt: string;
}

export interface RoleConfig {
  default: Role;
  roles: Record<Role, RoleDefinition>;
}

export interface ConfigLoadResult {
  config?: RoleConfig;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRoleConfig(source: string): ConfigLoadResult {
  try {
    const document = parseYaml(source) as unknown;
    if (!isRecord(document) || typeof document.default !== "string" || !isRecord(document.roles)) {
      return { error: "default and roles are required" };
    }

    const roles: Record<Role, RoleDefinition> = {};
    for (const [name, rawDefinition] of Object.entries(document.roles)) {
      if (!isRecord(rawDefinition)) return { error: `role ${name} must be an object` };
      const { model, tools, subagents, systemPrompt } = rawDefinition;
      if (typeof model !== "string" || !model)
        return { error: `role ${name} has an invalid model` };
      if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")) {
        return { error: `role ${name} has invalid tools` };
      }
      if (!Array.isArray(subagents) || !subagents.every((role) => typeof role === "string")) {
        return { error: `role ${name} has invalid subagents` };
      }
      if (typeof systemPrompt !== "string")
        return { error: `role ${name} has an invalid systemPrompt` };
      roles[name] = { model, tools, subagents, systemPrompt };
    }

    if (!roles[document.default])
      return { error: `default role ${document.default} is not defined` };
    for (const [name, definition] of Object.entries(roles)) {
      const unknownSubagent = definition.subagents.find((role) => !roles[role]);
      if (unknownSubagent)
        return { error: `role ${name} delegates to undefined role ${unknownSubagent}` };
    }

    return { config: { default: document.default, roles } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function loadRoleConfig(
  configPath = join(getAgentDir(), "extensions", "role", "config.yaml"),
): ConfigLoadResult {
  if (!existsSync(configPath)) return { error: `config file not found: ${configPath}` };
  try {
    return parseRoleConfig(readFileSync(configPath, "utf8"));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function initialRole(config: RoleConfig, requestedRole?: Role): Role {
  return requestedRole && config.roles[requestedRole] ? requestedRole : config.default;
}

export function switchRole(nextRole: Role, config: RoleConfig): Role {
  return config.roles[nextRole] ? nextRole : config.default;
}

export function isToolAllowed(role: Role, toolName: string, config: RoleConfig): boolean {
  if (toolName === "subagent") return true;
  const tools = config.roles[role]?.tools ?? [];
  return tools.includes("*") || tools.includes(toolName);
}

export function shouldBlockToolCall(role: Role, toolName: string, config: RoleConfig): boolean {
  return !isToolAllowed(role, toolName, config);
}

export function buildRoleSystemPromptAddendum(role: Role, config: RoleConfig): string {
  return config.roles[role]?.systemPrompt ? `\n\n${config.roles[role].systemPrompt}` : "";
}

export function canDelegate(fromRole: Role, toRole: Role, config: RoleConfig): boolean {
  return config.roles[fromRole]?.subagents.includes(toRole) ?? false;
}

export function childRole(fromRole: Role, toRole: Role, config: RoleConfig): Role | undefined {
  return canDelegate(fromRole, toRole, config) ? toRole : undefined;
}

export type ChildObservationKind =
  | "progress"
  | "intermediate-log"
  | "final-result"
  | "work-highlights"
  | "artifact-info";

export interface ChildObservation {
  readonly kind: ChildObservationKind;
  readonly content: string;
}

export const PARENT_REPORT_OBSERVATION_KINDS: readonly ChildObservationKind[] = [
  "final-result",
  "work-highlights",
  "artifact-info",
];

export function isOwnerDisplayObservation(observation: ChildObservation): boolean {
  return observation.kind === "progress";
}

export function isParentReportObservation(observation: ChildObservation): boolean {
  return PARENT_REPORT_OBSERVATION_KINDS.includes(observation.kind);
}

export type Principal = Role | "owner";
export type FailureCategory = "permission" | "capacity";
export const FAILURE_CATEGORIES: readonly FailureCategory[] = ["permission", "capacity"];
export const FAILURE_CATEGORY_LABELS: Record<FailureCategory, string> = {
  permission: "権限不足",
  capacity: "力量・情報不足",
};

export function reportDestination(reportingRole: Role, caller: Principal): Principal {
  return reportingRole === "worker" ? caller : "owner";
}

export const __spawn: { current: typeof spawn } = { current: spawn };

export const __abortTimer: {
  set: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clear: (timer: ReturnType<typeof setTimeout>) => void;
} = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (timer) => clearTimeout(timer),
};

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: any, text: string) => string,
): string {
  const argsString = JSON.stringify(args) ?? "{}";
  const preview = argsString.length > 100 ? `${argsString.slice(0, 100)}...` : argsString;
  return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
}

interface ChildAction {
  toolCallId?: string;
  name: string;
  args: Record<string, unknown>;
}

interface ChildRun {
  role: Role;
  task: string;
  exitCode: number;
  messages: Message[];
  actions: ChildAction[];
  stderr: string;
  stopReason?: string;
  errorMessage?: string;
}

interface RoleToolDetails {
  results: ChildRun[];
}

function textPart(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function getFinalOutput(messages: Message[]): string {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

function isFailedResult(result: ChildRun): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: ChildRun): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}


function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const executableName = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executableName)) return { command: process.execPath, args };
  return { command: "pi", args };
}

type OnUpdateCallback = (partialResult: AgentToolResult<RoleToolDetails>) => void;

async function runChild(
  defaultCwd: string,
  task: string,
  role: Role,
  config: RoleConfig,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
): Promise<ChildRun> {
  const roleDefinition = config.roles[role];
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--model",
    roleDefinition.model,
    "--role",
    role,
    `Task: ${task}`,
  ];
  const childResult: ChildRun = { role, task, exitCode: 0, messages: [], actions: [], stderr: "" };
  let wasAborted = false;

  const emitUpdate = () => {
    onUpdate?.({
      content: [textPart(getFinalOutput(childResult.messages) || "(running...)")],
      details: { results: [childResult] },
    });
  };

  const exitCode = await new Promise<number>((resolve) => {
    const invocation = getPiInvocation(args);
    const processHandle = __spawn.current(invocation.command, invocation.args, {
      cwd: cwd ?? defaultCwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let hasClosed = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      signal?.removeEventListener("abort", killChild);
      if (abortTimer !== undefined) {
        __abortTimer.clear(abortTimer);
        abortTimer = undefined;
      }
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.type === "message_end" && event.message) {
        const message = event.message as Message;
        childResult.messages.push(message);
        if (message.role === "assistant") {
          if (message.stopReason) childResult.stopReason = message.stopReason;
          if (message.errorMessage) childResult.errorMessage = message.errorMessage;
        }
        emitUpdate();
      }
      if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
        childResult.actions.push({
          toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
          name: event.toolName,
          args: isRecord(event.args) ? event.args : {},
        });
        emitUpdate();
      }
      if (event.type === "tool_execution_update") emitUpdate();
      if (event.type === "tool_execution_end") emitUpdate();
      if (event.type === "tool_result_end" && event.message) {
        childResult.messages.push(event.message as Message);
        emitUpdate();
      }
    };

    const killChild = () => {
      if (wasAborted) return;
      wasAborted = true;
      processHandle.kill("SIGTERM");
      abortTimer = __abortTimer.set(() => {
        if (!hasClosed) processHandle.kill("SIGKILL");
      }, 5000);
    };

    processHandle.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
    processHandle.stderr.on("data", (data) => {
      childResult.stderr += data.toString();
    });
    processHandle.on("close", (code) => {
      hasClosed = true;
      cleanup();
      if (buffer.trim()) processLine(buffer);
      resolve(code ?? 0);
    });
    processHandle.on("error", () => {
      hasClosed = true;
      cleanup();
      resolve(1);
    });

    if (signal?.aborted) killChild();
    else signal?.addEventListener("abort", killChild, { once: true });
  });

  childResult.exitCode = exitCode;
  if (wasAborted) {
    childResult.stopReason = "aborted";
    childResult.errorMessage = "Subagent was aborted";
  }
  return childResult;
}

function registerRoleWidget(ctx: ExtensionContext, currentRole: () => Role): void {
  ctx.ui.setWidget(
    "role",
    (_ui, theme) => ({
      render: () => [theme.fg("dim", `🤖 role: ${currentRole()}`)],
      invalidate: () => {},
    }),
    { placement: "aboveEditor" },
  );
}

export default function roleExtension(
  pi: ExtensionAPI,
  injectedConfig: ConfigLoadResult = loadRoleConfig(),
): void {
  const loadedConfig = injectedConfig;
  const config = loadedConfig.config;
  let currentRole = config?.default ?? "invalid";

  pi.registerFlag("role", { type: "string", description: "Role for a child session." });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Spawn an isolated child pi process using a configured role.",
    parameters: Type.Object({
      task: Type.String({ description: "Task to delegate to the child process" }),
      role: Type.String({ description: "Configured child role name" }),
      cwd: Type.Optional(
        Type.String({ description: "Working directory; defaults to the parent cwd" }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!config)
        return {
          content: [textPart(`Role configuration error: ${loadedConfig.error}`)],
          details: { results: [] },
          isError: true,
        };
      if (!params.task)
        return {
          content: [textPart("Invalid parameters. Provide a task.")],
          details: { results: [] },
        };
      if (!config.roles[params.role]) {
        return {
          content: [textPart(`Cannot delegate: role ${params.role} is not defined.`)],
          details: { results: [] },
          isError: true,
        };
      }
      if (!canDelegate(currentRole, params.role, config)) {
        return {
          content: [
            textPart(`Permission denied: role ${currentRole} cannot delegate to ${params.role}.`),
          ],
          details: { results: [] },
          isError: true,
        };
      }

      const result = await runChild(
        ctx.cwd,
        params.task,
        params.role,
        config,
        params.cwd,
        signal,
        onUpdate,
      );
      if (isFailedResult(result)) {
        return {
          content: [textPart(`Child ${result.stopReason || "failed"}: ${getResultOutput(result)}`)],
          details: { results: [result] },
          isError: true,
        };
      }
      return {
        content: [textPart(getFinalOutput(result.messages) || "(no output)")],
        details: { results: [result] },
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold(`subagent ${args.role ?? "..."}`)), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as RoleToolDetails | undefined;
      const childResult = details?.results[0];
      if (!childResult) {
        const fallback = result.content[0];
        return new Text(fallback?.type === "text" ? fallback.text : "(no output)", 0, 0);
      }

      const actions = childResult.actions;
      const finalOutput = getFinalOutput(childResult.messages);
      const container = new Container();
      container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
      container.addChild(new Text(theme.fg("dim", childResult.task), 0, 0));
      if (actions.length > 0) {
        container.addChild(new Text(theme.fg("muted", "─── Actions ───"), 0, 0));
        for (const action of actions) {
          container.addChild(
            new Text(
              `${theme.fg("muted", "→ ")}${formatToolCall(action.name, action.args, theme.fg.bind(theme))}`,
              0,
              0,
            ),
          );
        }
      }
      if (finalOutput) {
        container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
        container.addChild(new Markdown(finalOutput.trim(), 0, 0, getMarkdownTheme()));
      }
      return container;
    },
  });

  if (!config) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(`role configuration error: ${loadedConfig.error}`, "error");
    });
    return;
  }

  const activateRole = async (role: Role, ctx: ExtensionContext): Promise<void> => {
    currentRole = switchRole(role, config);
    const roleDefinition = config.roles[currentRole];
    const [provider, ...modelIdParts] = roleDefinition.model.split("/");
    const model = ctx.modelRegistry.find(provider, modelIdParts.join("/"));
    if (model) {
      const modelChanged = await pi.setModel(model);
      if (!modelChanged)
        ctx.ui.notify(
          `model unavailable for role ${currentRole}: ${roleDefinition.model}`,
          "warning",
        );
    } else {
      ctx.ui.notify(`model not found for role ${currentRole}: ${roleDefinition.model}`, "warning");
    }
    const activeTools = roleDefinition.tools.includes("*")
      ? pi.getAllTools().map((tool) => tool.name)
      : [...new Set([...roleDefinition.tools, "subagent"])];
    pi.setActiveTools(activeTools);
    registerRoleWidget(ctx, () => currentRole);
  };

  pi.on("session_start", async (_event, ctx) => {
    await activateRole(initialRole(config, pi.getFlag("role") as string | undefined), ctx);
  });

  pi.on("before_agent_start", async (event) => {
    const addendum = buildRoleSystemPromptAddendum(currentRole, config);
    return addendum ? { systemPrompt: event.systemPrompt + addendum } : undefined;
  });

  pi.on("tool_call", async (event) => {
    if (shouldBlockToolCall(currentRole, event.toolName, config)) {
      return { block: true, reason: `role ${currentRole} cannot use ${event.toolName}` };
    }
  });

  for (const role of Object.keys(config.roles)) {
    pi.registerCommand(`role:${role}`, {
      description: `Switch the session role to ${role}.`,
      handler: async (args, ctx) => {
        await activateRole(role, ctx);
        ctx.ui.notify(`role: ${currentRole}`, "info");
        const followUpMessage = args.trim();
        if (followUpMessage) pi.sendUserMessage(followUpMessage);
      },
    });
  }
}
