import { basename, dirname, relative, resolve, sep } from "node:path";

/**
 * Shared formatting helpers for tool call/result rendering.
 * Pure string functions with no TUI dependency; callers wrap them in Text.
 * Lives in extensions/shared/ (no index.ts) so the extension loader ignores it.
 */

export type ToolTheme = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

export type ToolResultContent = { type: string; text?: string };

export type ToolResultLike = { content?: ToolResultContent[]; details?: unknown };

export const COMMAND_PREVIEW_LIMIT = 80;

export const CALL_PREVIEW_LIMIT = 100;

export function truncateCommand(command: string, limit = COMMAND_PREVIEW_LIMIT): string {
  return command.length > limit ? `${command.slice(0, limit - 3)}...` : command;
}

export function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

export function countResultLines(text: string): number {
  if (text === "") return 0;
  const trimmed = text.trimEnd();
  return trimmed === "" ? 0 : trimmed.split("\n").length;
}

// Match lines are "path:line: text"; context lines use "path-line- text" instead.
export function countMatchLines(output: string): number {
  return output.split("\n").filter((line) => /:\d+: /.test(line)).length;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function resultText(result: ToolResultLike): string {
  return result.content?.[0]?.type === "text" ? (result.content[0].text ?? "") : "";
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
  return `${theme.fg("toolTitle", theme.bold("$ "))}${theme.fg("accent", truncateCommand(command))}`;
}

export function formatNamedCall(name: string, value: string, theme: ToolTheme): string {
  return `${theme.fg("toolTitle", theme.bold(`${name} `))}${theme.fg("accent", value)}`;
}

export function formatPath(path: string, cwd: string): string {
  const absolutePath = resolve(cwd, path);
  const relativePath = relative(cwd, absolutePath);
  const isOutsideCwd = relativePath === ".." || relativePath.startsWith(`..${sep}`);
  return isOutsideCwd ? absolutePath : relativePath || ".";
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
      return formatNamedCall("grep", String(args.pattern ?? ""), theme);
    case "find":
      return formatNamedCall("find", String(args.pattern ?? ""), theme);
    case "ls":
      return formatNamedCall("ls", String(args.path ?? "."), theme);
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
  if (options.isError) return theme.fg("error", resultText(result));
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
    case "read":
      return theme.fg("success", `${countResultLines(resultText(result))} lines`);
    case "grep":
      return theme.fg("success", `${countMatchLines(resultText(result))} matches`);
    case "find":
      return theme.fg("success", `${countResultLines(resultText(result))} files`);
    case "ls":
      return theme.fg("success", `${countResultLines(resultText(result))} entries`);
    default:
      return undefined;
  }
}
