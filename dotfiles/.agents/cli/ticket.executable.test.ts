import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const CLI = join(import.meta.dir, "ticket.executable");
const homes: string[] = [];

async function ticketHome(): Promise<string> {
  const home = await mkdtemp("/tmp/ticket-cli-");
  homes.push(home);
  return home;
}

function runAt(home: string, cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  const result = Bun.spawnSync([CLI, ...args], {
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
  const result = run(home, ["create", JSON.stringify({ title }), "--project", project]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
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

  it("normalizes a unique after prefix to the complete ID", async () => {
    const home = await ticketHome();
    const dependency = create(home, "dependency");
    const result = run(home, ["create", JSON.stringify({ title: "dependent", after: dependency.slice(0, -2) }), "--project", "demo", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal((JSON.parse(result.stdout) as { after: string }).after, dependency);
  });

  it("releases every current blocked dependent when closing a ticket", async () => {
    const home = await ticketHome();
    const dependency = create(home, "dependency");
    const dependent = run(home, ["create", JSON.stringify({ title: "dependent", after: dependency }), "--project", "demo", "--json"]);
    assert.equal(dependent.code, 0, dependent.stderr);
    const dependentId = (JSON.parse(dependent.stdout) as { id: string }).id;
    assert.equal(run(home, ["set", dependency, '{"status":"locked"}', "--project", "demo"]).code, 0);
    assert.equal(run(home, ["set", dependency, '{"status":"closed"}', "--project", "demo"]).code, 0);
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
    const result = run(home, ["edit", id, "--project", "demo", "--", "missing", "--json"]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /appears 0 times/);
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
    assert.equal(run(home, ["set", dependency, '{"status":"locked"}', "--project", "demo"]).code, 0);
    const before = await Promise.all([
      readFile(ticketPath(home, "demo", dependency), "utf8"),
      readFile(ticketPath(home, "demo", dependentOne), "utf8"),
      readFile(ticketPath(home, "demo", dependentTwo), "utf8"),
    ]);
    const failed = run(
      home,
      ["set", dependency, '{"status":"closed"}', "--project", "demo"],
      { TICKET_TEST_FAIL_STEP: "rename:1" },
    );
    assert.equal(failed.code, 1);
    assert.deepEqual(
      await Promise.all([
        readFile(ticketPath(home, "demo", dependency), "utf8"),
        readFile(ticketPath(home, "demo", dependentOne), "utf8"),
        readFile(ticketPath(home, "demo", dependentTwo), "utf8"),
      ]),
      before,
    );
    assert.equal(run(home, ["set", dependency, '{"status":"closed"}', "--project", "demo"]).code, 0);
    assert.equal((JSON.parse(run(home, ["show", dependentOne, "--project", "demo", "--json"]).stdout) as { status: string }).status, "open");
    assert.equal((JSON.parse(run(home, ["show", dependentTwo, "--project", "demo", "--json"]).stdout) as { status: string }).status, "open");
  });

  it("recovers a transaction when rollback itself fails before the next write", async () => {
    const home = await ticketHome();
    const dependency = create(home, "dependency");
    const dependent = createAfter(home, "dependent", dependency);
    assert.equal(run(home, ["set", dependency, '{"status":"locked"}', "--project", "demo"]).code, 0);
    const failed = run(
      home,
      ["set", dependency, '{"status":"closed"}', "--project", "demo"],
      { TICKET_TEST_FAIL_STEP: "rename:1,rollback:0" },
    );
    assert.equal(failed.code, 1);
    assert.equal((JSON.parse(run(home, ["show", dependency, "--project", "demo", "--json"]).stdout) as { status: string }).status, "closed");
    assert.equal(run(home, ["set", dependency, '{"status":"closed"}', "--project", "demo"]).code, 0);
    assert.equal((JSON.parse(run(home, ["show", dependent, "--project", "demo", "--json"]).stdout) as { status: string }).status, "open");
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
  });

  it("uses the cwd project and lists locked tickets", async () => {
    const home = await ticketHome();
    const id = run(home, ["create", '{"title":"default"}', "--json"]).stdout.trim();
    const project = basename(home);
    const ticketId = (JSON.parse(id) as { id: string }).id;
    assert.ok((await readdir(join(home, ".agents", "tickets"))).includes(project));
    const locked = create(home, "locked");
    assert.equal(run(home, ["set", locked, '{"status":"locked"}', "--project", "demo"]).code, 0);
    const show = JSON.parse(run(home, ["show", locked, "--project", "demo", "--json"]).stdout) as Record<string, unknown>;
    const list = JSON.parse(run(home, ["list", "--status", "locked", "--project", "demo", "--json"]).stdout) as Array<Record<string, unknown>>;
    assert.equal(show.id, locked);
    assert.equal(list.find((ticket) => ticket.id === locked)?.id, locked);
    assert.equal((JSON.parse(run(home, ["show", ticketId, "--json"]).stdout) as { id: string }).id, ticketId);
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
    assert.equal((JSON.parse(run(home, ["show", "--project", "demo", "--json"]).stdout) as { id: string }).id, first);
  });

  it("rejects unknown create fields and null after values", async () => {
    const home = await ticketHome();
    for (const input of [{ title: "unknown", unexpected: true }, { title: "null-after", after: null }]) {
      const result = run(home, ["create", JSON.stringify(input), "--project", "demo", "--json"]);
      assert.equal(result.code, 2);
      assert.equal(typeof (JSON.parse(result.stdout) as { error: string }).error, "string");
    }
    await assert.rejects(() => readdir(join(home, ".agents", "tickets", "demo")));
  });

  it("applies after linkage rules and rejects unavailable dependencies", async () => {
    const home = await ticketHome();
    const dependency = create(home, "dependency");
    const explicit = run(home, ["create", JSON.stringify({ title: "explicit", after: dependency, status: "open" }), "--project", "demo", "--json"]);
    assert.equal((JSON.parse(explicit.stdout) as { status: string }).status, "open");
    const target = create(home, "target");
    const blocked = run(home, ["set", target, JSON.stringify({ after: dependency }), "--project", "demo", "--json"]);
    assert.equal((JSON.parse(blocked.stdout) as { status: string; after: string }).status, "blocked");
    assert.equal((JSON.parse(blocked.stdout) as { after: string }).after, dependency);
    const reopened = run(home, ["set", target, '{"after":null}', "--project", "demo", "--json"]);
    assert.equal((JSON.parse(reopened.stdout) as { status: string; after: string | null }).status, "open");
    const closed = create(home, "closed");
    assert.equal(run(home, ["set", closed, '{"status":"closed"}', "--project", "demo"]).code, 0);
    const closedAfter = run(home, ["create", JSON.stringify({ title: "bad", after: closed }), "--project", "demo"]);
    assert.equal(closedAfter.code, 1);
    const cancelled = create(home, "cancelled");
    assert.equal(run(home, ["set", cancelled, '{"status":"cancelled"}', "--project", "demo"]).code, 0);
    const cancelledAfter = run(home, ["create", JSON.stringify({ title: "bad", after: cancelled }), "--project", "demo"]);
    assert.equal(cancelledAfter.code, 1);
  });

  it("rejects after cycles without changing the target", async () => {
    const home = await ticketHome();
    const first = create(home, "first");
    const second = create(home, "second");
    assert.equal(run(home, ["set", first, JSON.stringify({ after: second }), "--project", "demo"]).code, 0);
    const failed = run(home, ["set", second, JSON.stringify({ after: first }), "--project", "demo"]);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /cycle/);
    assert.equal((JSON.parse(run(home, ["show", second, "--project", "demo", "--json"]).stdout) as { status: string; after: string | null }).after, null);
  });

  it("checks missing after, cycles, and duplicate frontmatter fields", async () => {
    const home = await ticketHome();
    const projectDir = join(home, ".agents", "tickets", "demo");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "missing.md"), "---\nstatus: open\nafter: absent\n---\n# missing\n");
    await writeFile(join(projectDir, "cycle-a.md"), "---\nstatus: open\nafter: cycle-b\n---\n# a\n");
    await writeFile(join(projectDir, "cycle-b.md"), "---\nstatus: open\nafter: cycle-a\n---\n# b\n");
    await writeFile(join(projectDir, "duplicate-after.md"), "---\nstatus: open\nafter: a\nafter: b\n---\n# duplicate\n");
    const result = run(home, ["check", "--project", "demo", "--json"]);
    assert.equal(result.code, 1);
    const kinds = new Set((JSON.parse(result.stdout) as Array<{ kind: string }>).map((issue) => issue.kind));
    assert.deepEqual([...kinds].sort(), ["after-cycle", "invalid-frontmatter", "missing-after"]);
    const cleanHome = await ticketHome();
    create(cleanHome, "clean");
    const clean = run(cleanHome, ["check", "--project", "demo"]);
    assert.equal(clean.code, 0);
    assert.equal(clean.stdout.trim(), "ok");
  });

  it("supports empty literal replacements", async () => {
    const home = await ticketHome();
    const id = create(home, "replace");
    const result = run(home, ["edit", id, "replace", "", "--project", "demo"]);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(await readFile(ticketPath(home, "demo", id), "utf8"), /replace/);
  });
});
