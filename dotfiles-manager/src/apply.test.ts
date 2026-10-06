import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import {
  chmod,
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
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { collectDifferences, type DiffResult } from "./diff.ts";
import {
  applyDifferences,
  collectDeclarations,
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

    const exitCode = await main([distRoot, homeRoot]);

    assert.equal(exitCode, 0);
    assert.equal(
      await readFile(join(homeRoot, "node_modules/pkg/apply-out.txt"), "utf8"),
      join(homeRoot, "node_modules/pkg"),
    );
    assert.equal(existsSync(join(homeRoot, "node_modules/pkg/setup.apply.ts")), false);
  });

  it("runs machine-specific scripts after applying without placing them in home", async () => {
    await put(distRoot, "tools/keep.txt", "same\n");
    await put(homeRoot, "tools/keep.txt", "same\n");
    await putApplyScript(distRoot, "tools/setup.apply-machine.ts");
    const declarations = await collectDeclarations(distRoot);
    const result = await diffAndApply();

    await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.deepEqual(
      declarations.applyScripts.map((script) => script.distPath),
      ["tools/setup.apply-machine.ts"],
    );
    assert.deepEqual(result.added, []);
    assert.equal(existsSync(join(homeRoot, "tools/setup.apply-machine.ts")), false);
    assert.equal(
      await readFile(join(homeRoot, "tools/apply-out.txt"), "utf8"),
      join(homeRoot, "tools"),
    );
  });
  it("runs a TypeScript hook in the mapped home folder without requiring a shebang", async () => {
    await putApplyScript(
      distRoot,
      "tools/setup.apply.ts",
      `import { writeFile } from "node:fs/promises";\nawait writeFile("apply-out.txt", JSON.stringify([process.cwd(), import.meta.dir]));`,
    );
    const declarations = await collectDeclarations(distRoot);

    await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    const output = JSON.parse(await readFile(join(homeRoot, "tools", "apply-out.txt"), "utf8"));
    assert.deepEqual(output, [join(homeRoot, "tools"), join(distRoot, "tools")]);
  });

  it("runs a shebang hook with the home cwd and dist import directory", async () => {
    await putApplyScript(
      distRoot,
      "tools/setup.apply.ts",
      `#!/usr/bin/env bun\nimport { writeFile } from "node:fs/promises";\nawait writeFile("apply-out.txt", JSON.stringify([process.cwd(), import.meta.dir]));`,
    );
    const declarations = await collectDeclarations(distRoot);

    await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    const output = JSON.parse(await readFile(join(homeRoot, "tools", "apply-out.txt"), "utf8"));
    assert.deepEqual(output, [join(homeRoot, "tools"), join(distRoot, "tools")]);
  });

  it("runs scripts in full-path alphabetical order", async () => {
    const orderFile = join(root, "apply-order.txt");
    const appendOrder = (value: string) =>
      `import { appendFile } from "node:fs/promises";\nawait appendFile(${JSON.stringify(orderFile)}, ${JSON.stringify(`${value}\n`)});`;
    await putApplyScript(distRoot, "pkg/second.apply.ts", appendOrder("b"));
    await putApplyScript(distRoot, "pkg/first.apply.ts", appendOrder("a"));
    await putApplyScript(distRoot, "aaa/early.apply.ts", appendOrder("c"));
    await putApplyScript(distRoot, "pkg-/before.apply.ts", appendOrder("before"));
    const declarations = await collectDeclarations(distRoot);

    await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.deepEqual((await readFile(orderFile, "utf8")).trim().split("\n"), [
      "c",
      "before",
      "a",
      "b",
    ]);
  });

  it("runs a collected script after an earlier script moves it in dist", async () => {
    const orderFile = join(root, "apply-order.txt");
    const movedPath = join(distRoot, "moved/z-late.apply.ts");
    await putApplyScript(
      distRoot,
      "a-move.apply.ts",
      `import { appendFile, mkdir, rename } from "node:fs/promises";\nawait mkdir(${JSON.stringify(join(distRoot, "moved"))}, { recursive: true });\nawait rename(${JSON.stringify(join(distRoot, "z-late.apply.ts"))}, ${JSON.stringify(movedPath)});\nawait appendFile(${JSON.stringify(orderFile)}, "move\\n");`,
    );
    await putApplyScript(
      distRoot,
      "z-late.apply.ts",
      `import { appendFile } from "node:fs/promises";\nawait appendFile(${JSON.stringify(orderFile)}, "collected\\n");`,
    );
    const declarations = await collectDeclarations(distRoot);

    await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.equal(await readFile(orderFile, "utf8"), "move\ncollected\n");
    assert.equal(existsSync(movedPath), true);
  });

  it("runs a collected script after removal and preserves existing ancestors", async () => {
    const orderFile = join(root, "apply-order.txt");
    await putApplyScript(
      distRoot,
      "a-prune.apply.ts",
      `import { appendFile, rm } from "node:fs/promises";\nawait rm(${JSON.stringify(join(distRoot, "pkg/sub"))}, { recursive: true, force: true });\nawait appendFile(${JSON.stringify(orderFile)}, "prune\\n");`,
    );
    await putApplyScript(
      distRoot,
      "pkg/sub/z-late.apply.ts",
      `import { appendFile } from "node:fs/promises";\nawait appendFile(${JSON.stringify(orderFile)}, "collected\\n");`,
    );
    await put(distRoot, "pkg/keep.txt", "keep\n");
    const declarations = await collectDeclarations(distRoot);

    await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.equal(await readFile(orderFile, "utf8"), "prune\ncollected\n");
    assert.equal(await readFile(join(distRoot, "pkg/keep.txt"), "utf8"), "keep\n");
    assert.equal(existsSync(join(distRoot, "pkg/sub")), false);
  });

  it("removes a script snapshot after its hook moves its directory", async () => {
    const sourceDirectory = join(distRoot, "self");
    const movedDirectory = join(distRoot, "moved");
    await putApplyScript(
      distRoot,
      "self/move.apply.ts",
      `import { rename } from "node:fs/promises";\nawait rename(${JSON.stringify(sourceDirectory)}, ${JSON.stringify(movedDirectory)});`,
    );
    const declarations = await collectDeclarations(distRoot);

    await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.equal(existsSync(join(movedDirectory, "move.apply.ts")), true);
    assert.deepEqual(await readdir(movedDirectory), ["move.apply.ts"]);
  });

  it("rejects unsupported extensions and stops the queue", async () => {
    await put(distRoot, "pkg/bad.apply.sh", "not a TypeScript hook\n");
    await putApplyScript(distRoot, "pkg/good.apply.ts");
    const declarations = await collectDeclarations(distRoot);

    await assert.rejects(
      runApplyScripts(declarations.applyScripts, distRoot, homeRoot),
      /apply hook has unsupported extension: pkg\/bad\.apply\.sh/,
    );
    assert.equal(existsSync(join(homeRoot, "pkg", "apply-out.txt")), false);
  });

  it("stops remaining scripts on a non-zero exit", async () => {
    await putApplyScript(distRoot, "fail.apply.ts", "process.exit(3);");
    await putApplyScript(distRoot, "late.apply.ts");
    const declarations = await collectDeclarations(distRoot);

    await assert.rejects(
      runApplyScripts(declarations.applyScripts, distRoot, homeRoot),
      /apply script failed: fail\.apply\.ts \(exit code 3\)/,
    );
    assert.equal(existsSync(join(homeRoot, "apply-out.txt")), false);
  });
});

describe("unsupported apply scripts", () => {
  it("rejects PowerShell hooks", async () => {
    await put(distRoot, "ps/task.apply.ps1", "Set-Content -Value done\n");
    const declarations = await collectDeclarations(distRoot);

    await assert.rejects(
      runApplyScripts(declarations.applyScripts, distRoot, homeRoot),
      /apply hook has unsupported extension: ps\/task\.apply\.ps1/,
    );
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

    const exitCode = await main([distRoot, homeRoot]);

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
      const exitCode = await main(["dist", homeRoot]);
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
      [process.execPath, join(import.meta.dir, "apply.ts"), distRoot, homeRoot],
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
    assert.match(stdout, /apply: 3 added, 0 changed, 0 removed \(\d+\.\d{2}s\)\napply scripts: 0 scripts \(\d+\.\d{2}s\)\n$/);
    assert.equal(await readFile(join(homeRoot, "pkg/nested/file.txt"), "utf8"), "x\n");
  });

  it("direct --json still applies and prints the normal summary", async () => {
    await put(distRoot, "added.txt", "added\n");
    await putApplyScript(distRoot, "final.apply.ts");

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dir, "apply.ts"), distRoot, homeRoot, "--json"],
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
    assert.match(stdout, /apply: 1 added, 0 changed, 0 removed \(\d+\.\d{2}s\)\napply scripts: 1 scripts \(\d+\.\d{2}s\)\n$/);
    assert.equal(await readFile(join(homeRoot, "added.txt"), "utf8"), "added\n");
    assert.equal(existsSync(join(homeRoot, "apply-out.txt")), true);
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
