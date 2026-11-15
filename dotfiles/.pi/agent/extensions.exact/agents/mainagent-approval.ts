import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

export async function showMainagentApproval(
  ui: ExtensionUIContext,
  question: string,
  details: string,
  options: string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  let cancel: (() => void) | undefined;
  try {
    return await ui.custom<string | undefined>(
      (tui, theme, _keybindings, done) => {
        function onAbort(): void {
          done(undefined);
        }
        cancel = onAbort;
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        return new MainagentApprovalDialog(tui, theme, question, details, options, done);
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

export class MainagentApprovalDialog implements Component {
  readonly capturesViewportInput = true;
  private scrollTop = 0;
  private selectedIndex = 0;
  private bodyHeight = 1;
  private bodyLines: string[] = [];
  private readonly displayDetails: string;

  constructor(
    private readonly tui: Pick<TUI, "terminal" | "requestRender">,
    private readonly theme: Pick<Theme, "fg">,
    private readonly question: string,
    details: string,
    private readonly options: string[],
    private readonly done: (result: string | undefined) => void,
  ) {
    this.displayDetails = details.replace(/\p{Cc}/gu, (character) =>
      character === "\n"
        ? character
        : `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "return")) {
      this.done(this.options[this.selectedIndex]);
      return;
    }
    if (matchesKey(data, "tab")) {
      this.selectedIndex = (this.selectedIndex + 1) % this.options.length;
    } else if (matchesKey(data, "shift+tab")) {
      this.selectedIndex = (this.selectedIndex + this.options.length - 1) % this.options.length;
    } else if (matchesKey(data, "up")) {
      this.scrollTop--;
    } else if (matchesKey(data, "down")) {
      this.scrollTop++;
    } else if (matchesKey(data, "pageUp")) {
      this.scrollTop -= this.bodyHeight;
    } else if (matchesKey(data, "pageDown")) {
      this.scrollTop += this.bodyHeight;
    } else {
      return;
    }
    this.clampScroll();
    this.tui.requestRender();
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
      "↑↓ / PgUp/PgDn: scroll • Tab/Shift+Tab: choose • Enter: confirm • Esc: deny",
      innerWidth,
    );
    const borderRows = 4;
    const fixedRows = borderRows + header.length + choices.length;
    const helpLines = this.tui.terminal.rows > fixedRows + help.length ? help : [];
    this.bodyHeight = Math.max(1, this.tui.terminal.rows - fixedRows - helpLines.length);
    this.bodyLines = wrapTextWithAnsi(this.displayDetails, innerWidth);
    this.clampScroll();

    const horizontal = "─".repeat(Math.max(0, width - 2));
    const theme = this.theme;
    function border(left: string, right: string): string {
      return theme.fg("border", `${left}${horizontal}${right}`);
    }
    function row(content: string): string {
      const clipped = truncateToWidth(content, innerWidth, "");
      const padded = clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
      return theme.fg("border", "│") + ` ${padded} ` + theme.fg("border", "│");
    }
    const body = Array.from(
      { length: this.bodyHeight },
      (_, index) => this.bodyLines[this.scrollTop + index] ?? "",
    );
    return [
      border("┌", "┐"),
      ...header.map(row),
      border("├", "┤"),
      ...body.map(row),
      border("├", "┤"),
      ...choices.map(row),
      ...helpLines.map((line) => row(this.theme.fg("dim", line))),
      border("└", "┘"),
    ];
  }

  invalidate(): void {}

  private clampScroll(): void {
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, this.bodyLines.length - this.bodyHeight));
  }
}
