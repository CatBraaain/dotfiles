/**
 * Subagent Tool - Spawn an isolated child pi process
 *
 * Spawns a single `pi` process to run one task in its own context window.
 * The child's thinking streams to the user (onUpdate); only the child's
 * final text is returned to the parent. Cancellation propagates: SIGTERM,
 * then SIGKILL after 5s.
 *
 * Single mode only. The child keeps the parent's skill auto-discovery; model
 * override is supported.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const COLLAPSED_ITEM_COUNT = 10;

// ponytail: spawn is injectable so unit tests can fake the child process.
// bun:test `mock.module` only takes effect under `bun test`, not `bun run`,
// so a plain swappable reference is the minimal reliable seam.
export const __spawn: { current: typeof spawn } = { current: spawn };

/**
 * Generic one-line preview of a tool call: `toolName {args json}`. Every
 * tool renders the same way — there is no per-tool formatting.
 */
export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: any, text: string) => string,
): string {
  const argsStr = JSON.stringify(args);
  const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
  return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
}

/** Model override applied to the spawned task. */
export interface TaskConfig {
  model?: string;
}

interface SingleResult {
  label: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

interface SubagentDetails {
  results: SingleResult[];
}

/** Label for a child run: the model name when given, else a generic "task". */
export function deriveLabel(config: TaskConfig): string {
  return config.model ?? "task";
}

function textPart(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function isFailedResult(result: SingleResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall")
          items.push({ type: "toolCall", name: part.name, args: part.arguments });
      }
    }
  }
  return items;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
  defaultCwd: string,
  config: TaskConfig,
  task: string,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
): Promise<SingleResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (config.model) args.push("--model", config.model);
  args.push(`Task: ${task}`);

  const currentResult: SingleResult = {
    label: deriveLabel(config),
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    model: config.model,
  };

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [textPart(getFinalOutput(currentResult.messages) || "(running...)")],
        details: { results: [currentResult] },
      });
    }
  };

  let wasAborted = false;
  const exitCode = await new Promise<number>((resolve) => {
    const invocation = getPiInvocation(args);
    const proc = __spawn.current(invocation.command, invocation.args, {
      cwd: cwd ?? defaultCwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        currentResult.messages.push(msg);
        if (msg.role === "assistant") {
          if (!currentResult.model && msg.model) currentResult.model = msg.model;
          if (msg.stopReason) currentResult.stopReason = msg.stopReason;
          if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
        }
        emitUpdate();
      }

      if (event.type === "tool_result_end" && event.message) {
        currentResult.messages.push(event.message as Message);
        emitUpdate();
      }
    };

    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data) => {
      currentResult.stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (buffer.trim()) processLine(buffer);
      resolve(code ?? 0);
    });

    proc.on("error", () => {
      resolve(1);
    });

    if (signal) {
      const killProc = () => {
        wasAborted = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal.aborted) killProc();
      else signal.addEventListener("abort", killProc, { once: true });
    }
  });

  currentResult.exitCode = exitCode;
  if (wasAborted) throw new Error("Subagent was aborted");
  return currentResult;
}

const SubagentParams = Type.Object({
  task: Type.String({ description: "Task to delegate to the child process" }),
  model: Type.Optional(
    Type.String({ description: "Model override passed via --model. Optional." }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the child process. Defaults to the parent's cwd.",
    }),
  ),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Spawn an isolated child pi process to run a task with its own context window.",
      "Option: model (--model). The child keeps the parent's skill auto-discovery.",
      "Cancellation (Ctrl+C) propagates to kill the child process.",
    ].join(" "),
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config: TaskConfig = { model: params.model };

      if (!params.task) {
        return {
          content: [textPart("Invalid parameters. Provide a task.")],
          details: { results: [] },
        };
      }

      const result = await runSingleAgent(
        ctx.cwd,
        config,
        params.task,
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

    renderCall(args, theme, _context) {
      const optsTag = args.model ? theme.fg("muted", ` [${theme.fg("dim", args.model)}]`) : "";
      const preview = args.task
        ? args.task.length > 60
          ? `${args.task.slice(0, 60)}...`
          : args.task
        : "...";
      let text =
        theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", "single") + optsTag;
      text += `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const fallback = result.content[0];
        return new Text(fallback?.type === "text" ? fallback.text : "(no output)", 0, 0);
      }

      const mdTheme = getMarkdownTheme();
      const r = details.results[0];
      const isError = isFailedResult(r);
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const displayItems = getDisplayItems(r.messages);
      const finalOutput = getFinalOutput(r.messages);

      const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
        const toShow = limit ? items.slice(-limit) : items;
        const skipped = limit && items.length > limit ? items.length - limit : 0;
        let text = "";
        if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
        for (const item of toShow) {
          if (item.type === "text") {
            const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
            text += `${theme.fg("toolOutput", preview)}\n`;
          } else {
            text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
          }
        }
        return text.trimEnd();
      };

      if (expanded) {
        const container = new Container();
        let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.label))}`;
        if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
        container.addChild(new Text(header, 0, 0));
        if (isError && r.errorMessage)
          container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
        container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
        if (displayItems.length === 0 && !finalOutput) {
          container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
        } else {
          for (const item of displayItems) {
            if (item.type === "toolCall")
              container.addChild(
                new Text(
                  theme.fg("muted", "→ ") +
                    formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                  0,
                  0,
                ),
              );
          }
          if (finalOutput) {
            container.addChild(new Spacer(1));
            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
          }
        }
        return container;
      }

      let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.label))}`;
      if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
      if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
      else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
      else {
        text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
        if (displayItems.length > COLLAPSED_ITEM_COUNT)
          text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
      }
      return new Text(text, 0, 0);
    },
  });
}
