import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { parse } from "shell-quote";
import {
  applyWorkspaceChanges,
  detectWorkspaceChanges,
  findWorktreeScopes,
  loadWorktreeSnapshot,
  normalizeWorkspacePath,
  retainLiveWorkspaces,
  type WorktreeSnapshot,
} from "./worktrees.ts";

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);

function fixture() {
  mkdirSync("/tmp/work/dotfiles/session-metadata-custom-qa", { recursive: true });
  const directory = mkdtempSync("/tmp/work/dotfiles/session-metadata-custom-qa/worktrees-");
  directories.push(directory);
  const root = join(directory, "main repo");
  const linked = join(directory, "linked\nworktree");
  const identity = join(root, ".git/worktrees/linked");
  mkdirSync(identity, { recursive: true });
  mkdirSync(linked);
  writeFileSync(join(linked, ".git"), `gitdir: ${identity}\n`);
  const output = `worktree ${root}\0HEAD abc\0branch refs/heads/main\0\0worktree ${linked}\0HEAD abc\0detached\0\0`;
  return { directory, root, linked, identity, output };
}

describe("worktree command scopes", () => {
  it("finds ordinary git mutations but not mentions in echo or scripts", () => {
    const scopes = findWorktreeScopes(
      'echo "git worktree add /x"; ./script.sh; git worktree add /x',
      "/repo",
    );
    assert.deepEqual(scopes, [{ cwd: "/repo", actions: ["add"], paths: ["/x"] }]);
  });

  it("resolves git -C and cd paths including quotes and multiple mutations", () => {
    const command =
      'cd "main repo" && git -c core.autocrlf=false -C sub -C .. worktree add /a; git -C. worktree move /a /b; git worktree remove /b';
    const scopes = findWorktreeScopes(command, "/repo");
    assert.deepEqual(scopes, [
      {
        cwd: "/repo/main repo",
        actions: ["add", "move", "remove"],
        paths: ["/a", "/a", "/b", "/b"],
      },
    ]);
  });

  it("keeps Bash reference characters literal in cd, git -C and mutation paths", () => {
    const scopes = findWorktreeScopes(
      "cd '@repo' && git -C '~/nested' worktree add --detach '@feature' HEAD",
      "/repo",
    );
    assert.deepEqual(scopes, [
      {
        cwd: "/repo/@repo/~/nested",
        actions: ["add"],
        paths: ["/repo/@repo/~/nested/@feature"],
      },
    ]);
  });

  it("expands only an unquoted Bash home prefix", () => {
    const scopes = findWorktreeScopes(
      "git worktree add --detach ~/feature HEAD; git worktree add --detach '~/quoted' HEAD; git worktree add --detach \\~/escaped HEAD",
      "/repo",
    );
    assert.deepEqual(scopes, [
      {
        cwd: "/repo",
        actions: ["add"],
        paths: [join(homedir(), "feature"), "/repo/~/quoted", "/repo/~/escaped"],
      },
    ]);
  });

  it("keeps home expansion independent of quotes in shell comments", () => {
    const scopes = findWorktreeScopes(
      "# don't expand '~/comment'\ngit worktree add --detach ~/feature HEAD",
      "/repo",
    );
    assert.deepEqual(scopes, [
      { cwd: "/repo", actions: ["add"], paths: [join(homedir(), "feature")] },
    ]);
  });

  it("does not mistake option values and start points for worktree paths", () => {
    const scopes = findWorktreeScopes(
      "git worktree add --lock --reason reason -b branch ../target HEAD",
      "/repo",
    );
    assert.deepEqual(scopes, [{ cwd: "/repo", actions: ["add"], paths: ["/target"] }]);
  });

  it("recognizes newline-separated commands and RTK pass-through wrappers", () => {
    const command =
      "rtk git -C /one worktree add /a\nrtk proxy git -C /two worktree remove /b\ncommand git worktree move /a /b";
    assert.deepEqual(findWorktreeScopes(command, "/repo"), [
      { cwd: "/one", actions: ["add"], paths: ["/a"] },
      { cwd: "/two", actions: ["remove"], paths: ["/b"] },
      { cwd: "/repo", actions: ["move"], paths: ["/a", "/b"] },
    ]);
  });

  it("does not treat worktree list as a mutation or reinterpret an explicit git command string", () => {
    assert.deepEqual(
      findWorktreeScopes('git worktree list; echo "git worktree remove /x"', "/repo"),
      [],
    );
  });

  it("skips quoted empty git -C operands instead of throwing", () => {
    assert.deepEqual(findWorktreeScopes('git -C "$d" status', "/repo"), []);
    assert.deepEqual(findWorktreeScopes('git -C "$d" worktree add /a', "/repo"), []);
    assert.deepEqual(findWorktreeScopes('git -C "" worktree add /a', "/repo"), []);
  });

  it("scans loop commands over quoted variables without throwing", () => {
    const command =
      'for d in ~/mirrors/github.com/*/*/; do [ -d "$d/.git" ] || continue; n=$(git -C "$d" status --porcelain 2>/dev/null | wc -l); [ "$n" -gt 0 ] && echo "$n $d"; done; echo "scan done"';
    assert.deepEqual(findWorktreeScopes(command, "/repo"), []);
  });

  it("ignores empty worktree mutation paths instead of throwing", () => {
    assert.deepEqual(findWorktreeScopes('git worktree add ""', "/repo"), []);
    assert.deepEqual(findWorktreeScopes('git worktree move "" /b', "/repo"), [
      { cwd: "/repo", actions: ["move"], paths: ["/b"] },
    ]);
  });
});

describe("Git snapshot changes", () => {
  const before: WorktreeSnapshot = {
    cwd: "/repo",
    worktrees: [
      { path: "/repo", identity: "/repo/.git" },
      { path: "/a", identity: "/repo/.git/worktrees/a" },
    ],
  };

  it("finds additions from the observed list rather than an exit code", () => {
    const after = {
      ...before,
      worktrees: [...before.worktrees, { path: "/b", identity: "/repo/.git/worktrees/b" }],
    };
    assert.deepEqual(detectWorkspaceChanges(before, after, ["add"], ["/b"]), {
      added: ["/b"],
      moved: [],
      removed: [],
    });
  });

  it("matches moves by stable Git identity even for detached worktrees", () => {
    const after = {
      ...before,
      worktrees: [before.worktrees[0]!, { path: "/b", identity: "/repo/.git/worktrees/a" }],
    };
    assert.deepEqual(detectWorkspaceChanges(before, after, ["move"], ["/a", "/b"]), {
      added: [],
      moved: [{ from: "/a", to: "/b" }],
      removed: [],
    });
  });

  it("ignores a concurrent addition that was not a command target", () => {
    const after = {
      ...before,
      worktrees: [
        ...before.worktrees,
        { path: "/foreign", identity: "/repo/.git/worktrees/foreign" },
      ],
    };
    assert.deepEqual(detectWorkspaceChanges(before, after, ["add"], ["/requested"]), {
      added: [],
      moved: [],
      removed: [],
    });
  });

  it("does not invent a change for a failed or cancelled mutation", () => {
    assert.deepEqual(
      detectWorkspaceChanges(before, before, ["add", "move", "remove"], ["/a", "/b"]),
      { added: [], moved: [], removed: [] },
    );
  });

  it("replaces associations in order and does not register unrelated existing worktrees", () => {
    const current = ["/other", "/a"];
    const changes = { added: ["/c", "/c"], moved: [{ from: "/a", to: "/b" }], removed: [] };
    assert.deepEqual(applyWorkspaceChanges(current, changes), ["/other", "/b", "/c"]);
  });

  it("removes a disappeared worktree association", () => {
    const after = { ...before, worktrees: [before.worktrees[0]!] };
    const changes = detectWorkspaceChanges(before, after, ["remove"], ["/a"]);
    assert.deepEqual(applyWorkspaceChanges(["/a", "/other"], changes), ["/other"]);
  });
});

describe("Git worktree queries", () => {
  it("reads NUL-delimited paths including newlines through the supplied Bash runner", async () => {
    const input = fixture();
    const commands: string[] = [];
    const snapshot = await loadWorktreeSnapshot(input.root, async (command) => {
      commands.push(command);
      return input.output;
    });
    assert.deepEqual(parse(commands[0]!), [
      "git",
      "-C",
      input.root,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    assert.deepEqual(snapshot, {
      cwd: input.root,
      worktrees: [
        { path: input.root, identity: join(input.root, ".git") },
        { path: input.linked, identity: input.identity },
      ],
    });
  });

  it("excludes prunable paths and bare repositories from live worktrees", async () => {
    const input = fixture();
    const output = `worktree ${input.root}\0bare\0\0worktree ${input.directory}/missing\0HEAD abc\0prunable gitdir file points to non-existent location\0\0`;
    const snapshot = await loadWorktreeSnapshot(input.root, async () => output);
    assert.deepEqual(snapshot, { cwd: input.root, worktrees: [] });
  });

  it("rejects truncated or non-porcelain output", async () => {
    await assert.rejects(
      loadWorktreeSnapshot("/repo", async () => "worktree /repo\0HEAD abc"),
      /incomplete/,
    );
  });

  it("prunes missing worktrees and checks a surviving registration against Git", async () => {
    const input = fixture();
    const queries: string[] = [];
    const retained = await retainLiveWorkspaces(
      [input.linked, join(input.directory, "missing"), input.linked],
      async (command) => {
        queries.push(command);
        return input.output;
      },
    );
    assert.deepEqual(retained, [input.linked]);
    assert.equal(queries.length, 1);
  });

  it("does not keep a directory merely because it still exists", async () => {
    const input = fixture();
    const output = `worktree ${input.root}\0HEAD abc\0branch refs/heads/main\0\0`;
    assert.deepEqual(await retainLiveWorkspaces([input.linked], async () => output), []);
  });
});

describe("workspace paths", () => {
  it("normalizes references, relative paths and home paths", () => {
    assert.equal(normalizeWorkspacePath("@../feature", "/repo/main"), "/repo/feature");
    assert.equal(normalizeWorkspacePath("~/feature", "/repo"), join(homedir(), "feature"));
  });

  it("resolves a symlink to the worktree identity path", () => {
    const input = fixture();
    const link = join(input.directory, "alias");
    symlinkSync(input.linked, link);
    assert.equal(normalizeWorkspacePath(link, "/repo"), input.linked);
  });

  it("resolves existing symlink parents before a missing path suffix", () => {
    const input = fixture();
    const link = join(input.directory, "alias");
    symlinkSync(input.linked, link);
    assert.equal(
      normalizeWorkspacePath(join(link, "missing", "feature"), "/repo"),
      join(input.linked, "missing", "feature"),
    );
  });

  for (const form of ["absolute", "relative"]) {
    it(`resolves symlinks before dot-dot in ${form} form with a missing suffix`, () => {
      const input = fixture();
      const deep = join(input.linked, "deep");
      const alias = join(input.root, "alias");
      mkdirSync(deep);
      symlinkSync(deep, alias);
      const path = form === "absolute" ? `${alias}/../missing/feature` : "alias/../missing/feature";
      assert.equal(
        normalizeWorkspacePath(path, input.root),
        join(input.linked, "missing", "feature"),
      );
    });
  }

  it("rejects an empty or NUL-containing path", () => {
    assert.throws(() => normalizeWorkspacePath("", "/repo"), /Invalid/);
    assert.throws(() => normalizeWorkspacePath("a\0b", "/repo"), /Invalid/);
  });
});
