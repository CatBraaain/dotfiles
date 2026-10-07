import { lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogFile, catalogRoot } from "./catalog-files.mjs";

const PLACEHOLDER = "__DESIGN_CATALOG_DATA__";
const DEFAULT_TEMPLATE = new URL("./viewer.html", import.meta.url);

// The optional templatePath on buildViewerHtml/generateViewer is an internal
// injection point for tests. The public CLI only generates the bundled
// viewer.html and exposes no template argument.
export function buildViewerHtml(rootDir, templatePath = DEFAULT_TEMPLATE) {
  const catalog = readCatalog(rootDir);
  const template = readFileSync(templatePath, "utf8");
  if (template.split(PLACEHOLDER).length !== 2) {
    throw new Error(`Viewer template must contain exactly one ${PLACEHOLDER} placeholder.`);
  }
  const embeddedJson = JSON.stringify(catalog)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return template.replace(PLACEHOLDER, () => embeddedJson);
}

export function generateViewer(rootDir, templatePath = DEFAULT_TEMPLATE) {
  const root = catalogRoot(rootDir);
  const html = buildViewerHtml(root, templatePath);
  const output = join(root, "index.html");
  try {
    if (!lstatSync(output).isFile()) {
      throw new Error(
        `${output}: viewer output must be a regular file, not a symlink or directory.`,
      );
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporaryDir = mkdtempSync(join(root, ".catalog-viewer-"));
  try {
    const temporaryFile = join(temporaryDir, "index.html");
    writeFileSync(temporaryFile, html);
    renameSync(temporaryFile, output);
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
  return output;
}

export function readCatalog(rootDir) {
  const root = catalogRoot(rootDir);
  const manifestFile = catalogFile(root, "catalog.json");
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch (error) {
    throw new Error(`catalog.json: invalid JSON (${error.message}).`);
  }
  requireObject(catalog, "catalog");
  if (catalog.schemaVersion !== 1) {
    throw new Error("catalog.schemaVersion must be 1.");
  }
  requireId(catalog.id, "catalog.id");
  requireText(catalog.title, "catalog.title");
  requireItems(catalog.axes, "catalog.axes");
  const axisIds = new Set();
  return {
    schemaVersion: 1,
    id: catalog.id,
    title: catalog.title,
    axes: catalog.axes.map((axis, index) => {
      const field = `catalog.axes[${index}]`;
      requireObject(axis, field);
      requireUniqueId(axis.id, `${field}.id`, axisIds);
      requireText(axis.label, `${field}.label`);
      requireText(axis.description, `${field}.description`);
      requireItems(axis.options, `${field}.options`);
      const optionIds = new Set();
      return {
        id: axis.id,
        label: axis.label,
        description: axis.description,
        options: axis.options.map((option, optionIndex) => {
          const optionField = `${field}.options[${optionIndex}]`;
          requireObject(option, optionField);
          requireUniqueId(option.id, `${optionField}.id`, optionIds);
          requireText(option.label, `${optionField}.label`);
          requireText(option.description, `${optionField}.description`);
          return {
            id: option.id,
            label: option.label,
            description: option.description,
            path: optionUrl(root, option.path, `${optionField}.path`),
          };
        }),
      };
    }),
  };
}

export function main(argv) {
  const [rootDir, ...extra] = argv.slice(2);
  if (!rootDir || extra.length > 0) {
    console.error("Usage: node build-viewer.mjs <catalog-root>");
    return 1;
  }
  try {
    console.log(generateViewer(rootDir));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

function optionUrl(root, path, field) {
  requireText(path, field);
  const isAbsoluteOrUrl =
    posix.isAbsolute(path) || win32.isAbsolute(path) || /^[a-z][a-z0-9+.-]*:/i.test(path);
  if (isAbsoluteOrUrl || path.includes("\\") || /\p{Cc}/u.test(path)) {
    throw new Error(`${field}: expected a relative HTML file path inside the catalog root.`);
  }
  const normalized = posix.normalize(path);
  if (!/\.html?$/i.test(normalized)) {
    throw new Error(`${field}: expected an HTML file (.html or .htm).`);
  }
  const file = catalogFile(root, normalized);
  if (file === join(root, "index.html")) {
    throw new Error(`${field}: option HTML cannot be the generated viewer index.html.`);
  }
  return `./${normalized.split("/").map(encodeURIComponent).join("/")}`;
}

function requireObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function requireItems(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array.`);
  }
}

function requireId(value, field) {
  if (typeof value !== "string" || !/^[a-z0-9-]+$/.test(value)) {
    throw new Error(`${field} must use lowercase letters, digits, and hyphens.`);
  }
}

function requireUniqueId(value, field, seen) {
  requireId(value, field);
  if (seen.has(value)) throw new Error(`${field}: duplicate ID "${value}".`);
  seen.add(value);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
