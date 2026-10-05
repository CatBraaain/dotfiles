// Builds the standalone step viewer `recordings/index.html` from a
// recordings folder:
//
//   recordings/
//   ├── metadata.json
//   └── <step videos>.mp4
//
// metadata.json has the shape
// { "title": "...", "steps": [{ "action": "...", "video": "..." }] }
// where "video" resolves relative to the recordings folder. Steps play in
// array order and receive the viewer numbers 1..N.
// Usage: node build-viewer.mjs <recordings-dir>

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const METADATA = "metadata.json";
const TEMPLATE = "viewer.html";
const PLACEHOLDER = "__E2E_VIEWER_DATA__";

export function buildViewerHtml(recordingsDir) {
  const template = readFileSync(new URL(`./${TEMPLATE}`, import.meta.url), "utf8");
  if (!template.includes(PLACEHOLDER)) {
    throw new Error(`Template ${TEMPLATE} lost its ${PLACEHOLDER} placeholder.`);
  }
  return template.replace(PLACEHOLDER, embed(readMetadata(recordingsDir)));
}

export function main(argv) {
  const recordingsDir = argv[2];
  if (!recordingsDir) {
    console.error("Usage: node build-viewer.mjs <recordings-dir>");
    return 1;
  }
  try {
    const html = buildViewerHtml(recordingsDir);
    writeFileSync(join(recordingsDir, "index.html"), html);
  } catch (error) {
    console.error(String(error?.message ?? error));
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}

function readMetadata(recordingsDir) {
  const file = join(recordingsDir, METADATA);
  const { title, steps } = readJson(file);
  if (typeof title !== "string" || !title.trim()) {
    throw new Error(`${file}: "title" must be a non-empty string.`);
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`${file}: "steps" must be a non-empty array.`);
  }
  return {
    title,
    steps: steps.map((step, index) => readStep(recordingsDir, file, step, index + 1)),
  };
}

function readStep(recordingsDir, metadataFile, step, number) {
  if (typeof step !== "object" || step === null || Array.isArray(step)) {
    throw new Error(`${metadataFile}: step ${number} must be an object.`);
  }
  const { action, video } = step;
  if (typeof action !== "string" || !action.trim()) {
    throw new Error(`${metadataFile}: step ${number} "action" must be a non-empty string.`);
  }
  if (typeof video !== "string" || !video.trim() || isAbsolute(video) || video.startsWith("..")) {
    throw new Error(
      `${metadataFile}: step ${number} "video" must be a relative path inside the recordings folder.`,
    );
  }
  if (!existsSync(join(recordingsDir, video))) {
    throw new Error(`${metadataFile}: step ${number} video "${video}" does not exist.`);
  }
  return { number, action, video };
}

function readJson(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: invalid JSON (${error.message}).`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file}: expected a JSON object.`);
  }
  return parsed;
}

function embed(data) {
  // "<" cannot appear unescaped inside JSON script data; escaping keeps a
  // "</script>" in titles or step texts from ending the element early.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
