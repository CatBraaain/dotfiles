/** Browser client half: hide the stock model seat and hero chips, add the Ctrl+K → Ctrl+M chord. */
import { createElement, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
// Service augmentations this half reads: the slot registry, the composer slot
// map, the command UI, the per-session model directory, and the sessions service.
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-commands/client";
import type {} from "@deepseek-ai/dsh-client-ui-model-selection/client";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
// The `sessions` service declaration collides with the thin SessionStore one
// from @deepseek-ai/dsh-session (same cordis Context key), so read it through
// the full ISessions face explicitly.
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import { onChordKey, type ChordState } from "./chord";
import { chordPopupTarget, optionsOf, selectionOf } from "./popup-logic";

/** Services this client half touches. */
export const inject = ["commandUi", "sessions", "modelDirectories", "slots"];

/** CSS module names are hashed with a package-local prefix, so match on the stable suffix. */
const HERO_ROW_HIDE_CSS = '[class*="heroWorkspaceRow"]{display:none!important}';

/** Empty occupant for the single `conversation.input.model` slot: shadows the stock ModelSelect seat. */
function ModelSeatVoid(): ReactNode {
  return null;
}

export function apply(ctx: Context): void {
  // Hide the composer model seat: the single slot renders its latest
  // registrant, and this bundle loads after ui-model-selection's roster.
  ctx.inject(["slots"], (scope) => {
    scope.slots.inject("conversation.input.model", () =>
      scope.slots.register({ name: "conversation.input.model" }, ModelSeatVoid),
    );
  });

  // Hide the New Session hero row (workspace chip + agent preset chip). The
  // chips are host-built components without a slot of their own, so CSS is
  // the only removal surface.
  const style = document.createElement("style");
  style.textContent = HERO_ROW_HIDE_CSS;
  (document.head ?? document.documentElement).appendChild(style);
  ctx.effect(() => () => style.remove(), "custom-ui: hero row style");

  // Ctrl+K → (within 1s) Ctrl+M opens the /model popup for the current session.
  ctx.inject(["commandUi", "sessions", "modelDirectories"], (scope) => {
    const command = scope.commandUi;
    const sessions = scope.sessions as unknown as ISessions;
    const models = scope.modelDirectories;

    const openModelPopup = () => {
      // Current ordinary session only (spec M8: nothing on the New Session
      // screen; addressed subagent sessions expose no model selection, same
      // availability rule as the stock /model command).
      const id = chordPopupTarget(sessions.list.getSnapshot().current, (sessionId) =>
        sessions.subagentAddress(sessionId),
      );
      if (id === undefined) return;
      const actx = sessions.scope(id);
      if (actx === undefined) return;
      const directory = models.directoryFor(id);
      command.popupFor(actx).open(
        "model",
        {
          options: async () => optionsOf(await directory.load()),
          onSelect: async (option) => {
            const selection = selectionOf(directory.store.getSnapshot(), option.id);
            if (selection === undefined) throw new Error("this provider's catalog failed to load — pick a model from a loaded group");
            await directory.select(selection);
          },
        },
        { sessionId: id },
        { via: "enter", token: "model" },
      );
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
    ctx.effect(() => () => document.removeEventListener("keydown", onKeyDown, true), "custom-ui: chord keydown");
  });
}
