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

/** Per-workspace display mode: active sessions only, or all sessions. */
export type ViewMode = "active" | "all";

/** Display-only session data (the extension sends WebviewState-shaped values). */
export interface ClientSession {
  sessionId: string;
  displayName: string;
  mtimeMs: number;
  isActive: boolean;
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

/** Pure view for a state, per-workspace modes, and copied session IDs: mode
 * toggles, session rows, empty state. */
export function sessionListView(
  state: ClientState,
  modes: ReadonlyMap<string, ViewMode>,
  copiedIds: ReadonlySet<string> = new Set(),
): SessionListView {
  const groups = state.groups.map((group) => {
    const mode = modes.get(group.cwd) ?? "active";
    const sessions = mode === "active" ? group.sessions.filter((session) => session.isActive) : group.sessions;
    return groupDescriptor(group, mode, sessions, copiedIds);
  });
  return {
    sessions: groups.length === 0 ? [{ tag: "p", attrs: { class: "empty" }, children: ["No saved sessions"] }] : groups,
  };
}

function groupDescriptor(
  group: ClientSessionGroup,
  mode: ViewMode,
  sessions: ClientSession[],
  copiedIds: ReadonlySet<string>,
): ElementDescriptor {
  return {
    tag: "section",
    attrs: { class: "group" },
    children: [
      {
        tag: "div",
        attrs: { class: "group-header" },
        children: [
          { tag: "div", attrs: { class: "group-title", title: group.cwd }, children: [group.label] },
          {
            tag: "div",
            attrs: { class: "group-modes", role: "group", "aria-label": `${group.label} display mode` },
            children: (["active", "all"] as const).map((candidate) => ({
              tag: "button",
              attrs: {
                class: "mode-button",
                type: "button",
                "data-mode": candidate,
                "data-cwd": group.cwd,
                "aria-pressed": String(candidate === mode),
              },
              children: [candidate === "active" ? "Active" : "All"],
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
              children: ["No active sessions. Select All to browse saved sessions."],
            },
          ]
        : sessions.map((session) => sessionDescriptor(session, copiedIds))),
    ],
  };
}

function sessionDescriptor(session: ClientSession, copiedIds: ReadonlySet<string>): ElementDescriptor {
  return {
    tag: "div",
    attrs: { class: "session-row" },
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
            attrs: { class: `indicator${session.isActive ? " active" : ""}`, "aria-hidden": "true" },
          },
          { tag: "span", attrs: { class: "session-name" }, children: [session.displayName] },
        ],
      },
      {
        tag: "span",
        attrs: { class: "session-timestamp" },
        children: [new Date(session.mtimeMs).toLocaleString()],
      },
      copyDescriptor(session.sessionId, copiedIds.has(session.sessionId)),
      ...(session.isActive ? [archiveDescriptor(session.sessionId)] : []),
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

/** Overlay button at the row's right edge that archives (deactivates) the session. */
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

/** Archive glyph (codicon "archive", https://github.com/microsoft/vscode-codicons). */
function archiveIcon(): ElementDescriptor {
  return {
    tag: "svg",
    attrs: { width: "16", height: "16", viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": "true" },
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
    attrs: { width: "16", height: "16", viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": "true" },
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
    attrs: { width: "16", height: "16", viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": "true" },
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

/** Click actions the descriptor tree offers; wired by the SessionsApp. */
interface DescriptorActions {
  onModeClick(cwd: string, mode: ViewMode): void;
  onSessionClick(sessionId: string): void;
  onCopyClick(sessionId: string): void;
  onArchiveClick(sessionId: string): void;
}

/** Map descriptor attribute names to React prop names (class -> className). */
function descriptorProps(descriptor: ElementDescriptor): Record<string, string> {
  const props: Record<string, string> = {};
  for (const [name, value] of Object.entries(descriptor.attrs ?? {})) {
    props[name === "class" ? "className" : name] = value;
  }
  return props;
}

/** Attach the delegated-click behavior of initClient's predecessor to the
 * descriptor's buttons, mirroring the fixed request protocol. */
function descriptorOnClick(descriptor: ElementDescriptor, actions: DescriptorActions): (() => void) | undefined {
  if (descriptor.tag !== "button") return undefined;
  const attrs = descriptor.attrs ?? {};
  const mode = attrs["data-mode"];
  if (mode !== undefined) {
    const cwd = attrs["data-cwd"];
    if (cwd !== undefined && (mode === "active" || mode === "all")) return () => actions.onModeClick(cwd, mode);
    return undefined;
  }
  const sessionId = attrs["data-archive"] ?? attrs["data-copy"] ?? attrs["data-session"];
  if (sessionId === undefined) return undefined;
  if (attrs["data-archive"] !== undefined) return () => actions.onArchiveClick(sessionId);
  if (attrs["data-copy"] !== undefined) return () => actions.onCopyClick(sessionId);
  return () => actions.onSessionClick(sessionId);
}

/** Materialize a descriptor as a React element (SVG tags included). */
function descriptorToElement(descriptor: ElementDescriptor, actions: DescriptorActions): ReactElement {
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
}

/** Render the session list into the #sessions root. Mode toggles stay in
 * client state (no host round-trip); session actions go through the bridge. */
function SessionsApp({ bridge, store, statusElement }: SessionsAppProps): ReactElement {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [modes, setModes] = useState(() => new Map<string, ViewMode>());
  const [copiedIds, setCopiedIds] = useState(() => new Set<string>());
  const copiedTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

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
    onSessionClick: (sessionId) => bridge.postMessage({ type: "openSession", sessionId }),
    onCopyClick: (sessionId) => {
      markCopied(sessionId);
      bridge.postMessage({ type: "copySessionId", sessionId });
    },
    onArchiveClick: (sessionId) => bridge.postMessage({ type: "archiveSession", sessionId }),
  };

  const view = sessionListView(snapshot.state, modes, copiedIds);
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
  root.render(<SessionsApp bridge={bridge} store={store} statusElement={statusElement} />);

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
