window.__ModuleLoader__.load({ id: "dotfiles-dsh-titlebar", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
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

// src/client/format.ts
var SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
var SPINNER_INTERVAL_MS = 100;
var WAITING_MARK = "⏸";
var MARKED_TITLE_PATTERN = /^(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⏸] )/;
function spinnerFrame(nowMs, frames = SPINNER_FRAMES) {
  const index = Math.floor(nowMs / SPINNER_INTERVAL_MS) % frames.length;
  return frames[index < 0 ? index + frames.length : index];
}
function splitMarkedTitle(title) {
  const match = MARKED_TITLE_PATTERN.exec(title);
  if (match === null)
    return { plain: title };
  return { mark: match[0].trimEnd(), plain: title.slice(match[0].length) };
}
function buildTitle(mark, plain) {
  return mark === undefined ? plain : `${mark} ${plain}`;
}

// src/client/controller.ts
class TitlebarController {
  sessions;
  pending;
  host;
  timer = null;
  disposed = false;
  unsubscribe = null;
  lastWritten = null;
  constructor(sessions, pending, host) {
    this.sessions = sessions;
    this.pending = pending;
    this.host = host;
  }
  start() {
    const unsubscribers = [
      this.sessions.subscribe(() => this.sync()),
      this.pending.subscribe(() => this.sync())
    ];
    this.unsubscribe = () => {
      for (const fn of unsubscribers)
        fn();
    };
    this.sync();
  }
  dispose() {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopTimer();
    const live = this.host.getTitle();
    if (this.lastWritten !== null && live === this.lastWritten) {
      this.host.setTitle(this.plainOf(live));
    }
  }
  sync() {
    if (this.disposed)
      return;
    const live = this.host.getTitle();
    const mark = this.markForNow();
    const next = buildTitle(mark, this.plainOf(live));
    if (next !== live) {
      this.host.setTitle(next);
      this.lastWritten = next;
    }
    this.updateTimer(mark);
  }
  plainOf(live) {
    if (this.lastWritten !== null && live === this.lastWritten) {
      return splitMarkedTitle(live).plain;
    }
    return live;
  }
  markForNow() {
    const list = this.sessions.getSnapshot();
    const currentId = list.current;
    if (currentId === undefined)
      return;
    if (this.pending.getSnapshot().has(currentId))
      return WAITING_MARK;
    if (list.byId[currentId]?.running === true)
      return spinnerFrame(this.host.now());
    return;
  }
  updateTimer(mark) {
    const marked = mark !== undefined;
    if (marked && this.timer === null) {
      this.timer = this.host.startTimer(() => this.sync(), SPINNER_INTERVAL_MS);
    } else if (!marked && this.timer !== null) {
      this.stopTimer();
    }
  }
  stopTimer() {
    if (this.timer !== null) {
      this.host.stopTimer(this.timer);
      this.timer = null;
    }
  }
}

// src/client/index.ts
var inject = ["sessions", "uiSession"];
var browserHost = {
  getTitle: () => document.title,
  setTitle: (title) => {
    document.title = title;
  },
  now: () => Date.now(),
  startTimer: (handler, intervalMs) => setInterval(handler, intervalMs),
  stopTimer: (handle) => clearInterval(handle)
};
function apply(ctx) {
  const controller = new TitlebarController(ctx.sessions.list, ctx.uiSession.pendingInteractions, browserHost);
  controller.start();
  ctx.effect(function* () {
    yield () => controller.dispose();
  });
}

return module.exports; } });
