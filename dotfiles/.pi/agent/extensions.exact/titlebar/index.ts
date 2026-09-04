/**
 * Titlebar Spinner Extension
 *
 * Shows a spinner animation in the terminal title while the agent is working,
 * and a static pause symbol while a blocking extension UI prompt is waiting
 * for user input. Uses `ctx.ui.setTitle()` to update the terminal title via
 * the extension API. Title control runs only in TUI mode; other modes never
 * receive setTitle notifications, and the spinner timer does not run either.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;
const WAITING_FRAME = "⏸";

export const __timers: {
  set: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clear: (timer: ReturnType<typeof setInterval>) => void;
  now: () => number;
} = {
  set: (callback, intervalMs) => setInterval(callback, intervalMs),
  clear: (timer) => clearInterval(timer),
  now: () => Date.now(),
};

export function spinnerFrame(nowMs: number, frames: string[] = SPINNER_FRAMES): string {
  const index = Math.floor(nowMs / SPINNER_INTERVAL_MS) % frames.length;
  return frames[index < 0 ? index + frames.length : index]!;
}

export function buildTitle(sessionName: string | undefined, frame?: string): string {
  const base = sessionName ? `π - ${sessionName}` : "π";
  return frame ? `${frame} ${base}` : base;
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let waitingPrompt = false;

  function render(ctx: ExtensionContext) {
    const frame = waitingPrompt ? WAITING_FRAME : spinnerFrame(__timers.now());
    ctx.ui.setTitle(buildTitle(pi.getSessionName(), frame));
  }

  function stopAnimation(ctx: ExtensionContext) {
    waitingPrompt = false;
    if (timer) {
      __timers.clear(timer);
      timer = null;
    }
    ctx.ui.setTitle(buildTitle(pi.getSessionName()));
  }

  function startAnimation(ctx: ExtensionContext) {
    stopAnimation(ctx);
    render(ctx);
    timer = __timers.set(() => render(ctx), SPINNER_INTERVAL_MS);
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setTitle(buildTitle(pi.getSessionName()));
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    startAnimation(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    stopAnimation(ctx);
  });

  pi.on("ui_prompt_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    waitingPrompt = true;
    render(ctx);
  });

  pi.on("ui_prompt_end", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    waitingPrompt = false;
    render(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    stopAnimation(ctx);
  });
}
