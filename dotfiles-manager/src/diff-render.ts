// Human-only Git rename detection and delta display (SPEC.md §差分表示).
// Snapshots contain classified entries only; neither input tree is changed.
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compareFiles, comparesExecutableBits, lstatOrNull, readSymlinkTarget } from "./compare.ts";
import { mapSegment } from "./path-mapping.ts";
import type { DiffEntry, DiffResult } from "./diff.ts";

export async function renderDiffs(
  result: DiffResult,
  options: { distRoot: string; homeRoot: string },
): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "diff-render-"));
  try {
    const display = temporaryRoot;
    await mkdir(join(display, "a"));
    await mkdir(join(display, "b"));
    const addedPaths: string[] = [];
    const removedPaths: string[] = [];
    for (const entry of result.added) {
      const source = distAbsolutePath(entry, options.distRoot);
      if ((await lstatOrNull(source))?.isDirectory()) continue;
      addedPaths.push(...(await snapshot(source, join(display, "b"), entry.homePath, true)));
    }
    for (const entry of result.removedExact) {
      const source = join(options.homeRoot, entry.homePath);
      removedPaths.push(...(await snapshot(source, join(display, "a"), entry.homePath, false)));
    }

    const renames = await detectRenames(display);
    const matchedOld = new Set(renames.map((rename) => rename.oldPath));
    const matchedNew = new Set(renames.map((rename) => rename.newPath));
    const patches: string[] = [];
    for (const entry of [...result.changed, ...result.typeMismatches]) {
      await snapshot(
        join(options.homeRoot, entry.homePath),
        join(display, "a"),
        entry.homePath,
        false,
      );
      await snapshot(
        distAbsolutePath(entry, options.distRoot),
        join(display, "b"),
        entry.homePath,
        true,
      );
      patches.push(await contentPatch(display, entry.homePath, entry.homePath));
    }
    for (const rename of renames) {
      const metadata = [
        `diff --git ${quotePath(`a/${rename.oldPath}`)} ${quotePath(`b/${rename.newPath}`)}`,
        `similarity index ${rename.similarity}%`,
        `rename from ${quotePath(rename.oldPath)}`,
        `rename to ${quotePath(rename.newPath)}`,
      ]
        .map((line) => `\x1b[1m${line}\x1b[m\n`)
        .join("");
      const content = await contentPatch(display, rename.oldPath, rename.newPath);
      patches.push(metadata + content.slice(content.indexOf("\n") + 1));
    }
    for (const path of addedPaths) {
      if (!matchedNew.has(path)) patches.push(await contentPatch(display, null, path));
    }
    for (const path of removedPaths) {
      if (!matchedOld.has(path)) patches.push(await contentPatch(display, path, null));
    }
    await displayPatch(patches.join(""));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

type Rename = { oldPath: string; newPath: string; similarity: string };

async function detectRenames(root: string): Promise<Rename[]> {
  const status = await gitDiff(root, ["-M", "--name-status", "-z", "--color=never"], "a", "b");
  const fields = status.split("\0");
  const renames: Rename[] = [];
  for (let index = 0; index < fields.length;) {
    const kind = fields[index++]!;
    if (!kind) break;
    const firstPath = fields[index++]!;
    if (kind.startsWith("R")) {
      const secondPath = fields[index++]!;
      renames.push({
        oldPath: firstPath.slice(2),
        newPath: secondPath.slice(2),
        similarity: String(Number(kind.slice(1))),
      });
    }
  }
  return renames;
}

async function contentPatch(
  root: string,
  oldPath: string | null,
  newPath: string | null,
): Promise<string> {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const firstPath = oldPath === null ? nullDevice : `a/${oldPath}`;
  const secondPath = newPath === null ? nullDevice : `b/${newPath}`;
  const firstStat = oldPath === null ? null : await lstatOrNull(join(root, firstPath));
  const secondStat = newPath === null ? null : await lstatOrNull(join(root, secondPath));
  const regularInputs = (!firstStat || firstStat.isFile()) && (!secondStat || secondStat.isFile());
  if (regularInputs) {
    const emptyPath = join(root, "empty");
    await writeFile(emptyPath, "");
    const comparison = await compareFiles(
      oldPath === null ? emptyPath : join(root, firstPath),
      newPath === null ? emptyPath : join(root, secondPath),
    );
    if (!comparison.differs) return "";
  }
  const flags = ["--no-renames", "--color=always", "--no-prefix"];
  if (firstStat?.isDirectory() || secondStat?.isDirectory()) {
    const pairRoot = await mkdtemp(join(root, "pair-"));
    await mkdir(join(pairRoot, "a"));
    await mkdir(join(pairRoot, "b"));
    if (oldPath !== null)
      await snapshot(join(root, firstPath), join(pairRoot, "a"), oldPath, false);
    if (newPath !== null)
      await snapshot(join(root, secondPath), join(pairRoot, "b"), newPath, false);
    return gitDiff(pairRoot, flags, "a", "b");
  }
  return gitDiff(root, flags, firstPath, secondPath);
}

async function gitDiff(
  root: string,
  flags: string[],
  firstPath: string,
  secondPath: string,
): Promise<string> {
  const diff = Bun.spawn(
    [
      "git",
      "--no-pager",
      "-c",
      "core.safecrlf=false",
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.quotePath=false",
      "-c",
      "diff.renameLimit=0",
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      ...flags,
      "--",
      firstPath,
      secondPath,
    ],
    { cwd: root, stdout: "pipe", stderr: "inherit" },
  );
  const output = await new Response(diff.stdout).text();
  await diff.exited;
  return output;
}

async function displayPatch(patch: string): Promise<void> {
  if (!patch) return;
  const delta = Bun.which("delta");
  if (delta === null) {
    process.stdout.write(patch);
    return;
  }
  const renderer = Bun.spawn([delta, "--paging=never"], {
    stdin: new Blob([patch]),
    stdout: "pipe",
    stderr: "inherit",
  });
  process.stdout.write(await new Response(renderer.stdout).text());
  await renderer.exited;
}

async function snapshot(
  source: string,
  root: string,
  homePath: string,
  isDist: boolean,
): Promise<string[]> {
  const stat = await lstatOrNull(source);
  if (!stat) return [];
  const destination = join(root, homePath);
  await mkdir(dirname(destination), { recursive: true });
  if (stat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    const leaves: string[] = [];
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const mapping = mapSegment(entry.name, entry.isDirectory());
      if (isDist && mapping.isExcluded) continue;
      const name = isDist ? mapping.homeName : entry.name;
      leaves.push(
        ...(await snapshot(join(source, entry.name), root, `${homePath}/${name}`, isDist)),
      );
    }
    return leaves;
  }
  const mapping = mapSegment(source.split(/[\\/]/).at(-1)!, false);
  if (stat.isSymbolicLink() || (isDist && mapping.kind === "symlink")) {
    await symlink(
      stat.isSymbolicLink() ? await readlink(source) : await readSymlinkTarget(source),
      destination,
    );
  } else if (stat.isFile()) {
    await copyFile(source, destination);
    if (comparesExecutableBits(process.platform)) {
      const executable = isDist ? mapping.isExecutable : (stat.mode & 0o100) !== 0;
      await chmod(destination, executable ? 0o755 : 0o644);
    }
  } else {
    return [];
  }
  return [homePath];
}

function quotePath(path: string): string {
  const escapes: Record<string, string> = {
    "\x07": "\\a",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\v": "\\v",
    "\f": "\\f",
    "\r": "\\r",
    '"': '\\"',
    "\\": "\\\\",
  };
  let quoted = "";
  let needsQuotes = /\s/.test(path);
  for (const character of path) {
    const code = character.charCodeAt(0);
    const escaped = escapes[character];
    if (escaped !== undefined) {
      quoted += escaped;
      needsQuotes = true;
    } else if (code < 32 || code === 127) {
      quoted += `\\${code.toString(8).padStart(3, "0")}`;
      needsQuotes = true;
    } else {
      quoted += character;
    }
  }
  return needsQuotes ? `"${quoted}"` : path;
}

function distAbsolutePath(entry: DiffEntry, distRoot: string): string {
  if (entry.distPath === null) throw new Error(`entry has no dist path: ${entry.homePath}`);
  return join(distRoot, entry.distPath);
}
