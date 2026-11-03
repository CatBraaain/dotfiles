import type { FullResult } from "playwright/types/testReporter";

export interface SpecCase {
  id: string;
  title: string;
}

export interface GalleryImage {
  name: string;
  url?: string;
  width?: number;
  height?: number;
  error?: string;
}

export interface GalleryStep {
  title: string;
  status: string;
  images: GalleryImage[];
}

export interface GalleryAttempt {
  retry: number;
  worker: number;
  parallel: number;
  status: string;
  errors: string[];
  annotations: string[];
  steps: GalleryStep[];
}

export interface GalleryTest {
  specId?: string;
  title: string;
  project: string;
  repeat: number;
  outcome: string;
  attempts: GalleryAttempt[];
}

export interface GalleryRun {
  started: string;
  status: FullResult["status"] | "running";
  environment: string;
  errors: string[];
  tests: GalleryTest[];
  cases: SpecCase[];
}

export function parseSpecCases(source: string): SpecCase[] {
  const lines = source.split(/\r?\n/);
  const cases: SpecCase[] = [];
  let inCases = false;
  for (const [index, line] of lines.entries()) {
    if (line === "## テストケース") {
      inCases = true;
      continue;
    }
    if (inCases && line.startsWith("##")) break;
    if (!inCases || !line.trimStart().startsWith("|")) continue;
    const cells = splitTableRow(line);
    if (!/^E2E-\d+$/.test(cells[0])) continue;
    if (cells.length !== 5 || !cells[1] || !cells[2])
      throw new Error(`Invalid SPEC test case at line ${index + 1}`);
    if (cases.some((entry) => entry.id === cells[0]))
      throw new Error(`Duplicate SPEC test case: ${cells[0]}`);
    cases.push({ id: cells[0], title: cells[1] });
  }
  if (!cases.length) throw new Error("SPEC.md has no E2E cases in its test case table");
  return cases;
}

export function serializeGalleryRun(run: GalleryRun): string {
  const escaped: Record<string, string> = {
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029",
  };
  const serialized = JSON.stringify(run).replace(
    /[<>&\u2028\u2029]/g,
    (character) => escaped[character],
  );
  return `globalThis.E2E_GALLERY_RUN = ${serialized};\n`;
}

function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of line.trim().slice(1, -1)) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}
