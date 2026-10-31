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

/** Sessions shown in display order (groups in order, rows in order) for the given modes. */
export function visibleSessions(
  state: ClientState,
  modes: ReadonlyMap<string, ViewMode>,
): ClientSession[] {
  return state.groups.flatMap((group) => {
    const mode = modes.get(group.cwd) ?? "unarchived";
    return mode === "unarchived"
      ? group.sessions.filter((session) => !session.isArchived)
      : group.sessions;
  });
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

/** IDs a select-all picks up: visible unarchived unlocked sessions, across cwd groups. */
export function selectAllIds(visible: readonly ClientSession[]): string[] {
  return visible
    .filter((session) => !session.isArchived && !session.isLocked)
    .map((session) => session.sessionId);
}

/** Pure view for a state, per-workspace modes, copied session IDs, and selected rows: mode
 * toggles, session rows, empty state. */
export function sessionListView(
  state: ClientState,
  modes: ReadonlyMap<string, ViewMode>,
  copiedIds: ReadonlySet<string> = new Set(),
  selectedIds: ReadonlySet<string> = new Set(),
): SessionListView {
  const groups = state.groups.map((group) => {
    const mode = modes.get(group.cwd) ?? "unarchived";
    const sessions =
      mode === "unarchived"
        ? group.sessions.filter((session) => !session.isArchived)
        : group.sessions;
    return groupDescriptor(group, mode, sessions, copiedIds, selectedIds);
  });
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
  sessions: ClientSession[],
  copiedIds: ReadonlySet<string>,
  selectedIds: ReadonlySet<string>,
): ElementDescriptor {
  return {
    tag: "section",
    attrs: { class: "group" },
    children: [
      {
        tag: "div",
        attrs: { class: "group-header" },
        children: [
          {
            tag: "div",
            attrs: { class: "group-title", title: group.cwd },
            children: [group.label],
          },
          {
            tag: "div",
            attrs: {
              class: "group-modes",
              role: "group",
              "aria-label": `${group.label} display mode`,
            },
            children: (["unarchived", "all"] as const).map((candidate) => ({
              tag: "button",
              attrs: {
                class: "mode-button",
                type: "button",
                "data-mode": candidate,
                "data-cwd": group.cwd,
                "aria-pressed": String(candidate === mode),
              },
              children: [candidate === "unarchived" ? "Unarchived" : "All"],
            })),
          },
        ],
      },
      { tag: "div", attrs: { class: "group-path", title: group.cwd }, children: [group.cwd] },
      ...(sessions.length === 0
        ? [
            {
              tag: "p",
              attrs: { class: "empty" },
              children: ["No unarchived sessions. Select All to browse saved sessions."],
            },
          ]
        : sessions.map((session) => sessionDescriptor(session, copiedIds, selectedIds))),
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
          { tag: "span", attrs: { class: "session-name" }, children: [session.displayName] },
        ],
      },
      {
        tag: "span",
        attrs: { class: "session-timestamp" },
        children: [new Date(session.mtimeMs).toLocaleString()],
      },
      copyDescriptor(session.sessionId, copiedIds.has(session.sessionId)),
      lockDescriptor(session.sessionId, session.isLocked),
      ...(session.isArchived ? [] : [archiveDescriptor(session.sessionId, session.isLocked)]),
    ],
  };
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

/** Archive glyph (codicon "archive", https://github.com/microsoft/vscode-codicons). */
function archiveIcon(): ElementDescriptor {
  return {
    tag: "svg",
    attrs: {
      width: "16",
      height: "16",
      viewBox: "0 0 16 16",
      fill: "currentColor",
      "aria-hidden": "true",
    },
    children: [
      {
        tag: "path",
        attrs: {
          d: "M6.5 8C6.22386 8 6 8.22386 6 8.5C6 8.77614 6.22386 9 6.5 9H9.5C9.77614 9 10 8.77614 10 8.5C10 8.22386 9.77614 8 9.5 8H6.5ZM1 3.5C1 2.67157 1.67157 2 2.5 2H13.5C14.3284 2 15 2.67157 15 3.5V4.5C15 5.15311 14.5826 5.70873 14 5.91465V11.5C14 12.8807 12.8807 14 11.5 14H4.5C3.11929 14 2 12.8807 2 11.5V5.91465C1.4174 5.70873 1 5.15311 1 4.5V3.5ZM2.5 3C2.22386 3 2 3.22386 2 3.5V4.5C2 4.77614 2.22386 5 2.5 5H13.5C13.7761 5 14 4.77614 14 4.5V3.5C14 3.22386 13.7761 3 13.5 3H2.5ZM3 6V11.5C3 12.3284 3.67157 13 4.5 13H11.5C12.3284 13 13 12.3284 13 11.5V6H3Z",
        },
      },
    ],
  };
}

/** Copy glyph (codicon "copy", https://github.com/microsoft/vscode-codicons). */
function copyIcon(): ElementDescriptor {
  return {
    tag: "svg",
    attrs: {
      width: "16",
      height: "16",
      viewBox: "0 0 16 16",
      fill: "currentColor",
      "aria-hidden": "true",
    },
    children: [
      {
        tag: "path",
        attrs: {
          d: "M3 5V12.73C2.4 12.38 2 11.74 2 11V5C2 2.79 3.79 1 6 1H9C9.74 1 10.38 1.4 10.73 2H6C4.35 2 3 3.35 3 5ZM11 15H6C4.897 15 4 14.103 4 13V5C4 3.897 4.897 3 6 3H11C12.103 3 13 3.897 13 5V13C13 14.103 12.103 15 11 15ZM12 5C12 4.448 11.552 4 11 4H6C5.448 4 5 4.448 5 5V13C5 13.552 5.448 14 6 14H11C11.552 14 12 13.552 12 13V5Z",
        },
      },
    ],
  };
}

/** Check glyph (codicon "check", https://github.com/microsoft/vscode-codicons). */
function checkIcon(): ElementDescriptor {
  return {
    tag: "svg",
    attrs: {
      width: "16",
      height: "16",
      viewBox: "0 0 16 16",
      fill: "currentColor",
      "aria-hidden": "true",
    },
    children: [
      {
        tag: "path",
        attrs: {
          d: "M13.6572 3.13573C13.8583 2.9465 14.175 2.95614 14.3643 3.15722C14.5535 3.35831 14.5438 3.675 14.3428 3.86425L5.84277 11.8642C5.64597 12.0494 5.33756 12.0446 5.14648 11.8535L1.64648 8.35351C1.45121 8.15824 1.45121 7.84174 1.64648 7.64647C1.84174 7.45121 2.15825 7.45121 2.35351 7.64647L5.50976 10.8027L13.6572 3.13573Z",
        },
      },
    ],
  };
}

/** Locked glyph (codicon "lock", https://github.com/microsoft/vscode-codicons). */
function lockIcon(): ElementDescriptor {
  return {
    tag: "svg",
    attrs: {
      width: "16",
      height: "16",
      viewBox: "0 0 16 16",
      fill: "currentColor",
      "aria-hidden": "true",
    },
    children: [
      {
        tag: "path",
        attrs: {
          d: "M8 9C8.55228 9 9 9.44771 9 10C9 10.5523 8.55228 11 8 11C7.44772 11 7 10.5523 7 10C7 9.44771 7.44772 9 8 9Z",
        },
      },
      {
        tag: "path",
        attrs: {
          "fill-rule": "evenodd",
          "clip-rule": "evenodd",
          d: "M8 1C9.654 1 11 2.346 11 4V6H12C13.103 6 14 6.897 14 8V13C14 14.103 13.103 15 12 15H4C2.897 15 2 14.103 2 13V8C2 6.897 2.897 6 4 6H5V4C5 2.346 6.346 1 8 1ZM4 7C3.449 7 3 7.449 3 8V13C3 13.551 3.449 14 4 14H12C12.551 14 13 13.551 13 13V8C13 7.449 12.551 7 12 7H4ZM8 2C6.897 2 6 2.897 6 4V6H10V4C10 2.897 9.103 2 8 2Z",
        },
      },
    ],
  };
}

/** Unlocked glyph (codicon "unlock", https://github.com/microsoft/vscode-codicons). */
function unlockIcon(): ElementDescriptor {
  return {
    tag: "svg",
    attrs: {
      width: "16",
      height: "16",
      viewBox: "0 0 16 16",
      fill: "currentColor",
      "aria-hidden": "true",
    },
    children: [
      {
        tag: "path",
        attrs: {
          d: "M8 9C8.55228 9 9 9.44771 9 10C9 10.5523 8.55228 11 8 11C7.44772 11 7 10.5523 7 10C7 9.44771 7.44772 9 8 9Z",
        },
      },
      {
        tag: "path",
        attrs: {
          "fill-rule": "evenodd",
          "clip-rule": "evenodd",
          d: "M13 1C14.654 1 16 2.346 16 4V4.5C16 4.776 15.776 5 15.5 5C15.224 5 15 4.776 15 4.5V4C15 2.897 14.103 2 13 2C11.897 2 11 2.897 11 4V6H12C13.103 6 14 6.897 14 8V13C14 14.103 13.103 15 12 15H4C2.897 15 2 14.103 2 13V8C2 6.897 2.897 6 4 6H10V4C10 2.346 11.346 1 13 1ZM4 7C3.449 7 3 7.449 3 8V13C3 13.551 3.449 14 4 14H12C12.551 14 13 13.551 13 13V8C13 7.449 12.551 7 12 7H4Z",
        },
      },
    ],
  };
}

/** Click actions the descriptor tree offers; wired by the SessionsApp. */
interface DescriptorActions {
  onModeClick(cwd: string, mode: ViewMode): void;
  onSessionClick(
    sessionId: string,
    event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ): void;
  onCopyClick(sessionId: string): void;
  onLockClick(sessionId: string, nextLocked: boolean): void;
  onArchiveClick(sessionId: string): void;
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
  const mode = attrs["data-mode"];
  if (mode !== undefined) {
    const cwd = attrs["data-cwd"];
    if (cwd !== undefined && (mode === "unarchived" || mode === "all"))
      return () => actions.onModeClick(cwd, mode);
    return undefined;
  }
  const sessionId =
    attrs["data-archive"] ?? attrs["data-lock"] ?? attrs["data-copy"] ?? attrs["data-session"];
  if (sessionId === undefined) return undefined;
  if (attrs["data-archive"] !== undefined) return () => actions.onArchiveClick(sessionId);
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

/** Bridge data as one immutable snapshot for useSyncExternalStore. */
interface ClientSnapshot {
  state: ClientState;
  statusText: string;
  statusError: boolean;
}

/** Latest-value store fed by the bridge; registered synchronously by
 * initClient so no message is lost before React commits. */
function createClientStore(): {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ClientSnapshot;
  setSessions(state: ClientState): void;
  setError(message: string): void;
} {
  let snapshot: ClientSnapshot = { state: { groups: [] }, statusText: "", statusError: false };
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
    setSessions: (state) => publish({ state, statusText: "", statusError: false }),
    setError: (message) => publish({ ...snapshot, statusText: message, statusError: true }),
  };
}

interface SessionsAppProps {
  bridge: ClientBridge;
  store: ReturnType<typeof createClientStore>;
  statusElement: HTMLElement;
  sessionsElement: HTMLElement;
}

/** Render the session list into the #sessions root. Mode toggles and row
 * selection stay in client state (no host round-trip); session actions go
 * through the bridge. */
function SessionsApp({
  bridge,
  store,
  statusElement,
  sessionsElement,
}: SessionsAppProps): ReactElement {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [modes, setModes] = useState(() => new Map<string, ViewMode>());
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [copiedIds, setCopiedIds] = useState(() => new Set<string>());
  const anchorRef = useRef<string | undefined>(undefined);
  const copiedTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const visible = visibleSessions(snapshot.state, modes);

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
      setSelection(new Set(selectAllIds(visibleSessions(snapshot.state, modes))));
    };
    sessionsElement.addEventListener("keydown", onKeyDown);
    return () => sessionsElement.removeEventListener("keydown", onKeyDown);
  }, [snapshot.state, modes, sessionsElement]);

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

  useEffect(() => {
    // The fixed header buttons live outside the React root (#sessions), so
    // their data-action clicks still arrive through document delegation.
    const onDocumentClick = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const action = target.closest("[data-action]");
      if (action instanceof HTMLButtonElement) bridge.postMessage({ type: action.dataset.action });
    };
    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  }, [bridge]);

  useEffect(
    () => () => {
      for (const timer of copiedTimers.current.values()) clearTimeout(timer);
      copiedTimers.current.clear();
    },
    [],
  );

  const actions: DescriptorActions = {
    onModeClick: (cwd, mode) =>
      setModes((previous) => {
        const next = new Map(previous);
        next.set(cwd, mode);
        return next;
      }),
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
  };

  const view = sessionListView(snapshot.state, modes, copiedIds, selection);
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
  if (!(sessionsElement instanceof HTMLElement) || !(statusElement instanceof HTMLElement)) {
    throw new Error("Sessions webview markup is incomplete.");
  }

  const store = createClientStore();
  bridge.onMessage((message) => {
    if (!isRecord(message)) return;
    if (message.type === "sessions" && isClientState(message.state)) {
      store.setSessions(message.state);
    }
    if (message.type === "error" && typeof message.message === "string") {
      store.setError(message.message);
    }
  });

  const root = createRoot(sessionsElement);
  root.render(
    <SessionsApp
      bridge={bridge}
      store={store}
      statusElement={statusElement}
      sessionsElement={sessionsElement}
    />,
  );

  bridge.postMessage({ type: "ready" });

  return () => {
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
