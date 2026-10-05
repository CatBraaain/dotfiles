import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const viewerSource = readFileSync(
  new URL("./viewer.html", import.meta.url),
  "utf8",
);
const skillSource = readFileSync(
  new URL("../SKILL.md", import.meta.url),
  "utf8",
);
const specSource = readFileSync(
  new URL("../SPEC.md", import.meta.url),
  "utf8",
);

const PLACEHOLDER = "__E2E_VIEWER_DATA__";
const REQUIRED_IDS = [
  "e2e-viewer-data",
  "viewer-header",
  "viewer-title",
  "viewer-meta",
  "viewer-main",
  "step-list",
  "video",
  "stage-notice",
  "step-detail",
  "prev",
  "replay",
  "next",
  "viewer-empty",
];

test("template embeds exactly one data placeholder inside the data script", () => {
  const scriptStart = viewerSource.indexOf(
    '<script type="application/json" id="e2e-viewer-data">',
  );
  const scriptEnd = viewerSource.indexOf("</script>", scriptStart);
  assert.ok(
    scriptStart >= 0 && scriptEnd > scriptStart,
    "data script element exists",
  );
  const dataScript = viewerSource.slice(scriptStart, scriptEnd);
  assert.equal(dataScript.split(PLACEHOLDER).length - 1, 1);
  assert.equal(
    viewerSource.split(PLACEHOLDER).length - 1,
    1,
    "placeholder appears nowhere else",
  );
});

test("template has no external references", () => {
  const external = viewerSource.match(
    /(src|href)\s*=\s*["']\s*(https?:)?\/\//i,
  );
  assert.equal(external, null, "no http(s) or protocol-relative src/href");
  assert.equal(viewerSource.includes("@import"), false);
  assert.equal(/url\(\s*["']?(https?:)?\/\//i.test(viewerSource), false);
});

test("template carries the required viewer elements and controls", () => {
  for (const id of REQUIRED_IDS) {
    assert.ok(viewerSource.includes(`id="${id}"`), `#${id} exists`);
  }
  for (const label of ["Previous step", "Replay", "Next step"]) {
    assert.ok(
      new RegExp(`>\\s*${label}\\s*</button>`).test(viewerSource),
      `button label "${label}" exists`,
    );
  }
  for (const behavior of [
    "video.pause()",
    "video.currentTime = 0",
    "startPlayback()",
  ]) {
    assert.ok(viewerSource.includes(behavior), `behavior "${behavior}" exists`);
  }
});

test("step selection autoplays and ended videos do not advance on their own", () => {
  const selectAutoplays =
    /select\(index, \{ autoplay: true \}\)/.test(viewerSource) &&
    /select\(current - 1, \{ autoplay: true \}\)/.test(viewerSource) &&
    /select\(current \+ 1, \{ autoplay: true \}\)/.test(viewerSource);
  assert.ok(selectAutoplays, "list click, prev and next pass autoplay");
  assert.ok(
    /if \(autoplay\) startPlayback\(\)/.test(viewerSource),
    "select starts playback when autoplay is set",
  );
  assert.equal(
    viewerSource.includes('addEventListener("ended"'),
    false,
    "no automatic continuous playback",
  );
  assert.ok(
    viewerSource.includes("select(0)"),
    "initial selection does not autoplay",
  );
});

test("template texts are English only", () => {
  const cjk = viewerSource.match(/[\u3040-\u30ff\u4e00-\u9fff\uff01-\uff60]/);
  assert.equal(cjk, null, `no Japanese characters, found: ${cjk?.[0]}`);
});

test("skill and spec keep referencing the integrated spec", () => {
  assert.ok(
    skillSource.includes("`SPEC.md`"),
    "SKILL.md points at the integrated spec",
  );
  assert.equal(
    skillSource.includes("## 操作と変化を見せる"),
    false,
    "SKILL.md no longer embeds the recording spec",
  );
  assert.equal(
    skillSource.includes("assets/README.md"),
    false,
    "SKILL.md no longer references the removed assets README",
  );
  assert.ok(
    specSource.includes("metadata.json") && specSource.includes("index.html"),
    "spec documents the metadata and the generated file",
  );
  assert.ok(
    specSource.includes("## 操作と変化を見せる"),
    "spec owns the recording annotation specification",
  );
  assert.ok(
    specSource.includes("### ビューアの見た目"),
    "spec owns the viewer appearance",
  );
});
