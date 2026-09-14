window.__ModuleLoader__.load({ id: "dotfiles-dsh-quota-line", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
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

// src/client/active.ts
var QUOTA_BY_ROUTE_PROVIDER = {
  zai: "zai",
  "zai-coding-cn": "zai",
  "openai-codex": "codex"
};
function quotaIdForRouteProvider(routeProvider) {
  if (routeProvider === undefined || routeProvider === "")
    return;
  return QUOTA_BY_ROUTE_PROVIDER[routeProvider];
}
function resolveActiveRouteProvider(services) {
  let current;
  try {
    current = services.sessions?.list?.getSnapshot?.()?.current;
  } catch {
    return;
  }
  if (typeof current !== "string" || current === "")
    return;
  try {
    const provider = services.modelDirectories?.directoryFor?.(current)?.store?.getSnapshot?.()?.current?.provider;
    return typeof provider === "string" && provider !== "" ? provider : undefined;
  } catch {
    return;
  }
}
function subscribeActiveChange(services, onChange) {
  const sessions = services.sessions;
  if (typeof sessions?.list?.subscribe !== "function")
    return () => {};
  let directoryUnsub = null;
  const followDirectory = () => {
    directoryUnsub?.();
    directoryUnsub = null;
    const current = sessions?.list?.getSnapshot?.()?.current;
    if (typeof current === "string" && current !== "") {
      try {
        const store = services.modelDirectories?.directoryFor?.(current)?.store;
        if (typeof store?.subscribe === "function")
          directoryUnsub = store.subscribe(onChange);
      } catch {}
    }
  };
  const offList = sessions.list.subscribe(() => {
    followDirectory();
    onChange();
  });
  followDirectory();
  return () => {
    offList?.();
    directoryUnsub?.();
  };
}

// src/client/format.ts
function formatProviderLine(provider) {
  const segments = [provider.id];
  if (provider.rolling !== undefined)
    segments.push(`${Math.round(provider.rolling.percent)}% 5h`);
  if (provider.weekly !== undefined)
    segments.push(`${Math.round(provider.weekly.percent)}% wk`);
  return segments.join(" ");
}
function lineForProvider(payload, quotaId) {
  if (quotaId === undefined)
    return null;
  const root = payload;
  if (root === null || typeof root !== "object" || root.ok !== true || !Array.isArray(root.providers)) {
    return null;
  }
  for (const raw of root.providers) {
    const provider = raw;
    if (provider === null || typeof provider !== "object" || provider.id !== quotaId)
      continue;
    const line = formatProviderLine(provider);
    if (line !== "")
      return line;
  }
  return null;
}

// src/client/apply.ts
function registerQuotaLine(ctx, component) {
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({ name: "conversation.input.dock", id: "quota-line", order: 1 }, component));
}

// src/client/index.ts
var inject = ["slots", "sessions", "modelDirectories"];
var POLL_INTERVAL_MS = 60000;
var QUOTA_ROUTE = "/plugins/quota-line/quota.json";
var ROOT_STYLE = {
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: "var(--dsh-content-font-size-secondary, 13px)",
  lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))"
};
function apply(ctx) {
  const services = ctx;
  const getActiveQuotaId = () => quotaIdForRouteProvider(resolveActiveRouteProvider(services));
  function QuotaLine() {
    const [payload, setPayload] = import_react.useState(null);
    const [, bumpActive] = import_react.useState(0);
    import_react.useEffect(() => {
      let alive = true;
      const load = () => {
        fetch(QUOTA_ROUTE).then((res) => res.json()).then((next) => {
          if (alive)
            setPayload(next);
        }).catch(() => {});
      };
      load();
      const timer = setInterval(() => {
        if (!document.hidden)
          load();
      }, POLL_INTERVAL_MS);
      const onVisible = () => {
        if (!document.hidden)
          load();
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        alive = false;
        clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisible);
      };
    }, []);
    import_react.useEffect(() => subscribeActiveChange(services, () => bumpActive((count) => count + 1)), []);
    const line = lineForProvider(payload, getActiveQuotaId());
    if (line === null)
      return null;
    return import_react.createElement("div", { style: ROOT_STYLE }, line);
  }
  registerQuotaLine(ctx, QuotaLine);
}

return module.exports; } });
