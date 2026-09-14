// State fetching: transport and wire contract between the browser half and
// the host's exact /api route. Kept react-free so the adjacent test runs
// without the react dependency.
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { AGENTS_SELECT_PATH, AGENTS_STATE_PATH, type SelectKind } from "../state-rpc.ts";
import { parseDisplayState, type AgentDisplayState } from "./format.ts";

/** Minimal fetch face: avoids the runtime-specific `typeof fetch` shape. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Validate the state route's managed payload before narrowing it for display. */
function parseStatePayload(value: unknown): AgentDisplayState {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("invalid agents state payload");
  }
  const payload = value as Record<string, unknown>;
  if (payload.managed === false) return { managed: false };
  if (
    payload.managed !== true ||
    typeof payload.agent !== "string" ||
    payload.agent === "" ||
    typeof payload.className !== "string" ||
    payload.className === "" ||
    typeof payload.manual !== "boolean" ||
    !isStringArray(payload.agents) ||
    !isStringArray(payload.classes) ||
    (payload.model !== undefined &&
      (typeof payload.model !== "string" || payload.model === ""))
  ) {
    throw new TypeError("invalid agents state payload");
  }
  return parseDisplayState(payload);
}

/**
 * Build the state fetcher: POST the session id to the plugin's exact /api
 * route (same-origin fetch rides the browser-auth cookie). Failures reject so
 * the reader can keep the last display state; a valid unmanaged response still
 * clears the display.
 */
export function createStateFetcher(
  doFetch: FetchLike,
): (sessionId: SessionId) => Promise<AgentDisplayState> {
  return async (sessionId) => {
    const response = await doFetch(AGENTS_STATE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (!response.ok) throw new Error(`agents state request failed: ${response.status}`);
    return parseStatePayload(await response.json());
  };
}

/** Outcome face the menus need: whether the host accepted the pick. */
export interface SelectSenderResult {
  readonly ok: boolean;
}

/**
 * Build the selection sender: POST one menu pick to the plugin's exact /api
 * select route, which applies it through the same switch points as
 * `/agent <name>` / `/class <name>`. Any failure — transport, non-2xx, or a
 * malformed body — reads as not-accepted so the display keeps its last state
 * (the next poll re-syncs with the host truth).
 */
export function createSelectSender(
  doFetch: FetchLike,
): (sessionId: SessionId, kind: SelectKind, name: string) => Promise<SelectSenderResult> {
  return async (sessionId, kind, name) => {
    try {
      const response = await doFetch(AGENTS_SELECT_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, kind, name }),
      });
      if (!response.ok) return { ok: false };
      const payload: unknown = await response.json().catch(() => undefined);
      if (typeof payload !== "object" || payload === null) return { ok: false };
      return { ok: (payload as { ok?: unknown }).ok === true };
    } catch {
      return { ok: false };
    }
  };
}
