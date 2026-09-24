import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { tmpdir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { join } from "node:path";
import {
  copyRepoEntries,
  copySkillTree,
  defaultTtlHours,
  fetchExternals,
  isPullDue,
  loadExternalConfig,
  readLastPullAt,
  resolveSkillDir,
  syncMirror,
  type SyncContext,
} from "./external-fetch.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "external-fetch-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(baseDir: string, path: string, content: string): Promise<void> {
  const absolute = join(baseDir, path);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content);
}

async function runProcess(
  args: string[],
  cwd?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, {
    ...(cwd === undefined ? {} : { cwd }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { ok: (await proc.exited) === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

// Creates a real git repository at the given path with one committed file.
async function initRepo(
  path: string,
  fileName: string,
  content: string,
): Promise<(...args: string[]) => Promise<string>> {
  await mkdir(path, { recursive: true });
  const git = async (...args: string[]): Promise<string> => {
    const result = await runProcess(["git", "-C", path, ...args]);
    if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
  };
  await git("init", "-q");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "test");
  await put(path, fileName, content);
  await git("add", ".");
  await git("commit", "-q", "-m", "first");
  return git;
}

function testContext(originPath: string, overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    mirrorRoot: join(root, "mirrors", "github.com"),
    forcePull: false,
    repoUrl: () => originPath,
    runGit: (args) => runProcess(["git", ...args]),
    runCommand: (args, cwd) => runProcess(args, cwd),
    ...overrides,
  };
}

describe("loadExternalConfig", () => {
  it("parses repos with destination, entries, ttlHours, run_after and edit", async () => {
    const configPath = join(root, ".build-external.yaml");
    await put(root, ".build-external.yaml", `
externalSkills:
  test/repo:
    destination: .agents/skills.exact
    entries:
      - skills/eli5
    ttlHours: 24
    run_after:
      - [node, build.mjs]
    edit:
      "skills/eli5/SKILL.md.$append": "extra"
`);

    const config = await loadExternalConfig(configPath);

    assert.equal(config.repos.length, 1);
    const repo = config.repos[0]!;
    assert.deepEqual(
      { ...repo, ttlMs: repo.ttlMs },
      {
        repo: "test/repo",
        destination: ".agents/skills.exact",
        entries: ["skills/eli5"],
        ttlMs: 24 * 60 * 60 * 1000,
        runAfter: [["node", "build.mjs"]],
        edits: [{ path: "skills/eli5/SKILL.md", text: "extra" }],
      },
    );
  });

  it("defaults ttlHours and rejects a missing destination or entries", async () => {
    const configPath = join(root, ".build-external.yaml");
    await put(root, ".build-external.yaml", `
externalSkills:
  test/repo:
    destination: .agents/skills.exact
    entries:
      - skills/eli5
`);
    assert.equal((await loadExternalConfig(configPath)).repos[0]!.ttlMs, defaultTtlHours * 60 * 60 * 1000);

    await put(root, ".build-external.yaml", `
externalSkills:
  test/repo:
    entries:
      - skills/eli5
`);
    await assert.rejects(loadExternalConfig(configPath), /\.destination/);

    await put(root, ".build-external.yaml", `
externalSkills:
  test/repo:
    destination: .agents/skills.exact
`);
    await assert.rejects(loadExternalConfig(configPath), /\.entries/);
  });
});

describe("isPullDue", () => {
  it("pulls on force, without a record, and only after the TTL elapses", () => {
    assert.equal(isPullDue(undefined, 1000, 500, false), true);
    assert.equal(isPullDue(500, 1000, 500, false), true);
    assert.equal(isPullDue(500, 1000, 500, true), true);
    assert.equal(isPullDue(501, 1000, 500, false), false);
  });
});

describe("syncMirror", () => {
  let originPath: string;
  let gitInOrigin: (...args: string[]) => Promise<string>;

  beforeEach(async () => {
    originPath = join(root, "origin", "test", "repo");
    gitInOrigin = await initRepo(originPath, "README.md", "first\n");
  });

  it("clones a missing mirror and records the pull time", async () => {
    const context = testContext(originPath);

    const sync = await syncMirror("test/repo", defaultTtlHours * 60 * 60 * 1000, context);

    assert.equal(sync.changed, true);
    assert.equal(
      await readFile(join(sync.mirrorDir, "README.md"), "utf8"),
      "first\n",
    );
    assert.notEqual(await readLastPullAt(sync.mirrorDir), undefined);
  });

  it("skips the pull within the TTL", async () => {
    const context = testContext(originPath);
    await syncMirror("test/repo", defaultTtlHours * 60 * 60 * 1000, context);
    await gitInOrigin("commit", "-q", "--allow-empty", "-m", "second");

    const sync = await syncMirror("test/repo", defaultTtlHours * 60 * 60 * 1000, context);

    assert.equal(sync.changed, false);
    assert.equal(await readFile(join(sync.mirrorDir, "README.md"), "utf8"), "first\n");
  });

  it("pulls when due, detects changes, and updates the pull time", async () => {
    const context = testContext(originPath);
    await syncMirror("test/repo", defaultTtlHours * 60 * 60 * 1000, context);
    const pullTimeAfterClone = await readLastPullAt(join(context.mirrorRoot, "test", "repo"));
    await gitInOrigin("commit", "-q", "--allow-empty", "-m", "second");
    await put(originPath, "docs/new.md", "added\n");
    await gitInOrigin("add", ".");
    await gitInOrigin("commit", "-q", "-m", "third");

    const sync = await syncMirror("test/repo", 0, context);

    assert.equal(sync.changed, true);
    assert.equal(await readFile(join(sync.mirrorDir, "docs/new.md"), "utf8"), "added\n");
    assert.ok((await readLastPullAt(sync.mirrorDir))! >= pullTimeAfterClone!);
  });

  it("keeps the existing mirror with a warning when the pull fails", async () => {
    const context = testContext(originPath, {
      runGit: async (args) =>
        args.includes("pull")
          ? { ok: false, stdout: "", stderr: "forced pull failure" }
          : runProcess(["git", ...args]),
    });
    await syncMirror("test/repo", defaultTtlHours * 60 * 60 * 1000, context);
    await gitInOrigin("commit", "-q", "--allow-empty", "-m", "second");

    const sync = await syncMirror("test/repo", 0, context);

    assert.equal(sync.changed, false);
    assert.equal(await readFile(join(sync.mirrorDir, "README.md"), "utf8"), "first\n");
  });

  it("rejects when the clone fails", async () => {
    const context = testContext(join(root, "origin", "missing"));

    await assert.rejects(
      syncMirror("test/repo", defaultTtlHours * 60 * 60 * 1000, context),
      /git clone failed/,
    );
  });
});

describe("resolveSkillDir", () => {
  it("resolves a single match and rejects zero or multiple matches", async () => {
    const mirrorDir = join(root, "mirror");
    await put(mirrorDir, "skills/eli5/SKILL.md", "x\n");
    await put(mirrorDir, "skills/other/SKILL.md", "y\n");

    assert.equal(await resolveSkillDir(mirrorDir, "skills/eli5"), join(mirrorDir, "skills/eli5"));
    await assert.rejects(resolveSkillDir(mirrorDir, "skills/missing"), /matched nothing/);
    await assert.rejects(resolveSkillDir(mirrorDir, "skills/*"), /matched multiple/);
  });
});

describe("copySkillTree", () => {
  it("copies names verbatim, skips .git, and keeps existing files", async () => {
    const sourceDir = join(root, "mirror");
    const targetDir = join(root, "destination");
    await put(sourceDir, "dot_special/file.txt", "verbatim\n");
    await put(sourceDir, ".git/HEAD", "ref\n");
    await put(sourceDir, "plain.txt", "new\n");
    await put(targetDir, "plain.txt", "existing\n");

    await copySkillTree(sourceDir, targetDir);

    assert.equal(
      await readFile(join(targetDir, "dot_special/file.txt"), "utf8"),
      "verbatim\n",
    );
    assert.equal(existsSync(join(targetDir, ".git")), false);
    assert.equal(existsSync(join(targetDir, "literal_dot_special")), false);
    assert.equal(await readFile(join(targetDir, "plain.txt"), "utf8"), "existing\n");
  });
});

describe("copyRepoEntries", () => {
  it("copies glob and literal entries into the destination", async () => {
    const mirrorDir = join(root, "mirror");
    const destinationDir = join(root, "destination");
    await put(mirrorDir, "skills/hi/greeting/SKILL.md", "hi\n");
    await put(mirrorDir, "skills/lo/farewell/SKILL.md", "bye\n");

    await copyRepoEntries(mirrorDir, destinationDir, ["skills/*/greeting", "skills/lo/farewell"], []);

    assert.equal(await readFile(join(destinationDir, "greeting/SKILL.md"), "utf8"), "hi\n");
    assert.equal(await readFile(join(destinationDir, "farewell/SKILL.md"), "utf8"), "bye\n");
  });

  it("applies $append edits to the staged tree before copying", async () => {
    const mirrorDir = join(root, "mirror");
    const destinationDir = join(root, "destination");
    await put(mirrorDir, "skills/hi/greeting/SKILL.md", "base\n");

    await copyRepoEntries(mirrorDir, destinationDir, ["skills/hi/greeting"], [
      { path: "skills/hi/greeting/SKILL.md", text: "extra" },
    ]);

    assert.equal(
      await readFile(join(destinationDir, "greeting/SKILL.md"), "utf8"),
      "base\nextra",
    );
  });

  it("rejects an edit path outside of the entries", async () => {
    const mirrorDir = join(root, "mirror");
    const destinationDir = join(root, "destination");
    await put(mirrorDir, "skills/hi/greeting/SKILL.md", "base\n");
    await put(mirrorDir, "skills/other/SKILL.md", "other\n");

    await assert.rejects(
      copyRepoEntries(mirrorDir, destinationDir, ["skills/hi/greeting"], [
        { path: "skills/other/SKILL.md", text: "extra" },
      ]),
      /edit path is not included in entries/,
    );
  });

  it("appends the edit text to the mirrored file", async () => {
    const mirrorDir = join(root, "mirror");
    const destinationDir = join(root, "destination");
    await put(mirrorDir, "skills/hi/greeting/SKILL.md", "base\n");
    await put(mirrorDir, "skills/hi/greeting/EXTRA.md", "tail");

    await copyRepoEntries(mirrorDir, destinationDir, ["skills/hi/greeting"], [
      { path: "skills/hi/greeting/EXTRA.md", text: "appended" },
    ]);

    assert.equal(
      await readFile(join(destinationDir, "greeting/EXTRA.md"), "utf8"),
      "tail\nappended",
    );
  });
});

describe("fetchExternals", () => {
  it("syncs the mirror, materializes entries, and runs run_after only on changes", async () => {
    const originPath = join(root, "origin", "test", "repo");
    const gitInOrigin = await initRepo(originPath, "skills/hi/greeting/SKILL.md", "hello\n");
    const configPath = join(root, ".build-external.yaml");
    await put(root, ".build-external.yaml", `
externalSkills:
  test/repo:
    destination: .agents/skills.exact
    entries:
      - skills/*/greeting
    ttlHours: 1
    run_after:
      - [touch, after.txt]
`);
    const distDir = join(root, "dist");
    await mkdir(distDir, { recursive: true });
    const commands: Array<{ args: string[]; cwd: string }> = [];
    const context = testContext(originPath, {
      runCommand: async (args, cwd) => {
        commands.push({ args, cwd });
        return { ok: true, stdout: "", stderr: "" };
      },
    });

    await fetchExternals(configPath, distDir, context);

    assert.equal(
      await readFile(join(distDir, ".agents/skills.exact/greeting/SKILL.md"), "utf8"),
      "hello\n",
    );
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0]!.args, ["touch", "after.txt"]);
    assert.equal(commands[0]!.cwd, join(root, "mirrors", "github.com", "test", "repo"));
    assert.equal(existsSync(join(distDir, ".agents/skills.exact/greeting/SKILL.md")), true);

    // Within the TTL the mirror is unchanged, so run_after does not run again.
    await fetchExternals(configPath, distDir, context);
    assert.equal(commands.length, 1);
  });
});
