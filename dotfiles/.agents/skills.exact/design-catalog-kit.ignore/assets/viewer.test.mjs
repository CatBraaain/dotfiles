import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { buildViewerHtml, generateViewer } from "./build-viewer.mjs";

const catalog = {
  schemaVersion: 1,
  id: "viewer-tests",
  title: "Design choices",
  axes: [
    {
      id: "motion",
      label: "Motion",
      description: "Compare entrances.",
      options: [
        {
          id: "fade",
          label: "Fade",
          description: "Opacity entrance.",
          path: "designs/motion/fade/index.html",
        },
        {
          id: "slide",
          label: "Slide",
          description: "Translation entrance.",
          path: "designs/motion/slide/index.html",
        },
        {
          id: "still",
          label: "Still",
          description: "No entrance.",
          path: "designs/motion/still/index.html",
        },
      ],
    },
    {
      id: "shape",
      label: "Shape",
      description: "Compare geometry.",
      options: [
        {
          id: "round",
          label: "Round",
          description: "Rounded corners.",
          path: "designs/shape/round/index.html",
        },
      ],
    },
  ],
};

// Execute the generated template's actual inline script; this adapter does not simulate CSS or iframe documents.
function executeViewer(t, { manifest = catalog } = {}) {
  const root = mkdtempSync(join(tmpdir(), "design-catalog-viewer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "catalog.json"), JSON.stringify(manifest));
  for (const axis of manifest.axes) {
    for (const option of axis.options) {
      const file = join(root, option.path);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "<!doctype html><title>Option</title><input>");
    }
  }
  const output = generateViewer(root);
  const html = readFileSync(output, "utf8");
  const document = new DocumentAdapter(html);
  const window = {
    addEventListener() {},
  };
  const context = { document, window };
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  runInNewContext(script, context, { filename: output, timeout: 1000 });
  const axes = () => document.getElementById("axes").children;
  const optionsRow = (axisIndex) => axes()[axisIndex].children[1];
  const figures = (axisIndex) => optionsRow(axisIndex).children;
  return {
    html,
    root,
    document,
    node: (id) => document.getElementById(id),
    axes,
    optionsRow,
    figures,
    keydown: (axisIndex, key) => optionsRow(axisIndex).emit("keydown", keyEvent(key)),
  };
}

function keyEvent(key) {
  return {
    key,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

test("default generator injects the real portable template without modifying options", (t) => {
  const viewer = executeViewer(t);
  assert.equal(viewer.html, buildViewerHtml(viewer.root));
  assert.equal(viewer.document.title, catalog.title);
  assert.equal(viewer.node("catalog-title").textContent, catalog.title);
  assert.equal(
    readFileSync(join(viewer.root, catalog.axes[0].options[0].path), "utf8"),
    "<!doctype html><title>Option</title><input>",
  );
  assert.equal(/<script[^>]*\ssrc=/.test(viewer.html), false);
});

test("every axis and option expands in array order into one row per axis", (t) => {
  const viewer = executeViewer(t);
  assert.deepEqual(
    viewer.axes().map((section) => section.tag),
    ["section", "section"],
  );
  const [motion, shape] = viewer.axes();
  assert.equal(motion.getAttribute("aria-labelledby"), "axis-motion");
  assert.equal(shape.getAttribute("aria-labelledby"), "axis-shape");
  const motionHeading = motion.children[0].children[0];
  assert.equal(motionHeading.id, "axis-motion");
  assert.deepEqual(
    motionHeading.children.map((child) => child.textContent),
    ["1", "Motion"],
  );
  assert.equal(motion.children[0].children[1].textContent, "Compare entrances.");
  assert.deepEqual(
    shape.children[0].children[0].children.map((child) => child.textContent),
    ["2", "Shape"],
  );
  const motionFrames = motion.descendants("iframe");
  assert.equal(motionFrames.length, catalog.axes[0].options.length);
  const shapeFrames = shape.descendants("iframe");
  assert.equal(shapeFrames.length, catalog.axes[1].options.length);
  assert.deepEqual(
    [...motionFrames, ...shapeFrames].map((frame) => frame.src),
    [
      "./designs/motion/fade/index.html",
      "./designs/motion/slide/index.html",
      "./designs/motion/still/index.html",
      "./designs/shape/round/index.html",
    ],
  );
  assert.deepEqual(
    [...motionFrames, ...shapeFrames].map((frame) => frame.title),
    ["Motion · Fade", "Motion · Slide", "Motion · Still", "Shape · Round"],
  );
});

test("option key badges run a, b, c in option order within each axis", (t) => {
  const viewer = executeViewer(t);
  const keys = (axisIndex) =>
    viewer
      .figures(axisIndex)
      .map(
        (figure) =>
          figure.descendants("span").find((span) => span.className === "option-key").textContent,
      );
  assert.deepEqual(keys(0), ["a", "b", "c"]);
  assert.deepEqual(keys(1), ["a"]);
});

test("option key badges continue with aa after z", (t) => {
  const manifest = structuredClone(catalog);
  const axis = manifest.axes[0];
  axis.options = Array.from({ length: 27 }, (_, index) => ({
    ...axis.options[0],
    id: `option-${index + 1}`,
    label: `Option ${index + 1}`,
    path: `designs/motion/option-${index + 1}/index.html`,
  }));
  const viewer = executeViewer(t, { manifest });
  const keys = viewer
    .figures(0)
    .map(
      (figure) =>
        figure.descendants("span").find((span) => span.className === "option-key").textContent,
    );
  assert.equal(keys.length, 27);
  assert.equal(keys[0], "a");
  assert.equal(keys[25], "z");
  assert.deepEqual(keys.slice(25), ["z", "aa"]);
});

test("caption above the shell carries key, label, description and replay", (t) => {
  const viewer = executeViewer(t);
  const figure = viewer.figures(0)[1];
  const [caption, shell] = figure.children;
  assert.equal(caption.tag, "figcaption");
  assert.equal(shell.className, "preview-shell");
  assert.equal(caption.descendants("iframe").length, 0);
  const [labelRow, description] = caption.children;
  const [optionHeading, replay] = labelRow.children;
  const [key, label] = optionHeading.children;
  assert.equal(key.textContent, "b");
  assert.equal(label.textContent, "Slide");
  assert.equal(description.textContent, "Translation entrance.");
  assert.equal(replay.tag, "button");
  assert.equal(replay.textContent, "Replay");
  assert.equal(replay.getAttribute("aria-label"), "Replay Motion · Slide");
});

test("each option replay recreates only that option's iframe", (t) => {
  const viewer = executeViewer(t);
  const motionFigures = viewer.figures(0);
  const shapeFigure = viewer.figures(1)[0];
  const before = [...motionFigures.map((figure) => frameOf(figure)), frameOf(shapeFigure)];
  const replay = motionFigures[1].descendants("button")[0];
  replay.click();
  const after = [...motionFigures.map((figure) => frameOf(figure)), frameOf(shapeFigure)];
  assert.notEqual(after[1], before[1]);
  assert.equal(before[1].parent, null);
  assert.equal(after[1].src, before[1].src);
  assert.equal(after[1].title, before[1].title);
  for (const index of [0, 2, 3]) {
    assert.equal(after[index], before[index]);
  }
});

test("option rows expose group role, axis label and keyboard tabindex", (t) => {
  const viewer = executeViewer(t);
  for (const [axisIndex, label] of [
    [0, "Motion options"],
    [1, "Shape options"],
  ]) {
    const row = viewer.optionsRow(axisIndex);
    assert.equal(row.getAttribute("role"), "group");
    assert.equal(row.getAttribute("aria-label"), label);
    assert.equal(row.getAttribute("tabindex"), "0");
  }
});

test("arrow and home/end keys scroll only the focused option row", (t) => {
  const viewer = executeViewer(t);
  const motionRow = viewer.optionsRow(0);
  const shapeRow = viewer.optionsRow(1);
  const paging = Math.round(motionRow.clientWidth * 0.8);

  const right = viewer.keydown(0, "ArrowRight");
  assert.deepEqual(
    motionRow.scrollByCalls.map((call) => call.left),
    [paging],
  );
  assert.equal(right.defaultPrevented, true);

  viewer.keydown(0, "ArrowLeft");
  assert.deepEqual(
    motionRow.scrollByCalls.map((call) => call.left),
    [paging, -paging],
  );

  viewer.keydown(0, "Home");
  assert.deepEqual(
    motionRow.scrollToCalls.map((call) => call.left),
    [0],
  );

  viewer.keydown(0, "End");
  assert.deepEqual(
    motionRow.scrollToCalls.map((call) => call.left),
    [0, motionRow.scrollWidth],
  );

  const plainKey = viewer.keydown(0, "a");
  assert.equal(plainKey.defaultPrevented, false);
  assert.equal(motionRow.scrollByCalls.length, 2);
  assert.equal(motionRow.scrollToCalls.length, 2);

  assert.equal(shapeRow.scrollByCalls.length, 0);
  assert.equal(shapeRow.scrollToCalls.length, 0);
});

test("all manifest text follows text-only DOM paths, including hostile labels and descriptions", (t) => {
  const manifest = structuredClone(catalog);
  const hostile = '</script><img src=x onerror="throw 1"> $& <b>Text</b>';
  manifest.title = hostile;
  manifest.axes[0].label = hostile;
  manifest.axes[0].description = hostile;
  manifest.axes[0].options[0].label = hostile;
  manifest.axes[0].options[0].description = hostile;
  const viewer = executeViewer(t, { manifest });
  assert.equal(viewer.document.title, hostile);
  assert.equal(viewer.node("catalog-title").textContent, hostile);
  assert.equal(viewer.axes()[0].children[0].children[0].children[1].textContent, hostile);
  assert.equal(viewer.axes()[0].children[0].children[1].textContent, hostile);
  const figure = viewer.figures(0)[0];
  assert.equal(
    figure.descendants("span").find((span) => span.className === "option-label").textContent,
    hostile,
  );
  assert.equal(figure.descendants("p")[0].textContent, hostile);
  assert.equal(viewer.document.descendants("img").length, 0);
});

test("encoded generator paths pass straight to iframe.src without double encoding", (t) => {
  const manifest = structuredClone(catalog);
  manifest.axes[0].options[0].path = "designs/日本語 space#?%.html";
  const viewer = executeViewer(t, { manifest });
  assert.equal(
    frameOf(viewer.figures(0)[0]).src,
    "./designs/%E6%97%A5%E6%9C%AC%E8%AA%9E%20space%23%3F%25.html",
  );
});

function frameOf(figure) {
  return figure.descendants("iframe")[0];
}

class DocumentAdapter {
  constructor(html) {
    this.body = new ElementAdapter("body", this);
    for (const match of html.matchAll(/<(\w+)\b([^>]*)\bid="([^"]+)"([^>]*)>/g)) {
      const node = this.createElement(match[1]);
      node.id = match[3];
      for (const attr of `${match[2]} ${match[4]}`.matchAll(/([\w-]+)="([^"]*)"/g))
        node.setAttribute(attr[1], attr[2]);
      this.body.append(node);
    }
    this.getElementById("catalog-data").textContent = html.match(
      /<script id="catalog-data"[^>]*>([\s\S]*?)<\/script>/,
    )[1];
  }
  createElement(tag) {
    return new ElementAdapter(tag, this);
  }
  getElementById(id) {
    return this.body.descendants().find((node) => node.id === id);
  }
  descendants(tag) {
    return this.body.descendants(tag);
  }
}

class ElementAdapter {
  constructor(tag, document) {
    this.tag = tag;
    this.document = document;
    this.children = [];
    this.parent = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.disabled = false;
    this.clientWidth = 500;
    this.scrollWidth = 1200;
    this.scrollByCalls = [];
    this.scrollToCalls = [];
    this.classList = { toggle() {} };
  }
  set innerHTML(_html) {
    throw new Error("Unexpected HTML insertion");
  }
  set textContent(text) {
    this.replaceChildren();
    this.text = text;
  }
  get textContent() {
    return this.children.length
      ? this.children.map((node) => node.textContent).join("")
      : (this.text ?? "");
  }
  set tabIndex(value) {
    this.setAttribute("tabindex", String(value));
  }
  get tabIndex() {
    return Number(this.getAttribute("tabindex") ?? "-1");
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }
  emit(name, event) {
    this.listeners.get(name)?.(event);
    return event;
  }
  click() {
    if (this.disabled) return;
    this.emit("click");
  }
  scrollBy(delta) {
    this.scrollByCalls.push(delta);
  }
  scrollTo(position) {
    this.scrollToCalls.push(position);
  }
  descendants(tag) {
    return this.children.flatMap((child) => [
      ...(!tag || child.tag === tag ? [child] : []),
      ...child.descendants(tag),
    ]);
  }
}
