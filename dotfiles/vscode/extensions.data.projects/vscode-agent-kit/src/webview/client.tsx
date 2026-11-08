/**
 * Webview client built on React. sessionListView stays a pure function that
 * builds the view as an element-descriptor tree; the SessionsApp component
 * materializes that tree into React elements and wires it to the page's fixed
 * markup and a message bridge.
 */

import { createElement, useEffect, useState, useSyncExternalStore, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { initDocumentScrollbar } from "./documentScrollbar";

/** Per-workspace display mode: unarchived sessions only, or all sessions. */
export type ViewMode = "unarchived" | "all";

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
  attrs?: Record<string, string>;
  children?: (ElementDescriptor | string)[];
}

/** Dynamic region of the view: per-workspace groups filtered by their mode. */
export interface SessionListView {
  sessions: ElementDescriptor[];
}

/** Message bridge to the extension host (or a preview stub). */
export interface ClientBridge {
  postMessage(request: unknown): void;
  onMessage(callback: (message: unknown) => void): void;
}

/** Sessions shown in display order (groups in order, rows in order) for the
 * shared display mode. */
export function visibleSessions(
  state: ClientState,
  mode: ViewMode,
  collapsedCwds: ReadonlySet<string> = new Set(),
): ClientSession[] {
  return state.groups.flatMap((group) => visibleGroupSessions(group, mode, collapsedCwds));
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

/** Pure view for a state, the shared display mode, and the displayed session. */
export function sessionListView(
  state: ClientState,
  mode: ViewMode,
  displayedSessionId: string | undefined = undefined,
  collapsedCwds: ReadonlySet<string> = new Set(),
): SessionListView {
  const groups = state.groups.map((group) =>
    groupDescriptor(group, mode, displayedSessionId, collapsedCwds),
  );
  return {
    sessions:
      groups.length === 0
        ? [{ tag: "p", attrs: { class: "empty" }, children: ["No saved sessions"] }]
        : groups,
  };
}

function groupDescriptor(
  group: ClientSessionGroup,
  mode: ViewMode,
  displayedSessionId: string | undefined,
  collapsedCwds: ReadonlySet<string>,
): ElementDescriptor {
  const isExpanded = !collapsedCwds.has(group.cwd);
  const sessions = visibleGroupSessions(group, mode, collapsedCwds);
  return {
    tag: "section",
    attrs: { class: "group" },
    children: [
      {
        tag: "div",
        attrs: { class: "group-header", title: group.cwd },
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
          {
            tag: "button",
            attrs: {
              class: "group-unregister",
              type: "button",
              "data-unregister": group.cwd,
              title: "Unregister workspace",
              "aria-label": `Unregister workspace ${group.label}`,
            },
            children: [minusIcon()],
          },
          {
            tag: "button",
            attrs: {
              class: "group-new-session",
              type: "button",
              "data-new-session": group.cwd,
              title: "New session",
              "aria-label": `New session in ${group.label}`,
            },
            children: [plusIcon()],
          },
        ],
      },
      ...sessions.map((session) => sessionDescriptor(session, displayedSessionId)),
    ],
  };
}

function sessionDescriptor(
  session: ClientSession,
  displayedSessionId: string | undefined,
): ElementDescriptor {
  const rowClass = [
    "session-row",
    session.sessionId === displayedSessionId ? "selected" : "",
    session.isArchived ? "archived" : "",
  ]
    .filter((className) => className !== "")
    .join(" ");
  const title = [session.displayName, session.sessionId, phaseLabel(session.state)]
    .filter((line) => line !== undefined)
    .join("\n");
  return {
    tag: "div",
    attrs: { class: rowClass },
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
              ...(session.state === undefined ? {} : { "data-state": session.state }),
              "aria-hidden": "true",
            },
            children: sessionStatusIcons(session),
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
        ? unarchiveDescriptor(session.sessionId)
        : archiveDescriptor(session.sessionId),
    ],
  };
}

function sessionStatusIcons(session: ClientSession): ElementDescriptor[] {
  if (session.isArchived) return [];
  if (session.state === "running") {
    return [strokeIcon([{ tag: "path", attrs: { d: "M21 12a9 9 0 1 1-6.219-8.56" } }])];
  }
  if (session.state === "waiting-approval") {
    return [
      strokeIcon([
        { tag: "path", attrs: { d: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" } },
        { tag: "path", attrs: { d: "M10 21a2 2 0 0 0 4 0" } },
      ]),
    ];
  }
  return [];
}

/** Human-readable phase line for the session row tooltip. */
function phaseLabel(state: SessionPhase | undefined): string | undefined {
  if (state === "running") return "Running";
  if (state === "waiting-approval") return "Waiting for approval";
  if (state === "waiting-user") return "Waiting for user";
  return undefined;
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
function archiveDescriptor(sessionId: string): ElementDescriptor {
  return {
    tag: "button",
    attrs: {
      class: "archive",
      type: "button",
      "data-archive": sessionId,
      title: "Archive",
      "aria-label": "Archive",
    },
    children: [archiveIcon()],
  };
}

/** Overlay button at the row's right edge that restores the archived session to the default list. */
function unarchiveDescriptor(sessionId: string): ElementDescriptor {
  return {
    tag: "button",
    attrs: {
      class: "unarchive",
      type: "button",
      "data-unarchive": sessionId,
      title: "Unarchive",
      "aria-label": "Unarchive",
    },
    children: [unarchiveIcon()],
  };
}

function chevronIcon(direction: "down" | "right"): ElementDescriptor {
  const path = direction === "down" ? "m6 9 6 6 6-6" : "m9 18 6-6-6-6";
  return strokeIcon([{ tag: "path", attrs: { d: path } }]);
}

function minusIcon(): ElementDescriptor {
  return strokeIcon([{ tag: "path", attrs: { d: "M5 12h14" } }]);
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
  onNewSessionClick(cwd: string): void;
  onUnregisterClick(cwd: string): void;
  onSessionClick(sessionId: string): void;
  onArchiveClick(sessionId: string): void;
  onUnarchiveClick(sessionId: string): void;
}

/** Map descriptor attribute names to React prop names (class -> className). */
function descriptorProps(descriptor: ElementDescriptor): Record<string, unknown> {
  const props: Record<string, unknown> = {};
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
  const groupCwd = attrs["data-toggle-group"];
  if (groupCwd !== undefined) return () => actions.onGroupToggle(groupCwd);
  const newSessionCwd = attrs["data-new-session"];
  if (newSessionCwd !== undefined) return () => actions.onNewSessionClick(newSessionCwd);
  const unregisterCwd = attrs["data-unregister"];
  if (unregisterCwd !== undefined) return () => actions.onUnregisterClick(unregisterCwd);
  const sessionId = attrs["data-archive"] ?? attrs["data-unarchive"] ?? attrs["data-session"];
  if (sessionId === undefined) return undefined;
  if (attrs["data-archive"] !== undefined) return () => actions.onArchiveClick(sessionId);
  if (attrs["data-unarchive"] !== undefined) return () => actions.onUnarchiveClick(sessionId);
  return () => actions.onSessionClick(sessionId);
}

/** Materialize a descriptor as a React element (SVG tags included). */
function descriptorToElement(
  descriptor: ElementDescriptor,
  actions: DescriptorActions,
): ReactElement {
  const props: Record<string, unknown> = descriptorProps(descriptor);
  const onClick = descriptorOnClick(descriptor, actions);
  if (onClick !== undefined) props.onClick = onClick;
  return createElement(
    descriptor.tag,
    props,
    ...(descriptor.children ?? []).map((child) =>
      typeof child === "string" ? child : descriptorToElement(child, actions),
    ),
  );
}

/** Bridge data as one immutable snapshot for useSyncExternalStore. The shared
 * display mode lives here so the fixed header toggle (outside the React root)
 * and the rendered list read and write the same value. */
interface ClientSnapshot {
  state: ClientState;
  mode: ViewMode;
  statusText: string;
  statusError: boolean;
}

/** Latest-value store fed by the bridge; registered synchronously by
 * initClient so no message is lost before React commits. */
function createClientStore(): {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ClientSnapshot;
  setSessions(state: ClientState): void;
  setMode(mode: ViewMode): void;
  setError(message: string): void;
} {
  let snapshot: ClientSnapshot = {
    state: { groups: [] },
    mode: "unarchived",
    statusText: "",
    statusError: false,
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
    setSessions: (state) => publish({ ...snapshot, state, statusText: "", statusError: false }),
    setMode: (mode) => publish({ ...snapshot, mode }),
    setError: (message) => publish({ ...snapshot, statusText: message, statusError: true }),
  };
}

interface SessionsAppProps {
  bridge: ClientBridge;
  store: ReturnType<typeof createClientStore>;
  statusElement: HTMLElement;
}

/** Render the session list into the #sessions root. The shared display mode
 * stays in client state (no host round-trip); the row selection display
 * follows the state's displayedSessionId, which the host owns; session
 * actions go through the bridge. */
function SessionsApp({ bridge, store, statusElement }: SessionsAppProps): ReactElement {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [collapsedCwds, setCollapsedCwds] = useState<ReadonlySet<string>>(() => new Set<string>());
  useEffect(() => {
    statusElement.textContent = snapshot.statusText;
    statusElement.className = snapshot.statusError ? "error" : "";
  }, [snapshot, statusElement]);

  const actions: DescriptorActions = {
    onGroupToggle: (cwd) =>
      setCollapsedCwds((previous) => {
        const next = new Set(previous);
        if (next.has(cwd)) next.delete(cwd);
        else next.add(cwd);
        return next;
      }),
    onNewSessionClick: (cwd) => bridge.postMessage({ type: "newSession", cwd }),
    onUnregisterClick: (cwd) => bridge.postMessage({ type: "unregisterWorkspace", cwd }),
    onSessionClick: (sessionId) => bridge.postMessage({ type: "openSession", sessionId }),
    onArchiveClick: (sessionId) => bridge.postMessage({ type: "archiveSession", sessionId }),
    onUnarchiveClick: (sessionId) => bridge.postMessage({ type: "unarchiveSession", sessionId }),
  };

  const view = sessionListView(
    snapshot.state,
    snapshot.mode,
    snapshot.state.displayedSessionId,
    collapsedCwds,
  );
  return <>{view.sessions.map((descriptor) => descriptorToElement(descriptor, actions))}</>;
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
  const formElement = document.querySelector("#workspace-form");
  const pathInput = document.querySelector("#workspace-path");
  const newWorkspaceButton = document.querySelector('[data-action="toggleWorkspaceForm"]');
  const modeToggle = document.querySelector("#app header [data-mode-toggle]");
  if (
    !(sessionsElement instanceof HTMLElement) ||
    !(statusElement instanceof HTMLElement) ||
    !(formElement instanceof HTMLElement) ||
    !(pathInput instanceof HTMLInputElement) ||
    !(newWorkspaceButton instanceof HTMLElement) ||
    !(modeToggle instanceof HTMLButtonElement)
  ) {
    throw new Error("Sessions webview markup is incomplete.");
  }
  /** Toggle label describing what clicking switches to, per current mode. */
  const modeToggleLabel: Record<ViewMode, string> = {
    unarchived: "Show all sessions",
    all: "Show unarchived sessions",
  };

  const store = createClientStore();
  // The host closes the form by replying to an Add with a refreshed list; an
  // invalid path answers with an error instead, so the form stays open.
  let pendingAddWorkspace = false;
  const closeWorkspaceForm = (): void => {
    formElement.hidden = true;
    pathInput.value = "";
    newWorkspaceButton.setAttribute("aria-expanded", "false");
    pendingAddWorkspace = false;
  };
  bridge.onMessage((message) => {
    if (!isRecord(message)) return;
    if (message.type === "sessions" && isClientState(message.state)) {
      store.setSessions(message.state);
      if (pendingAddWorkspace) closeWorkspaceForm();
    }
    if (message.type === "error" && typeof message.message === "string") {
      store.setError(message.message);
    }
  });

  /** Reflect the shared mode on the fixed header toggle (outside the React root). */
  const selectHeaderMode = (mode: ViewMode): void => {
    store.setMode(mode);
    modeToggle.dataset.mode = mode;
    for (const candidate of ["unarchived", "all"] as const) {
      const icon = modeToggle.querySelector(`[data-mode-icon="${candidate}"]`);
      if (icon !== null) icon.toggleAttribute("hidden", candidate !== mode);
    }
    modeToggle.title = modeToggleLabel[mode];
    modeToggle.setAttribute("aria-label", modeToggleLabel[mode]);
  };

  // The header, workspace form, and footer live outside the React root
  // (#sessions), so their data-action and data-mode clicks arrive through
  // document delegation. Mode and form actions stay local; Refresh goes
  // through the bridge.
  const onDocumentClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const modeTarget = target.closest("[data-mode-toggle]");
    if (modeTarget instanceof HTMLButtonElement) {
      selectHeaderMode(modeTarget.dataset.mode === "unarchived" ? "all" : "unarchived");
      return;
    }
    const action = target.closest("[data-action]");
    if (!(action instanceof HTMLButtonElement)) return;
    const actionType = action.dataset.action ?? "";
    if (actionType === "toggleWorkspaceForm") {
      formElement.hidden = !formElement.hidden;
      pathInput.value = "";
      newWorkspaceButton.setAttribute("aria-expanded", String(!formElement.hidden));
      if (!formElement.hidden) pathInput.focus();
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
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && !formElement.hidden) closeWorkspaceForm();
  };
  document.addEventListener("keydown", onKeyDown);

  const root = createRoot(sessionsElement);
  root.render(<SessionsApp bridge={bridge} store={store} statusElement={statusElement} />);

  const disposeScrollbar = initDocumentScrollbar();
  bridge.postMessage({ type: "ready" });

  return () => {
    disposeScrollbar();
    document.removeEventListener("click", onDocumentClick);
    document.removeEventListener("keydown", onKeyDown);
    pathInput.removeEventListener("keydown", onPathInputKeyDown);
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
