import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
    assert.equal((stdout.match(/^Added: new\//gm) ?? []).length, 2);
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
    assert.match(stdout, /^Modified: asset\.bin$/m);
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
    assert.match(stdout, /^Modified: a\.json$/m);
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
    assert.equal((stdout.match(/^Added: /gm) ?? []).length, 2);
    assert.match(stdout, /^Added: a\.jsonc$/m);
    assert.match(stdout, /^Added: b\.txt$/m);
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
  const tracePath = join(root, "git-trace");
  const cli = Bun.spawn([process.execPath, join(import.meta.dir, "diff.ts"), distRoot, homeRoot], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...environment, GIT_TRACE: tracePath, ...extraEnv },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(cli.stdout).text(),
    new Response(cli.stderr).text(),
    cli.exited,
  ]);
  const traceFile = Bun.file(tracePath);
  const gitTrace = (await traceFile.exists()) ? await traceFile.text() : "";
  return { stdout, stderr, exitCode, gitTrace };
}

describe("diff display preparation", () => {
  for (const ignoredSurplus of [false, true]) {
    it(`skips temporary storage and Git with no displayed differences (ignored surplus: ${ignoredSurplus})`, async () => {
      await put(distRoot, "conf/same.txt", "same\n");
      await put(homeRoot, "conf/same.txt", "same\n");
      if (ignoredSurplus) await put(homeRoot, "conf/ignored.txt", "ignored\n");
      const blockedTemporaryRoot = await put(root, "blocked-tmp", "not a directory\n");

      const actual = await runGitOnlyDiff({ TMPDIR: blockedTemporaryRoot });

      assert.deepEqual(actual, { stdout: "", stderr: "", exitCode: 0, gitTrace: "" });
    });
  }

  for (const emptySide of ["added", "removed"] as const) {
    it(`skips rename detection when the ${emptySide} snapshot has no leaves`, async () => {
      await mkdir(join(distRoot, "conf.exact"));
      await mkdir(join(homeRoot, "conf"));
      if (emptySide === "added") {
        await mkdir(join(distRoot, "conf.exact/empty"));
        await put(homeRoot, "conf/old.txt", "old\n");
      } else {
        await mkdir(join(homeRoot, "conf/empty"));
        await put(distRoot, "conf.exact/new.txt", "new\n");
      }
      const blockedTemporaryRoot = await put(root, "blocked-tmp", "not a directory\n");
      const { stdout, stderr, exitCode, gitTrace } = await runGitOnlyDiff({
        TMPDIR: blockedTemporaryRoot,
      });

      assert.equal(exitCode, 0);
      assert.equal(stderr, "");
      const expectedHeading =
        emptySide === "added" ? "Deleted: conf/old.txt" : "Added: conf/new.txt";
      const headings = stdout.split("\n").filter((line) => /^(Added|Deleted|Renamed): /.test(line));
      assert.deepEqual(headings, [expectedHeading]);
      assert.match(stdout, emptySide === "added" ? /^-old$/m : /^\+new$/m);
      assert.equal(gitTrace, "");
    });
  }
});

describe("direct diff inputs", () => {
  for (const scenario of ["modified", "added", "deleted"] as const) {
    it(`compares original ordinary ${scenario} files without temporary storage`, async () => {
      await mkdir(join(distRoot, "conf.exact"));
      const homePath = "conf/a name.txt";
      const distPath = "conf.exact/a name.txt";
      if (scenario !== "added") await put(homeRoot, homePath, "old\n");
      if (scenario !== "deleted") await put(distRoot, distPath, "new\n");
      const blockedTemporaryRoot = await put(root, "blocked-tmp", "not a directory\n");
      const { stdout, stderr, exitCode, gitTrace } = await runGitOnlyDiff({
        TMPDIR: blockedTemporaryRoot,
      });

      assert.equal(exitCode, 0);
      assert.equal(stderr, "");
      const label = { modified: "Modified", added: "Added", deleted: "Deleted" }[scenario];
      assert.equal(stdout.includes(`${label}: ${homePath}\n`), true);
      if (scenario !== "added") {
        assert.match(stdout, /^-old$/m);
        assert.equal(await readFile(join(homeRoot, homePath), "utf8"), "old\n");
      }
      if (scenario !== "deleted") {
        assert.match(stdout, /^\+new$/m);
        assert.equal(await readFile(join(distRoot, distPath), "utf8"), "new\n");
      }
      assert.doesNotMatch(stdout, /\.exact|diff-render-/);
      assert.equal(stdout.includes(root), false);
      assert.equal(gitTrace, "");
    });
  }

  it("renders empty additions and raw line endings directly", async () => {
    await put(distRoot, "empty.txt", "");
    await put(homeRoot, "changed.txt", "old");
    await put(distRoot, "changed.txt", "new\r\n");
    await put(homeRoot, "equal.txt", "same");
    await put(distRoot, "equal.txt", "same\r\n");
    const blockedTemporaryRoot = await put(root, "blocked-tmp", "not a directory\n");
    const { stdout, stderr, exitCode, gitTrace } = await runGitOnlyDiff({
      TMPDIR: blockedTemporaryRoot,
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /^Modified: changed\.txt$/m);
    assert.equal(stdout.includes("+new\r\n"), true);
    assert.match(stdout, /No newline at end of file/);
    const heading = "Added: empty.txt";
    const fence = "─".repeat(heading.length);
    assert.equal(stdout.endsWith(`${fence}\n${heading}\n${fence}\n`), true);
    assert.doesNotMatch(stdout, /equal\.txt/);
    assert.doesNotMatch(gitTrace, /diff-render-/);
  });

  for (const scenario of ["modified", "added", "deleted"] as const) {
    it(`keeps mapped binary notices for direct ${scenario} files`, async () => {
      await mkdir(join(distRoot, "conf.exact"));
      const homePath = "conf/asset.bin";
      if (scenario !== "added") await put(homeRoot, homePath, new Uint8Array([0, 1]));
      if (scenario !== "deleted")
        await put(distRoot, "conf.exact/asset.bin", new Uint8Array([0, 2]));
      const blockedTemporaryRoot = await put(root, "blocked-tmp", "not a directory\n");
      const { stdout, stderr, exitCode } = await runGitOnlyDiff({ TMPDIR: blockedTemporaryRoot });

      assert.equal(exitCode, 0);
      assert.equal(stderr, "");
      const emptyInput = process.platform === "win32" ? "NUL" : "/dev/null";
      const oldName = scenario === "added" ? emptyInput : `a/${homePath}`;
      const newName = scenario === "deleted" ? emptyInput : `b/${homePath}`;
      assert.equal(stdout.includes(`Binary files ${oldName} and ${newName} differ\n`), true);
      assert.equal(stdout.includes(root), false);
      assert.doesNotMatch(stdout, /\.exact|diff-render-/);
    });
  }

  it("keeps Git quoting in mapped binary notices for special paths", async () => {
    const name = 'asset\t"\\$&\né日本.bin';
    const homePath = `conf/${name}`;
    await put(homeRoot, homePath, new Uint8Array([0, 1]));
    await put(distRoot, `conf.exact/${name}`, new Uint8Array([0, 2]));
    const blockedTemporaryRoot = await put(root, "blocked-tmp", "not a directory\n");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff({ TMPDIR: blockedTemporaryRoot });

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    const quotedName = 'asset\\t\\"\\\\$&\\né日本.bin';
    assert.equal(
      stdout.includes(`Binary files "a/conf/${quotedName}" and "b/conf/${quotedName}" differ\n`),
      true,
    );
    assert.equal(stdout.includes(root), false);
    assert.doesNotMatch(stdout, /\.exact|diff-render-/);
  });

  it("uses original executable files when their modes already match the virtual modes", async () => {
    await put(homeRoot, "tool", "same\n");
    await putExecutable(distRoot, "tool.executable", "same\n");
    const blockedTemporaryRoot = await put(root, "blocked-tmp", "not a directory\n");
    const { stdout, stderr, exitCode, gitTrace } = await runGitOnlyDiff({
      TMPDIR: blockedTemporaryRoot,
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /^old mode 100644$/m);
    assert.match(stdout, /^new mode 100755$/m);
    assert.equal(await readFile(join(distRoot, "tool.executable"), "utf8"), "same\n");
    assert.equal(gitTrace, "");
  });

  it("isolates virtual modes and symlink targets without copying ordinary changes", async () => {
    await put(homeRoot, "plain.txt", "old\n");
    await put(distRoot, "plain.txt", "new\n");
    await put(homeRoot, "tool", "same\n");
    await put(distRoot, "tool.executable", "same\n");
    await putSymlink(homeRoot, "link", "old-target");
    await put(distRoot, "link.symlink", "new-target\n");
    const toolPath = join(distRoot, "tool.executable");
    const initialMode = (await lstat(toolPath)).mode;
    const blockedTemporaryRoot = await put(root, "blocked-tmp", "not a directory\n");
    const { stdout, stderr, exitCode, gitTrace } = await runGitOnlyDiff({
      TMPDIR: blockedTemporaryRoot,
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /^Modified: link$/m);
    assert.match(stdout, /^Modified: plain\.txt$/m);
    assert.match(stdout, /^Modified: tool$/m);
    assert.match(stdout, /^old mode 100644$/m);
    assert.match(stdout, /^new mode 100755$/m);
    assert.match(stdout, /-old-target/);
    assert.match(stdout, /\+new-target/);
    assert.equal(await readFile(join(homeRoot, "plain.txt"), "utf8"), "old\n");
    assert.equal(await readFile(join(distRoot, "plain.txt"), "utf8"), "new\n");
    assert.equal((await lstat(toolPath)).mode, initialMode);
    assert.equal(await readFile(toolPath, "utf8"), "same\n");
    assert.equal(await readFile(join(distRoot, "link.symlink"), "utf8"), "new-target\n");
    assert.equal(await readlink(join(homeRoot, "link")), "old-target");
    assert.equal(stdout.includes(root), false);
    assert.doesNotMatch(stdout, /\.symlink|\.executable|diff-render-/);
    assert.equal(gitTrace, "");
  });

  it("keeps ordinary changes direct while pairing rename candidates in-process", async () => {
    await put(homeRoot, "plain.txt", "old\n");
    await put(distRoot, "plain.txt", "new\n");
    await put(homeRoot, "conf/old.txt", "first\nsecond\nthird\nfourth\nfifth\n");
    await put(distRoot, "conf.exact/new.txt", "first\nsecond\nCHANGED\nfourth\nfifth\n");
    const blockedTemporaryRoot = await put(root, "blocked-tmp", "not a directory\n");
    const { stdout, stderr, exitCode, gitTrace } = await runGitOnlyDiff({
      TMPDIR: blockedTemporaryRoot,
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /^Modified: plain\.txt$/m);
    assert.match(stdout, /^-old$/m);
    assert.match(stdout, /^\+new$/m);
    assert.match(stdout, /^Renamed: conf\/old\.txt → conf\/new\.txt$/m);
    assert.match(stdout, /^-third$/m);
    assert.match(stdout, /^\+CHANGED$/m);
    assert.equal(stdout.includes(root), false);
    assert.equal(gitTrace, "");
  });
});

describe("rename display", () => {
  const original = "first\nsecond\nthird\nfourth\nfifth\n";

  it("shows a rename with mapped home paths and its mode-only change", async () => {
    await put(homeRoot, "conf/old.txt", original);
    await put(distRoot, "conf.exact/new.txt.executable", original);
    const { stdout, stderr, exitCode, gitTrace } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.equal(gitTrace, "");
    assert.match(stdout, /^Renamed: conf\/old\.txt → conf\/new\.txt$/m);
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
    assert.match(stdout, /^Renamed: conf\/old\.txt → conf\/new\.txt$/m);
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
    assert.match(stdout, /^Renamed: conf\/old\.txt → conf\/new\.txt$/m);
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
    assert.match(stdout, /^Added: conf\/new\.txt$/m);
    assert.match(stdout, /^Deleted: conf\/old\.txt$/m);
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
    assert.match(stdout, /^Added: conf\/new\.txt$/m);
  });

  it("does not pair a changed entry with an addition", async () => {
    await put(homeRoot, "conf/changed.txt", original);
    await put(distRoot, "conf.exact/changed.txt", "unrelated replacement\n");
    await put(distRoot, "conf.exact/new.txt", original);
    const { stdout } = await runGitOnlyDiff();

    assert.doesNotMatch(stdout, /Renamed/);
    assert.match(stdout, /^Modified: conf\/changed\.txt$/m);
    assert.match(stdout, /^Added: conf\/new\.txt$/m);
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
    assert.match(stdout, /^Renamed: conf\/old\/nested\.txt → conf\/new\.txt$/m);
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
    assert.match(stdout, /^Renamed: conf\/old name\tfile\.txt → conf\/new name\tfile\.txt$/m);
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
      assert.match(stdout, /^Renamed: conf\/old/m);
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
    assert.match(stdout, /^Renamed: conf\/旧é\.txt → conf\/新é\.txt$/m);
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
    assert.match(stdout, /^Modified: a\.txt$/m);
    assert.match(stdout, /\+new/);
    assert.match(stdout, /-old/);
  });

  it("ignores a broken Git on PATH and renders the diff in-process", async () => {
    await put(homeRoot, "a.txt", "old\n");
    await put(distRoot, "a.txt", "new\n");
    const binDir = join(root, "failed-git");
    const fakeGit = await put(
      binDir,
      "git",
      `#!${process.execPath}\nconsole.log("git-output-before-error");\nprocess.exit(42);\n`,
    );
    await chmod(fakeGit, 0o755);
    const { stdout, stderr, exitCode, gitTrace } = await runGitOnlyDiff({ PATH: binDir });

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /^Modified: a\.txt$/m);
    assert.match(stdout, /^-old$/m);
    assert.match(stdout, /^\+new$/m);
    assert.doesNotMatch(stdout, /git-output-before-error/);
    assert.equal(gitTrace, "");
  });

  it("pairs edited renames at the 50% threshold and breaks ties by path order", async () => {
    const lines = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join("\n") + "\n";
    await put(homeRoot, "conf/at.txt", lines(10, "l"));
    await put(homeRoot, "conf/low.txt", lines(10, "l"));
    await put(distRoot, "conf.exact/half.txt", lines(5, "l") + lines(5, "n"));
    await put(distRoot, "conf.exact/weak.txt", lines(4, "l") + lines(6, "n"));
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /^Renamed: conf\/at\.txt → conf\/half\.txt$/m);
    assert.match(stdout, /^@@ -3,8 \+3,8 @@$/m);
    assert.match(stdout, /^-l6$/m);
    assert.match(stdout, /^\+n1$/m);
    assert.match(stdout, /^Added: conf\/weak\.txt$/m);
    assert.match(stdout, /^Deleted: conf\/low\.txt$/m);
    assert.doesNotMatch(stdout, /weak\.txt → /);
  });

  it("counts duplicate lines up to the smaller occurrence count on each side", async () => {
    await put(homeRoot, "conf/pairable.txt", "dup\ndup\nkeep\nkeep\n");
    await put(distRoot, "conf.exact/matched.txt", "dup\ndup\nother\n");
    await put(homeRoot, "conf/short.txt", "dup\nkeep\nkeep\nkeep\n");
    await put(distRoot, "conf.exact/extra.txt", "dup\nother\nother\nother\nother\n");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /^Renamed: conf\/pairable\.txt → conf\/matched\.txt$/m);
    assert.match(stdout, /^Added: conf\/extra\.txt$/m);
    assert.match(stdout, /^Deleted: conf\/short\.txt$/m);
  });

  it("prefers an identical copy over a similar edit when both can pair", async () => {
    const tenLines = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
    await put(homeRoot, "conf/orig.txt", tenLines);
    await put(distRoot, "conf.exact/copy.txt", tenLines);
    await put(distRoot, "conf.exact/edited.txt", tenLines.replace("six", "SIX"));
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    const renameHeading = "Renamed: conf/orig.txt → conf/copy.txt";
    const fence = "─".repeat(renameHeading.length);
    assert.equal(stdout.includes(`${fence}\n${renameHeading}\n${fence}\n`), true);
    assert.match(stdout, /^Added: conf\/edited\.txt$/m);
    assert.match(stdout, /^\+SIX$/m);
    assert.doesNotMatch(stdout, /orig\.txt → conf\/edited\.txt/);
  });

  it("pairs identical candidates one-to-one in UTF-16 path order", async () => {
    const content = "shared\ncontent\n";
    await put(homeRoot, "conf/b.txt", content);
    await put(homeRoot, "conf/a.txt", content);
    await put(distRoot, "conf.exact/y.txt", content);
    await put(distRoot, "conf.exact/x.txt", content);
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    const renames = stdout.split("\n").filter((line) => line.startsWith("Renamed: "));
    assert.deepEqual(renames, [
      "Renamed: conf/a.txt → conf/x.txt",
      "Renamed: conf/b.txt → conf/y.txt",
    ]);
    assert.equal(stdout.includes("Added"), false);
    assert.equal(stdout.includes("Deleted"), false);
  });
});

describe("diff display contract", () => {
  it("renders the SPEC Modified example byte-for-byte", async () => {
    await put(homeRoot, ".agents/config/agents.yaml", "agents:\n  model: old-model\n  enabled: true\n");
    await put(distRoot, ".agents/config/agents.yaml", "agents:\n  model: new-model\n  enabled: true\n");
    const { stdout, stderr, exitCode, gitTrace } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.equal(gitTrace, "");
    const heading = "Modified: .agents/config/agents.yaml";
    const fence = "─".repeat(heading.length);
    assert.equal(
      stdout,
      `${fence}\n${heading}\n${fence}\n` +
        "\n" +
        "@@ -1,3 +1,3 @@\n" +
        " agents:\n" +
        "-  model: old-model\n" +
        "+  model: new-model\n" +
        "   enabled: true\n",
    );
  });

  it("fences a long path untruncated with rules as wide as the heading", async () => {
    const longPath = `${"d".repeat(30)}/${"x".repeat(70)}.txt`;
    await put(homeRoot, longPath, "old\n");
    await put(distRoot, longPath, "new\n");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    const lines = stdout.split("\n");
    const heading = `Modified: ${longPath}`;
    assert.equal(lines[1], heading);
    assert.equal(lines[0], lines[2]);
    assert.equal(lines[0], "─".repeat(heading.length));
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
    const modifiedHeading = "Modified: a.txt";
    const renamedHeading = "Renamed: conf/old.txt → conf/new.txt";
    const modifiedFence = "─".repeat(modifiedHeading.length);
    const renamedFence = "─".repeat(renamedHeading.length);
    assert.equal(
      stdout,
      `${modifiedFence}\n${modifiedHeading}\n${modifiedFence}\n\n@@ -1 +1 @@\n-one\n+two\n\n\n` +
        `${renamedFence}\n${renamedHeading}\n${renamedFence}\n`,
    );
  });

  it("renders the deleted content in the Deleted section body", async () => {
    await put(distRoot, "dir.exact/keep.txt", "same\n");
    await put(homeRoot, "dir/keep.txt", "same\n");
    await put(homeRoot, "dir/legacy.txt", "mode=legacy\nenabled=true\n");
    const { stdout, stderr, exitCode, gitTrace } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.equal(gitTrace, "");
    assert.match(stdout, /^Deleted: dir\/legacy\.txt$/m);
    assert.match(stdout, /@@ -1,2 \+0,0 @@/);
    assert.match(stdout, /^-mode=legacy$/m);
    assert.match(stdout, /^-enabled=true$/m);
  });

  it("renders a non-rename mode-only change with old mode and new mode lines", async () => {
    await putExecutable(distRoot, "tool.executable", "#!/bin/sh\n");
    await put(homeRoot, "tool", "#!/bin/sh\n");
    const { stdout, stderr, exitCode, gitTrace } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.equal(gitTrace, "");
    assert.match(stdout, /^Modified: tool$/m);
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
    assert.match(stdout, /^Modified: meta\.txt$/m);
    assert.match(stdout, /^---- old$/m);
    assert.match(stdout, /^\+\+\+\+ new$/m);
    assert.match(stdout, /^ plain$/m);
    assert.doesNotMatch(stdout, /^index /m);
    assert.doesNotMatch(stdout, /^--- meta\.txt$/m);
    assert.doesNotMatch(stdout, /^\+\+\+ meta\.txt$/m);
  });

  it("renders an empty added file as a heading-only Added section", async () => {
    await put(distRoot, "empty.txt", "");
    const { stdout, stderr, exitCode, gitTrace } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.equal(gitTrace, "");
    const heading = "Added: empty.txt";
    const fence = "─".repeat(heading.length);
    assert.equal(stdout, `${fence}\n${heading}\n${fence}\n`);
  });

  it("renders a directory type mismatch as Deleted and Added sections", async () => {
    await put(homeRoot, "entry", "old-file\n");
    await put(distRoot, "entry.exact/keep.txt", "visible\n");
    await put(distRoot, "entry.exact/private.data.txt", "secret\n");
    const blockedTemporaryRoot = await put(root, "blocked-tmp", "not a directory\n");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff({ TMPDIR: blockedTemporaryRoot });

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /^Deleted: entry$/m);
    assert.match(stdout, /^-old-file$/m);
    assert.match(stdout, /^Added: entry\/keep\.txt$/m);
    assert.match(stdout, /^\+visible$/m);
    assert.doesNotMatch(stdout, /^Modified: entry$/m);
    assert.doesNotMatch(stdout, /private\.data|secret/);
  });

  it("renders a symlink type mismatch as Deleted and Added sections", async () => {
    await put(distRoot, "slink", "file-content\n");
    await putSymlink(homeRoot, "slink", "old-target");
    const blockedTemporaryRoot = await put(root, "blocked-tmp", "not a directory\n");
    const { stdout, stderr, exitCode, gitTrace } = await runGitOnlyDiff({
      TMPDIR: blockedTemporaryRoot,
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.equal(gitTrace, "");
    assert.match(stdout, /^Deleted: slink$/m);
    assert.match(stdout, /^-old-target$/m);
    assert.match(stdout, /^Added: slink$/m);
    assert.match(stdout, /^\+file-content$/m);
    assert.doesNotMatch(stdout, /^Modified: slink$/m);
  });

  it("splits hunks for changes separated by more than six context lines", async () => {
    const oldText = Array.from({ length: 12 }, (_, index) => `l${index + 1}`).join("\n") + "\n";
    const newText = oldText.replace("l2\n", "X2\n").replace("l11\n", "Y11\n");
    await put(homeRoot, "h.txt", oldText);
    await put(distRoot, "h.txt", newText);
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    const heading = "Modified: h.txt";
    const fence = "─".repeat(heading.length);
    assert.equal(
      stdout,
      `${fence}\n${heading}\n${fence}\n\n` +
        "@@ -1,5 +1,5 @@\n l1\n-l2\n+X2\n l3\n l4\n l5\n" +
        "@@ -8,5 +8,5 @@\n l8\n l9\n l10\n-l11\n+Y11\n l12\n",
    );
  });

  it("merges hunks whose contexts touch and restores both inputs from the body", async () => {
    const oldText = Array.from({ length: 11 }, (_, index) => `l${index + 1}`).join("\n") + "\n";
    const newText = oldText.replace("l2\n", "X2\n").replace("l9\n", "Y9\n");
    await put(homeRoot, "h.txt", oldText);
    await put(distRoot, "h.txt", newText);
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    const heading = "Modified: h.txt";
    const fence = "─".repeat(heading.length);
    const body =
      "@@ -1,11 +1,11 @@\n l1\n-l2\n+X2\n l3\n l4\n l5\n l6\n l7\n l8\n-l9\n+Y9\n l10\n l11\n";
    assert.equal(stdout, `${fence}\n${heading}\n${fence}\n\n${body}`);

    let restoredOld = "";
    let restoredNew = "";
    for (const line of body.split("\n").slice(1)) {
      if (line.startsWith("-") || line.startsWith(" ")) restoredOld += `${line.slice(1)}\n`;
      if (line.startsWith("+") || line.startsWith(" ")) restoredNew += `${line.slice(1)}\n`;
    }
    assert.equal(restoredOld, oldText);
    assert.equal(restoredNew, newText);
  });

  it("keeps first and last line changes with their newline markers", async () => {
    await put(homeRoot, "h.txt", "a\nb\nc\n");
    await put(distRoot, "h.txt", "A\nb\nC");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    const heading = "Modified: h.txt";
    const fence = "─".repeat(heading.length);
    assert.equal(
      stdout,
      `${fence}\n${heading}\n${fence}\n\n` +
        "@@ -1,3 +1,3 @@\n-a\n+A\n b\n-c\n+C\n\\ No newline at end of file\n",
    );
  });

  it("keeps empty and repeated lines inside hunks", async () => {
    await put(homeRoot, "h.txt", "\nx\n\nx\n");
    await put(distRoot, "h.txt", "\nx\ny\n");
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    const heading = "Modified: h.txt";
    const fence = "─".repeat(heading.length);
    assert.equal(
      stdout,
      `${fence}\n${heading}\n${fence}\n\n` + "@@ -1,4 +1,3 @@\n \n x\n-\n-x\n+y\n",
    );
  });

  for (const reverse of [false, true]) {
    it(`preserves distinct invalid bytes with identical replacement text (reverse: ${reverse})`, async () => {
      const oldBytes = new Uint8Array([reverse ? 0x81 : 0x80]);
      const newBytes = new Uint8Array([reverse ? 0x80 : 0x81]);
      await put(homeRoot, "raw.txt", oldBytes);
      await put(distRoot, "raw.txt", newBytes);
      const { stdout, stderr, exitCode, gitTrace } = await runGitOnlyDiff();

      assert.equal(exitCode, 0);
      assert.equal(stderr, "");
      assert.equal(gitTrace, "");
      const heading = "Modified: raw.txt";
      const fence = "─".repeat(heading.length);
      assert.equal(
        stdout,
        `${fence}\n${heading}\n${fence}\n\n@@ -1 +1 @@\n` +
          "-�\n\\ No newline at end of file\n+�\n\\ No newline at end of file\n",
      );
      assert.deepEqual(await readFile(join(homeRoot, "raw.txt")), Buffer.from(oldBytes));
      assert.deepEqual(await readFile(join(distRoot, "raw.txt")), Buffer.from(newBytes));
    });

    it(`preserves final LF differences on otherwise equal lines (reverse: ${reverse})`, async () => {
      const oldText = reverse ? "old\nsame" : "old\nsame\n";
      const newText = reverse ? "new\nsame\n" : "new\nsame";
      await put(homeRoot, "raw.txt", oldText);
      await put(distRoot, "raw.txt", newText);
      const { stdout, stderr, exitCode } = await runGitOnlyDiff();

      assert.equal(exitCode, 0);
      assert.equal(stderr, "");
      assert.match(stdout, /^@@ -1,2 \+1,2 @@$/m);
      assert.match(stdout, /^-same$/m);
      assert.match(stdout, /^\+same$/m);
      assert.doesNotMatch(stdout, /^ same$/m);
      assert.equal((stdout.match(/No newline at end of file/g) ?? []).length, 1);
      const lineWithoutLf = reverse ? "-same" : "+same";
      assert.equal(stdout.includes(`${lineWithoutLf}\n\\ No newline at end of file\n`), true);
    });

    it(`preserves BOM in changed input lines (reverse: ${reverse})`, async () => {
      await put(homeRoot, "raw.txt", `${reverse ? "" : "\uFEFF"}old\nsame\n`);
      await put(distRoot, "raw.txt", `${reverse ? "\uFEFF" : ""}new\nsame\n`);
      const { stdout, stderr, exitCode } = await runGitOnlyDiff();

      assert.equal(exitCode, 0);
      assert.equal(stderr, "");
      const heading = "Modified: raw.txt";
      const fence = "─".repeat(heading.length);
      assert.equal(
        stdout,
        `${fence}\n${heading}\n${fence}\n\n@@ -1,2 +1,2 @@\n` +
          `-${reverse ? "" : "\uFEFF"}old\n+${reverse ? "\uFEFF" : ""}new\n same\n`,
      );
    });
  }

  it("preserves invalid-byte changes without replacing their unchanged context", async () => {
    await put(homeRoot, "raw.txt", new Uint8Array([0x80, 0x0a, 0x78, 0x0a]));
    await put(distRoot, "raw.txt", new Uint8Array([0x81, 0x0a, 0x78, 0x0a]));
    const { stdout, stderr, exitCode } = await runGitOnlyDiff();

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.equal(stdout.endsWith("@@ -1,2 +1,2 @@\n-�\n+�\n x\n"), true);
    assert.doesNotMatch(stdout, /Binary files|No newline at end of file/);
  });

  it("renders every classification without Git on PATH or a writable TMPDIR", async () => {
    await put(homeRoot, "plain.txt", "old\n");
    await put(distRoot, "plain.txt", "new\n");
    await put(homeRoot, "tool", "#!/bin/sh\n");
    await put(distRoot, "tool.executable", "#!/bin/sh\n");
    await put(homeRoot, "conf/old.txt", "first\nsecond\nthird\nfourth\nfifth\n");
    await put(distRoot, "conf.exact/new.txt", "first\nsecond\nCHANGED\nfourth\nfifth\n");
    await put(distRoot, "new.bin", new Uint8Array([0, 1]));
    await putSymlink(homeRoot, "conf/gone-link", "old-target");
    const blockedTemporaryRoot = await put(root, "blocked-tmp", "not a directory\n");
    const emptyBin = join(root, "empty-bin");
    await mkdir(emptyBin);
    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dir, "diff.ts"), distRoot, homeRoot],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PATH: emptyBin, TMPDIR: blockedTemporaryRoot },
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    const headings = stdout
      .split("\n")
      .filter((line) => /^(Modified|Renamed|Added|Deleted): /.test(line));
    assert.deepEqual(headings.slice(0, 2).sort(), ["Modified: plain.txt", "Modified: tool"]);
    assert.deepEqual(headings.slice(2), [
      "Renamed: conf/old.txt → conf/new.txt",
      "Added: new.bin",
      "Deleted: conf/gone-link",
    ]);
    assert.match(stdout, /Binary files \/dev\/null and b\/new\.bin differ/);
    assert.match(stdout, /^-old-target$/m);
    assert.equal(stdout.includes(root), false);
  });
});
