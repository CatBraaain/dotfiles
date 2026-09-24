// Build stage of the dotfiles manager (spec: SPEC.md
// §ライフサイクル): regenerates dist from dotfiles/ — map removals, external
// fetch, local hooks, map moves, merge composition, replace sidecars.
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { existsSync, statSync } from "node:fs";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { homedir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { isMap, parse as parseYaml, parseDocument, stringify as stringifyYaml, type Pair, type ParsedNode } from "yaml";
import { toJS, type ToJSContext } from "yaml/util";
import { mapSegment } from "./diff.ts";

declare const Bun: {
  spawn(
    command: string[],
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      stdin: "ignore";
      stdout: "inherit";
      stderr: "inherit";
    },
  ): { exited: Promise<number>; signalCode: string | null };
  spawn(
    args: string[],
    options: { cwd?: string; stdout: "pipe"; stderr: "pipe" },
  ): { exited: Promise<number>; stdout: unknown; stderr: unknown };
  deepEquals(left: unknown, right: unknown): boolean;
  Glob: {
    new (pattern: string): {
      match(path: string): boolean;
      scanSync(options: { cwd: string; onlyFiles: boolean }): Iterable<string>;
    };
  };
};
declare const process: {
  cwd(): string;
  platform: string;
  env: Record<string, string | undefined>;
  exitCode: number;
};
declare const console: { error(...data: unknown[]): void };
declare const Response: { new (body: unknown): { text(): Promise<string> } };
declare global {
  interface ImportMeta {
    readonly main: boolean;
  }
}

export type Platform = "windows" | "linux" | "darwin";

type FileFormat = "json" | "toml" | "yaml";
type MergeOp = "append" | "remove" | "replace" | "unset";
type PlainObject = Record<string, unknown>;
type Operation = { key: string; value: unknown };
type Operations = Map<string, Partial<Record<MergeOp, Operation>>>;
type Entry = { path: string; isDirectory: boolean };
type Hook = { absolutePath: string; relativeParent: string };
type Layer = { normal: unknown; operations: Operations };
type MergeTarget = { outputPath: string; format: FileFormat; sidecarPaths: string[] };

const mergeOps = new Set<MergeOp>(["append", "remove", "replace", "unset"]);
const operationKeyPattern = new RegExp(`^(.+)\\.\\$(${[...mergeOps].join("|")})$`);
const hookFileName = ".pre-build.ts";
const sidecarPattern = /\.(merge|machine)\.(json|yaml|toml)$/;
const externalFileName = ".build-external.yaml";

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
  platform: Platform = currentPlatform(),
  homeRoot = homedir(),
): Promise<void> {
  assertPlatform(platform);
  const sourceDir = join(root, "dotfiles");
  const distDir = join(root, "dist");

  const pathMap = await loadPathMap(sourceDir, platform);
  const hooks = await collectHooks(sourceDir);
  await rm(distDir, { recursive: true, force: true });
  await copyDir(sourceDir, distDir);
  await removeMappedEntries(distDir, "", pathMap.removals);
  await fetchExternals(join(sourceDir, externalFileName), distDir);
  await runHooks(
    hooks.filter((hook) => !isIgnoredTarget(hook.relativeParent, pathMap.removals)),
    distDir,
  );
  await removeMappedEntries(distDir, "", pathMap.removals);
  await moveMappedEntries(distDir, pathMap.moves);
  await composeMergeTargets(distDir, homeRoot);
  await applyReplaceSidecars(distDir, homeRoot);
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

// .build-map.md lists one source path per row and a destination or removal per platform.
const mapFileName = ".build-map.md";
const removeDestination = "-";
const mapColumns = ["key", "linux", "windows", "macos"] as const;
const platformNames = ["windows", "linux", "darwin"] as const;
type PathMap = { removals: string[]; moves: Array<{ source: string; destination: string }> };
type PathMapRow = [key: string, linux: string, windows: string, macos: string];

function currentPlatform(): Platform {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    case "darwin":
      return "darwin";
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

function assertPlatform(platform: string): asserts platform is Platform {
  if (!platformNames.includes(platform as Platform))
    throw new Error(`Unsupported platform: ${platform}`);
}

async function loadPathMap(sourceDir: string, platform: Platform): Promise<PathMap> {
  const mapFilePath = join(sourceDir, mapFileName);
  if (!existsSync(mapFilePath)) throw new Error(`${mapFileName} not found: ${mapFilePath}`);
  const rows = parsePathMap(await readFile(mapFilePath, "utf-8"), mapFilePath);
  const columnIndex = platform === "linux" ? 1 : platform === "windows" ? 2 : 3;
  const removals: string[] = [];
  const moves: Array<{ source: string; destination: string }> = [];

  for (const row of rows) {
    const destination = row[columnIndex];
    if (destination === "") continue;
    if (destination === removeDestination) removals.push(row[0]);
    else moves.push({ source: row[0], destination });
  }
  return { removals, moves };
}

function parsePathMap(content: string, mapFilePath: string): PathMapRow[] {
  const lines = content.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim().startsWith("|"));
  const headerLine = headerIndex < 0 ? undefined : lines[headerIndex];
  if (!headerLine || !sameCells(parseTableRow(headerLine), mapColumns)) {
    throw new Error(
      `${mapFileName} must have columns: ${mapColumns.join(" | ")}: ${mapFilePath}`,
    );
  }

  const separator = parseTableRow(lines[headerIndex + 1] ?? "");
  if (
    separator.length !== mapColumns.length ||
    separator.some((cell) => !/^:?-{3,}:?$/.test(cell))
  )
    throw new Error(`${mapFileName} has an invalid Markdown table separator: ${mapFilePath}`);

  const rows: PathMapRow[] = [];
  const keys = new Set<string>();
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim().startsWith("|")) {
      if (line.trim() === "") continue;
      break;
    }
    const cells = parseTableRow(line);
    if (cells.length !== mapColumns.length)
      throw new Error(`${mapFileName} has an invalid table row: ${line}`);
    const [key, ...destinations] = cells;
    if (!key) throw new Error(`${mapFileName} contains an empty key`);
    if (keys.has(key)) throw new Error(`${mapFileName} contains a duplicate key: ${key}`);
    keys.add(key);

    for (const destination of destinations) {
      if (destination === "" || destination === removeDestination) continue;
      if (destination.startsWith("/"))
        throw new Error(
          `${mapFileName} has an unsupported destination for ${key}: ${destination}`,
        );
      if (globPatternCharacters.test(key))
        throw new Error(`${mapFileName} cannot map the glob key ${key} to ${destination}`);
    }
    rows.push(cells as unknown as PathMapRow);
  }
  return rows;
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim();
  const withoutEdges = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return withoutEdges.split("|").map((cell) =>
    cell
      .trim()
      .replace(/\\([*?])/g, "$1")
      .replaceAll("\\[", "[")
      .replaceAll("\\]", "]"),
  );
}

function sameCells(actual: string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((cell, index) => cell === expected[index])
  );
}

async function removeMappedEntries(
  distDir: string,
  relativeParent: string,
  removals: string[],
): Promise<void> {
  for (const entry of await readdir(distDir, { withFileTypes: true })) {
    const childParent = relativeParent === "" ? entry.name : `${relativeParent}/${entry.name}`;
    const entryPath = join(distDir, entry.name);
    if (isIgnoredTarget(childParent, removals, !entry.isDirectory())) {
      await rm(entryPath, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) await removeMappedEntries(entryPath, childParent, removals);
  }
}

async function moveMappedEntries(
  distDir: string,
  moves: Array<{ source: string; destination: string }>,
): Promise<void> {
  for (const { source, destination } of moves) {
    const sourcePath = join(distDir, source);
    if (!existsSync(sourcePath)) continue;

    const destinationPath = join(distDir, destination);
    await mkdir(dirname(destinationPath), { recursive: true });
    await rm(destinationPath, { recursive: true, force: true });
    await rename(sourcePath, destinationPath);
  }
}

// Home-relative path resolution shared by the build stages that read the
// current home (merge composition, replace sidecars), using the segment
// mapping of diff.ts (spec §差分検知).
function homeRelPath(distRelPath: string): string {
  const segments = distRelPath.split("/");
  return segments
    .map((segment, index) => mapSegment(segment, index < segments.length - 1).homeName)
    .join("/");
}

async function composeMergeTargets(distDir: string, homeRoot: string): Promise<void> {
  const targets = await collectMergeTargets(distDir);
  for (const target of targets) {
    const hasBase = existsSync(target.outputPath);
    if (!hasBase) await writeFile(target.outputPath, "");
    const sourcePath = relative(distDir, target.outputPath).split(sep).join("/");
    const homePath = join(homeRoot, homeRelPath(sourcePath));
    await composeMergeTarget(target, hasBase, homePath);
  }
}

async function composeMergeTarget(
  target: MergeTarget,
  hasBase: boolean,
  homePath: string,
): Promise<void> {
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
    const target = targets.get(outputPath) ?? {
      outputPath,
      format,
      sidecarPaths: [] as string[],
    };
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

// Apply one parsed layer to a base value following the spec §パッチ適用.
function applyLayer(base: unknown, layer: Layer): unknown {
  return applyOperations(deepMerge(base, layer.normal), layer.operations);
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
  const match = operationKeyPattern.exec(key);
  if (!match || !match[1] || !match[2] || match[1].includes("[")) return undefined;
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

// Replace sidecar stage of the build (spec: SPEC.md
// §build: 置換 sidecar): for each <name>.replace.yaml, writes dist/<name>
// from home's current <name> content with regex replacements applied.

export type Replacement = { pattern: string; replacement: string };

const sidecarSuffix = ".replace.yaml";

export function parseReplaceSidecar(
  content: string,
  sidecarPath: string,
): Replacement[] {
  const doc: unknown = parseYaml(content);
  const replacements = (doc as { replacements?: unknown })?.replacements;
  if (!Array.isArray(replacements))
    throw new Error(`replace sidecar must have a replacements array: ${sidecarPath}`);
  return replacements.map((raw, index) => {
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      typeof (raw as { pattern?: unknown }).pattern !== "string" ||
      typeof (raw as { replacement?: unknown }).replacement !== "string"
    ) {
      throw new Error(
        `replace sidecar entry ${index} must map pattern and replacement to strings: ${sidecarPath}`,
      );
    }
    return {
      pattern: (raw as { pattern: string }).pattern,
      replacement: (raw as { replacement: string }).replacement,
    };
  });
}

// Replacements apply top to bottom; every match of each pattern is replaced
// and ${1}-style capture references resolve to the matched groups.
export function applyReplacements(content: string, replacements: Replacement[]): string {
  let result = content;
  for (const { pattern, replacement } of replacements) {
    result = result.replace(new RegExp(pattern, "g"), (...args) => {
      // match, capture groups..., offset, string
      const groups = args.slice(0, args.length - 2).map((group) =>
        typeof group === "string" ? group : "",
      );
      return replacement.replace(/\$\{(\d+)\}/g, (_, index) => groups[Number(index)] ?? "");
    });
  }
  return result;
}

export async function applyReplaceSidecars(
  distDir: string,
  homeRoot: string,
): Promise<void> {
  for (const sidecarRel of await collectReplaceSidecars(distDir, "")) {
    // <dir>/<name>.replace.yaml renders <dir>/<name>.
    const nameRel = sidecarRel.slice(0, -sidecarSuffix.length);
    const homeAbs = join(homeRoot, homeRelPath(nameRel));
    const current = existsSync(homeAbs) ? await readFile(homeAbs, "utf8") : "";
    const replacements = parseReplaceSidecar(
      await readFile(join(distDir, sidecarRel), "utf8"),
      sidecarRel,
    );
    await writeFile(join(distDir, nameRel), applyReplacements(current, replacements));
    await rm(join(distDir, sidecarRel));
  }
}

async function collectReplaceSidecars(dirAbs: string, dirRel: string): Promise<string[]> {
  const sidecars: string[] = [];
  for (const entry of await readdir(dirAbs, { withFileTypes: true })) {
    const childRel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
    if (entry.isDirectory())
      sidecars.push(...(await collectReplaceSidecars(join(dirAbs, entry.name), childRel)));
    else if (entry.isFile() && entry.name.endsWith(sidecarSuffix))
      sidecars.push(childRel);
  }
  return sidecars.sort();
}

// External fetch stage of the build (spec: SPEC.md
// §build: external fetch): syncs GitHub repository mirrors under
// ~/mirrors/github.com and materializes their entries into dist. Moved from
// the retired skills.exact hook; the externalSkills config format is kept.

export type ProcessResult = { ok: boolean; stdout: string; stderr: string };
export type TextEdit = { path: string; text: string };
export type ExternalRepo = {
  repo: string;
  destination: string;
  entries: string[];
  ttlMs: number;
  runAfter: string[][];
  edits: TextEdit[];
};
export type ExternalConfig = { repos: ExternalRepo[] };
export type SyncContext = {
  mirrorRoot: string;
  forcePull: boolean;
  repoUrl: (repo: string) => string;
  runGit: (args: string[]) => Promise<ProcessResult>;
  runCommand: (args: string[], cwd: string) => Promise<ProcessResult>;
};

type MirrorSyncResult = { mirrorDir: string; changed: boolean };

export const defaultTtlHours = 6;
const pullTimeFileName = "build-pull-time";
const defaultMirrorRoot = join(homedir(), "mirrors", "github.com");

export function defaultContext(): SyncContext {
  return {
    mirrorRoot: defaultMirrorRoot,
    forcePull: process.env.BUILD_FORCE_PULL === "1",
    repoUrl: (repo) => `https://github.com/${repo}.git`,
    runGit: (args) => runProcess(["git", ...args]),
    runCommand: (args, cwd) => runProcess(args, cwd),
  };
}

// ---------------------------------------------------------------- public API

export async function fetchExternals(
  configPath: string,
  distDir: string,
  context: SyncContext = defaultContext(),
): Promise<void> {
  const config = await loadExternalConfig(configPath);
  await Promise.all(
    config.repos.map(async (repo) => {
      const sync = await syncMirror(repo.repo, repo.ttlMs, context);
      if (sync.changed && repo.runAfter.length > 0)
        await runAfterCommands(repo.repo, sync.mirrorDir, repo.runAfter, context);
      await copyRepoEntries(
        sync.mirrorDir,
        join(distDir, repo.destination),
        repo.entries,
        repo.edits,
      );
    }),
  );
}

export async function loadExternalConfig(configPath: string): Promise<ExternalConfig> {
  const doc: unknown = parseYaml(await readFile(configPath, "utf-8"));
  const externalSkills = (doc as { externalSkills?: unknown })?.externalSkills;
  if (!isPlainObject(externalSkills))
    throw new Error(`.build-external.yaml must have an externalSkills mapping: ${configPath}`);
  const repos = Object.entries(externalSkills).map(([repo, raw]) =>
    normalizeRepo(`externalSkills.${repo}`, repo, raw),
  );
  return { repos };
}

export async function syncMirror(
  repo: string,
  ttlMs: number,
  context: SyncContext = defaultContext(),
): Promise<MirrorSyncResult> {
  const { mirrorRoot: root, forcePull, repoUrl, runGit: run } = context;
  const mirrorDir = join(root, ...repo.split("/"));
  await mkdir(dirname(mirrorDir), { recursive: true });

  if (!existsSync(mirrorDir)) {
    const url = repoUrl(repo);
    const result = await run(["clone", "--depth", "1", "--quiet", url, mirrorDir]);
    if (!result.ok)
      throw new Error(`git clone failed for ${url}: ${singleLine(result.stderr)}`);
    await markPullAt(mirrorDir);
    return { mirrorDir, changed: true };
  }

  const lastPullAt = await readLastPullAt(mirrorDir);
  if (!isPullDue(lastPullAt, Date.now(), ttlMs, forcePull))
    return { mirrorDir, changed: false };

  const before = await readRevision(repo, mirrorDir, context);
  const result = await run(["-C", mirrorDir, "pull", "--ff-only", "--quiet"]);
  if (!result.ok) {
    console.error(`warning: git pull failed for ${repo}: ${singleLine(result.stderr)}`);
    return { mirrorDir, changed: false };
  }
  const after = await readRevision(repo, mirrorDir, context);
  await markPullAt(mirrorDir);
  return { mirrorDir, changed: before !== after };
}

export function isPullDue(
  lastPullAt: number | undefined,
  nowMs: number,
  ttlMs: number,
  forcePull = false,
): boolean {
  if (forcePull) return true;
  if (lastPullAt === undefined) return true;
  return nowMs - lastPullAt >= ttlMs;
}

export async function resolveSkillDir(
  mirrorDir: string,
  path: string,
): Promise<string> {
  const matches = [
    ...new Bun.Glob(path).scanSync({ cwd: mirrorDir, onlyFiles: false }),
  ]
    .map((relativePath) => join(mirrorDir, relativePath))
    .filter((absolute) => statSync(absolute).isDirectory());
  if (matches.length === 0)
    throw new Error(`skill path matched nothing: ${path}`);
  if (matches.length > 1)
    throw new Error(`skill path matched multiple directories: ${path}`);
  return matches[0]!;
}

export async function copySkillTree(
  sourceDir: string,
  targetDir: string,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;

    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) await copySkillTree(sourcePath, targetPath);
    else if (!existsSync(targetPath)) await copyFile(sourcePath, targetPath);
  }
}

export async function readLastPullAt(
  mirrorDir: string,
): Promise<number | undefined> {
  const pullTimePath = join(mirrorDir, ".git", pullTimeFileName);
  if (!existsSync(pullTimePath)) return undefined;
  const raw = await readFile(pullTimePath, "utf-8").catch(() => undefined);
  const pullAt = Number(raw?.trim());
  return Number.isFinite(pullAt) ? pullAt : undefined;
}

export async function markPullAt(mirrorDir: string): Promise<void> {
  const gitDir = join(mirrorDir, ".git");
  await mkdir(gitDir, { recursive: true });
  await writeFile(join(gitDir, pullTimeFileName), `${Date.now()}\n`);
}

// ------------------------------------------------------------- entry copying

export async function copyRepoEntries(
  mirrorDir: string,
  destinationDir: string,
  entries: string[],
  edits: TextEdit[],
): Promise<void> {
  const resolvedEdits = edits.map((edit, index) => ({
    ...edit,
    filePath: resolveEditFile(mirrorDir, edit.path),
    index,
  }));
  const appliedEditIndexes = new Set<number>();

  for (const entry of entries) {
    const skillDir = await resolveSkillDir(mirrorDir, entry);
    const entryEdits = resolvedEdits.filter(({ filePath }) =>
      isPathInside(skillDir, filePath),
    );
    if (entryEdits.length === 0) {
      await copySkillTree(skillDir, join(destinationDir, basename(skillDir)));
      continue;
    }

    const stagingDir = await mkdtemp(join(dirname(destinationDir), "external-edit-"));
    try {
      await copyRawTree(skillDir, stagingDir);
      for (const edit of entryEdits) {
        try {
          await appendEditedFile(
            join(stagingDir, relative(skillDir, edit.filePath)),
            edit.text,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`edit failed for ${edit.path}: ${singleLine(message)}`);
        }
        appliedEditIndexes.add(edit.index);
      }
      await copySkillTree(stagingDir, join(destinationDir, basename(skillDir)));
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }

  for (const edit of resolvedEdits) {
    if (!appliedEditIndexes.has(edit.index)) {
      throw new Error(`edit path is not included in entries: ${edit.path}`);
    }
  }
}

function resolveEditFile(mirrorDir: string, path: string): string {
  const filePath = join(mirrorDir, path);
  const parentDir = dirname(filePath);
  if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) {
    throw new Error(`edit path matched nothing: ${path}`);
  }
  return filePath;
}

function isPathInside(parentDir: string, candidatePath: string): boolean {
  const childPath = relative(parentDir, candidatePath);
  return childPath !== "" && !childPath.startsWith("..") && !isAbsolute(childPath);
}

async function copyRawTree(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) await copyRawTree(sourcePath, targetPath);
    else await copyFile(sourcePath, targetPath);
  }
}

async function appendEditedFile(filePath: string, text: string): Promise<void> {
  const current = existsSync(filePath) ? await readFile(filePath, "utf8") : "";
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, current + separator + text);
}

async function runAfterCommands(
  repo: string,
  mirrorDir: string,
  commands: string[][],
  context: SyncContext,
): Promise<void> {
  const clean = await context.runGit(["-C", mirrorDir, "clean", "-fdX"]);
  if (!clean.ok) {
    throw new Error(`git clean failed for ${repo}: ${singleLine(clean.stderr)}`);
  }
  for (const command of commands) {
    const result = await context.runCommand(command, mirrorDir);
    if (!result.ok) {
      throw new Error(`run_after failed for ${repo}: ${singleLine(result.stderr)}`);
    }
  }
}

async function readRevision(
  repo: string,
  mirrorDir: string,
  context: SyncContext,
): Promise<string> {
  const result = await context.runGit(["-C", mirrorDir, "rev-parse", "HEAD"]);
  if (!result.ok) {
    throw new Error(
      `git revision lookup failed for ${repo}: ${singleLine(result.stderr)}`,
    );
  }
  return result.stdout.trim();
}

// ------------------------------------------------------------- config format

function normalizeRepo(prefix: string, repo: string, raw: unknown): ExternalRepo {
  if (!isPlainObject(raw)) throw new Error(`${prefix} must be a mapping`);
  if (
    typeof raw.destination !== "string" ||
    raw.destination === "" ||
    raw.destination.startsWith("/")
  )
    throw new Error(`${prefix}.destination must be a relative dist path`);
  if (
    typeof raw.ttlHours !== "undefined" &&
    (typeof raw.ttlHours !== "number" || !Number.isFinite(raw.ttlHours) || raw.ttlHours <= 0)
  )
    throw new Error(`${prefix}.ttlHours must be a positive number`);
  return {
    repo,
    destination: raw.destination,
    entries: normalizePathEntries(`${prefix}.entries`, raw.entries),
    ttlMs:
      (typeof raw.ttlHours === "number" ? raw.ttlHours : defaultTtlHours) * 60 * 60 * 1000,
    runAfter: normalizeCommands(`${prefix}.run_after`, raw.run_after ?? []),
    edits: normalizeEdits(`${prefix}.edit`, raw.edit === undefined ? {} : raw.edit),
  };
}

function normalizePathEntries(prefix: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error(`${prefix} must be an array`);
  return raw.map((entry, index) => {
    if (typeof entry !== "string")
      throw new Error(`${prefix}[${index}] must be a path string`);
    return entry;
  });
}

function normalizeCommands(prefix: string, raw: unknown): string[][] {
  if (!Array.isArray(raw)) throw new Error(`${prefix} must be an array`);
  return raw.map((command, index) => {
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      command.some((argument) => typeof argument !== "string")
    ) {
      throw new Error(`${prefix}[${index}] must be a non-empty string array`);
    }
    return command;
  });
}

function normalizeEdits(prefix: string, raw: unknown): TextEdit[] {
  if (!isPlainObject(raw)) throw new Error(`${prefix} must be a mapping`);
  return Object.entries(raw).map(([key, text]) => {
    const match = /^(.*)\.\$append$/.exec(key);
    if (!match || typeof text !== "string") {
      throw new Error(`${prefix}[${key}] must be a .$append text edit`);
    }
    return { path: match[1]!, text };
  });
}

// ------------------------------------------------------------ child process

async function runProcess(args: string[], cwd?: string): Promise<ProcessResult> {
  const proc = Bun.spawn(args, {
    ...(cwd === undefined ? {} : { cwd }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const ok = (await proc.exited) === 0;
  return { ok, stdout: stdout.trim(), stderr: stderr.trim() };
}

function singleLine(message: string): string {
  return message.replace(/\r?\n/g, "\\n").trim();
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
    const leftPart = leftParts[index]!;
    const rightPart = rightParts[index]!;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return leftParts.length - rightParts.length;
}

const globPatternCharacters = /[*?[]/;

function isIgnoredTarget(relativeParent: string, patterns: string[], isFile = false): boolean {
  if (relativeParent === "") return false;
  // Source folder names use human-readable .exact suffixes; target paths do not.
  // Files keep their suffix because exact conversion only rewrites directories.
  const segments = relativeParent.split("/");
  const targetSegments = segments.map((name, index) =>
    isFile && index === segments.length - 1 ? name : name.replace(/\.exact$/, ""),
  );
  const targetPath = targetSegments.join("/");
  const targetPrefixes: string[] = [];
  for (let index = 1; index <= targetSegments.length; index++)
    targetPrefixes.push(targetSegments.slice(0, index).join("/"));
  return targetPrefixes.some((prefix) =>
    patterns.some((pattern) =>
      globPatternCharacters.test(pattern)
        ? new Bun.Glob(pattern).match(prefix)
        : pattern === prefix,
    ),
  );
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
      throw new Error(`local pre-build hook failed: ${relativePath} (${reason})`);
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

if (import.meta.main) {
  try {
    await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
