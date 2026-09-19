/**
 * Self-contained webview client (no imports; also loaded unchanged by the
 * static preview via preview/lib). sessionListView is a pure function that
 * builds the view as an element-descriptor tree; initClient wires that view
 * to the page's fixed markup and a message bridge.
 */

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

export interface ClientState {
  mode: "active" | "all";
  groups: ClientSessionGroup[];
}

/** Element descriptor: tag plus optional attributes and children (text allowed). */
export interface ElementDescriptor {
  tag: string;
  attrs?: Record<string, string>;
  children?: (ElementDescriptor | string)[];
}

/** Dynamic regions of the view: mode switch buttons and the session list body. */
export interface SessionListView {
  modeButtons: ElementDescriptor[];
  sessions: ElementDescriptor[];
}

/** Message bridge to the extension host (or a preview stub). */
export interface ClientBridge {
  postMessage(request: unknown): void;
  onMessage(callback: (message: unknown) => void): void;
}

/** Pure view for a state: mode switch buttons, cwd groups, session rows, empty state. */
export function sessionListView(state: ClientState): SessionListView {
  return {
    modeButtons: (["active", "all"] as const).map((mode) => ({
      tag: "button",
      attrs: {
        class: "mode-button",
        type: "button",
        "data-mode": mode,
        "aria-pressed": String(mode === state.mode),
      },
      children: [mode === "active" ? "Active" : "All"],
    })),
    sessions: state.groups.length === 0 ? [emptyDescriptor(state.mode)] : state.groups.map(groupDescriptor),
  };
}

function emptyDescriptor(mode: ClientState["mode"]): ElementDescriptor {
  return {
    tag: "p",
    attrs: { class: "empty" },
    children: [mode === "active" ? "No active sessions" : "No sessions"],
  };
}

function groupDescriptor(group: ClientSessionGroup): ElementDescriptor {
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
            attrs: { class: "session-content" },
            children: [
              { tag: "div", attrs: { class: "group-title" }, children: [group.label] },
              { tag: "div", attrs: { class: "group-path", title: group.cwd }, children: [group.cwd] },
            ],
          },
        ],
      },
      ...group.sessions.map(sessionDescriptor),
    ],
  };
}

function sessionDescriptor(session: ClientSession): ElementDescriptor {
  const row: ElementDescriptor = {
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
    ],
  };
  if (session.isActive) {
    row.children?.push({
      tag: "button",
      attrs: {
        class: "deactivate",
        type: "button",
        "data-deactivate": session.sessionId,
        "aria-label": `Deactivate ${session.displayName}`,
      },
      children: ["Deactivate"],
    });
  }
  return row;
}

/** Wire click delegation and state rendering to the page's fixed markup. */
export function initClient(bridge: ClientBridge): void {
  const sessionsElement = document.querySelector("#sessions");
  const statusElement = document.querySelector("#status");
  if (!(sessionsElement instanceof HTMLElement) || !(statusElement instanceof HTMLElement)) {
    throw new Error("Sessions webview markup is incomplete.");
  }

  let state: ClientState = { mode: "active", groups: [] };

  document.addEventListener("click", (event) => {
    const request = webviewRequestFromClick(event);
    if (request !== undefined) bridge.postMessage(request);
  });

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

  /**
   * Apply the current state's view. The static mode buttons keep their DOM so
   * keyboard focus is preserved; only their aria-pressed attribute is updated
   * from the descriptors (single source: sessionListView).
   */
  const render = (): void => {
    const view = sessionListView(state);
    for (const button of view.modeButtons) {
      const mode = button.attrs?.["data-mode"];
      const pressed = button.attrs?.["aria-pressed"];
      const existing = mode === undefined ? null : document.querySelector(`[data-mode="${mode}"]`);
      if (existing !== null && pressed !== undefined) existing.setAttribute("aria-pressed", pressed);
    }
    sessionsElement.replaceChildren(...view.sessions.map(createElement));
  };
}

/** Map a delegated click to the fixed request protocol (undefined off-controls). */
function webviewRequestFromClick(event: Event): Record<string, unknown> | undefined {
  const target = event.target;
  if (!(target instanceof Element)) return undefined;
  const action = target.closest("[data-action]");
  if (action instanceof HTMLButtonElement) return { type: action.dataset.action };
  const mode = target.closest("[data-mode]");
  if (mode instanceof HTMLButtonElement) return { type: "setMode", mode: mode.dataset.mode };
  const deactivate = target.closest("[data-deactivate]");
  if (deactivate instanceof HTMLButtonElement) {
    return { type: "deactivateSession", sessionId: deactivate.dataset.deactivate };
  }
  const session = target.closest("[data-session]");
  if (session instanceof HTMLButtonElement) return { type: "openSession", sessionId: session.dataset.session };
  return undefined;
}

/** Materialize a descriptor as a real DOM node (setAttribute/textContent only). */
function createElement(descriptor: ElementDescriptor | string): Node {
  if (typeof descriptor === "string") return document.createTextNode(descriptor);
  const element = document.createElement(descriptor.tag);
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
  return (
    isRecord(value) &&
    (value.mode === "active" || value.mode === "all") &&
    Array.isArray(value.groups)
  );
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
