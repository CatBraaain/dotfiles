// Build runtime path map: apply remap tables at copy time and again before
// collecting local hooks.
import { existsSync, lstatSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Platform } from "./build.ts";

// remap.data.md lists one source path per row and a destination or removal per platform.
const mapFileName = "remap.data.md";
const removeDestination = "-";
const mapColumns = ["key", "linux", "windows", "macos"] as const;
// The map targets macOS while the build refers to the platform as darwin.
const platformColumns = { linux: "linux", windows: "windows", darwin: "macos" } as const;
type PathMap = { removals: string[]; moves: Array<{ source: string; destination: string }> };
type PathMapRow = [key: string, linux: string, windows: string, macos: string];

function parsePathMap(content: string, mapFilePath: string): PathMapRow[] {
  const lines = content.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim().startsWith("|"));
  const headerLine = headerIndex < 0 ? undefined : lines[headerIndex];
  if (!headerLine || !sameCells(parseTableRow(headerLine), mapColumns)) {
    throw new Error(`${mapFileName} must have columns: ${mapColumns.join(" | ")}: ${mapFilePath}`);
  }

  const separator = parseTableRow(lines[headerIndex + 1] ?? "");
  if (separator.length !== mapColumns.length || separator.some((cell) => !/^:?-{3,}:?$/.test(cell)))
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
        throw new Error(`${mapFileName} has an unsupported destination for ${key}: ${destination}`);
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

async function loadPathMap(mapFilePath: string, platform: Platform): Promise<PathMap> {
  const rows = parsePathMap(await readFile(mapFilePath, "utf-8"), mapFilePath);
  const columnIndex = mapColumns.indexOf(platformColumns[platform]);
  const removals: string[] = [];
  const moves: Array<{ source: string; destination: string }> = [];

  for (const row of rows) {
    const destination = row[columnIndex] ?? "";
    if (destination === "") continue;
    if (destination === removeDestination) removals.push(row[0]);
    else moves.push({ source: row[0], destination });
  }
  return { removals, moves };
}

export async function applyPathMap(distRoot: string, platform: Platform): Promise<void> {
  const appliedMapIds = new Set<string>();

  async function walkUntilLayoutChanges(directory: string): Promise<boolean> {
    const mapFilePath = join(directory, mapFileName);
    const mapId = existsSync(mapFilePath) ? await identifyPathMap(mapFilePath) : undefined;
    if (mapId !== undefined && !appliedMapIds.has(mapId)) {
      const { removals, moves } = await loadPathMap(mapFilePath, platform);
      appliedMapIds.add(mapId);
      await removeMappedEntries(directory, "", removals);
      const hasCrossDirectoryMove = await moveMappedEntries(distRoot, directory, moves);
      if (hasCrossDirectoryMove) return true;
    }
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      if (await walkUntilLayoutChanges(join(directory, entry.name))) return true;
    }
    return false;
  }

  let layoutChanged = true;
  while (layoutChanged) layoutChanged = await walkUntilLayoutChanges(distRoot);
}

async function identifyPathMap(mapFilePath: string): Promise<string> {
  const { dev, ino } = await lstat(mapFilePath, { bigint: true });
  return ino === 0n ? `path:${mapFilePath}` : `file:${dev}:${ino}`;
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

// Destinations must stay inside dist: the whole dist tree is generated
// output, and a destination that escapes it would modify unmanaged files.
// The path form check catches destinations that resolve outside dist; the
// lstat walk catches destinations that resolve inside dist but traverse an
// in-dist symlink whose target sits outside dist.
async function assertDestinationInsideDist(
  distRoot: string,
  destinationPath: string,
  key: string,
  destination: string,
): Promise<void> {
  const relativePath = relative(distRoot, destinationPath);
  if (relativePath === "")
    throw new Error(`${mapFileName} cannot replace the dist root for ${key}: ${destination}`);
  if (isOutsideDirectory(relativePath))
    throw new Error(`${mapFileName} has a destination outside dist for ${key}: ${destination}`);
  const parentSegments = relativePath.split(sep).slice(0, -1);
  let current = distRoot;
  for (const segment of parentSegments) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => undefined);
    if (!info) break;
    if (info.isSymbolicLink())
      throw new Error(
        `${mapFileName} has a destination reaching outside dist via a symlink for ${key}: ${destination}`,
      );
  }
}

function isOutsideDirectory(relativePath: string): boolean {
  return isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`);
}

async function replacingDestinationWouldRemoveSource(
  sourcePath: string,
  destinationPath: string,
): Promise<boolean> {
  if (!isOutsideDirectory(relative(destinationPath, sourcePath))) return true;

  const destination = lstatSync(destinationPath, { bigint: true, throwIfNoEntry: false });
  if (!destination || destination.ino === 0n) return false;

  let candidatePath = sourcePath;
  while (true) {
    const candidate = await lstat(candidatePath, { bigint: true });
    if (destination.ino === candidate.ino && destination.dev === candidate.dev) return true;
    const parentPath = dirname(candidatePath);
    if (!destination.isDirectory() || parentPath === candidatePath) return false;
    candidatePath = parentPath;
  }
}

async function moveMappedEntries(
  distRoot: string,
  mapDirectory: string,
  moves: PathMap["moves"],
): Promise<boolean> {
  let hasCrossDirectoryMove = false;
  for (const { source, destination } of moves) {
    const sourcePath = join(mapDirectory, source);
    if (!existsSync(sourcePath)) continue;

    const destinationPath = join(mapDirectory, destination);
    await assertDestinationInsideDist(distRoot, destinationPath, source, destination);
    if (await replacingDestinationWouldRemoveSource(sourcePath, destinationPath))
      throw new Error(
        `${mapFileName} cannot replace the source or its ancestor for ${source}: ${destination}`,
      );
    await mkdir(dirname(destinationPath), { recursive: true });
    await rm(destinationPath, { recursive: true, force: true });
    await rename(sourcePath, destinationPath);
    if (
      isOutsideDirectory(relative(mapDirectory, sourcePath)) ||
      isOutsideDirectory(relative(mapDirectory, destinationPath))
    ) {
      hasCrossDirectoryMove = true;
    }
  }
  return hasCrossDirectoryMove;
}

// Copy-time application of the remap tables (spec: SPEC.md §build: パス対応表):
// platform removals are not copied at all and moved entries land directly at
// their destination. Mirrors the copyDir recursion — enter() with the folder
// pair being copied, route() per entry, exit() when leaving it.
export type CopyRoute =
  | { kind: "copy" }
  | { kind: "copy-to"; destination: string }
  | { kind: "skip" };

export type CopyRouter = {
  enter(sourceDir: string, destinationDir: string): Promise<void>;
  route(name: string, isFile: boolean): Promise<CopyRoute>;
  exit(): void;
};

type CopyMapContext = {
  sourceDir: string;
  destinationDir: string;
  removals: string[];
  moves: Array<{ source: string; destination: string }>;
};

export async function createCopyRouter(platform: Platform, distRoot: string): Promise<CopyRouter> {
  const sourceDirs: string[] = [];
  const contexts: Array<CopyMapContext | undefined> = [];
  return {
    async enter(sourceDir: string, destinationDir: string): Promise<void> {
      sourceDirs.push(sourceDir);
      const mapFilePath = join(sourceDir, mapFileName);
      contexts.push(
        existsSync(mapFilePath)
          ? { sourceDir, destinationDir, ...(await loadPathMap(mapFilePath, platform)) }
          : undefined,
      );
    },
    exit(): void {
      sourceDirs.pop();
      contexts.pop();
    },
    async route(name: string, isFile: boolean): Promise<CopyRoute> {
      const sourcePath = join(sourceDirs[sourceDirs.length - 1]!, name);
      // Parent tables apply before child ones (same walk order as
      // applyPathMap), and within a table removals apply before moves.
      for (let index = 0; index < contexts.length; index++) {
        const context = contexts[index];
        if (!context) continue;
        // Remap keys are "/"-separated; win32 path.relative returns "\\"-separated paths.
        const relativePath = relative(context.sourceDir, sourcePath).replaceAll("\\", "/");
        if (isIgnoredTarget(relativePath, context.removals, isFile)) return { kind: "skip" };
        const move = context.moves.find(({ source }) => source === relativePath);
        if (move) {
          const destination = join(context.destinationDir, move.destination);
          await assertDestinationInsideDist(distRoot, destination, relativePath, move.destination);
          return { kind: "copy-to", destination };
        }
      }
      return { kind: "copy" };
    },
  };
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
