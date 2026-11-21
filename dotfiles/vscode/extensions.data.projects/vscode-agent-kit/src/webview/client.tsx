/**
 * Webview client built on React. sessionListView stays a pure function that
 * builds the view as an element-descriptor tree; the SessionsApp component
 * materializes that tree into React elements and wires it to the page's fixed
 * markup and a message bridge.
 */

import {
  createElement,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
import { createRoot } from "react-dom/client";
import { initDocumentScrollbar } from "./documentScrollbar";

/** Per-workspace display mode: unarchived sessions only, or all sessions. */
export type ViewMode = "unarchived" | "all";

type SessionLoadStatus = "loading" | "loaded" | "error";

/** Live execution phase of a session, mirrored from the session state store. */
export type SessionPhase = "running" | "waiting-approval" | "waiting-user";

/** Display-only session data (the extension sends WebviewState-shaped values). */
export interface ClientSession {
  sessionId: string;
  displayName: string;
  updatedAtMs: number | null;
  isArchived: boolean;
  /** Live execution phase; undefined when the phase is unknown. */
  state?: SessionPhase;
  hasUnread?: boolean;
  /** True while a state publication is known to be incomplete for the session. */
  publishDelayed?: boolean;
}

export interface ClientSessionGroup {
  cwd: string;
  label: string;
  sessions: ClientSession[];
}

/** State sent by the extension host: every session of every workspace
 * group, plus the session its shared display terminal currently shows. */
export interface ClientState {
  groups: ClientSessionGroup[];
  /** Session the shared display terminal shows; undefined when it shows none. */
  displayedSessionId?: string;
}

/** Element descriptor: tag plus optional attributes and children (text allowed). */
export interface ElementDescriptor {
  tag: string;
  key?: string;
  attrs?: Record<string, string>;
  children?: (ElementDescriptor | string)[];
}

/** Dynamic region of the view: per-workspace groups filtered by their mode. */
export interface SessionListView {
  sessions: ElementDescriptor[];
}

/** Guidance shown in the list area while no group is displayable. */
const EMPTY_LIST_MESSAGES = {
  loading: "Loading sessions…",
  error: "Failed to load sessions. Retrying…",
  loaded: "No sessions yet",
} as const;

/** Message bridge to the extension host (or a preview stub). */
export interface ClientBridge {
  postMessage(request: unknown): void;
  onMessage(callback: (message: unknown) => void): void;
}

export function visibleSessions(
  state: ClientState,
  modes: ReadonlyMap<string, ViewMode> = new Map(),
  collapsedCwds: ReadonlySet<string> = new Set(),
): ClientSession[] {
  return state.groups.flatMap((group) =>
    visibleGroupSessions(group, modes.get(group.cwd) ?? "unarchived", collapsedCwds),
  );
}

function visibleGroupSessions(
  group: ClientSessionGroup,
  mode: ViewMode,
  collapsedCwds: ReadonlySet<string>,
): ClientSession[] {
  if (collapsedCwds.has(group.cwd)) return [];
  return mode === "unarchived"
    ? group.sessions.filter((session) => !session.isArchived)
    : group.sessions;
}

export function sessionListView(
  state: ClientState,
  modes: ReadonlyMap<string, ViewMode> = new Map(),
  displayedSessionId: string | undefined = undefined,
  collapsedCwds: ReadonlySet<string> = new Set(),
  loadStatus: SessionLoadStatus = "loaded",
  workspaceMenuCwd?: string,
  pendingNewSessionCwds: ReadonlySet<string> = new Set(),
  pendingArchiveIds: ReadonlySet<string> = new Set(),
  pendingUnarchiveIds: ReadonlySet<string> = new Set(),
): SessionListView {
  const groups = state.groups.map((group) =>
    groupDescriptor(
      group,
      modes.get(group.cwd) ?? "unarchived",
      displayedSessionId,
      collapsedCwds,
      workspaceMenuCwd,
      pendingNewSessionCwds.has(group.cwd),
      pendingArchiveIds,
      pendingUnarchiveIds,
    ),
  );
  if (groups.length > 0) return { sessions: groups };
  return {
    sessions: [
      { tag: "p", attrs: { class: "empty" }, children: [EMPTY_LIST_MESSAGES[loadStatus]] },
    ],
  };
}

function groupDescriptor(
  group: ClientSessionGroup,
  mode: ViewMode,
  displayedSessionId: string | undefined,
  collapsedCwds: ReadonlySet<string>,
  workspaceMenuCwd: string | undefined,
  isStartingSession: boolean,
  pendingArchiveIds: ReadonlySet<string> = new Set(),
  pendingUnarchiveIds: ReadonlySet<string> = new Set(),
): ElementDescriptor {
  const isExpanded = !collapsedCwds.has(group.cwd);
  const sessions = visibleGroupSessions(group, mode, collapsedCwds);
  return {
    tag: "section",
    key: group.cwd,
    attrs: { class: "group", "data-group-cwd": group.cwd },
    children: [
      {
        tag: "div",
        attrs: { class: "group-header", title: group.cwd, "data-workspace-menu": group.cwd },
        children: [
          {
            tag: "div",
            attrs: { class: "group-identity" },
            children: [
              {
                tag: "div",
                attrs: { class: "group-toggle" },
                children: [
                  {
                    tag: "button",
                    attrs: {
                      class: "group-chevron",
                      type: "button",
                      "data-toggle-group": group.cwd,
                      "aria-expanded": String(isExpanded),
                      "aria-label": `${isExpanded ? "Collapse" : "Expand"} ${group.label}`,
                    },
                    children: [chevronIcon(isExpanded ? "down" : "right")],
                  },
                  {
                    tag: "button",
                    attrs: {
                      class: "group-title",
                      type: "button",
                      "data-toggle-group": group.cwd,
                      "aria-expanded": String(isExpanded),
                    },
                    children: [group.label],
                  },
                ],
              },
              {
                tag: "button",
                attrs: {
                  class: "group-workspace-menu",
                  type: "button",
                  tabIndex: "-1",
                  "data-open-workspace-menu": group.cwd,
                  title: "Workspace actions",
                  "aria-label": "Workspace actions",
                  "aria-haspopup": "menu",
                  "aria-expanded": String(group.cwd === workspaceMenuCwd),
                },
                children: [
                  strokeIcon([{ tag: "path", attrs: { d: "M5 12h.01M12 12h.01M19 12h.01" } }]),
                ],
              },
            ],
          },
          modeToggleDescriptor(group.cwd, mode),
          {
            tag: "button",
            attrs: {
              class: "group-new-session",
              type: "button",
              "data-new-session": group.cwd,
              title: "New session",
              "aria-label": `New session in ${group.label}`,
              "aria-busy": String(isStartingSession),
            },
            children: [isStartingSession ? spinnerIcon() : plusIcon()],
          },
        ],
      },
      ...sessions.map((session) =>
        sessionDescriptor(
          session,
          displayedSessionId,
          pendingArchiveIds.has(session.sessionId),
          pendingUnarchiveIds.has(session.sessionId),
        ),
      ),
    ],
  };
}

function modeToggleDescriptor(cwd: string, mode: ViewMode): ElementDescriptor {
  const label = mode === "unarchived" ? "Show all sessions" : "Show unarchived sessions";
  return {
    tag: "button",
    attrs: {
      class: "group-mode-toggle",
      type: "button",
      "data-mode-toggle": cwd,
      "data-mode": mode,
      title: label,
      "aria-label": label,
    },
    children: [visibilityIcon(mode)],
  };
}

function visibilityIcon(mode: ViewMode): ElementDescriptor {
  const paths: Record<ViewMode, string> = {
    unarchived:
      "M10.1196 10.8267L14.1464 14.8536C14.3417 15.0488 14.6583 15.0488 14.8536 14.8536C15.0488 14.6583 15.0488 14.3417 14.8536 14.1464L1.85355 1.14645C1.65829 0.951184 1.34171 0.951184 1.14645 1.14645C0.951184 1.34171 0.951184 1.65829 1.14645 1.85355L4.37624 5.08334C3.90117 5.4183 3.5126 5.80026 3.19877 6.18295C2.75443 6.72477 2.46154 7.26493 2.27931 7.66977C2.18795 7.87274 2.12369 8.04329 2.08166 8.1653C2.06063 8.22636 2.03453 8.31047 2.03453 8.31047L2.01687 8.37186C2.01687 8.37186 1.94098 8.86907 2.37202 8.9833C2.63879 9.05404 2.91251 8.8948 2.98346 8.62815L2.98444 8.62471L2.99179 8.5997C2.9989 8.57616 3.01051 8.53927 3.02715 8.49095C3.06047 8.39421 3.11375 8.25227 3.19119 8.08023C3.34655 7.73507 3.59627 7.27523 3.97201 6.81706C4.26363 6.46146 4.63213 6.10494 5.09595 5.80306L6.67356 7.38067C5.9688 7.82277 5.50024 8.60667 5.50024 9.5C5.50024 10.8807 6.61953 12 8.00024 12C8.89358 12 9.67747 11.5314 10.1196 10.8267ZM9.3807 10.0878C9.15205 10.6241 8.62005 11 8.00024 11C7.17182 11 6.50024 10.3284 6.50024 9.5C6.50024 8.88019 6.87616 8.34819 7.41244 8.11955L9.3807 10.0878ZM6.31962 4.19853L7.174 5.05291C7.43366 5.01852 7.70875 5 8.00017 5C10.0445 5 11.2857 5.9115 12.0283 6.81706C12.4041 7.27523 12.6538 7.73507 12.8091 8.08023C12.8866 8.25227 12.9399 8.39421 12.9732 8.49095C12.9898 8.53927 13.0014 8.57616 13.0085 8.5997L13.0159 8.62471L13.0169 8.62815L13.0172 8.62937C13.0885 8.89555 13.3618 9.05397 13.6283 8.9833C13.8952 8.91253 14.0542 8.63878 13.9835 8.37186L13.9832 8.37069L13.9827 8.36916L13.9816 8.365L13.9781 8.35236C13.9752 8.34204 13.9711 8.328 13.9658 8.31047C13.9552 8.27541 13.9397 8.22636 13.9187 8.1653C13.8766 8.04329 13.8124 7.87274 13.721 7.66977C13.5388 7.26493 13.2459 6.72477 12.8016 6.18295C11.904 5.0885 10.3952 4 8.00017 4C7.38264 4 6.82403 4.07236 6.31962 4.19853Z",
    all: "M2.98444 8.62471L2.98346 8.62815C2.91251 8.8948 2.63879 9.05404 2.37202 8.9833C1.94098 8.86907 2.01687 8.37186 2.01687 8.37186L2.03453 8.31047C2.03453 8.31047 2.06063 8.22636 2.08166 8.1653C2.12369 8.04329 2.18795 7.87274 2.27931 7.66977C2.46154 7.26493 2.75443 6.72477 3.19877 6.18295C4.09629 5.08851 5.60509 4 8.00017 4C10.3952 4 11.904 5.08851 12.8016 6.18295C13.2459 6.72477 13.5388 7.26493 13.721 7.66977C13.8124 7.87274 13.8766 8.04329 13.9187 8.1653C13.9397 8.22636 13.9552 8.27541 13.9658 8.31047C13.9711 8.328 13.9752 8.34204 13.9781 8.35236L13.9816 8.365L13.9827 8.36916L13.9832 8.37069L13.9835 8.37186C14.0542 8.63878 13.8952 8.91253 13.6283 8.9833C13.3618 9.05397 13.0885 8.89556 13.0172 8.62937L13.0169 8.62815L13.0159 8.62471L13.0085 8.5997C13.0014 8.57616 12.9898 8.53927 12.9732 8.49095C12.9399 8.39422 12.8866 8.25227 12.8091 8.08023C12.6538 7.73508 12.4041 7.27523 12.0283 6.81706C11.2857 5.9115 10.0445 5 8.00017 5C5.95584 5 4.71464 5.9115 3.97201 6.81706C3.59627 7.27523 3.34655 7.73508 3.19119 8.08023C3.11375 8.25227 3.06047 8.39422 3.02715 8.49095C3.01051 8.53927 2.9989 8.57616 2.99179 8.5997L2.98444 8.62471ZM8.00024 7C6.61953 7 5.50024 8.11929 5.50024 9.5C5.50024 10.8807 6.61953 12 8.00024 12C9.38096 12 10.5002 10.8807 10.5002 9.5C10.5002 8.11929 9.38096 7 8.00024 7ZM6.50024 9.5C6.50024 8.67157 7.17182 8 8.00024 8C8.82867 8 9.50024 8.67157 9.50024 9.5C9.50024 10.3284 8.82867 11 8.00024 11C7.17182 11 6.50024 10.3284 6.50024 9.5Z",
  };
  return {
    tag: "svg",
    attrs: {
      width: "16",
      height: "16",
      viewBox: "0 0 16 16",
      fill: "currentColor",
      "data-mode-icon": mode,
      "aria-hidden": "true",
      focusable: "false",
    },
    children: [{ tag: "path", attrs: { d: paths[mode] } }],
  };
}

function sessionDescriptor(
  session: ClientSession,
  displayedSessionId: string | undefined,
  isArchiving = false,
  isUnarchiving = false,
): ElementDescriptor {
  const rowClass = [
    "session-row",
    session.sessionId === displayedSessionId ? "selected" : "",
    session.isArchived ? "archived" : "",
  ]
    .filter((className) => className !== "")
    .join(" ");
  const title = [
    session.displayName,
    session.sessionId,
    phaseLabel(session.state),
    session.publishDelayed ? PUBLISH_DELAYED_HINT : undefined,
    session.state === "waiting-user" && session.hasUnread && !session.isArchived
      ? "Unread"
      : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
  return {
    tag: "div",
    key: session.sessionId,
    attrs: { class: rowClass, "data-row-session": session.sessionId },
    children: [
      {
        tag: "button",
        attrs: {
          class: "session-button",
          type: "button",
          "data-session": session.sessionId,
          title,
        },
        children: [
          {
            tag: "span",
            attrs: {
              class: "session-status",
              "data-archived": String(session.isArchived),
              "data-unread": String(session.hasUnread === true && !session.isArchived),
              ...(session.state === undefined ? {} : { "data-state": session.state }),
              ...(session.publishDelayed ? { "data-delayed": "true" } : {}),
              "aria-hidden": "true",
            },
            children: [
              ...sessionStatusIcons(session),
              ...(session.publishDelayed ? [publishDelayDot()] : []),
            ],
          },
          { tag: "span", attrs: { class: "session-name" }, children: [session.displayName] },
        ],
      },
      {
        tag: "span",
        attrs: { class: "session-timestamp" },
        children: [formatSessionTimestamp(session.updatedAtMs)],
      },
      session.isArchived
        ? unarchiveDescriptor(session.sessionId, isUnarchiving)
        : archiveDescriptor(session.sessionId, isArchiving),
    ],
  };
}

function sessionStatusIcons(session: ClientSession): ElementDescriptor[] {
  if (session.isArchived) return [];
  if (session.state === "running") {
    return [spinnerIcon()];
  }
  if (session.state === "waiting-approval") {
    return [
      strokeIcon([
        { tag: "path", attrs: { d: "M9 4v16" } },
        { tag: "path", attrs: { d: "M15 4v16" } },
      ]),
    ];
  }
  if (session.state === "waiting-user" && session.hasUnread) {
    return [unreadBellIcon()];
  }
  return [];
}

function unreadBellIcon(): ElementDescriptor {
  return strokeIcon([
    { tag: "path", attrs: { d: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" } },
    { tag: "path", attrs: { d: "M10 21a2 2 0 0 0 4 0" } },
  ]);
}

/** Human-readable phase line for the session row tooltip. */
function phaseLabel(state: SessionPhase | undefined): string | undefined {
  if (state === "running") return "Running";
  if (state === "waiting-approval") return "Waiting for approval";
  if (state === "waiting-user") return "Waiting for user";
  return undefined;
}

/** Tooltip line for a session whose state publication is incomplete. */
const PUBLISH_DELAYED_HINT = "State update delayed";

/** Warning dot in the status slot marking a session whose state publication is incomplete. */
function publishDelayDot(): ElementDescriptor {
  return { tag: "span", attrs: { class: "session-delay-dot" } };
}

export function formatSessionTimestamp(updatedAtMs: number | null, now = new Date()): string {
  if (updatedAtMs === null) return "";
  const updatedAt = new Date(updatedAtMs);
  const isToday =
    updatedAt.getFullYear() === now.getFullYear() &&
    updatedAt.getMonth() === now.getMonth() &&
    updatedAt.getDate() === now.getDate();
  const parts = isToday
    ? [updatedAt.getHours(), updatedAt.getMinutes()]
    : [updatedAt.getMonth() + 1, updatedAt.getDate()];
  return parts.map((part) => String(part).padStart(2, "0")).join(isToday ? ":" : "/");
}

/** Overlay button at the row's right edge that archives the session. */
function archiveDescriptor(sessionId: string, isPending = false): ElementDescriptor {
  return {
    tag: "button",
    attrs: {
      class: "archive",
      type: "button",
      "data-archive": sessionId,
      title: "Archive",
      "aria-label": "Archive",
      "aria-busy": String(isPending),
    },
    children: [isPending ? spinnerIcon() : archiveIcon()],
  };
}

/** Overlay button at the row's right edge that restores the archived session to the default list. */
function unarchiveDescriptor(sessionId: string, isPending = false): ElementDescriptor {
  return {
    tag: "button",
    attrs: {
      class: "unarchive",
      type: "button",
      "data-unarchive": sessionId,
      title: "Unarchive",
      "aria-label": "Unarchive",
      "aria-busy": String(isPending),
    },
    children: [isPending ? spinnerIcon() : unarchiveIcon()],
  };
}

function chevronIcon(direction: "down" | "right"): ElementDescriptor {
  const path = direction === "down" ? "m6 9 6 6 6-6" : "m9 18 6-6-6-6";
  return strokeIcon([{ tag: "path", attrs: { d: path } }]);
}

function spinnerIcon(): ElementDescriptor {
  return strokeIcon([{ tag: "path", attrs: { d: "M21 12a9 9 0 1 1-6.219-8.56" } }]);
}

function plusIcon(): ElementDescriptor {
  return strokeIcon([
    { tag: "path", attrs: { d: "M5 12h14" } },
    { tag: "path", attrs: { d: "M12 5v14" } },
  ]);
}

function archiveIcon(): ElementDescriptor {
  return strokeIcon([
    { tag: "rect", attrs: { width: "20", height: "5", x: "2", y: "3", rx: "1" } },
    { tag: "path", attrs: { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" } },
    { tag: "path", attrs: { d: "M10 12h4" } },
  ]);
}

function unarchiveIcon(): ElementDescriptor {
  return strokeIcon([
    { tag: "rect", attrs: { width: "20", height: "5", x: "2", y: "3", rx: "1" } },
    { tag: "path", attrs: { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" } },
    { tag: "path", attrs: { d: "M12 16v-6" } },
    { tag: "path", attrs: { d: "m9 13 3-3 3 3" } },
  ]);
}

function strokeIcon(children: ElementDescriptor[]): ElementDescriptor {
  return {
    tag: "svg",
    attrs: {
      width: "12",
      height: "12",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    children,
  };
}

/** Click actions the descriptor tree offers; wired by the SessionsApp. */
interface DescriptorActions {
  onGroupToggle(cwd: string): void;
  onModeToggle(cwd: string): void;
  onNewSessionClick(cwd: string): void;
  onWorkspaceMenuOpen(menu: WorkspaceMenuState): void;
  onWorkspaceMenuToggle(menu: WorkspaceMenuState): void;
  onSessionClick(sessionId: string): void;
  onArchiveClick(sessionId: string): void;
  onUnarchiveClick(sessionId: string): void;
}

/** Map descriptor attribute names to React prop names (class -> className). */
function descriptorProps(descriptor: ElementDescriptor): Record<string, unknown> {
  const props: Record<string, unknown> = { key: descriptor.key };
  for (const [name, value] of Object.entries(descriptor.attrs ?? {})) {
    if (name === "class") {
      props.className = value;
    } else {
      props[name] = value;
    }
  }
  return props;
}

/** Attach the delegated-click behavior of initClient's predecessor to the
 * descriptor's buttons, mirroring the fixed request protocol. */
function descriptorOnClick(
  descriptor: ElementDescriptor,
  actions: DescriptorActions,
): (() => void) | undefined {
  if (descriptor.tag !== "button") return undefined;
  const attrs = descriptor.attrs ?? {};
  const modeCwd = attrs["data-mode-toggle"];
  if (modeCwd !== undefined) return () => actions.onModeToggle(modeCwd);
  const groupCwd = attrs["data-toggle-group"];
  if (groupCwd !== undefined) return () => actions.onGroupToggle(groupCwd);
  const newSessionCwd = attrs["data-new-session"];
  if (newSessionCwd !== undefined) return () => actions.onNewSessionClick(newSessionCwd);
  const sessionId = attrs["data-archive"] ?? attrs["data-unarchive"] ?? attrs["data-session"];
  if (sessionId === undefined) return undefined;
  if (attrs["data-archive"] !== undefined) return () => actions.onArchiveClick(sessionId);
  if (attrs["data-unarchive"] !== undefined) return () => actions.onUnarchiveClick(sessionId);
  return () => actions.onSessionClick(sessionId);
}

const StaticDescriptor = memo(
  function StaticDescriptor({
    descriptor,
    actions,
  }: {
    descriptor: ElementDescriptor;
    actions: DescriptorActions;
  }): ReactElement {
    return descriptorToElement(descriptor, actions);
  },
  (previous, next) => JSON.stringify(previous.descriptor) === JSON.stringify(next.descriptor),
);

/** Materialize a descriptor as a React element (SVG tags included). */
function descriptorToElement(
  descriptor: ElementDescriptor,
  actions: DescriptorActions,
): ReactElement {
  if (descriptor.attrs?.class === "session-status") {
    return <SessionStatus key={descriptor.key} descriptor={descriptor} actions={actions} />;
  }
  const props: Record<string, unknown> = descriptorProps(descriptor);
  const onClick = descriptorOnClick(descriptor, actions);
  if (onClick !== undefined) props.onClick = onClick;
  const menuTriggerCwd = descriptor.attrs?.["data-open-workspace-menu"];
  if (menuTriggerCwd !== undefined) {
    props.onClick = (event: ReactMouseEvent<HTMLElement>) => {
      if (event.detail === 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      actions.onWorkspaceMenuToggle({ cwd: menuTriggerCwd, x: rect.left, y: rect.bottom });
    };
  }
  const menuCwd = descriptor.attrs?.["data-workspace-menu"];
  if (menuCwd !== undefined) {
    props.onContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      if (event.button !== 2) return;
      actions.onWorkspaceMenuOpen({ cwd: menuCwd, x: event.clientX, y: event.clientY });
    };
  }
  return createElement(
    descriptor.tag,
    props,
    ...(descriptor.children ?? []).map((child) =>
      typeof child === "string" ? child : descriptorToElement(child, actions),
    ),
  );
}

function SessionStatus({
  descriptor,
  actions,
}: {
  descriptor: ElementDescriptor;
  actions: DescriptorActions;
}): ReactElement {
  const canFade =
    descriptor.attrs?.["data-state"] === "waiting-user" &&
    descriptor.attrs?.["data-archived"] === "false";
  const isUnread = canFade && descriptor.attrs?.["data-unread"] === "true";
  const [visibility, setVisibility] = useState({ unread: isUnread, fading: false });
  if (visibility.unread !== isUnread || (visibility.fading && !canFade)) {
    setVisibility({
      unread: isUnread,
      fading:
        visibility.unread &&
        !isUnread &&
        canFade &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    });
  }
  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    function onMotionChange(): void {
      if (motion.matches) setVisibility((previous) => ({ ...previous, fading: false }));
    }
    motion.addEventListener("change", onMotionChange);
    return () => motion.removeEventListener("change", onMotionChange);
  }, []);

  const children = visibility.fading ? [unreadBellIcon()] : (descriptor.children ?? []);
  return createElement(
    "span",
    {
      ...descriptorProps(descriptor),
      "data-fading": String(visibility.fading),
      onAnimationEnd: () => setVisibility((previous) => ({ ...previous, fading: false })),
    },
    ...children.map((child) =>
      typeof child === "string" ? child : descriptorToElement(child, actions),
    ),
  );
}

interface WorkspaceMenuState {
  cwd: string;
  x: number;
  y: number;
}

function WorkspaceMenu({
  menu,
  onClose,
  onUnregister,
}: {
  menu: WorkspaceMenuState;
  onClose: () => void;
  onUnregister: (cwd: string) => void;
}): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    const viewportPadding = 4;
    element.style.left = `${Math.max(viewportPadding, Math.min(menu.x, window.innerWidth - rect.width - viewportPadding))}px`;
    element.style.top = `${Math.max(viewportPadding, Math.min(menu.y, window.innerHeight - rect.height - viewportPadding))}px`;
  }, [menu]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      if (!(event.target instanceof Node)) return;
      if (event.target instanceof Element && event.target.closest("[data-open-workspace-menu]"))
        return;
      if (!menuRef.current?.contains(event.target)) onClose();
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="workspace-menu"
      role="menu"
      aria-label="Workspace actions"
      style={{ left: menu.x, top: menu.y }}
    >
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        onClick={(event) => {
          if (event.detail === 0) return;
          onClose();
          onUnregister(menu.cwd);
        }}
      >
        Unregister workspace
      </button>
    </div>
  );
}

interface ClientSnapshot {
  state: ClientState;
  loadStatus: SessionLoadStatus;
  manualRefresh: boolean;
  errorMessage: string;
  connectionError: boolean;
  pendingNewSessions: ReadonlyMap<string, string>;
  /** Archive requests in flight, keyed by request id (value: session id). */
  pendingArchives: ReadonlyMap<string, string>;
  /** Unarchive requests in flight, keyed by request id (value: session id). */
  pendingUnarchives: ReadonlyMap<string, string>;
  /** Whether the latest sessions update came from an in-flight archive/unarchive,
   * so the row movement slides instead of snapping. */
  animated: boolean;
}

/** Latest-value store fed by the bridge; registered synchronously by
 * initClient so no message is lost before React commits. */
function createClientStore(): {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ClientSnapshot;
  setLoading(manualRefresh: boolean, displayedSessionId?: string | null): void;
  setSessions(state: ClientState, animate?: boolean): void;
  setConnectionError(connectionError: boolean): void;
  setError(message: string): void;
  setSessionsError(): void;
  startNewSession(cwd: string): string;
  finishNewSession(requestId: string): void;
  startArchive(sessionId: string): string;
  finishArchive(requestId: string): void;
  startUnarchive(sessionId: string): string;
  finishUnarchive(requestId: string): void;
} {
  let snapshot: ClientSnapshot = {
    state: { groups: [] },
    loadStatus: "loading",
    manualRefresh: false,
    errorMessage: "",
    connectionError: false,
    pendingNewSessions: new Map(),
    pendingArchives: new Map(),
    pendingUnarchives: new Map(),
    animated: false,
  };
  const listeners = new Set<() => void>();
  const publish = (next: ClientSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    setLoading: (manualRefresh, displayedSessionId) =>
      publish({
        ...snapshot,
        state:
          displayedSessionId === undefined
            ? snapshot.state
            : { ...snapshot.state, displayedSessionId: displayedSessionId ?? undefined },
        animated: false,
        loadStatus: "loading",
        manualRefresh,
      }),
    setSessions: (state, animate = false) =>
      publish({
        ...snapshot,
        state,
        animated: animate,
        loadStatus: "loaded",
        manualRefresh: false,
      }),
    setConnectionError: (connectionError) => publish({ ...snapshot, connectionError }),
    setError: (message) => publish({ ...snapshot, errorMessage: message }),
    setSessionsError: () => publish({ ...snapshot, loadStatus: "error", manualRefresh: false }),
    startNewSession: (cwd) => {
      const requestId = crypto.randomUUID();
      const pendingNewSessions = new Map(snapshot.pendingNewSessions);
      pendingNewSessions.set(requestId, cwd);
      publish({ ...snapshot, pendingNewSessions });
      return requestId;
    },
    finishNewSession: (requestId) => {
      if (!snapshot.pendingNewSessions.has(requestId)) return;
      const pendingNewSessions = new Map(snapshot.pendingNewSessions);
      pendingNewSessions.delete(requestId);
      publish({ ...snapshot, pendingNewSessions });
    },
    startArchive: (sessionId) => {
      const requestId = crypto.randomUUID();
      const pendingArchives = new Map(snapshot.pendingArchives);
      pendingArchives.set(requestId, sessionId);
      publish({ ...snapshot, pendingArchives });
      return requestId;
    },
    finishArchive: (requestId) => {
      if (!snapshot.pendingArchives.has(requestId)) return;
      const pendingArchives = new Map(snapshot.pendingArchives);
      pendingArchives.delete(requestId);
      publish({ ...snapshot, pendingArchives });
    },
    startUnarchive: (sessionId) => {
      const requestId = crypto.randomUUID();
      const pendingUnarchives = new Map(snapshot.pendingUnarchives);
      pendingUnarchives.set(requestId, sessionId);
      publish({ ...snapshot, pendingUnarchives });
      return requestId;
    },
    finishUnarchive: (requestId) => {
      if (!snapshot.pendingUnarchives.has(requestId)) return;
      const pendingUnarchives = new Map(snapshot.pendingUnarchives);
      pendingUnarchives.delete(requestId);
      publish({ ...snapshot, pendingUnarchives });
    },
  };
}

const SessionRow = memo(function SessionRow(
  props: ClientSession & {
    isDisplayed: boolean;
    isArchiving: boolean;
    isUnarchiving: boolean;
    currentDay: string;
    actions: DescriptorActions;
  },
): ReactElement {
  return descriptorToElement(
    sessionDescriptor(
      props,
      props.isDisplayed ? props.sessionId : undefined,
      props.isArchiving,
      props.isUnarchiving,
    ),
    props.actions,
  );
});

interface SessionsAppProps {
  bridge: ClientBridge;
  store: ReturnType<typeof createClientStore>;
  statusElement: HTMLElement;
  connectionStatusElement: HTMLElement;
}

/** Slide duration and easing of the archive list transition (DESIGN.md). */
const LIST_SLIDE_TRANSITION = "transform 700ms cubic-bezier(0.45, 0, 0.25, 1)";
/** Safety cleanup after the slide; some pauses skip transitionend. */
const LIST_SLIDE_CLEANUP_MS = 900;

function SessionsApp({
  bridge,
  store,
  statusElement,
  connectionStatusElement,
}: SessionsAppProps): ReactElement {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [modes, setModes] = useState<ReadonlyMap<string, ViewMode>>(() => new Map());
  const [collapsedCwds, setCollapsedCwds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [workspaceMenu, setWorkspaceMenu] = useState<WorkspaceMenuState | null>(null);
  const topPositionsRef = useRef<Map<string, number>>(new Map());
  const hasMenuWorkspace = snapshot.state.groups.some((group) => group.cwd === workspaceMenu?.cwd);

  // Slide the list parts that moved during an in-flight archive/unarchive
  // update. Groups and rows are real elements moving with FLIP, so hit
  // targets stay under the visible list while the whole list slides.
  useLayoutEffect(() => {
    const docTop = (element: HTMLElement): number =>
      element.getBoundingClientRect().top + window.scrollY;
    const measureKey = (element: HTMLElement): string =>
      element.getAttribute("data-group-cwd") ?? element.getAttribute("data-row-session") ?? "";
    const elements = Array.from(document.querySelectorAll<HTMLElement>(".group, .session-row"));
    const previous = topPositionsRef.current;
    const current = new Map<string, number>();
    for (const element of elements) {
      current.set(measureKey(element), docTop(element));
    }
    topPositionsRef.current = current;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!snapshot.animated || reduceMotion) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    const moved: HTMLElement[] = [];
    // Invert the group sections first so the rows inside them keep their
    // visual place; each row then only animates its own extra movement.
    for (const element of elements) {
      if (!element.classList.contains("group")) continue;
      const before = previous.get(measureKey(element));
      if (before === undefined) continue;
      const delta = before - docTop(element);
      if (delta === 0) continue;
      element.style.transition = "none";
      element.style.transform = `translateY(${delta}px)`;
      moved.push(element);
    }
    for (const row of elements) {
      if (row.classList.contains("group")) continue;
      const before = previous.get(measureKey(row));
      if (before === undefined) continue;
      const delta = before - docTop(row);
      if (delta === 0) continue;
      row.style.transition = "none";
      row.style.transform = `translateY(${delta}px)`;
      moved.push(row);
    }
    for (const element of moved) {
      element.getBoundingClientRect();
      element.style.transition = LIST_SLIDE_TRANSITION;
      element.style.transform = "translateY(0)";
      const clear = () => {
        element.style.transition = "";
        element.style.transform = "";
      };
      element.addEventListener("transitionend", clear, { once: true });
      timers.push(setTimeout(clear, LIST_SLIDE_CLEANUP_MS));
    }
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [snapshot.state, snapshot.animated]);

  useEffect(() => {
    if (!hasMenuWorkspace) setWorkspaceMenu(null);
  }, [hasMenuWorkspace]);
  useEffect(() => {
    const loadingText =
      snapshot.loadStatus === "loading" &&
      snapshot.manualRefresh &&
      snapshot.state.groups.length > 0
        ? "Refreshing sessions…"
        : "";
    connectionStatusElement.textContent = snapshot.connectionError
      ? "Connection lost. Retrying…"
      : "";
    statusElement.textContent = [loadingText, snapshot.errorMessage]
      .filter((text) => text !== "")
      .join("\n");
    statusElement.className = snapshot.errorMessage !== "" ? "error" : "";
  }, [snapshot, statusElement, connectionStatusElement]);

  const actions = useMemo<DescriptorActions>(
    () => ({
      onModeToggle: (cwd) =>
        setModes((previous) => {
          const next = new Map(previous);
          next.set(cwd, previous.get(cwd) === "all" ? "unarchived" : "all");
          return next;
        }),
      onGroupToggle: (cwd) =>
        setCollapsedCwds((previous) => {
          const next = new Set(previous);
          if (next.has(cwd)) next.delete(cwd);
          else next.add(cwd);
          return next;
        }),
      onNewSessionClick: (cwd) => {
        const requestId = store.startNewSession(cwd);
        bridge.postMessage({ type: "newSession", cwd, requestId });
      },
      onWorkspaceMenuOpen: setWorkspaceMenu,
      onWorkspaceMenuToggle: (menu) =>
        setWorkspaceMenu((previous) => (previous?.cwd === menu.cwd ? null : menu)),
      onSessionClick: (sessionId) => bridge.postMessage({ type: "openSession", sessionId }),
      onArchiveClick: (sessionId) => {
        const requestId = store.startArchive(sessionId);
        bridge.postMessage({ type: "archiveSession", sessionId, requestId });
      },
      onUnarchiveClick: (sessionId) => {
        const requestId = store.startUnarchive(sessionId);
        bridge.postMessage({ type: "unarchiveSession", sessionId, requestId });
      },
    }),
    [bridge, store],
  );

  const pendingNewSessionCwds = new Set(snapshot.pendingNewSessions.values());
  const pendingArchiveIds = new Set(snapshot.pendingArchives.values());
  const pendingUnarchiveIds = new Set(snapshot.pendingUnarchives.values());
  const currentDay = new Date().toDateString();
  return (
    <>
      {snapshot.state.groups.length === 0 && (
        <p className="empty">{EMPTY_LIST_MESSAGES[snapshot.loadStatus]}</p>
      )}
      {snapshot.state.groups.map((group) => {
        const mode = modes.get(group.cwd) ?? "unarchived";
        const header = groupDescriptor(
          { ...group, sessions: [] },
          mode,
          snapshot.state.displayedSessionId,
          collapsedCwds,
          workspaceMenu?.cwd,
          pendingNewSessionCwds.has(group.cwd),
        );
        return createElement(
          header.tag,
          { ...descriptorProps(header), key: group.cwd },
          ...(header.children ?? []).map((child, index) =>
            typeof child === "string" ? (
              child
            ) : (
              <StaticDescriptor key={index} descriptor={child} actions={actions} />
            ),
          ),
          ...visibleGroupSessions(group, mode, collapsedCwds).map((session) => (
            <SessionRow
              key={session.sessionId}
              {...session}
              isDisplayed={session.sessionId === snapshot.state.displayedSessionId}
              isArchiving={pendingArchiveIds.has(session.sessionId)}
              isUnarchiving={pendingUnarchiveIds.has(session.sessionId)}
              currentDay={currentDay}
              actions={actions}
            />
          )),
        );
      })}
      {workspaceMenu !== null && hasMenuWorkspace && (
        <WorkspaceMenu
          menu={workspaceMenu}
          onClose={() => setWorkspaceMenu(null)}
          onUnregister={(cwd) => bridge.postMessage({ type: "unregisterWorkspace", cwd })}
        />
      )}
    </>
  );
}

/**
 * Mount the React root onto the page's fixed markup. The bridge subscription
 * is registered synchronously, so messages sent right after initClient (the
 * stories catalog resets its demo state this way) are never lost. Returns a
 * dispose function that unmounts the root and removes its listeners;
 * the webview never disposes, the stories catalog disposes on story change.
 */
export function initClient(bridge: ClientBridge): () => void {
  const sessionsElement = document.querySelector("#sessions");
  const statusElement = document.querySelector("#status");
  const connectionStatusElement = document.querySelector("#connection-status");
  const formElement = document.querySelector("#workspace-form");
  const pathInput = document.querySelector("#workspace-path");
  const newWorkspaceButton = document.querySelector('[data-action="toggleWorkspaceForm"]');
  if (
    !(sessionsElement instanceof HTMLElement) ||
    !(statusElement instanceof HTMLElement) ||
    !(connectionStatusElement instanceof HTMLElement) ||
    !(formElement instanceof HTMLElement) ||
    !(pathInput instanceof HTMLInputElement) ||
    !(newWorkspaceButton instanceof HTMLElement)
  ) {
    throw new Error("Sessions webview markup is incomplete.");
  }
  const store = createClientStore();
  const OPERATION_ERROR_DISPLAY_MS = 2_000;
  let operationErrorTimer: ReturnType<typeof setTimeout> | undefined;
  const CONNECTION_IDLE_MS = 5_000;
  const CONNECTION_TIMEOUT_MS = 10_000;
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingConnectionId: string | undefined;
  let disposed = false;

  function stopConnectionCheck(): void {
    clearTimeout(connectionTimer);
    connectionTimer = undefined;
    pendingConnectionId = undefined;
  }

  function checkConnection(): void {
    stopConnectionCheck();
    if (disposed || document.hidden) return;
    const requestId = crypto.randomUUID();
    pendingConnectionId = requestId;
    connectionTimer = setTimeout(() => {
      store.setConnectionError(true);
      connectionTimer = setTimeout(checkConnection, CONNECTION_IDLE_MS);
    }, CONNECTION_TIMEOUT_MS);
    bridge.postMessage({ type: "ready", requestId });
  }

  function acceptConnection(): void {
    stopConnectionCheck();
    store.setConnectionError(false);
    if (!disposed && !document.hidden)
      connectionTimer = setTimeout(checkConnection, CONNECTION_IDLE_MS);
  }

  function onVisibilityChange(): void {
    stopConnectionCheck();
    store.setConnectionError(false);
    if (!document.hidden) checkConnection();
  }

  document.addEventListener("visibilitychange", onVisibilityChange);
  let pendingAddWorkspace = false;
  const closeWorkspaceForm = (): void => {
    formElement.hidden = true;
    pathInput.value = "";
    newWorkspaceButton.hidden = false;
    newWorkspaceButton.setAttribute("aria-expanded", "false");
    pendingAddWorkspace = false;
  };
  bridge.onMessage((message) => {
    if (disposed || !isRecord(message)) return;
    const isListMessage =
      message.type === "loading" ||
      message.type === "sessionsError" ||
      (message.type === "sessions" && isClientState(message.state));
    const isReplay = isListMessage && message.requestId !== undefined;
    if (
      isReplay &&
      (pendingConnectionId === undefined || message.requestId !== pendingConnectionId)
    )
      return;
    if (isListMessage) acceptConnection();
    if (message.type === "loading") {
      const displayedSessionId = message.displayedSessionId;
      store.setLoading(
        message.manual === true,
        typeof displayedSessionId === "string" || displayedSessionId === null
          ? displayedSessionId
          : undefined,
      );
    }
    if (message.type === "sessions" && isClientState(message.state)) {
      const { pendingArchives, pendingUnarchives } = store.getSnapshot();
      // Animate while an archive or unarchive is in flight so the rows
      // below slide instead of jumping. Other updates stay immediate.
      store.setSessions(message.state, pendingArchives.size > 0 || pendingUnarchives.size > 0);
    }
    if (message.type === "newSessionFinished" && typeof message.requestId === "string") {
      store.finishNewSession(message.requestId);
    }
    if (message.type === "archiveFinished" && typeof message.requestId === "string") {
      store.finishArchive(message.requestId);
    }
    if (message.type === "unarchiveFinished" && typeof message.requestId === "string") {
      store.finishUnarchive(message.requestId);
    }
    if (message.type === "workspaceAdded" && pendingAddWorkspace) {
      closeWorkspaceForm();
    }
    if (message.type === "error" && typeof message.message === "string") {
      clearTimeout(operationErrorTimer);
      store.setError(message.message);
      operationErrorTimer = setTimeout(() => {
        operationErrorTimer = undefined;
        store.setError("");
      }, OPERATION_ERROR_DISPLAY_MS);
    }
    if (message.type === "sessionsError") {
      store.setSessionsError();
    }
  });

  const onDocumentClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.closest("[data-action]");
    if (!(action instanceof HTMLButtonElement)) return;
    const actionType = action.dataset.action ?? "";
    if (actionType === "toggleWorkspaceForm") {
      formElement.hidden = false;
      pathInput.value = "";
      newWorkspaceButton.hidden = true;
      newWorkspaceButton.setAttribute("aria-expanded", "true");
      pathInput.focus({ preventScroll: true });
      return;
    }
    bridge.postMessage({ type: actionType });
  };
  document.addEventListener("click", onDocumentClick);
  // Enter in the path input adds the workspace; an empty or IME-composing
  // input is ignored. Escape closes the form without sending anything.
  const onPathInputKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" || event.isComposing) return;
    const path = pathInput.value.trim();
    if (path === "") return;
    pendingAddWorkspace = true;
    bridge.postMessage({ type: "addWorkspace", path });
  };
  pathInput.addEventListener("keydown", onPathInputKeyDown);
  pathInput.addEventListener("blur", closeWorkspaceForm);
  window.addEventListener("blur", closeWorkspaceForm);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && !formElement.hidden) closeWorkspaceForm();
  };
  document.addEventListener("keydown", onKeyDown);

  const root = createRoot(sessionsElement);
  root.render(
    <SessionsApp
      bridge={bridge}
      store={store}
      statusElement={statusElement}
      connectionStatusElement={connectionStatusElement}
    />,
  );

  const disposeScrollbar = initDocumentScrollbar();
  checkConnection();

  return () => {
    disposed = true;
    clearTimeout(operationErrorTimer);
    stopConnectionCheck();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    disposeScrollbar();
    document.removeEventListener("click", onDocumentClick);
    document.removeEventListener("keydown", onKeyDown);
    pathInput.removeEventListener("keydown", onPathInputKeyDown);
    pathInput.removeEventListener("blur", closeWorkspaceForm);
    window.removeEventListener("blur", closeWorkspaceForm);
    root.unmount();
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isClientState(value: unknown): value is ClientState {
  return isRecord(value) && Array.isArray(value.groups);
}

declare const acquireVsCodeApi: undefined | (() => { postMessage(message: unknown): void });

// Auto-init inside a real webview view; the preview passes its own bridge.
if (typeof acquireVsCodeApi === "function") {
  const api = acquireVsCodeApi();
  initClient({
    postMessage: (request) => api.postMessage(request),
    onMessage: (callback) => {
      window.addEventListener("message", (event) => callback(event.data));
    },
  });
}
