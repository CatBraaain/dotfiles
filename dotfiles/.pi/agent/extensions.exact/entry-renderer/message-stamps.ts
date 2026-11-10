import {
  AssistantMessageComponent,
  UserMessageComponent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { stampSuffix, stampTime } from "./stamp-time.ts";

type AssistantPart = {
  timestamp?: string;
  lastMessage?: { timestamp?: number };
  hasToolCalls?: boolean;
};
type UserPart = { timestamp?: string; assignedStamp?: string };

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
    appendStamp(lines, width, stampTime(part.timestamp ?? part.lastMessage?.timestamp));
    return lines;
  }

  function renderUser(this: UserMessageComponent, width: number): string[] {
    const lines = userRender.call(this, width);
    if (!active || lines.length === 0) return lines;
    const part = this as unknown as UserPart;
    part.assignedStamp ??= part.timestamp
      ? stampTime(part.timestamp)
      : stampTime(pendingUserStampsMs.shift());
    appendStamp(lines, width, part.assignedStamp);
    return lines;
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

function appendStamp(lines: string[], width: number, stamp: string): void {
  if (!displayTheme || stamp === "") return;
  lines.push(displayTheme.fg("dim", stampSuffix("", stamp, width)));
}
