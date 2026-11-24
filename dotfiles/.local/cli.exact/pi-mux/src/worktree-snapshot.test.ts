import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "bun:test";
import {
  gitExecutable,
  nativePath,
  parseWorktreeRoots,
  type WorktreeSnapshotRequest,
} from "./worktree-snapshot";

const cli = fileURLToPath(new URL("./main.ts", import.meta.url));
const directories: string[] = [];
function gitEnvironment() {
  const directory = directories.at(-1);
  return {
    ...process.env,
    ...(directory ? { GIT_CONFIG_GLOBAL: join(directory, "gitconfig") } : {}),
    GIT_CONFIG_NOSYSTEM: "1",
  };
}
const emptyRequest = { shellDirectories: [], gitDirectories: [], paths: [] };

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const temp = join(tmpdir(), "work", "dotfiles");
  mkdirSync(temp, { recursive: true });
  const directory = realpathSync.native(mkdtempSync(join(temp, "worktree-snapshot-")));
  directories.push(directory);
  writeFileSync(join(directory, "gitconfig"), "");
  const root = join(directory, "main repo");
  git(directory, ["init", root]);
  git(root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  return { directory, root };
}

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, env: gitEnvironment(), stdio: "pipe" });
}

function run(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [cli, "worktree", "snapshot", ...args], {
    cwd,
    env: gitEnvironment(),
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result;
}

function readSnapshot(cwd: string, request: WorktreeSnapshotRequest) {
  const result = run(cwd, [JSON.stringify(request)]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\n$/);
  return JSON.parse(result.stdout);
}

describe("snapshot Git executable", () => {
  it("uses a fully qualified Windows PATH entry instead of a relative entry", () => {
    const checked: string[] = [];
    const expected = "C:\\Program Files\\Git\\cmd\\git.exe";
    const selected = gitExecutable(
      "win32",
      ';.;bin;C:bin;\\rooted;"C:\\Program Files\\Git\\cmd";D:\\Later',
      (candidate) => {
        checked.push(candidate);
        return candidate === expected;
      },
    );
    assert.equal(selected, expected);
    assert.deepEqual(checked, [expected]);
  });

  it("does not fall back when no fully qualified PATH directory supplies git.exe", () => {
    assert.throws(
      () => gitExecutable("win32", ";.;bin;C:;\\rooted", () => assert.fail("Unexpected lookup")),
      /git\.exe not found/,
    );
  });
});

describe("pi-mux worktree snapshot", () => {
  it("returns the main root and real worktrees in Git order, excluding stale roots", () => {
    const { directory, root } = fixture();
    const live = join(directory, process.platform === "win32" ? "live worktree" : "live\nworktree");
    const stale = join(directory, "stale worktree");
    git(root, ["worktree", "add", "--detach", live, "HEAD"]);
    git(root, ["worktree", "add", "--detach", stale, "HEAD"]);
    rmSync(stale, { recursive: true });

    const snapshot = readSnapshot(live, emptyRequest);
    assert.equal(snapshot.cwd, root);
    assert.deepEqual(
      snapshot.worktrees.map(({ path }: { path: string }) => path),
      [root, live],
    );
    assert.deepEqual(snapshot.paths, []);
  });

  it("keeps the identity stable across a move", () => {
    const { directory, root } = fixture();
    const source = join(directory, "source worktree");
    const destination = join(directory, "moved worktree");
    git(root, ["worktree", "add", "--detach", source, "HEAD"]);
    const before = readSnapshot(root, emptyRequest);
    git(root, ["worktree", "move", source, destination]);
    const after = readSnapshot(root, emptyRequest);
    assert.deepEqual(after.worktrees[1], {
      path: destination,
      identity: before.worktrees[1].identity,
    });
  });

  it("returns the bare main path without listing it as a live worktree", () => {
    const { directory } = fixture();
    const bare = join(directory, "bare repo");
    git(directory, ["init", "--bare", bare]);
    const snapshot = readSnapshot(bare, emptyRequest);
    assert.deepEqual(snapshot, { cwd: bare, worktrees: [], paths: [] });
  });

  it("resolves targets in input order without treating them as Git options", () => {
    const { directory, root } = fixture();
    const subdirectory = join(root, "sub dir");
    mkdirSync(subdirectory);
    const snapshot = readSnapshot(directory, {
      shellDirectories: ["main repo"],
      gitDirectories: ["sub dir", ".."],
      paths: ["--help", "sub dir/new target", "@name", "~/literal"],
    });
    assert.deepEqual(snapshot.paths, [
      join(root, "--help"),
      join(root, "sub dir", "new target"),
      join(root, "@name"),
      join(root, "~", "literal"),
    ]);
  });

  it("rejects malformed requests with a nonzero status and no stdout", () => {
    const cases = [
      [],
      ["{"],
      ["{}", "{}"],
      [JSON.stringify({ ...emptyRequest, shellDirectories: ["\0"] })],
      [JSON.stringify({ ...emptyRequest, gitDirectories: [""] })],
      [JSON.stringify({ ...emptyRequest, paths: [2] })],
      [JSON.stringify({ ...emptyRequest, extra: true })],
    ];
    for (const args of cases) {
      const { status, stdout, stderr } = run(dirname(cli), args);
      assert.notEqual(status, 0, JSON.stringify(args));
      assert.equal(stdout, "", JSON.stringify(args));
      assert.match(stderr, /^pi-mux:/, JSON.stringify(args));
    }
  });

  it("returns no snapshot for a missing directory, but reports the resolved operation targets", () => {
    const { directory, root } = fixture();
    const request = {
      ...emptyRequest,
      shellDirectories: ["../future worktree"],
      paths: ["../destination"],
    };
    const { status, stdout, stderr } = run(root, [JSON.stringify(request)]);
    assert.notEqual(status, 0);
    assert.equal(stdout, "");
    assert.match(stderr, /^pi-mux: Worktree directory unavailable: /);
    const diagnostic = JSON.parse(stderr.split("unavailable: ")[1]!);
    assert.deepEqual(diagnostic, {
      reason: "missing",
      directory: join(directory, "future worktree"),
      paths: [join(directory, "destination")],
    });
  });

  it("rejects a logical cd when the directory before dot-dot does not exist", () => {
    const { root } = fixture();
    const request = { ...emptyRequest, shellDirectories: ["missing/.."] };
    const { status, stdout, stderr } = run(root, [JSON.stringify(request)]);
    assert.notEqual(status, 0);
    assert.equal(stdout, "");
    assert.match(stderr, /Worktree directory unavailable/);
  });

  it("returns no stdout when the requested directory is not a Git repository", () => {
    const { directory } = fixture();
    const { status, stdout, stderr } = run(directory, [JSON.stringify(emptyRequest)]);
    assert.notEqual(status, 0);
    assert.equal(stdout, "");
    assert.match(stderr, /not-repository/);
  });

  it("rejects incomplete or malformed Git porcelain rather than providing a partial snapshot", () => {
    const path = join(tmpdir(), "worktree");
    const head = "0".repeat(40);
    const invalid = [
      "",
      "worktree relative\0HEAD " + head + "\0\0",
      "worktree " + path + "\0HEAD " + head + "\0",
      "worktree " + path + "\0HEAD malformed\0\0",
      "worktree " + path + "\0HEAD " + head + "\0HEAD " + head + "\0\0",
    ];
    for (const output of invalid)
      assert.throws(() => parseWorktreeRoots(output), /Invalid or incomplete Git worktree list/);
  });

  it("converts only Bash drive paths on Windows and preserves physical dot-dot operands", () => {
    assert.equal(nativePath("/c/work space/../repo", "win32"), "C:/work space/../repo");
    assert.equal(nativePath("/c/", "win32"), "C:/");
    assert.equal(nativePath("C:/work space", "win32"), "C:/work space");
    assert.equal(nativePath("sub dir/..", "win32"), "sub dir/..");
    assert.equal(nativePath("/c/work space", "linux"), "/c/work space");
  });

  it.skipIf(process.platform !== "win32")(
    "returns identical native paths for Git Bash, Windows and relative spellings",
    () => {
      const { directory, root } = fixture();
      const drive = root[0]!.toLowerCase();
      const slashRoot = root.replaceAll("\\", "/");
      const bashRoot = "/" + drive + slashRoot.slice(2);
      const target = "new worktree";
      const snapshot = readSnapshot(directory, {
        shellDirectories: [bashRoot],
        gitDirectories: [slashRoot],
        paths: [target, bashRoot + "/" + target, slashRoot + "/" + target],
      });
      assert.equal(snapshot.cwd, root);
      assert.deepEqual(snapshot.paths, [
        join(root, target),
        join(root, target),
        join(root, target),
      ]);
    },
  );
});
