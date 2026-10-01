// Build runtime path map: apply remap tables at copy time and again before
// collecting local hooks.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Platform } from "./build.ts";

// remap.data.md lists one source path per row and a destination or removal per platform.
const mapFileName = "remap.data.md";
const removeDestination = "-";
const mapColumns = ["key", "linux", "windows", "macos"] as const;
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

export async function applyPathMap(distDir: string, platform: Platform): Promise<void> {
  async function walk(directory: string): Promise<void> {
    const mapFilePath = join(directory, mapFileName);
    if (existsSync(mapFilePath)) {
      const { removals, moves } = await loadPathMap(mapFilePath, platform);
      await removeMappedEntries(directory, "", removals);
      await moveMappedEntries(directory, moves);
    }
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "node_modules")
        await walk(join(directory, entry.name));
    }
  }
  await walk(distDir);
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

export async function createCopyRouter(platform: Platform): Promise<CopyRouter> {
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
        if (move)
          return { kind: "copy-to", destination: join(context.destinationDir, move.destination) };
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
