// Dry-run difference engine between a dist tree and a home tree.
// Walks dist, maps every entry to its home-relative path (spec:
// dotfiles-manager.spec.md §差分検知), classifies it, and reports the result.
// Reads both trees only; never writes to either.

// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { homedir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join } from "node:path";

declare const Bun: {
  spawn(
    command: string[],
    options: { stdout: "inherit"; stderr: "inherit" },
  ): { exited: Promise<number> };
};
declare const process: {
  argv: string[];
  platform: string;
  execPath: string;
  exitCode: number;
  stdout: { write(data: string): void };
};
declare const console: { error(...data: unknown[]): void };
declare global {
  interface ImportMeta {
    readonly main: boolean;
    readonly dir: string;
  }
}

export type EntryKind = "file" | "directory" | "symlink";
export type Classification =
  | "unchanged"
  | "changed"
  | "typeMismatches"
  | "added"
  | "removedExact"
  | "removedIgnored";

/** distPath is the dist-relative posix path (null for surplus entries). */
export type DiffEntry = { homePath: string; distPath: string | null };
export type DiffResult = Record<Classification, DiffEntry[]>;
export type DiffJson = {
  changed: string[];
  typeMismatches: string[];
  added: string[];
  removedExact: string[];
  removedIgnored: string[];
};

type StatsLike = {
  mode: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};
type DirentLike = { name: string; isDirectory(): boolean };

const usage =
  "usage: bun scripts/home-diff.ts [--json] [distRoot] [homeRoot] (defaults: dist, ~)";

// ---------------------------------------------------------------- public API

export async function collectDifferences(
  distRoot: string,
  homeRoot: string,
  platform: string = process.platform,
): Promise<DiffResult> {
  for (const [label, path] of [
    ["dist root", distRoot],
    ["home root", homeRoot],
  ] as const) {
    const stat = await lstatOrNull(path);
    if (!stat || !stat.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  }

  const result: DiffResult = {
    unchanged: [],
    changed: [],
    typeMismatches: [],
    added: [],
    removedExact: [],
    removedIgnored: [],
  };
  await walk("", "", false, false, { distRoot, homeRoot, platform, result });
  for (const entries of Object.values(result))
    entries.sort((a, b) => compareCodeUnits(a.homePath, b.homePath));
  return result;
}

export function toDiffJson(result: DiffResult): DiffJson {
  return {
    changed: result.changed.map(paths),
    typeMismatches: result.typeMismatches.map(paths),
    added: result.added.map(paths),
    removedExact: result.removedExact.map(paths),
    removedIgnored: result.removedIgnored.map(paths),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const result = await collectDifferences(options.distRoot, options.homeRoot);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(toDiffJson(result), null, 2)}\n`);
  } else {
    await renderDiffs(result, options);
  }
  return 0;
}

export function parseArgs(
  argv: readonly string[],
): { json: boolean; distRoot: string; homeRoot: string } {
  const json = argv.includes("--json");
  const positional = argv.filter((arg) => arg !== "--json");
  if (positional.length > 2) throw new Error(usage);
  const [distRoot = "dist", homeRootArgument = "~"] = positional;
  return { json, distRoot, homeRoot: homeRootArgument === "~" ? homedir() : homeRootArgument };
}

// ------------------------------------------------------------ path mapping

const excludedEntryPrefixes = [".pre-chezmoi", ".pre-apply", ".post-apply"];
// Files only: run_ scripts are never placed into home, and .chezmoi* files are
// chezmoi's own configuration, not managed entries.
const excludedFilePrefixes = ["run_", ".chezmoi"];

export type SegmentMapping = {
  homeName: string;
  kind: EntryKind;
  isExactManaged: boolean;
  isExecutable: boolean;
  isExcluded: boolean;
};

export function mapSegment(name: string, isDirectory: boolean): SegmentMapping {
  const isExcluded =
    excludedEntryPrefixes.some((prefix) => name.startsWith(prefix)) ||
    (!isDirectory && excludedFilePrefixes.some((prefix) => name.startsWith(prefix)));
  if (isExcluded)
    return {
      homeName: name,
      kind: isDirectory ? "directory" : "file",
      isExactManaged: false,
      isExecutable: false,
      isExcluded: true,
    };

  if (isDirectory && name.endsWith(".exact"))
    return {
      homeName: name.slice(0, -".exact".length),
      kind: "directory",
      isExactManaged: true,
      isExecutable: false,
      isExcluded: false,
    };
  if (!isDirectory && name.endsWith(".executable"))
    return {
      homeName: name.slice(0, -".executable".length),
      kind: "file",
      isExactManaged: false,
      isExecutable: true,
      isExcluded: false,
    };
  if (!isDirectory && name.endsWith(".symlink"))
    return {
      homeName: name.slice(0, -".symlink".length),
      kind: "symlink",
      isExactManaged: false,
      isExecutable: false,
      isExcluded: false,
    };

  // Transitional: the current pipeline (pre-chezmoi.ts) renames entries into
  // chezmoi source naming (dot_/exact_/executable_/symlink_) before diff
  // detection runs, so digest those prefixes to work against today's dist.
  // Once the rename step is gone this block only ever sees plain names.
  let rest = name;
  let homeNamePrefix = "";
  let isExactManaged = false;
  let isExecutable = false;
  let isSymlink = false;
  for (;;) {
    if (isDirectory && rest.startsWith("exact_")) {
      isExactManaged = true;
      rest = rest.slice("exact_".length);
      continue;
    }
    if (rest.startsWith("executable_")) {
      isExecutable = true;
      rest = rest.slice("executable_".length);
      continue;
    }
    if (rest.startsWith("symlink_")) {
      isSymlink = true;
      rest = rest.slice("symlink_".length);
      continue;
    }
    if (rest.startsWith("dot_")) {
      homeNamePrefix += ".";
      rest = rest.slice("dot_".length);
      continue;
    }
    break;
  }
  return {
    homeName: homeNamePrefix + rest,
    kind: isDirectory ? "directory" : isSymlink ? "symlink" : "file",
    isExactManaged,
    isExecutable,
    isExcluded: false,
  };
}

// ------------------------------------------------------------- walk & diff

type WalkContext = {
  distRoot: string;
  homeRoot: string;
  platform: string;
  result: DiffResult;
};

async function walk(
  distRel: string,
  homeRel: string,
  isExactScope: boolean,
  scanForSurplus: boolean,
  ctx: WalkContext,
): Promise<void> {
  const distDir = join(ctx.distRoot, distRel);
  const homeDir = join(ctx.homeRoot, homeRel);
  const knownHomeNames = new Set<string>();

  for (const entry of await readdir(distDir, { withFileTypes: true }) as unknown as DirentLike[]) {
    if (entry.name === "node_modules") continue;
    const mapping = mapSegment(entry.name, entry.isDirectory());
    // Track every dist entry's home name (excluded ones included) so the
    // surplus scan below never counts a mapped counterpart as surplus.
    knownHomeNames.add(mapping.homeName);
    if (mapping.isExcluded) continue;

    const childDistRel = distRel === "" ? entry.name : `${distRel}/${entry.name}`;
    const childHomeRel = homeRel === "" ? mapping.homeName : `${homeRel}/${mapping.homeName}`;
    const distAbs = join(distDir, entry.name);
    const homeAbs = join(homeDir, mapping.homeName);
    const homeStat = await lstatOrNull(homeAbs);

    if (!homeStat) {
      ctx.result.added.push({ homePath: childHomeRel, distPath: childDistRel });
      if (entry.isDirectory())
        await collectAddedTree(childDistRel, childHomeRel, ctx);
      continue;
    }

    const homeKind = kindOfStat(homeStat);
    if (homeKind !== mapping.kind) {
      ctx.result.typeMismatches.push({ homePath: childHomeRel, distPath: childDistRel });
      continue;
    }

    if (mapping.kind === "directory") {
      await walk(
        childDistRel,
        childHomeRel,
        isExactScope || mapping.isExactManaged,
        true,
        ctx,
      );
      continue;
    }

    const differs =
      mapping.kind === "symlink"
        ? await symlinkDiffers(distAbs, homeAbs)
        : (await fileDiffers(distAbs, homeAbs, mapping.homeName)) ||
          (comparesExecutableBits(ctx.platform) &&
            executableDiffers(mapping.isExecutable, homeStat));
    ctx.result[differs ? "changed" : "unchanged"].push({
      homePath: childHomeRel,
      distPath: childDistRel,
    });
  }

  // Surplus scan: only below dist-managed directories (never at the home root,
  // matching chezmoi, which ignores unmanaged top-level home entries).
  if (!scanForSurplus) return;
  for (const homeEntry of await readdir(homeDir, { withFileTypes: true }) as unknown as DirentLike[]) {
    if (knownHomeNames.has(homeEntry.name)) continue;
    const surplusRel = homeRel === "" ? homeEntry.name : `${homeRel}/${homeEntry.name}`;
    // A surplus directory is reported as one entry (removed with its subtree
    // on apply), so its contents are not enumerated.
    ctx.result[isExactScope ? "removedExact" : "removedIgnored"].push({
      homePath: surplusRel,
      distPath: null,
    });
  }
}

async function collectAddedTree(
  distRel: string,
  homeRel: string,
  ctx: WalkContext,
): Promise<void> {
  for (const entry of await readdir(join(ctx.distRoot, distRel), {
    withFileTypes: true,
  }) as unknown as DirentLike[]) {
    if (entry.name === "node_modules") continue;
    const mapping = mapSegment(entry.name, entry.isDirectory());
    if (mapping.isExcluded) continue;
    const childDistRel = `${distRel}/${entry.name}`;
    const childHomeRel = `${homeRel}/${mapping.homeName}`;
    ctx.result.added.push({ homePath: childHomeRel, distPath: childDistRel });
    if (entry.isDirectory()) await collectAddedTree(childDistRel, childHomeRel, ctx);
  }
}

async function fileDiffers(
  distAbs: string,
  homeAbs: string,
  homeName: string,
): Promise<boolean> {
  const [distText, homeText] = await Promise.all([
    readFile(distAbs, "utf8"),
    readFile(homeAbs, "utf8"),
  ]);
  const jsonAware = isJsonName(homeName);
  return (
    normalizeText(distText, jsonAware) !== normalizeText(homeText, jsonAware)
  );
}

async function symlinkDiffers(distAbs: string, homeAbs: string): Promise<boolean> {
  const rawTarget = await readFile(distAbs, "utf8");
  const expectedTarget = rawTarget.endsWith("\n") ? rawTarget.slice(0, -1) : rawTarget;
  return expectedTarget !== (await readlink(homeAbs));
}

function executableDiffers(distExpectsExecutable: boolean, homeStat: StatsLike): boolean {
  const homeHasOwnerExecute = (homeStat.mode & 0o100) !== 0;
  return distExpectsExecutable !== homeHasOwnerExecute;
}

function comparesExecutableBits(platform: string): boolean {
  return platform === "linux" || platform === "darwin";
}

function kindOfStat(stat: StatsLike): EntryKind {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  return "file";
}

async function lstatOrNull(path: string): Promise<StatsLike | null> {
  try {
    return (await lstat(path)) as unknown as StatsLike;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

// ------------------------------------------------------------- normalizing

// spec §差分検知: strip CR before comparing (CRLF == LF), then ignore one
// trailing newline; for .json/.jsonc also ignore whitespace/trailing commas
// before closing braces (same rules as scripts/chezmoi-diff.ts).
function normalizeText(text: string, jsonAware: boolean): string {
  const withoutCarriageReturns = text.replaceAll("\r", "");
  const withoutTrailingNewline = withoutCarriageReturns.endsWith("\n")
    ? withoutCarriageReturns.slice(0, -1)
    : withoutCarriageReturns;
  return jsonAware ? stripTrailingCommas(withoutTrailingNewline) : withoutTrailingNewline;
}

function stripTrailingCommas(text: string): string {
  return text
    .split(/("(?:[^"\\]|\\.)*")/)
    .map((part, index) =>
      index % 2 === 0 ? part.replace(/[\s,]*(?=[}\]])/g, "") : part,
    )
    .join("");
}

function isJsonName(name: string): boolean {
  const lowercaseName = name.toLowerCase();
  return lowercaseName.endsWith(".json") || lowercaseName.endsWith(".jsonc");
}

// -------------------------------------------------------------- rendering

async function renderDiffs(
  result: DiffResult,
  options: { distRoot: string; homeRoot: string },
): Promise<void> {
  const chezmoiDiffScript = join(import.meta.dir, "chezmoi-diff.ts");
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const renderTargets: Array<{ destination: string; target: string }> = [];
  for (const entry of result.changed)
    renderTargets.push({
      destination: join(options.homeRoot, entry.homePath),
      target: distAbsolutePath(entry, options.distRoot),
    });
  for (const entry of result.typeMismatches)
    renderTargets.push({
      destination: join(options.homeRoot, entry.homePath),
      target: distAbsolutePath(entry, options.distRoot),
    });
  for (const entry of result.added)
    renderTargets.push({
      destination: nullDevice,
      target: distAbsolutePath(entry, options.distRoot),
    });
  for (const entry of result.removedExact)
    renderTargets.push({
      destination: join(options.homeRoot, entry.homePath),
      target: nullDevice,
    });

  for (const { destination, target } of renderTargets) {
    // Display-only: exit code belongs to chezmoi-diff.ts, not this engine.
    const diff = Bun.spawn(
      [process.execPath, chezmoiDiffScript, destination, target],
      { stdout: "inherit", stderr: "inherit" },
    );
    await diff.exited;
  }
}

function paths(entry: DiffEntry): string {
  return entry.homePath;
}

// Surplus entries have no dist counterpart; rendering helpers that need a
// dist path never receive one, so this guard just makes that explicit.
function distAbsolutePath(entry: DiffEntry, distRoot: string): string {
  if (entry.distPath === null) throw new Error(`entry has no dist path: ${entry.homePath}`);
  return join(distRoot, entry.distPath);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
