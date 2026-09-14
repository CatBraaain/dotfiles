window.__ModuleLoader__.load({ id: "dotfiles-dsh-session-list", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
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

// src/client/list.ts
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

// src/client/rows.ts
function visibleRows(list, archivedSessionIds) {
  const archived = new Set(archivedSessionIds);
  const rows = [];
  for (const id of list.ids) {
    const row = list.byId[id];
    if (row === undefined || row.origin === "subagent" || archived.has(id))
      continue;
    if (row.blank && id !== list.current)
      continue;
    rows.push(row);
  }
  return rows;
}
function ensureCurrentBlank(rows, list) {
  const current = list.current;
  if (current === undefined)
    return rows;
  const row = list.byId[current];
  if (row === undefined || !row.blank)
    return rows;
  if (rows.some((candidate) => candidate.id === current))
    return rows;
  return [row, ...rows];
}
function dotState(row, hasPending) {
  if (hasPending)
    return "warning";
  if (row.running)
    return "ongoing";
  if (row.completed)
    return "done";
  return "idle";
}
function rowTitle(row, newSessionLabel) {
  if (row.blank)
    return newSessionLabel;
  return row.title || row.displayTitle;
}
function timeLabel(bucket, t) {
  return bucket.unit === "now" ? t("time.now") : t(`time.${bucket.unit}`, { n: bucket.n });
}

// src/client/list.ts
var COPIED_RESET_MS = 1000;
var NOW_TICK_MS = 30000;
function rowSource(state) {
  const byId = {};
  for (const [id, summary] of Object.entries(state.byId))
    byId[id] = summary;
  return { ids: state.ids, byId, current: state.current };
}
function createSessionList(deps) {
  return function SessionList(props) {
    const list = props.useSessions((s) => s);
    const pending = props.useSessionPendingInteraction((s) => s);
    const workspaces = props.useWorkspaces((s) => s);
    const [now, setNow] = import_react.useState(() => Date.now());
    import_react.useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
      return () => clearInterval(timer);
    }, []);
    const source = rowSource(list);
    const rows = ensureCurrentBlank(visibleRows(source, workspaces.archivedSessionIds), source);
    return import_react.createElement("div", { className: props.wide ? "session-list-root" : "session-list-root session-list-rail" }, import_react.createElement("div", { className: "session-list-list", role: "tree", "aria-label": "Sessions" }, rows.map((row) => import_react.createElement(SessionRow, {
      key: row.id,
      row,
      selected: list.current === row.id,
      hasPending: pending.has(row.id),
      wide: props.wide,
      now,
      t: props.t,
      open: deps.openSession,
      archive: deps.archiveSession
    }))));
  };
}
function SessionRow(props) {
  const { row, selected, hasPending, wide, now, t } = props;
  const [copied, setCopied] = import_react.useState(false);
  const timerRef = import_react.useRef(null);
  import_react.useEffect(() => () => {
    if (timerRef.current !== null)
      clearTimeout(timerRef.current);
  }, []);
  const onCopy = () => {
    if (timerRef.current !== null)
      return;
    import_dsh_client_ui_primitives.writeClipboard(row.id).then((ok) => {
      if (!ok || timerRef.current !== null)
        return;
      setCopied(true);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setCopied(false);
      }, COPIED_RESET_MS);
    });
  };
  const classes = ["session-list-row"];
  if (selected)
    classes.push("session-list-selected");
  const children = [
    import_react.createElement("span", { key: "slot", className: "session-list-slot" }, import_react.createElement(import_dsh_client_ui_primitives.StateDot, { state: dotState(row, hasPending) }))
  ];
  if (wide) {
    children.push(import_react.createElement("span", { key: "title", className: "session-list-title" }, rowTitle(row, t("session.new"))));
    if (!row.blank) {
      children.push(import_react.createElement("span", { key: "time", className: "session-list-time" }, timeLabel(import_dsh_client_ui_primitives.relativeTime(row.updatedAt, now), t)), import_react.createElement("span", { key: "actions", className: "session-list-actions" }, import_react.createElement("button", {
        type: "button",
        className: "session-list-action",
        title: t("actions.archive"),
        onClick: (event) => {
          event.stopPropagation();
          props.archive(row.id);
        }
      }, import_react.createElement(import_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })), import_react.createElement("button", {
        type: "button",
        className: "session-list-action",
        title: t("actions.copyId"),
        onClick: (event) => {
          event.stopPropagation();
          onCopy();
        }
      }, import_react.createElement(copied ? import_dsh_client_ui_primitives.IconCheckOutline16 : import_dsh_client_ui_primitives.IconCopyOutline16))));
    }
  }
  return import_react.createElement("div", {
    className: classes.join(" "),
    role: "treeitem",
    "aria-selected": selected,
    onClick: () => props.open(row.id)
  }, ...children);
}

// src/client/locales.ts
var NS = "session-list";
var DICT_EN = {
  "session.new": "New Session",
  "time.now": "now",
  "time.minutes": "{n}min",
  "time.hours": "{n}h",
  "time.days": "{n}d",
  "time.months": "{n}mo",
  "time.years": "{n}y",
  "actions.archive": "Archive session",
  "actions.copyId": "Copy session ID"
};
var DICT_ZH = {
  "session.new": "新会话",
  "time.now": "刚刚",
  "time.minutes": "{n}分钟",
  "time.hours": "{n}小时",
  "time.days": "{n}天",
  "time.months": "{n}个月",
  "time.years": "{n}年",
  "actions.archive": "归档会话",
  "actions.copyId": "复制会话 ID"
};

// src/client/apply.ts
var LIST_CSS = [
  ".session-list-root{box-sizing:border-box;min-height:0;flex-direction:column;flex:1;display:flex}",
  ".session-list-list{min-height:0;flex-direction:column;flex:1;overflow-y:auto;margin:0 8px 8px;" + "padding-left:4px;display:flex;scrollbar-gutter:stable}",
  ".session-list-row{cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary);" + "border-radius:8px;align-items:center;height:32px;padding:0 8px;display:flex}",
  ".session-list-row:hover,.session-list-row.session-list-selected{background:var(--dsw-alias-interactive-bg-hover)}",
  ".session-list-slot{width:16px;height:20px;flex:none;justify-content:center;align-items:center;display:inline-flex}",
  ".session-list-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" + "font-size:14px;line-height:20px;margin:0 6px 0 4px}",
  ".session-list-time{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;white-space:nowrap}",
  ".session-list-actions{flex:none;align-items:center;gap:10px;display:none}",
  ".session-list-row:hover .session-list-actions{display:inline-flex}",
  ".session-list-row:hover .session-list-time{display:none}",
  ".session-list-action{cursor:pointer;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);" + "background:none;border:none;border-radius:4px;padding:0;display:inline-flex;justify-content:center;align-items:center}",
  ".session-list-action:hover{color:var(--dsw-alias-label-primary)}",
  ".session-list-rail .session-list-row{height:32px;justify-content:center;padding:0}"
].join("");
var SHADOW_PRIORITY = -1;
function registerSessionList(ctx, component) {
  ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({
    name: "sidebar.workspaces",
    priority: SHADOW_PRIORITY,
    locale: "session-list",
    inject: () => ({ hooks: { workspaces: ctx.workspaces.list } })
  }, component));
}

// src/client/index.ts
var inject = ["slots", "sessions", "workspaces", "layout", "locale"];
function apply(ctx) {
  const sessions = ctx.sessions;
  const workspaces = ctx.workspaces;
  const layout = ctx.layout;
  ctx.locale.register(NS, "en", DICT_EN);
  ctx.locale.register(NS, "zh", DICT_ZH);
  const style = document.createElement("style");
  style.textContent = LIST_CSS;
  (document.head ?? document.documentElement).appendChild(style);
  ctx.effect(() => () => style.remove(), "session-list: style");
  registerSessionList(ctx, createSessionList({
    openSession: (id) => {
      sessions.open(id);
      layout.selectPanel(null);
    },
    archiveSession: (id) => {
      workspaces.archiveSession(id).catch((reason) => {
        console.warn("session-list: archive failed:", reason);
      });
    }
  }));
}

return module.exports; } });
