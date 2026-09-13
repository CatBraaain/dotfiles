/** Browser client half: keep the current session id visible (and copyable) under the composer. */
import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
// Context augmentation: the `ctx.slots` registry service.
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
// SlotMap augmentation: 'conversation.composer.dock' is a session-scope list.
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
// SessionStandardProps augmentation: session-scope slot props carry `sessionId`.
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
// Shell-resident UI primitives: standard button, copy icons, clipboard helper.
import {
  Button,
  IconCheckOutline16,
  IconCopyOutline16,
  writeClipboard,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { formatSessionLabel } from "./format";
import { registerSessionIdFooter } from "./apply";

/** Services this client half touches (the slot registry only). */
export const inject = ["slots"];

/**
 * The session-scope standard props this component consumes. The runtime hands
 * every session-scope slot component the current `sessionId` (plus hooks this
 * entry does not read), so no host-side wiring exists.
 */
interface SessionIdFooterProps {
  readonly sessionId: SessionId;
}

/** How long the check icon stays before reverting to the copy icon. */
const COPIED_RESET_MS = 1000;

/**
 * Gap between the composer card and this row, matching the stock stats row
 * (StatsPills root padding-top) that shares the composer dock seat.
 */
const DOCK_ROW_GAP_PX = 4;

function SessionIdFooter({ sessionId }: SessionIdFooterProps): ReactNode {
  const [copied, setCopied] = useState(false);
  /** Non-null while the copied flag is showing; doubles as the re-click guard. */
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the pending revert when the footer unmounts (session switch).
  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  const onCopy = (): void => {
    if (resetTimer.current !== null) return;
    void writeClipboard(sessionId).then((ok) => {
      if (!ok || resetTimer.current !== null) return;
      setCopied(true);
      resetTimer.current = setTimeout(() => {
        resetTimer.current = null;
        setCopied(false);
      }, COPIED_RESET_MS);
    });
  };

  return createElement(
    Button,
    {
      variant: "ghost",
      size: "sm",
      onClick: onCopy,
      title: copied ? "Copied" : "Copy session ID",
      icon: createElement(copied ? IconCheckOutline16 : IconCopyOutline16),
      style: { marginTop: DOCK_ROW_GAP_PX },
    },
    formatSessionLabel(sessionId),
  );
}

/** Wire the footer entry into the composer dock (registration path lives in ./apply). */
export function apply(ctx: Context): void {
  registerSessionIdFooter(ctx, SessionIdFooter);
}
