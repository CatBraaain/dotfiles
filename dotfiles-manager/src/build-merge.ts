// Merge composition stage of the build (spec: SPEC.md §build: merge 変換,
// §パッチ適用): composes JSON/YAML/TOML/INI targets from the home tree, plain
// bases, and merge/merge-existing sidecars, then writes the finished value to dist.
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { homeRelPath } from "./home-path.ts";
import { parse as parseIni, stringify as stringifyIni } from "js-ini";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { isMap, isNode, isScalar, parseDocument, visit, type Document, type YAMLMap } from "yaml";
import { toJS, type ToJSContext } from "yaml/util";
import {
  copyYamlNotation,
  ownEntries,
  readYamlValue,
  rememberYamlNotation,
  stringifyYamlValue,
  yamlKey,
} from "./yaml-notation.ts";

type FileFormat = "json" | "toml" | "yaml" | "ini";
type MergeOp = "append" | "remove" | "replace" | "unset";
type PlainObject = Record<string | symbol, unknown>;
type MergePath = string | (string | symbol)[];
type RawJsonNumber = { readonly rawJSON: string };
type Operation = { key: string; value: unknown };
type Operations = Map<MergePath, Partial<Record<MergeOp, Operation>>>;
type Entry = { path: string; isDirectory: boolean };
type Layer = { normal: unknown; operations: Operations };
type MergeTarget = { outputPath: string; format: FileFormat; sidecarPaths: string[] };

const mergeOps = new Set<MergeOp>(["append", "remove", "replace", "unset"]);
const operationKeyPattern = new RegExp(`^(.+)\\.\\$(${[...mergeOps].join("|")})$`);
const sidecarPattern = /\.(merge|merge-existing)(?:-machine)?\.(json|yaml|toml|ini)$/;
const iniReservedNames = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"]);
const jsonNumberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const rawJson = JSON as typeof JSON & {
  rawJSON(source: string): RawJsonNumber;
  isRawJSON(value: unknown): value is RawJsonNumber;
};

const fileFormats = {
  ini: { stringify: stringifyIniMerge },
  json: {
    stringify: (value: unknown) => `${JSON.stringify(value, null, 2)}\n`,
  },
  yaml: {
    stringify: stringifyYamlValue,
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
  const hasHome = existsSync(homePath);
  const sidecars = ["merge", "merge-existing", "merge-machine", "merge-existing-machine"]
    .filter((suffix) => hasHome || !suffix.startsWith("merge-existing"))
    .map((suffix) => `${stem}.${suffix}.${target.format}`)
    .filter((path) => existsSync(path));

  if (sidecars.length > 0) {
    const layers: Layer[] = [await readLayer(homePath, target.format)];
    if (hasBase) layers.push(await readLayer(target.outputPath, target.format));
    for (const sidecar of sidecars) layers.push(await readLayer(sidecar, target.format));

    let value: unknown = {};
    for (const layer of layers) {
      if (target.format === "ini") validateIniMerge(value, layer.normal);
      value = applyLayer(value, layer);
    }

    await writeFile(target.outputPath, fileFormats[target.format].stringify(value));
  }
  for (const sidecar of target.sidecarPaths) await rm(sidecar);
}

async function collectMergeTargets(distDir: string): Promise<MergeTarget[]> {
  const targets = new Map<string, MergeTarget>();
  for (const entry of await collectEntries(distDir)) {
    const name = basename(entry.path);
    const match = sidecarPattern.exec(name);
    if (entry.isDirectory || !match) continue;

    const format = match[2] as FileFormat;
    const outputPath = join(dirname(entry.path), name.replace(sidecarPattern, `.${format}`));
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
  if (format === "ini") {
    const bytes = await readFile(path);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`invalid INI UTF-8: ${basename(path)}`, { cause: error });
    }
    return parseIniLayer(content);
  }
  const content = await readFile(path, "utf-8");
  if (content.trim() === "") return { normal: {}, operations: new Map() };
  return parseLayer(content, format);
}

function parseLayer(content: string, format: FileFormat): Layer {
  if (format === "toml") return parseTomlLayer(content);
  const document = parseDocument(format === "json" ? stripJsonComments(content) : content, {
    uniqueKeys: false,
  });
  if (document.errors.length > 0) throw document.errors[0];
  if (format === "json") rewriteJsonNumbers(document);
  if (!isMap(document.contents)) {
    const normal = format === "yaml" ? readYamlValue(document.contents) : document.toJSON();
    return { normal: normal ?? {}, operations: new Map() };
  }

  const operations: Operations = new Map();
  const jsonContext: ToJSContext = {
    anchors: new Map(),
    doc: document,
    keep: false,
    mapAsMap: false,
    mapKeyWarned: false,
    maxAliasCount: 100,
  };
  const { normal } = parsePairs(
    document.contents,
    "",
    operations,
    format === "yaml" ? undefined : jsonContext,
  );
  return { normal, operations };
}

function parseTomlLayer(content: string): Layer {
  const operations: Operations = new Map();
  const parsed = parseTomlPairs(parseToml(content), "", operations);
  return { normal: parsed.normal, operations };
}

// Rewrite numeric scalars whose source text matters to rawJSON so JSON number
// precision survives the layer pipeline.
function rewriteJsonNumbers(document: Document.Parsed): void {
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

function parseIniLayer(content: string): Layer {
  const operations: Operations = new Map();
  const operationSections = new Set<string>();
  const normal = parseIni(prepareIniLines(content), {
    comment: "#",
    delimiter: "=",
    nothrow: false,
    autoTyping: (guarded, section, key) => {
      if (typeof section !== "string") throw new Error("INI section name must be a string");
      const value = guarded.slice(1, -1).replace(/\\([\\rn])/g, (_, escaped: string) => {
        if (escaped === "r") return "\r";
        if (escaped === "n") return "\n";
        return "\\";
      });
      const operation = matchOperationKey(key);
      if (operation) {
        const path = section ? `${section}.${operation.path}` : operation.path;
        registerOperation(operations, path, operation.op, `${path}.$${operation.op}`, value);
        if (section) operationSections.add(section);
      }
      return value;
    },
    keyMergeStrategy: (section, key, value: unknown) => {
      if (matchOperationKey(key)) return;
      if (Object.hasOwn(section, key)) throw new Error(`duplicate INI key: ${key}`);
      setOwnProperty(section, key, value);
    },
  });
  for (const section of operationSections) {
    const values = normal[section];
    if (isPlainObject(values) && Object.keys(values).length === 0) delete normal[section];
  }
  for (const [path, pathOperations] of operations) {
    const unset = pathOperations.unset;
    if (!pathOperations.replace && unset && unset.value !== "true" && unset.value !== "") {
      throw new Error(`merge unset value must be true or empty: ${path}.$unset`);
    }
  }
  return { normal, operations };
}

function prepareIniLines(content: string): string {
  const sections = new Set<string>();
  const rootKeys = new Set<string>();
  let section = "";
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((rawLine, index) => {
      const lineNumber = index + 1;
      if (/[\0\r]/.test(rawLine)) throw new Error(`invalid INI character at line ${lineNumber}`);
      const line = rawLine.replace(/^[ \t]+/, "");
      if (line.trim() === "" || line.startsWith("#")) return "";
      if (line.startsWith("[")) {
        const header = /^\[([^[\]]+)\][ \t]*$/.exec(line);
        if (!header) throw new Error(`invalid INI header at line ${lineNumber}`);
        section = header[1]!;
        validateIniName(section);
        if (sections.has(section)) throw new Error(`duplicate INI section: ${section}`);
        if (rootKeys.has(section)) throw new Error(`INI root/section collision: ${section}`);
        sections.add(section);
        return `[${section}]`;
      }
      const delimiter = line.indexOf("=");
      const key = delimiter === -1 ? line : line.slice(0, delimiter);
      validateIniName(key);
      if (key.startsWith("[") || key.startsWith("#")) throw new Error(`invalid INI key: ${key}`);
      const operation = matchOperationKey(key);
      if (operation) {
        validateIniName(operation.path);
        if (operation.path.includes(".") || section.includes(".")) {
          throw new Error(`ambiguous INI operation: ${section ? `${section}.` : ""}${key}`);
        }
      }
      if (delimiter === -1 && operation?.op !== "unset") {
        throw new Error(`INI key requires '=' at line ${lineNumber}: ${key}`);
      }
      if (!section && !operation) {
        if (sections.has(key)) throw new Error(`INI root/section collision: ${key}`);
        rootKeys.add(key);
      }
      const value = delimiter === -1 ? "" : line.slice(delimiter + 1);
      // js-ini trims values; guards protect their edges without replacing the real value.
      return `${key}=~${value}~`;
    })
    .join("\n");
}

function validateIniName(name: string): void {
  if (name === "" || name.trim() !== name || /[\0\r\n]/.test(name)) {
    throw new Error(`invalid INI name: ${JSON.stringify(name)}`);
  }
  if (iniReservedNames.has(name)) throw new Error(`reserved INI name: ${name}`);
}

function validateIniMerge(base: unknown, normal: unknown): void {
  if (!isPlainObject(base) || !isPlainObject(normal)) throw new Error("INI root must be a map");
  for (const [key, value] of Object.entries(normal)) {
    if (Object.hasOwn(base, key) && isPlainObject(base[key]) !== isPlainObject(value)) {
      throw new Error(`INI root/section collision: ${key}`);
    }
  }
}

function stringifyIniMerge(value: unknown): string {
  if (!isPlainObject(value)) throw new Error("INI root must be a map");
  const rootValues: Record<string, string> = {};
  const sections: Record<string, Record<string, string>> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      rootValues[key] = escapeIniValue(child);
      continue;
    }
    if (!isPlainObject(child)) throw new Error(`INI section must be a map: ${key}`);
    const values: Record<string, string> = {};
    for (const [name, text] of Object.entries(child)) {
      if (typeof text !== "string") throw new Error(`INI value must be a string: ${key}.${name}`);
      values[name] = escapeIniValue(text);
    }
    sections[key] = values;
  }
  const options = { blankLine: false, spaceBefore: false, spaceAfter: false };
  return (
    [stringifyIni(rootValues, options), stringifyIni(sections, options)]
      .filter((block) => block !== "")
      .join("\n") + "\n"
  );
}

function escapeIniValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
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
  map: YAMLMap.Parsed,
  prefix: MergePath,
  operations: Operations,
  context: ToJSContext | undefined,
): ParsedPairs {
  const normal: PlainObject = {};
  let hasOperations = false;
  for (const pair of map.items) {
    const key = context ? String(pair.key?.toJSON()) : yamlKey(pair.key);
    const operation = typeof key === "string" ? matchOperationKey(key) : undefined;
    if (operation) {
      const path = extendMergePath(prefix, operation.path);
      registerOperation(
        operations,
        path,
        operation.op,
        `${mergePathText(path)}.$${operation.op}`,
        pairValue(pair, context),
      );
      hasOperations = true;
      continue;
    }
    if (isMap(pair.value)) {
      const path = extendMergePath(prefix, key);
      const child = parsePairs(
        pair.value,
        typeof path === "string" ? `${path}.` : path,
        operations,
        context,
      );
      if (child.hasOperations && ownEntries(child.normal).length === 0) {
        hasOperations = true;
        continue;
      }
      setOwnProperty(normal, key, child.normal);
      hasOperations ||= child.hasOperations;
      continue;
    }
    setOwnProperty(normal, key, pairValue(pair, context));
  }
  if (!context) rememberYamlNotation(map, normal);
  return { normal, hasOperations };
}

// Convert one pair value through the context (JSON layers) or keep the
// node-based value (YAML layers; a missing value becomes undefined).
function pairValue(
  pair: YAMLMap.Parsed["items"][number],
  context: ToJSContext | undefined,
): unknown {
  return context
    ? pair.value
      ? toJS(pair.value, null, context)
      : undefined
    : readYamlValue(pair.value);
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

function extendMergePath(prefix: MergePath, key: string | symbol): MergePath {
  if (typeof prefix === "string" && typeof key === "string") return prefix + key;
  const ancestors = typeof prefix === "string" ? prefix.split(".").slice(0, -1) : prefix;
  return [...ancestors, ...(typeof key === "string" ? key.split(".") : [key])];
}

function mergePathText(path: MergePath): string {
  return typeof path === "string" ? path : path.map(String).join(".");
}

function registerOperation(
  operations: Operations,
  path: MergePath,
  op: MergeOp,
  key: string,
  value: unknown,
): void {
  const canonicalPath = canonicalizePath(operations, path);
  const pathOperations = operations.get(canonicalPath) ?? {};
  const previous = pathOperations[op];
  pathOperations[op] = {
    key,
    value:
      Array.isArray(previous?.value) && Array.isArray(value)
        ? copyYamlNotation([...previous.value, ...value], previous.value, value)
        : value,
  };
  operations.set(canonicalPath, pathOperations);
}

// Structurally equal array paths share one Map key so the same nested target
// aggregates onto a single operation record.
function canonicalizePath(operations: Operations, path: MergePath): MergePath {
  if (!Array.isArray(path)) return path;
  const parts = path;
  return (
    [...operations.keys()].find(
      (existing) =>
        Array.isArray(existing) &&
        existing.length === parts.length &&
        existing.every((part, index) => part === parts[index]),
    ) ?? path
  );
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
    !isNode(value) &&
    !rawJson.isRawJSON(value)
  );
}

function deepMerge(base: unknown, layer: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(layer)) return layer;

  const merged: PlainObject = copyYamlNotation({ ...base }, base, layer);
  for (const [key, layerValue] of ownEntries(layer)) {
    const baseValue = Object.hasOwn(merged, key) ? merged[key] : undefined;
    setOwnProperty(merged, key, deepMerge(baseValue, layerValue));
  }
  return merged;
}

function applyOperations(base: unknown, operations: Operations): unknown {
  if (!isPlainObject(base)) {
    for (const [path, pathOperations] of operations) {
      if (pathOperations.replace) continue;
      if (pathOperations.append)
        throw new Error(`merge append path not found: ${mergePathText(path)}`);
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

type PathTarget = { parent: PlainObject; key: string | symbol; value: unknown };

function findPath(root: PlainObject, path: MergePath): PathTarget | undefined {
  const parts = typeof path === "string" ? path.split(".") : [...path];
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

function replacePath(root: PlainObject, path: MergePath, value: unknown): void {
  const target = findPath(root, path);
  if (target) target.parent[target.key] = value;
}

function unsetPath(root: PlainObject, path: MergePath): void {
  const target = findPath(root, path);
  if (target) delete target.parent[target.key];
}

function appendAtPath(root: PlainObject, path: MergePath, operation: Operation): void {
  const values = operation.value;
  if (!Array.isArray(values)) throw new Error(`merge append value must be array: ${operation.key}`);

  const target = findPath(root, path);
  if (!target) throw new Error(`merge append path not found: ${mergePathText(path)}`);
  if (!Array.isArray(target.value))
    throw new Error(`merge append requires array at path: ${mergePathText(path)}`);

  target.value.push(...values);
}

function removeAtPath(root: PlainObject, path: MergePath, operation: Operation): void {
  const values = operation.value;
  if (!Array.isArray(values)) throw new Error(`merge remove value must be array: ${operation.key}`);

  const target = findPath(root, path);
  if (!target) return;
  if (Array.isArray(target.value)) {
    target.parent[target.key] = copyYamlNotation(
      target.value.filter((value) => !values.some((matcher) => arrayElementsMatch(value, matcher))),
      target.value,
    );
    return;
  }
  if (!isPlainObject(target.value)) {
    throw new Error(`merge remove requires array or object at path: ${mergePathText(path)}`);
  }
  const keys = values.map((value) => (isScalar(value) ? value.value : value));
  if (!keys.every((value) => typeof value === "string")) {
    throw new Error(`merge remove object keys must be strings: ${operation.key}`);
  }
  for (const key of keys) delete target.value[key];
}

function arrayElementsMatch(left: unknown, right: unknown): boolean {
  return Bun.deepEquals(numericValues(left), numericValues(right));
}

function numericValues(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (rawJson.isRawJSON(value)) return Number(value.rawJSON);
  if (isScalar(value)) return value.value;
  if (typeof value !== "object" || value === null) return value;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
  if (seen.has(value)) return seen.get(value);

  const result = Array.isArray(value) ? [] : Object.create(prototype);
  seen.set(value, result);
  for (const [key, child] of ownEntries(value)) {
    setOwnProperty(result, key, numericValues(child, seen));
  }
  return result;
}

function setOwnProperty(target: object, key: string | symbol, value: unknown): void {
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
