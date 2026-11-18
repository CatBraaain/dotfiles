// Dry-run difference engine between a dist tree and a home tree.
// Walks dist, maps every entry to its home-relative path (spec:
// SPEC.md §差分検知), classifies it, and reports the result.
// Reads both trees only; never writes to either.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expandHomeRoot, positionalArguments } from "./args.ts";
import { compareCodeUnits, entryDiffers, lstatOrNull } from "./compare.ts";
import { fileOperationConcurrency, IoLimiter } from "./concurrency.ts";
import { renderDiffs } from "./diff-render.ts";
import { mapSegment, type EntryKind } from "./path-mapping.ts";
import type { Stats } from "node:fs";

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

const usage =
  "usage: bun dotfiles-manager/src/diff.ts [--managed] [--json] [distRoot] [homeRoot] (defaults: dist, ~)";

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
  await walk(
    "",
    "",
    { isExactScope: false, scanForSurplus: false },
    { distRoot, homeRoot, platform, result, limiter: new IoLimiter(fileOperationConcurrency) },
  );
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
  if (options.managed) {
    // Managed entries: every dist-mapped home entry regardless of difference,
    // in tree order. Surplus removals (removedExact) are not listed.
    const managedPaths = [
      ...result.unchanged,
      ...result.changed,
      ...result.typeMismatches,
      ...result.added,
    ]
      .map(paths)
      .sort(compareCodeUnits);
    for (const homePath of managedPaths) {
      // A closed pipe (e.g. `| head`) must not turn into a stack trace.
      try {
        process.stdout.write(`${homePath}\n`);
      } catch {
        break;
      }
    }
    return 0;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(toDiffJson(result), null, 2)}\n`);
  } else {
    await renderDiffs(result, options);
  }
  return 0;
}

export function parseArgs(argv: readonly string[]): {
  managed: boolean;
  json: boolean;
  distRoot: string;
  homeRoot: string;
} {
  const managed = argv.includes("--managed");
  const json = argv.includes("--json");
  const positional = positionalArguments(argv, ["--json", "--managed"]);
  if (positional.length > 2) throw new Error(usage);
  const [distRoot = "dist", homeRootArgument = "~"] = positional;
  return {
    managed,
    json,
    distRoot,
    homeRoot: expandHomeRoot(homeRootArgument),
  };
}

// ------------------------------------------------------------- walk & diff

type WalkContext = {
  distRoot: string;
  homeRoot: string;
  platform: string;
  result: DiffResult;
  limiter: IoLimiter;
};

type WalkScope = { isExactScope: boolean; scanForSurplus: boolean };

async function walk(
  distRel: string,
  homeRel: string,
  scope: WalkScope,
  ctx: WalkContext,
): Promise<void> {
  const distDir = join(ctx.distRoot, distRel);
  const homeDir = join(ctx.homeRoot, homeRel);
  const knownHomeNames = new Set<string>();
  const entries = await ctx.limiter.run(() => readdir(distDir, { withFileTypes: true }));
  const tasks: Promise<void>[] = [];

  for (const entry of entries) {
    const mapping = mapSegment(entry.name, entry.isDirectory());
    // Track every dist entry's home name (excluded ones included) so the
    // surplus scan below never counts a mapped counterpart as surplus.
    knownHomeNames.add(mapping.homeName);
    if (mapping.isExcluded) continue;

    const childDistRel = distRel === "" ? entry.name : `${distRel}/${entry.name}`;
    const childHomeRel = homeRel === "" ? mapping.homeName : `${homeRel}/${mapping.homeName}`;
    const distAbs = join(distDir, entry.name);
    const homeAbs = join(homeDir, mapping.homeName);
    tasks.push(
      (async () => {
        const homeStat = await ctx.limiter.run(() => lstatOrNull(homeAbs));

        if (!homeStat) {
          ctx.result.added.push({ homePath: childHomeRel, distPath: childDistRel });
          if (entry.isDirectory()) await collectAddedTree(childDistRel, childHomeRel, ctx);
          return;
        }

        const homeKind = kindOfStat(homeStat);
        if (homeKind !== mapping.kind) {
          ctx.result.typeMismatches.push({ homePath: childHomeRel, distPath: childDistRel });
          return;
        }

        if (mapping.kind === "directory") {
          ctx.result.unchanged.push({ homePath: childHomeRel, distPath: childDistRel });
          // Exact scope covers only the direct children of a .exact directory
          // (spec §.exact の解釈); it does not propagate into child directories.
          const childIsExactScope = mapping.isExactManaged;
          await walk(
            childDistRel,
            childHomeRel,
            { isExactScope: childIsExactScope, scanForSurplus: true },
            ctx,
          );
          return;
        }

        const differs = await ctx.limiter.run(() =>
          entryDiffers(distAbs, homeAbs, mapping, homeStat, ctx.platform),
        );
        ctx.result[differs ? "changed" : "unchanged"].push({
          homePath: childHomeRel,
          distPath: childDistRel,
        });
      })(),
    );
  }
  await Promise.all(tasks);

  // Surplus scan: only below dist-managed directories (never at the home
  // root). Unmanaged top-level home entries are ignored.
  if (!scope.scanForSurplus) return;
  const homeEntries = await ctx.limiter.run(() => readdir(homeDir, { withFileTypes: true }));
  for (const homeEntry of homeEntries) {
    if (knownHomeNames.has(homeEntry.name)) continue;
    const surplusRel = homeRel === "" ? homeEntry.name : `${homeRel}/${homeEntry.name}`;
    // A surplus directory is reported as one entry (removed with its subtree
    // on apply), so its contents are not enumerated.
    ctx.result[scope.isExactScope ? "removedExact" : "removedIgnored"].push({
      homePath: surplusRel,
      distPath: null,
    });
  }
}

async function collectAddedTree(distRel: string, homeRel: string, ctx: WalkContext): Promise<void> {
  const entries = await ctx.limiter.run(() =>
    readdir(join(ctx.distRoot, distRel), { withFileTypes: true }),
  );
  const tasks: Promise<void>[] = [];
  for (const entry of entries) {
    const mapping = mapSegment(entry.name, entry.isDirectory());
    if (mapping.isExcluded) continue;
    const childDistRel = `${distRel}/${entry.name}`;
    const childHomeRel = `${homeRel}/${mapping.homeName}`;
    ctx.result.added.push({ homePath: childHomeRel, distPath: childDistRel });
    if (entry.isDirectory()) tasks.push(collectAddedTree(childDistRel, childHomeRel, ctx));
  }
  await Promise.all(tasks);
}

function kindOfStat(stat: Stats): EntryKind {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  return "file";
}

function paths(entry: DiffEntry): string {
  return entry.homePath;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
