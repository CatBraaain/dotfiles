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

function writeFlow(recordings, flowId, meta, videoNames = []) {
  const flowDir = join(recordings.dir, flowId);
  mkdirSync(flowDir, { recursive: true });
  for (const name of videoNames) {
    mkdirSync(join(flowDir, name, ".."), { recursive: true });
    writeFileSync(join(flowDir, name), "");
  }
  writeFileSync(join(flowDir, "metadata.json"), JSON.stringify(meta));
}

function writeFlowFolder(recordings, flowId) {
  mkdirSync(join(recordings.dir, flowId), { recursive: true });
}

function extractData(html) {
  const start = html.indexOf(DATA_MARKER);
  assert.ok(start >= 0, "data script exists");
  const openEnd = html.indexOf(">", start) + 1;
  const close = html.indexOf("</script>", openEnd);
  return JSON.parse(html.slice(openEnd, close).trim());
}

test("merges flow folders ordered by folder name", () => {
  const recordings = tempRecordings();
  try {
    writeFlow(recordings, "search", {
      title: "Search flow",
      steps: [
        { action: "Open the page", video: "01-open.mp4" },
        { action: "Type a query", video: "02-type.mp4" },
      ],
    }, ["01-open.mp4", "02-type.mp4"]);
    writeFlow(recordings, "checkout", {
      title: "Checkout flow",
      steps: [{ action: "Add item to cart", video: "add-to-cart.mp4" }],
    }, ["add-to-cart.mp4"]);
    const data = extractData(buildViewerHtml(recordings.dir));
    assert.deepEqual(data, {
      flows: [
        {
          id: "checkout",
          title: "Checkout flow",
          steps: [{ number: 1, action: "Add item to cart", video: "checkout/add-to-cart.mp4" }],
        },
        {
          id: "search",
          title: "Search flow",
          steps: [
            { number: 1, action: "Open the page", video: "search/01-open.mp4" },
            { number: 2, action: "Type a query", video: "search/02-type.mp4" },
          ],
        },
      ],
    });
  } finally {
    recordings.dispose();
  }
});

test("resolves a video path inside a flow subfolder", () => {
  const recordings = tempRecordings();
  try {
    writeFlow(recordings, "search", {
      title: "t",
      steps: [{ action: "a", video: "videos/step.mp4" }],
    }, ["videos/step.mp4"]);
    const data = extractData(buildViewerHtml(recordings.dir));
    assert.deepEqual(
      data.flows[0].steps.map((step) => step.video),
      ["search/videos/step.mp4"],
    );
  } finally {
    recordings.dispose();
  }
});

test("rejects a recordings folder without flow folders", () => {
  const recordings = tempRecordings();
  try {
    assert.throws(() => buildViewerHtml(recordings.dir), /no flow folders with metadata\.json/);
  } finally {
    recordings.dispose();
  }
});

test("rejects a flow folder without metadata.json", () => {
  const recordings = tempRecordings();
  try {
    writeFlowFolder(recordings, "broken");
    assert.throws(() => buildViewerHtml(recordings.dir), /metadata\.json not found/);
  } finally {
    recordings.dispose();
  }
});

test("rejects missing or empty title and steps", () => {
  const recordings = tempRecordings();
  try {
    writeFlow(recordings, "search", { steps: [{ action: "a", video: "x.mp4" }] });
    assert.throws(() => buildViewerHtml(recordings.dir), /"title" must be a non-empty string/);
    writeFlow(recordings, "search", { title: "t" });
    assert.throws(() => buildViewerHtml(recordings.dir), /"steps" must be a non-empty array/);
  } finally {
    recordings.dispose();
  }
});

test("rejects a step missing action", () => {
  const recordings = tempRecordings();
  try {
    writeFlow(recordings, "search", { title: "t", steps: [{ video: "v.mp4" }] }, ["v.mp4"]);
    assert.throws(
      () => buildViewerHtml(recordings.dir),
      /step 1 "action" must be a non-empty string/,
    );
  } finally {
    recordings.dispose();
  }
});

test("rejects an absolute or parent video path", () => {
  const recordings = tempRecordings();
  try {
    writeFlow(recordings, "search", { title: "t", steps: [{ action: "a", video: "/tmp/v.mp4" }] });
    assert.throws(
      () => buildViewerHtml(recordings.dir),
      /must be a relative path inside the recordings folder/,
    );
    writeFlow(recordings, "search", { title: "t", steps: [{ action: "a", video: "../outside.mp4" }] });
    assert.throws(
      () => buildViewerHtml(recordings.dir),
      /must be a relative path inside the recordings folder/,
    );
  } finally {
    recordings.dispose();
  }
});

test("rejects a video that does not exist", () => {
  const recordings = tempRecordings();
  try {
    writeFlow(recordings, "search", { title: "t", steps: [{ action: "a", video: "missing.mp4" }] });
    assert.throws(() => buildViewerHtml(recordings.dir), /video "missing\.mp4" does not exist/);
  } finally {
    recordings.dispose();
  }
});

test("rejects invalid or non-object metadata.json", () => {
  const recordings = tempRecordings();
  try {
    writeFlowFolder(recordings, "search");
    writeFileSync(join(recordings.dir, "search", "metadata.json"), "{ nope");
    assert.throws(() => buildViewerHtml(recordings.dir), /invalid JSON/);
    writeFileSync(join(recordings.dir, "search", "metadata.json"), '"text"');
    assert.throws(() => buildViewerHtml(recordings.dir), /expected a JSON object/);
  } finally {
    recordings.dispose();
  }
});

test("escapes </script> inside the embedded JSON", () => {
  const recordings = tempRecordings();
  try {
    writeFlow(recordings, "search", {
      title: "</script><b>injected</b>",
      steps: [{ action: "a", video: "v.mp4" }],
    }, ["v.mp4"]);
    const data = extractData(buildViewerHtml(recordings.dir));
    assert.equal(data.flows[0].title, "</script><b>injected</b>");
  } finally {
    recordings.dispose();
  }
});

test("main writes index.html and reports failures via exit code", () => {
  const recordings = tempRecordings();
  try {
    writeFlow(recordings, "search", {
      title: "t",
      steps: [{ action: "a", video: "v.mp4" }],
    }, ["v.mp4"]);
    const argv = ["node", "build-viewer.mjs"];
    assert.equal(main([...argv, recordings.dir]), 0);
    const html = readFileSync(join(recordings.dir, "index.html"), "utf8");
    assert.ok(html.includes(DATA_MARKER));
    assert.equal(main([...argv, join(recordings.dir, "missing")]), 1);
    assert.equal(main(["node"]), 1);
    writeFlow(recordings, "broken", {
      title: "t",
      steps: [{ action: "a", video: "gone.mp4" }],
    });
    assert.equal(main([...argv, recordings.dir]), 1);
  } finally {
    recordings.dispose();
  }
});
