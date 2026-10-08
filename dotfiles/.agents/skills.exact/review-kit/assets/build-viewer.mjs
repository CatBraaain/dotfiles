// Builds the standalone step viewer `review-kit/index.html` from a
// review-kit folder:
//
//   review-kit/
//   ├── metadata.json  (scenario source of truth: title + flows + steps)
//   ├── <flow>/<step media>.mp4|.png
//   └── index.html     (generated)
//
// metadata.json holds the authored scenario: each step declares exactly one
// of "video" or "image" (a path relative to the review-kit folder) plus an
// optional "expected" description. Images and videos mix freely within a
// flow. Flows and steps render in array order, receiving the viewer numbers
// 1..N within their flow.
// Usage: node build-viewer.mjs <review-kit-dir>

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
  return template.replace(PLACEHOLDER, embed(readSet(recordingsDir)));
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

function readSet(recordingsDir) {
  const file = join(recordingsDir, METADATA);
  if (!existsSync(file)) {
    throw new Error(`${file}: metadata.json not found.`);
  }
  const { title, flows } = readJson(file);
  if (typeof title !== "string" || !title.trim()) {
    throw new Error(`${file}: "title" must be a non-empty string.`);
  }
  if (!Array.isArray(flows) || flows.length === 0) {
    throw new Error(`${file}: "flows" must be a non-empty array.`);
  }
  const seenIds = new Set();
  return {
    title,
    flows: flows.map((flow, index) => readFlow(recordingsDir, file, flow, index + 1, seenIds)),
  };
}

function readFlow(recordingsDir, metadataFile, flow, index, seenIds) {
  if (typeof flow !== "object" || flow === null || Array.isArray(flow)) {
    throw new Error(`${metadataFile}: flow ${index} must be an object.`);
  }
  const { id, title, steps } = flow;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error(`${metadataFile}: flow ${index} "id" must be a non-empty string.`);
  }
  if (seenIds.has(id)) {
    throw new Error(`${metadataFile}: flow id "${id}" is duplicated.`);
  }
  seenIds.add(id);
  if (typeof title !== "string" || !title.trim()) {
    throw new Error(`${metadataFile}: flow ${index} "title" must be a non-empty string.`);
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`${metadataFile}: flow ${index} "steps" must be a non-empty array.`);
  }
  return {
    id,
    title,
    steps: steps.map((step, stepIndex) =>
      readStep(recordingsDir, metadataFile, id, step, stepIndex + 1),
    ),
  };
}

function readStep(recordingsDir, metadataFile, flowId, step, number) {
  if (typeof step !== "object" || step === null || Array.isArray(step)) {
    throw new Error(`${metadataFile}: flow "${flowId}" step ${number} must be an object.`);
  }
  const { action, video, image, expected } = step;
  if (typeof action !== "string" || !action.trim()) {
    throw new Error(
      `${metadataFile}: flow "${flowId}" step ${number} "action" must be a non-empty string.`,
    );
  }
  if ((video !== undefined) === (image !== undefined)) {
    throw new Error(
      `${metadataFile}: flow "${flowId}" step ${number} must hold exactly one of "video" or "image".`,
    );
  }
  if (expected !== undefined && (typeof expected !== "string" || !expected.trim())) {
    throw new Error(
      `${metadataFile}: flow "${flowId}" step ${number} "expected" must be a non-empty string when present.`,
    );
  }
  const field = video !== undefined ? "video" : "image";
  const media = readMedia(recordingsDir, metadataFile, flowId, number, step[field], field);
  const entry = { number, action, [field]: media };
  if (expected !== undefined) entry.expected = expected;
  return entry;
}

function readMedia(recordingsDir, metadataFile, flowId, number, path, field) {
  const outsideSet =
    typeof path !== "string" ||
    !path.trim() ||
    isAbsolute(path) ||
    path.split(/[\\/]/).includes("..");
  if (outsideSet) {
    throw new Error(
      `${metadataFile}: flow "${flowId}" step ${number} "${field}" must be a relative path inside the recordings folder.`,
    );
  }
  if (!existsSync(join(recordingsDir, path))) {
    throw new Error(
      `${metadataFile}: flow "${flowId}" step ${number} ${field} "${path}" does not exist.`,
    );
  }
  return path;
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
