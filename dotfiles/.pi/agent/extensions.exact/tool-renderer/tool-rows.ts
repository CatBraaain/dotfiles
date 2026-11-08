import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";

export type ToolRowState = {
  toolName: string;
  args: Record<string, unknown>;
  cwd: string;
  expanded: boolean;
  isPartial: boolean;
  rendererState: Record<string, any>;
  result?: {
    content: Array<{ type: string; text?: string }>;
    details?: any;
    isError: boolean;
    durationMs?: number;
  };
  ui: TUI;
};

export function installToolRowFolding(summary: (row: ToolRowState) => string): () => void {
  const prototype = ToolExecutionComponent.prototype;
  const originalRender = prototype.render;
  const originalHandleMouse = prototype.handleMouse;
  const headerRows = new WeakMap<ToolExecutionComponent, number>();
  let active = true;

  function render(this: ToolExecutionComponent, width: number): string[] {
    if (!active) return originalRender.call(this, width);
    const row = this as unknown as ToolRowState;
    if (!row.expanded) return renderSummary(row, width);
    const lines = originalRender.call(this, width);
    const headerRow = lines.findIndex((line) => stripTerminalSequences(line).trim() !== "");
    headerRows.set(this, headerRow < 0 ? 0 : headerRow);
    return headerRow < 0 ? renderSummary(row, width) : lines;
  }

  function renderSummary(row: ToolRowState, width: number): string[] {
    try {
      const line = summary(row).replace(/[\r\n\t\u2028\u2029]/g, " ");
      return [truncateToWidth(line, width)];
    } catch {
      return [truncateToWidth(`${row.toolName} — [render error]`, width)];
    }
  }

  function handleMouse(
    this: ToolExecutionComponent,
    event: TuiMouseEvent,
  ): ReturnType<ToolExecutionComponent["handleMouse"]> {
    if (!active) return originalHandleMouse.call(this, event);
    const row = this as unknown as ToolRowState;
    const headerRow = row.expanded ? headerRows.get(this) : 0;
    if (event.type === "click" && event.button === "left" && event.y === headerRow) {
      this.setExpanded(!row.expanded);
      row.ui.requestRender();
      return {
        handled: true,
        target: {
          component: this,
          originX: event.screenX - event.x,
          originY: event.screenY - event.y,
          width: event.width,
          height: event.height,
        },
      };
    }
    return row.expanded ? originalHandleMouse.call(this, event) : undefined;
  }

  prototype.render = render;
  prototype.handleMouse = handleMouse;
  return function dispose() {
    active = false;
    if (prototype.render === render) prototype.render = originalRender;
    if (prototype.handleMouse === handleMouse) prototype.handleMouse = originalHandleMouse;
  };
}
