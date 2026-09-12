window.__ModuleLoader__.load({ id: "dotfiles-dsh-zai-concurrency-retry", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
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

// src/client/event.ts
var ZAI_RETRY_WAIT_EVENT_TYPE = "zai-concurrency-retry/wait";

// src/client/conversation.ts
function waitEventData(data) {
  const record = data;
  if (typeof record?.provider !== "string" || record.provider === "")
    return;
  if (typeof record?.attempt !== "number" || !Number.isInteger(record.attempt) || record.attempt < 1)
    return;
  if (typeof record?.waitMs !== "number" || !Number.isFinite(record.waitMs) || record.waitMs <= 0)
    return;
  return { provider: record.provider, attempt: record.attempt, waitMs: record.waitMs };
}
var zaiRetryWaitDefinition = {
  kind: ZAI_RETRY_WAIT_EVENT_TYPE,
  target: "chat",
  match(event) {
    if (event.type !== ZAI_RETRY_WAIT_EVENT_TYPE)
      return null;
    return waitEventData(event.data) === undefined ? null : { id: `wait-${event.seq}`, role: "start" };
  },
  start(_context, match) {
    const data = waitEventData(match.event.data);
    if (data === undefined) {
      throw new Error("zai-concurrency-retry/wait start requires a valid payload");
    }
    return { data, seq: match.event.seq };
  },
  update(context) {
    return context.state;
  },
  buildViewNode(context) {
    const state = context.state;
    if (state === undefined)
      return null;
    const location = context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" };
    return {
      key: context.key,
      kind: ZAI_RETRY_WAIT_EVENT_TYPE,
      id: context.id,
      target: "chat",
      anchorSeq: state.seq,
      location,
      visibility: "visible",
      data: state.data
    };
  }
};
function registerZaiRetryConversation(ctx) {
  ctx.uiConversation.events.register(zaiRetryWaitDefinition);
}

// src/client/apply.ts
function registerZaiRetryChatNode(ctx, component) {
  ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({ name: "conversation.chat.node", key: ZAI_RETRY_WAIT_EVENT_TYPE }, component));
}

// src/client/format.ts
function buildRetryWaitLine(data) {
  return `zai concurrency limit — retrying in ${Math.ceil(data.waitMs / 1000)}s (attempt ${data.attempt})`;
}

// src/client/index.ts
var inject = ["slots", "uiConversation"];
var WAIT_STYLE = {
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: "var(--dsh-content-font-size-secondary, 13px)",
  lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))"
};
function ZaiRetryWaitRow({ node }) {
  return import_react.createElement("div", { style: WAIT_STYLE }, buildRetryWaitLine(node.data));
}
function apply(ctx) {
  registerZaiRetryConversation(ctx);
  registerZaiRetryChatNode(ctx, ZaiRetryWaitRow);
}

return module.exports; } });
