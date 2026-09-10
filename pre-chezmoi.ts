import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { isMap, parseDocument, stringify as stringifyYaml } from "yaml";
import { toJS, type ToJSContext } from "yaml/util";

export type Platform = "win32" | "other";

type FileFormat = "json" | "yaml";
type MergeOp = "append" | "remove" | "replace" | "unset";
type PlainObject = Record<string, unknown>;
type Operation = { key: string; value: unknown };
type Operations = Map<string, Partial<Record<MergeOp, Operation>>>;
type Entry = { path: string; isDirectory: boolean };
type Layer = { normal: unknown; operations: Operations };
type MergeTarget = { outputPath: string; format: FileFormat; sidecarPaths: string[] };
type TargetPathResolver = (root: string, sourcePath: string) => Promise<string>;

const mergeOps = new Set<MergeOp>(["append", "remove", "replace", "unset"]);
const sidecarPattern = /\.merge(\.local)?\.(json|yaml)$/;

const fileFormats = {
  json: {
    stringify: (value: unknown) => `${JSON.stringify(value, null, 2)}\n`,
  },
  yaml: {
    stringify: (value: unknown) => stringifyYaml(value),
  },
} as const;

export async function run(
  root = process.cwd(),
  platform: Platform = process.platform === "win32" ? "win32" : "other",
  resolveTargetPath: TargetPathResolver = chezmoiTargetPath,
): Promise<void> {
  const sourceDir = join(root, "dotfiles");
  const distDir = join(root, "dist");

  await rm(distDir, { recursive: true, force: true });
  await copyDir(sourceDir, distDir);
  await movePlatformEntries(distDir, platform);
  await convertDotEntries(distDir);
  await convertExactDirectories(distDir);
  await convertExecutableFiles(distDir);
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
        "localsend/settings.merge.json":
          "AppData/Roaming/LocalSend/settings.merge.json",
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
    for (const suffix of ["merge", "merge.local"]) {
      const sidecar = `${stem}.${suffix}.${target.format}`;
      if (existsSync(sidecar)) layers.push(await readLayer(sidecar, target.format));
    }

    let value: unknown = {};
    for (const layer of layers) {
      value = applyOperations(deepMerge(value, layer.normal), layer.operations);
    }

    await writeFile(target.outputPath, fileFormats[target.format].stringify(value));
    for (const sidecar of target.sidecarPaths) await rm(sidecar);
  }
}

async function collectMergeTargets(distDir: string): Promise<MergeTarget[]> {
  const targets = new Map<string, MergeTarget>();
  for (const entry of await collectEntries(distDir)) {
    if (entry.isDirectory || !basename(entry.path).match(sidecarPattern)) continue;

    const format = entry.path.endsWith(".yaml") ? "yaml" : "json";
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
  const document = parseDocument(format === "json" ? stripJsonComments(content) : content, {
    uniqueKeys: false,
  });
  if (document.errors.length > 0) throw document.errors[0];
  if (!isMap(document.contents)) return { normal: document.toJSON() ?? {}, operations: new Map() };

  const normal: PlainObject = {};
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
  for (const pair of document.contents.items) {
    const key = String(pair.key?.toJSON());
    const value = pair.value ? toJS(pair.value, null, yamlContext) : undefined;
    if (!key.includes(".$")) {
      normal[key] = value;
      continue;
    }

    const match = key.match(/^(.+)\.\$(.+)$/);
    if (!match || match[1].includes("[") || !mergeOps.has(match[2] as MergeOp)) {
      throw new Error(`invalid merge op key: ${key}`);
    }

    const path = match[1];
    const op = match[2] as MergeOp;
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
