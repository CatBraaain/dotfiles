import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, createWriteTool } from "@earendil-works/pi-coding-agent";
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
}
