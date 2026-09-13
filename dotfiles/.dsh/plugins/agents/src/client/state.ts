// State fetching: transport and wire contract between the browser half and
// the host's exact /api route. Kept react-free so the adjacent test runs
// without the react dependency.
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { AGENTS_STATE_PATH } from "../state-rpc.ts";
import { parseDisplayState, type AgentDisplayState } from "./format.ts";

/** Minimal fetch face: avoids the runtime-specific `typeof fetch` shape. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Build the state fetcher: POST the session id to the plugin's exact /api
 * route (same-origin fetch rides the browser-auth cookie). Any failure —
 * transport, non-2xx, or malformed body — reads as unmanaged so the display
 * stays silent instead of showing stale state.
 */
export function createStateFetcher(
  doFetch: FetchLike,
): (sessionId: SessionId) => Promise<AgentDisplayState> {
  return async (sessionId) => {
    try {
      const response = await doFetch(AGENTS_STATE_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!response.ok) return { managed: false };
      return parseDisplayState(await response.json());
    } catch {
      return { managed: false };
    }
  };
}
