/**
 * Browser client half: render the active provider's quota line above the
 * composer card.
 *
 * Polls the host route `/plugins/quota-line/quota.json` (same-origin, served
 * by the host half's exact route) and draws ONE dim text line — the one for
 * the provider of the model the focused session currently has selected
 * (composer model seat, read live via the client `sessions` +
 * `modelDirectories` services; contract ported from dsh-provider-usage).
 * Nothing renders when the selection is unmapped/unknown or that provider's
 * quota is unavailable — the line's presence itself signals availability.
 */
import { createElement, useEffect, useState, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
// Context augmentation: the `ctx.slots` registry service.
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
// SlotMap augmentation: 'conversation.input.dock' is a session-scope list.
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
// SessionStandardProps augmentation: session-scope slot props carry `sessionId`.
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import {
  resolveActiveRouteProvider,
  subscribeActiveChange,
  quotaIdForRouteProvider,
  type ActiveProviderServices,
} from "./active";
import { lineForProvider } from "./format";
import { registerQuotaLine } from "./apply";

/** Services this client half touches (slot registry + live session/model state). */
export const inject = ["slots", "sessions", "modelDirectories"];

const POLL_INTERVAL_MS = 60_000;
const QUOTA_ROUTE = "/plugins/quota-line/quota.json";

/** Dim secondary text matching the neighboring stock rows. */
const ROOT_STYLE: Readonly<Record<string, string>> = {
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: "var(--dsh-content-font-size-secondary, 13px)",
  lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
};

export function apply(ctx: Context): void {
  const services = ctx as unknown as ActiveProviderServices;
  const getActiveQuotaId = (): string | undefined =>
    quotaIdForRouteProvider(resolveActiveRouteProvider(services));

  function QuotaLine(): ReactNode {
    const [payload, setPayload] = useState<unknown>(null);
    const [, bumpActive] = useState(0);

    useEffect(() => {
      let alive = true;
      const load = () => {
        fetch(QUOTA_ROUTE)
          .then((res) => res.json() as Promise<unknown>)
          .then((next) => {
            if (alive) setPayload(next);
          })
          .catch(() => {
            // Route unreachable (plugin removed, host restarting): keep silent.
          });
      };
      load();
      const timer = setInterval(() => {
        if (!document.hidden) load();
      }, POLL_INTERVAL_MS);
      const onVisible = () => {
        if (!document.hidden) load();
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        alive = false;
        clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisible);
      };
    }, []);

    // Re-derive the line the moment the focused session or its model
    // selection changes — no need to wait for the next poll tick.
    useEffect(() => subscribeActiveChange(services, () => bumpActive((count) => count + 1)), []);

    const line = lineForProvider(payload, getActiveQuotaId());
    if (line === null) return null;
    return createElement("div", { style: ROOT_STYLE }, line);
  }

  registerQuotaLine(ctx, QuotaLine);
}
