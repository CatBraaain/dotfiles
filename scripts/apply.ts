// Apply engine between a dist tree and a home tree (spec:
// SPEC.md §適用, §フックシステム, §apply スクリプト).
// Consumes the classification produced by diff.ts, writes the home tree,
// and runs apply scripts. The build stage (dist generation) is a separate
// stage and not part of this file.

// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import * as fsPromises from "node:fs/promises";
const { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, symlink } = fsPromises;
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { homedir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { dirname, join, resolve } from "node:path";
import {
  collectDifferences,
  isApplyScriptName,
  main as diffMain,
  mapSegment,
  type DiffEntry,
  type DiffResult,
} from "./diff.ts";
import { resolveHookCommand } from "./hook-runner.ts";

declare const Bun: {
  spawn(
    command: string[],
    options: {
      cwd: string;
      stdin: "ignore" | "pipe";
      stdout: "inherit";
      stderr: "inherit";
    },
  ): {
    exited: Promise<number>;
    signalCode: string | null;
    stdin: { write(data: string): void; end(): void };
  };
};
declare const process: {
  argv: string[];
  platform: string;
  pid: number;
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

export type ApplyResult = { added: string[]; changed: string[]; removed: string[] };
export type ApplyScript = {
  distPath: string;
  fileName: string;
  folderRel: string;
  homeFolderRel: string;
};
export type Declarations = {
  applyScripts: ApplyScript[];
};

type DirentLike = { name: string; isDirectory(): boolean; isFile(): boolean };

const usage = "usage: bun scripts/apply.ts [--dry-run] <distRoot> <homeRoot> [--json]";

// ---------------------------------------------------------------- public API

// Applies a DiffResult to the home tree (spec §適用): surplus entries under
// .exact scope are removed recursively, type mismatches are removed and
// re-created, then additions and changes are applied in tree order. An error
// aborts the remaining entries; already applied entries are not reverted.
export async function applyDifferences(
  distRoot: string,
  homeRoot: string,
  result: DiffResult,
  platform: string = process.platform,
): Promise<ApplyResult> {
  const applied: ApplyResult = { added: [], changed: [], removed: [] };

  for (const entry of result.removedExact) {
    await rm(join(homeRoot, entry.homePath), { recursive: true, force: true });
    applied.removed.push(entry.homePath);
  }

  // Type mismatches: remove the home-side entry; the dist entry is re-created
  // below and reported as an addition.
  for (const entry of result.typeMismatches) {
    await rm(join(homeRoot, entry.homePath), { recursive: true, force: true });
    applied.removed.push(entry.homePath);
  }

  const entries: Array<{ entry: DiffEntry; isChange: boolean }> = [
    ...result.added.map((entry) => ({ entry, isChange: false })),
    ...result.typeMismatches.map((entry) => ({ entry, isChange: false })),
    ...result.changed.map((entry) => ({ entry, isChange: true })),
  ].sort((left, right) => compareCodeUnits(left.entry.homePath, right.entry.homePath));
  for (const { entry, isChange } of entries)
    await applyEntry(distRoot, homeRoot, entry, isChange, platform, applied);

  applied.added.sort(compareCodeUnits);
  applied.changed.sort(compareCodeUnits);
  applied.removed.sort(compareCodeUnits);
  return applied;
}

// Finds apply scripts in a built dist tree (spec §apply スクリプト).
// node_modules and folders whose names are excluded from diffing are skipped;
// ordering is folder-relative path first (parents before children), then file
// name.
export async function collectDeclarations(distRoot: string): Promise<Declarations> {
  const declarations: Declarations = { applyScripts: [] };
  await walkDeclarations(distRoot, "", declarations);
  declarations.applyScripts.sort(
    (left, right) =>
      compareFolderRel(left.folderRel, right.folderRel) ||
      compareCodeUnits(left.fileName, right.fileName),
  );
  return declarations;
}

// Runs TypeScript apply hooks (spec §apply スクリプト) after applying. Each
// runs with its cwd at the script folder's home directory (created if missing).
// A non-zero exit aborts the remaining hooks.
export async function runApplyScripts(
  scripts: ApplyScript[],
  distRoot: string,
  homeRoot: string,
): Promise<void> {
  for (const script of scripts) {
    const cwd = join(homeRoot, script.homeFolderRel);
    await mkdir(cwd, { recursive: true });
    const command = resolveHookCommand(join(distRoot, script.distPath), script.distPath, "apply");

    await spawnChild(command, cwd, "ignore", `apply script failed: ${script.distPath}`);
  }
}

export function parseArgs(argv: readonly string[]): {
  dryRun: boolean;
  distRoot: string;
  homeRoot: string;
  rest: string[];
} {
  const rest = argv.filter((argument) => argument !== "--dry-run");
  const dryRun = rest.length !== argv.length;
  const positional = rest.filter((argument) => argument !== "--json");
  if (positional.length < 2) throw new Error(usage);
  const homeRoot = positional[1]!;
  return {
    dryRun,
    distRoot: positional[0]!,
    homeRoot: homeRoot === "~" ? homedir() : homeRoot,
    rest,
  };
}

// Lifecycle without the build stage: diff detection → apply → apply
// scripts. --dry-run renders the diff only (no writes, no apply scripts).
export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.dryRun) return diffMain(options.rest);
  // Absolute so script paths handed to child interpreters resolve against
  // dist, not against the child cwd at the home-side folder.
  const distRoot = resolve(options.distRoot);
  const { homeRoot } = options;

  const result = await collectDifferences(distRoot, homeRoot);
  writeLine(
    `diff: ${result.changed.length} changed, ${result.typeMismatches.length} type mismatches, ` +
      `${result.added.length} added, ${result.removedExact.length} surplus (exact), ` +
      `${result.removedIgnored.length} surplus (ignored)`,
  );

  const declarations = await collectDeclarations(distRoot);

  const applied = await applyDifferences(distRoot, homeRoot, result);
  writeLine(
    `apply: ${applied.added.length} added, ${applied.changed.length} changed, ` +
      `${applied.removed.length} removed`,
  );

  await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);
  writeLine(`apply scripts: ${declarations.applyScripts.length} scripts`);
  return 0;
}

// ------------------------------------------------------------------ applying

let tempCounter = 0;

async function applyEntry(
  distRoot: string,
  homeRoot: string,
  entry: DiffEntry,
  isChange: boolean,
  platform: string,
  applied: ApplyResult,
): Promise<void> {
  if (entry.distPath === null) throw new Error(`entry has no dist path: ${entry.homePath}`);
  const distAbs = join(distRoot, entry.distPath);
  const homeAbs = join(homeRoot, entry.homePath);
  try {
    await mkdir(dirname(homeAbs), { recursive: true });
    const stat = await lstat(distAbs);
    const mapping = mapSegment(entry.distPath.split("/").pop() ?? "", stat.isDirectory());
    if (mapping.kind === "directory") {
      await mkdir(homeAbs, { recursive: true });
      // A type-mismatch directory's contents are not part of the diff result,
      // so the whole dist subtree is placed here.
      await applyTree(distRoot, homeRoot, entry.distPath, entry.homePath, platform, applied);
    } else if (mapping.kind === "symlink") {
      // A .symlink entry is a plain file in dist; the target is its content
      // with one trailing newline stripped (spec §.symlink の解釈).
      const rawTarget = await readFile(distAbs, "utf8");
      const target = rawTarget.endsWith("\n") ? rawTarget.slice(0, -1) : rawTarget;
      await rm(homeAbs, { force: true });
      await symlink(target, homeAbs);
    } else {
      // Atomic write: build the new file beside the target, then rename it in,
      // so no half-written state ever appears at the home path.
      const tempPath = `${homeAbs}.apply-tmp-${process.pid}-${tempCounter++}`;
      await copyFile(distAbs, tempPath);
      if (comparesExecutableBits(platform)) {
        const mode = stat.mode & 0o7777;
        await chmod(tempPath, mapping.isExecutable ? mode | 0o100 : mode & ~0o100);
      }
      await rename(tempPath, homeAbs);
    }
  } catch (error) {
    throw new Error(`apply failed: ${entry.homePath}: ${messageOf(error)}`);
  }
  (isChange ? applied.changed : applied.added).push(entry.homePath);
}

async function applyTree(
  distRoot: string,
  homeRoot: string,
  distRel: string,
  homeRel: string,
  platform: string,
  applied: ApplyResult,
): Promise<void> {
  for (const dirent of (await readdir(join(distRoot, distRel), {
    withFileTypes: true,
  })) as unknown as DirentLike[]) {
    if (dirent.name === "node_modules") continue;
    const mapping = mapSegment(dirent.name, dirent.isDirectory());
    if (mapping.isExcluded) continue;
    await applyEntry(
      distRoot,
      homeRoot,
      { homePath: `${homeRel}/${mapping.homeName}`, distPath: `${distRel}/${dirent.name}` },
      false,
      platform,
      applied,
    );
  }
}

function comparesExecutableBits(platform: string): boolean {
  return platform === "linux" || platform === "darwin";
}

// ------------------------------------------------------- declarations lookup

async function walkDeclarations(
  dirAbs: string,
  dirRel: string,
  out: Declarations,
): Promise<void> {
  for (const entry of (await readdir(dirAbs, {
    withFileTypes: true,
  })) as unknown as DirentLike[]) {
    if (entry.name === "node_modules") continue;
    const childRel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (mapSegment(entry.name, true).isExcluded) continue;
      await walkDeclarations(join(dirAbs, entry.name), childRel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (isApplyScriptName(entry.name))
      out.applyScripts.push({
        distPath: childRel,
        fileName: entry.name,
        folderRel: dirRel,
        homeFolderRel: homeFolderOf(dirRel),
      });
  }
}

// The home-relative folder for a dist folder: every path segment is mapped
// like a diff entry (exact suffix stripped, transitional dot_ prefix turned
// into a leading dot), matching spec §差分検知 mapping.
function homeFolderOf(folderRel: string): string {
  if (folderRel === "") return "";
  return folderRel
    .split("/")
    .map((name) => mapSegment(name, true).homeName)
    .join("/");
}

// Folder sort: parent folders before children, siblings by UTF-16 code units.
function compareFolderRel(left: string, right: string): number {
  const leftParts = left === "" ? [] : left.split("/");
  const rightParts = right === "" ? [] : right.split("/");
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index++) {
    const leftPart = leftParts[index]!;
    const rightPart = rightParts[index]!;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return leftParts.length - rightParts.length;
}

// ------------------------------------------------------------------ spawning

async function spawnChild(
  command: string[],
  cwd: string,
  stdin: "ignore" | string,
  label: string,
): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd,
    stdin: stdin === "ignore" ? "ignore" : "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (stdin !== "ignore") {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const reason = proc.signalCode ? `signal ${proc.signalCode}` : `exit code ${exitCode}`;
    throw new Error(`${label} (${reason})`);
  }
}

// -------------------------------------------------------------------- helpers

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(messageOf(error));
    process.exitCode = 1;
  }
}
