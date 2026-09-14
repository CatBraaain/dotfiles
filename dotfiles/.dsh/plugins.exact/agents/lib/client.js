window.__ModuleLoader__.load({ id: "dotfiles-dsh-agents", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// src/client/index.ts
var exports_client = {};
__export(exports_client, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(exports_client);
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

// src/client/apply.ts
var TRIGGER_CLASS = "dotfiles-agents-trigger";
var AGENTS_TRIGGER_CSS = `
.${TRIGGER_CLASS} {
  background: none;
}
.${TRIGGER_CLASS}:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
`;
function registerAgentClassDisplay(ctx, component) {
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({ name: "conversation.input.dock", id: "agent-class", order: 2 }, component));
}

// src/client/controller.ts
function createStateReader(fetchState, onState) {
  let latestRequest = 0;
  return {
    invalidate() {
      latestRequest++;
    },
    async refresh() {
      const request = ++latestRequest;
      try {
        const state = await fetchState();
        if (request === latestRequest)
          onState(state);
      } catch {}
    }
  };
}
function startStatePoller(intervalMs, deps) {
  let stopped = false;
  const reader = deps.reader ?? createStateReader(deps.fetchState, (state) => {
    if (!stopped)
      deps.onState(state);
  });
  const poll = async () => {
    if (stopped)
      return;
    await reader.refresh();
  };
  poll();
  const handle = deps.setInterval(() => void poll(), intervalMs);
  return () => {
    stopped = true;
    reader.invalidate();
    deps.clearInterval(handle);
  };
}

// src/client/format.ts
var UNMANAGED_STATE = { managed: false };
function agentLineLabel(state) {
  if (!state.managed || state.agent === undefined)
    return;
  return `\uD83E\uDD16 agent: ${state.agent}`;
}
function classLineLabel(state) {
  if (!state.managed || state.agent === undefined || state.className === undefined) {
    return;
  }
  const mode = state.manual === true ? "manual" : "auto";
  const detail = state.model !== undefined ? `${mode}: ${state.model}` : mode;
  return `\uD83D\uDC8E class: ${state.className} (${detail})`;
}
function stringArray(value) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    return;
  return value;
}
function parseDisplayState(value) {
  if (typeof value !== "object" || value === null)
    return UNMANAGED_STATE;
  const { managed, agent, className, manual, model, agents, classes } = value;
  if (managed !== true || typeof agent !== "string" || agent === "")
    return UNMANAGED_STATE;
  const agentNames = stringArray(agents);
  const classNames = stringArray(classes);
  return {
    managed: true,
    agent,
    ...typeof className === "string" && className !== "" ? { className } : {},
    ...manual === true ? { manual: true } : {},
    ...typeof model === "string" && model !== "" ? { model } : {},
    ...agentNames !== undefined ? { agents: agentNames } : {},
    ...classNames !== undefined ? { classes: classNames } : {}
  };
}

// src/state-rpc.ts
var AGENTS_STATE_PATH = "/api/dsh-agents/state";
var AGENTS_SELECT_PATH = "/api/dsh-agents/select";

// src/client/state.ts
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function parseStatePayload(value) {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("invalid agents state payload");
  }
  const payload = value;
  if (payload.managed === false)
    return { managed: false };
  if (payload.managed !== true || typeof payload.agent !== "string" || payload.agent === "" || typeof payload.className !== "string" || payload.className === "" || typeof payload.manual !== "boolean" || !isStringArray(payload.agents) || !isStringArray(payload.classes) || payload.model !== undefined && (typeof payload.model !== "string" || payload.model === "")) {
    throw new TypeError("invalid agents state payload");
  }
  return parseDisplayState(payload);
}
function createStateFetcher(doFetch) {
  return async (sessionId) => {
    const response = await doFetch(AGENTS_STATE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId })
    });
    if (!response.ok)
      throw new Error(`agents state request failed: ${response.status}`);
    return parseStatePayload(await response.json());
  };
}
function createSelectSender(doFetch) {
  return async (sessionId, kind, name) => {
    try {
      const response = await doFetch(AGENTS_SELECT_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, kind, name })
      });
      if (!response.ok)
        return { ok: false };
      const payload = await response.json().catch(() => {
        return;
      });
      if (typeof payload !== "object" || payload === null)
        return { ok: false };
      return { ok: payload.ok === true };
    } catch {
      return { ok: false };
    }
  };
}

// src/client/index.ts
var inject = ["slots"];
var POLL_INTERVAL_MS = 2000;
var ROW_BAND_STYLE = {
  boxSizing: "border-box",
  width: "calc(100% - var(--dsh-composer-side-clearance) * 2 - var(--dsh-composer-dock-inset) * 4)",
  maxWidth: "calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) * 4)",
  margin: "0 auto",
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: "var(--dsh-content-font-size-secondary, 13px)",
  lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))"
};
var TRIGGER_STYLE = {
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: "var(--dsh-content-font-size-secondary, 13px)",
  lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
  border: "none",
  borderRadius: "6px",
  padding: "0 6px",
  margin: "0 -6px",
  font: "inherit",
  textAlign: "inherit",
  cursor: "pointer"
};
function SelectorMenu({
  label,
  title,
  names,
  selected,
  onPick
}) {
  const [open, setOpen] = import_react.useState(false);
  return import_react.createElement(import_dsh_client_ui_primitives.Menu, {
    open,
    anchor: import_react.createElement("button", {
      type: "button",
      style: TRIGGER_STYLE,
      className: TRIGGER_CLASS,
      title,
      "aria-haspopup": "menu",
      "aria-expanded": open,
      onClick: () => setOpen((current) => !current)
    }, label),
    items: names.map((name) => ({ id: name, label: name })),
    selectedId: selected,
    onSelect: (id) => {
      setOpen(false);
      onPick(id);
    },
    onClose: () => setOpen(false),
    portal: true,
    side: "top",
    align: "start"
  });
}
function AgentClassDisplay({
  sessionId,
  fetchState,
  select,
  initialState
}) {
  const [state, setState] = import_react.useState(initialState ?? { managed: false });
  const stateReader = import_react.useMemo(() => createStateReader(() => fetchState(sessionId), setState), [sessionId, fetchState]);
  import_react.useEffect(() => startStatePoller(POLL_INTERVAL_MS, {
    fetchState: () => fetchState(sessionId),
    onState: setState,
    reader: stateReader,
    setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
    clearInterval: (handle) => clearInterval(handle)
  }), [sessionId, fetchState, stateReader]);
  const agentLabel = agentLineLabel(state);
  if (agentLabel === undefined)
    return null;
  const classLabel = classLineLabel(state);
  const pick = async (kind, name) => {
    const result = await select(sessionId, kind, name);
    if (!result.ok)
      return;
    await stateReader.refresh();
  };
  return import_react.createElement("div", { style: { display: "contents" } }, import_react.createElement("div", { style: ROW_BAND_STYLE }, import_react.createElement(SelectorMenu, {
    label: agentLabel,
    title: "Select agent",
    names: state.agents ?? [],
    selected: state.agent,
    onPick: (name) => void pick("agent", name)
  })), classLabel !== undefined && import_react.createElement("div", { style: ROW_BAND_STYLE }, import_react.createElement(SelectorMenu, {
    label: classLabel,
    title: "Select class",
    names: state.classes ?? [],
    selected: state.className,
    onPick: (name) => void pick("class", name)
  })));
}
function apply(ctx) {
  const style = document.createElement("style");
  style.textContent = AGENTS_TRIGGER_CSS;
  (document.head ?? document.documentElement).appendChild(style);
  ctx.effect(() => () => style.remove(), "agent-class: style");
  const fetchState = createStateFetcher(globalThis.fetch);
  const select = createSelectSender(globalThis.fetch);
  const component = (props) => import_react.createElement(AgentClassDisplay, { ...props, fetchState, select });
  registerAgentClassDisplay(ctx, component);
}

return module.exports; } });
