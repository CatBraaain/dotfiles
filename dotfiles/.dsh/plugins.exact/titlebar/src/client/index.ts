/**
 * Browser client half: keep the document title in step with agent state.
 *
 * Registers a {@link TitlebarController} over the sessions list and pending
 * interactions observables. No React, no slots: the titlebar is the browser
 * tab title, written directly (the stock `DocumentTitle` component keeps
 * ownership of the unmarked title and re-asserts it on its own changes;
 * the controller re-marks within one spinner tick).
 */
import type { Context } from "@deepseek-ai/cordis";
// Context augmentation: `ctx.sessions` (list snapshot with current + running).
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
// Context augmentation: `ctx.uiSession` (pendingInteractions snapshot).
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import { TitlebarController, type TitlebarHost } from "./controller";
/** Services this client half touches. */
export const inject = ["sessions", "uiSession"];

/** Browser implementation of the clock/timer/title seams. */
const browserHost: TitlebarHost = {
  getTitle: () => document.title,
  setTitle: (title) => {
    document.title = title;
  },
  now: () => Date.now(),
  startTimer: (handler, intervalMs) => setInterval(handler, intervalMs),
  stopTimer: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Start the controller and tie its lifetime to this plugin's fiber. */
export function apply(ctx: Context): void {
  const controller = new TitlebarController(
    ctx.sessions.list,
    ctx.uiSession.pendingInteractions,
    browserHost,
  );
  controller.start();
  ctx.effect(function* () {
    yield () => controller.dispose();
  });
}
