// Compares the engine's own diff JSON (scripts/home-diff.ts --json) with the
// JSONL recorded by scripts/chezmoi-diff-collate.ts and reports detection gaps
// in both directions, as home-relative paths.

// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { readFile } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { homedir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { relative, sep } from "node:path";

declare const process: {
  argv: string[];
  exitCode: number;
  stdout: { write(data: string): void };
};
declare const console: { error(...data: unknown[]): void };
declare global {
  interface ImportMeta {
    readonly main: boolean;
  }
}

export type CollateRecord = { destination: string; target: string };

/** Self diff JSON as produced by home-diff.ts --json. */
export type SelfDiff = {
  changed: string[];
  typeMismatches: string[];
  added: string[];
  removedExact: string[];
  removedIgnored: string[];
};

export type ComparisonReport = {
  chezmoiOnly: string[];
  selfOnly: string[];
  removedIgnoredCount: number;
};

const usage =
  "usage: bun scripts/collate-report.ts <homeDiff.json> <collate.jsonl> [homeRoot] (default homeRoot: ~)";

// ---------------------------------------------------------------- public API

export function toHomeRelative(destination: string, homeRoot: string): string {
  return relative(homeRoot, destination).split(sep).join("/");
}

export function buildReport(
  records: CollateRecord[],
  self: SelfDiff,
  homeRoot: string,
): ComparisonReport {
  // removedIgnored entries are by design not reported to chezmoi, so they are
  // kept out of the self-detected set compared here.
  const chezmoiDetected = new Set(records.map((record) => toHomeRelative(record.destination, homeRoot)));
  const selfDetected = new Set([
    ...self.changed,
    ...self.typeMismatches,
    ...self.added,
    ...self.removedExact,
  ]);
  return {
    chezmoiOnly: [...chezmoiDetected]
      .filter((path) => !selfDetected.has(path))
      .sort(compareCodeUnits),
    selfOnly: [...selfDetected]
      .filter((path) => !chezmoiDetected.has(path))
      .sort(compareCodeUnits),
    removedIgnoredCount: self.removedIgnored.length,
  };
}

export async function readCollateRecords(jsonlPath: string): Promise<CollateRecord[]> {
  const content = (await readFile(jsonlPath, "utf8")) as string;
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CollateRecord);
}

export async function main(argv: readonly string[]): Promise<number> {
  const [selfJsonPath, jsonlPath, homeRootArgument = "~"] = argv;
  if (!selfJsonPath || !jsonlPath) throw new Error(usage);
  const homeRoot = homeRootArgument === "~" ? homedir() : homeRootArgument;

  const self = JSON.parse(await readFile(selfJsonPath, "utf8")) as SelfDiff;
  const records = await readCollateRecords(jsonlPath);
  const report = buildReport(records, self, homeRoot);

  const lines = [
    `chezmoi-only (detected by chezmoi, missed by home-diff): ${report.chezmoiOnly.length}`,
    ...report.chezmoiOnly.map((path) => `  ${path}`),
    `self-only (detected by home-diff, missed by chezmoi): ${report.selfOnly.length}`,
    ...report.selfOnly.map((path) => `  ${path}`),
    `note: removedIgnored entries (${report.removedIgnoredCount}) are not reported to chezmoi by design`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return report.chezmoiOnly.length + report.selfOnly.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
