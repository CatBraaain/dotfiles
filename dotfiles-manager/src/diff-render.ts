// Diff display (spec: SPEC.md §差分表示): renders a two-input comparison
// per changed / type-mismatched / added / surplus entry with difftastic or
// git diff. Display-only: diff tool exit codes never affect the engine.
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareFiles, lstatOrNull } from "./compare.ts";
import type { DiffEntry, DiffResult } from "./diff.ts";

export async function renderDiffs(
  result: DiffResult,
  options: { distRoot: string; homeRoot: string },
): Promise<void> {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const renderTargets: Array<{ destination: string; target: string; isJson: boolean }> = [];
  for (const entry of result.changed)
    renderTargets.push({
      destination: join(options.homeRoot, entry.homePath),
      target: distAbsolutePath(entry, options.distRoot),
      isJson: isJsonName(entry.homePath),
    });
  for (const entry of result.typeMismatches)
    renderTargets.push({
      destination: join(options.homeRoot, entry.homePath),
      target: distAbsolutePath(entry, options.distRoot),
      isJson: isJsonName(entry.homePath),
    });
  for (const entry of result.added) {
    const target = distAbsolutePath(entry, options.distRoot);
    // Children are already classified individually; rendering the directory
    // recursively would expose excluded entries and display children twice.
    if (isDirectoryPath(target)) continue;
    renderTargets.push({
      destination: nullDevice,
      target,
      isJson: isJsonName(entry.homePath),
    });
  }
  for (const entry of result.removedExact)
    renderTargets.push({
      destination: join(options.homeRoot, entry.homePath),
      target: nullDevice,
      isJson: isJsonName(entry.homePath),
    });

  for (const { destination, target, isJson } of renderTargets) {
    await renderDiff(destination, target, isJson);
  }
}

// Render a two-input comparison for one entry with difftastic or git diff
// (spec: 差分表示). Skips line-ending-only differences and displays the raw
// diff otherwise. The diff tools' exit codes (including 1) never propagate.
async function renderDiff(destination: string, target: string, isJson: boolean): Promise<void> {
  const hasSymlinkInput =
    (await lstatOrNull(destination))?.isSymbolicLink() ||
    (await lstatOrNull(target))?.isSymbolicLink();
  const hasDirectoryInput = isDirectoryPath(destination) || isDirectoryPath(target);
  let isBinary = false;
  if (!hasSymlinkInput && !hasDirectoryInput) {
    try {
      const comparison = await compareFiles(destination, target);
      if (!comparison.differs) return;
      isBinary = !comparison.isText;
    } catch {
      // Type mismatches may not have two readable file inputs.
    }
  }
  // difftastic accepts text files only, while the caller also passes directory
  // entries and symlinks (including broken ones).
  const useDifftastic =
    !hasDirectoryInput && !hasSymlinkInput && !isBinary && !isJson && Bun.which("difft") !== null;
  const diffInputs = hasDirectoryInput
    ? await prepareDirectoryInputs(destination, target)
    : {
        firstPath: destination,
        secondPath: target,
        cleanup: async () => {},
      };
  try {
    const diff = Bun.spawn(
      useDifftastic
        ? [
            "difft",
            "--color=always",
            "--display=inline",
            "--skip-unchanged",
            "--strip-cr=on",
            "--syntax-highlight=on",
            diffInputs.firstPath,
            diffInputs.secondPath,
          ]
        : [
            "git",
            "-c",
            "core.safecrlf=false",
            "-c",
            "core.autocrlf=false",
            "diff",
            "--no-index",
            ...(!isBinary ? ["--ignore-cr-at-eol"] : []),
            "--color=always",
            "--",
            diffInputs.firstPath,
            diffInputs.secondPath,
          ],
      { stdout: "pipe", stderr: "inherit" },
    );

    process.stdout.write(await new Response(diff.stdout).text());
    await diff.exited;
  } finally {
    await diffInputs.cleanup();
  }
}

async function prepareDirectoryInputs(
  firstPath: string,
  secondPath: string,
): Promise<{
  firstPath: string;
  secondPath: string;
  cleanup: () => Promise<void>;
}> {
  const temporaryDirectories: string[] = [];
  const inputPaths = await Promise.all(
    [firstPath, secondPath].map(async (path) => {
      if (isDirectoryPath(path) || !isNullDevice(path)) return path;
      const emptyDirectory = await mkdtemp(join(tmpdir(), "diff-render-"));
      temporaryDirectories.push(emptyDirectory);
      return emptyDirectory;
    }),
  );

  return {
    firstPath: inputPaths[0]!,
    secondPath: inputPaths[1]!,
    cleanup: async () => {
      await Promise.all(
        temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })),
      );
    },
  };
}

function isNullDevice(path: string): boolean {
  return path === "/dev/null" || path.toUpperCase() === "NUL";
}

function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isJsonName(name: string): boolean {
  const lowercaseName = name.toLowerCase();
  return lowercaseName.endsWith(".json") || lowercaseName.endsWith(".jsonc");
}

// Surplus entries have no dist counterpart; rendering helpers that need a
// dist path never receive one, so this guard just makes that explicit.
function distAbsolutePath(entry: DiffEntry, distRoot: string): string {
  if (entry.distPath === null) throw new Error(`entry has no dist path: ${entry.homePath}`);
  return join(distRoot, entry.distPath);
}
