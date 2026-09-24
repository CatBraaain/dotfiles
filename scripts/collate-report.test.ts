import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { tmpdir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join } from "node:path";
import {
  buildReport,
  readCollateRecords,
  toHomeRelative,
  type CollateRecord,
  type SelfDiff,
} from "./collate-report.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "collate-report-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function selfDiff(overrides: Partial<SelfDiff> = {}): SelfDiff {
  return {
    changed: [],
    typeMismatches: [],
    added: [],
    removedExact: [],
    removedIgnored: [],
    ...overrides,
  };
}

describe("toHomeRelative", () => {
  it("strips the home root from an absolute destination path", () => {
    const homeRoot = join(root, "home");

    const relative = toHomeRelative(join(homeRoot, "a", "b.txt"), homeRoot);

    assert.equal(relative, "a/b.txt");
  });
});

describe("buildReport", () => {
  const homeRoot = "/home/tester";

  function record(destination: string): CollateRecord {
    return { destination, target: "/somewhere/dist/irrelevant" };
  }

  it("reports nothing when both sides detect the same entries", () => {
    const records = [record("/home/tester/a.txt"), record("/home/tester/.config/b.toml")];
    const self = selfDiff({ changed: ["a.txt", ".config/b.toml"] });

    const report = buildReport(records, self, homeRoot);

    assert.deepEqual(report.chezmoiOnly, []);
    assert.deepEqual(report.selfOnly, []);
  });

  it("reports entries detected by chezmoi but missed by home-diff", () => {
    const records = [record("/home/tester/only-chezmoi.txt")];

    const report = buildReport(records, selfDiff(), homeRoot);

    assert.deepEqual(report.chezmoiOnly, ["only-chezmoi.txt"]);
    assert.deepEqual(report.selfOnly, []);
  });

  it("reports entries detected by home-diff but missed by chezmoi", () => {
    const self = selfDiff({
      changed: ["only-self.txt"],
      typeMismatches: ["kind.txt"],
      added: ["new.txt"],
      removedExact: ["exact/extra.txt"],
    });

    const report = buildReport([], self, homeRoot);

    assert.deepEqual(report.chezmoiOnly, []);
    assert.deepEqual(report.selfOnly, ["exact/extra.txt", "kind.txt", "new.txt", "only-self.txt"]);
  });

  it("keeps removedIgnored entries out of the self-detected set", () => {
    const self = selfDiff({ removedIgnored: ["config/leftover.txt"] });

    const report = buildReport([], self, homeRoot);

    assert.deepEqual(report.selfOnly, []);
    assert.equal(report.removedIgnoredCount, 1);
  });

  it("deduplicates repeated chezmoi invocations for the same destination", () => {
    const records = [record("/home/tester/a.txt"), record("/home/tester/a.txt")];
    const self = selfDiff({ changed: ["a.txt"] });

    const report = buildReport(records, self, homeRoot);

    assert.deepEqual(report.chezmoiOnly, []);
    assert.deepEqual(report.selfOnly, []);
  });
});

describe("readCollateRecords", () => {
  it("parses one JSON object per non-empty line", async () => {
    const jsonlPath = join(root, "collate.jsonl");
    await writeFile(
      jsonlPath,
      [
        '{"destination":"/home/a","target":"/dist/dot_a"}',
        "",
        '{"destination":"/home/b","target":"/dist/dot_b"}',
        "",
      ].join("\n"),
    );

    const records = await readCollateRecords(jsonlPath);

    assert.deepEqual(records, [
      { destination: "/home/a", target: "/dist/dot_a" },
      { destination: "/home/b", target: "/dist/dot_b" },
    ]);
  });

  it("returns an empty list for an empty record file", async () => {
    const jsonlPath = join(root, "empty.jsonl");
    await writeFile(jsonlPath, "");

    const records = await readCollateRecords(jsonlPath);

    assert.deepEqual(records, []);
  });
});
