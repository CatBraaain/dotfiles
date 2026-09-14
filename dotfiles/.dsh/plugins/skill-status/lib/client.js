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

// src/shared.ts
var SKILL_STATUS_PROJECTION_KEY = "skillStatus";

// src/client/apply.ts
function registerSkillStatusDock(ctx, component) {
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    id: "skill-status",
    order: 10
  }, component));
}

// src/client/format.ts
function buildSkillStatusLine(names) {
  return `\uD83C\uDFAF skills: ${names.join(", ")}`;
}

// src/client/index.ts
var inject = ["slots"];
var STATUS_STYLE = {
  boxSizing: "border-box",
  width: "calc(100% - var(--dsh-composer-side-clearance) * 2 - var(--dsh-composer-dock-inset) * 4)",
  maxWidth: "calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) * 4)",
  margin: "0 auto",
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: "var(--dsh-content-font-size-secondary, 13px)",
  lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis"
};
function SkillStatusRow({ useProjection }) {
  const names = useProjection(SKILL_STATUS_PROJECTION_KEY);
  return import_react.createElement("div", { style: STATUS_STYLE }, buildSkillStatusLine(names ?? []));
}
function apply(ctx) {
  registerSkillStatusDock(ctx, SkillStatusRow);
}

return module.exports; } });
