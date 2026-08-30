/**
 * Titlebar Spinner Extension
 *
 * Shows a spinner animation in the terminal title while the agent is working.
 * Uses `ctx.ui.setTitle()` to update the terminal title via the extension API.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;

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

  function stopAnimation(ctx: ExtensionContext) {
    if (timer) {
      __timers.clear(timer);
      timer = null;
    }
    ctx.ui.setTitle(buildTitle(pi.getSessionName()));
  }

  function startAnimation(ctx: ExtensionContext) {
    stopAnimation(ctx);
    const render = () =>
      ctx.ui.setTitle(buildTitle(pi.getSessionName(), spinnerFrame(__timers.now())));
    render();
    timer = __timers.set(render, SPINNER_INTERVAL_MS);
  }

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setTitle(buildTitle(pi.getSessionName()));
  });

  pi.on("agent_start", async (_event, ctx) => {
    startAnimation(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    stopAnimation(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopAnimation(ctx);
  });
}
