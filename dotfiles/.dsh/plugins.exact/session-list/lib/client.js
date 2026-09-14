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
var import_react2 = require("react");

// src/client/list.ts
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

// src/client/rows.ts
var UNGROUPED_KEY = "";
var COLLAPSED_SESSION_LIMIT = 5;
function groupVisible(row, archived, current) {
  return row.origin !== "subagent" && !archived.has(row.id) && (!row.blank || row.id === current);
}
function deriveGroups(list, workspaces, archivedSessionIds) {
  const archived = new Set(archivedSessionIds);
  const groups = [];
  const accounted = new Set;
  for (const workspace of workspaces) {
    const sessions = [];
    for (const id of workspace.sessionIds) {
      const summary = list.byId[id];
      if (summary === undefined)
        continue;
      accounted.add(id);
      if (!groupVisible(summary, archived, list.current))
        continue;
      sessions.push(summary);
    }
    groups.push({
      key: workspace.workspaceId,
      workspaceId: workspace.workspaceId,
      label: workspace.title,
      sessions
    });
  }
  const stray = [];
  for (const id of list.ids) {
    const summary = list.byId[id];
    if (summary === undefined || accounted.has(id))
      continue;
    if (!groupVisible(summary, archived, list.current))
      continue;
    stray.push(summary);
  }
  if (list.current !== undefined) {
    const current = list.byId[list.current];
    if (current !== undefined && current.blank && !accounted.has(current.id) && !stray.some((candidate) => candidate.id === current.id)) {
      stray.unshift(current);
    }
  }
  if (stray.length > 0) {
    groups.push({ key: UNGROUPED_KEY, workspaceId: undefined, label: "", sessions: stray });
  }
  return groups;
}
function collapsedSessionRows(sessions) {
  let ordinaryCount = 0;
  const rows = sessions.filter((session) => {
    if (session.blank)
      return true;
    if (ordinaryCount >= COLLAPSED_SESSION_LIMIT)
      return false;
    ordinaryCount += 1;
    return true;
  });
  return { rows, hiddenCount: sessions.length - rows.length };
}
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
    const flowAvailable = props.useDirectoryFlow((occupied) => occupied);
    const [now, setNow] = import_react.useState(() => Date.now());
    const [collapsedKeys, setCollapsedKeys] = import_react.useState([]);
    const [overflowKeys, setOverflowKeys] = import_react.useState([]);
    const [flowOpen, setFlowOpen] = import_react.useState(false);
    const [pickingFolder, setPickingFolder] = import_react.useState(false);
    const [errorOpen, setErrorOpen] = import_react.useState(false);
    const [modalError, setModalError] = import_react.useState(null);
    import_react.useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
      return () => clearInterval(timer);
    }, []);
    const source = rowSource(list);
    const groups = import_react.useMemo(() => deriveGroups(source, workspaces.items, workspaces.archivedSessionIds), [source, workspaces]);
    import_react.useEffect(() => {
      if (flowOpen && !flowAvailable)
        setFlowOpen(false);
    }, [flowOpen, flowAvailable]);
    const adoptDirectory = (path) => {
      setPickingFolder(true);
      deps.createWorkspace({ path }).then((workspace) => {
        setFlowOpen(false);
        deps.startSession(workspace.workspaceId);
      }).catch((reason) => {
        setFlowOpen(false);
        setModalError(reason instanceof Error ? reason.message : String(reason));
        setErrorOpen(true);
      }).finally(() => setPickingFolder(false));
    };
    const closeModal = () => {
      setErrorOpen(false);
      setModalError(null);
    };
    const flowOwner = {
      open: flowOpen,
      busy: pickingFolder,
      onPicked: (path) => {
        adoptDirectory(path);
      },
      onCancel: () => {
        setFlowOpen(false);
      },
      onError: (message) => {
        setFlowOpen(false);
        setModalError(message);
        setErrorOpen(true);
      }
    };
    const children = [];
    if (props.wide) {
      children.push(import_react.createElement("div", { key: "header", className: "session-list-header" }, import_react.createElement("span", { key: "label", className: "session-list-header-label" }, props.t("section.workspaces")), flowAvailable ? import_react.createElement("button", {
        key: "add",
        type: "button",
        className: "session-list-add",
        "aria-label": props.t("workspace.add"),
        title: props.t("workspace.add"),
        onClick: () => {
          setFlowOpen((open) => !open);
        }
      }, import_react.createElement(import_dsh_client_ui_primitives.IconProjectAddOutline16, { size: 16 })) : null));
      const groupSections = groups.map((group) => import_react.createElement(GroupSection, {
        key: group.key,
        group,
        collapsed: collapsedKeys.includes(group.key),
        overflowExpanded: overflowKeys.includes(group.key),
        onToggle: () => {
          setCollapsedKeys((keys) => keys.includes(group.key) ? keys.filter((candidate) => candidate !== group.key) : [...keys, group.key]);
        },
        onToggleOverflow: () => {
          setOverflowKeys((keys) => keys.includes(group.key) ? keys.filter((candidate) => candidate !== group.key) : [...keys, group.key]);
        },
        now,
        list,
        pending,
        t: props.t,
        open: deps.openSession,
        archive: deps.archiveSession
      }));
      children.push(import_react.createElement("div", { key: "list", className: "session-list-list", role: "tree", "aria-label": props.t("section.workspaces") }, groupSections));
    } else {
      const rows = visibleRows(source, workspaces.archivedSessionIds);
      children.push(import_react.createElement("div", { key: "list", className: "session-list-list", role: "tree", "aria-label": props.t("section.workspaces") }, rows.map((row) => import_react.createElement(SessionRow, {
        key: row.id,
        row,
        selected: list.current === row.id,
        hasPending: pending.has(row.id),
        wide: false,
        now,
        t: props.t,
        open: deps.openSession,
        archive: deps.archiveSession
      }))));
    }
    return import_react.createElement("div", { className: props.wide ? "session-list-root" : "session-list-root session-list-rail" }, ...children, deps.renderDirectoryFlow(flowOwner), import_react.createElement(ErrorDialog, {
      key: "error",
      open: errorOpen,
      title: props.t("folderError.title"),
      closeLabel: props.t("close"),
      message: modalError,
      retryDisabled: !flowAvailable,
      onClose: closeModal,
      onRetry: () => {
        closeModal();
        setFlowOpen(true);
      },
      cancelLabel: props.t("cancel"),
      retryLabel: props.t("folderError.retry")
    }));
  };
}
function GroupSection(props) {
  const { group, collapsed, overflowExpanded, now, list, pending, t } = props;
  const label = group.workspaceId === undefined ? t("group.ungrouped") : group.label;
  const containsCurrent = list.current !== undefined && group.sessions.some((row) => row.id === list.current);
  const folded = collapsedSessionRows(group.sessions);
  const visible = collapsed ? [] : folded.rows;
  const hiddenCount = collapsed ? 0 : folded.hiddenCount;
  const children = [
    import_react.createElement("div", {
      key: "header",
      className: ["session-list-group-row", containsCurrent ? "session-list-group-current" : null].filter(Boolean).join(" "),
      role: "treeitem",
      "aria-expanded": !collapsed,
      onClick: props.onToggle
    }, import_react.createElement("span", { key: "folder", className: "session-list-folder" }, import_react.createElement(collapsed ? import_dsh_client_ui_primitives.IconFolderClose16 : import_dsh_client_ui_primitives.IconFolderOpen16)), import_react.createElement("span", { key: "chevron", className: "session-list-chevron" }, import_react.createElement(import_dsh_client_ui_primitives.IconTriangleRightFill14, { className: collapsed ? undefined : "session-list-chevron-open" })), import_react.createElement("span", { key: "title", className: "session-list-group-title" }, label))
  ];
  if (!collapsed) {
    children.push(...visible.map((row) => import_react.createElement(SessionRow, {
      key: row.id,
      row,
      selected: list.current === row.id,
      hasPending: pending.has(row.id),
      wide: true,
      now,
      t,
      open: props.open,
      archive: props.archive
    })));
    if (hiddenCount > 0) {
      children.push(import_react.createElement("button", {
        key: "overflow",
        type: "button",
        className: "session-list-overflow",
        "aria-expanded": overflowExpanded,
        onClick: props.onToggleOverflow
      }, overflowExpanded ? t("sessions.collapse") : t("sessions.expand", { n: hiddenCount })));
    }
    if (overflowExpanded) {
      const shown = new Set(visible.map((row) => row.id));
      children.push(...group.sessions.filter((row) => !shown.has(row.id)).map((row) => import_react.createElement(SessionRow, {
        key: row.id,
        row,
        selected: list.current === row.id,
        hasPending: pending.has(row.id),
        wide: true,
        now,
        t,
        open: props.open,
        archive: props.archive
      })));
    }
  }
  return import_react.createElement("div", { key: group.key, className: "session-list-group" }, ...children);
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
function ErrorDialog(props) {
  if (!props.open)
    return null;
  return import_react.createElement("div", { className: "session-list-modal", role: "dialog", "aria-modal": "true", "aria-label": props.title }, import_react.createElement("div", { className: "session-list-modal-mask", onClick: props.onClose }), import_react.createElement("div", { className: "session-list-modal-dialog" }, import_react.createElement("div", { className: "session-list-modal-header" }, import_react.createElement("h2", { className: "session-list-modal-title" }, props.title), import_react.createElement("button", {
    type: "button",
    className: "session-list-modal-close",
    "aria-label": props.closeLabel,
    onClick: props.onClose
  }, import_react.createElement(import_dsh_client_ui_primitives.IconCloseFill14))), import_react.createElement("div", { className: "session-list-modal-body" }, import_react.createElement("div", { className: "session-list-modal-error", role: "alert" }, props.message)), import_react.createElement("div", { className: "session-list-modal-footer" }, import_react.createElement("button", { type: "button", className: "session-list-modal-action session-list-modal-outline", onClick: props.onClose }, props.cancelLabel), import_react.createElement("button", {
    type: "button",
    className: "session-list-modal-action session-list-modal-primary",
    disabled: props.retryDisabled,
    onClick: props.onRetry
  }, props.retryLabel))));
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
  "actions.copyId": "Copy session ID",
  "section.workspaces": "Workspaces",
  "group.ungrouped": "Ungrouped",
  "workspace.add": "Add workspace",
  "sessions.expand": "Show {n} more sessions",
  "sessions.collapse": "Show less",
  close: "Close",
  cancel: "Cancel",
  "folderError.title": "Couldn’t open folder",
  "folderError.retry": "Choose again"
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
  "actions.copyId": "复制会话 ID",
  "section.workspaces": "工作区",
  "group.ungrouped": "未分组",
  "workspace.add": "添加工作区",
  "sessions.expand": "展开其余 {n} 个会话",
  "sessions.collapse": "收起",
  close: "关闭",
  cancel: "取消",
  "folderError.title": "无法打开文件夹",
  "folderError.retry": "重新选择"
};

// src/client/apply.ts
var LIST_CSS = [
  ".session-list-root{box-sizing:border-box;min-height:0;flex-direction:column;flex:1;display:flex}",
  ".session-list-header{flex:none;align-items:center;justify-content:space-between;height:36px;" + "padding-left:4px;margin:2px 8px 4px;display:flex;box-sizing:border-box;" + "color:var(--dsw-alias-label-tertiary)}",
  ".session-list-header-label{flex:none;overflow:hidden;white-space:nowrap;line-height:20px}",
  ".session-list-add{flex:none;display:inline-flex;justify-content:center;align-items:center;" + "width:28px;height:28px;border:none;border-radius:50%;padding:0;background:transparent;" + "cursor:pointer;color:var(--dsw-alias-label-secondary)}",
  ".session-list-add:hover{background:var(--dsw-alias-interactive-bg-hover)}",
  ".session-list-list{min-height:0;flex-direction:column;flex:1;overflow-y:auto;margin:0 8px 8px;" + "padding-left:4px;display:flex;scrollbar-gutter:stable}",
  ".session-list-group{position:relative}",
  ".session-list-group+.session-list-group{margin-top:4px}",
  ".session-list-group>.session-list-row+*,.session-list-group>.session-list-overflow+*{margin-top:2px}",
  ".session-list-group-row{cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary);" + "border-radius:8px;align-items:center;gap:6px;height:34px;padding:0 8px;display:flex;box-sizing:border-box}",
  ".session-list-group-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
  ".session-list-folder{width:16px;height:20px;flex:none;justify-content:center;align-items:center;" + "display:inline-flex;color:var(--dsw-alias-label-tertiary)}",
  ".session-list-group-current .session-list-folder{color:var(--dsw-alias-state-business-primary)}",
  ".session-list-chevron{width:16px;height:20px;flex:none;justify-content:center;align-items:center;display:none}",
  ".session-list-group-row:hover .session-list-chevron{display:inline-flex}",
  ".session-list-group-row:hover .session-list-folder{display:none}",
  ".session-list-chevron svg{transition:transform 150ms var(--ds-ease-in-out)}",
  ".session-list-chevron .session-list-chevron-open{transform:rotate(90deg)}",
  ".session-list-group-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" + "font-size:14px;line-height:20px}",
  ".session-list-overflow{width:100%;height:28px;border:none;border-radius:8px;padding:0 12px 0 28px;" + "background:transparent;cursor:pointer;text-align:left;font-size:12px;" + "color:var(--dsw-alias-label-tertiary)}",
  ".session-list-overflow:hover{background:transparent;color:var(--dsw-alias-label-secondary)}",
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
  ".session-list-rail .session-list-row{height:32px;justify-content:center;padding:0}",
  ".session-list-modal{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;" + "justify-content:center;padding:24px}",
  ".session-list-modal-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);" + "backdrop-filter:var(--dsw-mask-blur)}",
  ".session-list-modal-dialog{position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;" + "width:min(380px,100%);padding:0 0 24px;overflow:hidden;border:0;border-radius:24px;" + "background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}",
  ".session-list-modal-header{display:flex;align-items:center;justify-content:space-between;gap:8px;" + "padding:22px 14px 12px 24px}",
  ".session-list-modal-title{margin:0;font-size:16px;line-height:24px;font-weight:500;" + "color:var(--dsw-alias-label-primary)}",
  ".session-list-modal-close{flex:none;display:inline-flex;align-items:center;justify-content:center;" + "width:28px;height:28px;border:none;border-radius:8px;background:transparent;cursor:pointer;" + "color:var(--dsw-alias-label-secondary)}",
  ".session-list-modal-close:hover{background:var(--dsw-alias-interactive-bg-hover)}",
  ".session-list-modal-body{padding:0 24px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}",
  ".session-list-modal-error{color:var(--dsw-alias-label-primary);word-break:break-word}",
  ".session-list-modal-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}",
  ".session-list-modal-action{display:inline-flex;align-items:center;justify-content:center;height:36px;" + "border:none;border-radius:18px;padding:0 14px;cursor:pointer;font-size:14px;line-height:22px;" + "color:var(--dsw-alias-label-primary);background:transparent}",
  ".session-list-modal-action:disabled{cursor:not-allowed;opacity:0.4}",
  ".session-list-modal-outline{border:0.5px solid var(--dsw-alias-border-l3)}",
  ".session-list-modal-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
  ".session-list-modal-primary{background:var(--dsw-alias-button-primary-fill);" + "color:var(--dsw-alias-label-primary-foreground)}",
  ".session-list-modal-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}"
].join("");
var SHADOW_PRIORITY = -1;
function directoryFlowOccupied(entryCount) {
  return entryCount > 0;
}
function directoryFlowSource(ctx) {
  return {
    getSnapshot: () => directoryFlowOccupied(ctx.slots.entries("sidebar.workspaces.directoryFlow").length),
    subscribe: (listener) => ctx.slots.subscribe("sidebar.workspaces.directoryFlow", listener)
  };
}
function registerSessionList(ctx, component) {
  ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({
    name: "sidebar.workspaces",
    priority: SHADOW_PRIORITY,
    locale: "session-list",
    inject: () => ({
      hooks: { workspaces: ctx.workspaces.list, directoryFlow: directoryFlowSource(ctx) }
    })
  }, component));
}

// src/client/index.ts
var inject = ["slots", "sessions", "workspaces", "uiWorkspace", "layout", "locale"];
function apply(ctx) {
  const sessions = ctx.sessions;
  const workspaces = ctx.workspaces;
  const uiWorkspace = ctx.uiWorkspace;
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
    },
    createWorkspace: (input) => workspaces.create(input),
    startSession: (workspaceId) => {
      uiWorkspace.startSession(workspaceId);
    },
    renderDirectoryFlow: (owner) => {
      const entry = ctx.slots.entries("sidebar.workspaces.directoryFlow").at(0);
      if (entry?.component === undefined)
        return null;
      const injected = entry.inject?.() ?? {};
      return import_react2.createElement(entry.component, {
        ...owner,
        ...injected
      });
    }
  }));
}

return module.exports; } });
