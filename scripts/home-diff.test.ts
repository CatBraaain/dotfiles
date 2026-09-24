import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { tmpdir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join } from "node:path";
import {
  collectDifferences,
  toDiffJson,
  type Classification,
  type DiffResult,
} from "./home-diff.ts";

let root: string;
let distRoot: string;
let homeRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "home-diff-test-"));
  distRoot = join(root, "dist");
  homeRoot = join(root, "home");
  await mkdir(distRoot);
  await mkdir(homeRoot);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function pathsOf(result: DiffResult, classification: Classification): string[] {
  return result[classification].map((entry) => entry.homePath);
}

function assertOnly(result: DiffResult, classification: Classification, expected: string[]): void {
  // unchanged entries exist naturally alongside differences, so their exact
  // contents are asserted separately in each test that cares.
  for (const key of Object.keys(result) as Classification[]) {
    if (key === "unchanged") continue;
    assert.deepEqual(pathsOf(result, key), key === classification ? expected : [], key);
  }
}

async function diff(platform = "linux"): Promise<DiffResult> {
  return collectDifferences(distRoot, homeRoot, platform);
}

async function put(rootDir: string, path: string, content: string): Promise<string> {
  const absolute = join(rootDir, path);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content);
  return absolute;
}

async function putExecutable(rootDir: string, path: string, content: string): Promise<void> {
  const absolute = await put(rootDir, path, content);
  await chmod(absolute, 0o755);
}

async function putSymlink(rootDir: string, path: string, target: string): Promise<void> {
  const absolute = join(rootDir, path);
  await mkdir(join(absolute, ".."), { recursive: true });
  await symlink(target, absolute);
}

describe("classification matrix", () => {
  it("classifies identical content and executable bit as unchanged", async () => {
    await put(distRoot, "a.txt", "same\n");
    await put(homeRoot, "a.txt", "same\n");
    await putExecutable(distRoot, "tool.executable", "#!/bin/sh\n");
    await putExecutable(homeRoot, "tool", "#!/bin/sh\n");

    const result = await diff();

    assert.deepEqual(pathsOf(result, "unchanged"), ["a.txt", "tool"]);
  });

  it("classifies different content as changed", async () => {
    await put(distRoot, "a.txt", "new\n");
    await put(homeRoot, "a.txt", "old\n");

    const result = await diff();

    assertOnly(result, "changed", ["a.txt"]);
  });

  it("classifies a missing owner-execute bit as changed on linux", async () => {
    await put(distRoot, "tool.executable", "#!/bin/sh\n");
    await put(homeRoot, "tool", "#!/bin/sh\n");

    const result = await diff("linux");

    assertOnly(result, "changed", ["tool"]);
  });

  it("ignores executable bit differences on windows", async () => {
    await put(distRoot, "tool.executable", "#!/bin/sh\n");
    await put(homeRoot, "tool", "#!/bin/sh\n");

    const result = await diff("win32");

    assertOnly(result, "unchanged", ["tool"]);
  });

  it("classifies a plain file whose home copy gained owner-execute as changed", async () => {
    await put(distRoot, "notes.txt", "text\n");
    await putExecutable(homeRoot, "notes.txt", "text\n");

    const result = await diff("linux");

    assertOnly(result, "changed", ["notes.txt"]);
  });

  it("classifies a different symlink target as changed", async () => {
    await put(distRoot, "link.symlink", "target-a\n");
    await putSymlink(homeRoot, "link", "target-b");

    const result = await diff();

    assertOnly(result, "changed", ["link"]);
  });

  it("classifies file vs directory as typeMismatch", async () => {
    await put(distRoot, "entry.txt", "content\n");
    await put(homeRoot, "entry.txt/inner.txt", "content\n");

    const result = await diff();

    assertOnly(result, "typeMismatches", ["entry.txt"]);
  });

  it("classifies file vs symlink as typeMismatch", async () => {
    await put(distRoot, "entry.txt", "content\n");
    await putSymlink(homeRoot, "entry.txt", "elsewhere");

    const result = await diff();

    assertOnly(result, "typeMismatches", ["entry.txt"]);
  });

  it("classifies dist-only entries as added, including parent directories", async () => {
    await put(distRoot, "newdir/nested.txt", "content\n");

    const result = await diff();

    assertOnly(result, "added", ["newdir", "newdir/nested.txt"]);
  });

  it("classifies home-only entries under an exact directory as removedExact", async () => {
    await put(distRoot, "dir.exact/keep.txt", "content\n");
    await put(homeRoot, "dir/keep.txt", "content\n");
    await put(homeRoot, "dir/extra.txt", "content\n");

    const result = await diff();

    assert.deepEqual(pathsOf(result, "unchanged"), ["dir/keep.txt"]);
    assertOnly(result, "removedExact", ["dir/extra.txt"]);
  });

  it("reports a surplus directory under an exact directory as one entry", async () => {
    await put(distRoot, "dir.exact/keep.txt", "content\n");
    await put(homeRoot, "dir/keep.txt", "content\n");
    await put(homeRoot, "dir/extra/deep.txt", "content\n");

    const result = await diff();

    assertOnly(result, "removedExact", ["dir/extra"]);
  });

  it("classifies home-only entries outside exact directories as removedIgnored", async () => {
    await put(distRoot, "dir/keep.txt", "content\n");
    await put(homeRoot, "dir/keep.txt", "content\n");
    await put(homeRoot, "dir/extra.txt", "content\n");

    const result = await diff();

    assert.deepEqual(pathsOf(result, "unchanged"), ["dir/keep.txt"]);
    assertOnly(result, "removedIgnored", ["dir/extra.txt"]);
  });

  it("does not scan the home root itself for surplus entries", async () => {
    await put(distRoot, "managed.txt", "content\n");
    await put(homeRoot, "managed.txt", "content\n");
    await put(homeRoot, "unmanaged.txt", "content\n");

    const result = await diff();

    assertOnly(result, "unchanged", ["managed.txt"]);
  });
});

describe("normalization", () => {
  it("treats CRLF and LF text as identical", async () => {
    await put(distRoot, "a.txt", "line1\r\nline2\r\n");
    await put(homeRoot, "a.txt", "line1\nline2\n");

    const result = await diff();

    assertOnly(result, "unchanged", ["a.txt"]);
  });

  it("ignores trailing commas and whitespace in .json", async () => {
    await put(distRoot, "a.json", '{"key": [1, 2,],}');
    await put(homeRoot, "a.json", '{"key": [1, 2]}');

    const result = await diff();

    assertOnly(result, "unchanged", ["a.json"]);
  });

  it("ignores trailing commas and whitespace in .jsonc", async () => {
    await put(distRoot, "a.jsonc", '{"key": 1,}');
    await put(homeRoot, "a.jsonc", '{"key": 1}');

    const result = await diff();

    assertOnly(result, "unchanged", ["a.jsonc"]);
  });

  it("compares symlink targets ignoring exactly one trailing newline", async () => {
    await put(distRoot, "link.symlink", "shared-target\n");
    await putSymlink(homeRoot, "link", "shared-target");

    const result = await diff();

    assertOnly(result, "unchanged", ["link"]);
  });

  it("keeps a second trailing newline as part of the symlink target", async () => {
    await put(distRoot, "link.symlink", "target\n\n");
    await putSymlink(homeRoot, "link", "target");

    const result = await diff();

    assertOnly(result, "changed", ["link"]);
  });
});

describe("path mapping", () => {
  it("maps an .exact directory to the plain directory name", async () => {
    await put(distRoot, "conf.exact/a.txt", "content\n");
    await put(homeRoot, "conf/a.txt", "content\n");

    const result = await diff();

    assertOnly(result, "unchanged", ["conf/a.txt"]);
  });

  it("maps an .executable file to the plain file name", async () => {
    await putExecutable(distRoot, "s.sh.executable", "#!/bin/sh\n");
    await putExecutable(homeRoot, "s.sh", "#!/bin/sh\n");

    const result = await diff();

    assertOnly(result, "unchanged", ["s.sh"]);
  });

  it("maps an .symlink file to a home symlink", async () => {
    await put(distRoot, "l.symlink", "dest\n");
    await putSymlink(homeRoot, "l", "dest");

    const result = await diff();

    assertOnly(result, "unchanged", ["l"]);
  });

  it("keeps plain names as-is", async () => {
    await put(distRoot, "d/inner.txt", "content\n");
    await put(homeRoot, "d/inner.txt", "content\n");

    const result = await diff();

    assertOnly(result, "unchanged", ["d/inner.txt"]);
  });
});

describe("path mapping (plain names without chezmoi prefixes)", () => {
  it("treats dot_ names as plain entries, not hidden files", async () => {
    await put(distRoot, "dot_bashrc", "content\n");
    await put(homeRoot, "dot_bashrc", "content\n");

    const result = await diff();

    assertOnly(result, "unchanged", ["dot_bashrc"]);
  });

  it("treats exact_ directories as plain directories without exact scope", async () => {
    await put(distRoot, "exact_cfg/keep.txt", "content\n");
    await put(homeRoot, "exact_cfg/keep.txt", "content\n");
    await put(homeRoot, "exact_cfg/extra.txt", "content\n");

    const result = await diff();

    assert.deepEqual(pathsOf(result, "removedIgnored"), ["exact_cfg/extra.txt"]);
    assert.deepEqual(pathsOf(result, "removedExact"), []);
  });

  it("treats executable_ and symlink_ names as plain files", async () => {
    await put(distRoot, "executable_tool", "#!/bin/sh\n");
    await put(homeRoot, "executable_tool", "#!/bin/sh\n");
    await put(distRoot, "symlink_l", "dest\n");
    await put(homeRoot, "symlink_l", "dest\n");

    const result = await diff();

    assertOnly(result, "unchanged", ["executable_tool", "symlink_l"]);
  });
});

describe("exclusions", () => {
  it("skips entries starting with .pre-chezmoi, .pre-apply or .post-apply", async () => {
    await put(distRoot, ".pre-chezmoi.ts", "hook\n");
    await put(distRoot, ".pre-chezmoi-map.md", "map\n");
    await put(distRoot, ".pre-apply.ts", "hook\n");
    await put(distRoot, ".post-apply.ts", "hook\n");

    const result = await diff();

    assert.deepEqual(result.unchanged, []);
    assert.deepEqual(result.added, []);
  });

  it("skips nested entries under an excluded directory", async () => {
    await put(distRoot, "x/.pre-chezmoi.data/generated.txt", "content\n");
    await put(distRoot, "x/keep.txt", "content\n");
    await put(homeRoot, "x/keep.txt", "content\n");

    const result = await diff();

    assert.deepEqual(pathsOf(result, "added"), []);
    assert.deepEqual(pathsOf(result, "unchanged"), ["x/keep.txt"]);
  });

  it("does not count the home-side counterpart of an excluded entry as surplus", async () => {
    await put(distRoot, "x/.pre-chezmoi.ts", "hook\n");
    await put(homeRoot, "x/.pre-chezmoi.ts", "hook\n");
    await put(distRoot, "x/keep.txt", "content\n");
    await put(homeRoot, "x/keep.txt", "content\n");

    const result = await diff();

    assert.deepEqual(pathsOf(result, "removedIgnored"), []);
  });

  it("skips run_ scripts, which run at the post-apply point instead", async () => {
    await put(distRoot, "run_after_setup.sh", "#!/bin/sh\n");

    const result = await diff();

    assert.deepEqual(result.added, []);
  });

  it("skips node_modules anywhere in dist", async () => {
    await put(distRoot, "pkg/node_modules/dep/index.js", "content\n");
    await put(distRoot, "pkg/keep.txt", "content\n");
    await put(homeRoot, "pkg/keep.txt", "content\n");

    const result = await diff();

    assert.deepEqual(pathsOf(result, "added"), []);
    assert.deepEqual(pathsOf(result, "unchanged"), ["pkg/keep.txt"]);
  });
});

describe("diff json", () => {
  it("omits unchanged entries and keeps the five difference categories", async () => {
    await put(distRoot, "same.txt", "content\n");
    await put(homeRoot, "same.txt", "content\n");
    await put(distRoot, "modified.txt", "new\n");
    await put(homeRoot, "modified.txt", "old\n");

    const json = toDiffJson(await diff());

    assert.deepEqual(Object.keys(json), [
      "changed",
      "typeMismatches",
      "added",
      "removedExact",
      "removedIgnored",
    ]);
    assert.deepEqual(json.changed, ["modified.txt"]);
  });
});

describe("cli", () => {
  it("prints machine-readable differences with --json", async () => {
    await put(distRoot, "modified.txt", "new\n");
    await put(homeRoot, "modified.txt", "old\n");
    await put(distRoot, "added.txt", "content\n");

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dir, "home-diff.ts"), "--json", distRoot, homeRoot],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(cli.stdout).text(),
      cli.exited,
    ]);

    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(stdout), {
      changed: ["modified.txt"],
      typeMismatches: [],
      added: ["added.txt"],
      removedExact: [],
      removedIgnored: [],
    });
  });
});
