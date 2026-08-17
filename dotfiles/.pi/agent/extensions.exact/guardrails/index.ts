import { basename, dirname, resolve } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import { Sandbox, type ToolSession } from "./sandbox";

export const COMMAND_PREVIEW_LIMIT = 80;

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

function formatReadCall(args: { path?: unknown }, cwd: string, theme: any): Text {
  const skill = classifyReadPath(args, cwd);
  if (skill) {
    return new Text(
      theme.fg("customMessageLabel", "\x1b[1m[skill]\x1b[22m ") +
        theme.fg("customMessageText", skill.label),
      0,
      0,
    );
  }
  const rawPath = args?.path;
  const pathText = typeof rawPath === "string" ? rawPath : "";
  return new Text(
    `${theme.fg("toolTitle", theme.bold("read "))}${theme.fg("accent", pathText)}`,
    0,
    0,
  );
}

function renderTextToolResult(
  result: any,
  options: { expanded: boolean; isPartial: boolean },
  theme: any,
  context: any,
  unit: string,
): Text {
  if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
  const output = result.content[0]?.type === "text" ? result.content[0].text : "";
  if (context.isError) return new Text(theme.fg("error", output), 0, 0);
  if (options.expanded) return new Text(theme.fg("dim", output), 0, 0);
  return new Text(theme.fg("success", `${countResultLines(output)} ${unit}`), 0, 0);
}

function sessionFromContext(context: any): ToolSession {
  return {
    sessionId: context?.sessionManager?.getSessionId?.(),
    sessionFile: context?.sessionManager?.getSessionFile?.(),
    provider: context?.model?.provider,
    modelId: context?.model?.id,
    reasoningLevel: context?.thinkingLevel,
  };
}

export default function guardrailsExtension(pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const sandbox = new Sandbox(cwd);
  const readTool = createReadTool(cwd);
  const writeTool = createWriteTool(cwd);
  const editTool = createEditTool(cwd);
  const grepTool = createGrepTool(cwd);
  const findTool = createFindTool(cwd);
  const lsTool = createLsTool(cwd);
  const bashTool = createBashTool(cwd);

  pi.registerTool({
    ...bashTool,
    async execute(id, params, signal, _onUpdate, context) {
      await sandbox.authorizeCommand(params.command, context);
      return sandbox.runTool("bash", params, {
        mode: "bash",
        signal,
        session: sessionFromContext(context),
      });
    },
    renderCall(args, theme, context) {
      if (context.state && context.executionStarted && context.state.startedAt === undefined)
        context.state.startedAt = Date.now();
      return new Text(
        `${theme.fg("toolTitle", theme.bold("$ "))}${theme.fg("accent", truncateCommand(args.command))}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      if (context.isError)
        return new Text(
          theme.fg("error", result.content[0]?.type === "text" ? result.content[0].text : ""),
          0,
          0,
        );
      if (options.expanded)
        return new Text(
          theme.fg("dim", result.content[0]?.type === "text" ? result.content[0].text : ""),
          0,
          0,
        );
      const state = context.state;
      if (state?.startedAt !== undefined) {
        state.endedAt ??= Date.now();
        return new Text(theme.fg("success", formatDuration(state.endedAt - state.startedAt)), 0, 0);
      }
      return new Text(theme.fg("success", "done"), 0, 0);
    },
  });

  const registerTextTool = (
    tool: any,
    name: string,
    unit: string,
    getCall: (args: any) => string,
    run: (args: any, signal: AbortSignal | undefined, context: any) => Promise<AgentToolResult>,
    renderOptions?: { renderCall?: (args: any, theme: any) => Text },
  ) => {
    pi.registerTool({
      ...tool,
      async execute(_id, params, signal, _onUpdate, context) {
        return run(params, signal, context);
      },
      renderCall(args: any, theme: any) {
        return (
          renderOptions?.renderCall?.(args, theme) ??
          new Text(
            `${theme.fg("toolTitle", theme.bold(`${name} `))}${theme.fg("accent", getCall(args))}`,
            0,
            0,
          )
        );
      },
      renderResult(result: any, options: any, theme: any, context: any) {
        return renderTextToolResult(result, options, theme, context, unit);
      },
    });
  };
  registerTextTool(
    readTool,
    "read",
    "lines",
    (args) => args.path,
    async (args, signal, context) => {
      await sandbox.authorizePath("read", resolve(cwd, args.path), context);
      return sandbox.runTool("read", args, { mode: "fs", signal });
    },
    { renderCall: (args, theme) => formatReadCall(args, cwd, theme) },
  );
  pi.registerTool({
    ...writeTool,
    async execute(_id, params, signal, _onUpdate, context) {
      await sandbox.authorizePath("write", resolve(cwd, params.path), context);
      return sandbox.runTool("write", params, { mode: "fs", signal });
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("write "))}${theme.fg("accent", args.path)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      const output = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (context.isError) return new Text(theme.fg("error", output), 0, 0);
      if (options.expanded) return new Text(theme.fg("dim", context.args?.content ?? ""), 0, 0);
      return new Text(
        theme.fg("success", `wrote ${formatSize(context.args?.content?.length ?? 0)}`),
        0,
        0,
      );
    },
  });
  pi.registerTool({
    ...editTool,
    renderShell: "default",
    async execute(_id, params, signal, _onUpdate, context) {
      await sandbox.authorizePath("read", resolve(cwd, params.path), context);
      await sandbox.authorizePath("write", resolve(cwd, params.path), context);
      return sandbox.runTool("edit", params, { mode: "fs", signal });
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("edit "))}${theme.fg("accent", args.path)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      const output = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (context.isError) return new Text(theme.fg("error", output), 0, 0);
      if (options.expanded) {
        const diff = (result.details as { diff?: string } | undefined)?.diff ?? output;
        return new Text(theme.fg("dim", diff), 0, 0);
      }
      const editCount = Array.isArray(context.args?.edits) ? context.args.edits.length : 1;
      return new Text(theme.fg("success", `edited ${editCount} block(s)`), 0, 0);
    },
  });
  pi.registerTool({
    ...grepTool,
    async execute(_id, params, signal, _onUpdate, context) {
      await sandbox.authorizePath("read", resolve(cwd, params.path ?? "."), context);
      return sandbox.runTool("grep", params, { mode: "fs", signal });
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("grep "))}${theme.fg("accent", args.pattern)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      const output = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (context.isError) return new Text(theme.fg("error", output), 0, 0);
      if (options.expanded) return new Text(theme.fg("dim", output), 0, 0);
      return new Text(theme.fg("success", `${countMatchLines(output)} matches`), 0, 0);
    },
  });
  registerTextTool(
    findTool,
    "find",
    "files",
    (args) => args.pattern,
    async (args, signal, context) => {
      await sandbox.authorizePath("read", resolve(cwd, args.path ?? "."), context);
      return sandbox.runTool("find", args, { mode: "fs", signal });
    },
  );
  registerTextTool(
    lsTool,
    "ls",
    "entries",
    (args) => args.path ?? ".",
    async (args, signal, context) => {
      await sandbox.authorizePath("read", resolve(cwd, args.path ?? "."), context);
      return sandbox.runTool("ls", args, { mode: "fs", signal });
    },
  );
}
