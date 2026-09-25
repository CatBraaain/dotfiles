import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { existsSync } from "node:fs";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { homedir, tmpdir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join } from "node:path";
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
  body = "pwd > apply-out.txt",
): Promise<void> {
  await put(rootDir, path, `#!/bin/sh\n${body}\n`);
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

  it("adds a directory with nested entries", async () => {
    await put(distRoot, "pkg/nested/file.txt", "x\n");

    await diffAndApply();

    const statHome = await stat(join(homeRoot, "pkg"));
    assert.ok(statHome.isDirectory());
    assert.equal(await readFile(join(homeRoot, "pkg/nested/file.txt"), "utf8"), "x\n");
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

  it("replaces file content atomically so the file gets a new inode", async () => {
    await put(distRoot, "a.txt", "new\n");
    const homeAbs = await put(homeRoot, "a.txt", "old\n");
    const before = await stat(homeAbs);

    await diffAndApply();

    const after = await stat(homeAbs);
    assert.notEqual(after.ino, before.ino, "rename should replace the inode");
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

  it("reports type mismatch as a removal of the old entry and an addition of the new one", async () => {
    await put(distRoot, "entry/inner.txt", "x\n");
    await put(homeRoot, "entry", "i was a file\n");

    const result = await collectDifferences(distRoot, homeRoot, "linux");
    const applied = await applyDifferences(distRoot, homeRoot, result, "linux");

    assert.deepEqual(applied.removed, ["entry"]);
    assert.deepEqual(applied.added, ["entry", "entry/inner.txt"]);
    assert.deepEqual(applied.changed, []);
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

  it("does not touch executable bits on windows", async () => {
    await put(distRoot, "tool.executable", "#!/bin/sh\n");

    await diffAndApply("win32");

    assert.equal(existsSync(join(homeRoot, "tool")), true);
  });
});

describe("apply scripts", () => {
  it("collects declarations skipping node_modules and excluded folders", async () => {
    await putApplyScript(distRoot, join("node_modules", "pkg", "x.apply.sh"));
    await put(distRoot, ".build.d/hidden/x.apply.sh", "script\n");
    await putApplyScript(distRoot, "ok/y.apply.sh");

    const declarations = await collectDeclarations(distRoot);

    assert.deepEqual(declarations.applyScripts.map((script) => script.distPath), [
      "ok/y.apply.sh",
    ]);
  });

  it("runs a shebang script via its interpreter in the mapped home folder", async () => {
    await putApplyScript(distRoot, "tools/setup.apply.sh");
    const declarations = await collectDeclarations(distRoot);

    await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    const output = await readFile(join(homeRoot, "tools", "apply-out.txt"), "utf8");
    assert.equal(output.trim(), join(homeRoot, "tools"));
  });

  it("runs scripts in folder then filename order", async () => {
    const orderFile = join(root, "apply-order.txt");
    await putApplyScript(distRoot, "pkg/second.apply.sh", `echo b >> ${JSON.stringify(orderFile)}`);
    await putApplyScript(distRoot, "pkg/first.apply.sh", `echo a >> ${JSON.stringify(orderFile)}`);
    await putApplyScript(distRoot, "aaa/early.apply.sh", `echo c >> ${JSON.stringify(orderFile)}`);
    const declarations = await collectDeclarations(distRoot);

    await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    assert.deepEqual(
      (await readFile(orderFile, "utf8")).trim().split("\n"),
      ["c", "a", "b"],
    );
  });

  it("errors on a script without shebang or .ps1 extension and stops the queue", async () => {
    await put(distRoot, "pkg/bad.apply.sh", "pwd > never.txt\n");
    await putApplyScript(distRoot, "pkg/good.apply.sh");
    const declarations = await collectDeclarations(distRoot);

    await assert.rejects(
      runApplyScripts(declarations.applyScripts, distRoot, homeRoot),
      /apply script has neither a shebang nor a \.ps1 extension: pkg\/bad\.apply\.sh/,
    );
    assert.equal(existsSync(join(homeRoot, "pkg", "apply-out.txt")), false);
  });

  it("stops remaining scripts on a non-zero exit", async () => {
    await putApplyScript(distRoot, "fail.apply.sh", "exit 3");
    await putApplyScript(distRoot, "late.apply.sh");
    const declarations = await collectDeclarations(distRoot);

    await assert.rejects(
      runApplyScripts(declarations.applyScripts, distRoot, homeRoot),
      /apply script failed: fail\.apply\.sh \(exit code 3\)/,
    );
    assert.equal(existsSync(join(homeRoot, "apply-out.txt")), false);
  });
});

const pwshPath = Bun.which("pwsh");

describe("apply scripts on windows shell", () => {
  it.skipIf(pwshPath === null)("runs a .ps1 script via pwsh", async () => {
    await put(distRoot, "ps/task.apply.ps1", 'Set-Content -Path "ps-out.txt" -Value "done"\n');
    const declarations = await collectDeclarations(distRoot);

    await runApplyScripts(declarations.applyScripts, distRoot, homeRoot);

    const output = await readFile(join(homeRoot, "ps", "ps-out.txt"), "utf8");
    assert.equal(output.trim(), "done");
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
    await putApplyScript(distRoot, "final.apply.sh");
    const declarations = await collectDeclarations(distRoot);
    assert.equal(declarations.applyScripts.length, 1);

    const exitCode = await main([distRoot, homeRoot]);

    assert.equal(exitCode, 0);
    assert.equal(await readFile(join(homeRoot, "a.txt"), "utf8"), "new\n");
    assert.equal(existsSync(join(homeRoot, "apply-out.txt")), true);
  });

  it("runs an apply script when the dist root is relative", async () => {
    await put(distRoot, "a.txt", "new\n");
    await putApplyScript(distRoot, "final.apply.sh");
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
});
