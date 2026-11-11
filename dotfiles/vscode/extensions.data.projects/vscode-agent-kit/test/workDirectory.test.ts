import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  expandWorkDirectoryInput,
  requireWorkDirectory,
  sameWorkDirectory,
} from "../src/workDirectory";
import { cleanup, tempDir } from "./fixtures";

let root: string;

beforeEach(async () => {
  root = await tempDir("pi-work-directory-test-");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup(root);
});

describe("work directories", () => {
  it("normalizes an existing absolute directory", async () => {
    expect(await requireWorkDirectory(`${root}/./`)).toBe(root);
  });

  it("preserves a valid logical symlink cwd while comparing physical directory identity", async () => {
    const alias = join(root, "alias");
    await symlink(root, alias);
    expect(await requireWorkDirectory(alias)).toBe(alias);
    expect(await sameWorkDirectory(alias, root)).toBe(true);
  });

  it("recognizes two symlinks to the same directory without equating different directories", async () => {
    const first = join(root, "first");
    const second = join(root, "second");
    const other = join(root, "other");
    await symlink(root, first);
    await symlink(root, second);
    await mkdir(other);
    expect(await sameWorkDirectory(first, second)).toBe(true);
    expect(await sameWorkDirectory(first, other)).toBe(false);
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

describe("path expansion", () => {
  it("expands a lone tilde to the home directory", async () => {
    vi.stubEnv("HOME", root);

    expect(await requireWorkDirectory(expandWorkDirectoryInput("~"))).toBe(root);
  });

  it("expands a leading tilde path to the home directory", async () => {
    const project = join(root, "project");
    await mkdir(project);
    vi.stubEnv("HOME", root);

    expect(await requireWorkDirectory(expandWorkDirectoryInput("~/project"))).toBe(project);
  });

  it.each(["$PI_SESSIONS_TEST_ROOT", "${PI_SESSIONS_TEST_ROOT}"])(
    "keeps an environment reference literal in %s",
    (input) => {
      vi.stubEnv("PI_SESSIONS_TEST_ROOT", root);

      expect(expandWorkDirectoryInput(input)).toBe(input);
    },
  );

  it("keeps environment references after a leading tilde literal", () => {
    vi.stubEnv("HOME", root);
    vi.stubEnv("PI_SESSIONS_TEST_CHILD", "other");

    const expanded = expandWorkDirectoryInput("~/$PI_SESSIONS_TEST_CHILD");

    expect(expanded).toBe(join(root, "$PI_SESSIONS_TEST_CHILD"));
  });

  it("rejects a user-qualified tilde path as not absolute", async () => {
    await expect(requireWorkDirectory(expandWorkDirectoryInput("~root/project"))).rejects.toThrow(
      "absolute path",
    );
  });
});
