import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { isMap, parseDocument, stringify as stringifyYaml, type Pair, type ParsedNode } from "yaml";
import { toJS, type ToJSContext } from "yaml/util";

export type Platform = "win32" | "other";

type FileFormat = "json" | "toml" | "yaml";
type MergeOp = "append" | "remove" | "replace" | "unset";
type PlainObject = Record<string, unknown>;
type Operation = { key: string; value: unknown };
type Operations = Map<string, Partial<Record<MergeOp, Operation>>>;
type Entry = { path: string; isDirectory: boolean };
type Hook = { absolutePath: string; relativeParent: string };
type Layer = { normal: unknown; operations: Operations };
type MergeTarget = { outputPath: string; format: FileFormat; sidecarPaths: string[] };
type TargetPathResolver = (root: string, sourcePath: string) => Promise<string>;

const mergeOps = new Set<MergeOp>(["append", "remove", "replace", "unset"]);
const operationKeyPattern = new RegExp(`^(.+)\\.\\$(${[...mergeOps].join("|")})$`);
const hookFileName = ".pre-chezmoi.ts";
const sidecarPattern = /\.(merge|machine)\.(json|yaml|toml)$/;

const fileFormats = {
  json: {
    stringify: (value: unknown) => `${JSON.stringify(value, null, 2)}\n`,
  },
  yaml: {
    stringify: (value: unknown) => stringifyYaml(value),
  },
  toml: {
    stringify: (value: unknown) => {
      const serialized = stringifyToml(value);
      return serialized === "" ? serialized : `${serialized}\n`;
    },
  },
} as const;

export async function run(
  root = process.cwd(),
  platform: Platform = process.platform === "win32" ? "win32" : "other",
  resolveTargetPath: TargetPathResolver = chezmoiTargetPath,
): Promise<void> {
  const sourceDir = join(root, "dotfiles");
  const distDir = join(root, "dist");

  const hooks = await collectHooks(sourceDir);
  await rm(distDir, { recursive: true, force: true });
  await copyDir(sourceDir, distDir);
  await runHooks(hooks, distDir);
  await movePlatformEntries(distDir, platform);
  await convertDotEntries(distDir);
  await convertExactDirectories(distDir);
  await convertExecutableFiles(distDir);
  await convertSymlinkFiles(distDir);
  await composeMergeTargets(root, distDir, resolveTargetPath);
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
        "localsend/settings.merge.json": "AppData/Roaming/LocalSend/settings.merge.json",
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
        "localsend/settings.merge.json":
          ".local/share/org.localsend.localsend_app/shared_preferences.merge.json",
        rtk: ".config/rtk",
        zed: ".config/zed",
      };
}

async function movePlatformEntries(distDir: string, platform: Platform): Promise<void> {
  for (const [source, destination] of Object.entries(pathMaps(platform))) {
    const sourcePath = join(distDir, source);
    if (!existsSync(sourcePath)) continue;

    const destinationPath = join(distDir, destination);
    await mkdir(dirname(destinationPath), { recursive: true });
    await rm(destinationPath, { recursive: true, force: true });
    await rename(sourcePath, destinationPath);
  }
}

async function convertDotEntries(distDir: string): Promise<void> {
  const dotEntries = (await collectEntries(distDir))
    .filter(
      (entry) =>
        basename(entry.path).startsWith(".") &&
        !isExcludedFromDotConversion(basename(entry.path)) &&
        !relative(distDir, entry.path).includes(".chezmoi"),
    )
    .sort(deepestFirst);
  for (const entry of dotEntries) {
    await rename(entry.path, join(dirname(entry.path), `dot_${basename(entry.path).slice(1)}`));
  }
}

function isExcludedFromDotConversion(name: string): boolean {
  return name.startsWith(".pre-chezmoi");
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

async function convertSymlinkFiles(distDir: string): Promise<void> {
  const symlinkFiles = (await collectEntries(distDir)).filter(
    (entry) =>
      !entry.isDirectory &&
      entry.path.endsWith(".symlink") &&
      !relative(distDir, entry.path).includes(".chezmoi"),
  );
  for (const entry of symlinkFiles) {
    await rename(
      entry.path,
      join(dirname(entry.path), `symlink_${basename(entry.path).replace(/\.symlink$/, "")}`),
    );
  }
}

async function composeMergeTargets(
  root: string,
  distDir: string,
  resolveTargetPath: TargetPathResolver,
): Promise<void> {
  for (const target of await collectMergeTargets(distDir)) {
    const hasBase = existsSync(target.outputPath);
    if (!hasBase) await writeFile(target.outputPath, "");
    const homePath = (
      await resolveTargetPath(root, relative(distDir, target.outputPath).split(sep).join("/"))
    ).replace(/[\r\n]+$/, "");

    const stem = target.outputPath.slice(0, -(target.format.length + 1));
    const layers: Layer[] = [await readLayer(homePath, target.format)];
    if (hasBase) layers.push(await readLayer(target.outputPath, target.format));
    for (const suffix of ["merge", "machine"]) {
      const sidecar = `${stem}.${suffix}.${target.format}`;
      if (existsSync(sidecar)) layers.push(await readLayer(sidecar, target.format));
    }

    let value: unknown = {};
    for (const layer of layers) {
      value = applyLayer(value, layer);
    }

    await writeFile(target.outputPath, fileFormats[target.format].stringify(value));
    for (const sidecar of target.sidecarPaths) await rm(sidecar);
  }
}

async function collectMergeTargets(distDir: string): Promise<MergeTarget[]> {
  const targets = new Map<string, MergeTarget>();
  for (const entry of await collectEntries(distDir)) {
    if (entry.isDirectory || !basename(entry.path).match(sidecarPattern)) continue;

    const format: FileFormat = entry.path.endsWith(".yaml")
      ? "yaml"
      : entry.path.endsWith(".toml")
        ? "toml"
        : "json";
    const outputPath = join(
      dirname(entry.path),
      basename(entry.path).replace(sidecarPattern, `.${format}`),
    );
    const target = targets.get(outputPath) ?? { outputPath, format, sidecarPaths: [] };
    target.sidecarPaths.push(entry.path);
    targets.set(outputPath, target);
  }
  return [...targets.values()];
}

async function readLayer(path: string, format: FileFormat): Promise<Layer> {
  if (!existsSync(path)) return { normal: {}, operations: new Map() };
  const content = await readFile(path, "utf-8");
  if (content.trim() === "") return { normal: {}, operations: new Map() };
  return parseLayer(content, format);
}

function parseLayer(content: string, format: FileFormat): Layer {
  if (format === "toml") {
    const operations: Operations = new Map();
    const parsed = parseTomlPairs(parseToml(content), "", operations);
    return { normal: parsed.normal, operations };
  }
  const document = parseDocument(format === "json" ? stripJsonComments(content) : content, {
    uniqueKeys: false,
  });
  if (document.errors.length > 0) throw document.errors[0];
  if (!isMap(document.contents)) return { normal: document.toJSON() ?? {}, operations: new Map() };

  const operations: Operations = new Map();
  // Keep one conversion context so aliases resolve against this document while
  // duplicate operation keys continue to be processed individually.
  const yamlContext: ToJSContext = {
    anchors: new Map(),
    doc: document,
    keep: false,
    mapAsMap: false,
    mapKeyWarned: false,
    maxAliasCount: 100,
  };
  const { normal } = parsePairs(document.contents.items, "", operations, yamlContext);
  return { normal, operations };
}

// Apply one parsed layer to a base value following pre-chezmoi.spec.md §9.
function applyLayer(base: unknown, layer: Layer): unknown {
  return applyOperations(deepMerge(base, layer.normal), layer.operations);
}

// Apply a YAML patch layer (pre-chezmoi.spec.md §9) to a base value. Exported
// for local hooks that merge machine-specific config layers.
export function applyYamlPatch(base: unknown, yamlContent: string): unknown {
  return applyLayer(base, parseLayer(yamlContent, "yaml"));
}

type ParsedPairs = { normal: PlainObject; hasOperations: boolean };

// Recursively split a layer object into normal keys and operation keys. An
// operation key at nesting depth contributes the ancestor keys joined by "."
// to its target path. Keys failing the recognition rules stay as normal keys.
// Objects holding only operation keys are dropped from the normal result so
// they do not take part in the deep merge.
function parsePairs(
  items: readonly Pair<ParsedNode, ParsedNode | null>[],
  prefix: string,
  operations: Operations,
  context: ToJSContext,
): ParsedPairs {
  const normal: PlainObject = {};
  let hasOperations = false;
  for (const pair of items) {
    const key = String(pair.key?.toJSON());
    const operation = matchOperationKey(key);
    if (operation) {
      const path = prefix + operation.path;
      registerOperation(
        operations,
        path,
        operation.op,
        `${path}.$${operation.op}`,
        pair.value ? toJS(pair.value, null, context) : undefined,
      );
      hasOperations = true;
      continue;
    }
    if (isMap(pair.value)) {
      const child = parsePairs(pair.value.items, `${prefix}${key}.`, operations, context);
      if (child.hasOperations && Object.keys(child.normal).length === 0) {
        hasOperations = true;
        continue;
      }
      normal[key] = child.normal;
      hasOperations ||= child.hasOperations;
      continue;
    }
    normal[key] = pair.value ? toJS(pair.value, null, context) : undefined;
  }
  return { normal, hasOperations };
}

// TOML counterpart of parsePairs: split a parsed plain-object layer into
// normal keys and operation keys following the same recognition rules.
// In TOML, `$` requires a quoted key (e.g. "key.$replace"), which does not
// split on "."; ancestor paths are expressed through nesting or dotted keys.
function parseTomlPairs(value: unknown, prefix: string, operations: Operations): ParsedPairs {
  if (!isPlainObject(value)) return { normal: {}, hasOperations: false };
  const normal: PlainObject = {};
  let hasOperations = false;
  for (const [key, child] of Object.entries(value)) {
    const operation = matchOperationKey(key);
    if (operation) {
      const path = prefix + operation.path;
      registerOperation(operations, path, operation.op, `${path}.$${operation.op}`, child);
      hasOperations = true;
      continue;
    }
    if (isPlainObject(child)) {
      const parsed = parseTomlPairs(child, `${prefix}${key}.`, operations);
      if (parsed.hasOperations && Object.keys(parsed.normal).length === 0) {
        hasOperations = true;
        continue;
      }
      normal[key] = parsed.normal;
      hasOperations ||= parsed.hasOperations;
      continue;
    }
    normal[key] = child;
  }
  return { normal, hasOperations };
}

function matchOperationKey(key: string): { path: string; op: MergeOp } | undefined {
  const match = key.match(operationKeyPattern);
  if (!match || match[1].includes("[")) return undefined;
  return { path: match[1], op: match[2] as MergeOp };
}

function registerOperation(
  operations: Operations,
  path: string,
  op: MergeOp,
  key: string,
  value: unknown,
): void {
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

function stripJsonComments(content: string): string {
  let result = "";
  let index = 0;
  while (index < content.length) {
    if (content[index] === '"') {
      const end = readString(content, index);
      result += content.slice(index, end);
      index = end;
    } else if (content.startsWith("//", index)) {
      const end = content.indexOf("\n", index);
      index = end === -1 ? content.length : end;
    } else if (content.startsWith("/*", index)) {
      const end = content.indexOf("*/", index + 2);
      if (end === -1) return result;
      index = end + 2;
    } else {
      result += content[index];
      index++;
    }
  }
  return result;
}

function readString(content: string, start: number): number {
  let index = start + 1;
  while (index < content.length) {
    if (content[index] === "\\") index += 2;
    else if (content[index] === '"') return index + 1;
    else index++;
  }
  throw new Error("unterminated string");
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, layer: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(layer)) return layer;

  const merged: PlainObject = { ...base };
  for (const [key, layerValue] of Object.entries(layer)) {
    merged[key] = deepMerge(merged[key], layerValue);
  }
  return merged;
}

function applyOperations(base: unknown, operations: Operations): unknown {
  if (!isPlainObject(base)) {
    for (const [path, pathOperations] of operations) {
      if (pathOperations.append && !pathOperations.replace)
        throw new Error(`merge append path not found: ${path}`);
    }
    return base;
  }

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
  if (!Array.isArray(values)) throw new Error(`merge append value must be array: ${operation.key}`);

  const target = findPath(root, path);
  if (!target) throw new Error(`merge append path not found: ${path}`);
  if (!Array.isArray(target.value)) throw new Error(`merge append requires array at path: ${path}`);

  target.value.push(...values);
}

function removeAtPath(root: PlainObject, path: string, operation: Operation): void {
  const values = operation.value;
  if (!Array.isArray(values)) throw new Error(`merge remove value must be array: ${operation.key}`);

  const target = findPath(root, path);
  if (!target) return;
  if (Array.isArray(target.value)) {
    target.parent[target.key] = target.value.filter(
      (value) => !values.some((matcher) => arrayElementsMatch(value, matcher)),
    );
    return;
  }
  if (!isPlainObject(target.value)) {
    throw new Error(`merge remove requires array or object at path: ${path}`);
  }
  if (!values.every((value) => typeof value === "string")) {
    throw new Error(`merge remove object keys must be strings: ${operation.key}`);
  }
  for (const key of values) delete target.value[key];
}

function arrayElementsMatch(left: unknown, right: unknown): boolean {
  return Bun.deepEquals(left, right);
}

async function chezmoiTargetPath(root: string, sourcePath: string): Promise<string> {
  const proc = Bun.spawn(
    ["chezmoi", "target-path", "-c", "chezmoi.yaml", join("dist", sourcePath)],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(stderr.trim() || `chezmoi target-path failed: dist/${sourcePath}`);
  return stdout;
}

async function collectHooks(sourceDir: string): Promise<Hook[]> {
  const hooks: Hook[] = [];
  async function walk(directory: string, relativeParent: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const entryPath = join(directory, entry.name);
      const childParent = relativeParent === "" ? entry.name : `${relativeParent}/${entry.name}`;
      if (entry.isDirectory()) await walk(entryPath, childParent);
      else if (entry.isFile() && entry.name === hookFileName)
        hooks.push({ absolutePath: entryPath, relativeParent });
    }
  }
  await walk(sourceDir, "");
  return hooks.sort((left, right) => compareHookParents(left.relativeParent, right.relativeParent));
}

function compareHookParents(left: string, right: string): number {
  const leftParts = left === "" ? [] : left.split("/");
  const rightParts = right === "" ? [] : right.split("/");
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index++) {
    if (leftParts[index] !== rightParts[index])
      return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return leftParts.length - rightParts.length;
}

async function runHooks(hooks: Hook[], distDir: string): Promise<void> {
  for (const hook of hooks) {
    const hookDistDir =
      hook.relativeParent === "" ? distDir : join(distDir, ...hook.relativeParent.split("/"));
    const relativePath =
      hook.relativeParent === "" ? hookFileName : `${hook.relativeParent}/${hookFileName}`;
    const proc = Bun.spawn(["bun", hook.absolutePath], {
      cwd: hookDistDir,
      env: process.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const reason = proc.signalCode ? `signal ${proc.signalCode}` : `exit code ${exitCode}`;
      throw new Error(`local pre-chezmoi hook failed: ${relativePath} (${reason})`);
    }
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

if (import.meta.main) {
  try {
    await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
