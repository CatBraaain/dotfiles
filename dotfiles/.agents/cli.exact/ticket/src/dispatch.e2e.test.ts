import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { dispatcherName, sessionName, shQuote } from "./dispatch";

const TEMP_ROOT = "/tmp/work/dotfiles/remove-dispatch-artifacts";
const CLI = join(import.meta.dir, "main.ts");
const TIMEOUT_MS = 20_000;
const FIXED_PROMPT = readFileSync(join(import.meta.dir, "../dispatch-prompt.md"), "utf8");

function expectedPrompt(id: string): string {
  return FIXED_PROMPT.split("{{ TICKET_ID }}").join(id);
}

function isolatedTmux(socket: string, args: string[], env = process.env) {
  return spawnSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8",
    env,
    timeout: TIMEOUT_MS,
  });
}

function setup(project = "project", all = false) {
  mkdirSync(TEMP_ROOT, { recursive: true });
  const root = mkdtempSync(join(TEMP_ROOT, "ticket-dispatch-e2e-"));
  const home = join(root, "home");
  const cwd = join(root, project);
  const store = join(home, ".agents", "tickets", project);
  const bin = join(root, "stub-bin");
  const records = join(root, "records");
  const socket = join(root, "tmux.sock");
  for (const dir of [cwd, store, bin, records]) mkdirSync(dir, { recursive: true });
  const stub = join(root, "stub.ts");
  writeFileSync(
    stub,
    `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (!args[0].startsWith("ticket ")) throw new Error("ticket ID is missing");
const id = args[0].split(" に")[0].slice("ticket ".length);
const project = process.env.TICKET_DISPATCH_PROJECT;
const recordDir = ${all} ? join(${JSON.stringify(records)}, project) : ${JSON.stringify(records)};
mkdirSync(recordDir, { recursive: true });
appendFileSync(join(${JSON.stringify(records)}, "launches"), (${all} ? project + "/" : "") + id + "\\n");
writeFileSync(join(recordDir, id + ".pid"), String(process.pid));
writeFileSync(join(recordDir, id + ".json"), JSON.stringify({ args, cwd: process.cwd() }));
if (process.env.STUB_WAIT === "1" || process.env.STUB_HOLD_ID === id) await Bun.sleep(60000);
if (id !== "b") {
  const store = ${all} ? join(${JSON.stringify(home)}, ".agents", "tickets", project) : ${JSON.stringify(store)};
  const path = join(store, id + ".md");
  const status = id === "c" ? "cancelled" : "closed";
  writeFileSync(path, readFileSync(path, "utf8").replace("status: open", "status: " + status));
  await Bun.sleep(60000);
}
`,
  );
  writeFileSync(
    join(bin, "pi"),
    `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(stub)} "$@"\n`,
  );
  chmodSync(join(bin, "pi"), 0o755);
  const env = {
    ...process.env,
    HOME: home,
    SHELL: "/bin/sh",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TICKET_TEST_TMUX_SOCKET: socket,
    TICKET_TEST_TICK_MS: "50",
  };
  return { root, home, cwd, project, store, socket, records, env };
}

type Fixture = ReturnType<typeof setup>;

function writeTicket(store: string, id: string, status: string) {
  writeFileSync(join(store, `${id}.md`), `---\nstatus: ${status}\n---\n\n# ${id}\n`);
}

function startServer(fixture: Fixture, env = fixture.env) {
  const started = isolatedTmux(
    fixture.socket,
    ["-f", "/dev/null", "new-session", "-d", "-s", "handle_a_v1_extra", "-c", fixture.cwd, "sleep 60"],
    env,
  );
  assert.equal(started.status, 0, started.stderr);
  assert.equal(
    isolatedTmux(fixture.socket, ["set-option", "-g", "default-shell", "/bin/sh"]).status,
    0,
  );
}

function cli(fixture: Fixture, args: string[], cwd = fixture.cwd, env = fixture.env) {
  const command = process.env.TICKET_DISPATCH_BIN
    ? [process.env.TICKET_DISPATCH_BIN]
    : [process.execPath, CLI];
  return spawnSync(command[0]!, [...command.slice(1), ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 5000,
  });
}

async function waitFor(condition: () => boolean, description: string) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!condition() && Date.now() < deadline) await Bun.sleep(20);
  assert.ok(condition(), description);
}

async function waitFinished(fixture: Fixture) {
  await waitFor(
    () =>
      isolatedTmux(fixture.socket, ["has-session", "-t", `=${dispatcherName(fixture.project)}`])
        .status !== 0,
    "finished dispatcher session survived",
  );
}

describe("ticket dispatch real tmux", () => {
  it(
    "passes the fixed prompt as one pi argument without creating artifacts",
    async () => {
      const fixture = setup();
      const { root, cwd, store, socket, records } = fixture;
      try {
        writeTicket(store, "a.v1", "open");
        writeFileSync(join(cwd, "fix-prompt-template.txt"), "ticket=wrong-cwd-template");
        startServer(fixture);
        const start = cli(fixture, ["dispatch"]);
        assert.equal(start.status, 0, start.stderr);
        await waitFinished(fixture);
        const expected = expectedPrompt("a.v1");
        const recorded = JSON.parse(readFileSync(join(records, "a.v1.json"), "utf8"));
        assert.ok(expected.endsWith("\n"));
        assert.deepEqual(readdirSync(cwd), ["fix-prompt-template.txt"]);
        assert.deepEqual(recorded, { args: [expected], cwd });
        for (const [key, value] of Object.entries({
          TICKET_DISPATCH_PROJECT: "project",
          TICKET_DISPATCH_ROLE: "pi",
          TICKET_DISPATCH_ID: "a.v1",
        })) {
          const metadata = isolatedTmux(socket, ["show-environment", "-t", "=handle_a_v1", key]);
          assert.equal(metadata.status, 0, metadata.stderr);
          assert.equal(metadata.stdout, `${key}=${value}\n`);
        }
      } finally {
        isolatedTmux(socket, ["kill-server"]);
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS + 5000,
  );

  it.each([
    { action: [], flag: "-p", project: "project" },
    { action: ["start"], flag: "--project", project: "project" },
    { action: [], flag: "--project", project: "quoted 'project'" },
    { action: ["start"], flag: "-p", project: "quoted 'project'" },
    { action: [], flag: "-p", project: "start" },
    { action: [], flag: "--project", project: "stop" },
  ])(
    "uses the named store and HOME/projects cwd regardless of Git discovery (%j)",
    async ({ action, flag, project }) => {
      const fixture = setup(project);
      const { root, home, store, socket, records } = fixture;
      const caller = join(root, "caller");
      const projectsDir = join(home, "projects");
      const target = join(projectsDir, project);
      const env = { ...fixture.env, STUB_WAIT: "1" };
      try {
        mkdirSync(caller);
        mkdirSync(target, { recursive: true });
        const initialized = spawnSync("git", ["init", "-b", "main", projectsDir], {
          encoding: "utf8",
        });
        assert.equal(initialized.status, 0, initialized.stderr);
        const callerStore = join(fixture.home, ".agents", "tickets", "caller");
        mkdirSync(callerStore);
        writeTicket(callerStore, "wrong", "open");
        writeTicket(store, "a.v1", "open");
        startServer(fixture, env);
        const result = cli(
          fixture,
          ["dispatch", ...action, flag, project],
          caller,
          env,
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `dispatcher started: ${dispatcherName(project)}\n`);
        await waitFor(() => existsSync(join(records, "a.v1.json")), "target pi did not start");
        assert.equal(readFileSync(join(records, "launches"), "utf8"), "a.v1\n");
        assert.deepEqual(JSON.parse(readFileSync(join(records, "a.v1.json"), "utf8")), {
          args: [expectedPrompt("a.v1")],
          cwd: target,
        });
        const dispatcherCwd = isolatedTmux(socket, [
          "display-message",
          "-p",
          "-t",
          `=${dispatcherName(project)}:0.0`,
          "#{pane_current_path}",
        ]);
        assert.equal(dispatcherCwd.status, 0, dispatcherCwd.stderr);
        assert.equal(dispatcherCwd.stdout.trim(), target);
        assert.deepEqual(readdirSync(caller), []);
        assert.deepEqual(readdirSync(target), []);
        assert.match(cli(fixture, ["dispatch", "stop"], caller, env).stdout, /already stopped/);
        assert.equal(
          isolatedTmux(socket, ["has-session", "-t", `=${dispatcherName(project)}`]).status,
          0,
        );
        const stopped = cli(fixture, ["dispatch", "stop", flag, project], caller, env);
        assert.equal(stopped.status, 0, stopped.stderr);
        assert.equal(stopped.stdout, `dispatcher stopped: ${dispatcherName(project)}\n`);
        assert.notEqual(
          isolatedTmux(socket, ["has-session", "-t", `=${dispatcherName(project)}`]).status,
          0,
        );
        assert.equal(isolatedTmux(socket, ["has-session", "-t", "=handle_a_v1"]).status, 0);
      } finally {
        isolatedTmux(socket, ["kill-server"]);
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS + 5000,
  );

  it.each([
    { flag: "-p", filesystem: "missing" },
    { flag: "--project", filesystem: "malformed" },
  ])(
    "stops a named dispatcher independently of its store and target (%j)",
    ({ flag, filesystem }) => {
      const fixture = setup();
      const { root, home, store, socket } = fixture;
      const name = dispatcherName("project");
      try {
        startServer(fixture);
        const started = isolatedTmux(socket, [
          "new-session",
          "-d",
          "-s",
          name,
          "-e",
          "TICKET_DISPATCH_PROJECT=project",
          "-e",
          "TICKET_DISPATCH_ROLE=dispatcher",
          "sleep 60",
        ]);
        assert.equal(started.status, 0, started.stderr);
        rmSync(store, { recursive: true });
        assert.equal(existsSync(join(home, "projects")), false);
        if (filesystem === "malformed") {
          writeFileSync(store, "not a store");
          mkdirSync(join(home, "projects"));
          writeFileSync(join(home, "projects", "project"), "not a directory");
        }
        const stopped = cli(fixture, ["dispatch", "stop", flag, "project"], root);
        assert.equal(stopped.status, 0, stopped.stderr);
        assert.equal(stopped.stdout, `dispatcher stopped: ${name}\n`);
        assert.equal(stopped.stderr, "");
        assert.notEqual(isolatedTmux(socket, ["has-session", "-t", `=${name}`]).status, 0);
      } finally {
        isolatedTmux(socket, ["kill-server"]);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects --template and omits it from usage without starting a dispatcher", () => {
    const fixture = setup();
    const { root, socket, records } = fixture;
    try {
      startServer(fixture);
      const result = cli(fixture, ["dispatch", "--template", join(root, "external.txt")]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /unknown option: --template/);
      const usage = cli(fixture, ["dispatch", "one", "two"]);
      assert.equal(usage.status, 2);
      assert.doesNotMatch(usage.stderr, /--template/);
      assert.equal(
        isolatedTmux(socket, ["has-session", "-t", `=${dispatcherName("project")}`]).status,
        1,
      );
      assert.equal(existsSync(join(records, "launches")), false);
    } finally {
      isolatedTmux(socket, ["kill-server"]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "serializes simultaneous starts through the named tmux session",
    async () => {
      const fixture = setup();
      const { root, cwd, store, socket, records } = fixture;
      const env = { ...fixture.env, STUB_WAIT: "1" };
      try {
        writeTicket(store, "a.v1", "open");
        startServer(fixture, env);
        const command = process.env.TICKET_DISPATCH_BIN
          ? [process.env.TICKET_DISPATCH_BIN]
          : [process.execPath, CLI];
        const starts = [0, 1].map(() =>
          Bun.spawn([...command, "dispatch", "start"], {
            cwd,
            env,
            stdout: "pipe",
            stderr: "pipe",
          }),
        );
        const results = await Promise.all(
          starts.map(async (child) => ({
            code: await child.exited,
            stdout: await new Response(child.stdout).text(),
            stderr: await new Response(child.stderr).text(),
          })),
        );
        for (const result of results) assert.equal(result.code, 0, result.stderr);
        assert.equal(
          results.filter((result) => result.stdout.includes("dispatcher started:")).length,
          1,
        );
        assert.equal(
          results.filter((result) => result.stdout.includes("already running:")).length,
          1,
        );
        await waitFor(
          () => existsSync(join(records, "a.v1.json")),
          "concurrent start did not launch pi",
        );
        assert.equal(readFileSync(join(records, "launches"), "utf8"), "a.v1\n");
        assert.equal(cli(fixture, ["dispatch", "stop"]).status, 0);
        assert.equal(isolatedTmux(socket, ["has-session", "-t", "=handle_a_v1"]).status, 0);
      } finally {
        isolatedTmux(socket, ["kill-server"]);
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS + 5000,
  );
  it(
    "uses the cwd store and refills slots while completed stubs and exact-name neighbors keep running",
    async () => {
      const fixture = setup();
      const { root, cwd, store, socket, records } = fixture;
      try {
        for (const [id, status] of [
          ["done", "closed"],
          ["a.v1", "open"],
          ["b", "open"],
          ["c", "open"],
          ["d", "open"],
          ["draft", "draft"],
        ])
          writeTicket(store, id!, status!);
        startServer(fixture);
        const result = cli(fixture, ["dispatch", "--max", "2"]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.match(result.stdout, /dispatcher started:/);
        await waitFinished(fixture);
        assert.deepEqual(readdirSync(cwd), []);
        assert.deepEqual(
          readFileSync(join(records, "launches"), "utf8").trimEnd().split("\n").sort(),
          ["a.v1", "b", "c", "d"],
        );
        for (const id of ["a.v1", "b", "c", "d"]) {
          const expected = expectedPrompt(id);
          assert.deepEqual(JSON.parse(readFileSync(join(records, `${id}.json`), "utf8")), {
            args: [expected],
            cwd,
          });
          const name = `=handle_${id.replaceAll(".", "_")}`;
          const session = isolatedTmux(socket, ["has-session", "-t", name]);
          if (id === "b") {
            assert.notEqual(session.status, 0);
          } else {
            assert.equal(session.status, 0, session.stderr);
            assert.equal(
              isolatedTmux(socket, [
                "display-message",
                "-p",
                "-t",
                `${name}:0.0`,
                "#{pane_pid}",
              ]).stdout.trim(),
              readFileSync(join(records, `${id}.pid`), "utf8"),
            );
          }
        }
        assert.equal(isolatedTmux(socket, ["has-session", "-t", "=handle_a_v1_extra"]).status, 0);
      } finally {
        isolatedTmux(socket, ["kill-server"]);
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS + 5000,
  );

  it(
    "picks up dynamic additions and dependencies released by the real ticket set command",
    async () => {
      const fixture = setup();
      const { root, cwd, store, socket, records } = fixture;
      const env = { ...fixture.env, STUB_HOLD_ID: "a.v1" };
      try {
        writeTicket(store, "a.v1", "open");
        writeFileSync(join(store, "b.md"), "---\nstatus: blocked\nafter: a.v1\n---\n\n# b\n");
        startServer(fixture, env);
        const start = cli(
          fixture,
          ["dispatch", "start", "--max", "1"],
          cwd,
          env,
        );
        assert.equal(start.status, 0, start.stderr);
        await waitFor(() => existsSync(join(records, "a.v1.json")), "first pi did not start");
        assert.equal(existsSync(join(records, "b.json")), false);
        writeTicket(store, "c", "open");
        const closed = cli(fixture, ["set", "a.v1", '{"status":"closed"}']);
        assert.equal(closed.status, 0, closed.stderr);
        assert.match(readFileSync(join(store, "b.md"), "utf8"), /status: open/);
        await waitFinished(fixture);
        assert.deepEqual(readdirSync(cwd), []);
        assert.equal(readFileSync(join(records, "launches"), "utf8"), "a.v1\nb\nc\n");
        for (const id of ["a.v1", "b", "c"]) {
          assert.deepEqual(JSON.parse(readFileSync(join(records, `${id}.json`), "utf8")), {
            args: [expectedPrompt(id)],
            cwd,
          });
          const name = `=handle_${id.replaceAll(".", "_")}`;
          const session = isolatedTmux(socket, ["has-session", "-t", name]);
          if (id === "b") {
            assert.notEqual(session.status, 0);
          } else {
            assert.equal(session.status, 0, session.stderr);
            assert.equal(
              isolatedTmux(socket, [
                "display-message",
                "-p",
                "-t",
                `${name}:0.0`,
                "#{pane_pid}",
              ]).stdout.trim(),
              readFileSync(join(records, `${id}.pid`), "utf8"),
            );
          }
        }
      } finally {
        isolatedTmux(socket, ["kill-server"]);
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS + 5000,
  );

  it.each([
    { releasedStatus: "closed", explicitProject: false },
    { releasedStatus: "cancelled", explicitProject: false },
    { releasedStatus: "blocked", explicitProject: false },
    { releasedStatus: "draft", explicitProject: false },
    { releasedStatus: "closed", explicitProject: true },
  ])(
    "releases inherited tickets after restarting with changed options (%j)",
    async ({ releasedStatus, explicitProject }) => {
      const fixture = setup();
      const { root, cwd, store, socket, records } = fixture;
      const env = { ...fixture.env, STUB_WAIT: "1" };
      try {
        assert.equal(spawnSync("git", ["init", "-b", "main", cwd], { encoding: "utf8" }).status, 0);
        const otherCwd = join(root, "other-worktree");
        const added = spawnSync(
          "git",
          ["-C", cwd, "worktree", "add", "--orphan", "-b", "other", otherCwd],
          { encoding: "utf8" },
        );
        assert.equal(added.status, 0, added.stderr);
        writeTicket(store, "a.v1", "open");
        startServer(fixture, env);
        const first = cli(
          fixture,
          ["dispatch", "start", "--max", "2"],
          cwd,
          env,
        );
        assert.equal(first.status, 0, first.stderr);
        assert.match(first.stdout, /dispatcher started:/);
        await waitFor(() => existsSync(join(records, "a.v1.json")), "held pi did not start");
        assert.equal(
          isolatedTmux(socket, ["has-session", "-t", `=${dispatcherName("project")}`]).status,
          0,
        );
        const piPid = isolatedTmux(socket, [
          "display-message",
          "-p",
          "-t",
          "=handle_a_v1:0.0",
          "#{pane_pid}",
        ]).stdout;
        assert.match(piPid, /^\d+\n$/);
        const duplicate = cli(fixture, ["dispatch"], otherCwd, env);
        assert.equal(duplicate.status, 0, duplicate.stderr);
        assert.match(duplicate.stdout, /already running/);
        const stop = cli(fixture, ["dispatch", "stop"], otherCwd, env);
        assert.equal(stop.status, 0, stop.stderr);
        assert.match(stop.stdout, /dispatcher stopped:/);
        assert.equal(isolatedTmux(socket, ["has-session", "-t", "=handle_a_v1"]).status, 0);
        assert.notEqual(
          isolatedTmux(socket, ["has-session", "-t", `=${dispatcherName("project")}`]).status,
          0,
        );
        assert.match(cli(fixture, ["dispatch", "stop"], otherCwd, env).stdout, /already stopped/);
        writeTicket(store, "c", "open");
        const launchCwd = explicitProject ? join(fixture.home, "projects", "project") : otherCwd;
        if (explicitProject) mkdirSync(launchCwd, { recursive: true });
        const restart = cli(
          fixture,
          [
            "dispatch",
            "start",
            ...(explicitProject ? ["-p", "project"] : []),
            "--max",
            "1",
          ],
          otherCwd,
          env,
        );
        assert.equal(restart.status, 0, restart.stderr);
        assert.equal(readFileSync(join(records, "launches"), "utf8"), "a.v1\n");
        assert.equal(
          isolatedTmux(socket, ["display-message", "-p", "-t", "=handle_a_v1:0.0", "#{pane_pid}"])
            .stdout,
          piPid,
        );
        assert.equal(
          cli(fixture, ["set", "a.v1", JSON.stringify({ status: releasedStatus })]).status,
          0,
        );
        await waitFor(
          () => existsSync(join(records, "c.json")),
          "ticket did not start after adoption release",
        );
        assert.equal(isolatedTmux(socket, ["has-session", "-t", "=handle_c"]).status, 0);
        assert.deepEqual(JSON.parse(readFileSync(join(records, "c.json"), "utf8")), {
          args: [expectedPrompt("c")],
          cwd: launchCwd,
        });
        assert.deepEqual(JSON.parse(readFileSync(join(records, "a.v1.json"), "utf8")), {
          args: [expectedPrompt("a.v1")],
          cwd,
        });
        assert.equal(cli(fixture, ["set", "a.v1", '{"status":"open"}']).status, 0);
        assert.equal(cli(fixture, ["set", "c", '{"status":"closed"}']).status, 0);
        await waitFinished(fixture);
        assert.deepEqual(readdirSync(otherCwd), [".git"]);
        assert.equal(isolatedTmux(socket, ["has-session", "-t", "=handle_a_v1"]).status, 0);
        assert.equal(
          isolatedTmux(socket, ["display-message", "-p", "-t", "=handle_a_v1:0.0", "#{pane_pid}"])
            .stdout,
          piPid,
        );
        assert.equal(isolatedTmux(socket, ["has-session", "-t", "=handle_c"]).status, 0);
        assert.equal(
          isolatedTmux(socket, [
            "display-message",
            "-p",
            "-t",
            "=handle_c:0.0",
            "#{pane_pid}",
          ]).stdout.trim(),
          readFileSync(join(records, "c.pid"), "utf8"),
        );
        assert.equal(readFileSync(join(records, "launches"), "utf8"), "a.v1\nc\n");
      } finally {
        isolatedTmux(socket, ["kill-server"]);
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS + 5000,
  );

  it(
    "preserves foreign workers and unmanaged sessions on name collisions",
    async () => {
      const fixture = setup();
      const { root, store, socket, records } = fixture;
      try {
        writeTicket(store, "a.v1", "open");
        writeTicket(store, "b", "open");
        startServer(fixture);
        for (const [name, metadata] of [
          [
            "handle_a_v1",
            [
              "-e",
              "TICKET_DISPATCH_PROJECT=foreign",
              "-e",
              "TICKET_DISPATCH_ROLE=pi",
              "-e",
              "TICKET_DISPATCH_ID=a.v1",
            ],
          ],
          ["handle_b", []],
        ] as const) {
          const result = isolatedTmux(socket, [
            "new-session",
            "-d",
            "-s",
            name,
            ...metadata,
            "sleep 60",
          ]);
          assert.equal(result.status, 0, result.stderr);
        }
        const start = cli(fixture, ["dispatch"]);
        assert.equal(start.status, 0, start.stderr);
        await waitFinished(fixture);
        assert.equal(existsSync(join(records, "launches")), false);
        for (const name of ["handle_a_v1", "handle_b", "handle_a_v1_extra"])
          assert.equal(isolatedTmux(socket, ["has-session", "-t", `=${name}`]).status, 0);
        const conflictName = dispatcherName("project");
        assert.equal(
          isolatedTmux(socket, [
            "new-session",
            "-d",
            "-s",
            conflictName,
            "-e",
            "TICKET_DISPATCH_PROJECT=foreign",
            "-e",
            "TICKET_DISPATCH_ROLE=dispatcher",
            "sleep 60",
          ]).status,
          0,
        );
        const conflict = cli(fixture, ["dispatch"]);
        assert.equal(conflict.status, 1);
        assert.match(conflict.stderr, /dispatcher start failed/);
        assert.equal(cli(fixture, ["dispatch", "stop", "-p", "project"], root).status, 0);
        assert.equal(isolatedTmux(socket, ["has-session", "-t", `=${conflictName}`]).status, 0);
      } finally {
        isolatedTmux(socket, ["kill-server"]);
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS + 5000,
  );
});

const globalFixtures: Fixture[] = [];

function setupGlobal() {
  const fixture = setup("alpha", true);
  fixture.env = { ...fixture.env, STUB_WAIT: "1" } as typeof fixture.env;
  for (const project of ["alpha", "beta"]) {
    mkdirSync(join(fixture.home, "projects", project), { recursive: true });
    mkdirSync(join(fixture.home, ".agents", "tickets", project), { recursive: true });
  }
  globalFixtures.push(fixture);
  return fixture;
}

function globalStore(fixture: Fixture, project: string) {
  return join(fixture.home, ".agents", "tickets", project);
}

function recordedLaunches(fixture: Fixture): string[] {
  const path = join(fixture.records, "launches");
  return existsSync(path) ? readFileSync(path, "utf8").trimEnd().split("\n") : [];
}

async function waitRecorded(fixture: Fixture, key: string) {
  await waitFor(() => existsSync(join(fixture.records, `${key}.json`)), `pi did not start: ${key}`);
}

async function waitGlobalFinished(fixture: Fixture) {
  await waitFor(
    () =>
      isolatedTmux(fixture.socket, ["has-session", "-t", `=${dispatcherName(null)}`]).status !== 0,
    "global dispatcher did not finish",
  );
}

afterEach(() => {
  for (const fixture of globalFixtures.splice(0)) {
    isolatedTmux(fixture.socket, ["kill-server"]);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe("global ticket dispatch", () => {
  it(
    "orders all projects by ID, separates matching IDs, and resolves dependencies within each project",
    async () => {
      const fixture = setupGlobal();
      const alpha = globalStore(fixture, "alpha");
      const beta = globalStore(fixture, "beta");
      for (const [store, id] of [
        [alpha, "20260103-000000"],
        [beta, "20260101-000000"],
        [alpha, "20260102-000000"],
        [beta, "20260102-000000"],
      ])
        writeTicket(store!, id!, "open");
      writeTicket(alpha, "dependency", "locked");
      writeTicket(beta, "dependency", "closed");
      writeFileSync(
        join(alpha, "20260100-000000.md"),
        "---\nstatus: open\nafter: dependency\n---\n# waiting\n",
      );
      writeTicket(alpha, "resolved", "closed");
      writeFileSync(
        join(alpha, "20260104-000000.md"),
        "---\nstatus: open\nafter: resolved\n---\n# ready\n",
      );
      for (const status of ["draft", "blocked", "locked", "closed", "cancelled"])
        writeTicket(beta, status, status);
      startServer(fixture);
      const started = cli(fixture, ["dispatch", "--all", "-p", "../ignored", "--max", "1"]);
      assert.equal(started.status, 0, started.stderr);
      const expected = [
        "beta/20260101-000000",
        "alpha/20260102-000000",
        "beta/20260102-000000",
        "alpha/20260103-000000",
        "alpha/20260104-000000",
      ];
      for (const [index, key] of expected.entries()) {
        await waitRecorded(fixture, key);
        assert.deepEqual(recordedLaunches(fixture), expected.slice(0, index + 1));
        const [project, id] = key.split("/");
        assert.deepEqual(JSON.parse(readFileSync(join(fixture.records, `${key}.json`), "utf8")), {
          args: [expectedPrompt(id!)],
          cwd: join(fixture.home, "projects", project!),
        });
        assert.equal(cli(fixture, ["set", id!, '{"status":"closed"}', "-p", project!]).status, 0);
      }
      await waitGlobalFinished(fixture);
      assert.deepEqual(recordedLaunches(fixture), expected);
      for (const project of ["alpha", "beta"]) {
        const name = sessionName("handle_", `${project}/20260102-000000`, true);
        assert.equal(isolatedTmux(fixture.socket, ["has-session", "-t", `=${name}`]).status, 0);
      }
    },
    TIMEOUT_MS + 5000,
  );

  it(
    "adopts remaining pi sessions across both modes and counts them against the global max",
    async () => {
      const fixture = setupGlobal();
      writeTicket(globalStore(fixture, "alpha"), "first", "open");
      writeTicket(globalStore(fixture, "beta"), "second", "open");
      startServer(fixture);
      assert.equal(cli(fixture, ["dispatch"]).status, 0);
      await waitRecorded(fixture, "alpha/first");
      const inheritedName = "handle_first";
      const pid = isolatedTmux(fixture.socket, [
        "display-message",
        "-p",
        "-t",
        `=${inheritedName}:0.0`,
        "#{pane_pid}",
      ]).stdout;
      assert.equal(cli(fixture, ["dispatch", "stop"]).status, 0);
      const global = cli(fixture, ["dispatch", "--all", "--max", "1"]);
      assert.equal(global.status, 0, global.stderr);
      await waitFor(
        () =>
          isolatedTmux(fixture.socket, [
            "capture-pane",
            "-p",
            "-t",
            `=${dispatcherName(null)}:0.0`,
          ]).stdout.includes("dispatcher start max=1"),
        "global worker did not begin",
      );
      assert.deepEqual(recordedLaunches(fixture), ["alpha/first"]);
      assert.equal(
        isolatedTmux(fixture.socket, [
          "display-message",
          "-p",
          "-t",
          `=${inheritedName}:0.0`,
          "#{pane_pid}",
        ]).stdout,
        pid,
      );
      assert.equal(cli(fixture, ["set", "first", '{"status":"closed"}', "-p", "alpha"]).status, 0);
      await waitRecorded(fixture, "beta/second");
      assert.equal(cli(fixture, ["dispatch", "stop", "--all"]).status, 0);
      writeTicket(globalStore(fixture, "beta"), "third", "open");
      const local = cli(fixture, ["dispatch", "-p", "beta", "--max", "1"]);
      assert.equal(local.status, 0, local.stderr);
      await waitFor(
        () =>
          isolatedTmux(fixture.socket, [
            "capture-pane",
            "-p",
            "-t",
            `=${dispatcherName("beta")}:0.0`,
          ]).stdout.includes("dispatcher start max=1"),
        "local worker did not begin",
      );
      assert.deepEqual(recordedLaunches(fixture), ["alpha/first", "beta/second"]);
      assert.equal(cli(fixture, ["set", "second", '{"status":"closed"}', "-p", "beta"]).status, 0);
      await waitRecorded(fixture, "beta/third");
      assert.deepEqual(recordedLaunches(fixture), ["alpha/first", "beta/second", "beta/third"]);
      assert.deepEqual(
        JSON.parse(readFileSync(join(fixture.records, "alpha/first.json"), "utf8")),
        {
          args: [expectedPrompt("first")],
          cwd: fixture.cwd,
        },
      );
    },
    TIMEOUT_MS + 5000,
  );

  it.each([false, true])(
    "rejects overlapping dispatchers in both start orders (global first=%s)",
    async (globalFirst) => {
      const fixture = setupGlobal();
      writeTicket(fixture.store, "held", "open");
      startServer(fixture);
      const firstArgs = globalFirst ? ["--all"] : [];
      const secondArgs = globalFirst ? [] : ["--all"];
      const first = cli(fixture, ["dispatch", ...firstArgs]);
      assert.equal(first.status, 0, first.stderr);
      await waitRecorded(fixture, "alpha/held");
      const duplicate = cli(fixture, ["dispatch", ...firstArgs]);
      assert.equal(duplicate.status, 0, duplicate.stderr);
      assert.match(duplicate.stdout, /already running/);
      const overlap = cli(fixture, ["dispatch", ...secondArgs]);
      assert.equal(overlap.status, 1);
      assert.match(overlap.stderr, /overlapping dispatcher already running/);
      assert.match(cli(fixture, ["dispatch", "stop", ...secondArgs]).stdout, /already stopped/);
      assert.equal(
        isolatedTmux(fixture.socket, [
          "has-session",
          "-t",
          `=${dispatcherName(globalFirst ? null : "alpha")}`,
        ]).status,
        0,
      );
      assert.equal(cli(fixture, ["dispatch", "stop", ...firstArgs]).status, 0);
      assert.deepEqual(recordedLaunches(fixture), ["alpha/held"]);
    },
    TIMEOUT_MS + 5000,
  );

  it(
    "serializes simultaneous global and project starts without double launching",
    async () => {
      const fixture = setupGlobal();
      writeTicket(fixture.store, "held", "open");
      startServer(fixture);
      const command = process.env.TICKET_DISPATCH_BIN
        ? [process.env.TICKET_DISPATCH_BIN]
        : [process.execPath, CLI];
      const children = [[], ["--all"]].map((flags) =>
        Bun.spawn([...command, "dispatch", ...flags], {
          cwd: fixture.cwd,
          env: fixture.env,
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const results = await Promise.all(
        children.map(async (child) => ({
          code: await child.exited,
          stderr: await new Response(child.stderr).text(),
        })),
      );
      assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
      assert.match(results.find((result) => result.code === 1)!.stderr, /overlapping dispatcher/);
      await waitRecorded(fixture, "alpha/held");
      assert.deepEqual(recordedLaunches(fixture), ["alpha/held"]);
    },
    TIMEOUT_MS + 5000,
  );

  it.each(["file", "inaccessible"])(
    "fails before any pi launch for a %s candidate cwd",
    (kind) => {
      const fixture = setupGlobal();
      writeTicket(fixture.store, "first", "open");
      writeTicket(globalStore(fixture, "beta"), "second", "open");
      const target = join(fixture.home, "projects", "beta");
      rmSync(target, { recursive: true });
      if (kind === "file") writeFileSync(target, "not a directory");
      if (kind === "inaccessible") {
        mkdirSync(target);
        chmodSync(target, 0o600);
      }
      try {
        const result = cli(fixture, ["dispatch", "--all", "--max", "1"]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /^I\/O error:/);
        assert.equal(existsSync(fixture.socket), false);
        assert.deepEqual(recordedLaunches(fixture), []);
      } finally {
        if (kind === "inaccessible") chmodSync(target, 0o700);
      }
    },
  );

  it(
    "skips a missing candidate cwd, logs the skip, and launches the other project",
    async () => {
      const fixture = setupGlobal();
      writeTicket(fixture.store, "first", "open");
      writeTicket(globalStore(fixture, "beta"), "second", "open");
      rmSync(join(fixture.home, "projects", "beta"), { recursive: true });
      const started = cli(fixture, ["dispatch", "--all", "--max", "1"]);
      assert.equal(started.status, 0, started.stderr);
      assert.match(started.stdout, /skipped beta: cwd not found/);
      await waitRecorded(fixture, "alpha/first");
      const pane = isolatedTmux(fixture.socket, [
        "capture-pane",
        "-p",
        "-S",
        "-100",
        "-t",
        `=${dispatcherName(null)}:0.0`,
      ]);
      assert.equal(pane.status, 0, pane.stderr);
      assert.match(pane.stdout, /skipped beta: cwd not found/);
      assert.deepEqual(recordedLaunches(fixture), ["alpha/first"]);
      const stopped = cli(fixture, ["dispatch", "stop", "--all", "-p", "../ignored"]);
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.match(stopped.stdout, /dispatcher stopped: ticket_dispatch_all/);
    },
    TIMEOUT_MS + 5000,
  );

  it(
    "fails fast on a new non-directory project during a tick while preserving existing pi",
    async () => {
      const fixture = setupGlobal();
      writeTicket(fixture.store, "held", "open");
      startServer(fixture);
      assert.equal(
        cli(fixture, ["dispatch", "--all", "--max", "1"]).status,
        0,
      );
      await waitRecorded(fixture, "alpha/held");
      const added = globalStore(fixture, "gamma");
      mkdirSync(added);
      writeTicket(added, "new", "open");
      writeFileSync(join(fixture.home, "projects", "gamma"), "not a directory");
      await waitGlobalFinished(fixture);
      assert.deepEqual(recordedLaunches(fixture), ["alpha/held"]);
      assert.equal(
        isolatedTmux(fixture.socket, [
          "has-session",
          "-t",
          `=${sessionName("handle_", "alpha/held", true)}`,
        ]).status,
        0,
      );
    },
    TIMEOUT_MS + 5000,
  );

  it(
    "keeps the dispatcher alive when a new project has no target directory during a tick",
    async () => {
      const fixture = setupGlobal();
      writeTicket(fixture.store, "held", "open");
      startServer(fixture);
      assert.equal(
        cli(fixture, ["dispatch", "--all", "--max", "1"]).status,
        0,
      );
      await waitRecorded(fixture, "alpha/held");
      const added = globalStore(fixture, "gamma");
      mkdirSync(added);
      writeTicket(added, "new", "open");
      await Bun.sleep(500);
      assert.equal(
        isolatedTmux(fixture.socket, ["has-session", "-t", `=${dispatcherName(null)}`]).status,
        0,
      );
      assert.deepEqual(recordedLaunches(fixture), ["alpha/held"]);
      const stopped = cli(fixture, ["dispatch", "stop", "--all", "-p", "../ignored"]);
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.match(stopped.stdout, /dispatcher stopped: ticket_dispatch_all/);
    },
    TIMEOUT_MS + 5000,
  );

  it(
    "stops the global dispatcher independently of removed stores and target directories",
    async () => {
      const fixture = setupGlobal();
      writeTicket(fixture.store, "held", "open");
      startServer(fixture);
      assert.equal(
        cli(fixture, ["dispatch", "--all"], fixture.cwd, {
          ...fixture.env,
          TICKET_TEST_TICK_MS: "60000",
        }).status,
        0,
      );
      await waitRecorded(fixture, "alpha/held");
      rmSync(join(fixture.home, ".agents", "tickets"), { recursive: true });
      rmSync(join(fixture.home, "projects"), { recursive: true });
      const stopped = cli(fixture, ["dispatch", "stop", "--all", "-p", "../ignored"]);
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.match(stopped.stdout, /dispatcher stopped: ticket_dispatch_all/);
      assert.equal(
        isolatedTmux(fixture.socket, [
          "has-session",
          "-t",
          `=${sessionName("handle_", "alpha/held", true)}`,
        ]).status,
        0,
      );
    },
    TIMEOUT_MS + 5000,
  );

  it(
    "lists running dispatchers and clears them on stop",
    async () => {
      const fixture = setup("alpha");
      const { root, socket, records, store } = fixture;
      const env = { ...fixture.env, STUB_WAIT: "1" };
      try {
        mkdirSync(join(fixture.home, "projects", "alpha"), { recursive: true });
        writeTicket(store, "held", "open");
        startServer(fixture, env);
        const empty = cli(fixture, ["dispatch", "list"]);
        assert.equal(empty.status, 0, empty.stderr);
        assert.equal(empty.stdout, "no dispatcher running\n");
        const start = cli(fixture, ["dispatch", "-p", "alpha", "--max", "1"]);
        assert.equal(start.status, 0, start.stderr);
        await waitFor(() => existsSync(join(records, "held.json")), "held pi did not start");
        const listing = cli(fixture, ["dispatch", "list"]);
        assert.equal(listing.status, 0, listing.stderr);
        const [project, name, time] = listing.stdout.trimEnd().split("  ");
        assert.equal(project, "alpha");
        assert.equal(name, dispatcherName("alpha"));
        assert.match(time!, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        const stopped = cli(fixture, ["dispatch", "stop", "-p", "alpha"]);
        assert.equal(stopped.status, 0, stopped.stderr);
        const cleared = cli(fixture, ["dispatch", "list"]);
        assert.equal(cleared.status, 0, cleared.stderr);
        assert.equal(cleared.stdout, "no dispatcher running\n");
      } finally {
        isolatedTmux(socket, ["kill-server"]);
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS + 5000,
  );
});

describe("global dispatch dynamic projects", () => {
  it(
    "discovers a new quoted project on a later tick",
    async () => {
      const fixture = setupGlobal();
      writeTicket(fixture.store, "first", "open");
      startServer(fixture);
      const started = cli(fixture, ["dispatch", "--all", "--max", "1"]);
      assert.equal(started.status, 0, started.stderr);
      await waitRecorded(fixture, "alpha/first");
      const project = "quoted 'project'";
      const store = globalStore(fixture, project);
      mkdirSync(join(fixture.home, "projects", project), { recursive: true });
      mkdirSync(store);
      writeTicket(store, "second", "open");
      assert.equal(cli(fixture, ["set", "first", '{"status":"closed"}', "-p", "alpha"]).status, 0);
      await waitRecorded(fixture, `${project}/second`);
      assert.deepEqual(recordedLaunches(fixture), ["alpha/first", `${project}/second`]);
      assert.deepEqual(
        JSON.parse(readFileSync(join(fixture.records, project, "second.json"), "utf8")),
        {
          args: [expectedPrompt("second")],
          cwd: join(fixture.home, "projects", project),
        },
      );
      assert.equal(cli(fixture, ["set", "second", '{"status":"closed"}', "-p", project]).status, 0);
      await waitGlobalFinished(fixture);
    },
    TIMEOUT_MS + 5000,
  );
});
