/**
 * Webview client built on React. sessionListView stays a pure function that
 * builds the view as an element-descriptor tree; the SessionsApp component
 * materializes that tree into React elements and wires it to the page's fixed
 * markup and a message bridge.
 */

import {
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
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
): SessionListView {
  const groups = state.groups.map((group) =>
    groupDescriptor(group, modes.get(group.cwd) ?? "unarchived", displayedSessionId, collapsedCwds),
  );
  if (groups.length > 0) return { sessions: groups };
  if (loadStatus === "error") return { sessions: [] };
  const emptyText = loadStatus === "loading" ? "Loading sessions…" : "No saved sessions";
  return { sessions: [{ tag: "p", attrs: { class: "empty" }, children: [emptyText] }] };
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
    key: group.cwd,
    attrs: { class: "group" },
    children: [
      {
        tag: "div",
        attrs: { class: "group-header", title: group.cwd, "data-workspace-menu": group.cwd },
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
          modeToggleDescriptor(group.cwd, mode),
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
    session.state === "waiting-user" && session.hasUnread && !session.isArchived
      ? "Unread"
      : undefined,
  ]
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
              "data-unread": String(session.hasUnread === true && !session.isArchived),
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
        { tag: "path", attrs: { d: "M9 4v16" } },
        { tag: "path", attrs: { d: "M15 4v16" } },
      ]),
    ];
  }
  if (session.state === "waiting-user" && session.hasUnread) {
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

/** Materialize a descriptor as a React element (SVG tags included). */
function descriptorToElement(
  descriptor: ElementDescriptor,
  actions: DescriptorActions,
): ReactElement {
  const props: Record<string, unknown> = descriptorProps(descriptor);
  const onClick = descriptorOnClick(descriptor, actions);
  if (onClick !== undefined) props.onClick = onClick;
  const menuCwd = descriptor.attrs?.["data-workspace-menu"];
  if (menuCwd !== undefined) {
    props.onContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      const trigger = event.currentTarget.querySelector<HTMLElement>(".group-title");
      if (trigger !== null) {
        actions.onWorkspaceMenuOpen({ cwd: menuCwd, x: event.clientX, y: event.clientY, trigger });
      }
    };
    props.onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      if (!(event.target instanceof HTMLElement)) return;
      event.preventDefault();
      const trigger = event.target;
      const rect = trigger.getBoundingClientRect();
      actions.onWorkspaceMenuOpen({ cwd: menuCwd, x: rect.left, y: rect.bottom, trigger });
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

interface WorkspaceMenuState {
  cwd: string;
  x: number;
  y: number;
  trigger: HTMLElement;
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
    element.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [menu]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) onClose();
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

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Escape" && event.key !== "Tab") return;
    if (event.key === "Escape") event.preventDefault();
    event.stopPropagation();
    menu.trigger.focus({ preventScroll: true });
    onClose();
  }

  return (
    <div
      ref={menuRef}
      className="workspace-menu"
      role="menu"
      aria-label="Workspace actions"
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
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
  errorMessage: string;
}

/** Latest-value store fed by the bridge; registered synchronously by
 * initClient so no message is lost before React commits. */
function createClientStore(): {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ClientSnapshot;
  setLoading(): void;
  setSessions(state: ClientState): void;
  setError(message: string): void;
  setSessionsError(message: string): void;
} {
  let snapshot: ClientSnapshot = {
    state: { groups: [] },
    loadStatus: "loading",
    errorMessage: "",
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
    setLoading: () =>
      publish({
        ...snapshot,
        loadStatus: "loading",
        errorMessage: "",
      }),
    setSessions: (state) => publish({ state, loadStatus: "loaded", errorMessage: "" }),
    setError: (message) => publish({ ...snapshot, errorMessage: message }),
    setSessionsError: (message) =>
      publish({ ...snapshot, loadStatus: "error", errorMessage: message }),
  };
}

interface SessionsAppProps {
  bridge: ClientBridge;
  store: ReturnType<typeof createClientStore>;
  statusElement: HTMLElement;
}

function SessionsApp({ bridge, store, statusElement }: SessionsAppProps): ReactElement {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [modes, setModes] = useState<ReadonlyMap<string, ViewMode>>(() => new Map());
  const [collapsedCwds, setCollapsedCwds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [workspaceMenu, setWorkspaceMenu] = useState<WorkspaceMenuState | null>(null);
  const hasMenuWorkspace = snapshot.state.groups.some((group) => group.cwd === workspaceMenu?.cwd);
  useEffect(() => {
    if (!hasMenuWorkspace) setWorkspaceMenu(null);
  }, [hasMenuWorkspace]);
  useEffect(() => {
    const loadingText =
      snapshot.loadStatus === "loading" && snapshot.state.groups.length > 0
        ? "Refreshing sessions…"
        : "";
    statusElement.textContent = [loadingText, snapshot.errorMessage]
      .filter((text) => text !== "")
      .join("\n");
    statusElement.className = snapshot.errorMessage === "" ? "" : "error";
  }, [snapshot, statusElement]);

  const actions: DescriptorActions = {
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
    onNewSessionClick: (cwd) => bridge.postMessage({ type: "newSession", cwd }),
    onWorkspaceMenuOpen: setWorkspaceMenu,
    onSessionClick: (sessionId) => bridge.postMessage({ type: "openSession", sessionId }),
    onArchiveClick: (sessionId) => bridge.postMessage({ type: "archiveSession", sessionId }),
    onUnarchiveClick: (sessionId) => bridge.postMessage({ type: "unarchiveSession", sessionId }),
  };

  const view = sessionListView(
    snapshot.state,
    modes,
    snapshot.state.displayedSessionId,
    collapsedCwds,
    snapshot.loadStatus,
  );
  return (
    <>
      {view.sessions.map((descriptor) => descriptorToElement(descriptor, actions))}
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
  const formElement = document.querySelector("#workspace-form");
  const pathInput = document.querySelector("#workspace-path");
  const newWorkspaceButton = document.querySelector('[data-action="toggleWorkspaceForm"]');
  if (
    !(sessionsElement instanceof HTMLElement) ||
    !(statusElement instanceof HTMLElement) ||
    !(formElement instanceof HTMLElement) ||
    !(pathInput instanceof HTMLInputElement) ||
    !(newWorkspaceButton instanceof HTMLElement)
  ) {
    throw new Error("Sessions webview markup is incomplete.");
  }
  const store = createClientStore();
  // The host closes the form by replying to an Add with a refreshed list; an
  // invalid path answers with an error instead, so the form stays open.
  let pendingAddWorkspace = false;
  const closeWorkspaceForm = (): void => {
    formElement.hidden = true;
    pathInput.value = "";
    newWorkspaceButton.hidden = false;
    newWorkspaceButton.setAttribute("aria-expanded", "false");
    pendingAddWorkspace = false;
  };
  bridge.onMessage((message) => {
    if (!isRecord(message)) return;
    if (message.type === "loading") store.setLoading();
    if (message.type === "sessions" && isClientState(message.state)) {
      store.setSessions(message.state);
      if (pendingAddWorkspace) closeWorkspaceForm();
    }
    if (message.type === "error" && typeof message.message === "string") {
      store.setError(message.message);
    }
    if (message.type === "sessionsError" && typeof message.message === "string") {
      store.setSessionsError(message.message);
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
