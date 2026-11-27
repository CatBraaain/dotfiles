import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseWorktreePorcelain,
  resolveMainRepository,
  worktreeFolderName,
} from "../../src/git-worktrees";
import { cleanup, tempDir } from "./fixtures";
import { wt } from "./folder-sync-fixtures";

// SPEC workspaceFolders 同期/worktree の検出: the worktree list is read
// from `git worktree list --porcelain`, so the parser must handle every
// entry kind real git emits (branch, detached, bare, locked, prunable).
const FIXTURE = [
  "worktree /repo",
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  "worktree /repo/worktrees/nested",
  "HEAD 2222222222222222222222222222222222222222",
  "branch refs/heads/feat/nested",
  "",
  "worktree /repo/det",
  "HEAD 3333333333333333333333333333333333333333",
  "detached",
  "",
  "worktree /repo.git",
  "bare",
  "",
  "worktree /repo/gone",
  "HEAD 4444444444444444444444444444444444444444",
  "branch refs/heads/gone",
  "prunable working tree is missing",
  "",
  "worktree /repo/locked",
  "HEAD 5555555555555555555555555555555555555555",
  "branch refs/heads/locked",
  "locked some reason",
].join("\n");

describe("parseWorktreePorcelain", () => {
  it("parses every entry kind, skipping bare repositories", () => {
    const entries = parseWorktreePorcelain(FIXTURE);
    expect(entries).toHaveLength(5);

    expect(entries[0]).toEqual({
      path: "/repo",
      head: "1111111111111111111111111111111111111111",
      branch: "main",
      prunable: false,
    });
    expect(entries[1]).toEqual({
      path: "/repo/worktrees/nested",
      head: "2222222222222222222222222222222222222222",
      branch: "feat/nested",
      prunable: false,
    });
    // No branch means detached; the "detached" marker itself is ignored.
    expect(entries[2]).toEqual({
      path: "/repo/det",
      head: "3333333333333333333333333333333333333333",
      branch: null,
      prunable: false,
    });
    // The prunable reason text is not part of the parsed entry.
    expect(entries[3]).toEqual({
      path: "/repo/gone",
      head: "4444444444444444444444444444444444444444",
      branch: "gone",
      prunable: true,
    });
    // The "locked" marker is ignored: a locked worktree stays a regular
    // (living) entry.
    expect(entries[4]).toEqual({
      path: "/repo/locked",
      head: "5555555555555555555555555555555555555555",
      branch: "locked",
      prunable: false,
    });
  });

  it("skips blocks without a worktree path or a HEAD line", () => {
    expect(
      parseWorktreePorcelain(
        ["worktree /no-head", "", "HEAD 1111111111111111111111111111111111111111"].join("\n"),
      ),
    ).toEqual([]);
  });

  it("parses CRLF output", () => {
    const entries = parseWorktreePorcelain(FIXTURE.replace(/\n/g, "\r\n"));
    expect(entries).toHaveLength(5);
    expect(entries[1].branch).toBe("feat/nested");
  });

  it("ignores a trailing newline and accepts empty input", () => {
    expect(parseWorktreePorcelain(`${FIXTURE}\n`)).toHaveLength(5);
    expect(parseWorktreePorcelain("")).toEqual([]);
  });
});

// SPEC worktree の検出: the folder label is the branch name, or
// `(detached <HEADの先頭7文字>)` for detached heads.
describe("worktreeFolderName", () => {
  it("uses the branch name", () => {
    expect(worktreeFolderName(wt("/repo/wt/x", { branch: "feat/nested" }))).toBe("feat/nested");
  });

  it("uses (detached <first 7 of HEAD>) without a branch", () => {
    expect(worktreeFolderName(wt("/repo/wt/x", { head: "abcdef1234567890" }))).toBe(
      "(detached abcdef1)",
    );
  });
});

// SPEC worktree の検出: a managed folder with a `.git` file whose
// `gitdir:` resolves the main repository's `.git` directory contributes
// that main repository as a detection candidate.
describe("resolveMainRepository", () => {
  let root: string;

  beforeEach(async () => {
    root = await tempDir("git-worktrees-test-");
  });

  afterEach(async () => {
    await cleanup(root);
  });

  async function writeGitFile(folder: string, content: string): Promise<string> {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, ".git"), content, "utf8");
    return folder;
  }

  it("resolves the main repository from an absolute gitdir", async () => {
    const worktree = await writeGitFile(
      join(root, "feat"),
      `gitdir: ${root}/main/.git/worktrees/feat\n`,
    );
    expect(await resolveMainRepository(worktree)).toBe(join(root, "main"));
  });

  it("resolves a relative gitdir against the worktree folder", async () => {
    const worktree = await writeGitFile(
      join(root, "main", "worktrees", "feat"),
      "gitdir: ../../.git/worktrees/feat\n",
    );
    expect(await resolveMainRepository(worktree)).toBe(join(root, "main"));
  });

  it("keeps resolving without a trailing newline", async () => {
    const worktree = await writeGitFile(
      join(root, "feat2"),
      `gitdir: ${root}/main/.git/worktrees/feat2`,
    );
    expect(await resolveMainRepository(worktree)).toBe(join(root, "main"));
  });

  it("returns undefined for a submodule-shaped gitdir", async () => {
    const worktree = await writeGitFile(join(root, "sub"), "gitdir: ../.git/modules/sub\n");
    expect(await resolveMainRepository(worktree)).toBeUndefined();
  });

  it("returns undefined without a .git file, with a .git directory, or with other content", async () => {
    expect(await resolveMainRepository(join(root, "missing"))).toBeUndefined();
    const repository = join(root, "main-repo", ".git");
    await mkdir(repository, { recursive: true });
    expect(await resolveMainRepository(join(root, "main-repo"))).toBeUndefined();
    const other = await writeGitFile(join(root, "other"), "something else\n");
    expect(await resolveMainRepository(other)).toBeUndefined();
  });
});
