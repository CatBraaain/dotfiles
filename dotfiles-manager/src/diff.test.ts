import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { applyDifferences } from "./apply.ts";
import { collectDifferences, toDiffJson, type Classification, type DiffResult } from "./diff.ts";

let root: string;
let distRoot: string;
let homeRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "diff-test-"));
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

function assertOnly(
  result: DiffResult,
  classification: Classification,
  expected: string[],
  unchanged: string[] = [],
): void {
  for (const key of Object.keys(result) as Classification[]) {
    const expectedPaths = key === classification ? expected : key === "unchanged" ? unchanged : [];
    assert.deepEqual(pathsOf(result, key), expectedPaths, key);
  }
}

async function diff(platform = "linux"): Promise<DiffResult> {
  return collectDifferences(distRoot, homeRoot, platform);
}

async function put(rootDir: string, path: string, content: string | Uint8Array): Promise<string> {
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

describe("path mapping", () => {
  it("maps an .exact directory to the plain directory name", async () => {
    await put(distRoot, "conf.exact/a.txt", "content\n");
    await put(homeRoot, "conf/a.txt", "content\n");

    const result = await diff();

    assertOnly(result, "unchanged", ["conf", "conf/a.txt"]);
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

    assertOnly(result, "unchanged", ["d", "d/inner.txt"]);
  });
});

describe("path mapping (plain names without legacy prefixes)", () => {
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

  it("does not manage surplus below a child directory of an exact scope", async () => {
    await put(distRoot, "dir.exact/sub/keep.txt", "content\n");
    await put(homeRoot, "dir/sub/keep.txt", "content\n");
    await put(homeRoot, "dir/sub/node_modules", "generated\n");

    const result = await diff();

    // Exact scope covers only the direct children of dir.exact; the interior
    // of a managed child directory is left alone (spec §.exact の解釈).
    assert.deepEqual(pathsOf(result, "removedExact"), []);
    assert.deepEqual(pathsOf(result, "removedIgnored"), ["dir/sub/node_modules"]);
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
  it("skips build data, build hooks, and apply scripts including machine-specific names", async () => {
    await put(distRoot, "setup.build.ts", "hook\n");
    await put(distRoot, "setup.build-machine.ts", "machine hook\n");
    await put(distRoot, "remap.data.md", "map\n");
    await put(distRoot, "external.data.yaml", "config\n");
    await put(distRoot, "external.data-machine.yaml", "machine config\n");
    await put(distRoot, "task.apply.sh", "script\n");
    await put(distRoot, "task.apply-machine.ts", "machine script\n");

    const result = await diff();

    assert.deepEqual(result.unchanged, []);
    assert.deepEqual(result.added, []);
  });

  it("treats the retired machine sidecar name as an ordinary entry", async () => {
    await put(distRoot, "settings.machine.json", "{}\n");

    const result = await diff();

    assert.deepEqual(pathsOf(result, "added"), ["settings.machine.json"]);
  });
  it("treats .edit.ts as an ordinary file to apply", async () => {
    await put(distRoot, "app.conf.edit.ts", "ordinary file\n");

    const result = await diff();
    assertOnly(result, "added", ["app.conf.edit.ts"]);
    await applyDifferences(distRoot, homeRoot, result);
    assert.equal(await readFile(join(homeRoot, "app.conf.edit.ts"), "utf8"), "ordinary file\n");
  });

  it("skips nested entries under an excluded directory", async () => {
    await put(distRoot, "x/.build.data/generated.txt", "content\n");
    await put(distRoot, "x/keep.txt", "content\n");
    await put(homeRoot, "x/keep.txt", "content\n");

    const result = await diff();

    assert.deepEqual(pathsOf(result, "added"), []);
    assert.deepEqual(pathsOf(result, "unchanged"), ["x", "x/keep.txt"]);
  });

  it("does not count the home-side counterpart of an excluded entry as surplus", async () => {
    await put(distRoot, "x/setup.build.ts", "hook\n");
    await put(homeRoot, "x/setup.build.ts", "hook\n");
    await put(distRoot, "x/keep.txt", "content\n");
    await put(homeRoot, "x/keep.txt", "content\n");

    const result = await diff();

    assert.deepEqual(pathsOf(result, "removedIgnored"), []);
  });

  it("skips apply scripts, which run after applying instead", async () => {
    await put(distRoot, "setup.apply.sh", "#!/bin/sh\n");

    const result = await diff();

    assert.deepEqual(result.added, []);
  });

  it("diffs run_-prefixed files as normal entries", async () => {
    await put(distRoot, "run_eval.py", "print()\n");

    const result = await diff();

    assert.deepEqual(pathsOf(result, "added"), ["run_eval.py"]);
  });

  it("includes hook-generated node_modules inside existing directories", async () => {
    await put(distRoot, "pkg/node_modules/dep/index.js", "content\n");
    await put(distRoot, "pkg/keep.txt", "content\n");
    await put(homeRoot, "pkg/keep.txt", "content\n");

    assertOnly(
      await diff(),
      "added",
      ["pkg/node_modules", "pkg/node_modules/dep", "pkg/node_modules/dep/index.js"],
      ["pkg", "pkg/keep.txt"],
    );
  });

  it("includes hook-generated node_modules inside newly added directories", async () => {
    await put(distRoot, "pkg/node_modules/dep/index.js", "content\n");

    assertOnly(await diff(), "added", [
      "pkg",
      "pkg/node_modules",
      "pkg/node_modules/dep",
      "pkg/node_modules/dep/index.js",
    ]);
  });
});

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

    assertOnly(result, "removedExact", ["dir/extra.txt"], ["dir", "dir/keep.txt"]);
  });

  it("reports a surplus directory under an exact directory as one entry", async () => {
    await put(distRoot, "dir.exact/keep.txt", "content\n");
    await put(homeRoot, "dir/keep.txt", "content\n");
    await put(homeRoot, "dir/extra/deep.txt", "content\n");

    const result = await diff();

    assertOnly(result, "removedExact", ["dir/extra"], ["dir", "dir/keep.txt"]);
  });

  it("removes surplus directly beneath each nested exact directory", async () => {
    await put(distRoot, "outer.exact/inner.exact/keep.txt", "same\n");
    await put(distRoot, "outer.exact/plain/keep.txt", "same\n");
    await put(homeRoot, "outer/inner/keep.txt", "same\n");
    await put(homeRoot, "outer/inner/extra.txt", "extra\n");
    await put(homeRoot, "outer/plain/keep.txt", "same\n");
    await put(homeRoot, "outer/plain/extra.txt", "extra\n");
    await put(homeRoot, "outer/extra.txt", "extra\n");

    const result = await diff();

    assert.deepEqual(pathsOf(result, "removedExact"), ["outer/extra.txt", "outer/inner/extra.txt"]);
    assert.deepEqual(pathsOf(result, "removedIgnored"), ["outer/plain/extra.txt"]);
    assert.deepEqual(pathsOf(result, "unchanged"), [
      "outer",
      "outer/inner",
      "outer/inner/keep.txt",
      "outer/plain",
      "outer/plain/keep.txt",
    ]);
  });

  it("classifies home-only entries outside exact directories as removedIgnored", async () => {
    await put(distRoot, "dir/keep.txt", "content\n");
    await put(homeRoot, "dir/keep.txt", "content\n");
    await put(homeRoot, "dir/extra.txt", "content\n");

    const result = await diff();

    assertOnly(result, "removedIgnored", ["dir/extra.txt"], ["dir", "dir/keep.txt"]);
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

  it("treats a trailing comma in .json as a content change", async () => {
    await put(distRoot, "a.json", '{"key": [1, 2,],}');
    await put(homeRoot, "a.json", '{"key": [1, 2]}');

    const result = await diff();

    assertOnly(result, "changed", ["a.json"]);
  });

  it("treats whitespace in .jsonc as a content change", async () => {
    await put(distRoot, "a.jsonc", '{"key":  1}');
    await put(homeRoot, "a.jsonc", '{"key": 1}');

    const result = await diff();

    assertOnly(result, "changed", ["a.jsonc"]);
  });

  it("ignores exactly one trailing LF for ordinary files", async () => {
    await put(distRoot, "a.txt", "same\n");
    await put(homeRoot, "a.txt", "same");

    assertOnly(await diff(), "unchanged", ["a.txt"]);
  });

  it("retains a second trailing LF as content", async () => {
    await put(distRoot, "a.txt", "same\n\n");
    await put(homeRoot, "a.txt", "same");

    assertOnly(await diff(), "changed", ["a.txt"]);
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

describe("binary content", () => {
  it("classifies distinct malformed UTF-8 bytes and applies the original bytes", async () => {
    const expected = new Uint8Array([0x80, 0x0d, 0x0a]);
    await put(distRoot, "asset.bin", expected);
    await put(homeRoot, "asset.bin", new Uint8Array([0x81, 0x0d, 0x0a]));

    const result = await diff();
    assertOnly(result, "changed", ["asset.bin"]);
    await applyDifferences(distRoot, homeRoot, result);
    const actual = await readFile(join(homeRoot, "asset.bin"));
    assert.deepEqual([...actual], [...expected]);
  });

  it("compares CR and trailing LF as bytes when either input contains NUL", async () => {
    await put(distRoot, "asset.bin", new Uint8Array([0x00, 0x0d, 0x0a]));
    await put(homeRoot, "asset.bin", new Uint8Array([0x00, 0x0a]));

    assertOnly(await diff(), "changed", ["asset.bin"]);
  });

  it("does not strip trailing LF from NUL-containing content", async () => {
    await put(distRoot, "asset.bin", new Uint8Array([0x00, 0x0a]));
    await put(homeRoot, "asset.bin", new Uint8Array([0x00]));

    assertOnly(await diff(), "changed", ["asset.bin"]);
  });

  it("compares bytes if only one input is valid NUL-free UTF-8", async () => {
    await put(distRoot, "asset.bin", new Uint8Array([0x80]));
    await put(homeRoot, "asset.bin", "�");

    assertOnly(await diff(), "changed", ["asset.bin"]);
  });

  it("keeps identical binary bytes unchanged", async () => {
    const bytes = new Uint8Array([0x00, 0x0d, 0x0a]);
    await put(distRoot, "asset.bin", bytes);
    await put(homeRoot, "asset.bin", bytes);

    assertOnly(await diff(), "unchanged", ["asset.bin"]);
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
      [process.execPath, join(import.meta.dir, "diff.ts"), "--json", distRoot, homeRoot],
      { stdout: "pipe", stderr: "pipe", env: await gitOnlyEnvironment() },
    );
    const [stdout, exitCode] = await Promise.all([new Response(cli.stdout).text(), cli.exited]);

    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      `${JSON.stringify(
        {
          changed: ["modified.txt"],
          typeMismatches: [],
          added: ["added.txt"],
          removedExact: [],
          removedIgnored: [],
        },
        null,
        2,
      )}\n`,
    );
  });

  it("lists the directory itself on first and repeated --managed runs", async () => {
    await put(distRoot, "dir.exact/keep.txt", "content\n");

    const managed = async () => {
      const cli = Bun.spawn(
        [process.execPath, join(import.meta.dir, "diff.ts"), "--managed", distRoot, homeRoot],
        { stdout: "pipe", stderr: "pipe", env: await gitOnlyEnvironment() },
      );
      const [stdout, exitCode] = await Promise.all([new Response(cli.stdout).text(), cli.exited]);
      assert.equal(exitCode, 0);
      return stdout;
    };

    assert.equal(await managed(), "dir\ndir/keep.txt\n");
    await put(homeRoot, "dir/keep.txt", "content\n");
    assert.equal(await managed(), "dir\ndir/keep.txt\n");
  });

  it("gives --managed precedence over --json", async () => {
    await put(distRoot, "same.txt", "content\n");
    await put(homeRoot, "same.txt", "content\n");
    await put(distRoot, "added.txt", "content\n");

    const cli = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "diff.ts"),
        "--json",
        "--managed",
        distRoot,
        homeRoot,
      ],
      { stdout: "pipe", stderr: "pipe", env: await gitOnlyEnvironment() },
    );
    const [stdout, exitCode] = await Promise.all([new Response(cli.stdout).text(), cli.exited]);

    assert.equal(exitCode, 0);
    assert.equal(stdout, "added.txt\nsame.txt\n");
  });

  it("reports invalid roots and extra positional arguments on stderr", async () => {
    for (const roots of [
      [distRoot, join(root, "missing")],
      [distRoot, homeRoot, root],
    ]) {
      const cli = Bun.spawn([process.execPath, join(import.meta.dir, "diff.ts"), ...roots], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(cli.stdout).text(),
        new Response(cli.stderr).text(),
        cli.exited,
      ]);

      assert.notEqual(exitCode, 0);
      assert.equal(stdout, "");
      assert.notEqual(stderr, "");
    }
  });

  it("does not expose excluded entries in a newly added directory's normal CLI diff", async () => {
    await put(distRoot, "new/keep.jsonc", "visible\n");
    await put(distRoot, "new/private.data.jsonc", "secret-data\n");
    await put(distRoot, "new/.build.cache/hidden.jsonc", "secret-directory\n");
    await put(distRoot, "new/setup.build.ts", "secret-hook\n");

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dir, "diff.ts"), distRoot, homeRoot],
      { stdout: "pipe", stderr: "pipe", env: await gitOnlyEnvironment() },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /visible/);
    assert.doesNotMatch(
      stdout,
      /private\.data|secret-data|\.build\.cache|secret-directory|setup\.build|secret-hook/,
    );
  });

  it("renders each classified child of a newly added directory only once", async () => {
    await put(distRoot, "new/keep.jsonc", "first\n");
    await put(distRoot, "new/nested/child.jsonc", "second\n");

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dir, "diff.ts"), distRoot, homeRoot],
      { stdout: "pipe", stderr: "pipe", env: await gitOnlyEnvironment() },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /keep\.jsonc/);
    assert.match(stdout, /child\.jsonc/);
    assert.equal((stdout.match(/── Added · new\//g) ?? []).length, 2);
  });

  it("does not display CR and single trailing LF differences alone", async () => {
    await put(distRoot, "a.txt", "same\r\n");
    await put(homeRoot, "a.txt", "same");

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dir, "diff.ts"), distRoot, homeRoot],
      { stdout: "pipe", stderr: "pipe", env: await gitOnlyEnvironment() },
    );
    const [stdout, exitCode] = await Promise.all([new Response(cli.stdout).text(), cli.exited]);

    assert.equal(exitCode, 0);
    assert.equal(stdout, "");
  });

  it("renders binary CR/LF changes instead of suppressing them", async () => {
    await put(distRoot, "asset.bin", new Uint8Array([0x00, 0x0d, 0x0a]));
    await put(homeRoot, "asset.bin", new Uint8Array([0x00, 0x0a]));

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dir, "diff.ts"), distRoot, homeRoot],
      { stdout: "pipe", stderr: "pipe", env: await gitOnlyEnvironment() },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /Binary files .* differ/);
  });

  it("renders malformed UTF-8 patches directly without invoking delta", async () => {
    const binDir = join(root, "bin");
    await mkdir(binDir);
    const fakeDelta = await put(
      binDir,
      "delta",
      `#!${process.execPath}\nconsole.log("fake-delta-used");\nconsole.log(await Bun.stdin.text());\nprocess.exit(9);\n`,
    );
    await chmod(fakeDelta, 0o755);
    await put(distRoot, "asset.bin", new Uint8Array([0x80, 0x0d, 0x0a]));
    await put(homeRoot, "asset.bin", new Uint8Array([0x81, 0x0a]));

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dir, "diff.ts"), distRoot, homeRoot],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      },
    );
    const [stdout, exitCode] = await Promise.all([new Response(cli.stdout).text(), cli.exited]);

    assert.equal(exitCode, 0);
    assert.match(stdout, /── Modified · asset\.bin ──/);
    assert.match(stdout, /@@ -1 \+1 @@/);
    assert.equal(stdout.includes("\uFFFD"), true);
    assert.doesNotMatch(stdout, /fake-delta-used/);
  });

  it("renders added and exact-removed binary entries against empty inputs", async () => {
    await put(distRoot, "new.bin", new Uint8Array([0x00, 0x0a]));
    await put(distRoot, "dir.exact/keep.txt", "same\n");
    await put(homeRoot, "dir/keep.txt", "same\n");
    await put(homeRoot, "dir/old.bin", new Uint8Array([0x00, 0x0d, 0x0a]));

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dir, "diff.ts"), distRoot, homeRoot],
      { stdout: "pipe", stderr: "pipe", env: await gitOnlyEnvironment() },
    );
    const [stdout, exitCode] = await Promise.all([new Response(cli.stdout).text(), cli.exited]);

    assert.equal(exitCode, 0);
    assert.match(stdout, /Binary files .*new\.bin differ/);
    assert.match(stdout, /Binary files .*old\.bin.* differ/);
  });

  it("renders JSON content differences with git including raw trailing LF differences", async () => {
    await put(distRoot, "a.json", '{"value":2}\n');
    await put(homeRoot, "a.json", '{"value":1}');

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dir, "diff.ts"), distRoot, homeRoot],
      { stdout: "pipe", stderr: "pipe", env: await gitOnlyEnvironment() },
    );
    const [stdout, exitCode] = await Promise.all([new Response(cli.stdout).text(), cli.exited]);

    assert.equal(exitCode, 0);
    assert.match(stdout, /── Modified · a\.json ──/);
    assert.match(stdout, /No newline at end of file/);
  });

  it("displays a changed symlink target even when the link is broken", async () => {
    await put(distRoot, "link.symlink", "new-target\n");
    await putSymlink(homeRoot, "link", "old-target");

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dir, "diff.ts"), distRoot, homeRoot],
      { stdout: "pipe", stderr: "pipe", env: await gitOnlyEnvironment() },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /old-target/);
    assert.match(stdout, /new-target/);
  });

  it("renders both JSONC and ordinary text patches without invoking delta", async () => {
    const binDir = join(root, "bin");
    await mkdir(binDir);
    const fakeDelta = await put(
      binDir,
      "delta",
      `#!${process.execPath}\nconsole.log("fake-delta-used", process.argv.slice(2).join(" "));\nconsole.log(await Bun.stdin.text());\n`,
    );
    await chmod(fakeDelta, 0o755);
    await put(distRoot, "a.jsonc", '{"value": 1}\n');
    await put(distRoot, "b.txt", "text\n");

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dir, "diff.ts"), distRoot, homeRoot],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      },
    );
    const [stdout, exitCode] = await Promise.all([new Response(cli.stdout).text(), cli.exited]);

    assert.equal(exitCode, 0);
    assert.equal((stdout.match(/── Added · /g) ?? []).length, 2);
    assert.match(stdout, /── Added · a\.jsonc ──/);
    assert.match(stdout, /── Added · b\.txt ──/);
    assert.match(stdout, /\+\{"value": 1\}/);
    assert.doesNotMatch(stdout, /fake-delta-used/);
  });
});

async function gitOnlyEnvironment() {
  const binDir = join(root, "git-only");
  await mkdir(binDir, { recursive: true });
  if (!(await Bun.file(join(binDir, "git")).exists())) {
    await symlink(Bun.which("git")!, join(binDir, "git"));
  }
  return { ...process.env, PATH: binDir };
}

async function runGitOnlyDiff(extraEnv: Record<string, string> = {}) {
  const environment = await gitOnlyEnvironment();
  const cli = Bun.spawn([process.execPath, join(import.meta.dir, "diff.ts"), distRoot, homeRoot], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...environment, ...extraEnv },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(cli.stdout).text(),
    new Response(cli.stderr).text(),
    cli.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("Git rename display", () => {
  const original = "first\nsecond\nthird\nfourth\nfifth\n";

  it("shows a rename with mapped home paths and its mode-only change", async () => {
    await put(homeRoot, "conf/old.txt", original);
    await put(distRoot, "conf.exact/new.txt.executable", original);
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /── Renamed · conf\/old\.txt → conf\/new\.txt ──/);
    assert.match(stdout, /old mode 100644/);
    assert.match(stdout, /new mode 100755/);
    assert.doesNotMatch(stdout, /@@|\.exact|\.executable|diff-render-|[ab]\/(old|new)\/conf/);
    assert.equal(stdout.includes("\x1b["), false);
  });

  it("shows edited rename metadata and the original inputs' line-ending changes", async () => {
    await put(homeRoot, "conf/old.txt", original);
    await put(distRoot, "conf.exact/new.txt", "first\r\nsecond\nCHANGED\nfourth\nfifth\n");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /── Renamed · conf\/old\.txt → conf\/new\.txt ──/);
    assert.match(stdout, /@@/);
    assert.match(stdout, /CHANGED/);
    assert.equal(stripVTControlCharacters(stdout).includes("first\r"), true);
    assert.doesNotMatch(stdout, /diff --git|rename from|rename to|^index /m);
  });

  it("shows a normalized-equal rename as a pure rename heading without hunks", async () => {
    await put(homeRoot, "conf/old.txt", original);
    await put(distRoot, "conf.exact/new.txt", "first\r\nsecond\nthird\nfourth\nfifth");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /── Renamed · conf\/old\.txt → conf\/new\.txt ──/);
    assert.doesNotMatch(stdout, /@@|No newline|first/);
  });

  it("shows unmatched candidates as ordinary additions and deletions", async () => {
    await put(homeRoot, "conf/old.txt", original);
    await put(distRoot, "conf.exact/new.txt", "completely different replacement\n");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.doesNotMatch(stdout, /Renamed/);
    assert.doesNotMatch(stdout, /new file mode|deleted file mode/);
    assert.match(stdout, /── Added · conf\/new\.txt ──/);
    assert.match(stdout, /── Deleted · conf\/old\.txt ──/);
  });

  it("does not use ignored surplus, excluded counterparts, or unmanaged home files as candidates", async () => {
    await put(distRoot, "conf.exact/sub/keep.txt", "same\n");
    await put(homeRoot, "conf/sub/keep.txt", "same\n");
    await put(homeRoot, "conf/sub/ignored.txt", original);
    await put(homeRoot, "unmanaged.txt", original);
    await put(distRoot, "conf.exact/private.data.txt", original);
    await put(homeRoot, "conf/private.data.txt", original);
    await put(distRoot, "conf.exact/new.txt", original);
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.doesNotMatch(stdout, /Renamed|ignored\.txt|unmanaged\.txt|private\.data/);
    assert.match(stdout, /── Added · conf\/new\.txt ──/);
  });

  it("does not pair a changed entry with an addition", async () => {
    await put(homeRoot, "conf/changed.txt", original);
    await put(distRoot, "conf.exact/changed.txt", "unrelated replacement\n");
    await put(distRoot, "conf.exact/new.txt", original);
    const { stdout } = await runGitOnlyDiff();

    assert.doesNotMatch(stdout, /Renamed/);
    assert.match(stdout, /── Modified · conf\/changed\.txt ──/);
    assert.match(stdout, /── Added · conf\/new\.txt ──/);
  });

  it("keeps the five JSON categories and applies additions and exact deletions unchanged", async () => {
    await put(homeRoot, "conf/old.txt", original);
    await put(distRoot, "conf.exact/new.txt", original);
    const result = await diff();
    const json = toDiffJson(result);
    await runGitOnlyDiff();

    assert.deepEqual(json, {
      changed: [],
      typeMismatches: [],
      added: ["conf/new.txt"],
      removedExact: ["conf/old.txt"],
      removedIgnored: [],
    });
    assert.deepEqual(toDiffJson(result), json);
    assert.equal(await readFile(join(homeRoot, "conf/old.txt"), "utf8"), original);
    await applyDifferences(distRoot, homeRoot, result);
    assert.equal(await readFile(join(homeRoot, "conf/new.txt"), "utf8"), original);
    assert.equal(await Bun.file(join(homeRoot, "conf/old.txt")).exists(), false);
  });

  it("includes managed removed subtrees without following their symlinks", async () => {
    await put(homeRoot, "conf/old/nested.txt", original);
    await put(homeRoot, "outside/secret.txt", "do-not-follow\n");
    await putSymlink(homeRoot, "conf/old/link", "../../outside");
    await put(distRoot, "conf.exact/new.txt", original);
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /── Renamed · conf\/old\/nested\.txt → conf\/new\.txt ──/);
    assert.doesNotMatch(stdout, /secret\.txt|do-not-follow/);
  });

  it("filters excluded entries when rendering directory type mismatches", async () => {
    await put(homeRoot, "entry", "old-file\n");
    await put(distRoot, "entry.exact/keep.txt", "visible\n");
    await put(distRoot, "entry.exact/private.data.txt", "secret\n");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /keep\.txt|visible/);
    assert.doesNotMatch(stdout, /private\.data|secret|\.exact|diff-render-/);
  });

  it("keeps control characters and spaces in rename paths without parsing whitespace", async () => {
    await put(homeRoot, "conf/old name\tfile.txt", original);
    await put(distRoot, "conf.exact/new name\tfile.txt", original);
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /── Renamed · conf\/old name\tfile\.txt → conf\/new name\tfile\.txt ──/);
    assert.doesNotMatch(stdout, /@@/);
  });

  for (const [scenario, content] of [
    ["pure", original],
    ["edited", original.replace("third", "CHANGED")],
    ["normalized-equal", original.trimEnd()],
  ] as const) {
    it(`renders special rename paths raw in the heading (${scenario})`, async () => {
      const suffix = ' \x1b[2J\x07\x01\x1f\x7f\b\t\n\v\f\r"\\é日本.txt';
      await put(homeRoot, `conf/old${suffix}`, original);
      await put(distRoot, `conf.exact/new${suffix}`, content);
      const { stdout, stderr, exitCode } = await runGitOnlyDiff();

      assert.equal(exitCode, 0);
      assert.equal(stderr, "");
      assert.match(stdout, /── Renamed · conf\/old/);
      assert.equal((stdout.match(/é日本\.txt/g) ?? []).length, 2);
      assert.equal(stdout.includes("@@"), scenario === "edited");
    });
  }

  it("leaves ordinary UTF-8 rename paths readable", async () => {
    await put(homeRoot, "conf/旧é.txt", original);
    await put(distRoot, "conf.exact/新é.txt", original);
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /── Renamed · conf\/旧é\.txt → conf\/新é\.txt ──/);
    assert.doesNotMatch(stdout, /@@/);
  });

  it("disables external diff commands even when user Git configuration enables them", async () => {
    await put(homeRoot, "a.txt", "old\n");
    await put(distRoot, "a.txt", "new\n");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff({
      GIT_EXTERNAL_DIFF: "/does/not/exist",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "diff.external",
      GIT_CONFIG_VALUE_0: "/does/not/exist",
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /── Modified · a\.txt ──/);
    assert.match(stdout, /\+new/);
    assert.match(stdout, /-old/);
  });

  it("does not propagate Git error exit codes", async () => {
    await put(distRoot, "a.txt", "content\n");
    const binDir = join(root, "failed-git");
    const fakeGit = await put(
      binDir,
      "git",
      `#!${process.execPath}\nif (!process.argv.includes("--name-status")) console.log("git-output-before-error");\nprocess.exit(42);\n`,
    );
    await chmod(fakeGit, 0o755);
    const { stdout, stderr, exitCode } = await runGitOnlyDiff({ PATH: binDir });

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /git-output-before-error/);
  });
});

describe("diff display contract", () => {
  it("renders the SPEC Modified example byte-for-byte at width 80", async () => {
    await put(homeRoot, ".agents/config/agents.yaml", "agents:\n  model: old-model\n  enabled: true\n");
    await put(distRoot, ".agents/config/agents.yaml", "agents:\n  model: new-model\n  enabled: true\n");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    const rule = "─".repeat(80 - "── Modified · .agents/config/agents.yaml ".length);
    assert.equal(
      stdout,
      `── Modified · .agents/config/agents.yaml ${rule}\n` +
        "\n" +
        "@@ -1,3 +1,3 @@\n" +
        " agents:\n" +
        "-  model: old-model\n" +
        "+  model: new-model\n" +
        "   enabled: true\n",
    );
  });

  it("keeps a long path untruncated with the minimum right rule", async () => {
    const longPath = `${"d".repeat(30)}/${"x".repeat(70)}.txt`;
    await put(homeRoot, longPath, "old\n");
    await put(distRoot, longPath, "new\n");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.equal(stdout.split("\n")[0], `── Modified · ${longPath} ──`);
  });

  it("separates headings and bodies with one blank line and sections with two", async () => {
    const original = "first\nsecond\nthird\n";
    await put(homeRoot, "a.txt", "one\n");
    await put(distRoot, "a.txt", "two\n");
    await put(distRoot, "conf.exact/keep.txt", "same\n");
    await put(homeRoot, "conf/keep.txt", "same\n");
    await put(homeRoot, "conf/old.txt", original);
    await put(distRoot, "conf.exact/new.txt", original);
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    const modifiedRule = "─".repeat(80 - "── Modified · a.txt ".length);
    const renamedRule = "─".repeat(80 - "── Renamed · conf/old.txt → conf/new.txt ".length);
    assert.equal(
      stdout,
      `── Modified · a.txt ${modifiedRule}\n\n@@ -1 +1 @@\n-one\n+two\n\n\n` +
        `── Renamed · conf/old.txt → conf/new.txt ${renamedRule}\n`,
    );
  });

  it("renders the deleted content in the Deleted section body", async () => {
    await put(distRoot, "dir.exact/keep.txt", "same\n");
    await put(homeRoot, "dir/keep.txt", "same\n");
    await put(homeRoot, "dir/legacy.txt", "mode=legacy\nenabled=true\n");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /── Deleted · dir\/legacy\.txt ──/);
    assert.match(stdout, /@@ -1,2 \+0,0 @@/);
    assert.match(stdout, /^-mode=legacy$/m);
    assert.match(stdout, /^-enabled=true$/m);
  });

  it("renders a non-rename mode-only change with old mode and new mode lines", async () => {
    await putExecutable(distRoot, "tool.executable", "#!/bin/sh\n");
    await put(homeRoot, "tool", "#!/bin/sh\n");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /── Modified · tool ──/);
    assert.match(stdout, /^old mode 100644$/m);
    assert.match(stdout, /^new mode 100755$/m);
    assert.doesNotMatch(stdout, /@@/);
  });

  it("drops index and file headers while keeping body lines starting like them", async () => {
    await put(homeRoot, "meta.txt", "--- old\nplain\n");
    await put(distRoot, "meta.txt", "+++ new\nplain\n");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /── Modified · meta\.txt ──/);
    assert.match(stdout, /^---- old$/m);
    assert.match(stdout, /^\+\+\+\+ new$/m);
    assert.match(stdout, /^ plain$/m);
    assert.doesNotMatch(stdout, /^index /m);
    assert.doesNotMatch(stdout, /^--- meta\.txt$/m);
    assert.doesNotMatch(stdout, /^\+\+\+ meta\.txt$/m);
  });

  it("renders an empty added file as a heading-only Added section", async () => {
    await put(distRoot, "empty.txt", "");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    const rule = "─".repeat(80 - "── Added · empty.txt ".length);
    assert.equal(stdout, `── Added · empty.txt ${rule}\n`);
  });

  it("renders a directory type mismatch as Deleted and Added sections", async () => {
    await put(homeRoot, "entry", "old-file\n");
    await put(distRoot, "entry.exact/keep.txt", "visible\n");
    await put(distRoot, "entry.exact/private.data.txt", "secret\n");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /── Deleted · entry ──/);
    assert.match(stdout, /^-old-file$/m);
    assert.match(stdout, /── Added · entry\/keep\.txt ──/);
    assert.match(stdout, /^\+visible$/m);
    assert.doesNotMatch(stdout, /── Modified · entry ──/);
    assert.doesNotMatch(stdout, /private\.data|secret/);
  });

  it("renders a symlink type mismatch as Deleted and Added sections", async () => {
    await put(distRoot, "slink", "file-content\n");
    await putSymlink(homeRoot, "slink", "old-target");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /── Deleted · slink ──/);
    assert.match(stdout, /^-old-target$/m);
    assert.match(stdout, /── Added · slink ──/);
    assert.match(stdout, /^\+file-content$/m);
    assert.doesNotMatch(stdout, /── Modified · slink ──/);
  });
});
