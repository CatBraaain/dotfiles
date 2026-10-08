import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const viewerSource = readFileSync(new URL("./viewer.html", import.meta.url), "utf8");
const skillSource = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
const specSource = readFileSync(new URL("./SPEC.md", import.meta.url), "utf8");

const PLACEHOLDER = "__E2E_VIEWER_DATA__";
const REQUIRED_IDS = [
  "e2e-viewer-data",
  "viewer-header",
  "viewer-title",
  "viewer-meta",
  "strip-view",
  "viewer-footnote",
  "lightbox",
  "lightbox-image",
  "lightbox-video",
  "lightbox-num",
  "lightbox-text",
  "lightbox-prev",
  "lightbox-next",
  "lightbox-close",
  "lightbox-notice",
  "viewer-empty",
];
const REPLACED_IDS = ["flow-list", "viewer-main", "step-list", "stage-notice", "step-detail", "replay"];

test("template embeds exactly one data placeholder inside the data script", () => {
  const scriptStart = viewerSource.indexOf('<script type="application/json" id="e2e-viewer-data">');
  const scriptEnd = viewerSource.indexOf("</script>", scriptStart);
  assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "data script element exists");
  const dataScript = viewerSource.slice(scriptStart, scriptEnd);
  assert.equal(dataScript.split(PLACEHOLDER).length - 1, 1);
  assert.equal(viewerSource.split(PLACEHOLDER).length - 1, 1, "placeholder appears nowhere else");
});

test("template has no external references", () => {
  const external = viewerSource.match(/(src|href)\s*=\s*["']\s*(https?:)?\/\//i);
  assert.equal(external, null, "no http(s) or protocol-relative src/href");
  assert.equal(viewerSource.includes("@import"), false);
  assert.equal(/url\(\s*["']?(https?:)?\/\//i.test(viewerSource), false);
});

test("the film strip replaces the stage viewer and stacks every flow", () => {
  for (const id of REQUIRED_IDS) {
    assert.ok(viewerSource.includes(`id="${id}"`), `#${id} exists`);
  }
  for (const id of REPLACED_IDS) {
    assert.equal(viewerSource.includes(`id="${id}"`), false, `#${id} is gone`);
  }
  assert.match(viewerSource, /renderHeader\(\);\s*renderStrips\(\);/, "only the strip view renders");
  assert.ok(viewerSource.includes("itemEl.append(thumb, caption)"), "the thumbnail is placed before the caption");
  assert.match(
    viewerSource,
    /\.strip-row \{[^}]*display: grid;[^}]*grid-auto-flow: column;[^}]*overflow-x: auto;/s,
    "the strip is a column-flow grid that scrolls horizontally",
  );
  assert.match(
    viewerSource,
    /\.strip-item \{[^}]*grid-row: span 3;[^}]*grid-template-rows: subgrid;/s,
    "each step spans the shared thumb, action, and expectation rows",
  );
  assert.match(
    viewerSource,
    /\.caption \{[^}]*grid-row: span 2;[^}]*grid-template-rows: subgrid;/s,
    "the caption shares the action and expectation rows so their heights match across a row",
  );
  assert.ok(viewerSource.includes('img.loading = "lazy"'), "image thumbnails load lazily");
  assert.match(viewerSource, /FIRST_FRAME_FRAGMENT = "#t=0\.001"/, "video thumbnails show the first frame");
  assert.ok(viewerSource.includes('video.preload = "metadata"'), "video thumbnails preload metadata only");
  assert.ok(viewerSource.includes('thumb.setAttribute("aria-label", label)'), "video thumbnails are labelled");
  assert.ok(viewerSource.includes('id="lightbox-video" controls'), "the lightbox video has controls");
});

test("lightbox shows media at natural size and moves and closes with the keyboard", () => {
  assert.match(
    viewerSource,
    /\.lightbox-body img,\s*\.lightbox-body video \{[^}]*width: auto;[^}]*height: auto;/s,
    "lightbox keeps images and videos at natural size",
  );
  assert.match(viewerSource, /id="lightbox"[^>]*hidden/, "lightbox is hidden until a thumbnail is clicked");
  assert.ok(viewerSource.includes('aria-label="Step media"'), "lightbox is a labelled dialog");
  assert.match(
    viewerSource,
    /lightboxText\.textContent = step\.expected\s*\?\s*`\$\{step\.action\} — \$\{step\.expected\}`\s*:\s*\(step\.action \?\? ""\);/,
    "the lightbox caption carries the action and the optional expectation",
  );
  assert.ok(viewerSource.includes("lightboxPrev.disabled = index === 0"), "previous clamps at start");
  assert.ok(
    viewerSource.includes("lightboxNext.disabled = index === flows[flowIndex].steps.length - 1"),
    "next clamps at the last step",
  );
  assert.ok(viewerSource.includes('if (event.key === "Escape") closeLightbox();'), "Escape closes the lightbox");
  assert.ok(
    viewerSource.includes('if (event.key === "ArrowLeft") moveLightbox(-1);') &&
      viewerSource.includes('if (event.key === "ArrowRight") moveLightbox(1);'),
    "arrow keys move between steps",
  );
  assert.ok(
    viewerSource.includes('if (event.key === "Tab") trapLightboxFocus(event);') &&
      viewerSource.includes("function trapLightboxFocus(event)"),
    "Tab cycles inside the modal lightbox",
  );
  assert.ok(
    viewerSource.includes("if (lastThumb) lastThumb.focus();"),
    "closing the lightbox returns focus to the thumbnail",
  );
  for (const wiring of [
    'lightboxPrev.addEventListener("click", () => moveLightbox(-1));',
    'lightboxNext.addEventListener("click", () => moveLightbox(1));',
    'lightboxClose.addEventListener("click", closeLightbox);',
    'thumb.addEventListener("click", () => openLightbox(flowIndex, index));',
  ]) {
    assert.ok(viewerSource.includes(wiring), `button click is wired: ${wiring}`);
  }
  assert.ok(viewerSource.includes('thumb.scrollIntoView({ block: "nearest", inline: "nearest" })'), "the strip keeps the current thumbnail in view");
  assert.ok(
    viewerSource.includes('lightboxImage.addEventListener("error", showLightboxNotice)') &&
      viewerSource.includes('lightboxVideo.addEventListener("error", showLightboxNotice)'),
    "an unreadable image or video shows a notice in the lightbox",
  );
});

test("playback never starts on its own and stops on step moves", () => {
  assert.equal(viewerSource.includes("autoplay"), false, "no autoplay anywhere");
  assert.equal(viewerSource.includes(".play()"), false, "the viewer never calls play()");
  assert.equal(viewerSource.includes('addEventListener("ended"'), false, "no automatic continuous playback");
  const pauseCalls = viewerSource.split("lightboxVideo.pause()").length - 1;
  assert.ok(pauseCalls >= 2, "playback stops on step moves and when the lightbox closes");
});

test("template texts are English only", () => {
  const cjk = viewerSource.match(/[\u3040-\u30ff\u4e00-\u9fff\uff01-\uff60]/);
  assert.equal(cjk, null, `no Japanese characters, found: ${cjk?.[0]}`);
});

test("skill and spec keep referencing the integrated spec", () => {
  assert.ok(skillSource.includes("`SPEC.md`"), "SKILL.md points at the integrated spec");
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
    specSource.includes("### ビューアの振る舞い") && specSource.includes("### ビューアの見た目"),
    "spec owns the unified viewer behavior and appearance",
  );
  assert.ok(
    specSource.includes("`expected`") && specSource.includes("`image`") && specSource.includes("`video`"),
    "spec documents the step media contract",
  );
});
