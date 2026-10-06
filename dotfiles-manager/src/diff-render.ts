// Human-only Git rename detection and diff display (SPEC.md §差分表示).
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
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compareFiles, comparesExecutableBits, lstatOrNull, readSymlinkTarget } from "./compare.ts";
import { mapSegment } from "./path-mapping.ts";
import type { DiffEntry, DiffResult } from "./diff.ts";

const NON_TTY_WIDTH = 80;
const MINIMUM_RIGHT_RULE = "──";

type Section = { label: string; paths: string[]; body: string[] };

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
    const sections: Section[] = [];
    for (const entry of result.changed) {
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
      const body = patchBody(await contentPatch(display, entry.homePath, entry.homePath));
      if (body.length > 0) sections.push({ label: "Modified", paths: [entry.homePath], body });
    }
    // Type mismatches follow the apply semantics (spec §適用: delete the home
    // entry and add the dist entry), rendering each side as its own section
    // like unmatched candidates instead of one concatenated Modified body.
    for (const entry of result.typeMismatches) {
      const oldLeaves = await snapshot(
        join(options.homeRoot, entry.homePath),
        join(display, "a"),
        entry.homePath,
        false,
      );
      const newLeaves = await snapshot(
        distAbsolutePath(entry, options.distRoot),
        join(display, "b"),
        entry.homePath,
        true,
      );
      for (const path of oldLeaves) {
        sections.push({
          label: "Deleted",
          paths: [path],
          body: patchBody(await contentPatch(display, path, null)),
        });
      }
      for (const path of newLeaves) {
        sections.push({
          label: "Added",
          paths: [path],
          body: patchBody(await contentPatch(display, null, path)),
        });
      }
    }
    for (const rename of renames) {
      const body = patchBody(await contentPatch(display, rename.oldPath, rename.newPath));
      sections.push({ label: "Renamed", paths: [rename.oldPath, rename.newPath], body });
    }
    for (const path of addedPaths) {
      if (!matchedNew.has(path)) {
        sections.push({
          label: "Added",
          paths: [path],
          body: patchBody(await contentPatch(display, null, path)),
        });
      }
    }
    for (const path of removedPaths) {
      if (!matchedOld.has(path)) {
        sections.push({
          label: "Deleted",
          paths: [path],
          body: patchBody(await contentPatch(display, path, null)),
        });
      }
    }
    if (sections.length > 0) process.stdout.write(renderSections(sections));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

type Rename = { oldPath: string; newPath: string };

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
      renames.push({ oldPath: firstPath.slice(2), newPath: secondPath.slice(2) });
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
  if (regularInputs && firstStat && secondStat) {
    // Suppress a patch only when normalized content is equal (spec §差分表示:
    // line-ending-only differences are not shown) and the modes match, so
    // mode-only changes still render their old mode / new mode lines. One-sided
    // inputs (additions, deletions) never take this branch, so an empty added
    // entry renders a heading-only section instead of being suppressed.
    const comparison = await compareFiles(join(root, firstPath), join(root, secondPath));
    const sameMode = (firstStat.mode & 0o777) === (secondStat.mode & 0o777);
    if (!comparison.differs && sameMode) return "";
  }
  const flags = ["--no-renames", "--color=never", "--no-prefix"];
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

// ---------------------------------------------------------------- rendering

function renderSections(sections: Section[]): string {
  const tty = process.stdout.isTTY === true;
  const columns = (process.stdout as { columns?: number }).columns;
  const width = tty && typeof columns === "number" && columns > 0 ? columns : NON_TTY_WIDTH;
  return sections.map((section) => renderSection(section, width, tty)).join("\n\n\n") + "\n";
}

function renderSection(section: Section, width: number, tty: boolean): string {
  const heading = renderHeading(section.label, section.paths, width, tty);
  const lines = [heading];
  if (section.body.length > 0) lines.push("");
  for (const line of section.body) lines.push(colorizeBodyLine(line, tty));
  return lines.join("\n");
}

function renderHeading(label: string, paths: string[], width: number, tty: boolean): string {
  const arrow = " → ";
  const decoratedPaths = paths.map((path) => decorateHeadingPath(path, tty)).join(arrow);
  const prefix = `── ${label} · ${paths.join(arrow)} `;
  const ruleLength = Math.max(width - displayWidth(prefix), MINIMUM_RIGHT_RULE.length);
  const right = "─".repeat(ruleLength);
  return (
    gray("──", tty) + ` ${label} ` + gray("·", tty) + " " + decoratedPaths + " " + gray(right, tty)
  );
}

// File name in bold; the directory part including its "/" separator in gray.
function decorateHeadingPath(path: string, tty: boolean): string {
  const separator = path.lastIndexOf("/");
  if (separator === -1) return bold(path, tty);
  return gray(path.slice(0, separator + 1), tty) + bold(path.slice(separator + 1), tty);
}

function colorizeBodyLine(line: string, tty: boolean): string {
  if (!tty) return line;
  if (line.startsWith("@@")) return gray(line, true);
  if (line.startsWith("+")) return green(line, true);
  if (line.startsWith("-")) return red(line, true);
  return line;
}

function bold(text: string, tty: boolean): string {
  return tty ? `\x1b[1m${text}\x1b[m` : text;
}

function gray(text: string, tty: boolean): string {
  return tty ? `\x1b[90m${text}\x1b[m` : text;
}

function green(text: string, tty: boolean): string {
  return tty ? `\x1b[32m${text}\x1b[m` : text;
}

function red(text: string, tty: boolean): string {
  return tty ? `\x1b[31m${text}\x1b[m` : text;
}

// ------------------------------------------------------------ patch parsing

// Drop git metadata lines (diff --git, index, ---/+++ headers, new/deleted
// file mode, rename and similarity) and keep hunks, binary notices, and
// old mode / new mode lines as the section body (spec §差分表示).
function patchBody(patch: string): string[] {
  const body: string[] = [];
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("@@")) {
      inHunk = true;
      body.push(line);
      continue;
    }
    if (
      !inHunk &&
      (line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("new file mode ") ||
        line.startsWith("deleted file mode ") ||
        line.startsWith("similarity index ") ||
        line.startsWith("rename from ") ||
        line.startsWith("rename to "))
    )
      continue;
    body.push(line);
  }
  return body;
}

// ----------------------------------------------------------- display width

const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x064b, 0x065f],
  [0x200b, 0x200f],
  [0x2060, 0x2064],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
];

// Approximate terminal cell count: East Asian wide/fullwidth characters count
// as two cells and combining marks as zero.
function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (inRanges(code, ZERO_WIDTH_RANGES)) continue;
    width += inRanges(code, WIDE_RANGES) ? 2 : 1;
  }
  return width;
}

function inRanges(code: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([low, high]) => code >= low && code <= high);
}

// --------------------------------------------------------------- snapshots

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

function distAbsolutePath(entry: DiffEntry, distRoot: string): string {
  if (entry.distPath === null) throw new Error(`entry has no dist path: ${entry.homePath}`);
  return join(distRoot, entry.distPath);
}
