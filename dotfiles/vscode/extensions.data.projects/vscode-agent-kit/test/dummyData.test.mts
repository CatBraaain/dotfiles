import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createNameScan,
  displayNameFromScan,
  foldSessionEntryLine,
  parseSessionHeader,
} from "../src/sessionFile.js";
import { buildDummyDataDir } from "../scripts/dummyData.mjs";

interface MetadataStore {
  version: number;
  sessions: Record<string, { active: boolean }>;
}

function listSessionFiles(root: string): string[] {
  return readdirSync(path.join(root, "sessions", "demo")).filter((f) => f.endsWith(".jsonl"));
}

describe("buildDummyDataDir", () => {
  it("writes exactly three session files inside the isolated directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dummy-data-test-"));
    buildDummyDataDir(root);
    expect(listSessionFiles(root)).toHaveLength(3);
  });

  it("marks all three sessions active in the metadata store", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dummy-data-test-"));
    buildDummyDataDir(root);
    const store: MetadataStore = JSON.parse(
      readFileSync(path.join(root, "session-metadata.json"), "utf8"),
    );
    const entries = Object.values(store.sessions);
    expect(store.version).toBe(1);
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.active === true)).toBe(true);
  });

  it("writes session files the extension can parse and display", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dummy-data-test-"));
    buildDummyDataDir(root);
    for (const file of listSessionFiles(root)) {
      const lines = readFileSync(path.join(root, "sessions", "demo", file), "utf8")
        .trim()
        .split("\n");
      const header = parseSessionHeader(lines[0]);
      expect(header).not.toBeNull();
      expect(header?.cwd).toBeTruthy();
      const scan = createNameScan();
      for (const line of lines.slice(1)) foldSessionEntryLine(scan, line);
      expect(displayNameFromScan(scan)).not.toBe("Untitled");
    }
  });

  it("staggeres file mtimes so the list order is stable", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dummy-data-test-"));
    buildDummyDataDir(root);
    const mtimes = listSessionFiles(root).map((file) =>
      statSync(path.join(root, "sessions", "demo", file)).mtimeMs,
    );
    expect(new Set(mtimes).size).toBe(3);
  });

  it("rebuilds the directory from scratch on repeated calls", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dummy-data-test-"));
    buildDummyDataDir(root);
    buildDummyDataDir(root);
    expect(listSessionFiles(root)).toHaveLength(3);
  });
});
