import { homedir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { getMarkdownTheme, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  getKeybindings,
  Markdown,
  Spacer,
  Text,
  type Component,
} from "@earendil-works/pi-tui";
import type { AgentToolDetails } from "../agents/index.ts";
import type { WebToolDetails } from "../web-search/index.ts";
import { isHandoffPayload, type HandoffPayload } from "../replace-context/index.ts";
import { spinnerFrame } from "../titlebar/index.ts";
import { spinnerTimers } from "../shared/spinner-timers.ts";
import {
  resultText,
  truncateErrorOutput,
  truncateText,
  type ToolResultLike,
} from "../shared/tool-text.ts";

export type ToolTheme = Pick<Theme, "fg" | "bold">;
export type ToolRenderers = {
  renderShell?: "default" | "self";
  renderCall?: (args: any, theme: any, context: any) => Component;
  renderResult?: (result: any, options: any, theme: any, context: any) => Component;
};
type ToolRendererResolver = (
  toolName: string,
  next: () => ToolRenderers | undefined,
) => ToolRenderers | undefined;
type RendererEntry =
  | ToolRenderers
  | ((next: () => ToolRenderers | undefined) => ToolRenderers | undefined);
type ResultOptions = { expanded: boolean; isPartial: boolean };
type TextDisplay = {
  call(args: any, theme: any, context: any): string;
  result(result: any, options: ResultOptions, theme: any, context: any): string;
};

export const CALL_PREVIEW_LIMIT = 100;
export const ASK_PERMISSION_TARGET_PREVIEW_LIMIT = 80;
export const DENIED_REASON_PREVIEW_LIMIT = 80;
const ERROR_PREVIEW_LINE_LIMIT = 3;
const SESSION_PREVIEW_LIMIT = 40;
const TOOL_LABEL = "[compaction]";
const PENDING_TEXT = "Requesting context replacement...";
const COLLAPSED_TEXT = "Context will be replaced at end of turn";
const EXPAND_KEYBINDING = "app.tools.expand";

const FS_TOOL_NAMES = ["bash", "read", "write", "edit", "grep", "find", "ls", "ask_permission"];
const WEB_DISPLAYS = {
  web_search: { kind: "web-search", source: "engine" },
  web_fetch: { kind: "web-fetch", source: "backend" },
} as const;
const SESSION_DISPLAYS = {
  session_search: { successStatus: "complete", text: allTextContent },
  create_detached_session: { successStatus: "created", text: resultText },
};

const REGISTRY: Record<string, RendererEntry> = {
  ...Object.fromEntries(
    FS_TOOL_NAMES.map((name) => [
      name,
      textRenderers({
        call(args, theme, context) {
          if (
            name === "bash" &&
            context?.state &&
            context.executionStarted &&
            context.state.startedAt === undefined
          ) {
            context.state.startedAt = Date.now();
          }
          return formatToolCall(name, args, context?.cwd ?? process.cwd(), theme);
        },
        result(result, options, theme, context) {
          return formatFsResult(name, result, options, theme, context);
        },
      }),
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(WEB_DISPLAYS).map(([name, display]) => [
      name,
      textRenderers({
        call(args, theme) {
          const input = name === "web_search" ? args.query : args.url;
          const langSuffix = name === "web_search" && args.lang ? ` [lang=${args.lang}]` : "";
          return titleLine(`${name} - "${input ?? ""}"${langSuffix}`, theme);
        },
        result(result, _options, _theme, context) {
          const details = detailsForRender(result, context?.state);
          const failure = failureLine(display.kind, result, details, context?.isError ?? false);
          if (failure) return failure;
          return details ? successLine(details[display.source] ?? "", details) : "";
        },
      }),
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(SESSION_DISPLAYS).map(([name, display]) => [
      name,
      textRenderers({
        call(args, theme) {
          const preview =
            name === "session_search"
              ? (args.action ?? "")
              : truncateText(args.name?.trim() || args.initialRequest, SESSION_PREVIEW_LIMIT);
          return titleLine(`${name} ${preview}`, theme);
        },
        result(result, { expanded, isPartial }, theme, context) {
          const status =
            result.structuredContent?.status ?? (context.isError ? "error" : display.successStatus);
          const summary = isPartial ? "Running..." : `${name}: ${status}`;
          return theme.fg(
            context.isError ? "error" : "toolOutput",
            expanded ? display.text(result) : summary,
          );
        },
      }),
    ]),
  ),
  codemode: codemodeRenderers,
  subagent: subagentRenderers(),
  replace_context: replaceContextRenderers(),
};

export function renderersOf(
  toolName: string,
  next: () => ToolRenderers | undefined = () => undefined,
): ToolRenderers | undefined {
  const entry = Object.hasOwn(REGISTRY, toolName) ? REGISTRY[toolName] : undefined;
  if (entry === undefined) return next();
  return typeof entry === "function" ? entry(next) : entry;
}

export default function (pi: ExtensionAPI) {
  const registerable = pi as ExtensionAPI & {
    registerToolRenderer?: (resolver: ToolRendererResolver) => void;
  };
  registerable.registerToolRenderer?.((toolName, next) => renderersOf(toolName, next));
}

function textRenderers(display: TextDisplay): ToolRenderers {
  return {
    renderCall(args, theme, context) {
      return new Text(display.call(args, theme, context), 0, 0);
    },
    renderResult(result, options, theme, context) {
      return new Text(display.result(result, options, theme, context), 0, 0);
    },
  };
}

function titleLine(text: string, theme: any): string {
  return theme.fg("toolTitle", theme.bold(text));
}

function allTextContent(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function formatFsResult(
  name: string,
  result: any,
  options: ResultOptions,
  theme: any,
  context: any,
): string {
  if (options.isPartial) {
    const progress = name === "bash" ? resultText(result) : "";
    return theme.fg("warning", progress === "" ? "Running..." : progress);
  }
  if (context.isError) return formatToolError(result, theme);
  const state = context.state;
  const durationMs =
    name === "bash" && state?.startedAt !== undefined
      ? (state.endedAt ?? Date.now()) - state.startedAt
      : undefined;
  return formatToolResultSummary(name, context.args ?? {}, result, { durationMs }, theme) ?? "";
}

function formatToolError(result: ToolResultLike, theme: any): string {
  const errorLines = resultText(result).split(/\r?\n/);
  if (errorLines.at(-1) === "") errorLines.pop();
  const preview = errorLines.slice(0, ERROR_PREVIEW_LINE_LIMIT).join("\n");
  const displayText = errorLines.length > ERROR_PREVIEW_LINE_LIMIT ? `${preview}\n…` : preview;
  return theme.fg("error", displayText);
}

export function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

export function countResultLines(text: string): number {
  if (text === "") return 0;
  const trimmed = text.trimEnd();
  return trimmed === "" ? 0 : trimmed.split("\n").length;
}

export function countMatchLines(output: string): number {
  return output.split("\n").filter((line) => /:\d+: /.test(line)).length;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function classifyReadPath(
  args: { path?: unknown },
  cwd: string,
): { kind: "skill"; label: string } | undefined {
  const rawPath = args?.path;
  if (typeof rawPath !== "string" || rawPath === "") return undefined;
  const absolutePath = resolve(cwd, rawPath);
  if (basename(absolutePath) !== "SKILL.md") return undefined;
  return { kind: "skill", label: basename(dirname(absolutePath)) || "SKILL.md" };
}

export function formatBashCall(command: string, theme: ToolTheme): string {
  return `${theme.fg("toolTitle", theme.bold("$ "))}${theme.fg("accent", truncateText(command))}`;
}

export function formatNamedCall(name: string, value: string, theme: ToolTheme): string {
  return `${theme.fg("toolTitle", theme.bold(`${name} `))}${theme.fg("accent", value)}`;
}

export function formatPath(path: string, cwd: string): string {
  const absolutePath = resolve(cwd, path);
  const relativePath = relative(cwd, absolutePath);
  const isOutsideCwd = relativePath === ".." || relativePath.startsWith(`..${sep}`);
  if (!isOutsideCwd) return relativePath ? `./${relativePath}` : ".";

  const homePath = homedir();
  if (absolutePath === homePath) return "~";
  if (absolutePath.startsWith(`${homePath}${sep}`)) {
    return `~${absolutePath.slice(homePath.length)}`;
  }
  return absolutePath;
}

export function formatReadCall(args: { path?: unknown }, cwd: string, theme: ToolTheme): string {
  const skill = classifyReadPath(args, cwd);
  if (skill) {
    return (
      theme.fg("customMessageLabel", "\x1b[1m[skill]\x1b[22m ") +
      theme.fg("customMessageText", skill.label)
    );
  }
  const rawPath = args?.path;
  const pathText = typeof rawPath === "string" ? formatPath(rawPath, cwd) : "";
  return formatNamedCall("read", pathText, theme);
}

export function formatFallbackCall(
  toolName: string,
  args: Record<string, unknown>,
  theme: ToolTheme,
): string {
  const argsString = JSON.stringify(args) ?? "{}";
  const preview =
    argsString.length > CALL_PREVIEW_LIMIT
      ? `${argsString.slice(0, CALL_PREVIEW_LIMIT)}...`
      : argsString;
  return `${theme.fg("toolTitle", theme.bold(toolName))}${theme.fg("dim", ` ${preview}`)}`;
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  theme: ToolTheme,
): string {
  switch (toolName) {
    case "bash":
      return formatBashCall(String(args.command ?? ""), theme);
    case "read":
      return formatReadCall(args, cwd, theme);
    case "write":
      return formatNamedCall("write", formatPath(String(args.path ?? ""), cwd), theme);
    case "edit":
      return formatNamedCall("edit", formatPath(String(args.path ?? ""), cwd), theme);
    case "grep":
      return formatNamedCall(
        "grep",
        `${String(args.pattern ?? "")} in ${formatPath(String(args.path ?? ""), cwd)}`,
        theme,
      );
    case "find":
      return formatNamedCall(
        "find",
        `${String(args.pattern ?? "")} in ${formatPath(String(args.path ?? ""), cwd)}`,
        theme,
      );
    case "ls":
      return formatNamedCall("ls", formatPath(String(args.path ?? ""), cwd), theme);
    case "ask_permission": {
      const target =
        typeof args.command === "string"
          ? truncateText(args.command, ASK_PERMISSION_TARGET_PREVIEW_LIMIT)
          : truncateText(
              formatPath(String(args.path ?? ""), cwd),
              ASK_PERMISSION_TARGET_PREVIEW_LIMIT,
            );
      return formatNamedCall("ask_permission", target, theme);
    }
    default:
      return formatFallbackCall(toolName, args, theme);
  }
}

export function formatToolResultSummary(
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResultLike,
  options: { isError?: boolean; durationMs?: number },
  theme: ToolTheme,
): string | undefined {
  if (options.isError) {
    return theme.fg("error", truncateErrorOutput(resultText(result)));
  }
  switch (toolName) {
    case "bash":
      return theme.fg(
        "success",
        options.durationMs !== undefined ? formatDuration(options.durationMs) : "done",
      );
    case "write": {
      const content = typeof args.content === "string" ? args.content : "";
      return theme.fg("success", `wrote ${formatSize(content.length)}`);
    }
    case "edit": {
      const editCount = Array.isArray(args.edits) ? args.edits.length : 1;
      return theme.fg("success", `edited ${editCount} block(s)`);
    }
    case "read": {
      const hasImage =
        Array.isArray(result.content) &&
        result.content.some((part) => (part as { type: string }).type === "image");
      if (hasImage) return theme.fg("success", "image input");
      return theme.fg("success", `${countResultLines(resultText(result))} lines`);
    }
    case "grep":
      return theme.fg("success", `${countMatchLines(resultText(result))} matches`);
    case "find":
      return theme.fg("success", `${countResultLines(resultText(result))} files`);
    case "ls":
      return theme.fg("success", `${countResultLines(resultText(result))} entries`);
    case "ask_permission": {
      const details = result.details as { status?: string; reason?: string } | undefined;
      const status = details?.status;
      if (status !== "granted" && status !== "denied" && status !== "already granted")
        return undefined;
      const reason = status === "denied" ? details?.reason : undefined;
      if (typeof reason !== "string" || reason === "") return theme.fg("success", status);
      return (
        theme.fg("success", "denied — ") +
        theme.fg("dim", truncateText(reason, DENIED_REASON_PREVIEW_LIMIT))
      );
    }
    default:
      return undefined;
  }
}

type WebRenderState = { details?: WebToolDetails };

function detailsForRender(
  result: { details?: unknown },
  state?: WebRenderState,
): WebToolDetails | undefined {
  const details = result.details as WebToolDetails | undefined;
  const hasDetails = details !== undefined && Object.keys(details).length > 0;
  if (hasDetails && state) state.details = details;
  return hasDetails ? details : state?.details;
}

function webResultText(result: {
  content?: ReadonlyArray<{ type: string; text?: string }>;
}): string | undefined {
  return result.content?.find((block) => block.type === "text")?.text?.trim() || undefined;
}

function tookSuffix(tookMs: number | undefined): string {
  return typeof tookMs === "number" ? ` (${(tookMs / 1000).toFixed(1)}s)` : "";
}

function fallbackSuffix(fallback: string | undefined): string {
  return fallback ? ` (fallback: ${fallback})` : "";
}

function successLine(name: string, details: WebToolDetails): string {
  const title = details.title ? ` - "${details.title}"` : "";
  return `✓ ${name}${title}${fallbackSuffix(details.fallback)}${tookSuffix(details.tookMs)}`;
}

function errorLine(kind: "web-search" | "web-fetch", message: string): string {
  return `✗ ${kind} - "${message}"`;
}

function failureLine(
  kind: "web-search" | "web-fetch",
  result: { content?: ReadonlyArray<{ type: string; text?: string }> },
  details: WebToolDetails | undefined,
  isError: boolean,
): string | undefined {
  if (!isError && !details?.error) return undefined;
  return errorLine(kind, details?.error ?? webResultText(result) ?? "Error");
}

export function codemodeRenderers(
  next: () => ToolRenderers | undefined,
): ToolRenderers | undefined {
  const inner = next();
  const renderResult = inner?.renderResult;
  if (!inner || !renderResult) return inner;
  return {
    renderShell: inner.renderShell,
    renderCall: inner.renderCall,
    renderResult(result: any, options: any, theme: any, context: any) {
      const innerContext = { ...context, lastComponent: undefined };
      const details = result.details as { calls?: { status: string }[] } | undefined;
      const durationMs = completedDurationMs(result.content[0]);
      const useStandardDisplay =
        options.isPartial ||
        context.isError ||
        result.isError ||
        durationMs === undefined ||
        details?.calls?.some((call) => call.status !== "ok");
      if (useStandardDisplay) return renderResult(result, options, theme, innerContext);

      const view = options.expanded ? result : { ...result, details: { ...details, calls: [] } };
      const component = new Container();
      component.addChild(
        new Text(formatToolResultSummary("bash", {}, result, { durationMs }, theme) ?? "", 0, 0),
      );
      component.addChild(renderResult(view, options, theme, innerContext));
      return component;
    },
  };
}

function completedDurationMs(
  first: { type: string; text?: string } | undefined,
): number | undefined {
  if (first?.type !== "text" || first.text === undefined) return undefined;
  const header = /^Script completed\nWall time (\d+(?:\.\d+)?) seconds\nOutput:\n$/.exec(
    first.text,
  );
  if (!header || header[0] !== first.text) return undefined;
  const durationMs = Number(header[1]) * 1000;
  return Number.isFinite(durationMs) ? durationMs : undefined;
}

function subagentRenderers(): ToolRenderers {
  return {
    renderCall(args: any, theme: any) {
      const sessionLabel =
        typeof args.session === "string" && args.session.length > 0
          ? ` (${args.fork ? "fork" : "resume"} ${basename(args.session)})`
          : "";
      return new Text(
        theme.fg("toolTitle", theme.bold(`subagent ${args.agent ?? "..."}${sessionLabel}`)),
        0,
        0,
      );
    },
    renderResult(result: any, options: any, theme: any) {
      const details = result.details as AgentToolDetails | undefined;
      const childResult = details?.results[0];
      if (!childResult) {
        const fallback = result.content[0];
        return new Text(fallback?.type === "text" ? fallback.text : "(no output)", 0, 0);
      }

      const actions = childResult.actions;
      const finalOutput = getFinalOutput(childResult.messages);
      const childCwd = childResult.cwd ?? process.cwd();
      const toolTheme: ToolTheme = { fg: theme.fg.bind(theme), bold: theme.bold.bind(theme) };
      const container = new Container();
      container.addChild(new Text(theme.fg("muted", "┌─── Task ──────"), 0, 0));
      container.addChild(new Text(theme.fg("text", childResult.task), 0, 0));
      container.addChild(new Text(theme.fg("muted", "└───────────────"), 0, 0));
      if (actions.length > 0) {
        container.addChild(new Text(theme.fg("muted", "┌─── Actions ───"), 0, 0));
        for (const action of actions) {
          const callText = formatToolCall(action.name, action.args, childCwd, toolTheme);
          container.addChild(new Text(`${theme.fg("muted", "→ ")}${callText}`, 0, 0));
          const durationMs =
            action.startedAt !== undefined && action.endedAt !== undefined
              ? action.endedAt - action.startedAt
              : undefined;
          const summary =
            action.result !== undefined
              ? formatToolResultSummary(
                  action.name,
                  action.args,
                  action.result,
                  { isError: action.isError, durationMs },
                  toolTheme,
                )
              : undefined;
          if (summary !== undefined) container.addChild(new Text(`  ${summary}`, 0, 0));
        }
        container.addChild(new Text(theme.fg("muted", "└───────────────"), 0, 0));
      }
      if (finalOutput && !options.isPartial) {
        container.addChild(new Text(theme.fg("muted", "┌─── Output ────"), 0, 0));
        container.addChild(new Markdown(finalOutput.trim(), 0, 0, getMarkdownTheme()));
        container.addChild(new Text(theme.fg("muted", "└───────────────"), 0, 0));
      }
      if (childResult.sessionId && !options.isPartial) {
        container.addChild(new Text(theme.fg("muted", `session: ${childResult.sessionId}`), 0, 0));
      }
      if (childResult.pending) {
        container.addChild({
          render: () =>
            childResult.pending
              ? [theme.fg("muted", `${spinnerFrame(spinnerTimers.now())} ${childResult.agent}`)]
              : [],
          invalidate: () => {},
        });
      }
      return container;
    },
  };
}

function getFinalOutput(messages: any[]): string {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

function replaceContextRenderers(): ToolRenderers {
  return {
    renderShell: "self",
    renderCall(_args: any, theme: any, context: any) {
      const box = stateBox(theme, context.state);
      box.clear();
      addLabel(box, theme);
      box.addChild(new Spacer(1));
      box.addChild(new Text(theme.fg("dim", PENDING_TEXT), 0, 0));
      return box;
    },
    renderResult(result: any, { expanded }: any, theme: any, context: any) {
      const tracked = context.state.box as Box | undefined;
      const box = tracked ?? stateBox(theme, context.state);
      box.clear();
      addLabel(box, theme);
      box.addChild(new Spacer(1));
      if (context.isError || !isHandoffPayload(result.details)) {
        box.addChild(new Text(theme.fg("error", firstTextContent(result.content)), 0, 0));
      } else if (expanded) {
        box.addChild(
          new Markdown(replaceContextDetailsMarkdown(result.details), 0, 0, getMarkdownTheme(), {
            color: (text: string) => theme.fg("customMessageText", text),
          }),
        );
      } else {
        box.addChild(new Text(collapsedResultLine(theme), 0, 0));
      }
      return tracked ? new Container() : box;
    },
  };
}

function stateBox(theme: any, state: { box?: Box }): Box {
  state.box ??= replaceContextBox(theme);
  return state.box;
}

function replaceContextBox(theme: any): Box {
  return new Box(1, 1, (text) => theme.bg("customMessageBg", text));
}

function addLabel(box: Box, theme: any): void {
  box.addChild(new Text(theme.fg("customMessageLabel", `\x1b[1m${TOOL_LABEL}\x1b[22m`), 0, 0));
}

function collapsedResultLine(theme: any): string {
  return (
    theme.fg("customMessageText", `${COLLAPSED_TEXT} (`) +
    theme.fg("dim", expandKeyText()) +
    theme.fg("customMessageText", " to expand)")
  );
}

function replaceContextDetailsMarkdown(payload: HandoffPayload): string {
  return [
    `**${COLLAPSED_TEXT}**`,
    "",
    "**Reason**",
    "",
    payload.reason,
    "",
    "**Handoff**",
    "",
    payload.handoff,
  ].join("\n");
}

function expandKeyText(): string {
  const altKeyName = process.platform === "darwin" ? "option" : "alt";
  return getKeybindings()
    .getKeys(EXPAND_KEYBINDING)
    .map((key) =>
      key
        .split("+")
        .map((part) => (part.toLowerCase() === "alt" ? altKeyName : part))
        .join("+"),
    )
    .join("/");
}

function firstTextContent(content: Array<{ type: string; text?: string }>): string {
  return content.find((block) => block.type === "text")?.text ?? "";
}
