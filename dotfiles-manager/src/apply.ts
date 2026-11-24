// Apply engine between a dist tree and a home tree (spec:
// SPEC.md §適用, §フックシステム, §apply スクリプト).
// Consumes the classification produced by diff.ts, writes the home tree,
// and runs apply scripts. The build stage (dist generation) is a separate
// stage and not part of this file.
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, normalize, relative, resolve, sep } from "node:path";
import { Stream } from "node:stream";
import { expandHomeRoot, positionalArguments } from "./args.ts";
import {
  compareCodeUnits,
  comparesExecutableBits,
  lstatOrNull,
  readSymlinkTarget,
} from "./compare.ts";
import { collectDifferences, main as diffMain, type DiffEntry, type DiffResult } from "./diff.ts";
import { renderDiffs } from "./diff-render.ts";
import { forwardHookOutput, hookCommand } from "./hook-runner.ts";
import {
  currentPlatform,
  hookPlatform,
  isApplyScriptName,
  isPostHookName,
  mapSegment,
} from "./path-mapping.ts";

export type ApplyResult = { added: string[]; changed: string[]; removed: string[] };
export type ApplyScript = {
  distPath: string;
  fileName: string;
  homeFolderRel: string;
};
export type Declarations = {
  applyScripts: ApplyScript[];
};

type RenameFile = (source: string, destination: string) => Promise<void>;

type ApplyContext = {
  distRoot: string;
  homeRoot: string;
  platform: string;
  applied: ApplyResult;
  renameFile: RenameFile;
};

const usage =
  "usage: bun dotfiles-manager/src/apply.ts [--dry-run] [--yes] <distRoot> <homeRoot> [--json]";

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
  const ctx: ApplyContext = { distRoot, homeRoot, platform, applied, renameFile };
  for (const { entry, isChange, recurseDirectory } of entries)
    await applyEntry(ctx, entry, { isChange, recurseDirectory });

  applied.added.sort(compareCodeUnits);
  applied.changed.sort(compareCodeUnits);
  applied.removed.sort(compareCodeUnits);
  return applied;
}

export async function collectDeclarations(distRoot: string): Promise<Declarations> {
  const declarations: Declarations = { applyScripts: [] };
  const platform = currentPlatform();
  const postScripts = await walkDeclarations(distRoot, "", declarations, platform);
  declarations.applyScripts.sort((left, right) => compareCodeUnits(left.distPath, right.distPath));
  declarations.applyScripts.push(...postScripts);
  return declarations;
}

type StartedScript = { script: ApplyScript; startedAt: number };

type ScriptTarget = StartedScript & { copyPath: string } & (
    | { canonicalCopyPath: string; pathError?: never }
    | { pathError: string; canonicalCopyPath?: never }
  );

type PreparedScript = StartedScript & {
  copyPath: string;
  canonicalCopyPath: string;
  stagingCleanupError?: string;
};

export async function runApplyScripts(
  scripts: ApplyScript[],
  distRoot: string,
  homeRoot: string,
): Promise<string[]> {
  if (scripts.length === 0) return [];
  const startedScripts = scripts.map((script) => {
    const startedAt = performance.now();
    writeLine(`  [${script.distPath}] Started`);
    return { script, startedAt };
  });
  const requestedHome = resolve(homeRoot);
  const canonicalHome = resolveScriptDirectory(requestedHome);
  const targets = await Promise.all(
    startedScripts.map((script) => findScriptTarget(script, requestedHome, canonicalHome)),
  );
  const targetCounts = new Map<string, number>();
  for (const { canonicalCopyPath } of targets) {
    if (canonicalCopyPath === undefined) continue;
    const copyKey = normalizePathKey(canonicalCopyPath);
    targetCounts.set(copyKey, (targetCounts.get(copyKey) ?? 0) + 1);
  }
  const distPaths = new Set(scripts.map(({ distPath }) => normalizePathKey(distPath)));

  const results: Array<string | null> = Array.from({ length: scripts.length }, () => null);
  const tasks: Array<{ entry: PreparedScript; index: number }> = [];
  for (const [index, target] of targets.entries()) {
    const prepared = await prepareScript(target, distRoot, distPaths, targetCounts);
    if (typeof prepared === "string") results[index] = prepared;
    else tasks.push({ entry: prepared, index });
  }

  const normal = tasks.filter(({ entry }) => !isPostHookName(entry.script.fileName));
  const posts = tasks.filter(({ entry }) => isPostHookName(entry.script.fileName));
  await Promise.all(
    normal.map(async ({ entry, index }) => {
      results[index] = await executePrepared(entry, distRoot, homeRoot);
    }),
  );
  for (const { entry, index } of posts)
    results[index] = await executePrepared(entry, distRoot, homeRoot);
  return results.filter((failure) => failure !== null);
}

async function findScriptTarget(
  started: StartedScript,
  requestedHome: string,
  canonicalHome: Promise<string>,
): Promise<ScriptTarget> {
  const { homeFolderRel, fileName } = started.script;
  const copyPath = resolve(requestedHome, homeFolderRel, fileName);
  try {
    const canonicalHomeRoot = await canonicalHome;
    if (!isPathWithin(requestedHome, dirname(copyPath))) {
      throw new Error("home copy path is outside the home root");
    }
    const canonicalCopyPath = await resolveScriptPath(copyPath);
    if (!isPathWithin(canonicalHomeRoot, dirname(canonicalCopyPath))) {
      throw new Error("home copy path is outside the home root");
    }
    return { ...started, copyPath, canonicalCopyPath };
  } catch (error) {
    return { ...started, copyPath, pathError: messageOf(error) };
  }
}

async function prepareScript(
  target: ScriptTarget,
  distRoot: string,
  distPaths: ReadonlySet<string>,
  targetCounts: ReadonlyMap<string, number>,
): Promise<PreparedScript | string> {
  const { script, startedAt, copyPath, canonicalCopyPath, pathError } = target;
  const label = `apply script failed: ${script.distPath}`;
  if (!script.distPath.endsWith(".ts")) {
    writeScriptResult(script, startedAt, false);
    return `apply hook has unsupported extension: ${script.distPath}`;
  }
  try {
    if (canonicalCopyPath === undefined) throw new Error(pathError);
    const copyKey = normalizePathKey(canonicalCopyPath);
    if ((targetCounts.get(copyKey) ?? 0) > 1) throw new Error("conflicting home copy path");

    const sourcePath = resolve(distRoot, script.distPath);
    const source = await lstat(sourcePath);
    if (!source.isFile()) throw new Error("copy source is not a regular file");
    await access(sourcePath, constants.R_OK);

    const sourceKey = normalizePathKey(await realpath(sourcePath));
    const distKey = normalizePathKey(await realpath(distRoot));
    const distRelativeTarget = relative(distKey, copyKey);
    if (copyKey === sourceKey || distPaths.has(distRelativeTarget)) {
      throw new Error("home copy path overlaps a dist declaration");
    }

    const stagingCleanupError = await placeScriptCopy(sourcePath, copyPath);
    return { script, startedAt, copyPath, canonicalCopyPath, stagingCleanupError };
  } catch (error) {
    writeScriptResult(script, startedAt, false);
    return `${label}: ${messageOf(error)}`;
  }
}

async function placeScriptCopy(sourcePath: string, copyPath: string): Promise<string | undefined> {
  const parent = dirname(copyPath);
  await mkdir(parent, { recursive: true });
  await validateScriptFile(copyPath);
  const stagingDir = await mkdtemp(join(parent, ".apply-tmp-"));
  const stagingPath = join(stagingDir, basename(copyPath));
  let stagingCleanupError: string | undefined;
  try {
    await copyFile(sourcePath, stagingPath);
    await rename(stagingPath, copyPath);
  } finally {
    try {
      await rm(stagingDir, { recursive: true, force: true });
    } catch (error) {
      stagingCleanupError = `copy staging cleanup failed: ${messageOf(error)}`;
    }
  }
  return stagingCleanupError;
}

async function executePrepared(
  entry: PreparedScript,
  distRoot: string,
  homeRoot: string,
): Promise<string | null> {
  const { script, startedAt, copyPath, canonicalCopyPath, stagingCleanupError } = entry;
  const label = `apply script failed: ${script.distPath}`;
  const errors: string[] = [];
  try {
    await spawnChild(
      hookCommand(copyPath),
      dirname(copyPath),
      {
        ...process.env,
        DOTFILES_DIST_DIR: resolve(distRoot),
        DOTFILES_HOME_ROOT: resolve(homeRoot),
        DOTFILES_MANAGER_SRC: import.meta.dir,
      },
      label,
      script.distPath,
    );
  } catch (error) {
    errors.push(messageOf(error));
  } finally {
    try {
      if ((await resolveScriptPath(copyPath)) === canonicalCopyPath) {
        if (await validateScriptFile(copyPath)) await unlink(copyPath);
      }
    } catch (error) {
      errors.push(`copy cleanup failed: ${messageOf(error)}`);
    }
  }
  if (stagingCleanupError) errors.push(stagingCleanupError);
  writeScriptResult(script, startedAt, errors.length === 0);
  if (errors.length === 0) return null;
  const diagnostic = errors.join("; ");
  return diagnostic.startsWith(label) ? diagnostic : `${label}: ${diagnostic}`;
}

async function validateScriptFile(path: string): Promise<boolean> {
  const existing = await lstatOrNull(path);
  if (existing === null) return false;
  if (!existing.isFile() && !existing.isSymbolicLink()) {
    throw new Error(`cannot replace or remove a non-file entry at ${path}`);
  }
  return true;
}

function isPathWithin(root: string, path: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(prefix);
}

async function resolveScriptPath(path: string): Promise<string> {
  return join(await resolveScriptDirectory(dirname(path)), basename(path));
}

async function resolveScriptDirectory(directory: string): Promise<string> {
  try {
    return normalize(await realpath(directory));
  } catch (error) {
    const parent = dirname(directory);
    if ((error as { code?: string }).code !== "ENOENT" || parent === directory) throw error;
    if ((await lstatOrNull(directory)) !== null) throw error;
    return join(await resolveScriptDirectory(parent), basename(directory));
  }
}

function normalizePathKey(path: string): string {
  const normalized = normalize(path);
  const ignoresCase = process.platform === "win32" || process.platform === "darwin";
  return ignoresCase ? normalized.toLowerCase() : normalized;
}

function writeScriptResult(script: ApplyScript, startedAt: number, succeeded: boolean): void {
  writeLine(
    `  [${script.distPath}] ${succeeded ? "✓ Complete" : "✗ Failed"} (${elapsedSeconds(startedAt)}s)`,
  );
}

export function parseArgs(argv: readonly string[]): {
  dryRun: boolean;
  yes: boolean;
  distRoot: string;
  homeRoot: string;
  rest: string[];
} {
  const rest = argv.filter((argument) => argument !== "--dry-run" && argument !== "--yes");
  const dryRun = argv.includes("--dry-run");
  const yes = argv.includes("--yes");
  const positional = positionalArguments(rest, ["--json"]);
  if (positional.length < 2) throw new Error(usage);
  return {
    dryRun,
    yes,
    distRoot: positional[0]!,
    homeRoot: expandHomeRoot(positional[1]!),
    rest,
  };
}

// Lifecycle without the build stage: diff detection → diff display →
// confirmation → apply → apply scripts. --dry-run renders the diff only
// (no writes, no apply scripts); --yes skips the confirmation.
export async function main(
  argv: readonly string[],
  confirmApply: () => Promise<boolean> = confirmApplyStdin,
): Promise<number> {
  const options = parseArgs(argv);
  if (options.dryRun) return diffMain(options.rest);
  const distRoot = resolve(options.distRoot);
  const { homeRoot } = options;

  const diffStarted = performance.now();
  const result = await collectDifferences(distRoot, homeRoot);
  writeLine(
    `diff: ${result.changed.length} changed, ${result.typeMismatches.length} type mismatches, ` +
      `${result.added.length} added, ${result.removedExact.length} surplus (exact), ` +
      `${result.removedIgnored.length} surplus (ignored) (${elapsedSeconds(diffStarted)}s)`,
  );
  await renderDiffs(result, { distRoot, homeRoot });

  const proceed = options.yes || (await confirmApply());
  if (!proceed) {
    writeLine("apply aborted");
    return 0;
  }

  const declarations = await collectDeclarations(distRoot);
  const applyStarted = performance.now();
  const applied = await applyDifferences(distRoot, homeRoot, result);
  writeLine(
    `apply: ${applied.added.length} added, ${applied.changed.length} changed, ` +
      `${applied.removed.length} removed (${elapsedSeconds(applyStarted)}s)`,
  );

  const scriptsStarted = performance.now();
  const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);
  writeLine(
    `apply scripts: ${declarations.applyScripts.length} scripts (${elapsedSeconds(scriptsStarted)}s)`,
  );
  for (const failure of failures) console.error(failure);
  return failures.length === 0 ? 0 : 1;
}

// ------------------------------------------------------------------ confirmation

export function confirmsApply(answer: string): boolean {
  return answer.trim().toLowerCase() === "y";
}

// Writes the prompt, reads one answer line from the input, and treats an
// input that ends before an answer (pipes, /dev/null) as a decline.
// Reads the stream by events: Bun's readline/promises leaves a pending
// question unresolved at end-of-input instead of rejecting it.
export async function confirmApplyStdin(
  input: Stream | NodeJS.ReadableStream = process.stdin,
): Promise<boolean> {
  process.stdout.write("Apply? [y/N] ");
  return confirmsApply(await readOneLine(input));
}

function readOneLine(input: Stream | NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolveLine) => {
    let buffer = "";
    const finish = (answer: string) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      if (input === process.stdin) process.stdin.pause();
      resolveLine(answer);
    };
    const onData = (chunk: string | Buffer) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) finish(buffer.slice(0, newlineIndex));
    };
    const onEnd = () => finish(buffer);
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onEnd);
  });
}

// ------------------------------------------------------------------ applying

let tempCounter = 0;

async function applyEntry(
  ctx: ApplyContext,
  entry: DiffEntry,
  behavior: { isChange: boolean; recurseDirectory: boolean },
): Promise<void> {
  if (entry.distPath === null) throw new Error(`entry has no dist path: ${entry.homePath}`);
  const distAbs = join(ctx.distRoot, entry.distPath);
  const homeAbs = join(ctx.homeRoot, entry.homePath);
  try {
    await mkdir(dirname(homeAbs), { recursive: true });
    const stat = await lstat(distAbs);
    const mapping = mapSegment(entry.distPath.split("/").pop() ?? "", stat.isDirectory());
    if (mapping.kind === "directory") {
      await mkdir(homeAbs, { recursive: true });
      // Added directory children are listed separately; type-mismatch children are not.
      if (behavior.recurseDirectory) await applyTree(ctx, entry.distPath, entry.homePath);
    } else if (mapping.kind === "symlink") {
      // A .symlink entry is a plain file in dist; the target is its content
      // with one trailing newline stripped (spec §.symlink の解釈).
      await rm(homeAbs, { force: true });
      await createSymlink(await readSymlinkTarget(distAbs), homeAbs, ctx.platform);
    } else {
      // Atomic write: build the new file beside the target, then rename it in,
      // so no half-written state ever appears at the home path.
      const tempPath = `${homeAbs}.apply-tmp-${process.pid}-${tempCounter++}`;
      await copyFile(distAbs, tempPath);
      if (comparesExecutableBits(ctx.platform)) {
        const mode = stat.mode & 0o7777;
        await chmod(tempPath, mapping.isExecutable ? mode | 0o100 : mode & ~0o100);
      } else if (behavior.isChange) {
        // Preserve the existing mode when replacing content on Windows;
        // copyFile otherwise carries the dist file's executable bit over.
        const previous = await lstat(homeAbs);
        await chmod(tempPath, previous.mode & 0o7777);
      }
      await ctx.renameFile(tempPath, homeAbs);
    }
  } catch (error) {
    throw new Error(`apply failed: ${entry.homePath}: ${messageOf(error)}`);
  }
  (behavior.isChange ? ctx.applied.changed : ctx.applied.added).push(entry.homePath);
}

async function createSymlink(target: string, path: string, platform: string): Promise<void> {
  try {
    await symlink(target, path);
  } catch (error) {
    const isWindowsPermissionError =
      platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM";
    if (!isWindowsPermissionError) throw error;
    throw new Error(
      `${error.message}\n` +
        "1. Enable Developer Mode in Windows Settings and retry.\n" +
        '2. If Developer Mode is unavailable or the error persists, open PowerShell with "Run as administrator" and retry.',
    );
  }
}

async function applyTree(ctx: ApplyContext, distRel: string, homeRel: string): Promise<void> {
  for (const dirent of await readdir(join(ctx.distRoot, distRel), { withFileTypes: true })) {
    const mapping = mapSegment(dirent.name, dirent.isDirectory());
    if (mapping.isExcluded) continue;
    await applyEntry(
      ctx,
      { homePath: `${homeRel}/${mapping.homeName}`, distPath: `${distRel}/${dirent.name}` },
      { isChange: false, recurseDirectory: true },
    );
  }
}

// ------------------------------------------------------- declarations lookup

async function walkDeclarations(
  dirAbs: string,
  dirRel: string,
  out: Declarations,
  platform: string,
): Promise<ApplyScript[]> {
  const entries = (await readdir(dirAbs, { withFileTypes: true })).sort((left, right) =>
    compareCodeUnits(left.name, right.name),
  );
  const postScripts: ApplyScript[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || mapSegment(entry.name, true).isExcluded) continue;
    const childRel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
    postScripts.push(
      ...(await walkDeclarations(join(dirAbs, entry.name), childRel, out, platform)),
    );
  }
  for (const entry of entries) {
    if (!entry.isFile() || !isApplyScriptName(entry.name)) continue;
    // OS-modified scripts (spec: SPEC.md §フックシステム) only run on the
    // matching platform; apply runs on the environment applying the dist.
    const scriptPlatform = hookPlatform(entry.name);
    if (scriptPlatform !== undefined && scriptPlatform !== platform) continue;
    const script = {
      distPath: dirRel === "" ? entry.name : `${dirRel}/${entry.name}`,
      fileName: entry.name,
      homeFolderRel: homeFolderOf(dirRel),
    };
    if (isPostHookName(entry.name)) postScripts.push(script);
    else out.applyScripts.push(script);
  }
  return postScripts;
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
  env: Record<string, string | undefined>,
  label: string,
  path: string,
): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await forwardHookOutput(proc, path);
  if (exitCode !== 0) {
    const reason = proc.signalCode ? `signal ${proc.signalCode}` : `exit code ${exitCode}`;
    throw new Error(`${label} (${reason})`);
  }
}

// -------------------------------------------------------------------- helpers

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
