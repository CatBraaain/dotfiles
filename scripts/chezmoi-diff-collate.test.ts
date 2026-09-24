import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { tmpdir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join } from "node:path";
import { recordInvocation, run } from "./chezmoi-diff-collate.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "collate-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("recordInvocation", () => {
  it("appends one JSON line per invocation", async () => {
    const recordPath = join(root, "collate.jsonl");

    await recordInvocation(recordPath, "/home/a.txt", "/dist/dot_a.txt");
    await recordInvocation(recordPath, "/home/b.txt", "/dist/dot_b.txt");

    const content = await readFile(recordPath, "utf8");
    assert.equal(
      content,
      '{"destination":"/home/a.txt","target":"/dist/dot_a.txt"}\n' +
        '{"destination":"/home/b.txt","target":"/dist/dot_b.txt"}\n',
    );
  });
});

describe("run", () => {
  it("records the invocation and delegates to chezmoi-diff with identical arguments", async () => {
    const destination = join(root, "home-copy.txt");
    const target = join(root, "dist-copy.txt");
    await writeFile(destination, "same content\n");
    await writeFile(target, "same content\n");
    const recordPath = join(root, "collate.jsonl");

    const exitCode = await run([
      "bun",
      "chezmoi-diff-collate.ts",
      destination,
      target,
      recordPath,
    ]);

    assert.equal(exitCode, 0);
    const content = await readFile(recordPath, "utf8");
    assert.deepEqual(content.split("\n").slice(0, 1), [
      JSON.stringify({ destination, target }),
    ]);
  });

  it("fails when destination or target is missing", async () => {
    await assert.rejects(
      () => run(["bun", "chezmoi-diff-collate.ts"]),
      /requires destination and target/,
    );
  });

  it("fails when the record file path is missing", async () => {
    await assert.rejects(
      () => run(["bun", "chezmoi-diff-collate.ts", "/home/a", "/dist/a"]),
      /requires a record file path/,
    );
  });
});
