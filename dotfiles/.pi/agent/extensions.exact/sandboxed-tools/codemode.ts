import {
  createCodemodeExtension,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { formatToolResultSummary } from "../shared/tool-format.ts";

export function registerCodemode(pi: ExtensionAPI): void {
  createCodemodeExtension()({
    ...pi,
    registerTool(tool) {
      pi.registerTool(withCodemodeResultRenderer(tool));
    },
  });
}

export function withCodemodeResultRenderer<TParams extends TSchema, TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
  const renderResult = tool.renderResult;
  if (!renderResult) return tool;

  return {
    ...tool,
    renderResult(result, options, theme, context) {
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

      const view = options.expanded
        ? result
        : { ...result, details: { ...details, calls: [] } as TDetails };
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
