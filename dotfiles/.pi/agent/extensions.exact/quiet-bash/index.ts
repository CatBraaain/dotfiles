import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const COMMAND_PREVIEW_LIMIT = 80;

export function truncateCommand(command: string, limit = COMMAND_PREVIEW_LIMIT): string {
  return command.length > limit ? `${command.slice(0, limit - 3)}...` : command;
}

export function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function quietBashExtension(pi: ExtensionAPI) {
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
}
