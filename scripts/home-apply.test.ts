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
import { collectDifferences, type DiffResult } from "./home-diff.ts";
import {
  applyDifferences,
  collectDeclarations,
  main,
  parseArgs,
  plannedPayload,
  runLifecycleHooks,
  runRunScripts,
  type ApplyResult,
} from "./home-apply.ts";

let root: string;
let distRoot: string;
let homeRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "home-apply-test-"));
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

// A hook script that records its cwd and the stdin payload in its cwd.
async function putRecordingHook(rootDir: string, path: string): Promise<void> {
  await put(
    rootDir,
    path,
    'const payload = JSON.parse(await Bun.stdin.text());\n' +
      'await Bun.write("hook-out.json", JSON.stringify({ cwd: process.cwd(), payload }));\n',
  );
}

type HookOutput = { cwd: string; payload: { added: string[]; changed: string[]; removed: string[] } };

async function readHookOutput(rootDir: string, path: string): Promise<HookOutput> {
  return JSON.parse(await readFile(join(rootDir, path), "utf8"));
}

// A hook script that appends "tag:cwd" lines to a shared file.
async function putOrderHook(
  rootDir: string,
  path: string,
  tag: string,
  orderFile: string,
): Promise<void> {
  await put(
    rootDir,
    path,
    `const fs = await import("node:fs/promises");\n` +
      `await fs.appendFile(${JSON.stringify(orderFile)}, ${JSON.stringify(tag)} + ":" + process.cwd() + "\\n");\n`,
  );
}

async function putRunScript(rootDir: string, path: string, body = "pwd > run-out.txt"): Promise<void> {
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

describe("lifecycle hooks", () => {
  it("passes the planned payload as JSON on stdin to a root hook", async () => {
    await put(distRoot, "new.txt", "x\n");
    await putRecordingHook(distRoot, ".pre-apply.ts");
    const result = await collectDifferences(distRoot, homeRoot, "linux");

    await runLifecycleHooks(
      (await collectDeclarations(distRoot)).preApply,
      distRoot,
      homeRoot,
      plannedPayload(result),
      "pre-apply hook",
    );

    const output = await readHookOutput(homeRoot, "hook-out.json");
    assert.equal(output.cwd, homeRoot);
    assert.deepEqual(output.payload.added, ["new.txt"]);
    assert.deepEqual(output.payload.changed, []);
    assert.deepEqual(output.payload.removed, []);
  });

  it("scopes the payload to the hook folder", async () => {
    await put(distRoot, "pkg/in.txt", "x\n");
    await put(distRoot, "other/out.txt", "y\n");
    await putRecordingHook(distRoot, "pkg/.pre-apply.ts");
    const result = await collectDifferences(distRoot, homeRoot, "linux");

    await runLifecycleHooks(
      (await collectDeclarations(distRoot)).preApply,
      distRoot,
      homeRoot,
      plannedPayload(result),
      "pre-apply hook",
    );

    const output = await readHookOutput(homeRoot, join("pkg", "hook-out.json"));
    // The parent directory counts as an addition too; other/out.txt must not appear.
    assert.deepEqual(output.payload.added, ["pkg", "pkg/in.txt"]);
  });

  it("runs each hook in its folder's home directory with the .exact suffix stripped", async () => {
    await put(distRoot, "cfg.exact/new.txt", "x\n");
    await putRecordingHook(distRoot, "cfg.exact/.pre-apply.ts");
    const result = await collectDifferences(distRoot, homeRoot, "linux");

    await runLifecycleHooks(
      (await collectDeclarations(distRoot)).preApply,
      distRoot,
      homeRoot,
      plannedPayload(result),
      "pre-apply hook",
    );

    const output = await readHookOutput(homeRoot, join("cfg", "hook-out.json"));
    assert.equal(output.cwd, join(homeRoot, "cfg"));
  });

  it("runs hooks parent-first in folder order", async () => {
    const orderFile = join(root, "order.txt");
    await putOrderHook(distRoot, "z/.pre-apply.ts", "z", orderFile);
    await putOrderHook(distRoot, "a/b/.pre-apply.ts", "a/b", orderFile);
    await putOrderHook(distRoot, "a/.pre-apply.ts", "a", orderFile);
    const declarations = await collectDeclarations(distRoot);

    await runLifecycleHooks(declarations.preApply, distRoot, homeRoot, {
      added: [],
      changed: [],
      removed: [],
    }, "pre-apply hook");

    const order = await readFile(orderFile, "utf8");
    assert.deepEqual(
      order.trim().split("\n").map((line) => line.split(":")[0]),
      ["a", "a/b", "z"],
    );
  });

  it("passes the applied result to a post-apply hook", async () => {
    await put(distRoot, "dir.exact/keep.txt", "same\n");
    await put(homeRoot, "dir/keep.txt", "same\n");
    await put(homeRoot, "dir/stale.txt", "old\n");
    await putRecordingHook(distRoot, "dir.exact/.post-apply.ts");
    const result = await collectDifferences(distRoot, homeRoot, "linux");
    const applied = await applyDifferences(distRoot, homeRoot, result, "linux");

    await runLifecycleHooks(
      (await collectDeclarations(distRoot)).postApply,
      distRoot,
      homeRoot,
      applied,
      "post-apply hook",
    );

    const output = await readHookOutput(homeRoot, join("dir", "hook-out.json"));
    assert.deepEqual(output.payload.removed, ["dir/stale.txt"]);
    assert.deepEqual(output.payload.added, []);
  });

  it("creates a missing home folder for a hook cwd", async () => {
    await putRecordingHook(distRoot, "brand/new/.post-apply.ts");
    const declarations = await collectDeclarations(distRoot);

    await runLifecycleHooks(declarations.postApply, distRoot, homeRoot, {
      added: [],
      changed: [],
      removed: [],
    }, "post-apply hook");

    const output = await readHookOutput(homeRoot, join("brand", "new", "hook-out.json"));
    assert.equal(output.cwd, join(homeRoot, "brand", "new"));
  });

  it("collects declarations skipping node_modules and excluded folders", async () => {
    await putRecordingHook(distRoot, "ok/.pre-apply.ts");
    await putRecordingHook(distRoot, join("node_modules", "pkg", ".pre-apply.ts"));
    await put(distRoot, ".pre-build.d/hidden/.pre-apply.ts", "hook\n");
    await putRunScript(distRoot, join("node_modules", "pkg", "run_x.sh"));
    await putRunScript(distRoot, "ok/run_y.sh");

    const declarations = await collectDeclarations(distRoot);

    assert.deepEqual(declarations.preApply.map((hook) => hook.distPath), ["ok/.pre-apply.ts"]);
    assert.deepEqual(declarations.runScripts.map((run) => run.distPath), ["ok/run_y.sh"]);
  });
});

describe("run scripts", () => {
  it("runs a shebang script via its interpreter in the mapped home folder", async () => {
    await putRunScript(distRoot, "tools/run_setup.sh");
    const declarations = await collectDeclarations(distRoot);

    await runRunScripts(declarations.runScripts, distRoot, homeRoot);

    const output = await readFile(join(homeRoot, "tools", "run-out.txt"), "utf8");
    assert.equal(output.trim(), join(homeRoot, "tools"));
  });

  it("runs scripts in folder then filename order", async () => {
    const orderFile = join(root, "run-order.txt");
    await putRunScript(distRoot, "pkg/run_second.sh", `echo b >> ${JSON.stringify(orderFile)}`);
    await putRunScript(distRoot, "pkg/run_first.sh", `echo a >> ${JSON.stringify(orderFile)}`);
    await putRunScript(distRoot, "aaa/run_early.sh", `echo c >> ${JSON.stringify(orderFile)}`);
    const declarations = await collectDeclarations(distRoot);

    await runRunScripts(declarations.runScripts, distRoot, homeRoot);

    assert.deepEqual(
      (await readFile(orderFile, "utf8")).trim().split("\n"),
      ["c", "a", "b"],
    );
  });

  it("errors on a script without shebang or .ps1 extension and stops the queue", async () => {
    await put(distRoot, "pkg/run_bad.sh", "pwd > never.txt\n");
    await putRunScript(distRoot, "pkg/run_good.sh");
    const declarations = await collectDeclarations(distRoot);

    await assert.rejects(
      runRunScripts(declarations.runScripts, distRoot, homeRoot),
      /run script has neither a shebang nor a \.ps1 extension: pkg\/run_bad\.sh/,
    );
    assert.equal(existsSync(join(homeRoot, "pkg", "run-out.txt")), false);
  });

  it("stops remaining scripts on a non-zero exit", async () => {
    await putRunScript(distRoot, "run_fail.sh", "exit 3");
    await putRunScript(distRoot, "run_late.sh");
    const declarations = await collectDeclarations(distRoot);

    await assert.rejects(
      runRunScripts(declarations.runScripts, distRoot, homeRoot),
      /run script failed: run_fail\.sh \(exit code 3\)/,
    );
    assert.equal(existsSync(join(homeRoot, "run-out.txt")), false);
  });
});

const pwshPath = Bun.which("pwsh");

describe("run scripts on windows shell", () => {
  it.skipIf(pwshPath === null)("runs a .ps1 script via pwsh", async () => {
    await put(distRoot, "ps/run_task.ps1", 'Set-Content -Path "ps-out.txt" -Value "done"\n');
    const declarations = await collectDeclarations(distRoot);

    await runRunScripts(declarations.runScripts, distRoot, homeRoot);

    const output = await readFile(join(homeRoot, "ps", "ps-out.txt"), "utf8");
    assert.equal(output.trim(), "done");
  });
});

describe("planned payload and CLI", () => {
  it("merges type mismatches into added and removed of the planned payload", async () => {
    await put(distRoot, "entry/inner.txt", "x\n");
    await put(homeRoot, "entry", "i was a file\n");
    await put(homeRoot, "stale.exact-scope", "old\n");
    await put(distRoot, "keep.txt", "same\n");
    await put(homeRoot, "keep.txt", "same\n");
    const result = await collectDifferences(distRoot, homeRoot, "linux");
    // Simulate an exact-scope surplus to exercise the removed list.
    result.removedExact.push({ homePath: "stale.exact-scope", distPath: null });

    const payload = plannedPayload(result);

    assert.deepEqual(payload.added, ["entry"]);
    assert.deepEqual(payload.removed, ["entry", "stale.exact-scope"]);
  });

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

  it("applies, hooks, and runs end to end", async () => {
    await put(distRoot, "a.txt", "new\n");
    await putRunScript(distRoot, "run_final.sh");
    const declarations = await collectDeclarations(distRoot);
    assert.equal(declarations.runScripts.length, 1);

    const exitCode = await main([distRoot, homeRoot]);

    assert.equal(exitCode, 0);
    assert.equal(await readFile(join(homeRoot, "a.txt"), "utf8"), "new\n");
    assert.equal(existsSync(join(homeRoot, "run-out.txt")), true);
  });

  it("skips the apply when a pre-apply hook fails", async () => {
    await put(distRoot, "a.txt", "new\n");
    await put(distRoot, ".pre-apply.ts", "process.exit(1);\n");

    await assert.rejects(main([distRoot, homeRoot]), /pre-apply hook failed/);

    assert.equal(existsSync(join(homeRoot, "a.txt")), false);
  });

  it("skips run scripts when a post-apply hook fails", async () => {
    await put(distRoot, "a.txt", "new\n");
    await put(distRoot, ".post-apply.ts", "process.exit(1);\n");
    await putRunScript(distRoot, "run_final.sh");

    await assert.rejects(main([distRoot, homeRoot]), /post-apply hook failed/);

    assert.equal(await readFile(join(homeRoot, "a.txt"), "utf8"), "new\n");
    assert.equal(existsSync(join(homeRoot, "run-out.txt")), false);
  });
});
