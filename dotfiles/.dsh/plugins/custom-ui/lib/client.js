window.__ModuleLoader__.load({ id: "dotfiles-dsh-custom-ui", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
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

// src/client/turn-time.ts
function turnRunMs(turn) {
  if (turn.start === undefined || turn.end === undefined)
    return;
  return Math.max(0, turn.end.time - turn.start.time);
}
function formatRunDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

// src/client/chord.ts
var CHORD_TIMEOUT_MS = 1000;
function plainCtrlOnly(event) {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}
function isCtrlK(event) {
  return event.key === "k" && plainCtrlOnly(event);
}
function isCtrlM(event) {
  return event.key === "m" && plainCtrlOnly(event);
}
function onChordKey(state, event, now) {
  if (isCtrlK(event)) {
    return { state: { armedAt: now }, open: false, swallow: true };
  }
  if (state.armedAt === undefined)
    return { state, open: false, swallow: false };
  if (now - state.armedAt > CHORD_TIMEOUT_MS)
    return { state: {}, open: false, swallow: false };
  if (isCtrlM(event))
    return { state: {}, open: true, swallow: true };
  return { state: {}, open: false, swallow: false };
}

// src/client/popup-logic.ts
function rowId(providerId, modelId) {
  return `${providerId}/${modelId}`;
}
function optionsOf(state) {
  const rows = [];
  for (const group of state.groups) {
    for (const model of group.models) {
      rows.push({
        id: rowId(group.id, model.id),
        label: model.name,
        detail: model.description !== undefined ? `${group.name} · ${model.description}` : group.name,
        ...state.current !== null && state.current.provider === group.id && state.current.model === model.id ? { active: true } : {}
      });
    }
  }
  for (const failure of state.failures) {
    rows.push({
      id: `failure/${failure.id}`,
      label: failure.name,
      detail: `Catalog failed to load: ${failure.message}`
    });
  }
  return rows;
}
function selectionOf(state, id) {
  for (const group of state.groups) {
    for (const model of group.models) {
      if (rowId(group.id, model.id) !== id)
        continue;
      const reasoningEffort = state.current?.provider === group.id && state.current.model === model.id ? state.current.reasoningEffort ?? model.reasoning?.defaultEffort : model.reasoning?.defaultEffort;
      return {
        provider: group.id,
        model: model.id,
        ...reasoningEffort === undefined ? {} : { reasoningEffort }
      };
    }
  }
  return;
}
function chordPopupTarget(current, subagentAddress) {
  if (current === undefined)
    return;
  if (subagentAddress(current) !== undefined)
    return;
  return current;
}

// src/client/index.ts
var inject = ["commandUi", "sessions", "modelDirectories", "slots"];
var SHADOW_PRIORITY = -1;
var TURN_TAIL_PRIORITY = 1;
var HIDE_CSS = [
  '[class*="heroWorkspaceRow"]',
  '[class*="pXSMma_headline"]',
  '[class*="uV2eYG_add"]',
  '[class*="Sh0Q9G_trigger"]',
  '[class*="Q51KRG_root"]',
  "[data-composer-stats]",
  '[class*="_8_XoUG_action"]'
].map((selector) => `${selector}{display:none!important}`).join("");
var TURN_TIME_CSS = [
  ".custom-ui-turn-time{display:inline-flex;align-items:center;gap:4px;" + "height:calc(28px + var(--dsh-content-font-delta,0px));" + "color:var(--dsw-alias-label-tertiary);" + "font-size:var(--dsh-content-font-size-secondary,13px);" + "font-variant-numeric:tabular-nums;" + "line-height:calc(24px + var(--dsh-content-font-delta,0px));" + "white-space:nowrap;padding:6px 8px}",
  ".custom-ui-turn-time svg{width:calc(15px + var(--dsh-content-font-delta,0px));" + "height:calc(15px + var(--dsh-content-font-delta,0px));flex:none}"
].join("");
function SeatVoid() {
  return null;
}
function ClockIcon() {
  return import_react.createElement("svg", {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": true
  }, import_react.createElement("circle", { cx: "8", cy: "8", r: "6.2" }), import_react.createElement("path", { d: "M8 4.6V8l2.3 1.3" }));
}
function TurnTimeTail(props) {
  const runMs = turnRunMs(props.turn);
  if (runMs === undefined)
    return null;
  return import_react.createElement("span", { className: "custom-ui-turn-time" }, import_react.createElement(ClockIcon, null), import_react.createElement("span", null, formatRunDuration(runMs)));
}
function apply(ctx) {
  ctx.inject(["slots"], (scope) => {
    scope.slots.inject("conversation.input.model", () => scope.slots.register({ name: "conversation.input.model", priority: SHADOW_PRIORITY }, SeatVoid));
    scope.slots.inject("conversation.input.plan", () => scope.slots.register({ name: "conversation.input.plan", priority: SHADOW_PRIORITY }, SeatVoid));
    scope.slots.inject("conversation.chat.turnTail", () => scope.slots.register({ name: "conversation.chat.turnTail", select: () => true, priority: TURN_TAIL_PRIORITY }, TurnTimeTail));
  });
  const style = document.createElement("style");
  style.textContent = `${HIDE_CSS}${TURN_TIME_CSS}`;
  (document.head ?? document.documentElement).appendChild(style);
  ctx.effect(() => () => style.remove(), "custom-ui: hide style");
  ctx.inject(["commandUi", "sessions", "modelDirectories"], (scope) => {
    const command = scope.commandUi;
    const sessions = scope.sessions;
    const models = scope.modelDirectories;
    const openModelPopup = () => {
      const id = chordPopupTarget(sessions.list.getSnapshot().current, (sessionId) => sessions.subagentAddress(sessionId));
      if (id === undefined)
        return;
      const actx = sessions.scope(id);
      if (actx === undefined)
        return;
      const directory = models.directoryFor(id);
      command.popupFor(actx).open("model", {
        options: async () => optionsOf(await directory.load()),
        onSelect: async (option) => {
          const selection = selectionOf(directory.store.getSnapshot(), option.id);
          if (selection === undefined)
            throw new Error("this provider's catalog failed to load — pick a model from a loaded group");
          await directory.select(selection);
        }
      }, { sessionId: id }, { via: "enter", token: "model" });
    };
    let chord = {};
    const onKeyDown = (event) => {
      const result = onChordKey(chord, event, Date.now());
      chord = result.state;
      if (result.swallow) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (result.open)
        openModelPopup();
    };
    document.addEventListener("keydown", onKeyDown, true);
    ctx.effect(() => () => document.removeEventListener("keydown", onKeyDown, true), "custom-ui: chord keydown");
  });
}

return module.exports; } });
