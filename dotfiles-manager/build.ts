// Build stage of the dotfiles manager (spec: SPEC.md
// §ライフサイクル): regenerates dist from dotfiles/ — local hooks
// (including the standard path-map and external fetch hooks), merge
// composition, replace sidecars.
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { existsSync } from "node:fs";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { homedir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  isMap,
  parse as parseYaml,
  parseDocument,
  stringify as stringifyYaml,
  type Pair,
  type ParsedNode,
} from "yaml";
import { toJS, type ToJSContext } from "yaml/util";
import { homeRelPath } from "./home-path.ts";
import {
  ensureHookDirectory,
  removeEmptyHookDirectories,
  removeHookSnapshot,
  writeHookSnapshot,
} from "./hook-runner.ts";

declare const Bun: {
  spawn(
    command: string[],
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      stdin: "ignore";
      stdout: "inherit" | "pipe";
      stderr: "inherit";
    },
  ): {
    exited: Promise<number>;
    signalCode: string | null;
    stdout: ReadableStream<Uint8Array> | null;
  };
  stdout: unknown;
  write(destination: unknown, content: Uint8Array): Promise<number>;
  deepEquals(left: unknown, right: unknown): boolean;
};
declare const process: {
  cwd(): string;
  platform: string;
  env: Record<string, string | undefined>;
  execPath: string;
  exitCode: number;
};
declare const console: { error(...data: unknown[]): void };
declare global {
  interface ImportMeta {
    readonly main: boolean;
    readonly dir: string;
  }
}

export type Platform = "windows" | "linux" | "darwin";

type FileFormat = "json" | "toml" | "yaml";
type MergeOp = "append" | "remove" | "replace" | "unset";
type PlainObject = Record<string, unknown>;
type Operation = { key: string; value: unknown };
type Operations = Map<string, Partial<Record<MergeOp, Operation>>>;
type Entry = { path: string; isDirectory: boolean };
type Hook = { absolutePath: string; relativeParent: string; name: string; contents: string };
export type HookEvent = (
  path: string,
  status: "start" | "success" | "failure",
  elapsedSeconds: number,
  stdoutNeedsNewline?: boolean,
) => void;
type Layer = { normal: unknown; operations: Operations };
type MergeTarget = { outputPath: string; format: FileFormat; sidecarPaths: string[] };

const mergeOps = new Set<MergeOp>(["append", "remove", "replace", "unset"]);
const operationKeyPattern = new RegExp(`^(.+)\\.\\$(${[...mergeOps].join("|")})$`);
const hookNamePattern = /\.build(?:-machine)?\.[^.]+$/;
const sidecarPattern = /\.(merge|merge-machine)\.(json|yaml|toml)$/;

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
      return serialized === "" ? "\n" : serialized.endsWith("\n") ? serialized : `${serialized}\n`;
    },
  },
} as const;

export async function run(
  root = process.cwd(),
  platform: Platform = currentPlatform(),
  homeRoot = homedir(),
  onHookEvent?: HookEvent,
): Promise<void> {
  assertPlatform(platform);
  const sourceDir = join(root, "dotfiles");
  const distDir = join(root, "dist");

  await rm(distDir, { recursive: true, force: true });
  await copyDir(sourceDir, distDir);
  // Capture hooks once so earlier hooks cannot remove later scripts from the event queue.
  await runHooks(await collectHooks(distDir), distDir, homeRoot, onHookEvent);
  await composeMergeTargets(distDir, homeRoot);
  await applyReplaceSidecars(distDir, homeRoot);
}

async function copyDir(sourceDir: string, destinationDir: string): Promise<void> {
  await mkdir(destinationDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (entry.name === "node_modules" && entry.isDirectory()) continue;

    const sourcePath = join(sourceDir, entry.name);
    const destinationPath = join(destinationDir, entry.name);
    if (entry.isDirectory()) await copyDir(sourcePath, destinationPath);
    else await cp(sourcePath, destinationPath);
  }
}

const platformNames = ["windows", "linux", "darwin"] as const;

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

async function composeMergeTargets(distDir: string, homeRoot: string): Promise<void> {
  const targets = await collectMergeTargets(distDir);
  for (const target of targets) {
    const hasBase = existsSync(target.outputPath);
    const sourcePath = relative(distDir, target.outputPath).split(sep).join("/");
    const homeRelativePath = homeRelPath(sourcePath);
    try {
      await composeMergeTarget(target, hasBase, join(homeRoot, homeRelativePath));
    } catch (error) {
      throw new Error(
        `merge target failed: ${homeRelativePath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
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
  for (const suffix of ["merge", "merge-machine"]) {
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

export function parseReplaceSidecar(content: string, sidecarPath: string): Replacement[] {
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
      const groups = args
        .slice(0, args.length - 2)
        .map((group) => (typeof group === "string" ? group : ""));
      return replacement.replace(/\$\{(\d+)\}/g, (_, index) => groups[Number(index)] ?? "");
    });
  }
  return result;
}

export async function applyReplaceSidecars(distDir: string, homeRoot: string): Promise<void> {
  for (const sidecarRel of await collectReplaceSidecars(distDir, "")) {
    // <dir>/<name>.replace.yaml renders <dir>/<name>.
    const nameRel = sidecarRel.slice(0, -sidecarSuffix.length);
    const homeRelativePath = homeRelPath(nameRel);
    try {
      const homeAbs = join(homeRoot, homeRelativePath);
      const current = existsSync(homeAbs) ? await readFile(homeAbs, "utf8") : "";
      const replacements = parseReplaceSidecar(
        await readFile(join(distDir, sidecarRel), "utf8"),
        sidecarRel,
      );
      await writeFile(join(distDir, nameRel), applyReplacements(current, replacements));
      await rm(join(distDir, sidecarRel));
    } catch (error) {
      throw new Error(
        `replace target failed: ${homeRelativePath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

async function collectReplaceSidecars(dirAbs: string, dirRel: string): Promise<string[]> {
  const sidecars: string[] = [];
  for (const entry of await readdir(dirAbs, { withFileTypes: true })) {
    const childRel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
    if (entry.isDirectory())
      sidecars.push(...(await collectReplaceSidecars(join(dirAbs, entry.name), childRel)));
    else if (entry.isFile() && entry.name.endsWith(sidecarSuffix)) sidecars.push(childRel);
  }
  return sidecars.sort();
}

async function collectHooks(distDir: string): Promise<Hook[]> {
  const hooks: Hook[] = [];
  async function walk(directory: string, relativeParent: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left: { name: string }, right: { name: string }) => compareCodeUnits(left.name, right.name),
    );
    for (const entry of entries) {
      if (!entry.isFile() || !hookNamePattern.test(entry.name)) continue;
      const entryPath = join(directory, entry.name);
      hooks.push({
        absolutePath: entryPath,
        relativeParent,
        name: entry.name,
        contents: await readFile(entryPath, "utf8"),
      });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const childParent = relativeParent === "" ? entry.name : `${relativeParent}/${entry.name}`;
      await walk(join(directory, entry.name), childParent);
    }
  }
  await walk(distDir, "");
  return hooks;
}

function hookRelativePath(hook: Hook): string {
  return hook.relativeParent === "" ? hook.name : `${hook.relativeParent}/${hook.name}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Local build hooks (spec: SPEC.md §build: ローカルフック) run as Bun processes.
export async function runHooks(
  hooks: Hook[],
  distDir: string,
  homeRoot: string,
  onHookEvent?: HookEvent,
): Promise<void> {
  for (const hook of hooks) {
    const relativePath = hookRelativePath(hook);
    const started = performance.now();
    const stdoutState = { needsNewline: false };
    onHookEvent?.(relativePath, "start", 0);
    try {
      const hookDistDir =
        hook.relativeParent === "" ? distDir : join(distDir, ...hook.relativeParent.split("/"));
      const createdDirectories = await ensureHookDirectory(hookDistDir, distDir);
      try {
        if (!relativePath.endsWith(".ts"))
          throw new Error(`build hook has unsupported extension: ${relativePath}`);

        const snapshotPath = await writeHookSnapshot(hookDistDir, hook.name, hook.contents);
        try {
          const command = [
            process.execPath,
            join(import.meta.dir, "build-hook-runner.ts"),
            resolve(snapshotPath),
            resolve(distDir),
            resolve(homeRoot),
          ];
          await runChildProcess(
            command,
            hookDistDir,
            relativePath,
            "local build hook",
            onHookEvent ? stdoutState : undefined,
          );
        } finally {
          await removeHookSnapshot(snapshotPath, distDir);
        }
      } finally {
        await removeEmptyHookDirectories(createdDirectories);
      }
      onHookEvent?.(
        relativePath,
        "success",
        (performance.now() - started) / 1000,
        stdoutState.needsNewline,
      );
    } catch (error) {
      onHookEvent?.(
        relativePath,
        "failure",
        (performance.now() - started) / 1000,
        stdoutState.needsNewline,
      );
      throw error;
    }
  }
}

async function runChildProcess(
  command: string[],
  cwd: string,
  relativePath: string,
  kind: string,
  stdoutState?: { needsNewline: boolean },
): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: stdoutState ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const forwardStdout = async () => {
    if (!stdoutState || !proc.stdout) return;
    for await (const chunk of proc.stdout) {
      await Bun.write(Bun.stdout, chunk);
      if (chunk.length > 0) stdoutState.needsNewline = chunk[chunk.length - 1] !== 10;
    }
  };
  const [exitCode] = await Promise.all([proc.exited, forwardStdout()]);
  if (exitCode !== 0) {
    const reason = proc.signalCode ? `signal ${proc.signalCode}` : `exit code ${exitCode}`;
    throw new Error(`${kind} failed: ${relativePath} (${reason})`);
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
