import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const COMMAND_PREVIEW_LIMIT = 80;

export function truncateCommand(command: string, limit = COMMAND_PREVIEW_LIMIT): string {
  return command.length > limit ? `${command.slice(0, limit - 3)}...` : command;
}

export function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function countResultLines(text: string): number {
  if (text === "") return 0;
  const trimmed = text.trimEnd();
  return trimmed === "" ? 0 : trimmed.split("\n").length;
}

function renderTextToolResult(result, { expanded, isPartial }, theme, context, unit) {
  if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
  const output = result.content[0]?.type === "text" ? result.content[0].text : "";
  if (context.isError) return new Text(theme.fg("error", output), 0, 0);
  if (expanded) return new Text(theme.fg("dim", output), 0, 0);
  return new Text(theme.fg("success", `${countResultLines(output)} ${unit}`), 0, 0);
}

export default function quietToolsExtension(pi: ExtensionAPI) {
  const originalBash = createBashTool(process.cwd());
  pi.registerTool({
    name: "bash",
    label: "bash",
    description: originalBash.description,
    parameters: originalBash.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      return originalBash.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      const state = context.state;
      if (state && context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
      }
      const command = truncateCommand(args.command);
      return new Text(
        `${theme.fg("toolTitle", theme.bold("$ "))}${theme.fg("accent", command)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);

      const output = result.content[0]?.type === "text" ? result.content[0].text : "";

      if (context.isError) return new Text(theme.fg("error", output), 0, 0);
      if (expanded) return new Text(theme.fg("dim", output), 0, 0);
      const state = context.state;
      if (state?.startedAt !== undefined) {
        state.endedAt ??= Date.now();
        return new Text(theme.fg("success", formatDuration(state.endedAt - state.startedAt)), 0, 0);
      }
      return new Text(theme.fg("success", "done"), 0, 0);
    },
  });

  const originalWrite = createWriteTool(process.cwd());
  pi.registerTool({
    name: "write",
    label: "write",
    description: originalWrite.description,
    parameters: originalWrite.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      return originalWrite.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", args.path)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);

      const output = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (context.isError) return new Text(theme.fg("error", output), 0, 0);
      if (expanded) return new Text(theme.fg("dim", context.args?.content ?? ""), 0, 0);

      const bytes = context.args?.content?.length ?? 0;
      return new Text(theme.fg("success", `wrote ${formatSize(bytes)}`), 0, 0);
    },
  });

  const originalEdit = createEditTool(process.cwd());
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: originalEdit.description,
    parameters: originalEdit.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      return originalEdit.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", args.path)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);

      const output = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (context.isError) return new Text(theme.fg("error", output), 0, 0);

      const diff = (result.details as { diff?: string } | undefined)?.diff;
      if (expanded) return new Text(theme.fg("dim", diff ?? output), 0, 0);

      const editCount = Array.isArray(context.args?.edits) ? context.args.edits.length : 1;
      return new Text(theme.fg("success", `edited ${editCount} block(s)`), 0, 0);
    },
  });

  const originalRead = createReadTool(process.cwd());
  pi.registerTool({
    name: "read",
    label: "read",
    description: originalRead.description,
    parameters: originalRead.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      return originalRead.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", args.path)}`,
        0,
        0,
      );
    },

    renderResult(result, options, theme, context) {
      return renderTextToolResult(result, options, theme, context, "lines");
    },
  });

  const originalGrep = createGrepTool(process.cwd());
  pi.registerTool({
    name: "grep",
    label: "grep",
    description: originalGrep.description,
    parameters: originalGrep.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      return originalGrep.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", args.pattern)}`,
        0,
        0,
      );
    },

    renderResult(result, options, theme, context) {
      return renderTextToolResult(result, options, theme, context, "matches");
    },
  });

  const originalFind = createFindTool(process.cwd());
  pi.registerTool({
    name: "find",
    label: "find",
    description: originalFind.description,
    parameters: originalFind.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      return originalFind.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", args.pattern)}`,
        0,
        0,
      );
    },

    renderResult(result, options, theme, context) {
      return renderTextToolResult(result, options, theme, context, "files");
    },
  });

  const originalLs = createLsTool(process.cwd());
  pi.registerTool({
    name: "ls",
    label: "ls",
    description: originalLs.description,
    parameters: originalLs.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      return originalLs.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", args.path ?? ".")}`,
        0,
        0,
      );
    },

    renderResult(result, options, theme, context) {
      return renderTextToolResult(result, options, theme, context, "entries");
    },
  });
}
