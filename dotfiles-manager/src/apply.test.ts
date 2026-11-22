import { describe, it, beforeEach, afterEach, spyOn } from "bun:test";
import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Stream } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { collectDifferences, type DiffResult } from "./diff.ts";
import {
  applyDifferences,
  collectDeclarations,
  confirmApplyStdin,
  confirmsApply,
  main,
  parseArgs,
  runApplyScripts,
  type ApplyResult,
} from "./apply.ts";

let root: string;
let distRoot: string;
let homeRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "apply-test-"));
  distRoot = join(root, "dist");
  homeRoot = join(root, "home");
  await mkdir(distRoot);
  await mkdir(homeRoot);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(rootDir: string, path: string, content: string): Promise<string> {
  const absolute = join(rootDir, path);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content);
  return absolute;
}

async function putSymlinkFile(rootDir: string, path: string, target: string): Promise<void> {
  await put(rootDir, path, `${target}\n`);
}

async function putHomeSymlink(rootDir: string, path: string, target: string): Promise<void> {
  const absolute = join(rootDir, path);
  await mkdir(join(absolute, ".."), { recursive: true });
  await symlink(target, absolute);
}

async function diffAndApply(platform = process.platform): Promise<ApplyResult> {
  const result = await collectDifferences(distRoot, homeRoot, platform);
  return applyDifferences(distRoot, homeRoot, result, platform);
}

async function putApplyScript(
  rootDir: string,
  path: string,
  body = `import { writeFile } from "node:fs/promises";\nawait writeFile("apply-out.txt", process.cwd());`,
): Promise<void> {
  await put(rootDir, path, `${body}\n`);
}

const emptyResult: DiffResult = {
  unchanged: [],
  changed: [],
  typeMismatches: [],
  added: [],
  removedExact: [],
  removedIgnored: [],
};

describe("apply classification matrix", () => {
  it("adds a file and creates missing parent directories", async () => {
    await put(distRoot, "nested/dir/a.txt", "content\n");

    await diffAndApply();

    assert.equal(await readFile(join(homeRoot, "nested/dir/a.txt"), "utf8"), "content\n");
  });

  it("adds each listed directory child once and reports each entry once", async () => {
    await put(distRoot, "pkg/nested/file.txt", "x\n");
    const result = await collectDifferences(distRoot, homeRoot, "linux");
    const renamedPaths: string[] = [];

    const applied = await applyDifferences(
      distRoot,
      homeRoot,
      result,
      "linux",
      async (from, to) => {
        renamedPaths.push(to);
        await rename(from, to);
      },
    );

    assert.deepEqual(applied.added, ["pkg", "pkg/nested", "pkg/nested/file.txt"]);
    assert.deepEqual(renamedPaths, [join(homeRoot, "pkg/nested/file.txt")]);
    assert.equal(await readFile(join(homeRoot, "pkg/nested/file.txt"), "utf8"), "x\n");
  });
  it("applies a retired machine sidecar as an ordinary file", async () => {
    await put(distRoot, "settings.machine.json", '{"mode":"old"}\n');

    await diffAndApply();

    assert.equal(
      await readFile(join(homeRoot, "settings.machine.json"), "utf8"),
      '{"mode":"old"}\n',
    );
  });

  it("adds a symlink whose target is the file content without the trailing newline", async () => {
    await putSymlinkFile(distRoot, "link.symlink", "data/actual.txt");

    await diffAndApply();

    assert.equal(await readlink(join(homeRoot, "link")), "data/actual.txt");
  });

  it("adds owner execute bit for an .executable file", async () => {
    await put(distRoot, "tool.executable", "#!/bin/sh\n");

    await diffAndApply();

    const statHome = await stat(join(homeRoot, "tool"));
    assert.ok((statHome.mode & 0o100) !== 0, "owner execute bit should be set");
  });

  it("removes the owner execute bit when the dist file is not executable", async () => {
    await put(distRoot, "plain.txt", "x\n");
    const homeAbs = await put(homeRoot, "plain.txt", "x\n");
    await chmod(homeAbs, 0o755);

    await diffAndApply();

    const statHome = await stat(homeAbs);
    assert.equal(statHome.mode & 0o100, 0, "owner execute bit should be cleared");
  });

  it("keeps the old home contents until a complete adjacent file is renamed into place", async () => {
    await put(distRoot, "a.txt", "new\n");
    const homeAbs = await put(homeRoot, "a.txt", "old\n");
    const result = await collectDifferences(distRoot, homeRoot, "linux");
    let renames = 0;

    await applyDifferences(distRoot, homeRoot, result, "linux", async (from, to) => {
      renames++;
      assert.equal(to, homeAbs);
      assert.equal(dirname(from), dirname(homeAbs));
      assert.equal(await readFile(homeAbs, "utf8"), "old\n");
      assert.equal(await readFile(from, "utf8"), "new\n");
      await rename(from, to);
    });

    assert.equal(renames, 1);
    assert.equal(await readFile(homeAbs, "utf8"), "new\n");
    assert.equal((await readdir(homeRoot)).filter((name) => name.includes("apply-tmp")).length, 0);
  });

  it("recreates a symlink whose target changed", async () => {
    await putSymlinkFile(distRoot, "link.symlink", "target/new.txt");
    await putHomeSymlink(homeRoot, "link", "target/old.txt");

    await diffAndApply();

    assert.equal(await readlink(join(homeRoot, "link")), "target/new.txt");
  });

  it("resolves a file-to-directory type mismatch by removing then re-adding", async () => {
    await put(distRoot, "entry/inner.txt", "x\n");
    await put(homeRoot, "entry", "i was a file\n");

    await diffAndApply();

    const statHome = await stat(join(homeRoot, "entry"));
    assert.ok(statHome.isDirectory());
    assert.equal(await readFile(join(homeRoot, "entry/inner.txt"), "utf8"), "x\n");
  });

  it("resolves a directory-to-file type mismatch by removing the subtree", async () => {
    await put(distRoot, "entry", "i am a file\n");
    await put(homeRoot, "entry/nested/deep.txt", "old\n");

    await diffAndApply();

    const statHome = await stat(join(homeRoot, "entry"));
    assert.ok(statHome.isFile());
    assert.equal(existsSync(join(homeRoot, "entry/nested")), false);
  });

  it("resolves a symlink-to-file type mismatch", async () => {
    await put(distRoot, "entry", "i am a file\n");
    await putHomeSymlink(homeRoot, "entry", "somewhere");

    await diffAndApply();

    const statHome = await stat(join(homeRoot, "entry"));
    assert.ok(statHome.isFile());
  });

  it("removes a surplus subtree under .exact scope", async () => {
    await put(distRoot, "dir.exact/keep.txt", "x\n");
    await put(homeRoot, "dir/keep.txt", "x\n");
    await put(homeRoot, "dir/stale/nested.txt", "old\n");

    await diffAndApply();

    assert.equal(existsSync(join(homeRoot, "dir/stale")), false);
    assert.equal(existsSync(join(homeRoot, "dir/keep.txt")), true);
  });

  it("keeps surplus outside exact scope", async () => {
    await put(distRoot, "dir/keep.txt", "x\n");
    await put(homeRoot, "dir/keep.txt", "x\n");
    await put(homeRoot, "dir/untracked.txt", "old\n");

    await diffAndApply();

    assert.equal(existsSync(join(homeRoot, "dir/untracked.txt")), true);
  });

  it.each([
    ["linux", ".local/share/fcitx5/rime"] as const,
    ["win32", "AppData/Roaming/Rime"] as const,
  ])("preserves existing Rime userdb fixtures on %s", async (platform, rimePath) => {
    await put(distRoot, `${rimePath}/default.custom.yaml`, "new settings\n");
    await put(homeRoot, `${rimePath}/default.custom.yaml`, "old settings\n");
    const userdbPath = join(homeRoot, rimePath, "userdb", "test.userdb");
    await mkdir(userdbPath, { recursive: true });
    const fixtures = new Map([
      ["CURRENT", Buffer.from([0x00, 0xff, 0x10, 0x80])],
      ["MANIFEST-000001", Buffer.from([0x4c, 0x53, 0x4d, 0x00, 0xfe])],
    ]);
    for (const [name, content] of fixtures) {
      await writeFile(join(userdbPath, name), content);
    }

    await diffAndApply(platform);

    assert.equal(
      await readFile(join(homeRoot, rimePath, "default.custom.yaml"), "utf8"),
      "new settings\n",
    );
    assert.equal((await stat(userdbPath)).isDirectory(), true);
    assert.deepEqual((await readdir(userdbPath)).sort(), [...fixtures.keys()].sort());
    for (const [name, content] of fixtures) {
      assert.deepEqual(await readFile(join(userdbPath, name)), content);
    }
  });

  it("recursively applies children omitted beneath a type-mismatch directory", async () => {
    await put(distRoot, "entry/inner.txt", "x\n");
    await put(homeRoot, "entry", "i was a file\n");

    const result = await collectDifferences(distRoot, homeRoot, "linux");
    const renamedPaths: string[] = [];
    const applied = await applyDifferences(
      distRoot,
      homeRoot,
      result,
      "linux",
      async (from, to) => {
        renamedPaths.push(to);
        await rename(from, to);
      },
    );

    assert.deepEqual(
      result.typeMismatches.map((entry) => entry.homePath),
      ["entry"],
    );
    assert.deepEqual(result.added, []);
    assert.deepEqual(applied.removed, ["entry"]);
    assert.deepEqual(applied.added, ["entry", "entry/inner.txt"]);
    assert.deepEqual(renamedPaths, [join(homeRoot, "entry/inner.txt")]);
    assert.equal(await readFile(join(homeRoot, "entry/inner.txt"), "utf8"), "x\n");
  });

  it("stops on error and keeps already applied entries", async () => {
    await put(distRoot, "a.txt", "a\n");
    await put(distRoot, "c.txt", "c\n");
    const broken: DiffResult = {
      ...emptyResult,
      added: [
        { homePath: "a.txt", distPath: "a.txt" },
        { homePath: "b.txt", distPath: "missing-in-dist.txt" },
        { homePath: "c.txt", distPath: "c.txt" },
      ],
    };

    await assert.rejects(
      applyDifferences(distRoot, homeRoot, broken, "linux"),
      /apply failed: b\.txt/,
    );

    assert.equal(await readFile(join(homeRoot, "a.txt"), "utf8"), "a\n", "earlier entry applied");
    assert.equal(existsSync(join(homeRoot, "c.txt")), false, "later entry not applied");
  });

  it("treats legacy-prefix names as plain entries during apply", async () => {
    await put(distRoot, "dot_config/tool", "new\n");
    await put(homeRoot, "dot_config/tool", "old\n");

    await diffAndApply();

    assert.equal(await readFile(join(homeRoot, "dot_config/tool"), "utf8"), "new\n");
    assert.equal(existsSync(join(homeRoot, ".config")), false);
  });

  it("preserves the existing file mode on windows when content changes", async () => {
    const distAbs = await put(distRoot, "tool.executable", "new\n");
    const homeAbs = await put(homeRoot, "tool", "old\n");
    await chmod(distAbs, 0o755);
    await chmod(homeAbs, 0o600);
    const beforeMode = (await stat(homeAbs)).mode & 0o777;

    await diffAndApply("win32");

    assert.equal(await readFile(homeAbs, "utf8"), "new\n");
    assert.equal((await stat(homeAbs)).mode & 0o777, beforeMode);
  });

  it("applies a node_modules subtree produced in dist", async () => {
    await put(distRoot, "generated/node_modules/pkg/index.js", "new\n");

    await diffAndApply();

    assert.equal(
      await readFile(join(homeRoot, "generated/node_modules/pkg/index.js"), "utf8"),
      "new\n",
    );
  });

  it("applies changes inside an existing node_modules directory", async () => {
    await put(distRoot, "node_modules/pkg/index.js", "new\n");
    await put(homeRoot, "node_modules/pkg/index.js", "old\n");

    await diffAndApply();

    assert.equal(await readFile(join(homeRoot, "node_modules/pkg/index.js"), "utf8"), "new\n");
  });
});

describe("apply scripts", () => {
  it("collects scripts in node_modules but skips excluded folders", async () => {
    await putApplyScript(distRoot, "node_modules/pkg/x.apply.ts");
    await put(distRoot, ".build.d/hidden/x.apply.sh", "script\n");
    await putApplyScript(distRoot, "ok/y.apply.ts");

    const declarations = await collectDeclarations(distRoot);

    assert.deepEqual(
      declarations.applyScripts.map((script) => script.distPath),
      ["node_modules/pkg/x.apply.ts", "ok/y.apply.ts"],
    );
  });

  it("runs an apply script produced inside node_modules", async () => {
    await putApplyScript(distRoot, "node_modules/pkg/setup.apply.ts");

    const exitCode = await main([distRoot, homeRoot, "--yes"]);

    assert.equal(exitCode, 0);
    assert.equal(
      await readFile(join(homeRoot, "node_modules/pkg/apply-out.txt"), "utf8"),
      join(homeRoot, "node_modules/pkg"),
    );
    assert.equal(existsSync(join(homeRoot, "node_modules/pkg/setup.apply.ts")), false);
  });

  it("runs machine-specific scripts and removes the home copy afterward", async () => {
    await put(distRoot, "tools/keep.txt", "same\n");
    await put(homeRoot, "tools/keep.txt", "same\n");
    await putApplyScript(distRoot, "tools/setup.machine-apply.ts");
    const declarations = await collectDeclarations(distRoot);
    const result = await diffAndApply();

    await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.deepEqual(
      declarations.applyScripts.map((script) => script.distPath),
      ["tools/setup.machine-apply.ts"],
    );
    assert.deepEqual(result.added, []);
    assert.equal(existsSync(join(homeRoot, "tools/setup.machine-apply.ts")), false);
    assert.equal(
      await readFile(join(homeRoot, "tools/apply-out.txt"), "utf8"),
      join(homeRoot, "tools"),
    );
  });
  it("runs the same-name copy in the mapped home folder with home-relative imports", async () => {
    const body = `import { writeFile } from "node:fs/promises";
import { direction } from "./helper.ts";
await writeFile("apply-out.txt", JSON.stringify([process.cwd(), import.meta.dir, import.meta.path, direction]));`;
    await putApplyScript(distRoot, "tools.exact/setup.apply.ts", body);
    await put(distRoot, "tools.exact/helper.ts", 'export const direction = "dist";');
    await put(homeRoot, "tools/helper.ts", 'export const direction = "home";');
    const declarations = await collectDeclarations(distRoot);
    const cwd = join(homeRoot, "tools");
    const copyPath = join(cwd, "setup.apply.ts");

    const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.deepEqual(failures, []);
    const output = JSON.parse(await readFile(join(cwd, "apply-out.txt"), "utf8"));
    assert.deepEqual(output, [cwd, cwd, copyPath, "home"]);
    assert.equal(existsSync(copyPath), false);
    assert.equal(await readFile(join(distRoot, "tools.exact/setup.apply.ts"), "utf8"), `${body}\n`);
  });

  it("runs a TypeScript hook regardless of its shebang", async () => {
    await putApplyScript(
      distRoot,
      "tools/setup.apply.ts",
      `#!/nonexistent/interpreter\nimport { writeFile } from "node:fs/promises";\nawait writeFile("apply-out.txt", process.cwd());`,
    );
    const declarations = await collectDeclarations(distRoot);

    const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.deepEqual(failures, []);
    assert.equal(
      await readFile(join(homeRoot, "tools/apply-out.txt"), "utf8"),
      join(homeRoot, "tools"),
    );
  });

  it("runs every script exactly once regardless of completion order", async () => {
    const orderFile = join(root, "apply-order.txt");
    const appendOrder = (value: string) =>
      `import { appendFile } from "node:fs/promises";\nawait appendFile(${JSON.stringify(orderFile)}, ${JSON.stringify(`${value}\n`)});`;
    await putApplyScript(distRoot, "pkg/second.apply.ts", appendOrder("b"));
    await putApplyScript(distRoot, "pkg/first.apply.ts", appendOrder("a"));
    await putApplyScript(distRoot, "aaa/early.apply.ts", appendOrder("c"));
    await putApplyScript(distRoot, "pkg-/before.apply.ts", appendOrder("before"));
    const declarations = await collectDeclarations(distRoot);

    await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    // Normal hooks run concurrently, so only the set of runs is guaranteed.
    assert.deepEqual((await readFile(orderFile, "utf8")).trim().split("\n").sort(), [
      "a",
      "b",
      "before",
      "c",
    ]);
  });

  it("copies current dist contents only for declarations found at collection", async () => {
    await putApplyScript(distRoot, "setup.apply.ts", "process.exit(99);");
    const declarations = await collectDeclarations(distRoot);
    await putApplyScript(distRoot, "setup.apply.ts");
    await putApplyScript(distRoot, "added.apply.ts", "process.exit(98);");

    const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.deepEqual(failures, []);
    assert.equal(await readFile(join(homeRoot, "apply-out.txt"), "utf8"), homeRoot);
    assert.equal(existsSync(join(homeRoot, "added.apply.ts")), false);
  });

  it("reports a missing source without replacing its home entry or stopping other hooks", async () => {
    await putApplyScript(distRoot, "missing.apply.ts");
    await putApplyScript(distRoot, "remaining.apply.ts");
    const declarations = await collectDeclarations(distRoot);
    await rm(join(distRoot, "missing.apply.ts"));
    const copyPath = await put(homeRoot, "missing.apply.ts", "keep this file");

    const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.equal(failures.length, 1);
    assert.match(failures[0]!, /^apply script failed: missing\.apply\.ts:.*ENOENT/);
    assert.equal(await readFile(copyPath, "utf8"), "keep this file");
    assert.equal(await readFile(join(homeRoot, "apply-out.txt"), "utf8"), homeRoot);
  });

  it("preserves the original and cleans staging when a copy fails after a partial write", async () => {
    await putApplyScript(distRoot, "setup.apply.ts");
    const copyPath = await put(homeRoot, "setup.apply.ts", "keep this file");
    const declarations = await collectDeclarations(distRoot);
    const copyFile = spyOn(fs, "copyFile").mockImplementationOnce(async (_source, destination) => {
      await writeFile(destination, "partial copy");
      throw new Error("EFBIG: file too large");
    });

    try {
      const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

      assert.deepEqual(failures, ["apply script failed: setup.apply.ts: EFBIG: file too large"]);
      assert.equal(await readFile(copyPath, "utf8"), "keep this file");
      assert.deepEqual(await readdir(homeRoot), ["setup.apply.ts"]);
    } finally {
      copyFile.mockRestore();
    }
  });

  it("starts timing before target preflight and logs its failure", async () => {
    await putApplyScript(distRoot, "setup.apply.ts");
    const declarations = await collectDeclarations(distRoot);
    let clockMs = 0;
    const now = spyOn(performance, "now").mockImplementation(() => clockMs);
    const write = spyOn(process.stdout, "write");
    const realpath = spyOn(fs, "realpath").mockImplementationOnce(async () => {
      assert.equal(write.mock.calls[0]?.[0], "  [setup.apply.ts] Started\n");
      clockMs = 1_000;
      throw new Error("preflight denied");
    });

    try {
      const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

      assert.deepEqual(failures, ["apply script failed: setup.apply.ts: preflight denied"]);
      assert.deepEqual(
        write.mock.calls.map(([chunk]) => chunk),
        ["  [setup.apply.ts] Started\n", "  [setup.apply.ts] ✗ Failed (1.00s)\n"],
      );
    } finally {
      write.mockRestore();
      realpath.mockRestore();
      now.mockRestore();
    }
  });

  it("runs and removes a placed copy even if staging cleanup fails", async () => {
    await putApplyScript(distRoot, "setup.apply.ts");
    const { applyScripts } = await collectDeclarations(distRoot);
    const remove = spyOn(fs, "rm").mockRejectedValueOnce(new Error("staging cleanup denied"));

    try {
      const failures = await runApplyScripts(applyScripts, distRoot, homeRoot);

      assert.deepEqual(failures, [
        "apply script failed: setup.apply.ts: copy staging cleanup failed: staging cleanup denied",
      ]);
      assert.equal(await readFile(join(homeRoot, "apply-out.txt"), "utf8"), homeRoot);
      assert.equal(existsSync(join(homeRoot, "setup.apply.ts")), false);
    } finally {
      remove.mockRestore();
    }
  });

  it("pre-copies post hooks and does not restore one removed before execution", async () => {
    await putApplyScript(
      distRoot,
      "remove.apply.ts",
      `import { unlink } from "node:fs/promises";
await unlink("a.postapply.ts");`,
    );
    await putApplyScript(
      distRoot,
      "a.postapply.ts",
      `import { writeFile } from "node:fs/promises";
await writeFile("restored.txt", "unexpected");`,
    );
    await putApplyScript(distRoot, "z.postapply.ts");
    const declarations = await collectDeclarations(distRoot);

    const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.deepEqual(failures, ["apply script failed: a.postapply.ts (exit code 1)"]);
    assert.equal(existsSync(join(homeRoot, "restored.txt")), false);
    assert.equal(existsSync(join(homeRoot, "a.postapply.ts")), false);
    assert.equal(existsSync(join(distRoot, "a.postapply.ts")), true);
    assert.equal(await readFile(join(homeRoot, "apply-out.txt"), "utf8"), homeRoot);
  });

  it("runs post hooks after normal hooks, children first and in filename order", async () => {
    const orderFile = join(root, "order.txt");
    const hooks = [
      ["a.postapply.ts", "root-a"],
      ["z.postapply.ts", "root-z"],
      ["pkg/b.postapply.ts", "pkg-b"],
      ["pkg/a.postapply.ts", "pkg-a"],
      ["pkg/run.apply.ts", "normal"],
    ] as const;
    for (const [path, marker] of hooks) {
      await putApplyScript(
        distRoot,
        path,
        `import { appendFile } from "node:fs/promises";
await appendFile(${JSON.stringify(orderFile)}, ${JSON.stringify(`${marker}\n`)});`,
      );
    }
    const declarations = await collectDeclarations(distRoot);

    const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.deepEqual(failures, []);
    assert.deepEqual((await readFile(orderFile, "utf8")).trim().split("\n"), [
      "normal",
      "pkg-a",
      "pkg-b",
      "root-a",
      "root-z",
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "cleans neither a moved copy nor a file behind a redirected cwd",
    async () => {
      const movedDirectory = join(homeRoot, "moved");
      const distDirectory = join(distRoot, "self");
      await putApplyScript(
        distRoot,
        "self/move.apply.ts",
        `import { rename, symlink } from "node:fs/promises";
await rename(import.meta.dir, ${JSON.stringify(movedDirectory)});
await symlink(${JSON.stringify(distDirectory)}, import.meta.dir, "dir");`,
      );
      const declarations = await collectDeclarations(distRoot);

      const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

      assert.deepEqual(failures, []);
      assert.deepEqual(await readdir(movedDirectory), ["move.apply.ts"]);
      assert.deepEqual(await readdir(distDirectory), ["move.apply.ts"]);
    },
  );

  it("replaces a same-name home file and does not restore it", async () => {
    await putApplyScript(distRoot, "setup.apply.ts");
    const copyPath = await put(homeRoot, "setup.apply.ts", "old contents");

    const exitCode = await main([distRoot, homeRoot, "--yes"]);

    assert.equal(exitCode, 0);
    assert.equal(await readFile(join(homeRoot, "apply-out.txt"), "utf8"), homeRoot);
    assert.equal(existsSync(copyPath), false);
  });

  it.skipIf(process.platform === "win32")(
    "replaces a same-name symlink without changing its target",
    async () => {
      await putApplyScript(distRoot, "setup.apply.ts");
      const target = await put(root, "linked.txt", "keep this file");
      await putHomeSymlink(homeRoot, "setup.apply.ts", target);
      const declarations = await collectDeclarations(distRoot);

      const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

      assert.deepEqual(failures, []);
      assert.equal(await readFile(target, "utf8"), "keep this file");
      assert.equal(await readFile(join(homeRoot, "apply-out.txt"), "utf8"), homeRoot);
      await assert.rejects(readlink(join(homeRoot, "setup.apply.ts")), { code: "ENOENT" });
    },
  );

  it("replaces a same-name hardlink without changing its target", async () => {
    await putApplyScript(distRoot, "setup.apply.ts");
    const target = await put(root, "linked.txt", "keep this file");
    await link(target, join(homeRoot, "setup.apply.ts"));
    const declarations = await collectDeclarations(distRoot);

    const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.deepEqual(failures, []);
    assert.equal(await readFile(target, "utf8"), "keep this file");
    assert.equal(existsSync(join(homeRoot, "setup.apply.ts")), false);
  });

  it("fails before replacing a same-name home directory", async () => {
    await putApplyScript(distRoot, "setup.apply.ts");
    const nestedFile = await put(homeRoot, "setup.apply.ts/keep.txt", "keep this file");
    const declarations = await collectDeclarations(distRoot);

    const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.equal(failures.length, 1);
    assert.match(failures[0]!, /^apply script failed: setup\.apply\.ts:.*non-file entry/);
    assert.equal(await readFile(nestedFile, "utf8"), "keep this file");
    assert.equal(existsSync(join(homeRoot, "apply-out.txt")), false);
  });

  it("does not remove a directory created in place of the home copy", async () => {
    await putApplyScript(
      distRoot,
      "setup.apply.ts",
      `import { mkdir, unlink, writeFile } from "node:fs/promises";
await unlink(import.meta.path);
await mkdir(import.meta.path);
await writeFile("setup.apply.ts/keep.txt", "keep this file");`,
    );
    const declarations = await collectDeclarations(distRoot);

    const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.equal(failures.length, 1);
    assert.match(failures[0]!, /^apply script failed: setup\.apply\.ts: copy cleanup failed:/);
    assert.equal(
      await readFile(join(homeRoot, "setup.apply.ts/keep.txt"), "utf8"),
      "keep this file",
    );
  });

  it("rejects all declarations mapped to the same home path before writing to it", async () => {
    await putApplyScript(distRoot, "tools/setup.apply.ts");
    await putApplyScript(distRoot, "tools.exact/setup.apply.ts");
    const copyPath = await put(homeRoot, "tools/setup.apply.ts", "keep this file");
    const declarations = await collectDeclarations(distRoot);

    const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.deepEqual(failures, [
      "apply script failed: tools.exact/setup.apply.ts: conflicting home copy path",
      "apply script failed: tools/setup.apply.ts: conflicting home copy path",
    ]);
    assert.equal(await readFile(copyPath, "utf8"), "keep this file");
    assert.equal(existsSync(join(homeRoot, "tools/apply-out.txt")), false);
  });

  it.each(["win32", "darwin"])("rejects case-only home path collisions on %s", async (platform) => {
    await putApplyScript(distRoot, "tools/Setup.apply.ts");
    await putApplyScript(distRoot, "TOOLS.exact/setup.apply.ts");
    const declarations = await collectDeclarations(distRoot);
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });

    try {
      const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

      assert.equal(failures.length, 2);
      assert.ok(failures.every((failure) => failure.includes("conflicting home copy path")));
      assert.deepEqual(await readdir(homeRoot), []);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects an external parent alias without changing the outside file or creating directories",
    async () => {
      await putApplyScript(distRoot, "redirected/setup.apply.ts");
      await putApplyScript(distRoot, "redirected/missing/other.apply.ts");
      const outside = join(root, "home-outside");
      const outsideFile = await put(outside, "setup.apply.ts", "keep this file");
      await symlink(outside, join(homeRoot, "redirected"), "dir");
      const declarations = await collectDeclarations(distRoot);

      const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

      assert.deepEqual(failures, [
        "apply script failed: redirected/missing/other.apply.ts: home copy path is outside the home root",
        "apply script failed: redirected/setup.apply.ts: home copy path is outside the home root",
      ]);
      assert.equal(await readFile(outsideFile, "utf8"), "keep this file");
      assert.deepEqual(await readdir(outside), ["setup.apply.ts"]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "accepts an alias for the requested home root and a parent alias within it",
    async () => {
      const homeAlias = join(root, "home-alias");
      await symlink(homeRoot, homeAlias, "dir");
      await mkdir(join(homeRoot, "tools"));
      await symlink("tools", join(homeRoot, "alias"), "dir");
      await putApplyScript(distRoot, "alias/new/setup.apply.ts");
      const declarations = await collectDeclarations(distRoot);

      const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeAlias);

      assert.deepEqual(failures, []);
      assert.deepEqual(await readdir(join(homeRoot, "tools/new")), ["apply-out.txt"]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not replace the source when home aliases dist",
    async () => {
      const body = "process.exit(99);";
      await putApplyScript(distRoot, "tools/setup.apply.ts", body);
      await symlink(distRoot, join(root, "alias"), "dir");
      const declarations = await collectDeclarations(distRoot);

      const failures = await runApplyScripts(
        declarations.applyScripts,
        distRoot,
        join(root, "alias"),
      );

      assert.deepEqual(failures, [
        "apply script failed: tools/setup.apply.ts: home copy path overlaps a dist declaration",
      ]);
      assert.equal(await readFile(join(distRoot, "tools/setup.apply.ts"), "utf8"), `${body}\n`);
    },
  );

  it("does not replace another declaration when home overlaps dist", async () => {
    const firstPath = "nested/setup.apply.ts";
    const secondPath = "nested/nested/setup.apply.ts";
    const body = "process.exit(99);";
    await putApplyScript(distRoot, firstPath);
    await putApplyScript(distRoot, secondPath, body);
    const declarations = await collectDeclarations(distRoot);

    const failures = await runApplyScripts(
      declarations.applyScripts,
      distRoot,
      join(distRoot, "nested"),
    );

    assert.deepEqual(failures, [
      `apply script failed: ${secondPath} (exit code 99)`,
      `apply script failed: ${firstPath}: home copy path overlaps a dist declaration`,
    ]);
    assert.equal(await readFile(join(distRoot, secondPath), "utf8"), `${body}\n`);
  });

  it("removes the prepared home copy after a spawn error", async () => {
    await putApplyScript(distRoot, "setup.apply.ts");
    const declarations = await collectDeclarations(distRoot);
    const spawn = spyOn(Bun, "spawn").mockImplementationOnce(() => {
      throw new Error("spawn denied");
    });

    try {
      const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

      assert.deepEqual(failures, ["apply script failed: setup.apply.ts: spawn denied"]);
      assert.equal(spawn.mock.calls.length, 1);
      assert.equal(existsSync(join(homeRoot, "setup.apply.ts")), false);
    } finally {
      spawn.mockRestore();
    }
  });

  it("reports unsupported extensions and keeps running remaining scripts", async () => {
    await put(distRoot, "pkg/bad.apply.sh", "not a TypeScript hook\n");
    const copyPath = await put(homeRoot, "pkg/bad.apply.sh", "keep this file");
    await putApplyScript(distRoot, "pkg/good.apply.ts");
    const declarations = await collectDeclarations(distRoot);

    const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.deepEqual(failures, ["apply hook has unsupported extension: pkg/bad.apply.sh"]);
    assert.equal(await readFile(copyPath, "utf8"), "keep this file");
    assert.equal(existsSync(join(homeRoot, "pkg", "apply-out.txt")), true);
  });

  it("runs remaining scripts after a non-zero exit and reports the failure", async () => {
    await putApplyScript(distRoot, "fail.apply.ts", "process.exit(3);");
    await putApplyScript(distRoot, "late.apply.ts");
    const declarations = await collectDeclarations(distRoot);

    const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.deepEqual(failures, ["apply script failed: fail.apply.ts (exit code 3)"]);
    assert.equal(existsSync(join(homeRoot, "fail.apply.ts")), false);
    assert.equal(await readFile(join(homeRoot, "apply-out.txt"), "utf8"), homeRoot);
  });

  it("reports a signal-terminated script and keeps running remaining scripts", async () => {
    await putApplyScript(distRoot, "late.apply.ts");
    await putApplyScript(distRoot, "sig.apply.ts", 'process.kill(process.pid, "SIGKILL");');
    const declarations = await collectDeclarations(distRoot);

    const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.deepEqual(failures, ["apply script failed: sig.apply.ts (signal SIGKILL)"]);
    assert.equal(await readFile(join(homeRoot, "apply-out.txt"), "utf8"), homeRoot);
  });

  it("reports every failure when several scripts fail", async () => {
    await putApplyScript(distRoot, "a.fail.apply.ts", "process.exit(5);");
    await putApplyScript(distRoot, "b.fail.apply.ts", "process.exit(7);");
    const declarations = await collectDeclarations(distRoot);

    const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.deepEqual(failures, [
      "apply script failed: a.fail.apply.ts (exit code 5)",
      "apply script failed: b.fail.apply.ts (exit code 7)",
    ]);
  });
});

describe("unsupported apply scripts", () => {
  it("reports PowerShell hooks as failures", async () => {
    await put(distRoot, "ps/task.apply.ps1", "Set-Content -Value done\n");
    const declarations = await collectDeclarations(distRoot);

    const failures = await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.deepEqual(failures, ["apply hook has unsupported extension: ps/task.apply.ps1"]);
    assert.equal(existsSync(join(homeRoot, "ps")), false);
  });
});

describe("CLI", () => {
  it("parses --dry-run separately, requires the home root, and expands ~", async () => {
    const parsed = parseArgs(["--dry-run", "dist", "~", "--json"]);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.distRoot, "dist");
    assert.equal(parsed.homeRoot, homedir());
    assert.deepEqual(parsed.rest, ["dist", "~", "--json"]);

    const literal = parseArgs(["dist", "/tmp/somewhere"]);
    assert.equal(literal.dryRun, false);
    assert.equal(literal.homeRoot, "/tmp/somewhere");

    assert.throws(() => parseArgs(["only-dist"]), /usage:/);
  });

  it("applies and runs an apply script end to end", async () => {
    await put(distRoot, "a.txt", "new\n");
    await putApplyScript(distRoot, "final.apply.ts");
    const declarations = await collectDeclarations(distRoot);
    assert.equal(declarations.applyScripts.length, 1);

    const exitCode = await main([distRoot, homeRoot, "--yes"]);

    assert.equal(exitCode, 0);
    assert.equal(await readFile(join(homeRoot, "a.txt"), "utf8"), "new\n");
    assert.equal(existsSync(join(homeRoot, "apply-out.txt")), true);
  });

  it("runs an apply script when the dist root is relative", async () => {
    await put(distRoot, "a.txt", "new\n");
    await putApplyScript(distRoot, "final.apply.ts");
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const exitCode = await main(["dist", homeRoot, "--yes"]);
      assert.equal(exitCode, 0);
    } finally {
      process.chdir(previousCwd);
    }

    assert.equal(await readFile(join(homeRoot, "a.txt"), "utf8"), "new\n");
    assert.equal(existsSync(join(homeRoot, "apply-out.txt")), true);
  });

  it("direct --dry-run --json reports differences without home writes or apply scripts", async () => {
    await put(distRoot, "changed.txt", "new\n");
    await put(homeRoot, "changed.txt", "old\n");
    await put(distRoot, "added.txt", "added\n");
    await put(distRoot, "exact.exact/keep.txt", "keep\n");
    await put(homeRoot, "exact/keep.txt", "keep\n");
    await put(homeRoot, "exact/stale.txt", "stale\n");
    await putApplyScript(distRoot, "final.apply.ts");

    const cli = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "apply.ts"),
        "--dry-run",
        distRoot,
        homeRoot,
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.equal(
      stdout,
      `${JSON.stringify(
        {
          changed: ["changed.txt"],
          typeMismatches: [],
          added: ["added.txt"],
          removedExact: ["exact/stale.txt"],
          removedIgnored: [],
        },
        null,
        2,
      )}\n`,
    );
    assert.equal(await readFile(join(homeRoot, "changed.txt"), "utf8"), "old\n");
    assert.equal(existsSync(join(homeRoot, "added.txt")), false);
    assert.equal(existsSync(join(homeRoot, "exact/stale.txt")), true);
    assert.equal(existsSync(join(homeRoot, "apply-out.txt")), false);
  });

  it("direct --dry-run displays a diff without changing home or running scripts", async () => {
    await put(distRoot, "settings.json", '{"value":2}\n');
    await put(homeRoot, "settings.json", '{"value":1}\n');
    await putApplyScript(distRoot, "final.apply.ts");

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dir, "apply.ts"), "--dry-run", distRoot, homeRoot],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /settings\.json/);
    assert.match(stripVTControlCharacters(stdout), /"value":2/);
    assert.equal(await readFile(join(homeRoot, "settings.json"), "utf8"), '{"value":1}\n');
    assert.equal(existsSync(join(homeRoot, "apply-out.txt")), false);
  });

  it("direct CLI reports one application per added directory entry", async () => {
    await put(distRoot, "pkg/nested/file.txt", "x\n");

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dir, "apply.ts"), "--yes", distRoot, homeRoot],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /^diff: 0 changed, 0 type mismatches, 3 added,/);
    assert.match(
      stdout,
      /apply: 3 added, 0 changed, 0 removed \(\d+\.\d{2}s\)\napply scripts: 0 scripts \(\d+\.\d{2}s\)\n$/,
    );
    assert.equal(await readFile(join(homeRoot, "pkg/nested/file.txt"), "utf8"), "x\n");
  });

  it("direct --json still applies and prints the normal summary", async () => {
    await put(distRoot, "added.txt", "added\n");
    await putApplyScript(distRoot, "final.apply.ts");

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dir, "apply.ts"), "--yes", distRoot, homeRoot, "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /^diff: 0 changed, 0 type mismatches, 1 added,/);
    assert.match(
      stdout,
      /apply: 1 added, 0 changed, 0 removed \(\d+\.\d{2}s\)\n  \[final\.apply\.ts\] Started\n  \[final\.apply\.ts\] ✓ Complete \(\d+\.\d{2}s\)\napply scripts: 1 scripts \(\d+\.\d{2}s\)\n$/,
    );
    assert.equal(await readFile(join(homeRoot, "added.txt"), "utf8"), "added\n");
    assert.equal(existsSync(join(homeRoot, "apply-out.txt")), true);
  });

  it("direct CLI runs remaining scripts after a failure, reports it, and exits non-zero", async () => {
    await putApplyScript(distRoot, "fail.apply.ts", "process.exit(3);");
    await putApplyScript(distRoot, "late.apply.ts");

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dir, "apply.ts"), "--yes", distRoot, homeRoot],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);

    assert.equal(exitCode, 1);
    assert.equal(stderr, "apply script failed: fail.apply.ts (exit code 3)\n");
    assert.match(stdout, /  \[fail\.apply\.ts\] Started\n/);
    assert.match(stdout, /  \[fail\.apply\.ts\] ✗ Failed \(\d+\.\d{2}s\)\n/);
    assert.match(stdout, /  \[late\.apply\.ts\] Started\n/);
    assert.match(stdout, /  \[late\.apply\.ts\] ✓ Complete \(\d+\.\d{2}s\)\n/);
    assert.match(stdout, /apply scripts: 2 scripts \(\d+\.\d{2}s\)\n$/);
    assert.equal(await readFile(join(homeRoot, "apply-out.txt"), "utf8"), homeRoot);
  });

  it("direct CLI reports missing arguments and invalid roots on stderr", async () => {
    for (const args of [[distRoot], [distRoot, join(root, "missing")]]) {
      const cli = Bun.spawn([process.execPath, join(import.meta.dir, "apply.ts"), ...args], {
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
});

describe("apply confirmation", () => {
  it("applies when the confirmation accepts", async () => {
    await put(distRoot, "a.txt", "new\n");

    const exitCode = await main([distRoot, homeRoot], async () => true);

    assert.equal(exitCode, 0);
    assert.equal(await readFile(join(homeRoot, "a.txt"), "utf8"), "new\n");
  });

  it("aborts with exit code 0, no home writes, and no apply scripts when declined", async () => {
    await put(distRoot, "a.txt", "new\n");
    await put(homeRoot, "a.txt", "old\n");
    await putApplyScript(distRoot, "final.apply.ts");

    const exitCode = await main([distRoot, homeRoot], async () => false);

    assert.equal(exitCode, 0);
    assert.equal(await readFile(join(homeRoot, "a.txt"), "utf8"), "old\n");
    assert.equal(existsSync(join(homeRoot, "apply-out.txt")), false);
  });

  it("skips the confirmation when --yes is given", async () => {
    await put(distRoot, "a.txt", "new\n");

    const exitCode = await main([distRoot, homeRoot, "--yes"], async () => {
      throw new Error("confirmation must not run with --yes");
    });

    assert.equal(exitCode, 0);
    assert.equal(await readFile(join(homeRoot, "a.txt"), "utf8"), "new\n");
  });

  it("aborts with exit code 0 when stdin ends before an answer", async () => {
    await put(distRoot, "a.txt", "new\n");
    await put(homeRoot, "a.txt", "old\n");

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dir, "apply.ts"), distRoot, homeRoot],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /Apply\? \[y\/N\] /);
    assert.match(stdout, /apply aborted/);
    assert.equal(await readFile(join(homeRoot, "a.txt"), "utf8"), "old\n");
  });

  it("reads the answer from the given stream and treats EOF as a decline", async () => {
    assert.equal(await confirmApplyStdin(Stream.Readable.from(["y\n"])), true);
    assert.equal(await confirmApplyStdin(Stream.Readable.from(["  Y \n"])), true);
    assert.equal(await confirmApplyStdin(Stream.Readable.from(["n\n"])), false);
    assert.equal(await confirmApplyStdin(Stream.Readable.from([])), false);
  });

  it("accepts only y answers ignoring case and surrounding whitespace", () => {
    assert.equal(confirmsApply("y\n"), true);
    assert.equal(confirmsApply("  Y \n"), true);
    assert.equal(confirmsApply("yes"), false);
    assert.equal(confirmsApply("n\n"), false);
    assert.equal(confirmsApply(""), false);
  });
});
