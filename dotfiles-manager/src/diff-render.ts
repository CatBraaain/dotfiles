import { readFile, readdir, readlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  compareCodeUnits,
  comparesExecutableBits,
  lstatOrNull,
  readSymlinkTarget,
} from "./compare.ts";
import { mapSegment } from "./path-mapping.ts";
import type { DiffEntry, DiffResult } from "./diff.ts";

type Section = { label: string; paths: string[]; body: string[] };
type DiffOptions = { distRoot: string; homeRoot: string };
type Side = "dist" | "home";
type DisplayInput = { source: string; homePath: string; side: Side };
type Mark = " " | "-" | "+";

export async function renderDiffs(result: DiffResult, options: DiffOptions): Promise<void> {
  const hasDisplayEntries =
    result.changed.length > 0 ||
    result.typeMismatches.length > 0 ||
    result.added.length > 0 ||
    result.removedExact.length > 0;
  if (!hasDisplayEntries) return;

  const loader = new LeafLoader();
  const addedContents = await collectAddedContents(result.added, options, loader);
  const removedContents = await collectRemovedContents(result.removedExact, options, loader);
  const renames = detectRenames(addedContents, removedContents);

  const contentByPath = new Map(
    [...addedContents, ...removedContents].map((content) => [content.input.homePath, content]),
  );
  const matchedOldPaths = new Set(renames.map((rename) => rename.oldPath));
  const matchedNewPaths = new Set(renames.map((rename) => rename.newPath));
  const sections = [
    ...(await changedSections(result.changed, options, loader)),
    ...(await typeMismatchSections(result.typeMismatches, options, loader)),
    ...renames.map((rename) => ({
      label: "Renamed",
      paths: [rename.oldPath, rename.newPath],
      body: pairBody(contentByPath.get(rename.oldPath)!, contentByPath.get(rename.newPath)!),
    })),
    ...leafSections(
      addedContents.filter((content) => !matchedNewPaths.has(content.input.homePath)),
      "Added",
    ),
    ...leafSections(
      removedContents.filter((content) => !matchedOldPaths.has(content.input.homePath)),
      "Deleted",
    ),
  ];
  if (sections.length > 0) process.stdout.write(renderSections(sections));
}

async function collectAddedContents(
  entries: DiffEntry[],
  options: DiffOptions,
  loader: LeafLoader,
): Promise<LeafContent[]> {
  const inputs: DisplayInput[] = [];
  for (const entry of entries) {
    const input = displayInput(entry, options, "dist");
    if ((await lstatOrNull(input.source))?.isDirectory()) continue;
    inputs.push(...(await collectInputs(input)));
  }
  return Promise.all(inputs.map((input) => loader.load(input)));
}

async function collectRemovedContents(
  entries: DiffEntry[],
  options: DiffOptions,
  loader: LeafLoader,
): Promise<LeafContent[]> {
  const inputs: DisplayInput[] = [];
  for (const entry of entries)
    inputs.push(...(await collectInputs(displayInput(entry, options, "home"))));
  return Promise.all(inputs.map((input) => loader.load(input)));
}

function displayInput(entry: DiffEntry, options: DiffOptions, side: Side): DisplayInput {
  const source =
    side === "dist"
      ? distAbsolutePath(entry, options.distRoot)
      : join(options.homeRoot, entry.homePath);
  return { source: resolve(source), homePath: entry.homePath, side };
}

async function collectInputs(input: DisplayInput): Promise<DisplayInput[]> {
  const stat = await lstatOrNull(input.source);
  if (!stat) return [];
  if (!stat.isDirectory()) return stat.isFile() || stat.isSymbolicLink() ? [input] : [];
  const dirents = await readdir(input.source, { withFileTypes: true });
  const childLeaves = await Promise.all(
    dirents.map(async (dirent) => {
      const mapping = mapSegment(dirent.name, dirent.isDirectory());
      if (input.side === "dist" && mapping.isExcluded) return [];
      const name = input.side === "dist" ? mapping.homeName : dirent.name;
      return collectInputs({
        source: join(input.source, dirent.name),
        homePath: `${input.homePath}/${name}`,
        side: input.side,
      });
    }),
  );
  return childLeaves.flat();
}

// ---------------------------------------------------------------- leaf reads

type FileLeaf = {
  input: DisplayInput;
  kind: "file";
  bytes: Uint8Array;
  strictText: string | null;
  displayText: string;
  hasNul: boolean;
  isExecutable: boolean;
};
type SymlinkLeaf = { input: DisplayInput; kind: "symlink"; target: string };
type LeafContent = FileLeaf | SymlinkLeaf;

class LeafLoader {
  private readonly cache = new Map<string, LeafContent>();

  async load(input: DisplayInput): Promise<LeafContent> {
    const key = `${input.side}/${input.homePath}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const content = await readLeafContent(input);
    this.cache.set(key, content);
    return content;
  }
}

async function readLeafContent(input: DisplayInput): Promise<LeafContent> {
  const stat = await lstatOrNull(input.source);
  const mapping = mapSegment(basename(input.source), false);
  if (input.side === "dist" && mapping.kind === "symlink" && stat?.isFile()) {
    return { input, kind: "symlink", target: await readSymlinkTarget(input.source) };
  }
  if (stat?.isSymbolicLink()) {
    return { input, kind: "symlink", target: await readlink(input.source) };
  }
  if (!stat) {
    return {
      input,
      kind: "file",
      bytes: new Uint8Array(),
      strictText: "",
      displayText: "",
      hasNul: false,
      isExecutable: false,
    };
  }
  const bytes = await readFile(input.source);
  const strictText = decodeStrictText(bytes);
  const hasNul = bytes.includes(0);
  return {
    input,
    kind: "file",
    bytes,
    strictText,
    displayText: hasNul ? "" : new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
    hasNul,
    isExecutable: input.side === "dist" ? mapping.isExecutable : (stat.mode & 0o100) !== 0,
  };
}

function decodeStrictText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------- rename detection

type Rename = { oldPath: string; newPath: string };

function detectRenames(addedContents: LeafContent[], removedContents: LeafContent[]): Rename[] {
  const matchedAddedPaths = new Set<string>();
  const matchedRemovedPaths = new Set<string>();
  const renames: Rename[] = [];
  pairIdenticalContents(
    addedContents,
    removedContents,
    matchedAddedPaths,
    matchedRemovedPaths,
    renames,
  );
  pairSimilarTexts(addedContents, removedContents, matchedAddedPaths, matchedRemovedPaths, renames);
  renames.sort(
    (left, right) =>
      compareCodeUnits(left.oldPath, right.oldPath) ||
      compareCodeUnits(left.newPath, right.newPath),
  );
  return renames;
}

function pairIdenticalContents(
  addedContents: LeafContent[],
  removedContents: LeafContent[],
  matchedAddedPaths: Set<string>,
  matchedRemovedPaths: Set<string>,
  renames: Rename[],
): void {
  const addedGroups = groupByIdentity(addedContents, matchedAddedPaths);
  const removedGroups = groupByIdentity(removedContents, matchedRemovedPaths);
  for (const [identity, addedGroup] of addedGroups) {
    const removedGroup = removedGroups.get(identity);
    if (!removedGroup) continue;
    const pairCount = Math.min(addedGroup.length, removedGroup.length);
    for (let index = 0; index < pairCount; index++) {
      const added = addedGroup[index]!;
      const removed = removedGroup[index]!;
      renames.push({ oldPath: removed.input.homePath, newPath: added.input.homePath });
      matchedAddedPaths.add(added.input.homePath);
      matchedRemovedPaths.add(removed.input.homePath);
    }
  }
}

function groupByIdentity(
  contents: LeafContent[],
  matchedPaths: Set<string>,
): Map<string, LeafContent[]> {
  const groups = new Map<string, LeafContent[]>();
  for (const content of contents) {
    if (matchedPaths.has(content.input.homePath)) continue;
    const identity = contentIdentity(content);
    const group = groups.get(identity);
    if (group) group.push(content);
    else groups.set(identity, [content]);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => compareCodeUnits(left.input.homePath, right.input.homePath));
  }
  return groups;
}

function contentIdentity(content: LeafContent): string {
  if (content.kind === "symlink") return `symlink:${content.target}`;
  if (content.strictText === null) return `binary:${sha256Hex(content.bytes)}`;
  return `text:${normalizeText(content.strictText)}`;
}

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

type TextProfile = { homePath: string; lineCounts: Map<string, number>; lineTotal: number };

function pairSimilarTexts(
  addedContents: LeafContent[],
  removedContents: LeafContent[],
  matchedAddedPaths: Set<string>,
  matchedRemovedPaths: Set<string>,
  renames: Rename[],
): void {
  const addedProfiles = textProfiles(addedContents, matchedAddedPaths);
  const removedProfiles = textProfiles(removedContents, matchedRemovedPaths);
  const candidates: Array<{
    removed: TextProfile;
    added: TextProfile;
    commonLines: number;
    totalLines: number;
  }> = [];
  for (const removed of removedProfiles) {
    for (const added of addedProfiles) {
      const commonLines = commonLineCount(removed.lineCounts, added.lineCounts);
      const totalLines = Math.max(removed.lineTotal, added.lineTotal);
      if (totalLines > 0 && commonLines * 2 >= totalLines)
        candidates.push({ removed, added, commonLines, totalLines });
    }
  }
  candidates.sort(
    (left, right) =>
      right.commonLines * left.totalLines - left.commonLines * right.totalLines ||
      compareCodeUnits(left.removed.homePath, right.removed.homePath) ||
      compareCodeUnits(left.added.homePath, right.added.homePath),
  );
  for (const candidate of candidates) {
    if (matchedAddedPaths.has(candidate.added.homePath)) continue;
    if (matchedRemovedPaths.has(candidate.removed.homePath)) continue;
    matchedAddedPaths.add(candidate.added.homePath);
    matchedRemovedPaths.add(candidate.removed.homePath);
    renames.push({ oldPath: candidate.removed.homePath, newPath: candidate.added.homePath });
  }
}

function textProfiles(contents: LeafContent[], matchedPaths: Set<string>): TextProfile[] {
  return contents.flatMap((content) => {
    if (content.kind !== "file" || content.strictText === null) return [];
    if (matchedPaths.has(content.input.homePath)) return [];
    const normalized = normalizeText(content.strictText);
    const lines = normalized === "" ? [] : normalized.split("\n");
    const lineCounts = new Map<string, number>();
    for (const line of lines) lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1);
    return [{ homePath: content.input.homePath, lineCounts, lineTotal: lines.length }];
  });
}

function commonLineCount(oldCounts: Map<string, number>, newCounts: Map<string, number>): number {
  let common = 0;
  for (const [line, removedCount] of oldCounts) {
    const addedCount = newCounts.get(line);
    if (addedCount !== undefined) common += Math.min(removedCount, addedCount);
  }
  return common;
}

function normalizeText(text: string): string {
  const withoutCarriageReturns = text.replaceAll("\r", "");
  return withoutCarriageReturns.endsWith("\n")
    ? withoutCarriageReturns.slice(0, -1)
    : withoutCarriageReturns;
}

// ---------------------------------------------------------- section bodies

async function changedSections(
  entries: DiffEntry[],
  options: DiffOptions,
  loader: LeafLoader,
): Promise<Section[]> {
  const sections = await Promise.all(
    entries.map(async (entry) => {
      const oldContent = await loader.load(displayInput(entry, options, "home"));
      const newContent = await loader.load(displayInput(entry, options, "dist"));
      const body = pairBody(oldContent, newContent);
      return body.length > 0
        ? ({ label: "Modified", paths: [entry.homePath], body } as Section)
        : null;
    }),
  );
  return sections.filter((section): section is Section => section !== null);
}

async function typeMismatchSections(
  entries: DiffEntry[],
  options: DiffOptions,
  loader: LeafLoader,
): Promise<Section[]> {
  const sections = await Promise.all(
    entries.map(async (entry) => {
      const oldLeaves = await collectLeaves(displayInput(entry, options, "home"), loader);
      const newLeaves = await collectLeaves(displayInput(entry, options, "dist"), loader);
      return [...leafSections(oldLeaves, "Deleted"), ...leafSections(newLeaves, "Added")];
    }),
  );
  return sections.flat();
}

async function collectLeaves(input: DisplayInput, loader: LeafLoader): Promise<LeafContent[]> {
  const inputs = await collectInputs(input);
  return Promise.all(inputs.map((leaf) => loader.load(leaf)));
}

function leafSections(contents: LeafContent[], label: "Added" | "Deleted"): Section[] {
  return contents.map((content) => ({
    label,
    paths: [content.input.homePath],
    body: pairBody(
      content.input.side === "home" ? content : null,
      content.input.side === "dist" ? content : null,
    ),
  }));
}

function pairBody(oldContent: LeafContent | null, newContent: LeafContent | null): string[] {
  const modeBody =
    oldContent !== null &&
    newContent !== null &&
    oldContent.kind === "file" &&
    newContent.kind === "file"
      ? modeLines(oldContent, newContent)
      : [];
  if (!pairContentDiffers(oldContent, newContent)) return modeBody;
  if (containsNul(oldContent) || containsNul(newContent)) {
    return [...modeBody, binaryNotice(oldContent, newContent)];
  }
  return [...modeBody, ...textDiffLines(oldContent, newContent)];
}

function pairContentDiffers(
  oldContent: LeafContent | null,
  newContent: LeafContent | null,
): boolean {
  if (oldContent !== null && newContent !== null) {
    if (oldContent.kind === "file" && newContent.kind === "file") {
      if (oldContent.strictText !== null && newContent.strictText !== null)
        return normalizeText(oldContent.strictText) !== normalizeText(newContent.strictText);
      return bytesDiffer(oldContent.bytes, newContent.bytes);
    }
    return leafText(oldContent) !== leafText(newContent);
  }
  const content = oldContent ?? newContent;
  if (content === null) return false;
  return content.kind === "symlink" ? content.target !== "" : content.bytes.length > 0;
}

function containsNul(content: LeafContent | null): boolean {
  return content !== null && content.kind === "file" && content.hasNul;
}

function leafText(content: LeafContent | null): string {
  if (content === null) return "";
  return content.kind === "symlink" ? content.target : content.displayText;
}

function bytesDiffer(first: Uint8Array, second: Uint8Array): boolean {
  return first.length !== second.length || first.some((byte, index) => byte !== second[index]);
}

function modeLines(oldFile: FileLeaf, newFile: FileLeaf): string[] {
  if (!comparesExecutableBits(process.platform)) return [];
  if (oldFile.isExecutable === newFile.isExecutable) return [];
  return [`old mode ${fileMode(oldFile)}`, `new mode ${fileMode(newFile)}`];
}

function fileMode(file: FileLeaf): string {
  return (0o100000 | (file.isExecutable ? 0o755 : 0o644)).toString(8);
}

function binaryNotice(oldContent: LeafContent | null, newContent: LeafContent | null): string {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const oldName = quoteGitPath(oldContent ? `a/${oldContent.input.homePath}` : nullDevice);
  const newName = quoteGitPath(newContent ? `b/${newContent.input.homePath}` : nullDevice);
  return `Binary files ${oldName} and ${newName} differ`;
}

function quoteGitPath(path: string): string {
  const escapes: Record<string, string> = {
    '"': '\\"',
    "\\": "\\\\",
    "\x07": "\\a",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\v": "\\v",
    "\f": "\\f",
    "\r": "\\r",
  };
  const firstPrintableAscii = 0x20;
  const asciiDelete = 0x7f;
  const quoted = [...path]
    .map((character) => {
      const escape = escapes[character];
      if (escape) return escape;
      const code = character.charCodeAt(0);
      const isControlCharacter = code < firstPrintableAscii || code === asciiDelete;
      return isControlCharacter ? `\\${code.toString(8).padStart(3, "0")}` : character;
    })
    .join("");
  return quoted === path ? path : `"${quoted}"`;
}

// ------------------------------------------------------------- unified diff

function textDiffLines(oldContent: LeafContent | null, newContent: LeafContent | null): string[] {
  const oldSplit = splitLines(leafText(oldContent));
  const newSplit = splitLines(leafText(newContent));
  const marks = diffSequences(rawLineKeys(oldContent), rawLineKeys(newContent));
  return unifiedBody(marks, oldSplit, newSplit);
}

function rawLineKeys(content: LeafContent | null): string[] {
  const raw =
    content?.kind === "file"
      ? Buffer.from(
          content.bytes.buffer,
          content.bytes.byteOffset,
          content.bytes.byteLength,
        ).toString("latin1")
      : leafText(content);
  return raw.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

type SplitText = { lines: string[]; endsWithNewline: boolean };

function splitLines(text: string): SplitText {
  if (text === "") return { lines: [], endsWithNewline: false };
  const endsWithNewline = text.endsWith("\n");
  const withoutFinalNewline = endsWithNewline ? text.slice(0, -1) : text;
  return { lines: withoutFinalNewline.split("\n"), endsWithNewline };
}

const CONTEXT_LINES = 3;

type PositionedMark = { mark: Mark; oldPos: number; newPos: number };

function unifiedBody(marks: Mark[], oldSplit: SplitText, newSplit: SplitText): string[] {
  const positioned: PositionedMark[] = [];
  let oldPos = 0;
  let newPos = 0;
  for (const mark of marks) {
    positioned.push({ mark, oldPos, newPos });
    if (mark !== "+") oldPos++;
    if (mark !== "-") newPos++;
  }
  const changeRuns: Array<[number, number]> = [];
  let runStart = -1;
  for (let index = 0; index < positioned.length; index++) {
    if (positioned[index]!.mark !== " ") {
      if (runStart === -1) runStart = index;
    } else if (runStart !== -1) {
      changeRuns.push([runStart, index - 1]);
      runStart = -1;
    }
  }
  if (runStart !== -1) changeRuns.push([runStart, positioned.length - 1]);
  if (changeRuns.length === 0) return [];

  const mergedRuns: Array<[number, number]> = [changeRuns[0]!];
  for (const run of changeRuns.slice(1)) {
    const previous = mergedRuns[mergedRuns.length - 1]!;
    const contextGap = run[0] - previous[1] - 1;
    if (contextGap <= 2 * CONTEXT_LINES) previous[1] = run[1];
    else mergedRuns.push(run);
  }

  const body: string[] = [];
  for (const [firstChange, lastChange] of mergedRuns) {
    const firstIndex = Math.max(0, firstChange - CONTEXT_LINES);
    const lastIndex = Math.min(positioned.length - 1, lastChange + CONTEXT_LINES);
    body.push(...hunkLines(positioned, firstIndex, lastIndex, oldSplit, newSplit));
  }
  return body;
}

function hunkLines(
  positioned: PositionedMark[],
  firstIndex: number,
  lastIndex: number,
  oldSplit: SplitText,
  newSplit: SplitText,
): string[] {
  let oldStart = 0;
  let oldCount = 0;
  let newStart = 0;
  let newCount = 0;
  for (let index = firstIndex; index <= lastIndex; index++) {
    const op = positioned[index]!;
    if (op.mark !== "+") {
      if (oldCount === 0) oldStart = op.oldPos + 1;
      oldCount++;
    }
    if (op.mark !== "-") {
      if (newCount === 0) newStart = op.newPos + 1;
      newCount++;
    }
  }
  if (oldCount === 0) oldStart = positioned[firstIndex]!.oldPos;
  if (newCount === 0) newStart = positioned[firstIndex]!.newPos;
  const lines = [`@@ -${rangeText(oldStart, oldCount)} +${rangeText(newStart, newCount)} @@`];
  for (let index = firstIndex; index <= lastIndex; index++) {
    const op = positioned[index]!;
    if (op.mark === "-") lines.push(`-${oldSplit.lines[op.oldPos]!}`);
    else if (op.mark === "+") lines.push(`+${newSplit.lines[op.newPos]!}`);
    else lines.push(` ${oldSplit.lines[op.oldPos]!}`);
    if (needsNoNewlineMarker(op, oldSplit, newSplit)) lines.push("\\ No newline at end of file");
  }
  return lines;
}

function needsNoNewlineMarker(
  op: PositionedMark,
  oldSplit: SplitText,
  newSplit: SplitText,
): boolean {
  const oldSideLacksNewline =
    op.mark !== "+" &&
    oldSplit.lines.length > 0 &&
    op.oldPos === oldSplit.lines.length - 1 &&
    !oldSplit.endsWithNewline;
  const newSideLacksNewline =
    op.mark !== "-" &&
    newSplit.lines.length > 0 &&
    op.newPos === newSplit.lines.length - 1 &&
    !newSplit.endsWithNewline;
  return oldSideLacksNewline || newSideLacksNewline;
}

function rangeText(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

// ------------------------------------------------------------- line diffing

const MYERS_STEP_LIMIT = 1024;

function diffSequences(oldLines: string[], newLines: string[]): Mark[] {
  const marks: Mark[] = [];
  diffRegion(oldLines, newLines, 0, oldLines.length, 0, newLines.length, marks);
  return marks;
}

function diffRegion(
  a: string[],
  b: string[],
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
  marks: Mark[],
): void {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
    marks.push(" ");
    aLo++;
    bLo++;
  }
  const suffix: Mark[] = [];
  while (aHi > aLo && bHi > bLo && a[aHi - 1] === b[bHi - 1]) {
    aHi--;
    bHi--;
    suffix.push(" ");
  }
  if (aLo < aHi || bLo < bHi) {
    if (!diffMiddle(a, b, aLo, aHi, bLo, bHi, marks))
      diffAroundAnchor(a, b, aLo, aHi, bLo, bHi, marks);
  }
  marks.push(...suffix);
}

function diffMiddle(
  a: string[],
  b: string[],
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
  marks: Mark[],
): boolean {
  const oldCount = aHi - aLo;
  const newCount = bHi - bLo;
  if (oldCount === 0) {
    for (let index = bLo; index < bHi; index++) marks.push("+");
    return true;
  }
  if (newCount === 0) {
    for (let index = aLo; index < aHi; index++) marks.push("-");
    return true;
  }
  const maxSteps = Math.min(oldCount + newCount, MYERS_STEP_LIMIT);
  const offset = maxSteps + 1;
  const frontier = new Int32Array(2 * maxSteps + 3);
  const trace: Int32Array[] = [];
  let endStep = -1;
  let endX = 0;
  let endY = 0;
  for (let step = 0; step <= maxSteps; step++) {
    for (let k = -step; k <= step; k += 2) {
      const belowValue = frontier[offset + k + 1]!;
      const diagonalValue = frontier[offset + k - 1]!;
      const fromBelow = k === -step || (k !== step && diagonalValue < belowValue);
      let x = fromBelow ? belowValue : diagonalValue + 1;
      let y = x - k;
      while (x < oldCount && y < newCount && a[aLo + x] === b[bLo + y]) {
        x++;
        y++;
      }
      frontier[offset + k] = x;
      if (x >= oldCount && y >= newCount) {
        endStep = step;
        endX = x;
        endY = y;
        break;
      }
    }
    trace.push(frontier.slice());
    if (endStep !== -1) break;
  }
  if (endStep === -1) return false;
  const reverseMarks: Mark[] = [];
  let x = endX;
  let y = endY;
  for (let step = endStep; step > 0; step--) {
    const previous = trace[step - 1]!;
    const k = x - y;
    const belowValue = previous[offset + k + 1]!;
    const diagonalValue = previous[offset + k - 1]!;
    const fromBelow = k === -step || (k !== step && diagonalValue < belowValue);
    const arrivalX = fromBelow ? belowValue : diagonalValue + 1;
    while (x > arrivalX) {
      x--;
      y--;
      reverseMarks.push(" ");
    }
    if (fromBelow) {
      y--;
      reverseMarks.push("+");
    } else {
      x--;
      reverseMarks.push("-");
    }
  }
  while (x > 0) {
    x--;
    y--;
    reverseMarks.push(" ");
  }
  reverseMarks.reverse();
  marks.push(...reverseMarks);
  return true;
}

function diffAroundAnchor(
  a: string[],
  b: string[],
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
  marks: Mark[],
): void {
  const oldCounts = new Map<string, number>();
  for (let index = aLo; index < aHi; index++) {
    oldCounts.set(a[index]!, (oldCounts.get(a[index]!) ?? 0) + 1);
  }
  const newCounts = new Map<string, number>();
  for (let index = bLo; index < bHi; index++) {
    newCounts.set(b[index]!, (newCounts.get(b[index]!) ?? 0) + 1);
  }

  let anchorOld = -1;
  let anchorWeight = Number.POSITIVE_INFINITY;
  const seenLines = new Set<string>();
  for (let index = aLo; index < aHi; index++) {
    const line = a[index]!;
    if (seenLines.has(line)) continue;
    seenLines.add(line);
    const newCount = newCounts.get(line);
    if (newCount === undefined) continue;
    const weight = (oldCounts.get(line) ?? 0) + newCount;
    if (weight < anchorWeight) {
      anchorWeight = weight;
      anchorOld = index;
    }
  }
  if (anchorOld === -1) {
    for (let index = aLo; index < aHi; index++) marks.push("-");
    for (let index = bLo; index < bHi; index++) marks.push("+");
    return;
  }
  const anchorLine = a[anchorOld]!;
  let anchorNew = -1;
  for (let index = bLo; index < bHi; index++) {
    if (b[index] === anchorLine) {
      anchorNew = index;
      break;
    }
  }
  diffRegion(a, b, aLo, anchorOld, bLo, anchorNew, marks);
  marks.push(" ");
  diffRegion(a, b, anchorOld + 1, aHi, anchorNew + 1, bHi, marks);
}

// ---------------------------------------------------------------- rendering

function renderSections(sections: Section[]): string {
  const tty = process.stdout.isTTY === true;
  return sections.map((section) => renderSection(section, tty)).join("\n\n\n") + "\n";
}

function renderSection(section: Section, tty: boolean): string {
  const heading = renderHeading(section.label, section.paths);
  const lines = [heading];
  if (section.body.length > 0) lines.push("");
  for (const line of section.body) lines.push(colorizeBodyLine(line, tty));
  return lines.join("\n");
}

function renderHeading(label: string, paths: string[]): string {
  const arrow = " → ";
  const text = `${label}: ${paths.join(arrow)}`;
  const fence = "─".repeat(displayWidth(text));
  return `${fence}\n${text}\n${fence}`;
}

function colorizeBodyLine(line: string, tty: boolean): string {
  if (!tty) return line;
  if (line.startsWith("@@")) return gray(line);
  if (line.startsWith("+")) return green(line);
  if (line.startsWith("-")) return red(line);
  return line;
}

function gray(text: string): string {
  return `\x1b[90m${text}\x1b[m`;
}

function green(text: string): string {
  return `\x1b[32m${text}\x1b[m`;
}

function red(text: string): string {
  return `\x1b[31m${text}\x1b[m`;
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

function distAbsolutePath(entry: DiffEntry, distRoot: string): string {
  if (entry.distPath === null) throw new Error(`entry has no dist path: ${entry.homePath}`);
  return join(distRoot, entry.distPath);
}
