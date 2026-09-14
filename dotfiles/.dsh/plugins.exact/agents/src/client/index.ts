/** Browser client half: show the live agents.yaml agent and class above the
 * composer, each row a button opening a primitives Menu selector. */
import { createElement, useEffect, useState, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Menu } from "@deepseek-ai/dsh-client-ui-primitives";
// Context augmentation: the `ctx.slots` registry service.
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
// SlotMap augmentation: 'conversation.input.dock' is a session-scope list.
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
// SessionStandardProps augmentation: session-scope slot props carry `sessionId`.
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SelectKind } from "../state-rpc.ts";
import {
  AGENTS_TRIGGER_CSS,
  registerAgentClassDisplay,
  TRIGGER_CLASS,
} from "./apply";
import { startStatePoller } from "./controller";
import {
  agentLineLabel,
  classLineLabel,
  type AgentDisplayState,
} from "./format";
import { createSelectSender, createStateFetcher, type SelectSenderResult } from "./state.ts";

/** Services this client half touches (the slot registry only). */
export const inject = ["slots"];

/** Poll cadence; the display follows host-side switches within this delay. */
const POLL_INTERVAL_MS = 2000;

/**
 * Dock row band, the first-party convention (TodoPanel / skill-status): a
 * centered band as wide as the composer card, so the agent/class rows sit
 * aligned on top of the `🎯 skills:` row instead of hugging the dock's left
 * edge. The column keeps each Menu's inline-flex trigger span at content
 * width, stacking the two selector rows.
 */
const DISPLAY_STYLE: Readonly<Record<string, string>> = {
  boxSizing: "border-box",
  width: "calc(100% - var(--dsh-composer-side-clearance) * 2 - var(--dsh-composer-dock-inset) * 4)",
  maxWidth: "calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) * 4)",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: "var(--dsh-content-font-size-secondary, 13px)",
  lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
};

/**
 * The row buttons inherit the gray caption tone (repo gray policy). The
 * background reset and the stock hover fill arrive through `AGENTS_TRIGGER_CSS`;
 * the negative margin keeps the label flush with the band edge while the
 * padding gives the fill breathing room like the stock chips.
 */
const TRIGGER_STYLE: Readonly<Record<string, string>> = {
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: "var(--dsh-content-font-size-secondary, 13px)",
  lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
  border: "none",
  borderRadius: "6px",
  padding: "0 6px",
  margin: "0 -6px",
  font: "inherit",
  textAlign: "inherit",
  cursor: "pointer",
};

interface DisplayProps {
  readonly sessionId: SessionId;
  readonly fetchState: (sessionId: SessionId) => Promise<AgentDisplayState>;
  readonly select: (
    sessionId: SessionId,
    kind: SelectKind,
    name: string,
  ) => Promise<SelectSenderResult>;
  /**
   * Seed state for server rendering (the static fixture): effects never run
   * there, so the first poll cannot populate the rows. The running client
   * omits it and starts unmanaged until the poller speaks.
   */
  readonly initialState?: AgentDisplayState;
}

/** One row: a gray text button opening a primitives Menu above the composer. */
function SelectorMenu({
  label,
  title,
  names,
  selected,
  onPick,
}: {
  readonly label: string;
  readonly title: string;
  readonly names: readonly string[];
  readonly selected: string | undefined;
  readonly onPick: (name: string) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  return createElement(Menu, {
    open,
    anchor: createElement(
      "button",
      {
        type: "button",
        style: TRIGGER_STYLE,
        className: TRIGGER_CLASS,
        title,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        onClick: () => setOpen((current) => !current),
      },
      label,
    ),
    items: names.map((name) => ({ id: name, label: name })),
    selectedId: selected,
    onSelect: (id: string) => {
      setOpen(false);
      onPick(id);
    },
    onClose: () => setOpen(false),
    // Portaled above the trigger so the dock row cannot clip the list.
    portal: true,
    side: "top",
    align: "start",
  });
}

function AgentClassDisplay({
  sessionId,
  fetchState,
  select,
  initialState,
}: DisplayProps): ReactNode {
  const [state, setState] = useState<AgentDisplayState>(initialState ?? { managed: false });
  useEffect(
    () =>
      startStatePoller(POLL_INTERVAL_MS, {
        fetchState: () => fetchState(sessionId),
        onState: setState,
        setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
        clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      }),
    [sessionId, fetchState],
  );

  const agentLabel = agentLineLabel(state);
  if (agentLabel === undefined) return null;
  const classLabel = classLineLabel(state);

  // Apply one menu pick; an accepted pick refreshes immediately instead of
  // waiting for the next poll tick, a rejected one leaves the display as-is
  // (the next tick re-syncs with the host truth).
  const pick = async (kind: SelectKind, name: string): Promise<void> => {
    const result = await select(sessionId, kind, name);
    if (!result.ok) return;
    try {
      setState(await fetchState(sessionId));
    } catch {
      // The next poll tick re-syncs.
    }
  };

  return createElement(
    "div",
    { style: DISPLAY_STYLE },
    createElement(SelectorMenu, {
      label: agentLabel,
      title: "Select agent",
      names: state.agents ?? [],
      selected: state.agent,
      onPick: (name: string) => void pick("agent", name),
    }),
    classLabel !== undefined &&
      createElement(SelectorMenu, {
        label: classLabel,
        title: "Select class",
        names: state.classes ?? [],
        selected: state.className,
        onPick: (name: string) => void pick("class", name),
      }),
  );
}

/** Wire the display above the composer (registration path lives in ./apply). */
export function apply(ctx: Context): void {
  const style = document.createElement("style");
  style.textContent = AGENTS_TRIGGER_CSS;
  (document.head ?? document.documentElement).appendChild(style);
  ctx.effect(() => () => style.remove(), "agent-class: style");
  const fetchState = createStateFetcher(globalThis.fetch);
  const select = createSelectSender(globalThis.fetch);
  const component: unknown = (props: Omit<DisplayProps, "fetchState" | "select">) =>
    createElement(AgentClassDisplay, { ...props, fetchState, select });
  registerAgentClassDisplay(ctx, component);
}
