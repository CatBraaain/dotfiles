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
import { describe, it } from "bun:test";
import { dispatcherName, shQuote } from "./dispatch";

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

function setup(project = "project") {
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
    `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (!args[0].startsWith("ticket ")) throw new Error("ticket ID is missing");
const id = args[0].split(" に")[0].slice("ticket ".length);
appendFileSync(join(${JSON.stringify(records)}, "launches"), id + "\\n");
writeFileSync(join(${JSON.stringify(records)}, id + ".pid"), String(process.pid));
writeFileSync(join(${JSON.stringify(records)}, id + ".json"), JSON.stringify({ args, cwd: process.cwd() }));
if (process.env.STUB_WAIT === "1" || process.env.STUB_HOLD_ID === id) await Bun.sleep(60000);
if (id !== "b") {
  const path = join(${JSON.stringify(store)}, id + ".md");
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
    ["-f", "/dev/null", "new-session", "-d", "-s", "e2e_a_v1_extra", "-c", fixture.cwd, "sleep 60"],
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
        const start = cli(fixture, ["dispatch", "--interval", "0.05"]);
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
          const metadata = isolatedTmux(socket, ["show-environment", "-t", "=fix_a_v1", key]);
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
          ["dispatch", ...action, flag, project, "--interval", "0.05"],
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
        assert.equal(isolatedTmux(socket, ["has-session", "-t", "=fix_a_v1"]).status, 0);
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
          Bun.spawn([...command, "dispatch", "start", "--interval", "0.05"], {
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
        assert.equal(isolatedTmux(socket, ["has-session", "-t", "=fix_a_v1"]).status, 0);
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
        const result = cli(fixture, [
          "dispatch",
          "--max",
          "2",
          "--prefix",
          "e2e_",
          "--interval",
          "0.1",
        ]);
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
          const name = `=e2e_${id.replaceAll(".", "_")}`;
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
        assert.equal(isolatedTmux(socket, ["has-session", "-t", "=e2e_a_v1_extra"]).status, 0);
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
          ["dispatch", "start", "--max", "1", "--prefix", "e2e_", "--interval", "0.05"],
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
          const name = `=e2e_${id.replaceAll(".", "_")}`;
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
          ["dispatch", "start", "--max", "2", "--prefix", "e2e_", "--interval", "0.05"],
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
          "=e2e_a_v1:0.0",
          "#{pane_pid}",
        ]).stdout;
        assert.match(piPid, /^\d+\n$/);
        const duplicate = cli(fixture, ["dispatch"], otherCwd, env);
        assert.equal(duplicate.status, 0, duplicate.stderr);
        assert.match(duplicate.stdout, /already running/);
        const stop = cli(fixture, ["dispatch", "stop"], otherCwd, env);
        assert.equal(stop.status, 0, stop.stderr);
        assert.match(stop.stdout, /dispatcher stopped:/);
        assert.equal(isolatedTmux(socket, ["has-session", "-t", "=e2e_a_v1"]).status, 0);
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
            "--prefix",
            "changed_",
            "--interval",
            "0.05",
          ],
          otherCwd,
          env,
        );
        assert.equal(restart.status, 0, restart.stderr);
        assert.equal(readFileSync(join(records, "launches"), "utf8"), "a.v1\n");
        assert.equal(
          isolatedTmux(socket, ["display-message", "-p", "-t", "=e2e_a_v1:0.0", "#{pane_pid}"])
            .stdout,
          piPid,
        );
        assert.equal(
          cli(fixture, ["set", "a.v1", JSON.stringify({ status: releasedStatus })]).status,
          0,
        );
        await waitFor(
          () => existsSync(join(records, "c.json")),
          "new prefix ticket did not start after adoption release",
        );
        assert.equal(isolatedTmux(socket, ["has-session", "-t", "=changed_c"]).status, 0);
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
        assert.equal(isolatedTmux(socket, ["has-session", "-t", "=e2e_a_v1"]).status, 0);
        assert.equal(
          isolatedTmux(socket, ["display-message", "-p", "-t", "=e2e_a_v1:0.0", "#{pane_pid}"])
            .stdout,
          piPid,
        );
        assert.equal(isolatedTmux(socket, ["has-session", "-t", "=changed_c"]).status, 0);
        assert.equal(
          isolatedTmux(socket, [
            "display-message",
            "-p",
            "-t",
            "=changed_c:0.0",
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
            "e2e_a_v1",
            [
              "-e",
              "TICKET_DISPATCH_PROJECT=foreign",
              "-e",
              "TICKET_DISPATCH_ROLE=pi",
              "-e",
              "TICKET_DISPATCH_ID=a.v1",
            ],
          ],
          ["e2e_b", []],
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
        const start = cli(fixture, ["dispatch", "--prefix", "e2e_", "--interval", "0.05"]);
        assert.equal(start.status, 0, start.stderr);
        await waitFinished(fixture);
        assert.equal(existsSync(join(records, "launches")), false);
        for (const name of ["e2e_a_v1", "e2e_b", "e2e_a_v1_extra"])
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
