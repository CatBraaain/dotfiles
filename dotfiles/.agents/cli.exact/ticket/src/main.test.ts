import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

// The CLI project dir (the source tree compiled by cli.build.ts; the same
// sources that run as the deployed `~/.agents/cli/ticket` executable).
const CLI_DIR = join(import.meta.dir, "..");
const homes: string[] = [];

async function ticketHome(): Promise<string> {
  const home = await mkdtemp("/tmp/ticket-cli-");
  homes.push(home);
  return home;
}

function runAt(home: string, cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  const command = process.env.TICKET_DISPATCH_BIN
    ? [process.env.TICKET_DISPATCH_BIN]
    : [process.execPath, CLI_DIR];
  const result = Bun.spawnSync([...command, ...args], {
    cwd,
    env: { ...process.env, HOME: home, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function run(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  return runAt(home, home, args, extraEnv);
}

function create(home: string, title: string, project = "demo"): string {
  const result = run(home, ["create", JSON.stringify({ title }), "--project", project, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  return (JSON.parse(result.stdout) as { id: string }).id;
}

function ticketPath(home: string, project: string, id: string): string {
  return join(home, ".agents", "tickets", project, `${id}.md`);
}

function createAfter(home: string, title: string, after: string, project = "demo"): string {
  const result = run(home, [
    "create",
    JSON.stringify({ title, after }),
    "--project",
    project,
    "--json",
  ]);
  assert.equal(result.code, 0, result.stderr);
  return (JSON.parse(result.stdout) as { id: string }).id;
}

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe("ticket list project selection", () => {
  it.each(["demo", "other project", "quote's project", "dotted.project"])(
    "uses either project flag for %j",
    async (project) => {
      const home = await ticketHome();
      const id = create(home, "selected", project);
      create(home, "wrong", basename(home));
      for (const args of [
        ["-p", project],
        ["--project", project],
      ]) {
        const result = run(home, ["list", "--json", ...args]);
        assert.equal(result.code, 0, result.stderr);
        const tickets = JSON.parse(result.stdout) as Array<{ id: string; title: string }>;
        assert.deepEqual(
          tickets.map((ticket) => ({ id: ticket.id, title: ticket.title })),
          [{ id, title: "selected" }],
        );
        assert.equal(result.stderr, "");
      }
    },
  );

  it.each([true, false])(
    "falls back to the cwd project outside Git (remove Git from PATH: %j)",
    async (hideGit) => {
      const home = await ticketHome();
      const id = create(home, "default", basename(home));
      create(home, "wrong");
      const result = run(home, ["list", "--json"], hideGit ? { PATH: home } : {});
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
      const tickets = JSON.parse(result.stdout) as Array<{ id: string }>;
      assert.deepEqual(
        tickets.map((ticket) => ticket.id),
        [id],
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "only uses Git output within the size limit",
    async () => {
      const home = await ticketHome();
      const gitProject = "git-project";
      const gitId = create(home, "from git", gitProject);
      const cwdId = create(home, "from cwd", basename(home));
      const git = join(home, "git");
      for (const [bytes, expected] of [
        [1_048_576, gitId],
        [1_048_577, cwdId],
      ] as const) {
        const program = [
          `#!${process.execPath}`,
          `const prefix = ${JSON.stringify("worktree /example/" + gitProject + "\n")};`,
          `process.stdout.write(prefix + " ".repeat(${bytes} - prefix.length));`,
          'process.stderr.write("diagnostic");',
        ].join("\n");
        await writeFile(git, program, { mode: 0o755 });
        const result = run(home, ["list", "--json"], { PATH: home });
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stderr, "");
        const tickets = JSON.parse(result.stdout) as Array<{ id: string }>;
        assert.deepEqual(
          tickets.map((ticket) => ticket.id),
          [expected],
        );
      }
    },
  );

  it("keeps status filtering and text output with a project flag", async () => {
    const home = await ticketHome();
    const id = create(home, "locked");
    create(home, "open");
    const locked = run(home, ["set", id, '{"status":"locked"}', "-p", "demo"]);
    assert.equal(locked.code, 0, locked.stderr);
    const result = run(home, ["list", "-p", "demo", "-s", "locked"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `${id}\tlocked\tlocked\n`);
  });

  it("keeps all-project listing regardless of the ignored project flag", async () => {
    const home = await ticketHome();
    const first = create(home, "one", "demo");
    const second = create(home, "two", "other");
    for (const args of [[], ["-p", "missing"], ["--project", "missing"], ["-p", "../ignored"]]) {
      const result = run(home, ["list", "-a", "--json", ...args]);
      assert.equal(result.code, 0, result.stderr);
      const checked = run(home, ["check", "-a", "--json", ...args]);
      assert.equal(checked.code, 0, checked.stderr);
      assert.deepEqual(JSON.parse(checked.stdout), []);
      const tickets = JSON.parse(result.stdout) as Array<{ id: string; project: string }>;
      assert.deepEqual(
        tickets.map((ticket) => ({ id: ticket.id, project: ticket.project })),
        [
          { id: first, project: "demo" },
          { id: second, project: "other" },
        ],
      );
    }
  });

  it.each(["", ".", "..", "../outside", "/tmp/demo", "nested/demo", "nested\\demo"])(
    "rejects invalid project flag value %j",
    async (project) => {
      const home = await ticketHome();
      const result = run(home, ["list", "-p", project]);
      assert.equal(result.code, 1);
      assert.equal(result.stderr, `invalid project: ${project}\n`);
      assert.equal(result.stdout, "");
    },
  );

  it.each([
    { args: ["demo"] },
    { args: ["--", "demo"] },
    { args: ["demo", "other"] },
    { args: ["demo", "-p", "demo"] },
    { args: ["demo", "--project", "other"] },
    { args: ["-p", "demo", "demo"] },
    { args: ["--project", "demo", "other"] },
    { args: ["demo", "-p", "demo", "-a"] },
  ])("rejects positional project arguments %j", async ({ args }) => {
    const home = await ticketHome();
    const result = run(home, ["list", ...args]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^usage: ticket list \[-s/);
    assert.equal(result.stdout, "");
  });

  it("returns code 1 for a missing named store", async () => {
    const home = await ticketHome();
    const result = run(home, ["list", "-p", "missing"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^project not found:/);
    assert.equal(result.stdout, "");
  });
});

describe("ticket CLI", () => {
  it("rejects traversal projects without creating a store-external file", async () => {
    const home = await ticketHome();
    const result = run(home, ["create", '{"title":"outside"}', "--project", "../outside"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid project/);
    assert.equal(result.stdout, "");
  });

  it("creates distinct IDs for same-second requests", async () => {
    const home = await ticketHome();
    const first = create(home, "one");
    const second = create(home, "two");
    assert.notEqual(first, second);
    assert.match(await readFile(ticketPath(home, "demo", first), "utf8"), /# one/);
    assert.match(await readFile(ticketPath(home, "demo", second), "utf8"), /# two/);
  });

  for (const body of [undefined, "Details"]) {
    it(`preserves frontmatter spacing through set and edit ${body === undefined ? "without" : "with"} a body`, async () => {
      const home = await ticketHome();
      const created = run(home, [
        "create",
        JSON.stringify({ title: "Spacing", body }),
        "--project",
        "demo",
        "--json",
      ]);
      assert.equal(created.code, 0, created.stderr);
      const id = (JSON.parse(created.stdout) as { id: string }).id;
      const path = ticketPath(home, "demo", id);
      const expectedBody = body === undefined ? "# Spacing\n" : `# Spacing\n\n${body}\n`;
      assert.equal(await readFile(path, "utf8"), `---\nstatus: open\n---\n\n${expectedBody}`);

      const set = run(home, ["set", id, '{"status":"locked"}', "--project", "demo"]);
      assert.equal(set.code, 0, set.stderr);
      const expectedLocked = `---\nstatus: locked\n---\n\n${expectedBody}`;
      assert.equal(await readFile(path, "utf8"), expectedLocked);

      const edited = run(home, ["edit", id, "Spacing", "Renamed", "--project", "demo"]);
      assert.equal(edited.code, 0, edited.stderr);
      assert.equal(await readFile(path, "utf8"), expectedLocked.replace("Spacing", "Renamed"));
    });
  }

  it("normalizes a unique after prefix to the complete ID", async () => {
    const home = await ticketHome();
    const dependency = create(home, "dependency");
    const result = run(home, [
      "create",
      JSON.stringify({ title: "dependent", after: dependency.slice(0, -2) }),
      "--project",
      "demo",
      "--json",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal((JSON.parse(result.stdout) as { after: string }).after, dependency);
    const id = (JSON.parse(result.stdout) as { id: string }).id;
    assert.equal(
      await readFile(ticketPath(home, "demo", id), "utf8"),
      `---\nstatus: blocked\nafter: ${dependency}\n---\n\n# dependent\n`,
    );
  });

  it("releases every current blocked dependent when closing a ticket", async () => {
    const home = await ticketHome();
    const dependency = create(home, "dependency");
    const dependent = run(home, [
      "create",
      JSON.stringify({ title: "dependent", after: dependency }),
      "--project",
      "demo",
      "--json",
    ]);
    assert.equal(dependent.code, 0, dependent.stderr);
    const dependentId = (JSON.parse(dependent.stdout) as { id: string }).id;
    assert.equal(
      run(home, ["set", dependency, '{"status":"locked"}', "--project", "demo"]).code,
      0,
    );
    assert.equal(
      run(home, ["set", dependency, '{"status":"closed"}', "--project", "demo"]).code,
      0,
    );
    const reopened = run(home, ["show", dependentId, "--project", "demo", "--json"]);
    assert.equal((JSON.parse(reopened.stdout) as { status: string }).status, "open");
  });

  it("rejects duplicate frontmatter fields and leaves them unchanged", async () => {
    const home = await ticketHome();
    const id = create(home, "duplicate");
    const path = ticketPath(home, "demo", id);
    const duplicate = "---\nstatus: open\nstatus: locked\n---\n# duplicate\n";
    await writeFile(path, duplicate);
    const result = run(home, ["set", id, '{"status":"closed"}', "--project", "demo"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /duplicate status field/);
    assert.equal(await readFile(path, "utf8"), duplicate);
  });

  it("uses literal edit matching and preserves the file on a non-unique match", async () => {
    const home = await ticketHome();
    const id = create(home, "a.*\na.*");
    const path = ticketPath(home, "demo", id);
    const before = await readFile(path, "utf8");
    const result = run(home, ["edit", id, "a.*", "literal", "--project", "demo"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /appears 2 times/);
    assert.equal(await readFile(path, "utf8"), before);
  });

  it("rejects a flag used as another flag's missing value", async () => {
    const home = await ticketHome();
    const result = run(home, ["list", "--project", "--json"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^usage: ticket list/m);
  });

  it("does not treat a literal --json after -- as the output flag", async () => {
    const home = await ticketHome();
    const id = create(home, "literal");
    const path = ticketPath(home, "demo", id);
    const before = await readFile(path, "utf8");
    const result = run(home, ["edit", id, "--project", "demo", "--", "missing", "--json"]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /appears 0 times/);
    assert.equal(await readFile(path, "utf8"), before);
  });

  it("returns one JSON error object for JSON-mode validation failures", async () => {
    const home = await ticketHome();
    const result = run(home, ["create", '{"title":', "--project", "demo", "--json"]);
    assert.equal(result.code, 2);
    assert.equal(typeof (JSON.parse(result.stdout) as { error: string }).error, "string");
    assert.match(result.stderr, /^usage: ticket list/m);
  });

  it("keeps JSON-mode edit errors on one stderr line", async () => {
    const home = await ticketHome();
    const id = create(home, "a\na");
    const result = run(home, ["edit", id, "a", "b", "--project", "demo", "--json"]);
    const error = (JSON.parse(result.stdout) as { error: string }).error;
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trimEnd(), error);
    assert.equal(result.stderr.trimEnd().includes("\\n"), true);
    assert.match(error, /Current body:\\n/);
  });

  it("returns a controlled JSON error for an I/O failure", async () => {
    const home = await ticketHome();
    await mkdir(join(home, ".agents", "tickets"), { recursive: true });
    await writeFile(join(home, ".agents", "tickets", "broken"), "not a directory");
    const result = run(home, ["create", '{"title":"io"}', "--project", "broken", "--json"]);
    assert.equal(result.code, 1);
    assert.equal(typeof (JSON.parse(result.stdout) as { error: string }).error, "string");
    assert.match(result.stderr, /I\/O error/);
  });

  it("restores every file after a multi-file transaction failure", async () => {
    const home = await ticketHome();
    const dependency = create(home, "dependency");
    const dependentOne = createAfter(home, "dependent one", dependency);
    const dependentTwo = createAfter(home, "dependent two", dependency);
    assert.equal(
      run(home, ["set", dependency, '{"status":"locked"}', "--project", "demo"]).code,
      0,
    );
    const before = await Promise.all([
      readFile(ticketPath(home, "demo", dependency), "utf8"),
      readFile(ticketPath(home, "demo", dependentOne), "utf8"),
      readFile(ticketPath(home, "demo", dependentTwo), "utf8"),
    ]);
    const failed = run(home, ["set", dependency, '{"status":"closed"}', "--project", "demo"], {
      TICKET_TEST_FAIL_STEP: "rename:1",
    });
    assert.equal(failed.code, 1);
    assert.deepEqual(
      await Promise.all([
        readFile(ticketPath(home, "demo", dependency), "utf8"),
        readFile(ticketPath(home, "demo", dependentOne), "utf8"),
        readFile(ticketPath(home, "demo", dependentTwo), "utf8"),
      ]),
      before,
    );
    assert.equal(
      run(home, ["set", dependency, '{"status":"closed"}', "--project", "demo"]).code,
      0,
    );
    assert.equal(
      (
        JSON.parse(run(home, ["show", dependentOne, "--project", "demo", "--json"]).stdout) as {
          status: string;
        }
      ).status,
      "open",
    );
    assert.equal(
      (
        JSON.parse(run(home, ["show", dependentTwo, "--project", "demo", "--json"]).stdout) as {
          status: string;
        }
      ).status,
      "open",
    );
  });

  it("recovers a transaction when rollback itself fails before the next write", async () => {
    const home = await ticketHome();
    const dependency = create(home, "dependency");
    const dependent = createAfter(home, "dependent", dependency);
    assert.equal(
      run(home, ["set", dependency, '{"status":"locked"}', "--project", "demo"]).code,
      0,
    );
    const failed = run(home, ["set", dependency, '{"status":"closed"}', "--project", "demo"], {
      TICKET_TEST_FAIL_STEP: "rename:1,rollback:0",
    });
    assert.equal(failed.code, 1);
    assert.equal(
      (
        JSON.parse(run(home, ["show", dependency, "--project", "demo", "--json"]).stdout) as {
          status: string;
        }
      ).status,
      "closed",
    );
    assert.equal(
      run(home, ["set", dependency, '{"status":"closed"}', "--project", "demo"]).code,
      0,
    );
    assert.equal(
      (
        JSON.parse(run(home, ["show", dependent, "--project", "demo", "--json"]).stdout) as {
          status: string;
        }
      ).status,
      "open",
    );
  });

  it("uses the main worktree basename from a subworktree cwd", async () => {
    const home = await ticketHome();
    const repo = await mkdtemp("/tmp/ticket-repo-");
    const subParent = await mkdtemp("/tmp/ticket-sub-");
    homes.push(repo, subParent);
    const git = (args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "ticket-test",
          GIT_AUTHOR_EMAIL: "ticket-test@example.com",
          GIT_COMMITTER_NAME: "ticket-test",
          GIT_COMMITTER_EMAIL: "ticket-test@example.com",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr));
    };
    await writeFile(join(repo, "README"), "repo\n");
    git(["init", "-b", "main"]);
    git(["add", "README"]);
    git(["commit", "-m", "init"]);
    const subworktree = join(subParent, "worktree");
    git(["worktree", "add", "-b", "feature", subworktree]);
    const created = runAt(home, subworktree, ["create", '{"title":"from subworktree"}', "--json"]);
    assert.equal(created.code, 0, created.stderr);
    const id = (JSON.parse(created.stdout) as { id: string }).id;
    const project = basename(repo);
    assert.match(await readFile(ticketPath(home, project, id), "utf8"), /from subworktree/);
    const shown = runAt(home, subworktree, ["show", id, "--json"]);
    assert.equal((JSON.parse(shown.stdout) as { id: string }).id, id);
    const listed = runAt(home, subworktree, ["list", "--json"]);
    assert.equal(listed.code, 0, listed.stderr);
    const tickets = JSON.parse(listed.stdout) as Array<{ id: string }>;
    assert.deepEqual(
      tickets.map((ticket) => ticket.id),
      [id],
    );
  });

  it("uses the cwd project and lists locked tickets", async () => {
    const home = await ticketHome();
    const id = run(home, ["create", '{"title":"default"}', "--json"]).stdout.trim();
    const project = basename(home);
    const ticketId = (JSON.parse(id) as { id: string }).id;
    assert.ok((await readdir(join(home, ".agents", "tickets"))).includes(project));
    const locked = create(home, "locked");
    assert.equal(run(home, ["set", locked, '{"status":"locked"}', "--project", "demo"]).code, 0);
    const show = JSON.parse(
      run(home, ["show", locked, "--project", "demo", "--json"]).stdout,
    ) as Record<string, unknown>;
    const list = JSON.parse(
      run(home, ["list", "--status", "locked", "--project", "demo", "--json"]).stdout,
    ) as Array<Record<string, unknown>>;
    assert.equal(show.id, locked);
    assert.equal(list.find((ticket) => ticket.id === locked)?.id, locked);
    assert.equal(
      (JSON.parse(run(home, ["show", ticketId, "--json"]).stdout) as { id: string }).id,
      ticketId,
    );
  });

  it("resolves exact, unique-prefix, ambiguous, and next selectors", async () => {
    const home = await ticketHome();
    const first = create(home, "first");
    const second = create(home, "second");
    let divergence = 0;
    while (first[divergence] === second[divergence]) divergence++;
    const uniquePrefix = first.slice(0, divergence + 1);
    const ambiguousPrefix = first.slice(0, divergence);
    assert.equal(run(home, ["show", uniquePrefix, "--project", "demo", "--json"]).code, 0);
    const ambiguous = run(home, ["show", ambiguousPrefix, "--project", "demo"]);
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.stderr, /ambiguous id/);
    assert.equal(
      (JSON.parse(run(home, ["show", "--project", "demo", "--json"]).stdout) as { id: string }).id,
      first,
    );
  });

  it("rejects unknown create fields and null after values", async () => {
    const home = await ticketHome();
    for (const input of [
      { title: "unknown", unexpected: true },
      { title: "null-after", after: null },
    ]) {
      const result = run(home, ["create", JSON.stringify(input), "--project", "demo", "--json"]);
      assert.equal(result.code, 2);
      assert.equal(typeof (JSON.parse(result.stdout) as { error: string }).error, "string");
    }
    await assert.rejects(() => readdir(join(home, ".agents", "tickets", "demo")));
  });

  it("applies after linkage rules and rejects unavailable dependencies", async () => {
    const home = await ticketHome();
    const dependency = create(home, "dependency");
    const explicit = run(home, [
      "create",
      JSON.stringify({ title: "explicit", after: dependency, status: "open" }),
      "--project",
      "demo",
      "--json",
    ]);
    assert.equal((JSON.parse(explicit.stdout) as { status: string }).status, "open");
    const target = create(home, "target");
    const blocked = run(home, [
      "set",
      target,
      JSON.stringify({ after: dependency }),
      "--project",
      "demo",
      "--json",
    ]);
    assert.equal(
      (JSON.parse(blocked.stdout) as { status: string; after: string }).status,
      "blocked",
    );
    assert.equal((JSON.parse(blocked.stdout) as { after: string }).after, dependency);
    const reopened = run(home, ["set", target, '{"after":null}', "--project", "demo", "--json"]);
    assert.equal(
      (JSON.parse(reopened.stdout) as { status: string; after: string | null }).status,
      "open",
    );
    const closed = create(home, "closed");
    assert.equal(run(home, ["set", closed, '{"status":"closed"}', "--project", "demo"]).code, 0);
    const closedAfter = run(home, [
      "create",
      JSON.stringify({ title: "bad", after: closed }),
      "--project",
      "demo",
    ]);
    assert.equal(closedAfter.code, 1);
    const cancelled = create(home, "cancelled");
    assert.equal(
      run(home, ["set", cancelled, '{"status":"cancelled"}', "--project", "demo"]).code,
      0,
    );
    const cancelledAfter = run(home, [
      "create",
      JSON.stringify({ title: "bad", after: cancelled }),
      "--project",
      "demo",
    ]);
    assert.equal(cancelledAfter.code, 1);
  });

  it("rejects after cycles without changing the target", async () => {
    const home = await ticketHome();
    const first = create(home, "first");
    const second = create(home, "second");
    assert.equal(
      run(home, ["set", first, JSON.stringify({ after: second }), "--project", "demo"]).code,
      0,
    );
    const failed = run(home, [
      "set",
      second,
      JSON.stringify({ after: first }),
      "--project",
      "demo",
    ]);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /cycle/);
    assert.equal(
      (
        JSON.parse(run(home, ["show", second, "--project", "demo", "--json"]).stdout) as {
          status: string;
          after: string | null;
        }
      ).after,
      null,
    );
  });

  it("checks missing after, cycles, and duplicate frontmatter fields", async () => {
    const home = await ticketHome();
    const projectDir = join(home, ".agents", "tickets", "demo");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "missing.md"),
      "---\nstatus: open\nafter: absent\n---\n# missing\n",
    );
    await writeFile(
      join(projectDir, "cycle-a.md"),
      "---\nstatus: open\nafter: cycle-b\n---\n# a\n",
    );
    await writeFile(
      join(projectDir, "cycle-b.md"),
      "---\nstatus: open\nafter: cycle-a\n---\n# b\n",
    );
    await writeFile(
      join(projectDir, "duplicate-after.md"),
      "---\nstatus: open\nafter: a\nafter: b\n---\n# duplicate\n",
    );
    const result = run(home, ["check", "--project", "demo", "--json"]);
    assert.equal(result.code, 1);
    const kinds = new Set(
      (JSON.parse(result.stdout) as Array<{ kind: string }>).map((issue) => issue.kind),
    );
    assert.deepEqual([...kinds].sort(), ["after-cycle", "invalid-frontmatter", "missing-after"]);
    const cleanHome = await ticketHome();
    create(cleanHome, "clean");
    const clean = run(cleanHome, ["check", "--project", "demo"]);
    assert.equal(clean.code, 0);
    assert.equal(clean.stdout.trim(), "ok");
  });

  it.each(["$&", "$`", "$'", "$$", "first line\nsecond line\t  "])(
    "saves replacement text %j literally",
    async (replacement) => {
      const home = await ticketHome();
      const id = create(home, "before needle after");
      const result = run(home, ["edit", "--project", "demo", "--", id, "needle", replacement]);
      const expectedContent = `---\nstatus: open\n---\n\n# before ${replacement} after\n`;
      assert.equal(result.code, 0, result.stderr);
      assert.equal(await readFile(ticketPath(home, "demo", id), "utf8"), expectedContent);
    },
  );

  it("supports empty literal replacements", async () => {
    const home = await ticketHome();
    const id = create(home, "before replace after");
    const result = run(home, ["edit", id, "replace", "", "--project", "demo"]);
    const expectedContent = "---\nstatus: open\n---\n\n# before  after\n";
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(ticketPath(home, "demo", id), "utf8"), expectedContent);
  });

  it("rejects an empty old string without changing the ticket", async () => {
    const home = await ticketHome();
    const id = create(home, "unchanged");
    const path = ticketPath(home, "demo", id);
    const before = await readFile(path, "utf8");
    const result = run(home, ["edit", "--project", "demo", "--", id, "", "replacement"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^usage: ticket list/m);
    assert.equal(await readFile(path, "utf8"), before);
  });

  it("renders the spec text output for create, show, list, edit, and set", async () => {
    const home = await ticketHome();
    const created = run(home, ["create", '{"title":"First"}', "--project", "demo"]);
    assert.equal(created.code, 0, created.stderr);
    const id = created.stdout.match(/^created (\S+)/)?.[1]!;
    const path = ticketPath(home, "demo", id);
    assert.deepEqual(created.stdout, `created ${id}\nstatus: open\nafter: -\npath: ${path}\n`);

    const shown = run(home, ["show", id, "--project", "demo"]);
    assert.deepEqual(
      shown.stdout,
      `id: ${id}\nstatus: open\nafter: -\ntitle: First\n\nbody:\n\n# First\n`,
    );

    const listed = run(home, ["list", "--project", "demo"]);
    assert.deepEqual(listed.stdout, `${id}\topen\tFirst\n`);

    const edited = run(home, ["edit", id, "First", "Renamed", "--project", "demo"]);
    assert.equal(edited.code, 0, edited.stderr);
    assert.deepEqual(edited.stdout, `updated ${id}\nstatus: open\nafter: -\npath: ${path}\n`);

    const set = run(home, ["set", id, '{"status":"locked"}', "--project", "demo"]);
    assert.deepEqual(set.stdout, `updated ${id}\nstatus: locked\nafter: -\npath: ${path}\n`);
  });

  it("lists no tickets when the store is empty and prefixes the project with --all", async () => {
    const home = await ticketHome();
    await mkdir(join(home, ".agents", "tickets", "demo"), { recursive: true });
    assert.deepEqual(run(home, ["list", "--project", "demo"]).stdout, "no tickets\n");
    const id = create(home, "First");
    const all = run(home, ["list", "--all"]);
    assert.deepEqual(all.stdout, `demo\t${id}\topen\tFirst\n`);
  });
});

describe("ticket stats", () => {
  const statuses = ["draft", "open", "blocked", "locked", "closed", "cancelled"] as const;
  const statusCounts = {
    draft: 1,
    open: 2,
    blocked: 3,
    locked: 4,
    closed: 5,
    cancelled: 6,
  };

  async function addStatsFixtures(home: string) {
    const root = join(home, ".agents", "tickets");
    for (const [project, multiplier] of [
      ["zeta", 2],
      ["alpha", 1],
    ] as const) {
      const projectDir = join(root, project);
      await mkdir(projectDir, { recursive: true });
      for (const [statusIndex, status] of statuses.entries()) {
        for (let ticketIndex = 0; ticketIndex < statusCounts[status] * multiplier; ticketIndex++) {
          const id = `20260101-${String(statusIndex * 10 + ticketIndex).padStart(6, "0")}`;
          await writeFile(
            join(projectDir, `${id}.md`),
            `---\nstatus: ${status}\n---\n# ${project} ${status} ${ticketIndex}\n`,
          );
        }
      }
    }
    await mkdir(join(root, "empty"), { recursive: true });
  }

  it("counts every status in sorted project and status order, including empty projects", async () => {
    const home = await ticketHome();
    await addStatsFixtures(home);
    const result = run(home, ["stats"]);
    const expectedRows = [
      ["project", "draft", "open", "blocked", "locked", "closed", "cancelled"],
      ["alpha  ", "    1", "   2", "      3", "     4", "     5", "        6"],
      ["empty  ", "    0", "   0", "      0", "     0", "     0", "        0"],
      ["zeta   ", "    2", "   4", "      6", "     8", "    10", "       12"],
      ["───────", "─────", "────", "───────", "──────", "──────", "─────────"],
      ["total  ", "    3", "   6", "      9", "    12", "    15", "       18"],
    ].map((cells) => cells.join("  "));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `${expectedRows.join("\n")}\n`);
    assert.equal(result.stderr, "");
  });

  it.each([
    { project: "日本語プロジェクト", displayWidth: 18, columnWidth: 19 },
    { project: "日本語プロジェクト日本語", displayWidth: 24, columnWidth: 24 },
  ])(
    "aligns long ASCII and Japanese names by display width ($project)",
    async ({ project, displayWidth, columnWidth }) => {
      const home = await ticketHome();
      for (const name of ["a-long-project-name", "dotfiles", project]) {
        const dir = join(home, ".agents", "tickets", name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "20260101-000000.md"), "---\nstatus: open\n---\n# ticket\n");
      }
      const result = run(home, ["stats"]);
      const expectedRows = [
        [
          "project" + " ".repeat(columnWidth - 7),
          "draft",
          "open",
          "blocked",
          "locked",
          "closed",
          "cancelled",
        ],
        ...[
          "a-long-project-name" + " ".repeat(columnWidth - 19),
          "dotfiles" + " ".repeat(columnWidth - 8),
          project + " ".repeat(columnWidth - displayWidth),
        ].map((cell) => [cell, "    0", "   1", "      0", "     0", "     0", "        0"]),
        ["─".repeat(columnWidth), "─────", "────", "───────", "──────", "──────", "─────────"],
        [
          "total" + " ".repeat(columnWidth - 5),
          "    0",
          "   3",
          "      0",
          "     0",
          "     0",
          "        0",
        ],
      ].map((cells) => cells.join("  "));
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, `${expectedRows.join("\n")}\n`);
      assert.equal(result.stderr, "");
      const json = run(home, ["stats", "--json"]);
      assert.equal(json.code, 0, json.stderr);
      assert.deepEqual(
        JSON.parse(json.stdout),
        ["a-long-project-name", "dotfiles", project].map((name) => ({
          project: name,
          draft: 0,
          open: 1,
          blocked: 0,
          locked: 0,
          closed: 0,
          cancelled: 0,
        })),
      );
    },
  );

  it("widens a count column when its decimal digits exceed the heading", async () => {
    const home = await ticketHome();
    const dir = join(home, ".agents", "tickets", "large");
    await mkdir(dir, { recursive: true });
    for (let index = 0; index < 10_000; index++) {
      await writeFile(join(dir, `${index}.md`), "---\nstatus: open\n---\n# ticket\n");
    }
    const result = run(home, ["stats"]);
    const expectedRows = [
      ["project", "draft", " open", "blocked", "locked", "closed", "cancelled"],
      ["large  ", "    0", "10000", "      0", "     0", "     0", "        0"],
      ["───────", "─────", "─────", "───────", "──────", "──────", "─────────"],
      ["total  ", "    0", "10000", "      0", "     0", "     0", "        0"],
    ].map((cells) => cells.join("  "));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `${expectedRows.join("\n")}\n`);
    assert.equal(result.stderr, "");
  }, 30_000);

  it("returns all project counts as a status-ordered JSON array", async () => {
    const home = await ticketHome();
    await addStatsFixtures(home);
    const result = run(home, ["stats", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      { project: "alpha", ...statusCounts },
      {
        project: "empty",
        draft: 0,
        open: 0,
        blocked: 0,
        locked: 0,
        closed: 0,
        cancelled: 0,
      },
      {
        project: "zeta",
        draft: 2,
        open: 4,
        blocked: 6,
        locked: 8,
        closed: 10,
        cancelled: 12,
      },
    ]);
    assert.equal(result.stderr, "");
  });

  it("returns the empty result when the store root exists without projects", async () => {
    const home = await ticketHome();
    await mkdir(join(home, ".agents", "tickets"), { recursive: true });
    const text = run(home, ["stats"]);
    const json = run(home, ["stats", "--json"]);
    assert.equal(text.code, 0, text.stderr);
    assert.equal(text.stdout, "no tickets\n");
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), []);
  });

  it("fails without partial output when the store root is missing", async () => {
    const home = await ticketHome();
    const text = run(home, ["stats"]);
    const json = run(home, ["stats", "--json"]);
    assert.equal(text.code, 1);
    assert.equal(text.stdout, "");
    assert.notEqual(text.stderr, "");
    assert.equal(json.code, 1);
    assert.equal(typeof (JSON.parse(json.stdout) as { error: string }).error, "string");
    assert.equal(json.stderr.trimEnd(), (JSON.parse(json.stdout) as { error: string }).error);
  });

  it.each([
    { name: "invalid frontmatter", contents: "---\nstatus: open\nstatus: locked\n---\n# bad\n" },
    { name: "invalid status", contents: "---\nstatus: unknown\n---\n# bad\n" },
  ])("fails without partial output or file changes for $name", async ({ contents }) => {
    const home = await ticketHome();
    const projectDir = join(home, ".agents", "tickets", "demo");
    await mkdir(projectDir, { recursive: true });
    const validPath = join(projectDir, "20260101-000000.md");
    const invalidPath = join(projectDir, "20260101-000001.md");
    await writeFile(validPath, "---\nstatus: open\n---\n# valid\n");
    await writeFile(invalidPath, contents);
    const before = await Promise.all([readFile(validPath, "utf8"), readFile(invalidPath, "utf8")]);

    for (const args of [["stats"], ["stats", "--json"]]) {
      const result = run(home, args);
      assert.equal(result.code, 1);
      if (args.includes("--json")) {
        const error = (JSON.parse(result.stdout) as { error: string }).error;
        assert.equal(typeof error, "string");
        assert.equal(result.stderr.trimEnd(), error);
      } else {
        assert.equal(result.stdout, "");
        assert.notEqual(result.stderr, "");
      }
    }
    assert.deepEqual(
      await Promise.all([readFile(validPath, "utf8"), readFile(invalidPath, "utf8")]),
      before,
    );
  });

  it.each([
    { name: "position argument", args: ["stats", "demo"] },
    { name: "position argument after --", args: ["stats", "--", "demo"] },
    { name: "project flag", args: ["stats", "-p", "demo"] },
    { name: "long project flag", args: ["stats", "--project", "demo"] },
    { name: "all flag", args: ["stats", "-a"] },
    { name: "long all flag", args: ["stats", "--all"] },
    { name: "status flag", args: ["stats", "-s", "open"] },
    { name: "long status flag", args: ["stats", "--status", "open"] },
  ])("rejects the unsupported $name with usage status", async ({ args }) => {
    const home = await ticketHome();
    const result = run(home, [...args]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^usage: ticket list/m);
    assert.match(result.stderr, /^\s+ticket stats \[--json\]$/m);
    assert.equal(result.stdout, "");
  });
});
