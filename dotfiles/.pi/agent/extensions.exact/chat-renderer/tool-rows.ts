import { ToolExecutionComponent, type Theme, type ThemeBg } from "@earendil-works/pi-coding-agent";
import {
  Container,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";

export type ToolRowState = {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  cwd: string;
  expanded: boolean;
  outputPad: number;
  isPartial: boolean;
  rendererState: Record<string, any>;
  result?: {
    content: Array<{ type: string; text?: string }>;
    details?: any;
    isError: boolean;
    durationMs?: number;
    timestamp?: number;
  };
  ui: TUI;
};

export function installToolRowFolding(
  compose: (row: ToolRowState, width: number) => string,
  theme: Pick<Theme, "bg" | "getBgAnsi">,
): () => void {
  const prototype = ToolExecutionComponent.prototype;
  const originalRender = prototype.render;
  const originalHandleMouse = prototype.handleMouse;
  const originalContainerRender = Container.prototype.render;
  const headerRows = new WeakMap<ToolExecutionComponent, number>();
  const positions = new WeakMap<Component, { parent: Container; index: number }>();
  let active = true;

  function renderContainer(this: Container, width: number): string[] {
    if (active) {
      const containsTools = this.children.some((child) => child instanceof ToolExecutionComponent);
      this.children.forEach((child, index) => {
        if (containsTools) positions.set(child, { parent: this, index });
        else positions.delete(child);
      });
    }
    const lines = originalContainerRender.call(this, width);
    const position = positions.get(this);
    const isEntry = position?.parent.children[position.index] === this;
    if (
      active &&
      isEntry &&
      !(this instanceof ToolExecutionComponent) &&
      lines.every(isUncoloredBlank)
    ) {
      return [];
    }
    return lines;
  }

  function isUncoloredBlank(line: string): boolean {
    if (stripTerminalSequences(line).trim() !== "") return false;
    for (const sequence of line.split("\x1b[").slice(1)) {
      const end = sequence.indexOf("m");
      if (end < 0) continue;
      const codes = sequence.slice(0, end);
      if (!/^[\d;:]*$/.test(codes)) continue;
      const parameters = codes.split(";");
      for (let index = 0; index < parameters.length; index++) {
        const code = Number(parameters[index]!.split(":")[0]);
        if ((code >= 40 && code <= 48) || (code >= 100 && code <= 107) || code === 7) return false;
        if (code === 38 && !parameters[index]!.includes(":")) {
          index += parameters[index + 1] === "2" ? 4 : 2;
        }
      }
    }
    return true;
  }

  function needsSeparator(row: ToolExecutionComponent, width: number, direction: -1 | 1): boolean {
    const position = positions.get(row);
    if (!position) return false;
    const { parent, index } = position;
    const siblings = parent.children;
    if (siblings[index] !== row) return false;
    for (
      let cursor = index + direction;
      cursor >= 0 && cursor < siblings.length;
      cursor += direction
    ) {
      const sibling = siblings[cursor]!;
      if (sibling instanceof ToolExecutionComponent) return false;
      const lines = sibling.render(width);
      if (lines.length === 0) continue;
      const boundary = direction === -1 ? lines.at(-1)! : lines[0]!;
      return !isUncoloredBlank(boundary);
    }
    return false;
  }

  function render(this: ToolExecutionComponent, width: number): string[] {
    if (!active) return originalRender.call(this, width);
    const row = this as unknown as ToolRowState;
    if (!row.expanded) return renderSummary(row, width);
    const lines = originalRender.call(this, width);
    const headerRow = lines.findIndex((line) => stripTerminalSequences(line).trim() !== "");
    headerRows.set(this, headerRow < 0 ? 0 : headerRow);
    if (headerRow < 0) return renderSummary(row, width);
    return lines.at(-1) === "" ? lines : [...lines, ""];
  }

  function renderSummary(row: ToolRowState, width: number): string[] {
    const padding = Math.min(row.outputPad, Math.max(0, width - 1));
    const contentWidth = width - padding;
    let content: string;
    try {
      content = compose(row, contentWidth);
    } catch {
      content = truncateToWidth(`${row.toolName} — [render error]`, contentWidth);
    }
    const background: ThemeBg =
      !row.result || row.isPartial
        ? "toolPendingBg"
        : row.result.isError
          ? "toolErrorBg"
          : "toolSuccessBg";
    const line = `${" ".repeat(padding)}${content}`;
    const rightPadding = " ".repeat(Math.max(0, width - visibleWidth(line)));
    const component = row as unknown as ToolExecutionComponent;
    const leading = needsSeparator(component, width, -1);
    const trailing = needsSeparator(component, width, 1);
    headerRows.set(component, leading ? 1 : 0);
    return [
      ...(leading ? [""] : []),
      theme
        .bg(background, line + rightPadding)
        .replaceAll("\x1b[0m", `\x1b[0m${theme.getBgAnsi(background)}`),
      ...(trailing ? [""] : []),
    ];
  }

  function handleMouse(
    this: ToolExecutionComponent,
    event: TuiMouseEvent,
  ): ReturnType<ToolExecutionComponent["handleMouse"]> {
    if (!active) return originalHandleMouse.call(this, event);
    const row = this as unknown as ToolRowState;
    const headerRow = headerRows.get(this) ?? 0;
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

  Container.prototype.render = renderContainer;
  prototype.render = render;
  prototype.handleMouse = handleMouse;
  return function dispose() {
    active = false;
    if (Container.prototype.render === renderContainer)
      Container.prototype.render = originalContainerRender;
    if (prototype.render === render) prototype.render = originalRender;
    if (prototype.handleMouse === handleMouse) prototype.handleMouse = originalHandleMouse;
  };
}
