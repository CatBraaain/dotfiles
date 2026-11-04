import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireWorkDirectory } from "../src/workDirectory";
import { cleanup, tempDir } from "./fixtures";

let root: string;

beforeEach(async () => {
  root = await tempDir("pi-work-directory-test-");
});

afterEach(async () => {
  await cleanup(root);
});

describe("work directories", () => {
  it("normalizes an existing absolute directory", async () => {
    expect(await requireWorkDirectory(`${root}/./`)).toBe(root);
  });

  it("rejects a relative cwd", async () => {
    await expect(requireWorkDirectory("relative/project")).rejects.toThrow("absolute path");
  });

  it("rejects a missing cwd", async () => {
    await expect(requireWorkDirectory(join(root, "missing"))).rejects.toThrow();
  });

  it("rejects a file as cwd", async () => {
    const filePath = join(root, "file");
    await writeFile(filePath, "test");
    await expect(requireWorkDirectory(filePath)).rejects.toThrow("not a directory");
  });
});
