// Apply engine between a dist tree and a home tree (spec:
// SPEC.md §適用, §フックシステム, §apply スクリプト).
// Consumes the classification produced by diff.ts, writes the home tree,
// and runs apply scripts. The build stage (dist generation) is a separate
// stage and not part of this file.
import * as fsPromises from "node:fs/promises";
const { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, symlink } = fsPromises;
import { dirname, join, resolve } from "node:path";
import { expandHomeRoot, positionalArguments } from "./args.ts";
import { comparesExecutableBits, readSymlinkTarget } from "./compare.ts";
import { collectDifferences, main as diffMain, type DiffEntry, type DiffResult } from "./diff.ts";
import {
  ensureHookDirectory,
  removeEmptyHookDirectories,
  resolveHookCommand,
} from "./hook-runner.ts";
import { isApplyScriptName, mapSegment } from "./path-mapping.ts";

export type ApplyResult = { added: string[]; changed: string[]; removed: string[] };
export type ApplyScript = {
  distPath: string;
  fileName: string;
  folderRel: string;
  homeFolderRel: string;
  contents: string;
};
export type Declarations = {
  applyScripts: ApplyScript[];
};

type RenameFile = (source: string, destination: string) => Promise<void>;

const usage = "usage: bun dotfiles-manager/src/apply.ts [--dry-run] <distRoot> <homeRoot> [--json]";

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
  renameFile: RenameFile = rename,
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

  const entries: Array<{ entry: DiffEntry; isChange: boolean; recurseDirectory: boolean }> = [
    ...result.added.map((entry) => ({ entry, isChange: false, recurseDirectory: false })),
    ...result.typeMismatches.map((entry) => ({ entry, isChange: false, recurseDirectory: true })),
    ...result.changed.map((entry) => ({ entry, isChange: true, recurseDirectory: false })),
  ].sort((left, right) => compareCodeUnits(left.entry.homePath, right.entry.homePath));
  for (const { entry, isChange, recurseDirectory } of entries)
    await applyEntry(
      distRoot,
      homeRoot,
      entry,
      isChange,
      recurseDirectory,
      platform,
      applied,
      renameFile,
    );

  applied.added.sort(compareCodeUnits);
  applied.changed.sort(compareCodeUnits);
  applied.removed.sort(compareCodeUnits);
  return applied;
}

// Finds apply scripts in a built dist tree (spec §apply スクリプト).
// Folders excluded from diffing are skipped; ordering is the full
// dist-relative path in UTF-16 code-unit order.
export async function collectDeclarations(distRoot: string): Promise<Declarations> {
  const declarations: Declarations = { applyScripts: [] };
  await walkDeclarations(distRoot, "", declarations);
  declarations.applyScripts.sort((left, right) => compareCodeUnits(left.distPath, right.distPath));
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
    const scriptDirectory = dirname(join(distRoot, script.distPath));
    const createdDirectories = await ensureHookDirectory(scriptDirectory, distRoot);
    await mkdir(cwd, { recursive: true });

    try {
      const command = resolveHookCommand(script.contents, script.distPath, "apply", cwd);
      await spawnChild(
        command,
        scriptDirectory,
        "ignore",
        `apply script failed: ${script.distPath}`,
      );
    } finally {
      await removeEmptyHookDirectories(createdDirectories);
    }
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
  const positional = positionalArguments(rest, ["--json"]);
  if (positional.length < 2) throw new Error(usage);
  return {
    dryRun,
    distRoot: positional[0]!,
    homeRoot: expandHomeRoot(positional[1]!),
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

  const diffStarted = performance.now();
  const result = await collectDifferences(distRoot, homeRoot);
  writeLine(
    `diff: ${result.changed.length} changed, ${result.typeMismatches.length} type mismatches, ` +
      `${result.added.length} added, ${result.removedExact.length} surplus (exact), ` +
      `${result.removedIgnored.length} surplus (ignored) (${elapsedSeconds(diffStarted)}s)`,
  );

  const applyStarted = performance.now();
  const applied = await applyDifferences(distRoot, homeRoot, result);
  writeLine(
    `apply: ${applied.added.length} added, ${applied.changed.length} changed, ` +
      `${applied.removed.length} removed (${elapsedSeconds(applyStarted)}s)`,
  );

  const scriptsStarted = performance.now();
  const declarations = await collectDeclarations(distRoot);
  await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);
  writeLine(
    `apply scripts: ${declarations.applyScripts.length} scripts (${elapsedSeconds(scriptsStarted)}s)`,
  );
  return 0;
}

// ------------------------------------------------------------------ applying

let tempCounter = 0;

async function applyEntry(
  distRoot: string,
  homeRoot: string,
  entry: DiffEntry,
  isChange: boolean,
  recurseDirectory: boolean,
  platform: string,
  applied: ApplyResult,
  renameFile: RenameFile,
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
      // Added directory children are listed separately; type-mismatch children are not.
      if (recurseDirectory)
        await applyTree(
          distRoot,
          homeRoot,
          entry.distPath,
          entry.homePath,
          platform,
          applied,
          renameFile,
        );
    } else if (mapping.kind === "symlink") {
      // A .symlink entry is a plain file in dist; the target is its content
      // with one trailing newline stripped (spec §.symlink の解釈).
      await rm(homeAbs, { force: true });
      await symlink(await readSymlinkTarget(distAbs), homeAbs);
    } else {
      // Atomic write: build the new file beside the target, then rename it in,
      // so no half-written state ever appears at the home path.
      const tempPath = `${homeAbs}.apply-tmp-${process.pid}-${tempCounter++}`;
      await copyFile(distAbs, tempPath);
      if (comparesExecutableBits(platform)) {
        const mode = stat.mode & 0o7777;
        await chmod(tempPath, mapping.isExecutable ? mode | 0o100 : mode & ~0o100);
      } else if (isChange) {
        // Preserve the existing mode when replacing content on Windows;
        // copyFile otherwise carries the dist file's executable bit over.
        const previous = await lstat(homeAbs);
        await chmod(tempPath, previous.mode & 0o7777);
      }
      await renameFile(tempPath, homeAbs);
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
  renameFile: RenameFile,
): Promise<void> {
  for (const dirent of await readdir(join(distRoot, distRel), { withFileTypes: true })) {
    const mapping = mapSegment(dirent.name, dirent.isDirectory());
    if (mapping.isExcluded) continue;
    await applyEntry(
      distRoot,
      homeRoot,
      { homePath: `${homeRel}/${mapping.homeName}`, distPath: `${distRel}/${dirent.name}` },
      false,
      true,
      platform,
      applied,
      renameFile,
    );
  }
}

// ------------------------------------------------------- declarations lookup

async function walkDeclarations(dirAbs: string, dirRel: string, out: Declarations): Promise<void> {
  for (const entry of await readdir(dirAbs, { withFileTypes: true })) {
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
        contents: await readFile(join(dirAbs, entry.name), "utf8"),
      });
  }
}

// Map each dist directory segment to its home name, including .exact suffixes.
function homeFolderOf(folderRel: string): string {
  if (folderRel === "") return "";
  return folderRel
    .split("/")
    .map((name) => mapSegment(name, true).homeName)
    .join("/");
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
    // stdin: "pipe" is requested for this spawn, so the stream always exists.
    proc.stdin!.write(stdin);
    proc.stdin!.end();
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

function elapsedSeconds(started: number): string {
  return ((performance.now() - started) / 1000).toFixed(2);
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(messageOf(error));
    process.exitCode = 1;
  }
}
