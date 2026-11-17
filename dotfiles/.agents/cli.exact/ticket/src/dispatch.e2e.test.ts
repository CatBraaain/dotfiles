import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { dispatcherName, shQuote } from "./dispatch";

const TEMP_ROOT = "/tmp/work/dotfiles";
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

function setup() {
  mkdirSync(TEMP_ROOT, { recursive: true });
  const root = mkdtempSync(join(TEMP_ROOT, "ticket-dispatch-e2e-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const work = join(cwd, "work with 'single' \"double\" $HOME `ticks` {{ TICKET_ID }}");
  const store = join(home, ".agents", "tickets", "project");
  const bin = join(root, "stub-bin");
  const records = join(root, "records");
  const socket = join(root, "tmux.sock");
  for (const dir of [work, store, bin, records]) mkdirSync(dir, { recursive: true });
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
  return { root, home, cwd, work, store, socket, records, env };
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

function logText(work: string): string {
  const path = join(work, "dispatch.log");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

async function waitFinished(fixture: Fixture, work = fixture.work) {
  await waitFor(() => logText(work).endsWith("dispatcher finished\n"), "dispatcher did not finish");
  await waitFor(
    () =>
      isolatedTmux(fixture.socket, ["has-session", "-t", `=${dispatcherName("project")}`])
        .status !== 0,
    "finished dispatcher session survived",
  );
  return logText(work);
}

describe("ticket dispatch real tmux", () => {
  it(
    "passes the fixed prompt as one pi argument and preserves its trailing newline",
    async () => {
      const fixture = setup();
      const { root, cwd, work, store, socket, records } = fixture;
      try {
        writeTicket(store, "a.v1", "open");
        writeFileSync(join(work, "fix-prompt-template.txt"), "ticket=wrong-cwd-template");
        startServer(fixture);
        const start = cli(fixture, ["dispatch", work, "--interval", "0.05"]);
        assert.equal(start.status, 0, start.stderr);
        await waitFinished(fixture);
        const expected = expectedPrompt("a.v1");
        const prompt = readFileSync(join(work, "fix", "prompt-a.v1.txt"), "utf8");
        const recorded = JSON.parse(readFileSync(join(records, "a.v1.json"), "utf8"));
        assert.equal(prompt, expected);
        assert.ok(prompt.endsWith("\n"));
        assert.deepEqual(recorded, { args: [expected], cwd });
      } finally {
        isolatedTmux(socket, ["kill-server"]);
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS + 5000,
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
      const { root, cwd, work, store, socket, records } = fixture;
      const env = { ...fixture.env, STUB_WAIT: "1" };
      try {
        writeTicket(store, "a.v1", "open");
        startServer(fixture, env);
        const command = process.env.TICKET_DISPATCH_BIN
          ? [process.env.TICKET_DISPATCH_BIN]
          : [process.execPath, CLI];
        const starts = [0, 1].map(() =>
          Bun.spawn([...command, "dispatch", "start", work, "--interval", "0.05"], {
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
      const { root, cwd, work, store, socket, records } = fixture;
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
          work,
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
        const log = await waitFinished(fixture);
        const messages = log
          .trimEnd()
          .split("\n")
          .map((line) => {
            assert.match(line, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /);
            return line.replace(/^\[[^\]]+\] /, "");
          });
        assert.equal(messages[0], "dispatcher start max=2");
        assert.equal(messages.at(-1), "dispatcher finished");
        assert.equal(messages.filter((line) => line.startsWith("launched ")).length, 4);
        assert.equal(messages.filter((line) => line.startsWith("done ")).length, 3);
        assert.deepEqual(
          messages.filter((line) => line.startsWith("incomplete ")),
          ["incomplete b status=open session exited without close"],
        );
        assert.ok(messages.includes("done c status=cancelled"));
        for (const id of ["a.v1", "b", "c", "d"]) {
          const expected = expectedPrompt(id);
          assert.equal(readFileSync(join(work, "fix", `prompt-${id}.txt`), "utf8"), expected);
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
        const log = await waitFinished(fixture, cwd);
        assert.deepEqual(
          log
            .split("\n")
            .filter((line) => line.includes("launched "))
            .map((line) => line.replace(/^\[[^\]]+\] /, "")),
          ["launched a.v1 as e2e_a_v1", "launched b as e2e_b", "launched c as e2e_c"],
        );
        assert.match(log, /done a.v1 status=closed/);
        assert.match(log, /incomplete b status=open session exited without close/);
        assert.match(log, /done c status=cancelled/);
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

  it.each(["closed", "cancelled"])(
    "releases inherited %s tickets after stopping and restarting with changed options",
    async (completedStatus) => {
      const fixture = setup();
      const { root, cwd, work, store, socket, records } = fixture;
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
          ["dispatch", "start", work, "--max", "2", "--prefix", "e2e_", "--interval", "0.05"],
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
        const duplicate = cli(fixture, ["dispatch", work], otherCwd, env);
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
        const secondWork = join(root, "second-work");
        mkdirSync(secondWork);
        writeTicket(store, "c", "open");
        const restart = cli(
          fixture,
          [
            "dispatch",
            "start",
            secondWork,
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
        await waitFor(
          () => logText(secondWork).includes("dispatcher start max=1"),
          "restart worker did not start",
        );
        assert.equal(readFileSync(join(records, "launches"), "utf8"), "a.v1\n");
        assert.equal(
          isolatedTmux(socket, ["display-message", "-p", "-t", "=e2e_a_v1:0.0", "#{pane_pid}"])
            .stdout,
          piPid,
        );
        assert.equal(
          cli(fixture, ["set", "a.v1", JSON.stringify({ status: completedStatus })]).status,
          0,
        );
        await waitFor(
          () => existsSync(join(records, "c.json")),
          "new prefix ticket did not start after adoption release",
        );
        assert.equal(isolatedTmux(socket, ["has-session", "-t", "=changed_c"]).status, 0);
        assert.deepEqual(JSON.parse(readFileSync(join(records, "c.json"), "utf8")), {
          args: [expectedPrompt("c")],
          cwd: otherCwd,
        });
        assert.deepEqual(JSON.parse(readFileSync(join(records, "a.v1.json"), "utf8")), {
          args: [expectedPrompt("a.v1")],
          cwd,
        });
        assert.equal(cli(fixture, ["set", "c", '{"status":"closed"}']).status, 0);
        const log = await waitFinished(fixture, secondWork);
        assert.ok(log.includes(`done a.v1 status=${completedStatus}`));
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
      const { root, work, store, socket, records } = fixture;
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
        const start = cli(fixture, ["dispatch", work, "--prefix", "e2e_", "--interval", "0.05"]);
        assert.equal(start.status, 0, start.stderr);
        const log = await waitFinished(fixture);
        assert.match(log, /tmux new-session failed for e2e_a_v1/);
        assert.match(log, /tmux new-session failed for e2e_b/);
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
        const conflict = cli(fixture, ["dispatch", work]);
        assert.equal(conflict.status, 1);
        assert.match(conflict.stderr, /dispatcher start failed/);
        assert.equal(cli(fixture, ["dispatch", "stop"]).status, 0);
        assert.equal(isolatedTmux(socket, ["has-session", "-t", `=${conflictName}`]).status, 0);
      } finally {
        isolatedTmux(socket, ["kill-server"]);
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS + 5000,
  );
});
