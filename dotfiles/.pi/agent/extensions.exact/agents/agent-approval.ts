import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  TuiAltScreen,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE_TRACKING = "\x1b[?1006l\x1b[?1000l";
const WHEEL_SCROLL_LINES = 3;
const SGR_WHEEL_PREFIX = "\x1b[<6";

export type ApprovalField = { label: string; text: string };

function wheelDirection(data: string): number | undefined {
  if (!data.startsWith(SGR_WHEEL_PREFIX)) return undefined;
  const tail = data.slice(SGR_WHEEL_PREFIX.length);
  if (!/^[45];\d+;\d+M$/.test(tail)) return undefined;
  return tail.startsWith("4") ? -1 : 1;
}

export async function showAgentApproval(
  ui: ExtensionUIContext,
  question: string,
  fields: ApprovalField[],
  options: string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  let cancel: (() => void) | undefined;
  try {
    return await ui.custom<string | undefined>(
      (tui, theme, _keybindings, done) => {
        const dialog = new AgentApprovalDialog(tui, theme, question, fields, options, done);
        function onAbort(): void {
          dialog.finish(undefined);
        }
        cancel = onAbort;
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        return dialog;
      },
      {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
      },
    );
  } finally {
    if (cancel) signal?.removeEventListener("abort", cancel);
  }
}

export class AgentApprovalDialog implements Component {
  readonly capturesViewportInput = true;
  private scrollTop = 0;
  private selectedIndex = 0;
  private bodyHeight = 1;
  private bodyLines: string[] = [];
  private readonly displayCells: { label: string; text: string }[];
  private readonly ownsMouseTracking: boolean;

  constructor(
    private readonly tui: Pick<TUI, "terminal" | "requestRender">,
    private readonly theme: Pick<Theme, "fg">,
    private readonly question: string,
    fields: ApprovalField[],
    private readonly options: string[],
    private readonly done: (result: string | undefined) => void,
  ) {
    this.displayCells = fields.map((field) => ({
      ...field,
      text: field.text.replace(/\p{Cc}/gu, (character) =>
        character === "\n"
          ? character
          : `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
      ),
    }));
    this.ownsMouseTracking = !(tui instanceof TuiAltScreen);
    if (this.ownsMouseTracking) this.tui.terminal.write(ENABLE_MOUSE_TRACKING);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel" || event.wheelDelta === undefined) return undefined;
    const direction = Math.sign(event.wheelDelta);
    if (direction === 0) return undefined;
    this.scrollBy(direction * WHEEL_SCROLL_LINES);
    return { handled: true };
  }

  handleInput(data: string): void {
    const wheel = wheelDirection(data);
    if (wheel !== undefined) {
      this.scrollBy(wheel * WHEEL_SCROLL_LINES);
      return;
    }
    if (matchesKey(data, "escape")) {
      this.finish(undefined);
      return;
    }
    if (matchesKey(data, "return")) {
      this.finish(this.options[this.selectedIndex]);
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "tab")) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.scrollBy(-this.bodyHeight);
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.scrollBy(this.bodyHeight);
      return;
    }
  }

  private scrollBy(lines: number): void {
    this.scrollTop += lines;
    this.clampScroll();
    this.tui.requestRender();
  }

  private moveSelection(delta: number): void {
    const count = this.options.length;
    this.selectedIndex = (this.selectedIndex + delta + count) % count;
    this.tui.requestRender();
  }

  finish(result: string | undefined): void {
    if (this.ownsMouseTracking) this.tui.terminal.write(DISABLE_MOUSE_TRACKING);
    this.done(result);
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    const header = wrapTextWithAnsi(this.question, innerWidth);
    const choices = this.options.flatMap((option, index) => {
      const selected = index === this.selectedIndex;
      return wrapTextWithAnsi(`${selected ? "→" : " "} ${option}`, innerWidth).map((line) =>
        selected ? this.theme.fg("accent", line) : line,
      );
    });
    const help = wrapTextWithAnsi(
      "↑↓/Tab: choose • wheel/PgUp/PgDn: scroll • Enter: confirm • Esc: deny",
      innerWidth,
    );
    const borderRows = 4;
    const fixedRows = borderRows + header.length + choices.length;
    const helpLines = this.tui.terminal.rows > fixedRows + help.length ? help : [];
    this.bodyHeight = Math.max(1, this.tui.terminal.rows - fixedRows - helpLines.length);
    const theme = this.theme;
    function border(left: string, right: string, columns = width, label = ""): string {
      const spanWidth = Math.max(0, columns - 2);
      const title = truncateToWidth(label ? `─ ${label} ` : "", spanWidth, "");
      const horizontal = "─".repeat(Math.max(0, spanWidth - visibleWidth(title)));
      return theme.fg(
        "border",
        truncateToWidth(`${left}${title}${horizontal}${right}`, columns, ""),
      );
    }
    function row(content: string, columns = width): string {
      const contentWidth = Math.max(0, columns - 4);
      const clipped = truncateToWidth(content, contentWidth, "");
      const padded = clipped + " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
      return truncateToWidth(
        theme.fg("border", "│") + ` ${padded} ` + theme.fg("border", "│"),
        columns,
        "",
      );
    }
    this.bodyLines = this.displayCells.flatMap((cell, index) => [
      ...(index === 0 ? [] : [""]),
      border("┌", "┐", innerWidth, cell.label),
      ...wrapTextWithAnsi(cell.text, Math.max(1, innerWidth - 4)).map((line) =>
        row(line, innerWidth),
      ),
      border("└", "┘", innerWidth),
    ]);
    this.clampScroll();
    const body = Array.from({ length: this.bodyHeight }, (_, index) =>
      row(this.bodyLines[this.scrollTop + index] ?? ""),
    );
    return [
      border("┌", "┐"),
      ...header.map((line) => row(line)),
      border("├", "┤"),
      ...body,
      border("├", "┤"),
      ...choices.map((line) => row(line)),
      ...helpLines.map((line) => row(this.theme.fg("dim", line))),
      border("└", "┘"),
    ];
  }

  invalidate(): void {}

  private clampScroll(): void {
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, this.bodyLines.length - this.bodyHeight));
  }
}
