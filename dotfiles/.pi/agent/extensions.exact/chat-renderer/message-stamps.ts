import {
  AssistantMessageComponent,
  UserMessageComponent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { stampTime } from "./stamp-time.ts";

type AssistantPart = {
  timestamp?: string;
  lastMessage?: { timestamp?: number };
  hasToolCalls?: boolean;
};
type UserPart = { timestamp?: string; assignedStamp?: string };
type MessagePadding = { top: number; bottom: number };

let active = false;
let displayTheme: Theme | undefined;
const pendingUserStampsMs: number[] = [];

export function installMessageStamps(theme: Theme): () => void {
  displayTheme = theme;
  pendingUserStampsMs.length = 0;
  const assistantRender = AssistantMessageComponent.prototype.render;
  const userRender = UserMessageComponent.prototype.render;

  function renderAssistant(this: AssistantMessageComponent, width: number): string[] {
    const lines = assistantRender.call(this, width);
    if (!active || lines.length === 0) return lines;
    const part = this as unknown as AssistantPart;
    if (part.hasToolCalls) return lines;
    const content = this.children[0];
    const leading = content instanceof Container ? content.children[0] : undefined;
    const top = leading instanceof Spacer ? leading.render(width).length : 0;
    return renderMessageBox(
      lines,
      width,
      stampTime(part.timestamp ?? part.lastMessage?.timestamp),
      {
        top,
        bottom: 0,
      },
    );
  }

  function renderUser(this: UserMessageComponent, width: number): string[] {
    const lines = userRender.call(this, width);
    if (!active || lines.length === 0) return lines;
    const part = this as unknown as UserPart;
    part.assignedStamp ??= part.timestamp
      ? stampTime(part.timestamp)
      : stampTime(pendingUserStampsMs.shift());
    const first = this.children[0];
    const last = this.children.at(-1);
    return renderMessageBox(lines, width, part.assignedStamp, {
      top: first instanceof Markdown && first.render(width).length > 0 ? 1 : 0,
      bottom: last instanceof Markdown && last.render(width).length > 0 ? 1 : 0,
    });
  }

  AssistantMessageComponent.prototype.render = renderAssistant;
  UserMessageComponent.prototype.render = renderUser;
  active = true;
  return function dispose() {
    active = false;
    displayTheme = undefined;
    if (AssistantMessageComponent.prototype.render === renderAssistant) {
      AssistantMessageComponent.prototype.render = assistantRender;
    }
    if (UserMessageComponent.prototype.render === renderUser) {
      UserMessageComponent.prototype.render = userRender;
    }
  };
}

export function recordMessageStart(message: { role: string; timestamp?: number }): void {
  if (!active) return;
  if (message.role === "user" && typeof message.timestamp === "number") {
    pendingUserStampsMs.push(message.timestamp);
  }
}

function renderMessageBox(
  lines: string[],
  width: number,
  stamp: string,
  padding: MessagePadding,
): string[] {
  const theme = displayTheme;
  if (!theme) return lines;
  const bodyEnd = lines.length - padding.bottom;
  const body = lines.slice(padding.top, bodyEnd);
  const hasBody = body.some(
    (line) => isImageLine(line) || stripTerminalSequences(line).trim() !== "",
  );
  if (!hasBody) return lines;

  const imageRows = protectedImageRows(lines);
  const paintedBody = body.map((line, index) =>
    imageRows.has(index + padding.top) ? line : paintLine(line, width, theme),
  );
  const top = padding.top > 0 ? lines[0]! : "";
  const bottom = padding.bottom > 0 ? lines.at(-1)! : "";
  const stampWidth = visibleWidth(stamp);
  const footer =
    stamp !== "" && stampWidth <= width
      ? bottom.replaceAll(" ", "") + " ".repeat(width - stampWidth) + theme.fg("dim", stamp)
      : bottom;
  return [paintLine(top, width, theme), ...paintedBody, paintLine(footer, width, theme)];
}

function paintLine(line: string, width: number, theme: Theme): string {
  const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
  const background = theme.getBgAnsi("userMessageBg");
  const nested = padded
    .split("\x1b[")
    .map((part, index) => {
      if (index === 0) return part;
      const sgr = /^([\d;:]*)m/.exec(part);
      const restored =
        sgr && resetsBackground(sgr[1]!) ? sgr[0] + background + part.slice(sgr[0].length) : part;
      return "\x1b[" + restored;
    })
    .join("");
  return theme.bg("userMessageBg", nested);
}

function resetsBackground(parameters: string): boolean {
  const parts = parameters.split(";");
  let resets = false;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const code = Number(part.split(":")[0]);
    if (code === 0 || code === 49) {
      resets = true;
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      resets = false;
    } else if (code === 38 || code === 48 || code === 58) {
      if (part.includes(":")) {
        if (code === 48) resets = false;
        continue;
      }
      const mode = parts[index + 1];
      const channelCount = mode === "2" ? 3 : mode === "5" ? 1 : 0;
      if (channelCount > 0 && parts[index + channelCount + 1] !== undefined) {
        if (code === 48) resets = false;
        index += channelCount + 1;
      }
    }
  }
  return resets;
}

function protectedImageRows(lines: string[]): Set<number> {
  const protectedRows = new Set<number>();
  lines.forEach((line, index) => {
    if (!isImageLine(line)) return;
    protectedRows.add(index);
    const kittyStart = line.indexOf("\x1b_G");
    const kittyHeader =
      kittyStart >= 0
        ? line.slice(kittyStart + "\x1b_G".length, line.indexOf(";", kittyStart))
        : undefined;
    const rows = Number(
      kittyHeader
        ?.split(",")
        .find((part) => part.startsWith("r="))
        ?.slice(2) ?? 1,
    );
    const itermIndex = line.indexOf("\x1b]1337;File=");
    const cursorUp = itermIndex >= 0 ? line.slice(0, itermIndex).split("\x1b[").at(-1) : undefined;
    const precedingRows = Number(/^(\d+)A$/.exec(cursorUp ?? "")?.[1] ?? 0);
    const first = Math.max(0, index - precedingRows);
    const last = Math.min(lines.length - 1, index + rows - 1);
    for (let row = first; row <= last; row++) {
      if (stripTerminalSequences(lines[row]!) === "") protectedRows.add(row);
    }
  });
  return protectedRows;
}

function isImageLine(line: string): boolean {
  return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}
