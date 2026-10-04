import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { installRecordingOverlay } from "./overlay.mjs";

const overlaySource = readFileSync(new URL("./overlay.mjs", import.meta.url), "utf8");
const overlayHtml = readFileSync(new URL("./overlay.html", import.meta.url), "utf8");
const overlayCss = readFileSync(new URL("./overlay.css", import.meta.url), "utf8");
const designSource = readFileSync(new URL("./design.html", import.meta.url), "utf8");

const TITLE_AREA = { x: 0, y: 0, width: 1280, height: 64 };
const PAGE_AREA = { x: 0, y: 64, width: 1280, height: 720 };

function baseState(overrides = {}) {
  return {
    title: "Checkout › confirm the order",
    steps: [
      { name: "input name", action: "Type the delivery name", expected: "Name is preserved" },
      { name: "press enter", action: "Press Enter", expected: "Row is added" },
      { name: "click checkbox", action: "Click the checkbox", expected: "Row is completed" },
    ],
    current: 1,
    phase: "waiting",
    theme: "light",
    pageArea: { ...PAGE_AREA },
    titleArea: { ...TITLE_AREA },
    target: {
      rect: { x: 100, y: 200, width: 400, height: 66 },
      name: "Name",
      kind: "input",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Deterministic DOM shim. The installer only uses the APIs mirrored here, so
// the real asset runs unchanged under node:test with a virtual clock.
// ---------------------------------------------------------------------------
/** @typedef {{char:number,line:number}} RoleMetric */
/** @type {Record<string, RoleMetric>} */
const ROLE_METRICS = {
  "step-count": { char: 8, line: 20 },
  "test-title": { char: 8.8, line: 24 },
  "label-text": { char: 9, line: 26 },
  "result-text": { char: 8, line: 20 },
  "input-text": { char: 11, line: 30 },
  "key-name": { char: 11, line: 30 },
};

/**
 * @typedef {{matches:boolean, addEventListener:(type:string, listener:()=>void)=>void, removeEventListener:(type:string, listener:()=>void)=>void}} MediaQueryListLike
 * @typedef {Record<string, string> & {setProperty:(name:string, value:string, priority?:string)=>void, removeProperty:(name:string)=>void, getPropertyValue:(name:string)=>string}} StyleLike
 * @typedef {{transform?:string, opacity?:number|string}} KeyframeLike
 * @typedef {{x:number, y:number, width:number, height:number}} ShimRect
 * @typedef {Record<string, {char:number, line:number}>} RoleMetricTable
 */

class ShimKeyframeEffect {
  /** @type {KeyframeLike[]} */
  keyframes = [];
  /** @param {KeyframeLike[]} keyframes */
  setKeyframes(keyframes) {
    this.keyframes = keyframes;
  }
  getKeyframes() {
    return this.keyframes;
  }
}

class ShimAnimation {
  /** @type {ShimWorld} */
  world;
  /** @type {KeyframeLike[]} */
  keyframes;
  /** @type {number} */
  duration;
  /** @type {string | undefined} */
  fill;
  /** @type {string} */
  playState = "running";
  /** @type {ShimKeyframeEffect} */
  effect;
  /** @type {number | null} */
  startTime = null;
  /** @type {number} */
  createdAt;
  /** @type {Promise<void>} */
  finished;
  /** @type {() => void} */
  resolveFinished = () => {};
  /** @type {(error: Error) => void} */
  rejectFinished = () => {};
  /**
   * @param {ShimWorld} world
   * @param {KeyframeLike[]} keyframes
   * @param {{duration?:number, fill?:string}} options
   */
  constructor(world, keyframes, options) {
    this.world = world;
    this.keyframes = keyframes;
    this.duration = options.duration ?? 0;
    this.fill = options.fill;
    this.effect = new ShimKeyframeEffect();
    this.effect.setKeyframes(keyframes);
    this.createdAt = world.now;
    this.finished = new Promise((resolve, reject) => {
      this.resolveFinished = resolve;
      this.rejectFinished = reject;
    });
    world.animations.add(this);
  }
  get endTime() {
    return (this.startTime ?? this.createdAt) + this.duration;
  }
  cancel() {
    if (this.playState === "finished") return;
    this.playState = "cancelled";
    this.world.animations.delete(this);
    const error = new Error("Animation was cancelled");
    error.name = "AbortError";
    this.rejectFinished(error);
  }
  /** @param {number} now */
  settle(now) {
    if (this.playState === "running" && now >= this.endTime) {
      this.playState = "finished";
      this.resolveFinished();
    }
  }
}

class ShimClassList {
  /** @type {ShimElement} */
  element;
  /** @param {ShimElement} element */
  constructor(element) {
    this.element = element;
  }
  /** @returns {Set<string>} */
  tokenSet() {
    return new Set(this.element.className.split(/\s+/).filter(Boolean));
  }
  /** @param {string} name */
  add(name) {
    const tokens = this.tokenSet();
    tokens.add(name);
    this.element.className = [...tokens].join(" ");
  }
  /** @param {string} name */
  remove(name) {
    const tokens = this.tokenSet();
    tokens.delete(name);
    this.element.className = [...tokens].join(" ");
  }
  /** @param {string} name */
  contains(name) {
    return this.tokenSet().has(name);
  }
  /**
   * @param {string} name
   * @param {boolean} force
   */
  toggle(name, force) {
    const tokens = this.tokenSet();
    const next = force ?? !tokens.has(name);
    if (next) tokens.add(name);
    else tokens.delete(name);
    this.element.className = [...tokens].join(" ");
  }
}

function makeStyle() {
  const style = /** @type {StyleLike} */ ({});
  style.setProperty = (name, value) => {
    style[name] = value;
  };
  style.removeProperty = (name) => {
    delete style[name];
  };
  style.getPropertyValue = (name) => style[name] ?? "";
  return style;
}

class ShimElement {
  /** @type {string} */
  tagName;
  /** @type {Record<string, string>} */
  attributes;
  /** @type {string} */
  className;
  /** @type {ShimElement[]} */
  children = [];
  /** @type {ShimElement | null} */
  parentNode = null;
  /** @type {boolean} */
  hidden;
  /** @type {Record<string, string>} */
  dataset = {};
  /** @type {StyleLike} */
  style;
  /** @type {ShimClassList} */
  classList;
  /** @type {string} */
  _text = "";
  /** @type {ShimWorld} */
  ownerWorld;
  /** @type {(() => {children: ShimElement[]}) | undefined} */
  attachShadow;
  /** @param {string} tagName @param {Record<string, string>} attributes */
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toLowerCase();
    this.attributes = { ...attributes };
    this.className = typeof attributes.class === "string" ? attributes.class : "";
    this.hidden = attributes.hidden !== undefined;
    this.style = makeStyle();
    this.classList = new ShimClassList(this);
    this.ownerWorld = /** @type {ShimWorld} */ (/** @type {unknown} */ (null));
  }
  get textContent() {
    return this._text;
  }
  /** @param {string} value */
  set textContent(value) {
    this._text = String(value);
  }
  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = String(value);
    if (name === "hidden") this.hidden = true;
  }
  /** @param {...ShimElement} nodes */
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode?.removeChild(node);
      node.parentNode = this;
      this.children.push(node);
    }
  }
  /** @param {ShimElement} node */
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  replaceChildren() {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }
  /** @param {boolean} deep */
  cloneNode(deep) {
    const copy = new ShimElement(this.tagName, this.attributes);
    copy.className = this.className;
    copy.hidden = this.hidden;
    copy.dataset = { ...this.dataset };
    Object.assign(copy.style, this.style);
    copy._text = this._text;
    if (deep) copy.children = this.children.map((child) => child.cloneNode(true));
    return copy;
  }
  /**
   * @param {KeyframeLike[]} keyframes
   * @param {{duration?:number, fill?:string}} options
   */
  animate(keyframes, options) {
    return new ShimAnimation(this.ownerWorld, keyframes, options);
  }
  /** @returns {ShimElement[]} */
  descendants() {
    const found = [];
    for (const child of this.children) found.push(child, ...child.descendants());
    return found;
  }
  /** @param {string} selector */
  matchesClass(selector) {
    const name = selector.replace(/^\./, "");
    return this.className.split(/\s+/).includes(name);
  }
  getBoundingClientRect() {
    const metrics = ROLE_METRICS[this.className];
    if (metrics) {
      const units = [...this._text].reduce(
        (sum, char) => sum + ((char.codePointAt(0) ?? 0) <= 0x7f ? 1 : 2),
        0,
      );
      const natural = units * metrics.char;
      if (!this.style.width || this.style.width === "max-content")
        return { x: 0, y: 0, width: natural, height: metrics.line };
      const width = Number.parseFloat(this.style.width) || 0;
      const lines = Math.max(1, Math.ceil(natural / Math.max(1, width)));
      return { x: 0, y: 0, width, height: lines * metrics.line };
    }
    return {
      x: Number.parseFloat(this.style.left) || 0,
      y: Number.parseFloat(this.style.top) || 0,
      width: Number.parseFloat(this.style.width) || 0,
      height: Number.parseFloat(this.style.height) || 0,
    };
  }
}

/**
 * @param {string} html
 * @param {ShimWorld} world
 * @returns {ShimElement[]}
 */
function parseHtml(html, world) {
  /** @type {ShimElement[]} */
  const roots = [];
  /** @type {{children: ShimElement[]}[]} */
  const stack = [{ children: roots }];
  const pattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*(\/?)>/g;
  let match;
  while ((match = pattern.exec(html))) {
    const [, closing, name, attributeText, selfClosing] = match;
    if (closing) {
      stack.pop();
      continue;
    }
    /** @type {Record<string, string>} */
    const attributes = {};
    for (const attribute of attributeText.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g))
      attributes[attribute[1]] = attribute[2] ?? "";
    const node = new ShimElement(name, attributes);
    node.ownerWorld = world;
    stack.at(-1)?.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new Error("overlay.html did not parse into a balanced tree");
  return roots;
}

class ShimWorld {
  /** @type {number} */
  now = 0;
  /** @type {Set<ShimAnimation>} */
  animations = new Set();
  /** @type {Map<number, () => void>} */
  frames = new Map();
  /** @type {number} */
  frameIds = 0;
  /** @type {() => MediaQueryListLike} */
  matchMedia;
  /** @type {Record<string, unknown>} */
  window = {};
  /** @type {{children: ShimElement[]} | null} */
  preparedShadow = null;
  /** @type {{createElement:(tagName:string)=>ShimElement, documentElement:ShimElement}} */
  document;
  /** @type {(callback:() => void)=>number} */
  requestAnimationFrame;
  /** @type {(id:number)=>boolean} */
  cancelAnimationFrame;
  /** @type {{now:()=>number}} */
  performance;
  /** @type {Record<string, unknown>} */
  globals;
  /** @type {Record<string, unknown>} */
  previous;
  /** @param {{reducedMotion?:boolean, viewport?:{width:number, height:number}}} options */
  constructor({ reducedMotion = false, viewport = { width: 1920, height: 1080 } } = {}) {
    this.matchMedia = () => ({
      matches: reducedMotion,
      addEventListener() {},
      removeEventListener() {},
    });
    const self = this;
    this.document = {
      createElement: (tagName) => {
        const node = new ShimElement(tagName);
        node.ownerWorld = self;
        const shadow = self.preparedShadow;
        if (tagName === "recording-annotation-overlay" && shadow) {
          self.preparedShadow = null;
          node.attachShadow = () => shadow;
        }
        return node;
      },
      documentElement: new ShimElement("html"),
    };
    this.document.documentElement.ownerWorld = this;
    this.requestAnimationFrame = (callback) => {
      const id = ++this.frameIds;
      this.frames.set(id, callback);
      return id;
    };
    this.cancelAnimationFrame = (id) => this.frames.delete(id);
    this.performance = { now: () => this.now };
    this.globals = {
      document: this.document,
      window: this.window,
      matchMedia: this.matchMedia,
      performance: this.performance,
      requestAnimationFrame: this.requestAnimationFrame,
      cancelAnimationFrame: this.cancelAnimationFrame,
      CSSStyleSheet: class {
        replaceSync() {}
      },
      KeyframeEffect: ShimKeyframeEffect,
      HTMLElement: ShimElement,
      SVGElement: class ShimSvgElement extends ShimElement {},
      getComputedStyle: (/** @type {ShimElement} */ node) => ({
        opacity: node.style.opacity ?? "1",
        transform: node.style.transform ?? "none",
      }),
      innerWidth: viewport.width,
      innerHeight: viewport.height,
    };
    this.previous = {};
    const target = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
    for (const [name, value] of Object.entries(this.globals)) {
      this.previous[name] = target[name];
      target[name] = value;
    }
  }
  /** @param {number} ms */
  advance(ms) {
    this.now += ms;
    for (const animation of Array.from(this.animations)) animation.settle(this.now);
    const callbacks = Array.from(this.frames.entries());
    this.frames.clear();
    for (const [, callback] of callbacks) callback();
    for (const animation of Array.from(this.animations)) animation.settle(this.now);
  }
  restore() {
    const target = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
    for (const [name, value] of Object.entries(this.previous)) target[name] = value;
  }
  /**
   * @param {Record<string, unknown>} state
   * @returns {{layout: ShimLayout, overlay: ShimOverlay, shadow: {querySelector:(selector:string)=>ShimElement|null, querySelectorAll:(selector:string)=>ShimElement[]}}}
   */
  install(state) {
    const nodes = parseHtml(overlayHtml, this);
    const all = () => nodes.flatMap((node) => [node, ...node.descendants()]);
    const shadow = {
      children: nodes,
      querySelector: (/** @type {string} */ selector) =>
        all().find((node) => node.matchesClass(selector)) ?? null,
      querySelectorAll: (/** @type {string} */ selector) =>
        all().filter((node) => node.matchesClass(selector)),
    };
    this.preparedShadow = shadow;
    const typedState = /** @type {import("./overlay.mjs").OverlayState} */ (state);
    const layout = installRecordingOverlay({
      html: overlayHtml,
      css: overlayCss,
      state: typedState,
    });
    const overlay = /** @type {ShimOverlay} */ (this.window.recordingOverlay);
    return { layout, overlay, shadow };
  }
}

/**
 * @typedef {{element:string, reason:string, rect:{x:number,y:number,width:number,height:number}, step:number, total:number, pageArea:{x:number,y:number,width:number,height:number}, value:string}} ShimConstraint
 * @typedef {{constraints:ShimConstraint[], placements:Record<string,{x:number,y:number,width:number,height:number}>, requiredTitleHeight:number, at:number}} ShimLayout
 * @typedef {{update:(patch:Record<string, unknown>)=>ShimLayout, inspect:()=>ShimLayout, painted:()=>Promise<ShimLayout>, setVisible:(visible:boolean)=>Promise<void>, dispose:()=>void}} ShimOverlay
 */

/** @type {{querySelector:(selector:string)=>ShimElement|null, querySelectorAll:(selector:string)=>ShimElement[]}} */
let currentShadow = /** @type {never} */ (/** @type {unknown} */ (null));
/** @type {ShimOverlay|null} */
let currentOverlay = null;

/**
 * @param {ShimWorld} world
 * @param {Record<string, unknown>} state
 */
function installAt(world, state) {
  const result = world.install(state);
  currentShadow = result.shadow;
  currentOverlay = result.overlay;
  return result;
}

/** @param {string} selector */
function elementOrThrow(selector) {
  const found = currentShadow.querySelector(selector);
  assert.ok(found instanceof ShimElement, `${selector} is missing`);
  return found;
}

/** @param {string} selector */
function text(selector) {
  return elementOrThrow(selector).textContent;
}

/** @param {string} selector */
function style(selector) {
  return elementOrThrow(selector).style;
}

/** @param {string} selector */
function hidden(selector) {
  return elementOrThrow(selector).hidden;
}

function overlayHandle() {
  assert.ok(currentOverlay, "overlay handle is not installed");
  return currentOverlay;
}

// ---------------------------------------------------------------------------
// Design gallery identity: design.html must embed the real assets verbatim.
// ---------------------------------------------------------------------------
test("design.html embeds the installer from overlay.mjs", () => {
  const inline = designSource.match(
    /\/\* overlay-asset:installer:start \*\/([\s\S]*?)\/\* overlay-asset:installer:end \*\//,
  );
  assert.ok(inline, "design.html lacks the installer markers");
  const inlineSource = inline[1].replace(/^\s*const installer =/, "").replace(/;\s*$/, "");
  const assetInstaller = overlaySource
    .slice(overlaySource.indexOf("/** Self-contained"))
    .replace("export function", "function");
  // Whitespace and commas differ between the standalone module and the
  // oxfmt-formatted inline copy; every other byte must match.
  const comparable = (/** @type {string} */ text) => text.replace(/[\s,]/g, "");
  assert.equal(
    comparable(inlineSource),
    comparable(assetInstaller),
    "design.html inline installer differs from assets/overlay.mjs",
  );
});

test("design.html embeds overlay.html and overlay.css verbatim", () => {
  const htmlMatch = designSource.match(
    /\/\* overlay-asset:html \*\/\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/,
  );
  const cssMatch = designSource.match(
    /\/\* overlay-asset:css \*\/\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/,
  );
  assert.ok(htmlMatch, "design.html lacks the html asset marker");
  assert.ok(cssMatch, "design.html lacks the css asset marker");
  // oxfmt re-quotes the embedded literal; accept either quote style.
  const parseLiteral = (/** @type {string} */ literal) =>
    literal.startsWith("'")
      ? JSON.parse(`"${literal.slice(1, -1).replaceAll('"', '\\"')}"`)
      : JSON.parse(literal);
  assert.equal(parseLiteral(htmlMatch[1]), overlayHtml);
  assert.equal(parseLiteral(cssMatch[1]), overlayCss);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
test("rejects malformed state", () => {
  const world = new ShimWorld();
  try {
    const cases = [
      baseState({ steps: [] }),
      baseState({ current: 0 }),
      baseState({ phase: "done" }),
      baseState({ theme: "blue" }),
      baseState({ layer: "outside" }),
      baseState({ read: 4 }),
      baseState({ current: 1, read: 3 }),
      baseState({ pageArea: undefined }),
      baseState({
        target: { rect: { x: 0, y: 0, width: 0, height: 10 }, name: "x", kind: "click" },
      }),
      baseState({ checkAt: Number.NaN }),
    ];
    for (const state of cases)
      assert.throws(() => world.install(state), Error, `expected rejection for ${state.title}`);
  } finally {
    world.restore();
  }
});

// ---------------------------------------------------------------------------
// READ progress
// ---------------------------------------------------------------------------
test("step-count shows READ progress and finishes with COMPLETE", () => {
  const world = new ShimWorld();
  try {
    const { overlay } = installAt(world, baseState());
    assert.equal(text(".step-count"), "READ 0 / 3");
    overlay.update({ read: 1 });
    assert.equal(text(".step-count"), "READ 1 / 3");
    overlay.update({ current: 3, phase: "result", target: null, read: 2 });
    assert.equal(text(".step-count"), "READ 2 / 3");
    overlay.update({ read: 3 });
    assert.equal(text(".step-count"), "COMPLETE 3 / 3");
  } finally {
    world.restore();
  }
});

test("readTotal generalizes READ beyond the step count", () => {
  const world = new ShimWorld();
  try {
    const { overlay } = installAt(world, baseState({ readTotal: 5 }));
    assert.equal(text(".step-count"), "READ 0 / 5");
    overlay.update({ current: 3, phase: "result", target: null, read: 4 });
    assert.equal(text(".step-count"), "READ 4 / 5");
    overlay.update({ read: 5 });
    assert.equal(text(".step-count"), "COMPLETE 5 / 5");
  } finally {
    world.restore();
  }
});

test("segments follow current steps and completion", () => {
  const world = new ShimWorld();
  try {
    const { overlay } = installAt(world, baseState({ current: 2, read: 1 }));
    const classes = () =>
      currentShadow.querySelectorAll(".segment").map((segment) => segment.className);
    assert.deepEqual(classes(), ["segment done", "segment current", "segment pending"]);
    overlay.update({ current: 3, phase: "result", target: null, read: 3 });
    assert.deepEqual(classes(), ["segment done", "segment done", "segment done"]);
  } finally {
    world.restore();
  }
});

// ---------------------------------------------------------------------------
// Task label
// ---------------------------------------------------------------------------
test("task label anchors above the target with the anchor width and 48px height", () => {
  const world = new ShimWorld();
  try {
    const { layout } = installAt(world, baseState());
    assert.deepEqual(layout.placements["task-label"], {
      x: 100,
      y: 200 - 12 - 48,
      width: 400,
      height: 48,
    });
    assert.equal(text(".label-text"), "Type the delivery name");
    assert.equal(text(".chip"), "1");
    assert.equal(layout.constraints.length, 0);
  } finally {
    world.restore();
  }
});

test("long task text wraps instead of truncating and grows the label height", () => {
  const world = new ShimWorld();
  try {
    const action = "配送先の氏名と郵便番号と建物名と部屋番号を確認してから入力する";
    const { layout } = installAt(
      world,
      baseState({
        steps: [
          { name: "long", action, expected: "ok" },
          { name: "b", action: "B", expected: "ok" },
        ],
      }),
    );
    const placed = layout.placements["task-label"];
    assert.equal(placed.width, 400);
    assert.ok(placed.height > 48, `expected wrapping to raise height, got ${placed.height}`);
    assert.equal(text(".label-text"), action);
  } finally {
    world.restore();
  }
});

test("task label falls below the anchor when above does not fit", () => {
  const world = new ShimWorld();
  try {
    const rect = { x: 100, y: 80, width: 400, height: 66 };
    const { layout } = installAt(
      world,
      baseState({ target: { rect, name: "Name", kind: "input" }, taskAnchor: rect }),
    );
    assert.equal(layout.placements["task-label"].y, 80 + 66 + 12);
  } finally {
    world.restore();
  }
});

test("task label reports a constraint when neither side fits", () => {
  const world = new ShimWorld();
  try {
    const rect = { x: 100, y: 88, width: 200, height: 620 };
    const { layout } = installAt(
      world,
      baseState({ target: { rect, name: "Panel", kind: "click" }, taskAnchor: rect }),
    );
    const constraint = layout.constraints.find((entry) => entry.element === "task-label");
    assert.ok(constraint, "expected a task-label constraint");
    assert.equal(constraint.step, 1);
    assert.equal(constraint.value, "Type the delivery name");
  } finally {
    world.restore();
  }
});

test("task label stays fixed on its anchor while the target moves", () => {
  const world = new ShimWorld();
  try {
    const anchor = { x: 100, y: 200, width: 400, height: 66 };
    const { overlay, layout } = installAt(world, baseState({ taskAnchor: anchor }));
    const before = layout.placements["task-label"];
    overlay.update({
      phase: "acting",
      target: { rect: { x: 100, y: 520, width: 400, height: 66 }, name: "Name", kind: "input" },
    });
    assert.deepEqual(overlay.inspect().placements["task-label"], before);
  } finally {
    world.restore();
  }
});

// ---------------------------------------------------------------------------
// Check fade
// ---------------------------------------------------------------------------
test("check fades in over 360ms after the operation ends", () => {
  const world = new ShimWorld();
  try {
    const { overlay } = installAt(world, baseState());
    assert.equal(hidden(".check"), true);
    world.advance(1000);
    overlay.update({ phase: "acting" });
    assert.equal(hidden(".check"), true);
    world.advance(1000);
    overlay.update({ phase: "checking" });
    assert.equal(hidden(".check"), false);
    assert.equal(Number(style(".check").opacity), 0);
    world.advance(180);
    const half = Number(style(".check").opacity);
    assert.ok(half > 0.3 && half < 0.7, `opacity at 180ms should ease to ~0.5, got ${half}`);
    world.advance(180);
    const done = Number(style(".check").opacity);
    assert.ok(done > half, "opacity keeps rising");
    world.advance(100);
    assert.equal(Number(style(".check").opacity), 1);
  } finally {
    world.restore();
  }
});

test("checkAt restores a finished check without restarting the fade", () => {
  const world = new ShimWorld();
  try {
    world.now = 5000;
    const { overlay } = installAt(world, baseState({ phase: "checking", checkAt: 4000 }));
    assert.equal(hidden(".check"), false);
    assert.equal(Number(style(".check").opacity), 1);
    overlay.update({ phase: "waiting", checkAt: null });
    assert.equal(hidden(".check"), true);
  } finally {
    world.restore();
  }
});

// ---------------------------------------------------------------------------
// Result label
// ---------------------------------------------------------------------------
test("result label shows name === expected above the result frame", () => {
  const world = new ShimWorld();
  try {
    const result = {
      rect: { x: 300, y: 400, width: 200, height: 30 },
      name: "Total",
      expected: "¥3,300",
    };
    const { layout } = installAt(
      world,
      baseState({
        phase: "result",
        target: null,
        result,
        taskAnchor: { x: 100, y: 200, width: 400, height: 66 },
      }),
    );
    assert.equal(text(".result-text"), "Total === ¥3,300");
    const placed = layout.placements["result-label"];
    assert.equal(placed.x, 300 - 2 + 8);
    assert.equal(placed.y, 400 - 2 - 8 - placed.height);
    assert.equal(placed.height, 16 + 20);
    assert.equal(layout.constraints.length, 0);
  } finally {
    world.restore();
  }
});

test("result label avoids the task label by moving below", () => {
  const world = new ShimWorld();
  try {
    const rect = { x: 300, y: 400, width: 200, height: 30 };
    const { layout } = installAt(
      world,
      baseState({
        phase: "result",
        target: null,
        result: { rect, name: "Total", expected: "¥3,300" },
        taskAnchor: rect,
      }),
    );
    assert.equal(layout.placements["result-label"].y, 400 + 30 + 2 + 8);
  } finally {
    world.restore();
  }
});

// ---------------------------------------------------------------------------
// Docks: input band and key display
// ---------------------------------------------------------------------------
test("input band sits at the bottom centre with 200/1200/250 timing", () => {
  const world = new ShimWorld();
  try {
    world.now = 10_000;
    const { overlay, layout } = installAt(
      world,
      baseState({ phase: "acting", target: null, input: { text: "Buy milk", at: world.now } }),
    );
    const placed = layout.placements.input;
    assert.equal(placed.width, 360);
    assert.equal(placed.height, 56);
    assert.equal(placed.x, (1280 - 360) / 2);
    assert.equal(placed.y, 64 + 720 - 24 - 56);
    assert.equal(text(".input-text"), "Buy milk");
    assert.equal(layout.constraints.length, 0);
    world.advance(1300);
    assert.equal(hidden(".input"), false, "still holding 1300ms after the last update");
    world.advance(200);
    assert.ok(
      [...world.animations].some((animation) => animation.startTime === 10_000 + 200 + 1200),
      "exit animation starts at max(enterEnd, lastAt) + 1200",
    );
    assert.equal(hidden(".input"), false, "inside the 250ms exit");
    world.advance(200);
    assert.equal(hidden(".input"), true, "removed after the exit");
    assert.equal(overlay.inspect().placements.input, undefined);
  } finally {
    world.restore();
  }
});

test("typing extends the hold from the first appearance without restarting the enter", () => {
  const world = new ShimWorld();
  try {
    world.now = 5000;
    installAt(
      world,
      baseState({ phase: "acting", target: null, input: { text: "Buy", at: 5000 } }),
    );
    const enter = [...world.animations].at(-1);
    assert.ok(enter, "enter animation recorded");
    assert.equal(enter.duration, 200);
    world.advance(300);
    overlayHandle().update({ input: { text: "Buy milk", at: world.now } });
    assert.equal(text(".input-text"), "Buy milk");
    assert.equal(hidden(".input"), false);
    world.advance(1000);
    assert.equal(hidden(".input"), false, "hold runs from the latest update");
    world.advance(100);
    assert.equal(hidden(".input"), false, "still holding");
    world.advance(200);
    assert.equal(hidden(".input"), false, "inside the 250ms exit");
    world.advance(200);
    assert.equal(hidden(".input"), true, "exit completed");
  } finally {
    world.restore();
  }
});

test("hold keeps a dock visible and reduced motion drops the scale", () => {
  const world = new ShimWorld({ reducedMotion: true });
  try {
    world.now = 1000;
    installAt(
      world,
      baseState({
        reducedMotion: true,
        phase: "acting",
        target: null,
        input: { text: "Sample", at: world.now, hold: true },
      }),
    );
    const enter = [...world.animations].at(-1);
    assert.ok(enter, "enter animation recorded");
    assert.deepEqual(
      enter.keyframes.map((frame) => frame.transform),
      ["scale(1)", "scale(1)"],
    );
    world.advance(5000);
    assert.equal(hidden(".input"), false);
  } finally {
    world.restore();
  }
});

test("key display is centred, widens for long names and notes API substitution", () => {
  const world = new ShimWorld();
  try {
    world.now = 1000;
    const { layout } = installAt(
      world,
      baseState({
        phase: "acting",
        target: null,
        key: { name: "Enter", at: world.now, hold: true },
      }),
    );
    const placed = layout.placements.key;
    assert.equal(placed.width, 120);
    assert.equal(placed.height, 56);
    assert.equal(placed.x, (1280 - 120) / 2);
    assert.equal(placed.y, 64 + (720 - 56) / 2);
    overlayHandle().update({
      key: { name: "Ctrl+Shift+Backspace", at: world.now, api: true, hold: true },
    });
    assert.equal(hidden(".api-note"), false);
    assert.equal(text(".api-note"), "操作案内");
    const widened = overlayHandle().inspect().placements.key;
    assert.ok(widened.width > 200, `long key name widens the dock, got ${widened.width}`);
    assert.ok(widened.height > 56, "api note raises the dock height");
  } finally {
    world.restore();
  }
});

test("key display skips a protected centre and takes the next candidate", () => {
  const world = new ShimWorld();
  try {
    world.now = 1000;
    const { layout } = installAt(
      world,
      baseState({
        phase: "acting",
        target: { rect: { x: 400, y: 300, width: 480, height: 200 }, name: "Hero", kind: "click" },
        key: { name: "Enter", at: world.now, hold: true },
      }),
    );
    const placed = layout.placements.key;
    const centreY = 64 + (720 - placed.height) / 2;
    assert.notEqual(placed.y, centreY, "centre candidate is protected");
    assert.equal(placed.y, 64 + 720 - 24 - placed.height, "falls through to the bottom centre");
  } finally {
    world.restore();
  }
});

test("backspace deletion reveal is delayed by 160ms", () => {
  const world = new ShimWorld();
  try {
    world.now = 2000;
    installAt(
      world,
      baseState({ phase: "acting", target: null, input: { text: "Buy mil", at: 2000 } }),
    );
    world.advance(50);
    overlayHandle().update({ key: { name: "Backspace", at: world.now, hold: true } });
    world.advance(50);
    overlayHandle().update({ input: { text: "Buy milk", at: world.now } });
    assert.equal(text(".input-text"), "Buy mil");
    world.advance(80);
    assert.equal(text(".input-text"), "Buy milk");
  } finally {
    world.restore();
  }
});

// ---------------------------------------------------------------------------
// Cursor, trail and ripple
// ---------------------------------------------------------------------------
test("pointer moves leave a trail and clicks leave a ripple", () => {
  const world = new ShimWorld();
  try {
    world.now = 3000;
    const { overlay } = installAt(world, baseState({ pointer: null }));
    overlay.update({ pointer: { x: 150, y: 120, at: world.now } });
    assert.equal(currentShadow.querySelectorAll(".cursor").length, 2, "main cursor plus one trail");
    overlay.update({ pointer: { x: 150, y: 120, at: world.now, click: true } });
    assert.equal(currentShadow.querySelectorAll(".ripple").length, 1);
    world.advance(500);
    assert.equal(currentShadow.querySelectorAll(".ripple").length, 0, "ripple dies after 450ms");
    assert.equal(currentShadow.querySelectorAll(".cursor").length, 1, "trail dies after 200ms");
  } finally {
    world.restore();
  }
});

test("reduced motion drops the trail and keeps the ripple small", () => {
  const world = new ShimWorld({ reducedMotion: true });
  try {
    world.now = 3000;
    const { overlay } = installAt(world, baseState({ reducedMotion: true, pointer: null }));
    overlay.update({ pointer: { x: 150, y: 120, at: world.now } });
    overlay.update({ pointer: { x: 150, y: 120, at: world.now, click: true } });
    assert.equal(
      currentShadow.querySelectorAll(".cursor").length,
      1,
      "no trail under reduced motion",
    );
    const ripple = currentShadow.querySelector(".ripple");
    assert.ok(ripple instanceof ShimElement);
    assert.equal(ripple.style.getPropertyValue("--ripple-scale"), String(24 / 48));
  } finally {
    world.restore();
  }
});

// ---------------------------------------------------------------------------
// Layers, theme and title diagnostics
// ---------------------------------------------------------------------------
test("layer title renders only the title band", () => {
  const world = new ShimWorld();
  try {
    const { layout } = installAt(world, baseState({ layer: "title" }));
    assert.equal(hidden(".title"), false);
    assert.equal(hidden(".frames"), true);
    assert.equal(hidden(".task-label"), true);
    assert.equal(layout.placements["task-label"], undefined);
    assert.ok(layout.requiredTitleHeight >= 64);
  } finally {
    world.restore();
  }
});

test("layer page skips the title band and its constraints", () => {
  const world = new ShimWorld();
  try {
    const { layout } = installAt(world, baseState({ layer: "page" }));
    assert.equal(hidden(".title"), true);
    assert.equal(layout.requiredTitleHeight, 0);
    assert.equal(layout.constraints.length, 0);
    assert.equal(hidden(".task-label"), false);
  } finally {
    world.restore();
  }
});

test("long titles require a taller title area and narrow pages stack the progress", () => {
  const world = new ShimWorld();
  try {
    const long =
      "チェックアウトの最終確認 — 配送先と支払いと合計金額を確認する長いタイトルの例".repeat(2);
    const wide = installAt(world, baseState({ title: long }));
    assert.ok(wide.layout.requiredTitleHeight > 64);
    assert.ok(wide.layout.constraints.some((entry) => entry.element === "title"));
    const narrow = installAt(
      world,
      baseState({
        title: "Confirm",
        pageArea: { x: 0, y: 64, width: 600, height: 720 },
        titleArea: { x: 0, y: 0, width: 600, height: 64 },
      }),
    );
    const title = currentShadow.querySelector(".title");
    assert.ok(title instanceof ShimElement && title.classList.contains("stacked"));
    assert.ok(
      narrow.layout.requiredTitleHeight > 64,
      "stacked progress raises the required height",
    );
    assert.ok(narrow.layout.constraints.some((entry) => entry.element === "title"));
  } finally {
    world.restore();
  }
});

test("theme is the observed site theme and theme-only updates keep geometry", () => {
  const world = new ShimWorld();
  try {
    const { overlay, layout } = installAt(world, baseState({ theme: "dark" }));
    const root = currentShadow.querySelector(".overlay");
    assert.ok(root instanceof ShimElement);
    assert.equal(root.dataset.theme, "dark");
    overlay.update({ theme: "light" });
    assert.equal(root.dataset.theme, "light");
    assert.deepEqual(overlay.inspect().placements, layout.placements);
  } finally {
    world.restore();
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
test("painted resolves after two frames and dispose rejects pending paints", async () => {
  const world = new ShimWorld();
  try {
    world.now = 50;
    const { overlay } = installAt(world, baseState());
    const pending = overlay.painted();
    world.advance(16);
    world.advance(16);
    world.advance(200);
    const layout = await pending;
    assert.ok(layout.at > 0);
    const later = overlay.painted();
    world.advance(16);
    overlay.dispose();
    await assert.rejects(later, () => true);
  } finally {
    world.restore();
  }
});

test("setVisible hides the host without disposing and reports layouts", async () => {
  const world = new ShimWorld();
  try {
    const { overlay } = installAt(world, baseState());
    const hiding = overlay.setVisible(false);
    world.advance(400);
    await hiding;
    const showing = overlay.setVisible(true);
    world.advance(400);
    await showing;
    assert.equal(hidden(".task-label"), false);
    assert.equal(overlay.inspect().constraints.length, 0);
  } finally {
    world.restore();
  }
});

test("full scenario walks phases, read progress and the completion state", () => {
  const world = new ShimWorld();
  try {
    const { overlay } = installAt(world, baseState());
    world.advance(1800);
    overlay.update({ phase: "acting" });
    world.advance(400);
    overlay.update({ phase: "checking" });
    world.advance(1200);
    overlay.update({
      phase: "result",
      target: null,
      result: { rect: { x: 100, y: 200, width: 400, height: 66 }, name: "Name", expected: "ok" },
    });
    assert.equal(text(".chip"), "1");
    world.advance(3000);
    overlay.update({ read: 1, result: null });
    world.advance(600);
    overlay.update({ current: 2, phase: "waiting", result: null, checkAt: null });
    assert.equal(text(".chip"), "2");
    assert.equal(hidden(".check"), true, "check resets on the next step");
    assert.equal(text(".step-count"), "READ 1 / 3");
    overlay.update({ current: 3, phase: "result", target: null, read: 3 });
    assert.equal(text(".step-count"), "COMPLETE 3 / 3");
  } finally {
    world.restore();
  }
});
