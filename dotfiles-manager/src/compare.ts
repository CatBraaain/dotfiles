// Dist/home entry comparison core shared by diff detection and apply
// (spec: SPEC.md §差分検知 の内容比較, §.symlink の解釈, §.executable の解釈).
import { lstat, readFile, readlink } from "node:fs/promises";
import type { EntryKind } from "./path-mapping.ts";
import type { Stats } from "node:fs";

export function comparesExecutableBits(platform: string): boolean {
  return platform === "linux" || platform === "darwin";
}

export async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

// A .symlink entry is a plain file in dist; the target is its content with
// one trailing newline stripped (spec §.symlink の解釈).
export async function readSymlinkTarget(distAbs: string): Promise<string> {
  const rawTarget = await readFile(distAbs, "utf8");
  return rawTarget.endsWith("\n") ? rawTarget.slice(0, -1) : rawTarget;
}

export async function fileDiffers(distAbs: string, homeAbs: string): Promise<boolean> {
  return (await compareFiles(distAbs, homeAbs)).differs;
}

export async function symlinkDiffers(distAbs: string, homeAbs: string): Promise<boolean> {
  return (await readSymlinkTarget(distAbs)) !== (await readlink(homeAbs));
}

function executableDiffers(distExpectsExecutable: boolean, homeStat: { mode: number }): boolean {
  const homeHasOwnerExecute = (homeStat.mode & 0o100) !== 0;
  return distExpectsExecutable !== homeHasOwnerExecute;
}

// One dist/home entry comparison: symlink target for symlinks, normalized
// text or byte content for files, plus the owner execute bit on unix.
export async function entryDiffers(
  distAbs: string,
  homeAbs: string,
  mapping: { kind: EntryKind; isExecutable: boolean },
  homeStat: { mode: number },
  platform: string,
): Promise<boolean> {
  if (mapping.kind === "symlink") return symlinkDiffers(distAbs, homeAbs);
  return (
    (await fileDiffers(distAbs, homeAbs)) ||
    (comparesExecutableBits(platform) && executableDiffers(mapping.isExecutable, homeStat))
  );
}

export async function compareFiles(
  firstPath: string,
  secondPath: string,
): Promise<{ differs: boolean; isText: boolean }> {
  const [first, second]: [Uint8Array, Uint8Array] = await Promise.all([
    readFile(firstPath),
    readFile(secondPath),
  ]);
  const firstText = decodeText(first);
  const secondText = decodeText(second);
  if (firstText !== null && secondText !== null)
    return { differs: normalizeText(firstText) !== normalizeText(secondText), isText: true };
  return {
    differs: first.length !== second.length || first.some((byte, index) => byte !== second[index]),
    isText: false,
  };
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

// spec §差分検知: strip CR before comparing (CRLF == LF), then ignore one
// trailing newline for text files.
function normalizeText(text: string): string {
  const withoutCarriageReturns = text.replaceAll("\r", "");
  return withoutCarriageReturns.endsWith("\n")
    ? withoutCarriageReturns.slice(0, -1)
    : withoutCarriageReturns;
}
