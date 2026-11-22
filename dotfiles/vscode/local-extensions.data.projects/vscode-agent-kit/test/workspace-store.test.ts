import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceStore } from "../src/workspace-store";
import { cleanup, tempDir } from "./fixtures";

vi.mock("node:fs/promises", { spy: true });

let root: string;
let directory: string;
let first: WorkspaceStore;
let second: WorkspaceStore;

beforeEach(async () => {
  root = await tempDir("pi-workspace-store-");
  directory = join(root, "workspaces");
  first = new WorkspaceStore(directory);
  second = new WorkspaceStore(directory);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup(root);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("WorkspaceStore", () => {
  it("returns an empty collection before the first workspace is saved", async () => {
    expect(await first.list()).toEqual(new Set());
    await expect(fs.readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stores only the cwd and restores it through a new client", async () => {
    const cwd = `/project/${"long-directory".repeat(30)}`;
    await first.add(cwd);
    const names = await fs.readdir(directory);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[a-f0-9]{64}\.cwd$/);
    expect(await fs.readFile(join(directory, names[0]), "utf8")).toBe(cwd);
    expect(await second.list()).toEqual(new Set([cwd]));
  });

  it("keeps both concurrent additions from independent clients", async () => {
    expect(await first.list()).toEqual(new Set());
    expect(await second.list()).toEqual(new Set());
    await Promise.all([first.add("/first"), second.add("/second")]);
    expect(await first.list()).toEqual(new Set(["/first", "/second"]));
    expect(await second.list()).toEqual(new Set(["/first", "/second"]));
  });

  it("does not revive a removed cwd when another client adds a different cwd", async () => {
    await first.add("/removed");
    expect(await second.list()).toEqual(new Set(["/removed"]));
    await first.remove("/removed");
    await second.add("/new");
    expect(await first.list()).toEqual(new Set(["/new"]));
    expect(await second.list()).toEqual(new Set(["/new"]));
  });

  it("retries a failed write without losing previously saved workspaces", async () => {
    await first.add("/saved");
    const writeFile = fs.writeFile;
    vi.spyOn(fs, "writeFile").mockImplementationOnce(async (file, _content, options) => {
      await writeFile(file, "/partial", options);
      throw new Error("write failed");
    });
    await expect(first.add("/new")).rejects.toThrow("write failed");
    expect(await first.list()).toEqual(new Set(["/saved"]));
    expect(await second.list()).toEqual(new Set(["/saved"]));
    await first.add("/new");
    expect(await second.list()).toEqual(new Set(["/saved", "/new"]));
  });

  it("does not publish a failed rename and retries it through the same client", async () => {
    await first.add("/saved");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));
    await expect(first.add("/new")).rejects.toThrow("rename failed");
    expect(await first.list()).toEqual(new Set(["/saved"]));
    expect(await fs.readdir(directory)).toHaveLength(1);
    await first.add("/new");
    expect(await second.list()).toEqual(new Set(["/saved", "/new"]));
  });

  it("ignores an incomplete temporary file until its atomic publication", async () => {
    await first.add("/saved");
    const started = deferred();
    const release = deferred();
    const writeFile = fs.writeFile;
    vi.spyOn(fs, "writeFile").mockImplementationOnce(async (file, content, options) => {
      await writeFile(file, "/partial", options);
      started.resolve();
      await release.promise;
      await writeFile(file, content);
    });
    const adding = first.add("/new");
    await started.promise;
    try {
      expect(await second.list()).toEqual(new Set(["/saved"]));
      const temporary = (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp"));
      expect(temporary).toHaveLength(1);
      expect(await fs.readFile(join(directory, temporary[0]), "utf8")).toBe("/partial");
    } finally {
      release.resolve();
      await adding;
    }
    expect(await second.list()).toEqual(new Set(["/saved", "/new"]));
  });

  it("keeps a failed removal on disk and retries without a stale cache", async () => {
    await first.add("/saved");
    expect(await second.list()).toEqual(new Set(["/saved"]));
    vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("remove failed"));
    await expect(first.remove("/saved")).rejects.toThrow("remove failed");
    expect(await first.list()).toEqual(new Set(["/saved"]));
    expect(await second.list()).toEqual(new Set(["/saved"]));
    await first.remove("/saved");
    expect(await first.list()).toEqual(new Set());
    expect(await second.list()).toEqual(new Set());
  });

  it("reports an invalid committed value without deleting it", async () => {
    await first.add("/saved");
    const [name] = await fs.readdir(directory);
    const path = join(directory, name);
    await fs.writeFile(path, "relative");
    await expect(first.list()).rejects.toThrow("Invalid stored workspace");
    expect(await fs.readFile(path, "utf8")).toBe("relative");
  });

  it("allows repeated removal when the workspace file is already absent", async () => {
    await first.add("/saved");
    await first.remove("/saved");
    await second.remove("/saved");
    expect(await first.list()).toEqual(new Set());
  });
});
