import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, it } from "bun:test";
import {
  applyWorkspaceChanges,
  detectWorkspaceChanges,
  findWorktreeScopes,
  parseUnavailableDirectory,
  parseWorktreeSnapshot,
  WorktreeDirectoryUnavailable,
  retainLiveWorkspaces,
  type WorktreeSnapshot,
} from "./worktrees.ts";

const rootScope = { shellDirectories: [], gitDirectories: [] };
const home = process.env.HOME || homedir();

describe("worktree command scopes", () => {
  it("finds ordinary git mutations but not mentions in echo or scripts", () => {
    const scopes = findWorktreeScopes(
      'echo "git worktree add /x"; ./script.sh; git worktree add /x',
    );
    assert.deepEqual(scopes, [
      { ...rootScope, actions: ["add"], destinationIndexes: [0], paths: ["/x"] },
    ]);
  });

  it("preserves git -C and cd operands separately for multiple mutations", () => {
    const command =
      'cd "main repo" && git -c core.autocrlf=false -C sub -C .. worktree add /a; git -C. worktree move /a /b; git worktree remove /b';
    const scopes = findWorktreeScopes(command);
    assert.deepEqual(scopes, [
      {
        shellDirectories: ["main repo"],
        gitDirectories: ["sub", ".."],
        actions: ["add"],
        destinationIndexes: [0],
        paths: ["/a"],
      },
      {
        shellDirectories: ["main repo"],
        gitDirectories: ["."],
        actions: ["move"],
        destinationIndexes: [1],
        paths: ["/a", "/b"],
      },
      {
        shellDirectories: ["main repo"],
        gitDirectories: [],
        actions: ["remove"],
        destinationIndexes: [],
        paths: ["/b"],
      },
    ]);
  });

  it("passes Git Bash and Windows drive paths to pi-mux without host normalization", () => {
    const scopes = findWorktreeScopes(
      'cd "/c/work space" && git -C "C:/main repo" worktree move "sub dir" "C:/move here"',
    );
    assert.deepEqual(scopes, [
      {
        shellDirectories: ["/c/work space"],
        gitDirectories: ["C:/main repo"],
        actions: ["move"],
        destinationIndexes: [1],
        paths: ["sub dir", "C:/move here"],
      },
    ]);
  });

  it("keeps Bash reference characters literal in cd, git -C and mutation paths", () => {
    const scopes = findWorktreeScopes(
      "cd '@repo' && git -C '~/nested' worktree add --detach '@feature' HEAD",
    );
    assert.deepEqual(scopes, [
      {
        shellDirectories: ["@repo"],
        gitDirectories: ["~/nested"],
        actions: ["add"],
        destinationIndexes: [0],
        paths: ["@feature"],
      },
    ]);
  });

  it("expands only an unquoted Bash home prefix", () => {
    const scopes = findWorktreeScopes(
      "git worktree add --detach ~/feature HEAD; git worktree add --detach '~/quoted' HEAD; git worktree add --detach \\~/escaped HEAD",
    );
    assert.deepEqual(scopes, [
      {
        ...rootScope,
        actions: ["add"],
        destinationIndexes: [0, 1, 2],
        paths: [home + "/feature", "~/quoted", "~/escaped"],
      },
    ]);
  });

  it("uses Git Bash HOME rather than USERPROFILE for cd and unquoted tilde", () => {
    const previousHome = process.env.HOME;
    const previousProfile = process.env.USERPROFILE;
    try {
      process.env.HOME = "C:/Bash Home";
      process.env.USERPROFILE = "C:/Windows Profile";
      const scopes = findWorktreeScopes(
        "cd && git worktree add ~/feature && git worktree add '~/quoted' && git worktree add \\~/escaped",
      );
      assert.deepEqual(scopes, [
        {
          ...rootScope,
          shellDirectories: ["C:/Bash Home"],
          actions: ["add"],
          paths: ["C:/Bash Home/feature", "~/quoted", "~/escaped"],
          destinationIndexes: [0, 1, 2],
        },
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
    }
  });

  it("keeps home expansion independent of quotes in shell comments", () => {
    const scopes = findWorktreeScopes(
      "# don't expand '~/comment'\ngit worktree add --detach ~/feature HEAD",
    );
    assert.deepEqual(scopes, [
      { ...rootScope, actions: ["add"], destinationIndexes: [0], paths: [home + "/feature"] },
    ]);
  });

  it("does not mistake option values and start points for worktree paths", () => {
    const scopes = findWorktreeScopes(
      "git worktree add --lock --reason reason -b branch ../target HEAD",
    );
    assert.deepEqual(scopes, [
      { ...rootScope, actions: ["add"], destinationIndexes: [0], paths: ["../target"] },
    ]);
  });

  it("recognizes newline-separated commands and RTK pass-through wrappers", () => {
    const command =
      "rtk git -C /one worktree add /a\nrtk proxy git -C /two worktree remove /b\ncommand git worktree move /a /b";
    assert.deepEqual(findWorktreeScopes(command), [
      {
        ...rootScope,
        gitDirectories: ["/one"],
        actions: ["add"],
        destinationIndexes: [0],
        paths: ["/a"],
      },
      {
        ...rootScope,
        gitDirectories: ["/two"],
        actions: ["remove"],
        destinationIndexes: [],
        paths: ["/b"],
      },
      { ...rootScope, actions: ["move"], destinationIndexes: [1], paths: ["/a", "/b"] },
    ]);
  });

  it("does not treat worktree list as a mutation or reinterpret an explicit git command string", () => {
    assert.deepEqual(findWorktreeScopes('git worktree list; echo "git worktree remove /x"'), []);
  });

  it("skips quoted empty git -C operands instead of throwing", () => {
    assert.deepEqual(findWorktreeScopes('git -C "$d" status'), []);
    assert.deepEqual(findWorktreeScopes('git -C "$d" worktree add /a'), []);
    assert.deepEqual(findWorktreeScopes('git -C "" worktree add /a'), []);
  });

  it("scans loop commands over quoted variables without throwing", () => {
    const command =
      'for d in ~/mirrors/github.com/*/*/; do [ -d "$d/.git" ] || continue; n=$(git -C "$d" status --porcelain 2>/dev/null | wc -l); [ "$n" -gt 0 ] && echo "$n $d"; done; echo "scan done"';
    assert.deepEqual(findWorktreeScopes(command), []);
  });

  it("ignores empty worktree mutation paths instead of throwing", () => {
    assert.deepEqual(findWorktreeScopes('git worktree add ""'), []);
    assert.deepEqual(findWorktreeScopes('git worktree move "" /b'), [
      { ...rootScope, actions: ["move"], destinationIndexes: [0], paths: ["/b"] },
    ]);
  });
});

describe("Git snapshot changes", () => {
  const before: WorktreeSnapshot = {
    cwd: "/repo",
    paths: [],
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

describe("pi-mux snapshot responses", () => {
  const snapshot = {
    cwd: "/repo",
    worktrees: [{ path: "/repo", identity: "/repo/.git" }],
    paths: ["/target"],
  };

  it("accepts a snapshot with absolute resolved paths and stable identities", () => {
    assert.deepEqual(parseWorktreeSnapshot(JSON.stringify(snapshot), 1), snapshot);
  });

  it("rejects malformed replies instead of applying partial changes", () => {
    const invalidSnapshots = [
      { ...snapshot, cwd: "relative" },
      { ...snapshot, worktrees: [{ path: "relative", identity: "/repo/.git" }] },
      { ...snapshot, worktrees: [{ path: "/repo", identity: "bad\0identity" }] },
      { ...snapshot, worktrees: [...snapshot.worktrees, ...snapshot.worktrees] },
      { ...snapshot, paths: [] },
      { ...snapshot, paths: ["/a\0b"] },
    ];
    for (const invalid of invalidSnapshots)
      assert.throws(
        () => parseWorktreeSnapshot(JSON.stringify(invalid), 1),
        /Invalid pi-mux worktree snapshot/,
      );
  });

  it("only interprets the fixed unavailable-directory diagnostic", () => {
    assert.equal(parseUnavailableDirectory("Git failed", 1), undefined);
    const prefix = "pi-mux: Worktree directory unavailable: ";
    assert.throws(
      () =>
        parseUnavailableDirectory(
          prefix + JSON.stringify({ reason: "missing", directory: "/absent", paths: [] }),
          1,
        ),
      /Invalid pi-mux worktree directory error/,
    );
    const missing = { reason: "missing", directory: "/absent", paths: ["/target"] };
    const error = parseUnavailableDirectory(prefix + JSON.stringify(missing) + "\n", 1);
    assert.ok(error instanceof WorktreeDirectoryUnavailable);
    assert.equal(error.directory, missing.directory);
    assert.deepEqual(error.paths, missing.paths);
  });
});

describe("live workspace checks", () => {
  it("checks other registrations with pi-mux and drops missing paths", async () => {
    const queries: string[] = [];
    const retained = await retainLiveWorkspaces(
      ["/linked", "/missing", "/linked"],
      async (request) => {
        const path = request.gitDirectories[0]!;
        queries.push(path);
        assert.deepEqual(request, { ...rootScope, gitDirectories: [path], paths: [path] });
        if (path === "/missing") throw new WorktreeDirectoryUnavailable("missing", path, [path]);
        return {
          cwd: "/repo",
          worktrees: [{ path: "/linked", identity: "/repo/.git/worktrees/linked" }],
          paths: [path],
        };
      },
    );
    assert.deepEqual(retained, ["/linked"]);
    assert.deepEqual(queries, ["/linked", "/missing"]);
  });

  it("does not retain a directory absent from the Git listing", async () => {
    const retained = await retainLiveWorkspaces(["/repo/subdir"], async () => ({
      cwd: "/repo",
      worktrees: [{ path: "/repo", identity: "/repo/.git" }],
      paths: ["/repo/subdir"],
    }));
    assert.deepEqual(retained, []);
  });

  it("propagates real query errors instead of pruning the registration", async () => {
    await assert.rejects(
      retainLiveWorkspaces(["/linked"], async () => {
        throw new Error("fixture failure");
      }),
      /fixture failure/,
    );
  });
});
