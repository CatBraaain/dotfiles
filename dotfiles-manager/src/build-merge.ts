// Merge composition stage of the build (spec: SPEC.md §build: merge 変換,
// §パッチ適用): composes JSON/YAML/TOML targets from the home tree, plain
// bases, and merge sidecars, then writes the finished value to dist.
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { homeRelPath } from "./home-path.ts";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  isMap,
  parseDocument,
  stringify as stringifyYaml,
  visit,
  type Pair,
  type ParsedNode,
} from "yaml";
import { toJS, type ToJSContext } from "yaml/util";

type FileFormat = "json" | "toml" | "yaml";
type MergeOp = "append" | "remove" | "replace" | "unset";
type PlainObject = Record<string, unknown>;
type RawJsonNumber = { readonly rawJSON: string };
type Operation = { key: string; value: unknown };
type Operations = Map<string, Partial<Record<MergeOp, Operation>>>;
type Entry = { path: string; isDirectory: boolean };
type Layer = { normal: unknown; operations: Operations };
type MergeTarget = { outputPath: string; format: FileFormat; sidecarPaths: string[] };

const mergeOps = new Set<MergeOp>(["append", "remove", "replace", "unset"]);
const operationKeyPattern = new RegExp(`^(.+)\\.\\$(${[...mergeOps].join("|")})$`);
const sidecarPattern = /\.(merge|merge-machine)\.(json|yaml|toml)$/;
const jsonNumberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const rawJson = JSON as typeof JSON & {
  rawJSON(source: string): RawJsonNumber;
  isRawJSON(value: unknown): value is RawJsonNumber;
};

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

export async function composeMergeTargets(distDir: string, homeRoot: string): Promise<void> {
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
  if (format === "json") {
    visit(document, {
      Scalar(key, node) {
        if (
          key !== "key" &&
          typeof node.value === "number" &&
          node.source !== undefined &&
          jsonNumberPattern.test(node.source)
        ) {
          node.value = rawJson.rawJSON(node.source);
        }
      },
    });
  }
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
      setOwnProperty(normal, key, child.normal);
      hasOperations ||= child.hasOperations;
      continue;
    }
    setOwnProperty(normal, key, pair.value ? toJS(pair.value, null, context) : undefined);
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
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !rawJson.isRawJSON(value)
  );
}

function deepMerge(base: unknown, layer: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(layer)) return layer;

  const merged: PlainObject = { ...base };
  for (const [key, layerValue] of Object.entries(layer)) {
    const baseValue = Object.hasOwn(merged, key) ? merged[key] : undefined;
    setOwnProperty(merged, key, deepMerge(baseValue, layerValue));
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
  return Bun.deepEquals(numericValues(left), numericValues(right));
}

function numericValues(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (rawJson.isRawJSON(value)) return Number(value.rawJSON);
  if (typeof value !== "object" || value === null) return value;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
  if (seen.has(value)) return seen.get(value);

  const result = Array.isArray(value) ? [] : Object.create(prototype);
  seen.set(value, result);
  for (const [key, child] of Object.entries(value)) {
    setOwnProperty(result, key, numericValues(child, seen));
  }
  return result;
}

function setOwnProperty(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
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
