// Builds the standalone step viewer `review-kit/index.html` from a
// review-kit folder of per-flow recording sets:
//
//   review-kit/
//   ├── <flow>/
//   │   ├── metadata.json
//   │   └── <step videos>.mp4
//   └── index.html  (generated)
//
// Each flow's metadata.json has the shape
// { "title": "...", "steps": [{ "action": "...", "video": "..." }] }
// where "video" resolves relative to the flow folder. Flows are ordered by
// folder name and steps play in array order, receiving the viewer numbers
// 1..N within their flow.
// Usage: node build-viewer.mjs <review-kit-dir>

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
  return template.replace(PLACEHOLDER, embed(readFlows(recordingsDir)));
}

export function main(argv) {
  const recordingsDir = argv[2];
  if (!recordingsDir) {
    console.error("Usage: node build-viewer.mjs <review-kit-dir>");
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

function readFlows(recordingsDir) {
  const flowIds = readdirSync(recordingsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (flowIds.length === 0) {
    throw new Error(`${recordingsDir}: no flow folders with metadata.json.`);
  }
  return { flows: flowIds.map((flowId) => readFlow(recordingsDir, flowId)) };
}

function readFlow(recordingsDir, flowId) {
  const flowDir = join(recordingsDir, flowId);
  const { title, steps } = readMetadata(flowDir);
  return {
    id: flowId,
    title,
    steps: steps.map(({ number, action, video }) => ({
      number,
      action,
      video: `${flowId}/${video}`,
    })),
  };
}

function readMetadata(flowDir) {
  const file = join(flowDir, METADATA);
  if (!existsSync(file)) {
    throw new Error(`${file}: metadata.json not found.`);
  }
  const { title, steps } = readJson(file);
  if (typeof title !== "string" || !title.trim()) {
    throw new Error(`${file}: "title" must be a non-empty string.`);
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`${file}: "steps" must be a non-empty array.`);
  }
  return {
    title,
    steps: steps.map((step, index) => readStep(flowDir, file, step, index + 1)),
  };
}

function readStep(flowDir, metadataFile, step, number) {
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
  if (!existsSync(join(flowDir, video))) {
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
