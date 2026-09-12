window.__ModuleLoader__.load({ id: "dotfiles-dsh-skill-status", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
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
var SKILL_STATUS_EVENT_TYPE = "skill-status/used";

// src/client/conversation.ts
var SKILL_STATUS_TARGET = "skill-status";
var EMPTY_SKILL_STATUS_SNAPSHOT = { names: [] };
function usedSkillName(data) {
  const name = data?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}
var skillStatusDefinition = {
  kind: SKILL_STATUS_EVENT_TYPE,
  target: SKILL_STATUS_TARGET,
  match(event) {
    if (event.type !== SKILL_STATUS_EVENT_TYPE)
      return null;
    const name = usedSkillName(event.data);
    return name === undefined ? null : { id: name, role: "start" };
  },
  start(_context, match) {
    return { name: usedSkillName(match.event.data) ?? "", seq: match.event.seq };
  },
  update(context) {
    return context.state;
  },
  buildViewNode(context) {
    const state = context.state;
    return state === undefined ? null : {
      key: context.key,
      kind: skillStatusDefinition.kind,
      id: context.id,
      target: SKILL_STATUS_TARGET,
      data: state
    };
  }
};
function namesFromNodes(nodes) {
  const seqs = new Map;
  for (const node of nodes) {
    const data = node.data;
    if (typeof data?.name !== "string" || typeof data?.seq !== "number")
      continue;
    const previous = seqs.get(data.name);
    if (previous === undefined || data.seq < previous)
      seqs.set(data.name, data.seq);
  }
  const names = [...seqs.entries()];
  names.sort((left, right) => left[1] - right[1]);
  return { names: names.map(([name]) => name) };
}

class SkillStatusBuilder {
  nodes = new Map;
  empty = EMPTY_SKILL_STATUS_SNAPSHOT;
  replace(input) {
    this.nodes.clear();
    for (const node of input.nodes)
      this.nodes.set(node.key, node);
    return namesFromNodes([...this.nodes.values()]);
  }
  apply(input) {
    for (const node of input.upserts)
      this.nodes.set(node.key, node);
    return namesFromNodes([...this.nodes.values()]);
  }
}
var skillStatusViewDefinition = {
  target: SKILL_STATUS_TARGET,
  create: () => new SkillStatusBuilder
};
function registerSkillStatusConversation(ctx) {
  ctx.uiConversation.events.register(skillStatusDefinition);
  ctx.uiConversation.views.register(skillStatusViewDefinition);
}

// src/client/source.ts
var cache = new WeakMap;
function skillStatusSource(ctx, sessionId) {
  const binding = ctx.uiConversation.binding(sessionId);
  let source = cache.get(binding);
  if (source === undefined) {
    const target = binding.target(SKILL_STATUS_TARGET);
    source = {
      getSnapshot: () => target.getSnapshot() ?? EMPTY_SKILL_STATUS_SNAPSHOT,
      subscribe: (listener) => target.subscribe(listener)
    };
    cache.set(binding, source);
  }
  return source;
}

// src/client/apply.ts
function registerSkillStatusDock(ctx, component) {
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    id: "skill-status",
    order: 10,
    inject: (sessionId) => ({ source: skillStatusSource(ctx, sessionId) })
  }, component));
}

// src/client/format.ts
function buildSkillStatusLine(names) {
  if (names.length === 0)
    return;
  return `\uD83C\uDFAF skills: ${names.join(", ")}`;
}

// src/client/index.ts
var inject = ["slots", "uiConversation"];
var STATUS_STYLE = {
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: "var(--dsh-content-font-size-secondary, 13px)",
  lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis"
};
function SkillStatusRow({ source }) {
  const snapshot = import_react.useSyncExternalStore(source.subscribe, source.getSnapshot);
  const line = buildSkillStatusLine(snapshot.names);
  if (line === undefined)
    return null;
  return import_react.createElement("div", { style: STATUS_STYLE }, line);
}
function apply(ctx) {
  registerSkillStatusConversation(ctx);
  registerSkillStatusDock(ctx, SkillStatusRow);
}

return module.exports; } });
