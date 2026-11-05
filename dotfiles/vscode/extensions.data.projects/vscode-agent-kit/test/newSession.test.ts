import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { listSessionFileNames } from "../src/newSession";
import { cleanup, tempDir, writeJsonl } from "./fixtures";

describe("listSessionFileNames", () => {
  let root: string;
  let groupDir: string;

  beforeEach(async () => {
    root = await tempDir("pi-new-session-test-");
    groupDir = join(root, "--home-user-project--");
  });

  afterEach(async () => {
    await cleanup(root);
  });

  it("returns jsonl file names directly inside the group directory", async () => {
    await writeJsonl(groupDir, "t1_old.jsonl", []);
    await writeJsonl(groupDir, "t2_new.jsonl", []);
    const names = await listSessionFileNames(groupDir);

    expect(names.sort()).toEqual(["t1_old.jsonl", "t2_new.jsonl"]);
  });

  it("returns an empty list when the group directory does not exist", async () => {
    expect(await listSessionFileNames(join(root, "missing"))).toEqual([]);
  });

  it("ignores non-jsonl files and files inside subdirectories", async () => {
    await writeJsonl(groupDir, "notes.txt", []);
    await writeJsonl(join(groupDir, "nested"), "t1_inside.jsonl", []);
    await writeJsonl(groupDir, "t1_real.jsonl", []);

    expect(await listSessionFileNames(groupDir)).toEqual(["t1_real.jsonl"]);
  });
});
