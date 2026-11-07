/**
 * Webview client built on React. sessionListView stays a pure function that
 * builds the view as an element-descriptor tree; the SessionsApp component
 * materializes that tree into React elements and wires it to the page's fixed
 * markup and a message bridge.
 */

import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { createRoot } from "react-dom/client";

/** Per-workspace display mode: unarchived sessions only, or all sessions. */
export type ViewMode = "unarchived" | "all";

/** Display-only session data (the extension sends WebviewState-shaped values). */
export interface ClientSession {
  sessionId: string;
  displayName: string;
  mtimeMs: number;
  isArchived: boolean;
  isLocked: boolean;
}

export interface ClientSessionGroup {
  cwd: string;
  label: string;
  /** True when the cwd comes from a registered workspace (New Workspace). */
  registered: boolean;
  sessions: ClientSession[];
}

/** State sent by the extension host: every session of every workspace group. */
export interface ClientState {
  groups: ClientSessionGroup[];
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

/** Modifier keys of a session-row click, as far as selection is concerned. */
export interface SelectionClick {
  sessionId: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Result of applying a selection click: the next selection, its anchor row, and whether the row also opens. */
export interface SelectionUpdate {
  selection: ReadonlySet<string>;
  anchor: string | undefined;
  opensSession: boolean;
}

/**
 * Native-style row selection:
 * - plain click: single selection and open the session;
 * - Ctrl/Cmd click: toggle one row without opening;
 * - Shift click: replace the selection with the anchor-to-clicked range in
 *   display order (across cwd groups) without opening.
 */
export function nextSelectionFromClick(
  click: SelectionClick,
  selection: ReadonlySet<string>,
  visibleIds: readonly string[],
  anchor: string | undefined,
): SelectionUpdate {
  if (click.shiftKey) {
    const anchorId = anchor ?? click.sessionId;
    const anchorIndex = visibleIds.indexOf(anchorId);
    const clickedIndex = visibleIds.indexOf(click.sessionId);
    if (anchorIndex === -1 || clickedIndex === -1) {
      return {
        selection: new Set([click.sessionId]),
        anchor: click.sessionId,
        opensSession: false,
      };
    }
    const [first, last] =
      anchorIndex <= clickedIndex ? [anchorIndex, clickedIndex] : [clickedIndex, anchorIndex];
    return {
      selection: new Set(visibleIds.slice(first, last + 1)),
      anchor: anchorId,
      opensSession: false,
    };
  }
  if (click.ctrlKey || click.metaKey) {
    const next = new Set(selection);
    if (next.has(click.sessionId)) {
      next.delete(click.sessionId);
    } else {
      next.add(click.sessionId);
    }
    return { selection: next, anchor: click.sessionId, opensSession: false };
  }
  return { selection: new Set([click.sessionId]), anchor: click.sessionId, opensSession: true };
}

/** IDs to archive when the Archive action runs on one row: the visible selected unarchived unlocked sessions when the row is selected, otherwise just that row. */
export function archiveTargetIds(
  clickedSessionId: string,
  selection: ReadonlySet<string>,
  visible: readonly ClientSession[],
): string[] {
  if (!selection.has(clickedSessionId)) return [clickedSessionId];
  return visible
    .filter(
      (session) => !session.isArchived && !session.isLocked && selection.has(session.sessionId),
    )
    .map((session) => session.sessionId);
}

/** IDs to unarchive when the Unarchive action runs on one row: the visible selected archived sessions when the row is selected, otherwise just that row. */
export function unarchiveTargetIds(
  clickedSessionId: string,
  selection: ReadonlySet<string>,
  visible: readonly ClientSession[],
): string[] {
  if (!selection.has(clickedSessionId)) return [clickedSessionId];
  return visible
    .filter((session) => session.isArchived && selection.has(session.sessionId))
    .map((session) => session.sessionId);
}

/** IDs a select-all picks up: visible unarchived unlocked sessions, across cwd groups. */
export function selectAllIds(visible: readonly ClientSession[]): string[] {
  return visible
    .filter((session) => !session.isArchived && !session.isLocked)
    .map((session) => session.sessionId);
}

/** Pure view for a state, the shared display mode, copied session IDs, and
 * selected rows: session rows, empty state. */
export function sessionListView(
  state: ClientState,
  mode: ViewMode,
  copiedIds: ReadonlySet<string> = new Set(),
  selectedIds: ReadonlySet<string> = new Set(),
  collapsedCwds: ReadonlySet<string> = new Set(),
): SessionListView {
  const groups = state.groups.map((group) =>
    groupDescriptor(group, mode, copiedIds, selectedIds, collapsedCwds),
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
  copiedIds: ReadonlySet<string>,
  selectedIds: ReadonlySet<string>,
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
          ...(group.registered
            ? [
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
                } satisfies ElementDescriptor,
              ]
            : []),
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
      ...sessions.map((session) => sessionDescriptor(session, copiedIds, selectedIds)),
    ],
  };
}

function sessionDescriptor(
  session: ClientSession,
  copiedIds: ReadonlySet<string>,
  selectedIds: ReadonlySet<string>,
): ElementDescriptor {
  const rowClass = [
    "session-row",
    selectedIds.has(session.sessionId) ? "selected" : "",
    session.isArchived ? "archived" : "",
  ]
    .filter((className) => className !== "")
    .join(" ");
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
          title: `${session.displayName}\n${session.sessionId}`,
        },
        children: [
          {
            tag: "span",
            attrs: {
              class: "session-status",
              "data-archived": String(session.isArchived),
              "data-locked": String(session.isLocked),
              "aria-hidden": "true",
            },
          },
          { tag: "span", attrs: { class: "session-name" }, children: [session.displayName] },
        ],
      },
      {
        tag: "span",
        attrs: { class: "session-timestamp" },
        children: [formatSessionTimestamp(session.mtimeMs)],
      },
      copyDescriptor(session.sessionId, copiedIds.has(session.sessionId)),
      lockDescriptor(session.sessionId, session.isLocked),
      ...(session.isArchived
        ? [unarchiveDescriptor(session.sessionId)]
        : [archiveDescriptor(session.sessionId, session.isLocked)]),
    ],
  };
}

export function formatSessionTimestamp(mtimeMs: number, now = new Date()): string {
  const updatedAt = new Date(mtimeMs);
  const isToday =
    updatedAt.getFullYear() === now.getFullYear() &&
    updatedAt.getMonth() === now.getMonth() &&
    updatedAt.getDate() === now.getDate();
  const parts = isToday
    ? [updatedAt.getHours(), updatedAt.getMinutes()]
    : [updatedAt.getMonth() + 1, updatedAt.getDate()];
  return parts.map((part) => String(part).padStart(2, "0")).join(isToday ? ":" : "/");
}

/** Overlay button at the row's right edge that copies the session ID to the clipboard. */
function copyDescriptor(sessionId: string, copied: boolean): ElementDescriptor {
  return {
    tag: "button",
    attrs: {
      class: copied ? "copy copied" : "copy",
      type: "button",
      "data-copy": sessionId,
      title: copied ? "Copied" : "Copy session ID",
      "aria-label": copied ? "Copied" : "Copy session ID",
    },
    children: [copied ? checkIcon() : copyIcon()],
  };
}

/** Overlay button at the row's right edge that toggles the archive-protection lock. */
function lockDescriptor(sessionId: string, locked: boolean): ElementDescriptor {
  return {
    tag: "button",
    attrs: {
      class: "lock",
      type: "button",
      "data-lock": sessionId,
      "aria-pressed": String(locked),
      title: locked ? "Unlock" : "Lock",
      "aria-label": locked ? "Unlock" : "Lock",
    },
    children: [locked ? lockIcon() : unlockIcon()],
  };
}

/** Overlay button at the row's right edge that archives the session (disabled while locked). */
function archiveDescriptor(sessionId: string, disabled: boolean): ElementDescriptor {
  return {
    tag: "button",
    attrs: {
      class: "archive",
      type: "button",
      "data-archive": sessionId,
      title: disabled ? "Archive (locked)" : "Archive",
      "aria-label": disabled ? "Archive (locked)" : "Archive",
      ...(disabled ? { disabled: "disabled" } : {}),
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

function copyIcon(): ElementDescriptor {
  return strokeIcon([
    { tag: "rect", attrs: { width: "14", height: "14", x: "8", y: "8", rx: "2" } },
    { tag: "path", attrs: { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" } },
  ]);
}

function checkIcon(): ElementDescriptor {
  return strokeIcon([{ tag: "path", attrs: { d: "M20 6 9 17l-5-5" } }]);
}

function lockIcon(): ElementDescriptor {
  return strokeIcon([
    { tag: "rect", attrs: { width: "18", height: "11", x: "3", y: "11", rx: "2" } },
    { tag: "path", attrs: { d: "M7 11V7a5 5 0 0 1 10 0v4" } },
  ]);
}

function unlockIcon(): ElementDescriptor {
  return strokeIcon([
    { tag: "rect", attrs: { width: "18", height: "11", x: "3", y: "11", rx: "2" } },
    { tag: "path", attrs: { d: "M7 11V7a5 5 0 0 1 9.9-1" } },
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
  onSessionClick(
    sessionId: string,
    event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ): void;
  onCopyClick(sessionId: string): void;
  onLockClick(sessionId: string, nextLocked: boolean): void;
  onArchiveClick(sessionId: string): void;
  onUnarchiveClick(sessionId: string): void;
}

/** Map descriptor attribute names to React prop names (class -> className, disabled string -> true). */
function descriptorProps(descriptor: ElementDescriptor): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(descriptor.attrs ?? {})) {
    if (name === "class") {
      props.className = value;
    } else if (name === "disabled") {
      props.disabled = true;
    } else {
      props[name] = value;
    }
  }
  return props;
}

/** Modifier keys a row click carries, as far as selection is concerned. */
interface ClickModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Attach the delegated-click behavior of initClient's predecessor to the
 * descriptor's buttons, mirroring the fixed request protocol. */
function descriptorOnClick(
  descriptor: ElementDescriptor,
  actions: DescriptorActions,
): ((event: ClickModifiers) => void) | undefined {
  if (descriptor.tag !== "button") return undefined;
  const attrs = descriptor.attrs ?? {};
  const groupCwd = attrs["data-toggle-group"];
  if (groupCwd !== undefined) return () => actions.onGroupToggle(groupCwd);
  const newSessionCwd = attrs["data-new-session"];
  if (newSessionCwd !== undefined) return () => actions.onNewSessionClick(newSessionCwd);
  const unregisterCwd = attrs["data-unregister"];
  if (unregisterCwd !== undefined) return () => actions.onUnregisterClick(unregisterCwd);
  const sessionId =
    attrs["data-archive"] ??
    attrs["data-unarchive"] ??
    attrs["data-lock"] ??
    attrs["data-copy"] ??
    attrs["data-session"];
  if (sessionId === undefined) return undefined;
  if (attrs["data-archive"] !== undefined) return () => actions.onArchiveClick(sessionId);
  if (attrs["data-unarchive"] !== undefined) return () => actions.onUnarchiveClick(sessionId);
  if (attrs["data-lock"] !== undefined) {
    const locked = attrs["aria-pressed"] === "true";
    return () => actions.onLockClick(sessionId, !locked);
  }
  if (attrs["data-copy"] !== undefined) return () => actions.onCopyClick(sessionId);
  return (event) => actions.onSessionClick(sessionId, event);
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
  sessionsElement: HTMLElement;
  openUnregisterDialog: (cwd: string) => void;
}

/** Render the session list into the #sessions root. The shared display mode
 * and row selection stay in client state (no host round-trip); session actions
 * go through the bridge. */
function SessionsApp({
  bridge,
  store,
  statusElement,
  sessionsElement,
  openUnregisterDialog,
}: SessionsAppProps): ReactElement {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [collapsedCwds, setCollapsedCwds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [copiedIds, setCopiedIds] = useState(() => new Set<string>());
  const anchorRef = useRef<string | undefined>(undefined);
  const copiedTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const visible = visibleSessions(snapshot.state, snapshot.mode, collapsedCwds);

  /** Keep selection and its anchor pointing at sessions that still exist. */
  useEffect(() => {
    const knownIds = new Set(
      snapshot.state.groups.flatMap((group) => group.sessions.map((session) => session.sessionId)),
    );
    setSelection((previous) => {
      const next = new Set([...previous].filter((sessionId) => knownIds.has(sessionId)));
      return next.size === previous.size ? previous : next;
    });
    if (anchorRef.current !== undefined && !knownIds.has(anchorRef.current)) {
      anchorRef.current = undefined;
    }
  }, [snapshot.state]);

  /** Select-all while the list itself has focus; never touch inputs elsewhere. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.key.toLowerCase() !== "a") return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      setSelection(
        new Set(selectAllIds(visibleSessions(snapshot.state, snapshot.mode, collapsedCwds))),
      );
    };
    sessionsElement.addEventListener("keydown", onKeyDown);
    return () => sessionsElement.removeEventListener("keydown", onKeyDown);
  }, [snapshot, collapsedCwds, sessionsElement]);

  /** Show the copied feedback on the row's copy button for about a second. */
  const markCopied = useCallback((sessionId: string): void => {
    setCopiedIds((previous) => {
      const next = new Set(previous);
      next.add(sessionId);
      return next;
    });
    clearTimeout(copiedTimers.current.get(sessionId));
    copiedTimers.current.set(
      sessionId,
      setTimeout(() => {
        copiedTimers.current.delete(sessionId);
        setCopiedIds((previous) => {
          const next = new Set(previous);
          next.delete(sessionId);
          return next;
        });
      }, 1000),
    );
  }, []);

  useEffect(() => {
    statusElement.textContent = snapshot.statusText;
    statusElement.className = snapshot.statusError ? "error" : "";
  }, [snapshot, statusElement]);

  useEffect(
    () => () => {
      for (const timer of copiedTimers.current.values()) clearTimeout(timer);
      copiedTimers.current.clear();
    },
    [],
  );

  const actions: DescriptorActions = {
    onGroupToggle: (cwd) =>
      setCollapsedCwds((previous) => {
        const next = new Set(previous);
        if (next.has(cwd)) next.delete(cwd);
        else next.add(cwd);
        return next;
      }),
    onNewSessionClick: (cwd) => bridge.postMessage({ type: "newSession", cwd }),
    onUnregisterClick: (cwd) => openUnregisterDialog(cwd),
    onSessionClick: (sessionId, event) => {
      const update = nextSelectionFromClick(
        { sessionId, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey },
        selection,
        visible.map((session) => session.sessionId),
        anchorRef.current,
      );
      setSelection(update.selection);
      anchorRef.current = update.anchor;
      if (update.opensSession) bridge.postMessage({ type: "openSession", sessionId });
    },
    onCopyClick: (sessionId) => {
      markCopied(sessionId);
      bridge.postMessage({ type: "copySessionId", sessionId });
    },
    onLockClick: (sessionId, nextLocked) =>
      bridge.postMessage({ type: "setSessionLock", sessionId, locked: nextLocked }),
    onArchiveClick: (sessionId) => {
      const sessionIds = archiveTargetIds(sessionId, selection, visible);
      if (sessionIds.length === 0) return;
      bridge.postMessage({ type: "archiveSessions", sessionIds });
    },
    onUnarchiveClick: (sessionId) => {
      const sessionIds = unarchiveTargetIds(sessionId, selection, visible);
      if (sessionIds.length === 0) return;
      bridge.postMessage({ type: "unarchiveSessions", sessionIds });
    },
  };

  const view = sessionListView(snapshot.state, snapshot.mode, copiedIds, selection, collapsedCwds);
  return <>{view.sessions.map((descriptor) => descriptorToElement(descriptor, actions))}</>;
}

/**
 * Mount the React root onto the page's fixed markup. The bridge subscription
 * is registered synchronously, so messages sent right after initClient (the
 * stories catalog resets its demo state this way) are never lost. Returns a
 * dispose function that unmounts the root and clears its timers and listener;
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
  const dialogElement = document.querySelector("#unregister-dialog");
  const dialogCwd = document.querySelector("#unregister-dialog-cwd");
  const cancelUnregisterButton = document.querySelector('[data-action="cancelUnregister"]');
  if (
    !(dialogElement instanceof HTMLElement) ||
    !(dialogCwd instanceof HTMLElement) ||
    !(cancelUnregisterButton instanceof HTMLButtonElement)
  ) {
    throw new Error("Sessions webview markup is incomplete.");
  }
  /** Unregister asks for confirmation in the webview before contacting the host. */
  let pendingUnregisterCwd: string | undefined = undefined;
  const closeUnregisterDialog = (): void => {
    pendingUnregisterCwd = undefined;
    dialogElement.hidden = true;
  };
  const openUnregisterDialog = (cwd: string): void => {
    pendingUnregisterCwd = cwd;
    dialogCwd.textContent = cwd;
    dialogElement.hidden = false;
    cancelUnregisterButton.focus();
  };
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
    if (actionType === "cancelWorkspaceForm") {
      closeWorkspaceForm();
      return;
    }
    if (actionType === "cancelUnregister") {
      closeUnregisterDialog();
      return;
    }
    if (actionType === "confirmUnregister") {
      const cwd = pendingUnregisterCwd;
      closeUnregisterDialog();
      if (cwd !== undefined) bridge.postMessage({ type: "unregisterWorkspace", cwd });
      return;
    }
    if (actionType === "addWorkspace") {
      const path = pathInput.value.trim();
      if (path === "") return;
      pendingAddWorkspace = true;
      bridge.postMessage({ type: "addWorkspace", path });
      return;
    }
    bridge.postMessage({ type: actionType });
  };
  document.addEventListener("click", onDocumentClick);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && !dialogElement.hidden) closeUnregisterDialog();
  };
  document.addEventListener("keydown", onKeyDown);

  const root = createRoot(sessionsElement);
  root.render(
    <SessionsApp
      bridge={bridge}
      store={store}
      statusElement={statusElement}
      sessionsElement={sessionsElement}
      openUnregisterDialog={openUnregisterDialog}
    />,
  );

  bridge.postMessage({ type: "ready" });

  return () => {
    document.removeEventListener("click", onDocumentClick);
    document.removeEventListener("keydown", onKeyDown);
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
