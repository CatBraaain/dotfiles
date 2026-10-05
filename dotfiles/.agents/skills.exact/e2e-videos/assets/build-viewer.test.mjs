import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { buildViewerHtml, main } from "./build-viewer.mjs";

const DATA_MARKER = '<script type="application/json" id="e2e-viewer-data">';

function tempRecordings() {
  const dir = mkdtempSync(join(tmpdir(), "viewer-build-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeMetadata(recordingsDir, meta) {
  writeFileSync(join(recordingsDir, "metadata.json"), JSON.stringify(meta));
}

function writeVideo(recordingsDir, name) {
  writeFileSync(join(recordingsDir, name), "");
}

function extractData(html) {
  const start = html.indexOf(DATA_MARKER);
  assert.ok(start >= 0, "data script exists");
  const openEnd = html.indexOf(">", start) + 1;
  const close = html.indexOf("</script>", openEnd);
  return JSON.parse(html.slice(openEnd, close).trim());
}

test("builds the viewer data from metadata.json", () => {
  const recordings = tempRecordings();
  try {
    writeVideo(recordings.dir, "01-type-delivery-name.mp4");
    writeVideo(recordings.dir, "02-click-confirm.mp4");
    writeMetadata(recordings.dir, {
      title: "Checkout flow",
      steps: [
        {
          action: "Type the delivery name",
          expected: "Name is preserved",
          video: "01-type-delivery-name.mp4",
        },
        {
          action: "Click Confirm",
          expected: "Total === ¥3,300",
          video: "02-click-confirm.mp4",
        },
      ],
    });
    const data = extractData(buildViewerHtml(recordings.dir));
    assert.deepEqual(data, {
      title: "Checkout flow",
      steps: [
        {
          number: 1,
          action: "Type the delivery name",
          expected: "Name is preserved",
          video: "01-type-delivery-name.mp4",
        },
        {
          number: 2,
          action: "Click Confirm",
          expected: "Total === ¥3,300",
          video: "02-click-confirm.mp4",
        },
      ],
    });
  } finally {
    recordings.dispose();
  }
});

test("resolves video paths inside subfolders", () => {
  const recordings = tempRecordings();
  try {
    mkdirSync(join(recordings.dir, "videos"));
    writeVideo(join(recordings.dir, "videos"), "step.mp4");
    writeMetadata(recordings.dir, {
      title: "t",
      steps: [{ action: "a", expected: "e", video: "videos/step.mp4" }],
    });
    const data = extractData(buildViewerHtml(recordings.dir));
    assert.deepEqual(
      data.steps.map((step) => step.video),
      ["videos/step.mp4"],
    );
  } finally {
    recordings.dispose();
  }
});

test("rejects missing or empty title and steps", () => {
  const recordings = tempRecordings();
  try {
    writeMetadata(recordings.dir, {
      steps: [{ action: "a", expected: "e", video: "x.mp4" }],
    });
    assert.throws(
      () => buildViewerHtml(recordings.dir),
      /"title" must be a non-empty string/,
    );
    writeMetadata(recordings.dir, { title: "t" });
    assert.throws(
      () => buildViewerHtml(recordings.dir),
      /"steps" must be a non-empty array/,
    );
  } finally {
    recordings.dispose();
  }
});

test("rejects a step missing action or expected", () => {
  const recordings = tempRecordings();
  try {
    writeVideo(recordings.dir, "v.mp4");
    writeMetadata(recordings.dir, {
      title: "t",
      steps: [{ expected: "e", video: "v.mp4" }],
    });
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
    writeVideo(recordings.dir, "v.mp4");
    writeMetadata(recordings.dir, {
      title: "t",
      steps: [{ action: "a", expected: "e", video: "/tmp/v.mp4" }],
    });
    assert.throws(
      () => buildViewerHtml(recordings.dir),
      /must be a relative path inside the recordings folder/,
    );
    writeMetadata(recordings.dir, {
      title: "t",
      steps: [{ action: "a", expected: "e", video: "../outside.mp4" }],
    });
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
    writeMetadata(recordings.dir, {
      title: "t",
      steps: [{ action: "a", expected: "e", video: "missing.mp4" }],
    });
    assert.throws(
      () => buildViewerHtml(recordings.dir),
      /video "missing\.mp4" does not exist/,
    );
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
    assert.throws(
      () => buildViewerHtml(recordings.dir),
      /expected a JSON object/,
    );
  } finally {
    recordings.dispose();
  }
});

test("escapes </script> inside the embedded JSON", () => {
  const recordings = tempRecordings();
  try {
    writeVideo(recordings.dir, "v.mp4");
    writeMetadata(recordings.dir, {
      title: "</script><b>injected</b>",
      steps: [{ action: "a", expected: "e", video: "v.mp4" }],
    });
    const data = extractData(buildViewerHtml(recordings.dir));
    assert.equal(data.title, "</script><b>injected</b>");
  } finally {
    recordings.dispose();
  }
});

test("main writes index.html and reports failures via exit code", () => {
  const recordings = tempRecordings();
  try {
    writeVideo(recordings.dir, "v.mp4");
    writeMetadata(recordings.dir, {
      title: "t",
      steps: [{ action: "a", expected: "e", video: "v.mp4" }],
    });
    const argv = ["node", "build-viewer.mjs"];
    assert.equal(main([...argv, recordings.dir]), 0);
    const html = readFileSync(join(recordings.dir, "index.html"), "utf8");
    assert.ok(html.includes(DATA_MARKER));
    assert.equal(main([...argv, join(recordings.dir, "missing")]), 1);
    assert.equal(main(["node"]), 1);
  } finally {
    recordings.dispose();
  }
});
