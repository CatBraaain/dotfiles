import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { isMap, parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";

export type Platform = "win32" | "other";

type FileFormat = "json" | "yaml";
type OverwriteOp = "append" | "remove" | "replace" | "unset";
type PlainObject = Record<string, unknown>;
type Operation = { key: string; value: unknown };
type Operations = Map<string, Partial<Record<OverwriteOp, Operation>>>;
type Entry = { path: string; isDirectory: boolean };

const overwriteOps = new Set<OverwriteOp>(["append", "remove", "replace", "unset"]);

const fileFormats = {
  json: {
    parse: JSON.parse,
    stringify: (value: unknown) => `${JSON.stringify(value, null, 2)}\n`,
  },
  yaml: {
    parse: parseYaml,
    stringify: (value: unknown) => stringifyYaml(value),
  },
} as const;

export async function run(
  root = process.cwd(),
  platform: Platform = process.platform === "win32" ? "win32" : "other",
): Promise<void> {
  const sourceDir = join(root, "dotfiles");
  const distDir = join(root, "dist");

  await rm(distDir, { recursive: true, force: true });
  await copyDir(sourceDir, distDir);
  await movePlatformDirectories(distDir, platform);
  await mergeOverwriteFiles(root, distDir);
  await convertMergeFiles(distDir);
  await convertDotEntries(distDir);
  await convertExactDirectories(distDir);
  await convertExecutableFiles(distDir);
}

async function copyDir(sourceDir: string, destinationDir: string): Promise<void> {
  await mkdir(destinationDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;

    const sourcePath = join(sourceDir, entry.name);
    const destinationPath = join(destinationDir, entry.name);
    if (entry.isDirectory()) await copyDir(sourcePath, destinationPath);
    else await cp(sourcePath, destinationPath);
  }
}

function pathMaps(platform: Platform): Record<string, string> {
  return platform === "win32"
    ? {
        docker: "AppData/Roaming/Docker",
        erdtree: "AppData/Roaming/erdtree",
        gemini: ".gemini",
        "git-cliff": "AppData/Roaming/git-cliff",
        mise: ".config/mise",
        nushell: "AppData/Roaming/nushell",
        "obs-studio": "AppData/Roaming/obs-studio",
        powershell: "Documents/PowerShell",
        "windows-terminal":
          "AppData/Local/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState",
        roo: ".roo",
        sharex: "Documents/ShareX",
        vscode: "AppData/Roaming/Code/User",
        zed: "AppData/Roaming/Zed",
      }
    : {
        docker: ".docker/desktop",
        erdtree: ".config/erdtree",
        "git-cliff": ".config/git-cliff",
        zed: ".config/zed",
      };
}

async function movePlatformDirectories(distDir: string, platform: Platform): Promise<void> {
  for (const [source, destination] of Object.entries(pathMaps(platform))) {
    const sourcePath = join(distDir, source);
    if (!existsSync(sourcePath)) continue;

    const destinationPath = join(distDir, destination);
    await mkdir(dirname(destinationPath), { recursive: true });
    await rm(destinationPath, { recursive: true, force: true });
    await rename(sourcePath, destinationPath);
  }
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, overwrite: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overwrite)) return overwrite;

  const merged: PlainObject = { ...base };
  for (const [key, overwriteValue] of Object.entries(overwrite)) {
    merged[key] = deepMerge(merged[key], overwriteValue);
  }
  return merged;
}

const formatOf = (path: string): FileFormat => (path.endsWith(".yaml") ? "yaml" : "json");

function parseFile(content: string, format: FileFormat): unknown {
  return format === "json" ? JSON.parse(content) : parseYaml(content);
}

async function mergeOverwriteFiles(root: string, distDir: string): Promise<void> {
  for (const entry of await collectEntries(distDir)) {
    if (!entry.path.match(/\.overwrite\.(json|yaml)$/)) continue;

    const format = formatOf(entry.path);
    const baseFile = entry.path.replace(/\.overwrite\.\w+$/, `.${format}`);
    if (!existsSync(baseFile))
      throw new Error(`overwrite target not found: ${displayPath(root, baseFile)}`);

    const { stringify } = fileFormats[format];
    const baseContent = parseFile(await readFile(baseFile, "utf-8"), format);
    const { normal, operations } = parseOverwrite(await readFile(entry.path, "utf-8"));
    const merged = applyOperations(deepMerge(baseContent, normal), operations);
    await writeFile(baseFile, stringify(merged));
    await rm(entry.path);
  }
}

function parseOverwrite(content: string): { normal: unknown; operations: Operations } {
  const document = parseDocument(content, { uniqueKeys: false });
  if (document.errors.length > 0) throw document.errors[0];
  if (!isMap(document.contents)) return { normal: document.toJSON(), operations: new Map() };

  const normal: PlainObject = {};
  const operations: Operations = new Map();
  for (const pair of document.contents.items) {
    const key = String(pair.key?.toJSON());
    const value = pair.value?.toJSON();
    if (!key.includes(".$")) {
      normal[key] = value;
      continue;
    }

    const match = key.match(/^(.+)\.\$(.+)$/);
    if (!match || match[1].includes("[") || !overwriteOps.has(match[2] as OverwriteOp)) {
      throw new Error(`invalid overwrite op key: ${key}`);
    }

    const path = match[1];
    const op = match[2] as OverwriteOp;
    const pathOperations = operations.get(path) ?? {};
    const previous = pathOperations[op];
    pathOperations[op] = {
      key,
      value:
        Array.isArray(previous?.value) && Array.isArray(value)
          ? [...previous.value, ...value]
          : value,
    };
    operations.set(path, pathOperations);
  }
  return { normal, operations };
}

function applyOperations(base: unknown, operations: Operations): unknown {
  if (!isPlainObject(base)) return base;

  for (const [path, pathOperations] of operations) {
    if (pathOperations.replace) {
      replacePath(base, path, pathOperations.replace.value);
      continue;
    }
    if (pathOperations.unset) unsetPath(base, path);
    if (pathOperations.remove) removeAtPath(base, path, pathOperations.remove);
    if (pathOperations.append) appendAtPath(base, path, pathOperations.append);
  }
  return base;
}

type PathTarget = { parent: PlainObject; key: string; value: unknown };

function findPath(root: PlainObject, path: string): PathTarget | undefined {
  const parts = path.split(".");
  const key = parts.pop()!;
  let parent = root;
  for (const part of parts) {
    const value = parent[part];
    if (!isPlainObject(value)) return undefined;
    parent = value;
  }
  if (!(key in parent)) return undefined;
  return { parent, key, value: parent[key] };
}

function replacePath(root: PlainObject, path: string, value: unknown): void {
  const target = findPath(root, path);
  if (target) target.parent[target.key] = value;
}

function unsetPath(root: PlainObject, path: string): void {
  const target = findPath(root, path);
  if (target) delete target.parent[target.key];
}

function appendAtPath(root: PlainObject, path: string, operation: Operation): void {
  const values = operation.value;
  if (!Array.isArray(values))
    throw new Error(`overwrite append value must be array: ${operation.key}`);

  const target = findPath(root, path);
  if (!target) throw new Error(`overwrite append path not found: ${path}`);
  if (!Array.isArray(target.value))
    throw new Error(`overwrite append requires array at path: ${path}`);

  for (const value of values) {
    if (!target.value.some((existing) => arrayElementsMatch(existing, value)))
      target.value.push(value);
  }
}

function removeAtPath(root: PlainObject, path: string, operation: Operation): void {
  const values = operation.value;
  if (!Array.isArray(values))
    throw new Error(`overwrite remove value must be array: ${operation.key}`);

  const target = findPath(root, path);
  if (!target) return;
  if (Array.isArray(target.value)) {
    target.parent[target.key] = target.value.filter(
      (value) => !values.some((matcher) => arrayElementsMatch(value, matcher)),
    );
    return;
  }
  if (!isPlainObject(target.value)) {
    throw new Error(`overwrite remove requires array or object at path: ${path}`);
  }
  if (!values.every((value) => typeof value === "string")) {
    throw new Error(`overwrite remove object keys must be strings: ${operation.key}`);
  }
  for (const key of values) delete target.value[key];
}

function arrayElementsMatch(left: unknown, right: unknown): boolean {
  if (typeof left === "string" && typeof right === "string") return left === right;
  return isPlainObject(left) && isPlainObject(right) && left.source === right.source;
}

const modifyTemplate = (format: FileFormat, repoContent: string) =>
  format === "json"
    ? `{{- /* chezmoi:modify-template */ -}}
{{
  mergeOverwrite
    ((or .chezmoi.stdin "{}") | fromJson)
    (fromJsonc \`
${repoContent}
\`)
  | toPrettyJson
  | println
-}}`
    : `{{- /* chezmoi:modify-template */ -}}
{{
  mergeOverwrite
    ((or .chezmoi.stdin "{}") | fromYaml)
    (fromYaml \`
${repoContent}
\`)
  | toYaml
-}}`;

async function convertMergeFiles(distDir: string): Promise<void> {
  for (const entry of await collectEntries(distDir)) {
    if (!entry.path.match(/\.merge\.(json|yaml)$/)) continue;

    const format = formatOf(entry.path);
    const baseName = basename(entry.path).replace(/\.merge\./, ".");
    await writeFile(
      join(dirname(entry.path), `modify_${baseName}`),
      modifyTemplate(format, await readFile(entry.path, "utf-8")),
    );
    await rm(entry.path);
  }
}

async function convertDotEntries(distDir: string): Promise<void> {
  const dotEntries = (await collectEntries(distDir))
    .filter(
      (entry) =>
        basename(entry.path).startsWith(".") && !relative(distDir, entry.path).includes(".chezmoi"),
    )
    .sort(deepestFirst);
  for (const entry of dotEntries) {
    await rename(entry.path, join(dirname(entry.path), `dot_${basename(entry.path).slice(1)}`));
  }
}

async function convertExactDirectories(distDir: string): Promise<void> {
  const exactDirectories = (await collectEntries(distDir))
    .filter((entry) => entry.isDirectory && entry.path.endsWith(".exact"))
    .sort(deepestFirst);
  for (const entry of exactDirectories) {
    await rename(
      entry.path,
      join(dirname(entry.path), `exact_${basename(entry.path).replace(/\.exact$/, "")}`),
    );
  }
}

async function convertExecutableFiles(distDir: string): Promise<void> {
  const executableFiles = (await collectEntries(distDir)).filter(
    (entry) => !entry.isDirectory && entry.path.endsWith(".executable"),
  );
  for (const entry of executableFiles) {
    await rename(
      entry.path,
      join(dirname(entry.path), `executable_${basename(entry.path).replace(/\.executable$/, "")}`),
    );
  }
}

async function collectEntries(directory: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const isDirectory = entry.isDirectory();
    entries.push({ path, isDirectory });
    if (isDirectory) entries.push(...(await collectEntries(path)));
  }
  return entries;
}

function deepestFirst(left: Entry, right: Entry): number {
  return pathDepth(right.path) - pathDepth(left.path);
}

function pathDepth(path: string): number {
  return path.split(sep).length;
}

function displayPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

if (import.meta.main) {
  try {
    await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
