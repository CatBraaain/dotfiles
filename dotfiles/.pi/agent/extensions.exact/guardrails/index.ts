import { resolve } from "node:path";
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
import {
  formatBashCall,
  formatNamedCall,
  formatReadCall,
  formatToolResultSummary,
  resultText,
} from "../shared/tool-format.ts";

export {
  COMMAND_PREVIEW_LIMIT,
  classifyReadPath,
  countMatchLines,
  countResultLines,
  formatDuration,
  formatSize,
  truncateCommand,
} from "../shared/tool-format.ts";

function renderTextToolResult(
  result: any,
  options: { expanded: boolean; isPartial: boolean },
  theme: any,
  context: any,
  name: string,
): Text {
  if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
  if (context.isError) return new Text(theme.fg("error", resultText(result)), 0, 0);
  if (options.expanded) return new Text(theme.fg("dim", resultText(result)), 0, 0);
  const summary = formatToolResultSummary(name, context.args ?? {}, result, {}, theme);
  return new Text(summary ?? "", 0, 0);
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
      return new Text(formatBashCall(args.command, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      if (context.isError) return new Text(theme.fg("error", resultText(result)), 0, 0);
      if (options.expanded) return new Text(theme.fg("dim", resultText(result)), 0, 0);
      const state = context.state;
      const durationMs =
        state?.startedAt !== undefined ? (state.endedAt ?? Date.now()) - state.startedAt : undefined;
      return new Text(formatToolResultSummary("bash", {}, result, { durationMs }, theme) ?? "", 0, 0);
    },
  });

  const registerTextTool = (
    tool: any,
    name: string,
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
          new Text(formatNamedCall(name, getCall(args), theme), 0, 0)
        );
      },
      renderResult(result: any, options: any, theme: any, context: any) {
        return renderTextToolResult(result, options, theme, context, name);
      },
    });
  };
  registerTextTool(
    readTool,
    "read",
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
      return new Text(formatNamedCall("write", args.path, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      if (context.isError) return new Text(theme.fg("error", resultText(result)), 0, 0);
      if (options.expanded) return new Text(theme.fg("dim", context.args?.content ?? ""), 0, 0);
      return new Text(
        formatToolResultSummary("write", context.args ?? {}, result, {}, theme) ?? "",
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
      return new Text(formatNamedCall("edit", args.path, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      if (context.isError) return new Text(theme.fg("error", resultText(result)), 0, 0);
      if (options.expanded) {
        const diff = (result.details as { diff?: string } | undefined)?.diff ?? resultText(result);
        return new Text(theme.fg("dim", diff), 0, 0);
      }
      return new Text(
        formatToolResultSummary("edit", context.args ?? {}, result, {}, theme) ?? "",
        0,
        0,
      );
    },
  });
  pi.registerTool({
    ...grepTool,
    async execute(_id, params, signal, _onUpdate, context) {
      await sandbox.authorizePath("read", resolve(cwd, params.path ?? "."), context);
      return sandbox.runTool("grep", params, { mode: "fs", signal });
    },
    renderCall(args, theme) {
      return new Text(formatNamedCall("grep", args.pattern, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      if (context.isError) return new Text(theme.fg("error", resultText(result)), 0, 0);
      if (options.expanded) return new Text(theme.fg("dim", resultText(result)), 0, 0);
      return new Text(
        formatToolResultSummary("grep", context.args ?? {}, result, {}, theme) ?? "",
        0,
        0,
      );
    },
  });
  registerTextTool(
    findTool,
    "find",
    (args) => args.pattern,
    async (args, signal, context) => {
      await sandbox.authorizePath("read", resolve(cwd, args.path ?? "."), context);
      return sandbox.runTool("find", args, { mode: "fs", signal });
    },
  );
  registerTextTool(
    lsTool,
    "ls",
    (args) => args.path ?? ".",
    async (args, signal, context) => {
      await sandbox.authorizePath("read", resolve(cwd, args.path ?? "."), context);
      return sandbox.runTool("ls", args, { mode: "fs", signal });
    },
  );
}
