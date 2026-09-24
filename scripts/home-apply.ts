// Apply engine between a dist tree and a home tree (spec:
// dotfiles-manager.spec.md §適用, §フックシステム, §run_ スクリプト).
// Consumes the classification produced by home-diff.ts, writes the home tree,
// and runs pre/post-apply hooks and run_ scripts. The build stage (dist
// generation) is a separate stage and not part of this file.

// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, symlink } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { homedir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { dirname, join } from "node:path";
import {
  collectDifferences,
  main as diffMain,
  mapSegment,
  type DiffEntry,
  type DiffResult,
} from "./home-diff.ts";

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
export type HookPayload = { added: string[]; changed: string[]; removed: string[] };
export type LifecycleHook = { distPath: string; folderRel: string; homeFolderRel: string };
export type RunScript = {
  distPath: string;
  fileName: string;
  folderRel: string;
  homeFolderRel: string;
};
export type Declarations = {
  preApply: LifecycleHook[];
  postApply: LifecycleHook[];
  runScripts: RunScript[];
};

type DirentLike = { name: string; isDirectory(): boolean; isFile(): boolean };

const usage = "usage: bun scripts/home-apply.ts [--dry-run] <distRoot> <homeRoot> [--json]";

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

// Finds .pre-apply.ts / .post-apply.ts hooks and run_ scripts in a built dist
// tree (spec §フックシステム, §run_ スクリプト). node_modules and folders whose
// names are excluded from diffing are skipped; ordering is folder-relative
// path first (parents before children), then file name.
export async function collectDeclarations(distRoot: string): Promise<Declarations> {
  const declarations: Declarations = { preApply: [], postApply: [], runScripts: [] };
  await walkDeclarations(distRoot, "", declarations);
  declarations.preApply.sort((left, right) => compareFolderRel(left.folderRel, right.folderRel));
  declarations.postApply.sort((left, right) => compareFolderRel(left.folderRel, right.folderRel));
  declarations.runScripts.sort(
    (left, right) =>
      compareFolderRel(left.folderRel, right.folderRel) ||
      compareCodeUnits(left.fileName, right.fileName),
  );
  return declarations;
}

// Runs pre/post-apply hooks (spec §フックシステム): each hook is a separate
// bun child process with its cwd at the hook folder's home directory (created
// if missing), receiving the payload scoped to its folder as JSON on stdin.
// A non-zero exit aborts the remaining hooks.
export async function runLifecycleHooks(
  hooks: LifecycleHook[],
  distRoot: string,
  homeRoot: string,
  payload: HookPayload,
  label: string,
): Promise<void> {
  for (const hook of hooks) {
    const cwd = join(homeRoot, hook.homeFolderRel);
    await mkdir(cwd, { recursive: true });
    const stdinText = JSON.stringify(scopedPayload(payload, hook.homeFolderRel));
    await spawnChild(
      [process.execPath, join(distRoot, hook.distPath)],
      cwd,
      stdinText,
      `${label} failed: ${hook.distPath}`,
    );
  }
}

// Runs run_ scripts (spec §run_ スクリプト) after the post-apply hooks: each
// script runs with its cwd at the script folder's home directory (created if
// missing), via its shebang interpreter or pwsh for .ps1. A non-zero exit
// aborts the remaining scripts.
export async function runRunScripts(
  runs: RunScript[],
  distRoot: string,
  homeRoot: string,
): Promise<void> {
  for (const run of runs) {
    const cwd = join(homeRoot, run.homeFolderRel);
    await mkdir(cwd, { recursive: true });
    const command = await resolveRunCommand(run, join(distRoot, run.distPath));
    command.push(join(distRoot, run.distPath));
    await spawnChild(command, cwd, "ignore", `run script failed: ${run.distPath}`);
  }
}

// Hook payload of the planned apply (spec §フックシステム): additions and
// changes, plus removals from removal propagation. Type mismatches appear
// both as a removal (the old entry) and an addition (the new one).
export function plannedPayload(result: DiffResult): HookPayload {
  return {
    added: pathsOf([...result.added, ...result.typeMismatches]),
    changed: pathsOf(result.changed),
    removed: pathsOf([...result.removedExact, ...result.typeMismatches]),
  };
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

// Lifecycle without the build stage: diff detection → pre-apply hooks →
// apply → post-apply hooks → run_ scripts. --dry-run renders the diff only
// (no writes, no hooks, no run scripts).
export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.dryRun) return diffMain(options.rest);
  const { distRoot, homeRoot } = options;

  const result = await collectDifferences(distRoot, homeRoot);
  writeLine(
    `diff: ${result.changed.length} changed, ${result.typeMismatches.length} type mismatches, ` +
      `${result.added.length} added, ${result.removedExact.length} surplus (exact), ` +
      `${result.removedIgnored.length} surplus (ignored)`,
  );

  const declarations = await collectDeclarations(distRoot);
  await runLifecycleHooks(
    declarations.preApply,
    distRoot,
    homeRoot,
    plannedPayload(result),
    "pre-apply hook",
  );
  writeLine(`pre-apply: ${declarations.preApply.length} hooks`);

  const applied = await applyDifferences(distRoot, homeRoot, result);
  writeLine(
    `apply: ${applied.added.length} added, ${applied.changed.length} changed, ` +
      `${applied.removed.length} removed`,
  );

  await runLifecycleHooks(
    declarations.postApply,
    distRoot,
    homeRoot,
    applied,
    "post-apply hook",
  );
  writeLine(`post-apply: ${declarations.postApply.length} hooks`);

  await runRunScripts(declarations.runScripts, distRoot, homeRoot);
  writeLine(`run: ${declarations.runScripts.length} scripts`);
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
    if (entry.name === ".pre-apply.ts" || entry.name === ".post-apply.ts")
      out[entry.name === ".pre-apply.ts" ? "preApply" : "postApply"].push({
        distPath: childRel,
        folderRel: dirRel,
        homeFolderRel: homeFolderOf(dirRel),
      });
    else if (entry.name.startsWith("run_"))
      out.runScripts.push({
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

async function resolveRunCommand(run: RunScript, runAbs: string): Promise<string[]> {
  const content = await readFile(runAbs, "utf8");
  const firstLine = content.split("\n", 1)[0] ?? "";
  if (firstLine.startsWith("#!")) {
    const parts = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) throw new Error(`run script has an empty shebang: ${run.distPath}`);
    return parts;
  }
  if (run.fileName.toLowerCase().endsWith(".ps1")) return ["pwsh"];
  throw new Error(`run script has neither a shebang nor a .ps1 extension: ${run.distPath}`);
}

// -------------------------------------------------------------------- helpers

function scopedPayload(payload: HookPayload, folder: string): HookPayload {
  return {
    added: payload.added.filter((homePath) => isInFolder(homePath, folder)),
    changed: payload.changed.filter((homePath) => isInFolder(homePath, folder)),
    removed: payload.removed.filter((homePath) => isInFolder(homePath, folder)),
  };
}

function isInFolder(homePath: string, folder: string): boolean {
  return folder === "" || homePath === folder || homePath.startsWith(`${folder}/`);
}

function pathsOf(entries: DiffEntry[]): string[] {
  return entries.map((entry) => entry.homePath).sort(compareCodeUnits);
}

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
