#!/usr/bin/env bun
// Standard build hook (spec: SPEC.md §build: マップ): applies the removals
// and moves of remap.data.md to dist once, resolving the OS column from
// process.platform. Runs as 02-, after the external fetch hook, because
// fetched entries are map move targets and must be placed before the map
// applies. The hook runner executes it with cwd at the dist root, and
// import.meta.dir resolves to the copied hook in dist.
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { existsSync } from "node:fs";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { dirname, join } from "node:path";

declare const Bun: {
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
};
declare global {
  interface ImportMeta {
    readonly dir: string;
  }
}

// remap.data.md lists one source path per row and a destination or removal per platform.
const mapFileName = "remap.data.md";
const removeDestination = "-";
const mapColumns = ["key", "linux", "windows", "macos"] as const;
type Platform = "windows" | "linux" | "darwin";
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

async function loadPathMap(mapFilePath: string, platform: Platform): Promise<PathMap> {
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

// Applies the platform column of the map to dist once: removals first, then
// moves. Entries created after this point (later local hooks) keep their
// place as generated.
async function applyPathMap(
  mapFilePath: string,
  distDir: string,
  platform: Platform,
): Promise<void> {
  const { removals, moves } = await loadPathMap(mapFilePath, platform);
  await removeMappedEntries(distDir, "", removals);
  await moveMappedEntries(distDir, moves);
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

// The top-level await sits after every declaration so no constant is read
// before initialization.
await applyPathMap(join(import.meta.dir, mapFileName), process.cwd(), currentPlatform());
