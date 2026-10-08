import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { buildViewerHtml, main } from "./build-viewer.mjs";

const DATA_MARKER = '<script type="application/json" id="e2e-viewer-data">';

function tempRecordings() {
  const dir = mkdtempSync(join(tmpdir(), "viewer-build-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeSet(recordings, meta, mediaNames = []) {
  for (const name of mediaNames) {
    mkdirSync(join(recordings.dir, name, ".."), { recursive: true });
    writeFileSync(join(recordings.dir, name), "");
  }
  writeFileSync(join(recordings.dir, "metadata.json"), JSON.stringify(meta));
}

function extractData(html) {
  const start = html.indexOf(DATA_MARKER);
  assert.ok(start >= 0, "data script exists");
  const openEnd = html.indexOf(">", start) + 1;
  const close = html.indexOf("</script>", openEnd);
  return JSON.parse(html.slice(openEnd, close).trim());
}

test("embeds flows in array order with per-flow step numbers", () => {
  const recordings = tempRecordings();
  try {
    writeSet(recordings, {
      title: "Checkout review",
      flows: [
        {
          id: "search",
          title: "Search flow",
          steps: [
            { action: "Open the page", expected: "the form is visible", image: "search/01-open.png" },
            { action: "Type a query", video: "search/02-type.mp4" },
          ],
        },
        {
          id: "checkout",
          title: "Checkout flow",
          steps: [{ action: "Add item to cart", expected: "the cart badge shows 1", video: "checkout/add.mp4" }],
        },
      ],
    }, ["search/01-open.png", "search/02-type.mp4", "checkout/add.mp4"]);
    const data = extractData(buildViewerHtml(recordings.dir));
    assert.deepEqual(data, {
      title: "Checkout review",
      flows: [
        {
          id: "search",
          title: "Search flow",
          steps: [
            { number: 1, action: "Open the page", expected: "the form is visible", image: "search/01-open.png" },
            { number: 2, action: "Type a query", video: "search/02-type.mp4" },
          ],
        },
        {
          id: "checkout",
          title: "Checkout flow",
          steps: [{ number: 1, action: "Add item to cart", expected: "the cart badge shows 1", video: "checkout/add.mp4" }],
        },
      ],
    });
  } finally {
    recordings.dispose();
  }
});

test("accepts images and videos mixed within one flow", () => {
  const recordings = tempRecordings();
  try {
    writeSet(recordings, {
      title: "t",
      flows: [
        {
          id: "grid",
          title: "Grid",
          steps: [
            { action: "Open", image: "grid/a.png" },
            { action: "Animate", video: "grid/b.mp4" },
            { action: "Sort", image: "grid/c.png" },
          ],
        },
      ],
    }, ["grid/a.png", "grid/b.mp4", "grid/c.png"]);
    const data = extractData(buildViewerHtml(recordings.dir));
    const mediaKinds = data.flows[0].steps.map((step) => ("video" in step ? "video" : "image"));
    assert.deepEqual(mediaKinds, ["image", "video", "image"]);
  } finally {
    recordings.dispose();
  }
});

test("rejects a recordings folder without metadata.json", () => {
  const recordings = tempRecordings();
  try {
    assert.throws(() => buildViewerHtml(recordings.dir), /metadata\.json not found/);
  } finally {
    recordings.dispose();
  }
});

test("rejects invalid or non-object metadata.json", () => {
  const recordings = tempRecordings();
  try {
    writeFileSync(join(recordings.dir, "metadata.json"), "{ nope");
    assert.throws(() => buildViewerHtml(recordings.dir), /invalid JSON/);
    writeFileSync(join(recordings.dir, "metadata.json"), '"text"');
    assert.throws(() => buildViewerHtml(recordings.dir), /expected a JSON object/);
  } finally {
    recordings.dispose();
  }
});

test("rejects missing or empty title and flows", () => {
  const recordings = tempRecordings();
  try {
    writeSet(recordings, { flows: [] });
    assert.throws(() => buildViewerHtml(recordings.dir), /"title" must be a non-empty string/);
    writeSet(recordings, { title: "t" });
    assert.throws(() => buildViewerHtml(recordings.dir), /"flows" must be a non-empty array/);
  } finally {
    recordings.dispose();
  }
});

test("rejects a flow missing id or title, or duplicating an id", () => {
  const recordings = tempRecordings();
  try {
    writeSet(recordings, { title: "t", flows: [{ title: "Flow", steps: [{ action: "a", image: "a.png" }] }] }, ["a.png"]);
    assert.throws(() => buildViewerHtml(recordings.dir), /flow 1 "id" must be a non-empty string/);
    writeSet(recordings, { title: "t", flows: [{ id: "x", steps: [{ action: "a", image: "a.png" }] }] }, ["a.png"]);
    assert.throws(() => buildViewerHtml(recordings.dir), /flow 1 "title" must be a non-empty string/);
    writeSet(recordings, {
      title: "t",
      flows: [
        { id: "x", title: "First", steps: [{ action: "a", image: "a.png" }] },
        { id: "x", title: "Second", steps: [{ action: "b", image: "b.png" }] },
      ],
    }, ["a.png", "b.png"]);
    assert.throws(() => buildViewerHtml(recordings.dir), /flow id "x" is duplicated/);
  } finally {
    recordings.dispose();
  }
});

test("rejects a flow missing steps", () => {
  const recordings = tempRecordings();
  try {
    writeSet(recordings, { title: "t", flows: [{ id: "x", title: "Flow" }] });
    assert.throws(() => buildViewerHtml(recordings.dir), /flow 1 "steps" must be a non-empty array/);
  } finally {
    recordings.dispose();
  }
});

test("rejects a step missing action", () => {
  const recordings = tempRecordings();
  try {
    writeSet(recordings, {
      title: "t",
      flows: [{ id: "grid", title: "Grid", steps: [{ image: "a.png" }] }],
    }, ["a.png"]);
    assert.throws(
      () => buildViewerHtml(recordings.dir),
      /flow "grid" step 1 "action" must be a non-empty string/,
    );
  } finally {
    recordings.dispose();
  }
});

test("rejects a step having both or neither of video and image", () => {
  const recordings = tempRecordings();
  try {
    writeSet(recordings, {
      title: "t",
      flows: [{ id: "grid", title: "Grid", steps: [{ action: "a", video: "v.mp4", image: "v.png" }] }],
    }, ["v.mp4", "v.png"]);
    assert.throws(
      () => buildViewerHtml(recordings.dir),
      /flow "grid" step 1 must hold exactly one of "video" or "image"/,
    );
    writeSet(recordings, {
      title: "t",
      flows: [{ id: "grid", title: "Grid", steps: [{ action: "a" }] }],
    });
    assert.throws(
      () => buildViewerHtml(recordings.dir),
      /flow "grid" step 1 must hold exactly one of "video" or "image"/,
    );
  } finally {
    recordings.dispose();
  }
});

test("rejects an empty expected when present", () => {
  const recordings = tempRecordings();
  try {
    writeSet(recordings, {
      title: "t",
      flows: [{ id: "grid", title: "Grid", steps: [{ action: "a", expected: "  ", image: "a.png" }] }],
    }, ["a.png"]);
    assert.throws(
      () => buildViewerHtml(recordings.dir),
      /flow "grid" step 1 "expected" must be a non-empty string when present/,
    );
  } finally {
    recordings.dispose();
  }
});

test("rejects invalid or missing media paths", () => {
  const recordings = tempRecordings();
  try {
    writeSet(recordings, {
      title: "t",
      flows: [{ id: "grid", title: "Grid", steps: [{ action: "a", image: "/tmp/a.png" }] }],
    });
    assert.throws(
      () => buildViewerHtml(recordings.dir),
      /flow "grid" step 1 "image" must be a relative path inside the recordings folder/,
    );
    writeSet(recordings, {
      title: "t",
      flows: [{ id: "grid", title: "Grid", steps: [{ action: "a", video: "grid/../outside.mp4" }] }],
    });
    assert.throws(
      () => buildViewerHtml(recordings.dir),
      /flow "grid" step 1 "video" must be a relative path inside the recordings folder/,
    );
    writeSet(recordings, {
      title: "t",
      flows: [{ id: "grid", title: "Grid", steps: [{ action: "a", video: "grid\\..\\outside.mp4" }] }],
    });
    assert.throws(
      () => buildViewerHtml(recordings.dir),
      /flow "grid" step 1 "video" must be a relative path inside the recordings folder/,
    );
    writeSet(recordings, {
      title: "t",
      flows: [{ id: "grid", title: "Grid", steps: [{ action: "a", image: "grid/missing.png" }] }],
    });
    assert.throws(
      () => buildViewerHtml(recordings.dir),
      /flow "grid" step 1 image "grid\/missing\.png" does not exist/,
    );
  } finally {
    recordings.dispose();
  }
});

test("escapes </script> inside the embedded JSON", () => {
  const recordings = tempRecordings();
  try {
    writeSet(recordings, {
      title: "</script><b>injected</b>",
      flows: [{ id: "grid", title: "Grid", steps: [{ action: "a", expected: "</script>", image: "a.png" }] }],
    }, ["a.png"]);
    const data = extractData(buildViewerHtml(recordings.dir));
    assert.equal(data.title, "</script><b>injected</b>");
    assert.equal(data.flows[0].steps[0].expected, "</script>");
  } finally {
    recordings.dispose();
  }
});

test("main writes index.html and reports failures via exit code", () => {
  const recordings = tempRecordings();
  try {
    writeSet(recordings, {
      title: "t",
      flows: [{ id: "grid", title: "Grid", steps: [{ action: "a", image: "a.png" }] }],
    }, ["a.png"]);
    const argv = ["node", "build-viewer.mjs"];
    assert.equal(main([...argv, recordings.dir]), 0);
    const html = readFileSync(join(recordings.dir, "index.html"), "utf8");
    assert.ok(html.includes(DATA_MARKER));
    assert.equal(main([...argv, join(recordings.dir, "missing")]), 1);
    assert.equal(main(["node"]), 1);
    writeFileSync(join(recordings.dir, "metadata.json"), JSON.stringify({ title: "t", flows: [{}] }));
    assert.equal(main([...argv, recordings.dir]), 1);
  } finally {
    recordings.dispose();
  }
});
