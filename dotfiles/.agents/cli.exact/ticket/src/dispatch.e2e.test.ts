import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
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
  const runtime = join(root, "runtime");
  const agent = join(root, "agent dir");
  const sessions = join(root, "sessions");
  const socket = join(runtime, "pi-tmux", "server.sock");
  for (const dir of [cwd, store, bin, records, join(runtime, "pi-tmux"), agent])
    mkdirSync(dir, { recursive: true });
  const stub = join(root, "stub.ts");
  writeFileSync(
    stub,
    `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--") throw new Error("Expected one pi prompt");
const id = process.env.TICKET_DISPATCH_ID;
if (!id) throw new Error("ticket ID is missing");
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
  const ticket = readFileSync(path, "utf8");
  if (ticket.startsWith("---\\nstatus: locked\\n")) process.exit(0);
  writeFileSync(path, ticket.replace("status: open", "status: " + status));
  await Bun.sleep(60000);
}
`,
  );
  writeFileSync(
    join(bin, "pi"),
    `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(stub)} -- "$@"\n`,
  );
  chmodSync(join(bin, "pi"), 0o755);
  const env = {
    ...process.env,
    HOME: home,
    SHELL: "/bin/sh",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TICKET_TEST_TMUX_SOCKET: socket,
    TICKET_TEST_TICK_MS: "50",
    XDG_RUNTIME_DIR: runtime,
    PI_CODING_AGENT_DIR: agent,
    PI_CODING_AGENT_SESSION_DIR: sessions,
  };
  return { root, home, cwd, project, store, socket, records, sessions, env };
}

type Fixture = ReturnType<typeof setup>;

function writeTicket(store: string, id: string, status: string) {
  writeFileSync(join(store, `${id}.md`), `---\nstatus: ${status}\n---\n\n# ${id}\n`);
}

function startServer(fixture: Fixture, env: NodeJS.ProcessEnv = fixture.env) {
  const started = isolatedTmux(
    fixture.socket,
    [
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "handle_a_v1_extra",
      "-c",
      fixture.cwd,
      "sleep 60",
    ],
    env,
  );
  assert.equal(started.status, 0, started.stderr);
  assert.equal(
    isolatedTmux(fixture.socket, ["set-option", "-g", "default-shell", "/bin/sh"]).status,
    0,
  );
}

function cliCommand(): string[] {
  return process.env.TICKET_DISPATCH_BIN
    ? [process.env.TICKET_DISPATCH_BIN]
    : [process.execPath, CLI];
}

function cli(
  fixture: Fixture,
  args: string[],
  cwd = fixture.cwd,
  env: NodeJS.ProcessEnv = fixture.env,
) {
  const command = cliCommand();
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

async function waitFinished(fixture: Fixture, project: string | null = fixture.project) {
  await waitFor(
    () =>
      isolatedTmux(fixture.socket, ["has-session", "-t", `=${dispatcherName(project)}`]).status !==
      0,
    "finished dispatcher session survived",
  );
}

function inspectionStub(
  fixture: Fixture,
  options: {
    all?: boolean;
    failOnce?: boolean;
    pausePreflight?: string;
    changingTicket?: { id: string; close?: true };
  } = {},
) {
  const inspectLog = join(fixture.records, "inspections");
  const stub = join(fixture.root, "mux-stub.ts");
  const expectedCwd = options.all ? join(fixture.home, "projects", fixture.project) : fixture.cwd;
  writeFileSync(
    stub,
    `import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { sessionName, shQuote } from ${JSON.stringify(join(import.meta.dir, "dispatch.ts"))};
const [command, mode, ...args] = process.argv.slice(2);
const log = ${JSON.stringify(inspectLog)};
const failure = ${JSON.stringify(options.failOnce ?? false)};
const pausePreflight = ${JSON.stringify(options.pausePreflight ?? null)};
const changingTicket = ${JSON.stringify(options.changingTicket ? join(fixture.store, `${options.changingTicket.id}.md`) : null)};
const answer = (value) => console.log(JSON.stringify(value));
assert.equal(command, "inspect");
assert.equal(process.env.XDG_RUNTIME_DIR, ${JSON.stringify(fixture.env.XDG_RUNTIME_DIR)});
assert.equal(process.env.PI_CODING_AGENT_DIR, ${JSON.stringify(fixture.env.PI_CODING_AGENT_DIR)});
if (mode !== "--dispatch-ticket") {
  assert.equal(args.length, 0);
  const alreadyProbed = existsSync(log) && readFileSync(log, "utf8").includes("preflight " + mode + "\\n");
  appendFileSync(log, "preflight " + mode + "\\n");
  while (pausePreflight && existsSync(${JSON.stringify(fixture.root)}) && !existsSync(pausePreflight))
    await Bun.sleep(10);
  if (mode === "present") answer({ state: "present" });
  else if (mode === "failed") process.exitCode = 1;
  else {
    if (changingTicket && !alreadyProbed) {
      const content = readFileSync(changingTicket, "utf8");
      const nextContent = ${options.changingTicket?.close ?? false} ? content.replace("status: locked", "status: closed") : content;
      const replacement = changingTicket + ".tmp";
      writeFileSync(replacement, nextContent);
      renameSync(replacement, changingTicket);
    }
    answer({ state: "absent", file: null });
  }
} else {
  assert.equal(args.length, 7);
  const [ownerId, socket, project, ticketId, name, cwd, prompt] = args;
  const attempted = existsSync(log) && readFileSync(log, "utf8").includes("atomic " + ownerId + "\\n");
  appendFileSync(log, "atomic " + ownerId + "\\n");
  assert.equal(socket, join(process.env.XDG_RUNTIME_DIR, "pi-tmux", "server.sock"));
  assert.equal(project, ${JSON.stringify(fixture.project)});
  assert.equal(cwd, ${JSON.stringify(expectedCwd)});
  assert.equal(name, sessionName("handle_", ${options.all ? "project + '/' + ticketId" : "ticketId"}, ${options.all ?? false}));
  assert.ok(prompt.endsWith("\\n"));
  if (ownerId === "arrived") answer({ state: "present" });
  else if (failure && !attempted) {
    console.error("temporary mux failure");
    process.exitCode = 1;
  } else {
    const result = spawnSync("tmux", ["-S", socket, "new-session", "-d", "-P", "-F", "#{session_id}", "-s", name, "-c", cwd,
      "-e", "HOME=" + process.env.HOME, "-e", "PATH=" + process.env.PATH,
      "-e", "TICKET_DISPATCH_ROLE=pi", "-e", "TICKET_DISPATCH_PROJECT=" + project, "-e", "TICKET_DISPATCH_ID=" + ticketId,
      "exec pi -- " + shQuote(prompt)], { encoding: "utf8" });
    if (result.status === 0) answer({ state: "launched", session: result.stdout.trim() });
    else {
      console.error(result.stderr.trim());
      process.exitCode = 1;
    }
  }
}
`,
  );
  writeFileSync(
    join(fixture.root, "stub-bin", "pi-mux"),
    `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(stub)} "$@"\n`,
    { mode: 0o700 },
  );
  return inspectLog;
}

function lockedTicket(id: string): string {
  return `---\nstatus: locked\n---\n\n# ${id}\n`;
}

function lockHistoryRecords(cwd: string, ticketPath: string, ownerId: string, hour = "10") {
  const ticketId = basename(ticketPath, ".md");
  const project = basename(dirname(ticketPath));
  const toolCallId = `call-${ownerId}`;
  return [
    { type: "session", id: ownerId, cwd, timestamp: `2026-11-23T${hour}:00:00.000Z` },
    {
      type: "message",
      id: "call",
      parentId: null,
      timestamp: `2026-11-23T${hour}:00:01.000Z`,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "ticket_set",
            arguments: { selector: ticketId, project, status: "locked" },
          },
        ],
      },
    },
    {
      type: "message",
      id: "result",
      parentId: "call",
      timestamp: `2026-11-23T${hour}:00:02.000Z`,
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "ticket_set",
        isError: false,
        content: [
          {
            type: "text",
            text: `updated ${ticketId}\nstatus: locked\nafter: null\npath: ${ticketPath}`,
          },
        ],
      },
    },
  ];
}

function jsonl(entries: readonly object[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function writeLockHistory(file: string, cwd: string, ticketPath: string, ownerId: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, jsonl(lockHistoryRecords(cwd, ticketPath, ownerId)));
}

function seedLockedTicket(
  fixture: Fixture,
  id: string,
  ownerId: string,
  cwd = fixture.cwd,
): string {
  const ticketPath = join(fixture.store, `${id}.md`);
  const file = join(fixture.sessions, "archive", `${ownerId}.jsonl`);
  writeFileSync(ticketPath, lockedTicket(id));
  writeLockHistory(file, cwd, ticketPath, ownerId);
  return file;
}

describe("ticket dispatch with real pi-mux", () => {
  it.each(["custom", "unset", "empty", "project"] as const)(
    "uses the caller or project session settings instead of the tmux global (%s)",
    async (rootMode) => {
      const global = rootMode === "project";
      const fixture = setup("project", global);
      try {
        const workspace = global ? join(fixture.home, "projects", fixture.project) : fixture.cwd;
        const projectSettings = join(workspace, ".pi", "settings.json");
        const { PI_CODING_AGENT_DIR: agent, XDG_RUNTIME_DIR, PATH } = fixture.env;
        const env: NodeJS.ProcessEnv = {
          HOME: fixture.home,
          LANG: "C.UTF-8",
          SHELL: "/bin/sh",
          PATH,
          XDG_RUNTIME_DIR,
          PI_CODING_AGENT_DIR: agent,
          TICKET_TEST_TMUX_SOCKET: fixture.socket,
          TICKET_TEST_TICK_MS: fixture.env.TICKET_TEST_TICK_MS,
        };
        const sessionDirKey = "PI_CODING_AGENT_SESSION_DIR";
        const staleRoot = join(fixture.root, "stale sessions");
        const settingsRoot = join(fixture.root, "settings sessions");
        const customRoot = join(fixture.root, "caller sessions;");
        if (rootMode === "custom" || rootMode === "empty")
          env[sessionDirKey] = rootMode === "custom" ? customRoot : "";
        const expectedRoot = rootMode === "custom" || global ? customRoot : settingsRoot;
        for (const root of [staleRoot, settingsRoot, customRoot]) mkdirSync(root);
        writeFileSync(join(agent, "settings.json"), JSON.stringify({ sessionDir: settingsRoot }));
        if (global) {
          mkdirSync(join(workspace, ".pi"), { recursive: true });
          writeFileSync(projectSettings, JSON.stringify({ sessionDir: expectedRoot }));
        }
        mkdirSync(join(agent, "pi-tmux"), { mode: 0o700 });
        for (const extension of ["guardrails", "tickets"]) {
          const directory = join(agent, "extensions", extension);
          mkdirSync(directory, { recursive: true });
          writeFileSync(join(directory, "index.ts"), "export default function () {}\n");
        }

        const mux = join(import.meta.dir, "../../../../.local/cli.exact/pi-mux/src/main.ts");
        const muxCommand = join(fixture.root, "stub-bin", "pi-mux");
        writeFileSync(
          muxCommand,
          `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(mux)} "$@"\n`,
          { mode: 0o700 },
        );
        startServer(fixture, { ...env, [sessionDirKey]: staleRoot });
        const initialized = isolatedTmux(
          fixture.socket,
          ["set-option", "-g", "@pi-mux-generation", randomUUID()],
          env,
        );
        assert.equal(initialized.status, 0, initialized.stderr);

        const createArgs = [
          "create",
          "--json",
          JSON.stringify({ title: "Saved owner", status: "locked" }),
        ];
        const created = cli(fixture, createArgs, fixture.cwd, env);
        assert.equal(created.status, 0, created.stderr);
        const { id, path: ticketPath } = JSON.parse(created.stdout);
        const ownerId = randomUUID();
        const ownerFile = join(expectedRoot, "owner.jsonl");
        const original = lockedTicket(id);
        writeFileSync(ticketPath, original);
        writeLockHistory(ownerFile, workspace, ticketPath, ownerId);

        const reportId = randomUUID();
        const capture = join(fixture.records, "launch.json");
        writeFileSync(
          join(fixture.root, "stub.ts"),
          `import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const override = process.env.PI_CODING_AGENT_SESSION_DIR;
const settingsPath = join(process.cwd(), ".pi", "settings.json");
const settings = JSON.parse(readFileSync(existsSync(settingsPath) ? settingsPath : join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"));
const root = override || settings.sessionDir;
const timestamp = new Date().toISOString();
writeFileSync(join(root, "report.jsonl"), [
  JSON.stringify({ type: "session", id: ${JSON.stringify(reportId)}, cwd: process.cwd(), timestamp }),
  "",
].join("\\n"));
const capture = ${JSON.stringify(capture)};
writeFileSync(capture + ".tmp", JSON.stringify({ override: override ?? null, args: process.argv.slice(2), legacyMode: process.env.TICKET_DISPATCH_INSPECTION ?? null }));
renameSync(capture + ".tmp", capture);
`,
        );

        const statuses =
          rootMode === "unset"
            ? ["--status", "open", "--status", "locked"]
            : ["--status", "locked"];
        const scope = global ? ["--all"] : [];
        const started = cli(
          fixture,
          ["dispatch", "start", ...scope, ...statuses],
          fixture.cwd,
          env,
        );
        assert.equal(started.status, 0, started.stderr);
        await waitFor(() => existsSync(capture), "real pi-mux did not launch pi");
        await waitFinished(fixture, global ? null : fixture.project);
        const template = readFileSync(
          join(import.meta.dir, "../dispatch-locked-prompt.md"),
          "utf8",
        );
        assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), {
          override: env[sessionDirKey] ?? null,
          legacyMode: null,
          args: [
            "--",
            template.replace(
              "{{ ASSIGNMENT }}",
              JSON.stringify({
                project: fixture.project,
                ticketId: id,
                ownerId,
                ownerSessionFile: ownerFile,
              }),
            ),
          ],
        });
        assert.equal(readFileSync(ticketPath, "utf8"), original);
        assert.deepEqual(readdirSync(staleRoot), []);
        const serverEnv = isolatedTmux(
          fixture.socket,
          ["show-environment", "-g", sessionDirKey],
          env,
        );
        assert.equal(serverEnv.status, 0, serverEnv.stderr);
        assert.equal(serverEnv.stdout.trimEnd(), `${sessionDirKey}=${staleRoot}`);

        const history = spawnSync(muxCommand, ["history", "--cwd", workspace, "--json"], {
          cwd: workspace,
          env,
          encoding: "utf8",
          timeout: 5000,
        });
        assert.equal(history.status, 0, history.stderr);
        const report = JSON.parse(history.stdout).find(
          (entry: { id: string }) => entry.id === reportId,
        );
        assert.equal(report?.file, join(expectedRoot, "report.jsonl"));
      } finally {
        isolatedTmux(fixture.socket, ["kill-server"]);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS + 5000,
  );
});

describe("ticket dispatch real tmux", () => {
  it("launches the locked prompt only through the final mux command and leaves tickets unchanged", async () => {
    const fixture = setup();
    try {
      startServer(fixture, {
        ...fixture.env,
        XDG_RUNTIME_DIR: fixture.root,
        PI_CODING_AGENT_DIR: fixture.root,
      });
      const inspectLog = inspectionStub(fixture);
      const absent = "20261123-100001";
      const tickets = [
        [absent, "departed"],
        ["20261123-100002", "present"],
        ["20261123-100003", "failed"],
        ["20261123-100004", "arrived"],
      ] as const;
      const history = new Map(
        tickets.map(([id, owner]) => [id, seedLockedTicket(fixture, id, owner)]),
      );
      writeTicket(fixture.store, "20261123-100005", "locked");
      writeTicket(fixture.store, "a", "open");
      const started = cli(fixture, ["dispatch", "start", "--status", "locked", "--max", "1"]);
      assert.equal(started.status, 0, started.stderr);
      const report = join(fixture.records, `${absent}.json`);
      await waitFor(() => existsSync(report), "locked worker did not start");
      await waitFinished(fixture);
      const record = JSON.parse(readFileSync(report, "utf8"));
      const template = readFileSync(join(import.meta.dir, "../dispatch-locked-prompt.md"), "utf8");
      assert.deepEqual(record.args, [
        "--",
        template.replace(
          "{{ ASSIGNMENT }}",
          JSON.stringify({
            project: fixture.project,
            ticketId: absent,
            ownerId: "departed",
            ownerSessionFile: history.get(absent),
          }),
        ),
      ]);
      assert.equal(record.cwd, fixture.cwd);
      assert.equal(readFileSync(join(fixture.records, "launches"), "utf8"), `${absent}\n`);
      assert.deepEqual(
        readFileSync(inspectLog, "utf8")
          .trimEnd()
          .split("\n")
          .filter((line) => line.startsWith("atomic ")),
        ["atomic departed", "atomic arrived", "atomic arrived"],
      );
      for (const [id] of tickets)
        assert.equal(readFileSync(join(fixture.store, `${id}.md`), "utf8"), lockedTicket(id));
    } finally {
      isolatedTmux(fixture.socket, ["kill-server"]);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
  it(
    "does not block dispatch one on the same socket during a locked probe",
    async () => {
      const fixture = setup("project", true);
      const gate = join(fixture.root, "resume-inspect");
      try {
        startServer(fixture);
        const inspectLog = inspectionStub(fixture, { pausePreflight: gate });
        const lockedId = "20261123-100001";
        seedLockedTicket(fixture, lockedId, "departed");

        const other = "other";
        const openId = "20261123-100002";
        const otherStore = join(fixture.home, ".agents", "tickets", other);
        mkdirSync(otherStore, { recursive: true });
        mkdirSync(join(fixture.home, "projects", other), { recursive: true });
        writeTicket(otherStore, openId, "open");

        const started = cli(fixture, ["dispatch", "start", "--status", "locked"]);
        assert.equal(started.status, 0, started.stderr);
        await waitFor(() => existsSync(inspectLog), "locked probe did not begin");

        const manual = cli(fixture, ["dispatch", "one", "--project", other, openId]);
        assert.equal(manual.status, 0, manual.stderr);
        await waitFor(
          () => existsSync(join(fixture.records, other, `${openId}.json`)),
          "dispatch one did not launch",
        );
        assert.equal(readFileSync(inspectLog, "utf8"), "preflight departed\n");

        writeFileSync(gate, "");
        await waitFor(
          () => existsSync(join(fixture.records, fixture.project, `${lockedId}.json`)),
          "locked dispatch did not launch",
        );
        await waitFinished(fixture);
      } finally {
        writeFileSync(gate, "");
        isolatedTmux(fixture.socket, ["kill-server"]);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS + 5000,
  );

  it("skips a missing global project and retries a transient launch failure in another", async () => {
    const fixture = setup("調査 project", true);
    try {
      mkdirSync(join(fixture.home, "projects", fixture.project), { recursive: true });
      startServer(fixture);
      const probeLog = inspectionStub(fixture, { all: true, failOnce: true });
      const id = "20261123-100001.v1";
      const ticket = join(fixture.store, `${id}.md`);
      const original = lockedTicket(id);
      seedLockedTicket(fixture, id, "departed", join(fixture.home, "projects", fixture.project));
      const missingId = "20261123-100000";
      const missingStore = join(fixture.home, ".agents", "tickets", "missing");
      mkdirSync(missingStore, { recursive: true });
      const missingTicket = join(missingStore, `${missingId}.md`);
      writeFileSync(missingTicket, lockedTicket(missingId));
      writeLockHistory(
        join(fixture.sessions, "missing.jsonl"),
        join(fixture.home, "projects", "missing"),
        missingTicket,
        "missing-owner",
      );

      const started = cli(fixture, [
        "dispatch",
        "start",
        "--all",
        "--status",
        "locked",
        "--max",
        "1",
      ]);
      assert.equal(started.status, 0, started.stderr);
      assert.ok(
        started.stdout.includes(
          `skipped missing: cwd not found: ${join(fixture.home, "projects", "missing")}`,
        ),
      );
      await waitFinished(fixture, null);
      assert.equal(
        readFileSync(probeLog, "utf8"),
        "preflight departed\natomic departed\n".repeat(2),
      );
      assert.equal(
        readFileSync(join(fixture.records, "launches"), "utf8"),
        `${fixture.project}/${id}\n`,
      );
      assert.equal(readFileSync(ticket, "utf8"), original);
    } finally {
      isolatedTmux(fixture.socket, ["kill-server"]);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reruns preflight before atomically launching a replaced ticket with identical contents", async () => {
    const fixture = setup();
    try {
      startServer(fixture);
      const id = "20261123-100001";
      const ticket = join(fixture.store, `${id}.md`);
      const oldFile = seedLockedTicket(fixture, id, "previous");
      const probeLog = inspectionStub(fixture, { changingTicket: { id } });
      const started = cli(fixture, ["dispatch", "start", "--status", "locked"]);
      assert.equal(started.status, 0, started.stderr);
      await waitFinished(fixture);
      assert.equal(
        readFileSync(probeLog, "utf8"),
        "preflight previous\npreflight previous\natomic previous\n",
      );
      const record = JSON.parse(readFileSync(join(fixture.records, `${id}.json`), "utf8"));
      const assignment = JSON.parse(record.args[1].split("```json\n")[1].split("\n```")[0]);
      assert.equal(assignment.ownerId, "previous");
      assert.equal(assignment.ownerSessionFile, oldFile);
      assert.equal(readFileSync(ticket, "utf8"), lockedTicket(id));
    } finally {
      isolatedTmux(fixture.socket, ["kill-server"]);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["new-owner", "present"])(
    "uses re-lock history appended during preflight without a ticket write (%s)",
    async (ownerId) => {
      const fixture = setup();
      const gate = join(fixture.root, "resume-inspect");
      try {
        startServer(fixture);
        const id = "20261123-100001";
        const ticket = join(fixture.store, `${id}.md`);
        seedLockedTicket(fixture, id, "previous");
        const original = statSync(ticket, { bigint: true });
        const ownerFile = join(fixture.sessions, `${ownerId}.jsonl`);
        const [header, ...updates] = lockHistoryRecords(fixture.cwd, ticket, ownerId, "11");
        writeFileSync(ownerFile, jsonl([header!]));
        const probeLog = inspectionStub(fixture, { pausePreflight: gate });

        const started = cli(fixture, ["dispatch", "start", "--status", "locked"]);
        assert.equal(started.status, 0, started.stderr);
        await waitFor(() => existsSync(probeLog), "initial owner probe did not begin");
        assert.equal(readFileSync(probeLog, "utf8"), "preflight previous\n");

        appendFileSync(ownerFile, jsonl(updates));
        writeFileSync(gate, "");
        await waitFinished(fixture);

        const logs = readFileSync(probeLog, "utf8");
        const recordPath = join(fixture.records, `${id}.json`);
        if (ownerId === "present") {
          assert.equal(logs, "preflight previous\npreflight present\n");
          assert.equal(existsSync(recordPath), false);
        } else {
          assert.equal(logs, "preflight previous\npreflight new-owner\natomic new-owner\n");
          const record = JSON.parse(readFileSync(recordPath, "utf8"));
          const assignment = JSON.parse(record.args[1].split("```json\n")[1].split("\n```")[0]);
          assert.equal(assignment.ownerId, ownerId);
          assert.equal(assignment.ownerSessionFile, ownerFile);
        }
        const unchanged = statSync(ticket, { bigint: true });
        assert.equal(unchanged.ino, original.ino);
        assert.equal(unchanged.ctimeNs, original.ctimeNs);
      } finally {
        writeFileSync(gate, "");
        isolatedTmux(fixture.socket, ["kill-server"]);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS + 5000,
  );

  it("does not send an atomic launch for a ticket closed after preflight", async () => {
    const fixture = setup();
    try {
      startServer(fixture);
      const id = "20261123-100001";
      seedLockedTicket(fixture, id, "previous");
      const probeLog = inspectionStub(fixture, { changingTicket: { id, close: true } });
      const started = cli(fixture, ["dispatch", "start", "--status", "locked"]);
      assert.equal(started.status, 0, started.stderr);
      await waitFinished(fixture);
      assert.equal(readFileSync(probeLog, "utf8"), "preflight previous\n");
      assert.equal(existsSync(join(fixture.records, "launches")), false);
    } finally {
      isolatedTmux(fixture.socket, ["kill-server"]);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("releases the shared slot on a locked ticket status change without stopping its pi", async () => {
    const fixture = setup();
    const id = "20261123-100001";
    const openId = "a";
    const env = { ...fixture.env, STUB_HOLD_ID: id };
    try {
      startServer(fixture, env);
      inspectionStub(fixture);
      seedLockedTicket(fixture, id, "departed");
      writeTicket(fixture.store, openId, "open");
      const started = cli(
        fixture,
        ["dispatch", "start", "--status", "locked", "--status", "open", "--max", "1"],
        fixture.cwd,
        env,
      );
      assert.equal(started.status, 0, started.stderr);

      const lockedRecord = join(fixture.records, `${id}.json`);
      const openRecord = join(fixture.records, `${openId}.json`);
      await waitFor(() => existsSync(lockedRecord), "locked pi did not start");
      assert.equal(existsSync(openRecord), false);
      const closed = cli(fixture, ["set", id, '{"status":"closed"}'], fixture.cwd, env);
      assert.equal(closed.status, 0, closed.stderr);
      await waitFor(() => existsSync(openRecord), "ticket status did not release the slot");
      await waitFinished(fixture);
      assert.equal(readFileSync(join(fixture.records, "launches"), "utf8"), `${id}\n${openId}\n`);
      assert.equal(isolatedTmux(fixture.socket, ["has-session", "-t", `=handle_${id}`]).status, 0);
      const marker = isolatedTmux(fixture.socket, [
        "show-environment",
        "-t",
        `=handle_${id}`,
        "TICKET_DISPATCH_INSPECTION",
      ]);
      assert.notEqual(marker.status, 0);
    } finally {
      isolatedTmux(fixture.socket, ["kill-server"]);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves an existing tmux session and does not retry the atomic name collision", async () => {
    const fixture = setup();
    try {
      startServer(fixture);
      const id = "20261123-100001";
      const ticket = join(fixture.store, `${id}.md`);
      const original = lockedTicket(id);
      seedLockedTicket(fixture, id, "departed");
      const probeLog = inspectionStub(fixture);
      const name = `handle_${id}`;
      const collision = isolatedTmux(fixture.socket, [
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{session_id}",
        "-s",
        name,
        "sleep 60",
      ]);
      assert.equal(collision.status, 0, collision.stderr);
      const started = cli(fixture, ["dispatch", "start", "--status", "locked"]);
      assert.equal(started.status, 0, started.stderr);
      await waitFinished(fixture);
      assert.equal(readFileSync(probeLog, "utf8"), "preflight departed\natomic departed\n");
      const live = isolatedTmux(fixture.socket, [
        "list-sessions",
        "-F",
        "#{session_name}:#{session_id}",
      ]);
      assert.ok(live.stdout.split("\n").includes(`${name}:${collision.stdout.trim()}`));
      assert.equal(existsSync(join(fixture.records, "launches")), false);
      assert.equal(readFileSync(ticket, "utf8"), original);
    } finally {
      isolatedTmux(fixture.socket, ["kill-server"]);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

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
        assert.deepEqual(recorded, { args: ["--", expected], cwd });
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
        const result = cli(fixture, ["dispatch", ...action, flag, project], caller, env);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `dispatcher started: ${dispatcherName(project)}\n`);
        await waitFor(() => existsSync(join(records, "a.v1.json")), "target pi did not start");
        assert.equal(readFileSync(join(records, "launches"), "utf8"), "a.v1\n");
        assert.deepEqual(JSON.parse(readFileSync(join(records, "a.v1.json"), "utf8")), {
          args: ["--", expectedPrompt("a.v1")],
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
        for (const result of results) {
          assert.equal(result.code, 0, result.stderr);
          assert.match(result.stdout, /dispatcher (started|restarted):/);
        }
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
    "applies the new --max when restarting a running dispatcher",
    async () => {
      const fixture = setup();
      const { root, cwd, store, socket, records } = fixture;
      const env = { ...fixture.env, STUB_WAIT: "1" };
      try {
        writeTicket(store, "a.v1", "open");
        writeTicket(store, "b.v2", "open");
        startServer(fixture, env);
        const first = cli(fixture, ["dispatch", "start", "--max", "1"]);
        assert.equal(first.status, 0, first.stderr);
        assert.match(first.stdout, /dispatcher started:/);
        await waitFor(
          () => existsSync(join(records, "a.v1.json")),
          "first dispatcher did not launch a.v1",
        );
        await Bun.sleep(150);
        assert.equal(readFileSync(join(records, "launches"), "utf8"), "a.v1\n");
        const second = cli(fixture, ["dispatch", "start", "--max", "2"]);
        assert.equal(second.status, 0, second.stderr);
        assert.match(second.stdout, /dispatcher restarted:/);
        await waitFor(
          () => existsSync(join(records, "b.v2.json")),
          "restarted dispatcher did not apply the new max",
        );
        assert.equal(readFileSync(join(records, "launches"), "utf8"), "a.v1\nb.v2\n");
        assert.equal(cli(fixture, ["dispatch", "stop"]).status, 0);
        assert.equal(isolatedTmux(socket, ["has-session", "-t", "=handle_a_v1"]).status, 0);
        assert.equal(isolatedTmux(socket, ["has-session", "-t", "=handle_b_v2"]).status, 0);
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
            args: ["--", expected],
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
        const start = cli(fixture, ["dispatch", "start", "--max", "1"], cwd, env);
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
            args: ["--", expectedPrompt(id)],
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
        const first = cli(fixture, ["dispatch", "start", "--max", "2"], cwd, env);
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
        assert.match(duplicate.stdout, /dispatcher restarted:/);
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
          ["dispatch", "start", ...(explicitProject ? ["-p", "project"] : []), "--max", "1"],
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
          args: ["--", expectedPrompt("c")],
          cwd: launchCwd,
        });
        assert.deepEqual(JSON.parse(readFileSync(join(records, "a.v1.json"), "utf8")), {
          args: ["--", expectedPrompt("a.v1")],
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
          args: ["--", expectedPrompt(id!)],
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
          args: ["--", expectedPrompt("first")],
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
      assert.match(duplicate.stdout, /dispatcher restarted:/);
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

  it.each(["file", "inaccessible"])("fails before any pi launch for a %s candidate cwd", (kind) => {
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
  });

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
      assert.equal(cli(fixture, ["dispatch", "--all", "--max", "1"]).status, 0);
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
      assert.equal(cli(fixture, ["dispatch", "--all", "--max", "1"]).status, 0);
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

function oneArgs(project: string, id: string): string[] {
  return ["dispatch", "one", "--project", project, id];
}

async function concurrentCli(fixture: Fixture, commands: string[][]) {
  const children = commands.map((args) =>
    Bun.spawn([...cliCommand(), ...args], {
      cwd: fixture.cwd,
      env: fixture.env,
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  return Promise.all(
    children.map(async (child) => ({
      code: await child.exited,
      stderr: await new Response(child.stderr).text(),
    })),
  );
}

async function waitDispatchLog(fixture: Fixture, name: string, message: string) {
  await waitFor(
    () =>
      isolatedTmux(fixture.socket, ["capture-pane", "-p", "-t", `=${name}:0.0`]).stdout.includes(
        message,
      ),
    `missing dispatcher log: ${message}`,
  );
}

function tmuxSessionId(fixture: Fixture, name: string): string {
  return isolatedTmux(fixture.socket, [
    "display-message",
    "-p",
    "-t",
    `=${name}:0.0`,
    "#{session_id}",
  ]).stdout.trim();
}

describe("manual ticket dispatch", () => {
  it.each([false, true])(
    "exceeds max manually and waits for two releases before auto refill (global=%s)",
    async (all) => {
      const fixture = setupGlobal();
      const { socket, store } = fixture;
      const manualProject = all ? "beta" : "alpha";
      const manualStore = globalStore(fixture, manualProject);
      const manualKey = `${manualProject}/c`;
      writeTicket(store, "a", "open");
      writeTicket(store, "b", "open");
      writeTicket(manualStore, "c", "open");
      startServer(fixture);
      const flags = all ? ["--all"] : [];
      const worker = dispatcherName(all ? null : "alpha");
      const started = cli(fixture, ["dispatch", "start", ...flags, "--max", "1"]);
      assert.equal(started.status, 0, started.stderr);
      await waitRecorded(fixture, "alpha/a");
      const workerSession = tmuxSessionId(fixture, worker);
      const autoDuplicate = cli(fixture, oneArgs("alpha", "a"));
      assert.equal(autoDuplicate.status, 1);
      assert.match(autoDuplicate.stderr, /ticket already running/);

      const manual = cli(fixture, oneArgs(manualProject, "c"));
      assert.equal(manual.status, 0, manual.stderr);
      await waitRecorded(fixture, manualKey);
      const manualName = sessionName("handle_", manualKey, true);
      assert.notEqual(tmuxSessionId(fixture, manualName), "");
      assert.deepEqual(recordedLaunches(fixture), ["alpha/a", manualKey]);
      assert.deepEqual(
        JSON.parse(readFileSync(join(fixture.records, `${manualKey}.json`), "utf8")),
        {
          args: ["--", expectedPrompt("c")],
          cwd: join(fixture.home, "projects", manualProject),
        },
      );

      writeTicket(store, "a", "closed");
      await waitDispatchLog(
        fixture,
        worker,
        all ? "done alpha/a status=closed" : "done a status=closed",
      );
      const duplicate = cli(fixture, oneArgs(manualProject, "c"));
      assert.equal(duplicate.status, 1);
      assert.match(duplicate.stderr, /ticket already running/);
      const queuedName = sessionName("handle_", all ? "alpha/b" : "b", all);
      assert.notEqual(isolatedTmux(socket, ["has-session", "-t", `=${queuedName}`]).status, 0);

      writeTicket(manualStore, "c", "closed");
      await waitRecorded(fixture, "alpha/b");
      assert.deepEqual(recordedLaunches(fixture), ["alpha/a", manualKey, "alpha/b"]);
      assert.equal(tmuxSessionId(fixture, worker), workerSession);
      assert.notEqual(tmuxSessionId(fixture, manualName), "");
    },
    TIMEOUT_MS + 5000,
  );

  it(
    "counts a new session for a previously released ID but never re-adopts the same session",
    async () => {
      const fixture = setupGlobal();
      const { store, socket } = fixture;
      writeTicket(store, "a", "open");
      writeTicket(store, "b", "open");
      writeTicket(store, "c", "open");
      startServer(fixture);
      const started = cli(fixture, ["dispatch", "start", "--max", "1"]);
      assert.equal(started.status, 0, started.stderr);
      await waitRecorded(fixture, "alpha/a");
      const manual = cli(fixture, oneArgs("alpha", "b"));
      assert.equal(manual.status, 0, manual.stderr);
      await waitRecorded(fixture, "alpha/b");
      const manualName = sessionName("handle_", "alpha/b", true);
      const firstSession = tmuxSessionId(fixture, manualName);

      writeTicket(store, "b", "closed");
      const worker = dispatcherName("alpha");
      await waitDispatchLog(fixture, worker, "done b status=closed");
      writeTicket(store, "b", "open");
      writeTicket(store, "a", "closed");
      await waitRecorded(fixture, "alpha/c");

      assert.equal(isolatedTmux(socket, ["kill-session", "-t", `=${manualName}`]).status, 0);
      const retry = cli(fixture, oneArgs("alpha", "b"));
      assert.equal(retry.status, 0, retry.stderr);
      const replacementSession = tmuxSessionId(fixture, manualName);
      assert.notEqual(replacementSession, "");
      assert.notEqual(replacementSession, firstSession);
      await waitFor(
        () => recordedLaunches(fixture).filter((key) => key === "alpha/b").length === 2,
        "replacement pi did not start",
      );

      writeTicket(store, "d", "open");
      writeTicket(store, "c", "closed");
      await waitDispatchLog(fixture, worker, "done c status=closed");
      const duplicate = cli(fixture, oneArgs("alpha", "b"));
      assert.equal(duplicate.status, 1);
      assert.match(duplicate.stderr, /ticket already running/);
      assert.notEqual(isolatedTmux(socket, ["has-session", "-t", "=handle_d"]).status, 0);

      assert.equal(isolatedTmux(socket, ["kill-session", "-t", `=${manualName}`]).status, 0);
      await waitDispatchLog(
        fixture,
        worker,
        "incomplete b status=open session exited without close",
      );
      await waitRecorded(fixture, "alpha/d");
    },
    TIMEOUT_MS + 5000,
  );

  it(
    "starts at most one pi when manual requests race each other and project auto",
    async () => {
      const fixture = setupGlobal();
      writeTicket(fixture.store, "same", "open");
      writeTicket(fixture.store, "z-other", "open");
      startServer(fixture);
      const [first, second, start] = await concurrentCli(fixture, [
        oneArgs("alpha", "same"),
        oneArgs("alpha", "same"),
        ["dispatch", "start", "--project", "alpha"],
      ]);
      assert.ok(first && second && start);
      assert.equal(start.code, 0, start.stderr);
      const rejected = [first, second].filter((entry) => entry.code !== 0);
      assert.ok(rejected.length >= 1);
      for (const entry of rejected) {
        assert.equal(entry.code, 1);
        assert.match(entry.stderr, /ticket already running/);
      }
      await waitRecorded(fixture, "alpha/same");
      await waitRecorded(fixture, "alpha/z-other");
      const duplicate = cli(fixture, oneArgs("alpha", "same"));
      assert.equal(duplicate.status, 1);
      assert.match(duplicate.stderr, /ticket already running/);
      const manualName = sessionName("handle_", "alpha/same", true);
      const sessions = ["handle_same", manualName].filter((name) => tmuxSessionId(fixture, name));
      assert.equal(sessions.length, 1);
      assert.deepEqual(recordedLaunches(fixture).sort(), ["alpha/same", "alpha/z-other"]);
    },
    TIMEOUT_MS + 5000,
  );

  it(
    "starts the same ID independently in each explicitly selected project",
    async () => {
      const fixture = setupGlobal();
      writeTicket(fixture.store, "same", "open");
      writeTicket(globalStore(fixture, "beta"), "same", "open");
      startServer(fixture);
      const results = await concurrentCli(fixture, [
        oneArgs("alpha", "same"),
        oneArgs("beta", "same"),
      ]);
      for (const result of results) assert.equal(result.code, 0, result.stderr);
      await waitRecorded(fixture, "alpha/same");
      await waitRecorded(fixture, "beta/same");
      assert.deepEqual(recordedLaunches(fixture).sort(), ["alpha/same", "beta/same"]);
      assert.equal(cli(fixture, ["dispatch", "list"]).stdout.trim(), "no dispatcher running");
    },
    TIMEOUT_MS + 5000,
  );

  it(
    "starts one pi without an existing tmux server",
    async () => {
      const fixture = setupGlobal();
      writeTicket(fixture.store, "same", "open");
      assert.equal(existsSync(fixture.socket), false);
      const result = cli(fixture, oneArgs("alpha", "same"));
      assert.equal(result.status, 0, result.stderr);
      await waitRecorded(fixture, "alpha/same");
      assert.deepEqual(recordedLaunches(fixture), ["alpha/same"]);
      assert.equal(cli(fixture, ["dispatch", "list"]).stdout.trim(), "no dispatcher running");
    },
    TIMEOUT_MS + 5000,
  );

  it("rejects a manual session-name collision without replacing the existing session", () => {
    const fixture = setupGlobal();
    writeTicket(fixture.store, "same", "open");
    startServer(fixture);
    const name = sessionName("handle_", "alpha/same", true);
    const foreign = isolatedTmux(fixture.socket, ["new-session", "-d", "-s", name, "sleep 60"]);
    assert.equal(foreign.status, 0, foreign.stderr);
    const originalSession = tmuxSessionId(fixture, name);

    const result = cli(fixture, oneArgs("alpha", "same"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /tmux new-session failed/);
    assert.notEqual(originalSession, "");
    assert.equal(tmuxSessionId(fixture, name), originalSession);
    assert.deepEqual(recordedLaunches(fixture), []);
  });

  it("rejects invalid, missing, partial and non-actionable targets without starting tmux", () => {
    const fixture = setupGlobal();
    writeTicket(fixture.store, "real", "open");
    writeTicket(fixture.store, "finished", "closed");
    writeFileSync(join(fixture.store, "dependent.md"), "---\nstatus: open\nafter: real\n---\n");
    const noProject = cli(fixture, ["dispatch", "one", "real"]);
    assert.equal(noProject.status, 2);
    assert.match(noProject.stderr, /usage: ticket dispatch/);

    writeFileSync(join(fixture.home, "projects", "not-dir"), "");
    const cases = [
      { project: "../alpha", id: "real", error: /invalid project/ },
      { project: "missing", id: "real", error: /I\/O error/ },
      { project: "not-dir", id: "real", error: /I\/O error/ },
      { project: "alpha", id: "rea", error: /ticket not found/ },
      { project: "alpha", id: "missing", error: /ticket not found/ },
      { project: "alpha", id: "finished", error: /not actionable/ },
      { project: "alpha", id: "dependent", error: /not actionable/ },
    ];
    for (const { project, id, error } of cases) {
      const result = cli(fixture, oneArgs(project, id));
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, error);
    }
    assert.equal(existsSync(fixture.socket), false);
    assert.deepEqual(recordedLaunches(fixture), []);
  });
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
          args: ["--", expectedPrompt("second")],
          cwd: join(fixture.home, "projects", project),
        },
      );
      assert.equal(cli(fixture, ["set", "second", '{"status":"closed"}', "-p", project]).status, 0);
      await waitGlobalFinished(fixture);
    },
    TIMEOUT_MS + 5000,
  );
});
