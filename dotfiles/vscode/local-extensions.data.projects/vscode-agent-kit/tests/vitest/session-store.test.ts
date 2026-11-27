import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionFileExists } from "../../src/session-store";
import { cleanup, tempDir } from "./fixtures";

let root: string;

beforeEach(async () => {
  root = await tempDir("pi-session-store-test-");
});

afterEach(async () => {
  await cleanup(root);
});

describe("sessionFileExists", () => {
  it("returns true only for an existing regular file", async () => {
    const filePath = join(root, "session.jsonl");
    await writeFile(filePath, "{}\n");

    await expect(sessionFileExists(filePath)).resolves.toBe(true);
    await expect(sessionFileExists(root)).resolves.toBe(false);
    await expect(sessionFileExists(join(root, "missing.jsonl"))).resolves.toBe(false);
  });

  it("propagates errors other than a missing file", async () => {
    const directory = join(root, "denied");
    await mkdir(directory);
    await writeFile(join(directory, "session.jsonl"), "{}\n");
    chmodSync(directory, 0o000);
    try {
      await expect(sessionFileExists(join(directory, "session.jsonl"))).rejects.toThrow();
    } finally {
      chmodSync(directory, 0o755);
    }
  });
});
