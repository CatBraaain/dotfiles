/**
 * Browser client half: hide stock composer controls and usage/feedback chrome,
 * keep the turn run time as a plain re-implemented tail, add the Ctrl+K → Ctrl+M chord.
 */
import { createElement, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
// Service augmentations this half reads: the slot registry, the composer slot
// map, the chat node slots, the command UI, the per-session model directory,
// and the sessions service.
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import type {} from "@deepseek-ai/dsh-client-ui-commands/client";
import type {} from "@deepseek-ai/dsh-client-ui-model-selection/client";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import type { TurnLocation } from "@deepseek-ai/dsh-client-ui-conversation/client";
import { formatRunDuration, turnRunMs } from "./turn-time";
// The `sessions` service declaration collides with the thin SessionStore one
// from @deepseek-ai/dsh-session (same cordis Context key), so read it through
// the full ISessions face explicitly.
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import { onChordKey, type ChordState } from "./chord";
import { chordPopupTarget, modelPopupSpec } from "./popup-logic";

/** Services this client half touches. */
export const inject = ["commandUi", "sessions", "modelDirectories", "slots"];

/**
 * Shadowing rank for our null occupants: one below the stock seats (which
 * register without a priority, i.e. 0). Single slots reject a second
 * registration at the SAME priority, so omitting this throws at apply time
 * and kills the rest of the client half with it.
 */
const SHADOW_PRIORITY = -1;

/**
 * Turn-tail chain rank: the chain tries selectors in ascending priority order
 * and the first non-null wins. Stock occupants (deliverables) register at the
 * default 0, so our 1 only renders when every stock occupant declined —
 * the turn time never displaces a richer tail.
 */
const TURN_TAIL_PRIORITY = 1;

/**
 * Stock components without a slot of their own, hidden via CSS. Class names
 * are hashed with a per-file prefix, so each selector pins the current dsh
 * build; a dsh update that changes a hash just makes the element reappear.
 */
const HIDE_CSS = [
  '[class*="heroWorkspaceRow"]', // New Session hero chips (workspace + agent preset)
  '[class*="pXSMma_headline"]', // hero headline row (fish + title + Preview badge)
  '[class*="uV2eYG_add"]', // commands + add attachment buttons (shared class)
  '[class*="Sh0Q9G_trigger"]', // PermissionSelect trigger (access mode)
  '[class*="Q51KRG_root"]', // turn usage + turn time panels (shared CSS module)
  "[data-composer-stats]", // session stats pills (time + usage) under the composer
  '[class*="_8_XoUG_action"]', // Like/Dislike feedback buttons on assistant messages
]
  .map((selector) => `${selector}{display:none!important}`)
  .join("");

/** Static look of the custom turn-time tail, matching the stock trigger metrics. */
const TURN_TIME_CSS = [
  ".custom-ui-turn-time{display:inline-flex;align-items:center;gap:4px;" +
    "height:calc(28px + var(--dsh-content-font-delta,0px));" +
    "color:var(--dsw-alias-label-tertiary);" +
    "font-size:var(--dsh-content-font-size-secondary,13px);" +
    "font-variant-numeric:tabular-nums;" +
    "line-height:calc(24px + var(--dsh-content-font-delta,0px));" +
    "white-space:nowrap;padding:6px 8px}",
  ".custom-ui-turn-time svg{width:calc(15px + var(--dsh-content-font-delta,0px));" +
    "height:calc(15px + var(--dsh-content-font-delta,0px));flex:none}",
].join("");

/** Empty occupant shadowing the stock seats of `conversation.input.model` and `.plan`. */
function SeatVoid(): ReactNode {
  return null;
}

/** Clock glyph in the stock 16px outline style. */
function ClockIcon(): ReactNode {
  return createElement(
    "svg",
    {
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": true,
    },
    createElement("circle", { cx: "8", cy: "8", r: "6.2" }),
    createElement("path", { d: "M8 4.6V8l2.3 1.3" }),
  );
}

/**
 * Turn-tail occupant: the stock time pill re-implemented as inert text — clock
 * glyph plus run duration, no click-open dialog. Renders nothing while the
 * turn has no completed bounds (same rule as the stock panel).
 */
function TurnTimeTail(props: { turn: TurnLocation }): ReactNode {
  const runMs = turnRunMs(props.turn);
  if (runMs === undefined) return null;
  return createElement(
    "span",
    { className: "custom-ui-turn-time" },
    createElement(ClockIcon, null),
    createElement("span", null, formatRunDuration(runMs)),
  );
}

export function apply(ctx: Context): void {
  // Shadow the stock model seat and plan chip. The single slot renders its
  // lowest-priority registrant, and our rank sits below the stock seats'.
  ctx.inject(["slots"], (scope) => {
    scope.slots.inject("conversation.input.model", () =>
      scope.slots.register(
        { name: "conversation.input.model", priority: SHADOW_PRIORITY },
        SeatVoid,
      ),
    );
    scope.slots.inject("conversation.input.plan", () =>
      scope.slots.register(
        { name: "conversation.input.plan", priority: SHADOW_PRIORITY },
        SeatVoid,
      ),
    );
    // Turn-tail chain: replace the usage/time panels (hidden via CSS above)
    // with a plain run-time display, but only when no stock tail (deliverables)
    // accepted this turn.
    scope.slots.inject("conversation.chat.turnTail", () =>
      scope.slots.register(
        { name: "conversation.chat.turnTail", select: () => true, priority: TURN_TAIL_PRIORITY },
        TurnTimeTail,
      ),
    );
  });

  // Hide the hero row, headline, the built-in tool row buttons, the usage
  // panels, the composer stats, and the feedback buttons. Host-built components
  // without slots of their own, so CSS is the only removal surface.
  const style = document.createElement("style");
  style.textContent = `${HIDE_CSS}${TURN_TIME_CSS}`;
  (document.head ?? document.documentElement).appendChild(style);
  ctx.effect(() => () => style.remove(), "custom-ui: hide style");

  // Ctrl+K → (within 1s) Ctrl+M opens the /model popup for the current session.
  ctx.inject(["commandUi", "sessions", "modelDirectories"], (scope) => {
    const command = scope.commandUi;
    const sessions = scope.sessions as unknown as ISessions;
    const models = scope.modelDirectories;

    const openModelPopup = () => {
      try {
        // Current ordinary session only (spec M8: nothing on the New Session
        // screen; addressed subagent sessions expose no model selection, same
        // availability rule as the stock /model command).
        const id = chordPopupTarget(sessions.list.getSnapshot().current, (sessionId) =>
          sessions.subagentAddress(sessionId),
        );
        if (id === undefined) return;
        const actx = sessions.scope(id);
        if (actx === undefined) return;
        command.popupFor(actx).open(
          "model",
          // Directory resolution is deferred into the spec callbacks (same
          // shape and failure copy as the stock /model contribution), so a
          // session with degraded remote wiring fails the shell's options
          // load (retry UI) instead of throwing out of this keydown handler.
          modelPopupSpec((sessionId) => models.directoryFor(sessionId)),
          { sessionId: id },
          { via: "enter", token: "model" },
        );
      } catch (error) {
        // Session lookup or popup open itself failed; never escape uncaught
        // from a document-level capture keydown.
        console.error("[custom-ui] Ctrl+K Ctrl+M could not open the model popup:", error);
      }
    };

    let chord: ChordState = {};
    const onKeyDown = (event: KeyboardEvent) => {
      const result = onChordKey(chord, event, Date.now());
      chord = result.state;
      if (result.swallow) {
        // Keep Ctrl+K alone inert and keep the CR-shaped Ctrl+M away from the
        // composer editor (capture phase: stops before any editor binding).
        event.preventDefault();
        event.stopPropagation();
      }
      if (result.open) openModelPopup();
    };
    document.addEventListener("keydown", onKeyDown, true);
    ctx.effect(
      () => () => document.removeEventListener("keydown", onKeyDown, true),
      "custom-ui: chord keydown",
    );
  });
}
