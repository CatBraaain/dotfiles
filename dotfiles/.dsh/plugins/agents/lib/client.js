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

// src/client/apply.ts
function registerAgentClassDisplay(ctx, component) {
  ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({ name: "conversation.composer.dock", id: "agent-class", order: 2 }, component));
}

// src/client/controller.ts
function startStatePoller(intervalMs, deps) {
  let stopped = false;
  const poll = async () => {
    if (stopped)
      return;
    try {
      const state = await deps.fetchState();
      if (!stopped)
        deps.onState(state);
    } catch {}
  };
  poll();
  const handle = deps.setInterval(() => void poll(), intervalMs);
  return () => {
    stopped = true;
    deps.clearInterval(handle);
  };
}

// src/client/format.ts
var UNMANAGED_STATE = { managed: false };
function agentStateLines(state) {
  if (!state.managed || state.agent === undefined)
    return [];
  const lines = [`\uD83E\uDD16 agent: ${state.agent}`];
  if (state.className !== undefined) {
    lines.push(`\uD83D\uDC8E class: ${state.className}${state.manual ? " (manual)" : ""}`);
  }
  return lines;
}
function parseDisplayState(value) {
  if (typeof value !== "object" || value === null)
    return UNMANAGED_STATE;
  const { managed, agent, className, manual } = value;
  if (managed !== true || typeof agent !== "string" || agent === "")
    return UNMANAGED_STATE;
  return {
    managed: true,
    agent,
    ...typeof className === "string" && className !== "" ? { className } : {},
    ...manual === true ? { manual: true } : {}
  };
}

// src/state-rpc.ts
var AGENTS_STATE_PATH = "/api/dsh-agents/state";

// src/client/state.ts
function createStateFetcher(doFetch) {
  return async (sessionId) => {
    try {
      const response = await doFetch(AGENTS_STATE_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId })
      });
      if (!response.ok)
        return { managed: false };
      return parseDisplayState(await response.json());
    } catch {
      return { managed: false };
    }
  };
}

// src/client/index.ts
var inject = ["slots"];
var POLL_INTERVAL_MS = 2000;
var DISPLAY_STYLE = {
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: "var(--dsh-content-font-size-secondary, 13px)",
  lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))"
};
function AgentClassDisplay({ sessionId, fetchState }) {
  const [state, setState] = import_react.useState({ managed: false });
  import_react.useEffect(() => startStatePoller(POLL_INTERVAL_MS, {
    fetchState: () => fetchState(sessionId),
    onState: setState,
    setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
    clearInterval: (handle) => clearInterval(handle)
  }), [sessionId, fetchState]);
  const lines = agentStateLines(state);
  if (lines.length === 0)
    return null;
  return import_react.createElement("div", { style: DISPLAY_STYLE }, ...lines.map((line) => import_react.createElement("div", { key: line }, line)));
}
function apply(ctx) {
  const fetchState = createStateFetcher(globalThis.fetch);
  const component = (props) => import_react.createElement(AgentClassDisplay, { ...props, fetchState });
  registerAgentClassDisplay(ctx, component);
}

return module.exports; } });
