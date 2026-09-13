window.__ModuleLoader__.load({ id: "dotfiles-dsh-footer", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
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

// src/client/format.ts
function formatSessionLabel(sessionId) {
  return `session: ${sessionId}`;
}

// src/client/apply.ts
function registerSessionIdFooter(ctx, component) {
  ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({ name: "conversation.composer.dock", id: "session-id", order: 1 }, component));
}

// src/client/index.ts
var inject = ["slots"];
var COPIED_RESET_MS = 1000;
function SessionIdFooter({ sessionId }) {
  const [copied, setCopied] = import_react.useState(false);
  const resetTimer = import_react.useRef(null);
  import_react.useEffect(() => () => {
    if (resetTimer.current !== null)
      clearTimeout(resetTimer.current);
  }, []);
  const onCopy = () => {
    if (resetTimer.current !== null)
      return;
    import_dsh_client_ui_primitives.writeClipboard(sessionId).then((ok) => {
      if (!ok || resetTimer.current !== null)
        return;
      setCopied(true);
      resetTimer.current = setTimeout(() => {
        resetTimer.current = null;
        setCopied(false);
      }, COPIED_RESET_MS);
    });
  };
  return import_react.createElement(import_dsh_client_ui_primitives.Button, {
    variant: "ghost",
    size: "sm",
    onClick: onCopy,
    title: copied ? "Copied" : "Copy session ID",
    icon: import_react.createElement(copied ? import_dsh_client_ui_primitives.IconCheckOutline16 : import_dsh_client_ui_primitives.IconCopyOutline16)
  }, formatSessionLabel(sessionId));
}
function apply(ctx) {
  registerSessionIdFooter(ctx, SessionIdFooter);
}

return module.exports; } });
