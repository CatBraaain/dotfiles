/**
 * Self-contained webview client (no imports). sessionListView is a pure
 * function that builds the view as an element-descriptor tree; initClient
 * wires that view to the page's fixed markup and a message bridge.
 */

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

/** Pure view for a state and per-workspace modes: mode toggles, session rows, empty state. */
export function sessionListView(state: ClientState, modes: ReadonlyMap<string, ViewMode>): SessionListView {
  const groups = state.groups.flatMap((group) => {
    const mode = modes.get(group.cwd) ?? "active";
    const sessions = mode === "active" ? group.sessions.filter((session) => session.isActive) : group.sessions;
    // Active mode hides workspaces without active sessions entirely.
    return mode === "active" && sessions.length === 0 ? [] : [groupDescriptor(group, mode, sessions)];
  });
  return {
    sessions: groups.length === 0 ? [{ tag: "p", attrs: { class: "empty" }, children: ["No active sessions"] }] : groups,
  };
}

function groupDescriptor(group: ClientSessionGroup, mode: ViewMode, sessions: ClientSession[]): ElementDescriptor {
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
      ...sessions.map(sessionDescriptor),
    ],
  };
}

function sessionDescriptor(session: ClientSession): ElementDescriptor {
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
          {
            tag: "span",
            attrs: { class: "session-content" },
            children: [
              { tag: "span", attrs: { class: "session-name" }, children: [session.displayName] },
              {
                tag: "span",
                attrs: { class: "session-meta" },
                children: [`${session.sessionId} · ${new Date(session.mtimeMs).toLocaleString()}`],
              },
            ],
          },
        ],
      },
      ...(session.isActive ? [archiveDescriptor(session.sessionId)] : []),
    ],
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

/**
 * Wire click delegation and state rendering to the page's fixed markup.
 * Mode toggles stay in client state (no host round-trip); session actions go
 * through the bridge. Returns a dispose function that removes the
 * document-level click listener; the webview never disposes, the stories
 * catalog disposes on story change.
 */
export function initClient(bridge: ClientBridge): () => void {
  const sessionsElement = document.querySelector("#sessions");
  const statusElement = document.querySelector("#status");
  if (!(sessionsElement instanceof HTMLElement) || !(statusElement instanceof HTMLElement)) {
    throw new Error("Sessions webview markup is incomplete.");
  }

  let state: ClientState = { groups: [] };
  const modes = new Map<string, ViewMode>();

  const onDocumentClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const modeButton = target.closest("[data-mode]");
    if (modeButton !== null) {
      const cwd = modeButton.getAttribute("data-cwd");
      const mode = modeButton.getAttribute("data-mode");
      if (cwd !== null && (mode === "active" || mode === "all")) {
        modes.set(cwd, mode);
        render();
      }
      return;
    }
    const request = webviewRequestFromClick(event);
    if (request !== undefined) bridge.postMessage(request);
  };
  document.addEventListener("click", onDocumentClick);

  bridge.onMessage((message) => {
    if (!isRecord(message)) return;
    if (message.type === "sessions" && isClientState(message.state)) {
      state = message.state;
      statusElement.textContent = "";
      statusElement.className = "";
      render();
    }
    if (message.type === "error" && typeof message.message === "string") {
      statusElement.textContent = message.message;
      statusElement.className = "error";
    }
  });

  const render = (): void => {
    sessionsElement.replaceChildren(...sessionListView(state, modes).sessions.map(createElement));
  };

  return () => {
    document.removeEventListener("click", onDocumentClick);
  };
}

/** Map a delegated click to the fixed request protocol (undefined off-controls). */
function webviewRequestFromClick(event: Event): Record<string, unknown> | undefined {
  const target = event.target;
  if (!(target instanceof Element)) return undefined;
  const action = target.closest("[data-action]");
  if (action instanceof HTMLButtonElement) return { type: action.dataset.action };
  const archive = target.closest("[data-archive]");
  if (archive instanceof HTMLButtonElement) {
    return { type: "archiveSession", sessionId: archive.dataset.archive };
  }
  const session = target.closest("[data-session]");
  if (session instanceof HTMLButtonElement) return { type: "openSession", sessionId: session.dataset.session };
  return undefined;
}

/** Materialize a descriptor as a real DOM node (setAttribute/textContent only). */
function createElement(descriptor: ElementDescriptor | string): Node {
  if (typeof descriptor === "string") return document.createTextNode(descriptor);
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const element =
    descriptor.tag === "svg" || descriptor.tag === "path"
      ? document.createElementNS(SVG_NAMESPACE, descriptor.tag)
      : document.createElement(descriptor.tag);
  for (const [name, value] of Object.entries(descriptor.attrs ?? {})) {
    element.setAttribute(name, value);
  }
  element.append(...(descriptor.children ?? []).map(createElement));
  return element;
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
