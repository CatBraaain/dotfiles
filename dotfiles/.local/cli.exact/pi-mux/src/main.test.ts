import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseOperation, type StateSource } from "./main";

const source = join(import.meta.dir, "main.ts");
const realTmux = Bun.which("tmux");
const temporaryRoot = "/tmp/work/dotfiles/fix-pi-mux-close-missing-session";

type Failure = "none" | "legacy-missing-session" | "session-cleanup" | "restore-marker";

class CloseFixture {
  readonly directory: string;
  readonly socket: string;
  readonly cwd: string;
  readonly id = randomUUID();
  readonly otherId = randomUUID();
  readonly restore: string;
  readonly conversation: string;
  readonly env: Record<string, string>;
  readonly conversationBefore = "saved conversation sentinel\n";
  readonly generation = randomUUID();
  readonly launchToken = randomUUID();
  pid = 0;

  constructor(failure: Failure) {
    assert.ok(realTmux, "tmux must be installed for the isolated close tests");
    mkdirSync(temporaryRoot, { recursive: true });
    this.directory = mkdtempSync(join(temporaryRoot, "test-"));
    this.socket = join(this.directory, "runtime/pi-tmux/server.sock");
    this.cwd = join(this.directory, "workspace");
    this.restore = join(this.directory, "agent/pi-tmux/pi-mux-restore.json");
    this.conversation = join(this.directory, "agent/sessions/conversation.jsonl");
    this.env = {
      PATH: `${join(this.directory, "bin")}:${process.env.PATH ?? ""}`,
      HOME: join(this.directory, "home"),
      XDG_RUNTIME_DIR: join(this.directory, "runtime"),
      PI_CODING_AGENT_DIR: join(this.directory, "agent"),
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
    };
    for (const directory of [
      "bin",
      "home/.config/tmux",
      "runtime/pi-tmux",
      "agent/pi-tmux",
      "agent/sessions",
      "agent/extensions/pi-mux-bridge",
      "workspace",
    ])
      mkdirSync(join(this.directory, directory), { recursive: true, mode: 0o700 });
    writeFileSync(join(this.directory, "agent/extensions/pi-mux-bridge/index.ts"), "");
    const sessionError =
      failure === "legacy-missing-session" ? "can't find session:" : "permission denied:";
    writeFileSync(
      join(this.directory, "bin/tmux"),
      `#!/bin/sh
if [ "$1" != -S ] || [ "$2" != ${JSON.stringify(this.socket)} ]; then exit 64; fi
if [ "$5" = set-environment ] && [ "$6" = -u ] && [ ${JSON.stringify(failure)} != none ] && [ ${JSON.stringify(failure)} != restore-marker ]; then
  printf '%s %s\\n' ${JSON.stringify(sessionError)} "$8" >&2
  exit 1
fi
if [ "$5" = set-option ] && [ "$6" = -gu ] && [ ${JSON.stringify(failure)} = restore-marker ]; then
  printf '%s\\n' 'restore marker denied' >&2
  exit 1
fi
exec ${JSON.stringify(realTmux)} "$@"
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(this.directory, "home/.config/tmux/pi.conf"),
      "set -g exit-empty off\nset -g remain-on-exit off\n",
    );
    writeFileSync(this.conversation, this.conversationBefore);
    writeFileSync(
      this.restore,
      JSON.stringify({
        version: 1,
        generation: this.generation,
        workspaces: [{ cwd: this.cwd, sessions: [this.id, this.otherId] }],
      }),
    );
  }

  start(): void {
    const [session, pane, pid] = this.tmux([
      "new-session",
      "-d",
      "-s",
      "target",
      "-c",
      this.cwd,
      "-P",
      "-F",
      "#{session_id}\t#{pane_id}\t#{pane_pid}",
      "/bin/sleep",
      "300",
    ]).split("\t");
    assert.ok(session && pane && pid);
    this.pid = Number(pid);
    this.tmux(["set-option", "-g", "@pi-mux-generation", this.generation]);
    this.tmux(["set-environment", "-t", session, "PI_TMUX_SESSION_ID", this.id]);
    this.tmux([
      "set-option",
      "-p",
      "-t",
      pane,
      "@pi-tmux-session",
      Buffer.from(
        JSON.stringify({
          id: this.id,
          cwd: this.cwd,
          file: this.conversation,
          pid: this.pid,
          startup: "ready",
          token: this.launchToken,
        }),
      ).toString("base64"),
    ]);
  }

  tmux(args: string[]): string {
    const result = spawnSync(
      realTmux!,
      ["-S", this.socket, "-f", join(this.directory, "home/.config/tmux/pi.conf"), ...args],
      { env: this.env, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }

  close() {
    return spawnSync(process.execPath, ["run", source, "close", this.id], {
      cwd: this.cwd,
      env: this.env,
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  snapshot(): { generation: string; workspaces: { cwd: string; sessions: string[] }[] } {
    return JSON.parse(readFileSync(this.restore, "utf8"));
  }

  async cleanup(): Promise<void> {
    spawnSync(realTmux!, ["-S", this.socket, "kill-server"], {
      env: this.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    const deadline = Date.now() + 2_000;
    while (existsSync(`/proc/${this.pid}`) && Date.now() < deadline) await Bun.sleep(10);
    assert.equal(existsSync(`/proc/${this.pid}`), false);
    const server = spawnSync(realTmux!, ["-S", this.socket, "display-message", "-p", "#{pid}"], {
      env: this.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(server.error, undefined);
    assert.equal(server.status, 1, server.stderr);
    rmSync(this.directory, { recursive: true, force: true });
  }
}

describe("close cleanup", () => {
  for (const failure of ["none", "legacy-missing-session"] as const) {
    it(`removes only the target candidate after its tmux session disappears (${failure})`, async () => {
      const fixture = new CloseFixture(failure);
      try {
        fixture.start();
        const serverPid = fixture.tmux(["display-message", "-p", "#{pid}"]);
        const result = fixture.close();
        const snapshot = fixture.snapshot();
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.signal, null);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "");
        assert.equal(existsSync(`/proc/${fixture.pid}`), false);
        assert.equal(fixture.tmux(["list-sessions", "-F", "#{session_id}"]), "");
        assert.equal(fixture.tmux(["display-message", "-p", "#{pid}"]), serverPid);
        assert.equal(
          fixture.tmux(["show-option", "-gqv", "@pi-mux-generation"]),
          fixture.generation,
        );
        assert.deepEqual(snapshot.workspaces, [{ cwd: fixture.cwd, sessions: [fixture.otherId] }]);
        assert.equal(snapshot.generation, fixture.generation);
        assert.equal(readFileSync(fixture.conversation, "utf8"), fixture.conversationBefore);
      } finally {
        await fixture.cleanup();
      }
    });
  }

  for (const failure of ["session-cleanup", "restore-marker"] as const) {
    it(`reports ${failure} failure and keeps restore candidates`, async () => {
      const fixture = new CloseFixture(failure);
      try {
        fixture.start();
        const before = readFileSync(fixture.restore, "utf8");
        const result = fixture.close();
        const expectedError =
          failure === "session-cleanup"
            ? "Cannot clear managed session"
            : "Cannot clear restore target";
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        assert.equal(result.signal, null);
        assert.equal(result.stdout, "");
        assert.ok(result.stderr.includes(`Cannot close session ${fixture.id}: ${expectedError}`));
        assert.ok(
          result.stderr.includes(
            failure === "session-cleanup" ? "permission denied:" : "restore marker denied",
          ),
        );
        assert.equal(existsSync(`/proc/${fixture.pid}`), false);
        assert.equal(readFileSync(fixture.restore, "utf8"), before);
        assert.equal(readFileSync(fixture.conversation, "utf8"), fixture.conversationBefore);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

function stateSource(fixture: CloseFixture) {
  const [serverPid, pane] = fixture
    .tmux(["display-message", "-p", "#{pid}\t#{pane_id}"])
    .split("\t");
  return {
    socket: fixture.socket,
    serverPid: Number(serverPid),
    pane: pane!,
    pid: fixture.pid,
    token: fixture.launchToken,
  };
}

function notify(fixture: CloseFixture, args: string[], origin: StateSource = stateSource(fixture)) {
  return spawnSync(
    process.execPath,
    ["run", source, "state", fixture.id, ...args, "--source", JSON.stringify(origin)],
    {
      cwd: fixture.cwd,
      env: fixture.env,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

function lastRunLine(sessionId: string, run: { atMs: number; aborted: boolean | string }): string {
  return (
    JSON.stringify({
      type: "custom",
      customType: "pi-mux-last-run",
      data: { sessionId, ...run },
    }) + "\n"
  );
}

function publicState(fixture: CloseFixture): string {
  return fixture.tmux(["show-options", "-pqv", "@pi_session_state"]);
}

function pendingState(fixture: CloseFixture): string {
  return fixture.tmux(["show-options", "-pqv", "@pi_session_state_pending"]);
}

function runActiveList(fixture: CloseFixture) {
  return spawnSync(process.execPath, ["run", source, "list", "--active", "--json"], {
    cwd: fixture.cwd,
    env: fixture.env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

async function holdSharedLock(
  fixture: { directory: string },
  lock: ReturnType<typeof createServer>,
) {
  const key = createHash("sha256").update(join(fixture.directory, "agent/pi-tmux")).digest("hex");
  await new Promise<void>((resolve, reject) => {
    lock.once("error", reject);
    lock.listen(`\0pi-mux-${process.getuid!()}-${key}`, resolve);
  });
  return lock;
}

describe("state notifications", () => {
  for (const failure of ["metadata", "owner"] as const) {
    it(`fails closed when ${failure} inspection fails and recovers on retry`, async () => {
      const fixture = new CloseFixture("none");
      try {
        fixture.start();
        assert.equal(notify(fixture, ["running", "--title", "null"]).status, 0);
        const before = publicState(fixture);
        const failing = join(fixture.directory, "guard-failure");
        const observed = join(fixture.directory, "guard-failure-observed");
        const option = failure === "owner" ? "@pi-mux-state-source" : "@pi-tmux-session";
        const query = failure === "owner" ? "show-options" : "list-panes";
        const condition = `case "$*" in *${query}*${option}*) true;; *) false;; esac`;
        const wrapper = join(fixture.directory, "bin/tmux");
        rmSync(wrapper, { force: true });
        writeFileSync(
          wrapper,
          `#!/bin/sh
if [ -e ${JSON.stringify(failing)} ] && { ${condition}; }; then
  touch ${JSON.stringify(observed)}
  exit 1
fi
exec ${JSON.stringify(realTmux)} "$@"
`,
          { mode: 0o700 },
        );
        writeFileSync(failing, "fail");
        const args = failure === "owner" ? ["--clear"] : ["waiting-user", "--title", "null"];
        const failed = notify(fixture, args);
        assert.equal(
          existsSync(observed),
          true,
          "the guarded command must encounter the injected failure",
        );
        assert.equal(failed.status, 1, failed.stderr);
        assert.equal(existsSync(`/proc/${fixture.pid}`), true);
        assert.equal(publicState(fixture), before);
        rmSync(failing);
        const recovered = notify(fixture, args);
        assert.equal(recovered.status, 0, recovered.stderr);
        if (failure === "owner") assert.equal(publicState(fixture), "");
        else assert.equal(JSON.parse(publicState(fixture)).state, "waiting-user");
      } finally {
        await fixture.cleanup();
      }
    });
  }

  it("fails closed when the write acknowledgement is missing", async () => {
    const fixture = new CloseFixture("none");
    try {
      fixture.start();
      assert.equal(notify(fixture, ["waiting-user", "--title", "null"]).status, 0);
      const before = publicState(fixture);
      const wrapper = join(fixture.directory, "bin/tmux");
      rmSync(wrapper);
      writeFileSync(
        wrapper,
        `#!/bin/sh
if [ "$5" = source-file ] && [ "$6" = - ]; then cat >/dev/null; exit 0; fi
exec ${JSON.stringify(realTmux)} "$@"
`,
        { mode: 0o700 },
      );
      for (const args of [["running", "--title", "null"], ["--clear"]]) {
        const result = notify(fixture, args);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /Cannot confirm session state update/);
        assert.equal(publicState(fixture), before);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a stale source and keeps the replacement pane untouched when the server swaps right before the write", async () => {
    const fixture = new CloseFixture("none");
    try {
      fixture.start();
      const wrapper = join(fixture.directory, "bin/tmux");
      rmSync(wrapper);
      writeFileSync(
        wrapper,
        `#!/bin/sh
if [ "$1" != -S ] || [ "$2" != ${JSON.stringify(fixture.socket)} ]; then exit 64; fi
if [ "$5" = source-file ] && [ "$6" = - ]; then
  input=$(cat)
  case "$input" in
    *"@pi-mux-state-source"*)
      ${JSON.stringify(realTmux)} -S ${JSON.stringify(fixture.socket)} kill-server
      ${JSON.stringify(realTmux)} -S ${JSON.stringify(fixture.socket)} -f ${JSON.stringify(join(fixture.directory, "home/.config/tmux/pi.conf"))} new-session -d -s swapped sleep 300
      pane=$(${JSON.stringify(realTmux)} -S ${JSON.stringify(fixture.socket)} display-message -p -t swapped '#{pane_id}')
      ppid=$(${JSON.stringify(realTmux)} -S ${JSON.stringify(fixture.socket)} display-message -p -t swapped '#{pane_pid}')
      ${JSON.stringify(realTmux)} -S ${JSON.stringify(fixture.socket)} set-option -p -t "$pane" '@pi-tmux-session' "$(printf '%s' '{"id":"${fixture.id}","cwd":"${fixture.cwd}","file":"${fixture.conversation}","pid":'"$ppid"',"startup":"ready"}' | base64 | tr -d '\\n')"
      ${JSON.stringify(realTmux)} -S ${JSON.stringify(fixture.socket)} set-option -p -t "$pane" '@pi_session_state' '{"version":1,"sessionId":"sentinel","state":"waiting-user","title":"new server"}'
      printf '%s' "$input" | ${JSON.stringify(realTmux)} "$@"
      exit $? ;;
  esac
  printf '%s' "$input" | ${JSON.stringify(realTmux)} "$@"
  exit $?
fi
exec ${JSON.stringify(realTmux)} "$@"
`,
        { mode: 0o700 },
      );
      const origin = stateSource(fixture);
      const result = notify(
        fixture,
        ["waiting-approval", "--title", JSON.stringify("stale notification")],
        origin,
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Cannot verify source/);
      const pane = fixture.tmux(["display-message", "-p", "-t", "swapped", "#{pane_id}"]);
      assert.deepEqual(
        JSON.parse(fixture.tmux(["show-options", "-pqv", "-t", pane, "@pi_session_state"])),
        {
          version: 1,
          sessionId: "sentinel",
          state: "waiting-user",
          title: "new server",
        },
      );
      assert.equal(fixture.tmux(["show-options", "-pqv", "-t", pane, "@pi-mux-state-source"]), "");
    } finally {
      await fixture.cleanup();
    }
  });

  it("publishes and clears in an uninitialized external server without changing the restore record", async () => {
    const fixture = new CloseFixture("none");
    try {
      fixture.start();
      fixture.tmux(["set-option", "-gu", "@pi-mux-generation"]);
      const before = readFileSync(fixture.restore, "utf8");
      const title = "Quotes ' \"\n #{pane_id}; $(touch /unsafe)";
      const lastRun = { atMs: 1735689600000, aborted: true };
      writeFileSync(
        fixture.conversation,
        JSON.stringify({ type: "session", id: fixture.id }) +
          "\n" +
          lastRunLine(fixture.id, lastRun),
      );
      for (const state of ["waiting-user", "running", "waiting-approval"] as const) {
        const result = notify(fixture, [state, "--title", JSON.stringify(title)]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout + result.stderr, "");
        assert.deepEqual(JSON.parse(publicState(fixture)), {
          version: 1,
          sessionId: fixture.id,
          state,
          title,
          ...(state === "waiting-user" ? { lastRun } : {}),
        });
      }
      assert.equal(readFileSync(fixture.restore, "utf8"), before);
      assert.equal(fixture.tmux(["show-options", "-gqv", "@pi-mux-generation"]), "");
      const cleared = notify(fixture, ["--clear"]);
      assert.equal(cleared.status, 0, cleared.stderr);
      assert.equal(publicState(fixture), "");
    } finally {
      await fixture.cleanup();
    }
  });

  it("publishes waiting-user and title when lastRun cannot be obtained", async () => {
    const fixture = new CloseFixture("none");
    try {
      fixture.start();
      const title = "Still waiting";
      const run = lastRunLine(fixture.id, { atMs: 1, aborted: false });
      const cases = [
        { name: "invalid header", conversation: "{}\n" + run },
        { name: "foreign header", conversation: '{"type":"session","id":"foreign"}\n' + run },
        {
          name: "no valid run",
          conversation:
            JSON.stringify({ type: "session", id: fixture.id }) +
            "\n" +
            lastRunLine("foreign", { atMs: 1, aborted: false }) +
            lastRunLine(fixture.id, { atMs: 0, aborted: false }),
        },
        { name: "missing file", conversation: undefined },
      ];
      for (const { name, conversation } of cases) {
        if (conversation === undefined) rmSync(fixture.conversation);
        else writeFileSync(fixture.conversation, conversation);
        const result = notify(fixture, ["waiting-user", "--title", JSON.stringify(title)]);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(
          JSON.parse(publicState(fixture)),
          {
            version: 1,
            sessionId: fixture.id,
            state: "waiting-user",
            title,
          },
          name,
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("publishes running, marks the pending publication, and returns 75 when another operation holds the shared lock", async () => {
    const fixture = new CloseFixture("none");
    const lock = createServer();
    try {
      fixture.start();
      await holdSharedLock(fixture, lock);
      const before = readFileSync(fixture.restore, "utf8");
      const result = notify(fixture, ["running", "--title", "null"]);
      assert.equal(result.status, 75, result.stderr);
      assert.match(result.stderr, /lock/);
      assert.deepEqual(JSON.parse(publicState(fixture)), {
        version: 1,
        sessionId: fixture.id,
        state: "running",
        title: null,
      });
      const marked = JSON.parse(pendingState(fixture));
      assert.equal(marked.version, 1);
      assert.equal(marked.sessionId, fixture.id);
      assert.ok(
        typeof marked.attemptAt === "number" &&
          Number.isSafeInteger(marked.attemptAt) &&
          marked.attemptAt > 0,
        "attemptAt must be a positive integer",
      );
      assert.equal(readFileSync(fixture.restore, "utf8"), before);
    } finally {
      if (lock?.listening) await new Promise<void>((resolve) => lock.close(() => resolve()));
      await fixture.cleanup();
    }
  });

  it("completes waiting, approval, and clear while another operation holds the shared lock", async () => {
    const fixture = new CloseFixture("none");
    const lock = createServer();
    try {
      fixture.start();
      await holdSharedLock(fixture, lock);
      const before = readFileSync(fixture.restore, "utf8");
      const deferred = notify(fixture, ["running", "--title", "null"]);
      assert.equal(deferred.status, 75, deferred.stderr);
      assert.ok(pendingState(fixture), "contention must mark the pending publication");
      const waiting = notify(fixture, [
        "waiting-user",
        "--title",
        JSON.stringify("Waiting under contention"),
      ]);
      assert.equal(waiting.status, 0, waiting.stderr);
      assert.deepEqual(JSON.parse(publicState(fixture)), {
        version: 1,
        sessionId: fixture.id,
        state: "waiting-user",
        title: "Waiting under contention",
      });
      assert.ok(pendingState(fixture), "waiting notifications must not change the pending mark");
      const approval = notify(fixture, ["waiting-approval", "--title", "null"]);
      assert.equal(approval.status, 0, approval.stderr);
      assert.deepEqual(JSON.parse(publicState(fixture)), {
        version: 1,
        sessionId: fixture.id,
        state: "waiting-approval",
        title: null,
      });
      assert.ok(pendingState(fixture), "approval notifications must not change the pending mark");
      const cleared = notify(fixture, ["--clear"]);
      assert.equal(cleared.status, 0, cleared.stderr);
      assert.equal(publicState(fixture), "");
      assert.equal(pendingState(fixture), "", "clear must remove the pending mark");
      assert.equal(readFileSync(fixture.restore, "utf8"), before);
    } finally {
      if (lock?.listening) await new Promise<void>((resolve) => lock.close(() => resolve()));
      await fixture.cleanup();
    }
  });

  it("relays the deferred running publication through list and clears it after the lock part succeeds", async () => {
    const fixture = new CloseFixture("none");
    const lock = createServer();
    try {
      fixture.start();
      fixture.tmux(["set-environment", "-t", "target", "PI_TMUX_TEMPORARY", fixture.id]);
      fixture.tmux(["set-option", "-g", `@pi-mux-restoring-${fixture.otherId}`, "1"]);
      await holdSharedLock(fixture, lock);
      const deferred = notify(fixture, ["running", "--title", "null"]);
      assert.equal(deferred.status, 75, deferred.stderr);
      assert.ok(pendingState(fixture), "contention must mark the pending publication");
      const deferredListing = runActiveList(fixture);
      assert.equal(deferredListing.status, 0, deferredListing.stderr);
      const deferredSession = JSON.parse(deferredListing.stdout)[0].sessions.find(
        (entry: { id: string }) => entry.id === fixture.id,
      );
      assert.equal(deferredSession.state, "running");
      assert.ok(
        Number.isSafeInteger(deferredSession.publishPending?.attemptAt) &&
          deferredSession.publishPending.attemptAt > 0,
        "list must relay the pending attempt time",
      );
      assert.equal(deferredSession.temporary, true);
      if (lock.listening) await new Promise<void>((resolve) => lock.close(() => resolve()));
      const repaired = notify(fixture, ["running", "--title", "null"]);
      assert.equal(repaired.status, 0, repaired.stderr);
      assert.equal(pendingState(fixture), "");
      const repairedListing = runActiveList(fixture);
      assert.equal(repairedListing.status, 0, repairedListing.stderr);
      const repairedSession = JSON.parse(repairedListing.stdout)[0].sessions.find(
        (entry: { id: string }) => entry.id === fixture.id,
      );
      assert.equal(repairedSession.publishPending, null);
      assert.equal(repairedSession.temporary, undefined);
    } finally {
      if (lock?.listening) await new Promise<void>((resolve) => lock.close(() => resolve()));
      await fixture.cleanup();
    }
  });

  it("relays only a valid pending publication through list and returns null otherwise", async () => {
    const fixture = new CloseFixture("none");
    try {
      fixture.start();
      const pane = fixture.tmux(["display-message", "-p", "#{pane_id}"]);
      const entryOf = (listing: string) =>
        JSON.parse(listing)[0].sessions.find((entry: { id: string }) => entry.id === fixture.id);
      const attemptAt = 1735689600000;
      const invalid = [
        "{broken",
        JSON.stringify({ version: 2, sessionId: fixture.id, attemptAt }),
        JSON.stringify({ version: 1, sessionId: "other-session", attemptAt }),
        JSON.stringify({ version: 1, sessionId: fixture.id, attemptAt: 0 }),
        JSON.stringify({ version: 1, sessionId: fixture.id, attemptAt: -5 }),
        JSON.stringify({ version: 1, sessionId: fixture.id, attemptAt: 1.5 }),
        JSON.stringify({ version: 1, sessionId: fixture.id, attemptAt: String(attemptAt) }),
        JSON.stringify({ version: 1, sessionId: fixture.id }),
      ];
      for (const value of invalid) {
        fixture.tmux(["set-option", "-p", "-t", pane, "@pi_session_state_pending", value]);
        const listing = runActiveList(fixture);
        assert.equal(listing.status, 0, listing.stderr);
        assert.equal(
          entryOf(listing.stdout).publishPending,
          null,
          `invalid value must resolve to null: ${value}`,
        );
      }
      fixture.tmux([
        "set-option",
        "-p",
        "-t",
        pane,
        "@pi_session_state_pending",
        JSON.stringify({ version: 1, sessionId: fixture.id, attemptAt }),
      ]);
      const valid = runActiveList(fixture);
      assert.equal(valid.status, 0, valid.stderr);
      assert.deepEqual(entryOf(valid.stdout).publishPending, { attemptAt });
      fixture.tmux(["set-option", "-pu", "-t", pane, "@pi_session_state_pending"]);
      const cleared = runActiveList(fixture);
      assert.equal(cleared.status, 0, cleared.stderr);
      assert.equal(entryOf(cleared.stdout).publishPending, null);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not promote on waiting, title changes, or clear, then promotes running and records it", async () => {
    const fixture = new CloseFixture("none");
    try {
      fixture.start();
      fixture.tmux(["set-environment", "-t", "target", "PI_TMUX_TEMPORARY", fixture.id]);
      fixture.tmux(["set-option", "-g", `@pi-mux-restoring-${fixture.otherId}`, "1"]);
      for (const state of ["waiting-user", "waiting-approval"]) {
        const result = notify(fixture, [state, "--title", JSON.stringify("Browsing")]);
        assert.equal(result.status, 0, result.stderr);
      }
      assert.equal(notify(fixture, ["--clear"]).status, 0);
      assert.equal(
        fixture.tmux(["show-environment", "-t", "target", "PI_TMUX_TEMPORARY"]),
        `PI_TMUX_TEMPORARY=${fixture.id}`,
      );
      const snapshot = spawnSync(process.execPath, [source, "snapshot"], {
        env: fixture.env,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(snapshot.status, 0, snapshot.stderr);
      assert.deepEqual(fixture.snapshot().workspaces, [
        { cwd: fixture.cwd, sessions: [fixture.otherId] },
      ]);
      const running = notify(fixture, ["running", "--title", "null"]);
      assert.equal(running.status, 0, running.stderr);
      assert.deepEqual(
        fixture.snapshot().workspaces[0]!.sessions.sort(),
        [fixture.id, fixture.otherId].sort(),
      );
      const waiting = notify(fixture, ["waiting-user", "--title", "null"]);
      assert.equal(waiting.status, 0, waiting.stderr);
      assert.deepEqual(
        fixture.snapshot().workspaces[0]!.sessions.sort(),
        [fixture.id, fixture.otherId].sort(),
      );
      assert.ok(existsSync(`/proc/${fixture.pid}`));
    } finally {
      await fixture.cleanup();
    }
  });

  it("repairs a partial promotion on an equal running notification without overwriting an invalid snapshot", async () => {
    const fixture = new CloseFixture("none");
    try {
      fixture.start();
      fixture.tmux(["set-environment", "-t", "target", "PI_TMUX_TEMPORARY", fixture.id]);
      const before = readFileSync(fixture.restore, "utf8");
      writeFileSync(fixture.restore, "{broken");
      const failed = notify(fixture, ["running", "--title", "null"]);
      assert.equal(failed.status, 1);
      assert.match(failed.stderr, new RegExp(fixture.id));
      assert.match(failed.stderr, /Cannot read snapshot/);
      assert.equal(readFileSync(fixture.restore, "utf8"), "{broken");
      assert.equal(JSON.parse(publicState(fixture)).state, "running");
      assert.ok(existsSync(`/proc/${fixture.pid}`));
      writeFileSync(fixture.restore, before);
      fixture.tmux(["set-option", "-g", `@pi-mux-restoring-${fixture.otherId}`, "1"]);
      const repaired = notify(fixture, ["running", "--title", "null"]);
      assert.equal(repaired.status, 0, repaired.stderr);
      assert.deepEqual(
        fixture.snapshot().workspaces[0]!.sessions.sort(),
        [fixture.id, fixture.otherId].sort(),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects stale socket, server, Pi, and pane identities without changing published or saved values", async () => {
    const fixture = new CloseFixture("none");
    try {
      fixture.start();
      assert.equal(notify(fixture, ["waiting-user", "--title", "null"]).status, 0);
      const original = stateSource(fixture);
      const before = publicState(fixture);
      const snapshot = readFileSync(fixture.restore, "utf8");
      for (const changed of [
        { socket: fixture.socket + ".other" },
        { serverPid: process.pid },
        { pane: "%99999" },
        { pid: process.pid },
        { token: "00000000-0000-4000-8000-000000000000" },
      ]) {
        const result = notify(fixture, ["running", "--title", "null"], { ...original, ...changed });
        assert.equal(result.status, 1, JSON.stringify(changed));
        assert.equal(publicState(fixture), before);
        assert.equal(readFileSync(fixture.restore, "utf8"), snapshot);
      }
      const staleClear = notify(fixture, ["--clear"], {
        ...original,
        token: "00000000-0000-4000-8000-000000000000",
      });
      assert.equal(staleClear.status, 1);
      assert.equal(publicState(fixture), before);
      fixture.tmux(["set-option", "-p", "@pi-mux-state-source", "another publisher"]);
      assert.equal(notify(fixture, ["--clear"]).status, 0);
      assert.equal(publicState(fixture), before);
    } finally {
      await fixture.cleanup();
    }
  });
});

const sessionFixtureRoot = "/tmp/work/dotfiles/pi-mux-session-fixture";
const historyTestRoot = "/tmp/work/dotfiles/pi-mux-history";

type ClientSummary = { name: string; pid: number; session: string };

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the fixture condition");
    await Bun.sleep(10);
  }
}

class SessionFixture {
  readonly directory: string;
  readonly socket: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly env: Record<string, string>;
  private readonly attached: Bun.Subprocess[] = [];
  private readonly panePids: number[] = [];
  private readonly launchTokens = new Map<string, string>();

  launchTokenOf(name: string): string {
    const existing = this.launchTokens.get(name);
    if (existing !== undefined) return existing;
    const token = randomUUID();
    this.launchTokens.set(name, token);
    return token;
  }

  constructor() {
    assert.ok(realTmux && Bun.which("script"), "tmux and script must be installed");
    mkdirSync(sessionFixtureRoot, { recursive: true });
    this.directory = mkdtempSync(join(sessionFixtureRoot, "test-"));
    this.socket = join(this.directory, "runtime/pi-tmux/server.sock");
    this.cwd = join(this.directory, "workspace");
    this.agentDir = join(this.directory, "agent");
    this.env = {
      PATH: `${join(this.directory, "bin")}:${process.env.PATH ?? ""}`,
      HOME: join(this.directory, "home"),
      XDG_RUNTIME_DIR: join(this.directory, "runtime"),
      PI_CODING_AGENT_DIR: this.agentDir,
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
    };
    for (const directory of [
      "bin",
      "home/.config/tmux",
      "runtime/pi-tmux",
      "agent/sessions",
      "agent/pi-tmux/session-dirs",
      "agent/extensions/pi-mux-bridge",
      "workspace",
    ])
      mkdirSync(join(this.directory, directory), { recursive: true, mode: 0o700 });
    writeFileSync(join(this.directory, "agent/extensions/pi-mux-bridge/index.ts"), "");
    writeFileSync(
      join(this.directory, "bin/tmux"),
      `#!/bin/sh
if [ "$1" != -S ] || [ "$2" != ${JSON.stringify(this.socket)} ]; then exit 64; fi
exec ${JSON.stringify(realTmux)} "$@"
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(this.directory, "home/.config/tmux/pi.conf"),
      "set -g exit-empty off\nset -g remain-on-exit off\n",
    );
    writeFileSync(
      join(this.agentDir, "pi-tmux/pi-mux-restore.json"),
      JSON.stringify({ version: 1, generation: "", workspaces: [{ cwd: this.cwd, sessions: [] }] }),
    );
  }

  piSession(name: string, entry: { id: string; file: string; temporary?: boolean }): void {
    this.piSessionIn(name, this.cwd, entry);
  }

  piSessionIn(
    name: string,
    cwd: string,
    entry: { id: string; file: string; temporary?: boolean },
  ): void {
    const [session, pane, pid] = this.startPane(name, ["/bin/sleep", "300"], cwd);
    this.tmux(["set-environment", "-t", session, "PI_TMUX_SESSION_ID", entry.id]);
    if (entry.temporary)
      this.tmux(["set-environment", "-t", session, "PI_TMUX_TEMPORARY", entry.id]);
    this.publishPiMetadata(pane, pid, entry, this.launchTokenOf(name), cwd);
  }

  shellSession(name: string): { session: string; pane: string; pid: string } {
    const [session, pane, pid] = this.startPane(name, ["/bin/sh"]);
    return { session, pane, pid };
  }

  plainSession(name: string): void {
    this.startPane(name);
  }

  piWindow(session: string, entry: { id: string; file: string }): void {
    const [pane, pid] = this.tmux([
      "new-window",
      "-d",
      "-t",
      session,
      "-c",
      this.cwd,
      "-P",
      "-F",
      "#{pane_id}\t#{pane_pid}",
      "/bin/sleep",
      "300",
    ]).split("\t");
    assert.ok(pane && pid, `cannot start a pi window in ${session}`);
    this.panePids.push(Number(pid));
    this.publishPiMetadata(pane, pid, entry, this.launchTokenOf(session));
  }

  plainWindow(session: string): void {
    const [pane, pid] = this.tmux([
      "new-window",
      "-t",
      session,
      "-c",
      this.cwd,
      "-P",
      "-F",
      "#{pane_id}\t#{pane_pid}",
      "/bin/sleep",
      "300",
    ]).split("\t");
    assert.ok(pane && pid, `cannot start a plain window in ${session}`);
    this.panePids.push(Number(pid));
  }

  private publishPiMetadata(
    pane: string,
    pid: string,
    entry: { id: string; file: string },
    token: string,
    cwd = this.cwd,
  ): void {
    this.tmux([
      "set-option",
      "-p",
      "-t",
      pane,
      "@pi-tmux-session",
      Buffer.from(
        JSON.stringify({
          id: entry.id,
          cwd,
          file: entry.file,
          pid: Number(pid),
          startup: "ready",
          token,
        }),
      ).toString("base64"),
    ]);
  }

  private startPane(
    name: string,
    command: string[] = ["/bin/sleep", "300"],
    cwd = this.cwd,
  ): [string, string, string] {
    const [session, pane, pid] = this.tmux([
      "new-session",
      "-d",
      "-s",
      name,
      "-c",
      cwd,
      "-P",
      "-F",
      "#{session_id}\t#{pane_id}\t#{pane_pid}",
      ...command,
    ]).split("\t");
    assert.ok(session && pane && pid, `cannot start pane for ${name}`);
    this.panePids.push(Number(pid));
    return [session, pane, pid];
  }

  clients(): ClientSummary[] {
    const result = spawnSync(
      realTmux!,
      ["-S", this.socket, "list-clients", "-F", "#{client_name}\t#{client_pid}\t#{client_session}"],
      { env: this.env, encoding: "utf8", timeout: 10_000 },
    );
    return result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, pid, session] = line.split("\t");
        return { name: name!, pid: Number(pid), session: session! };
      });
  }

  async attach(session: string): Promise<void> {
    const previousCount = this.clients().filter((client) => client.session === session).length;
    const command = `tmux -S ${JSON.stringify(this.socket)} attach-session -t ${JSON.stringify(session)}`;
    const child = Bun.spawn(["script", "-qfc", command, "/dev/null"], {
      env: this.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    this.attached.push(child);
    await waitUntil(
      () => this.clients().filter((client) => client.session === session).length > previousCount,
    );
  }

  beforeCliTmux(script: string): void {
    const wrapper = join(this.directory, "bin/tmux");
    const guardedCommand = readFileSync(wrapper, "utf8");
    writeFileSync(wrapper, guardedCommand.replace("\nexec ", `\n${script}\nexec `));
  }

  run(args: string[], environment: Record<string, string> = {}) {
    return spawnSync(process.execPath, ["run", source, ...args], {
      cwd: this.cwd,
      env: { ...this.env, ...environment },
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  tmux(args: string[]): string {
    const result = spawnSync(
      realTmux!,
      ["-S", this.socket, "-f", join(this.directory, "home/.config/tmux/pi.conf"), ...args],
      { env: this.env, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }

  async cleanup(): Promise<void> {
    spawnSync(realTmux!, ["-S", this.socket, "kill-server"], {
      env: this.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    for (const child of this.attached) {
      child.kill();
      await Promise.race([child.exited, Bun.sleep(2_000)]);
    }
    const deadline = Date.now() + 2_000;
    while (this.panePids.some((pid) => existsSync(`/proc/${pid}`)) && Date.now() < deadline)
      await Bun.sleep(10);
    assert.equal(
      this.panePids.some((pid) => existsSync(`/proc/${pid}`)),
      false,
    );
    rmSync(this.directory, { recursive: true, force: true });
  }
}

function sessionGroupDirectory(agentDir: string, cwd: string): string {
  return join(agentDir, "sessions", `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
}

function conversationFile(
  agentDir: string,
  cwd: string,
  id: string,
  options: { title?: string; message?: string; mtime?: Date; activity?: string } = {},
): string {
  const file = join(sessionGroupDirectory(agentDir, cwd), `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  const entries = [
    { type: "session", version: 1, id, cwd, timestamp: "2026-01-01T00:00:00.000Z" },
    ...(options.title === undefined
      ? []
      : [
          {
            type: "session_info",
            id: "e1",
            parentId: null,
            timestamp: "2026-01-01T00:00:01.000Z",
            name: options.title,
          },
        ]),
    {
      type: "message",
      id: "e2",
      parentId: null,
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "user", content: options.message ?? [] },
    },
    ...(options.activity === undefined ? [] : [{ type: "message", timestamp: options.activity }]),
  ];
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  if (options.mtime) utimesSync(file, options.mtime, options.mtime);
  return file;
}

function archiveConversation(file: string): string {
  const archivedFile = join(dirname(file), "archive", basename(file));
  mkdirSync(dirname(archivedFile), { recursive: true });
  renameSync(file, archivedFile);
  return archivedFile;
}

const fixtureBtimeMs = Date.parse("2026-01-01T00:00:02.000Z");

function historyEntry(
  file: string,
  id: string,
  cwd: string,
  title: string | null,
  times: { btime?: number; mtime?: number | null } = {},
) {
  const stat = statSync(file);
  return {
    id,
    cwd,
    file,
    title,
    btime: times.btime ?? fixtureBtimeMs,
    mtime: times.mtime === undefined ? fixtureBtimeMs : times.mtime,
    size: stat.size,
  };
}

function tableRows(stdout: string): string[][] {
  return stdout
    .trimEnd()
    .split("\n")
    .map((line) => line.split(/ {2,}/));
}

describe("list scopes", () => {
  it("merges active panes and saved conversations into one table and JSON listing", async () => {
    const fixture = new SessionFixture();
    try {
      const liveCwd = join(fixture.directory, "live-workspace");
      mkdirSync(liveCwd);
      const sharedId = randomUUID();
      const paneFile = conversationFile(fixture.agentDir, liveCwd, sharedId, {
        title: "Older copy",
      });
      const recentActivity = "2026-01-03T00:00:00.000Z";
      const historyFile = conversationFile(fixture.agentDir, fixture.cwd, sharedId, {
        title: "Recent copy",
        activity: recentActivity,
      });
      fixture.piSessionIn("active", liveCwd, { id: sharedId, file: paneFile });
      const [serverPid, pane, pid] = fixture
        .tmux(["display-message", "-p", "-t", "active", "#{pid}\t#{pane_id}\t#{pane_pid}"])
        .split("\t");
      const origin = {
        socket: fixture.socket,
        serverPid: Number(serverPid),
        pane,
        pid: Number(pid),
        token: fixture.launchTokenOf("active"),
      };
      const lastRun = { atMs: 1, aborted: true };
      const laterTime = { atMs: Date.parse(recentActivity), aborted: false };
      appendFileSync(
        paneFile,
        lastRunLine(sharedId, laterTime) +
          lastRunLine(sharedId, lastRun) +
          lastRunLine("foreign", laterTime) +
          lastRunLine(sharedId, { ...laterTime, atMs: Number.MAX_SAFE_INTEGER + 1 }) +
          lastRunLine(sharedId, { ...laterTime, aborted: "false" }) +
          '{"type":"custom","customType":"pi-mux-last-run","data":',
      );
      appendFileSync(historyFile, lastRunLine(sharedId, laterTime));
      const notified = fixture.run([
        "state",
        sharedId,
        "waiting-user",
        "--title",
        JSON.stringify("Live title"),
        "--source",
        JSON.stringify(origin),
      ]);
      assert.equal(notified.status, 0, notified.stderr);

      appendFileSync(paneFile, "\n" + lastRunLine(sharedId, laterTime));

      const unsavedId = randomUUID();
      const unsavedFile = join(fixture.directory, `${unsavedId}.jsonl`);
      fixture.piSessionIn("unsaved", liveCwd, {
        id: unsavedId,
        file: unsavedFile,
        temporary: true,
      });
      const emptyPane = fixture.tmux(["display-message", "-p", "-t", "unsaved", "#{pane_id}"]);
      fixture.tmux([
        "set-option",
        "-p",
        "-t",
        emptyPane,
        "@pi_session_state",
        JSON.stringify({ version: 1, sessionId: unsavedId, state: "waiting-user", lastRun }),
      ]);

      const archivedId = randomUUID();
      const archivedActivity = "2026-01-02T00:00:00.000Z";
      const archivedFile = archiveConversation(
        conversationFile(fixture.agentDir, liveCwd, archivedId, {
          title: "Archived title",
          activity: archivedActivity,
        }),
      );

      appendFileSync(archivedFile, lastRunLine(archivedId, laterTime));

      const closedId = randomUUID();
      const closedFile = conversationFile(fixture.agentDir, liveCwd, closedId, {
        title: "Closed title",
      });

      const listed = fixture.run(["list", "--json"]);
      assert.equal(listed.status, 0, listed.stderr);
      assert.ok(listed.stdout.endsWith("\n"));
      const savedOnly = [
        {
          id: archivedId,
          file: archivedFile,
          title: "Archived title",
          mtime: Date.parse(archivedActivity),
        },
        { id: closedId, file: closedFile, title: "Closed title", mtime: fixtureBtimeMs },
      ].map((entry) => ({
        ...entry,
        active: false,
        saved: true,
        state: null,
        publishPending: null,
        btime: fixtureBtimeMs,
        size: statSync(entry.file).size,
      }));
      assert.deepEqual(JSON.parse(listed.stdout), [
        { cwd: fixture.cwd, sessions: [] },
        {
          cwd: liveCwd,
          sessions: [
            {
              id: sharedId,
              file: historyFile,
              active: true,
              saved: true,
              state: "waiting-user",
              title: "Live title",
              publishPending: null,
              lastRun,
              btime: fixtureBtimeMs,
              mtime: Date.parse(recentActivity),
              size: statSync(historyFile).size,
            },
            {
              id: unsavedId,
              file: unsavedFile,
              active: true,
              saved: false,
              state: null,
              title: null,
              publishPending: null,
              btime: null,
              mtime: null,
              size: null,
              temporary: true,
            },
            ...savedOnly,
          ],
        },
      ]);

      const active = fixture.run(["list", "--active", "--json"]);
      assert.equal(active.status, 0, active.stderr);
      assert.deepEqual(JSON.parse(active.stdout), [
        { cwd: fixture.cwd, sessions: [], empty: [] },
        {
          cwd: liveCwd,
          sessions: [
            {
              id: sharedId,
              file: paneFile,
              state: "waiting-user",
              title: "Live title",
              publishPending: null,
              lastRun,
            },
          ],
          empty: [{ id: unsavedId, file: unsavedFile, temporary: true }],
        },
      ]);

      const table = fixture.run(["list"]);
      assert.equal(table.status, 0, table.stderr);
      assert.deepEqual(tableRows(table.stdout), [
        ["WORKSPACE", "SESSION ID", "STATE", "UPDATED (UTC)", "TITLE"],
        [liveCwd, sharedId, "waiting-user", recentActivity, "Live title"],
        [liveCwd, unsavedId, "unsaved", "-", "-"],
        [liveCwd, archivedId, "inactive", archivedActivity, "Archived title"],
        [liveCwd, closedId, "inactive", new Date(fixtureBtimeMs).toISOString(), "Closed title"],
      ]);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("matches history in both saved formats and accepts --cwd and --json in any order without tmux", async () => {
    const fixture = new SessionFixture();
    try {
      const otherCwd = join(fixture.directory, "other workspace");
      mkdirSync(otherCwd);
      const registration = fixture.run(["workspace", "register", otherCwd]);
      assert.equal(registration.status, 0, registration.stderr);
      const id = randomUUID();
      const file = archiveConversation(conversationFile(fixture.agentDir, fixture.cwd, id));
      conversationFile(fixture.agentDir, otherCwd, randomUUID());
      const unsavedId = randomUUID();
      fixture.piSession("unsaved", {
        id: unsavedId,
        file: join(fixture.directory, `${unsavedId}.jsonl`),
      });
      const tmuxCalls = join(fixture.directory, "saved-tmux-calls");
      fixture.beforeCliTmux(`touch ${JSON.stringify(tmuxCalls)}; exit 99`);

      for (const options of [
        [],
        ["--json"],
        ["--cwd", fixture.cwd],
        ["--cwd", fixture.cwd, "--json"],
      ]) {
        const saved = fixture.run(["list", "--saved", ...options]);
        const history = fixture.run(["history", ...options]);
        assert.equal(saved.status, 0, saved.stderr);
        assert.equal(history.status, 0, history.stderr);
        assert.equal(saved.stdout, history.stdout, options.join(" "));
      }

      const restricted = fixture.run(["list", "--json", "--cwd", fixture.cwd, "--saved"]);
      assert.equal(restricted.status, 0, restricted.stderr);
      assert.deepEqual(JSON.parse(restricted.stdout), [historyEntry(file, id, fixture.cwd, null)]);
      assert.equal(existsSync(tmuxCalls), false);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("rejects conflicting, repeated, and invalid list options", () => {
    const fixture = new HistoryFixture();
    try {
      for (const options of [
        ["--active", "--saved"],
        ["--saved", "--active"],
        ["--active", "--active"],
        ["--saved", "--saved"],
        ["--saved", "--json", "--json"],
        ["--saved", "--cwd", fixture.cwd, "--cwd", fixture.otherCwd],
        ["--saved", "--cwd", "relative"],
        ["--saved", "--cwd"],
        ["--active", "--cwd", fixture.cwd],
        ["--cwd", fixture.cwd],
        ["--json", "--json"],
      ]) {
        const invoked = options.join(" ");
        const result = fixture.run(["list", ...options]);
        assert.equal(result.status, 1, invoked);
        assert.match(result.stderr, /usage: pi-mux/, invoked);
        assert.equal(result.stdout, "", invoked);
      }
    } finally {
      fixture.cleanup();
    }
  });
});

describe("list workspace panes", () => {
  it("shows saved and unsaved panes without a row for an empty workspace", async () => {
    const fixture = new SessionFixture();
    try {
      const savedCwd = join(fixture.directory, "with-panes");
      mkdirSync(savedCwd);
      const savedId = randomUUID();
      const unsavedId = randomUUID();
      const savedFile = conversationFile(fixture.agentDir, savedCwd, savedId);
      fixture.piSessionIn("saved", savedCwd, { id: savedId, file: savedFile });
      fixture.piSessionIn("unsaved", savedCwd, {
        id: unsavedId,
        file: join(fixture.directory, `${unsavedId}.jsonl`),
      });
      const pane = fixture.tmux(["display-message", "-p", "-t", "saved", "#{pane_id}"]);
      fixture.tmux([
        "set-option",
        "-p",
        "-t",
        pane,
        "@pi_session_state",
        JSON.stringify({ version: 1, sessionId: savedId, state: "running", title: "Live title" }),
      ]);

      const table = fixture.run(["list", "--active"]);
      assert.equal(table.status, 0, table.stderr);
      assert.deepEqual(tableRows(table.stdout), [
        ["WORKSPACE", "SESSION ID", "STATE", "TITLE"],
        [savedCwd, savedId, "running", "Live title"],
        [savedCwd, unsavedId, "unsaved", "-"],
      ]);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("separates panes with a saved conversation file from unsaved empty panes", async () => {
    const fixture = new SessionFixture();
    try {
      const savedId = randomUUID();
      const savedFile = join(
        fixture.directory,
        "conversations",
        `2026-01-01T00-00-00-000Z_${savedId}.jsonl`,
      );
      mkdirSync(dirname(savedFile), { recursive: true });
      writeFileSync(
        savedFile,
        [
          JSON.stringify({
            type: "session",
            version: 1,
            id: savedId,
            cwd: fixture.cwd,
            timestamp: "2026-01-01T00:00:00.000Z",
          }),
          JSON.stringify({
            type: "session_info",
            id: "e1",
            parentId: null,
            timestamp: "2026-01-01T00:00:01.000Z",
            name: "Saved title",
          }),
        ].join("\n") + "\n",
      );
      const emptyId = randomUUID();
      const emptyFile = join(fixture.directory, "conversations", `later_${emptyId}.jsonl`);
      fixture.piSession("saved", { id: savedId, file: savedFile });
      fixture.piSession("fresh", { id: emptyId, file: emptyFile, temporary: true });
      fixture.tmux([
        "set-option",
        "-w",
        "-t",
        "saved",
        "@pi_session_state",
        JSON.stringify({ version: 1, sessionId: savedId, state: "running", title: "Window title" }),
      ]);
      fixture.tmux([
        "set-option",
        "-g",
        "@pi_session_state_pending",
        JSON.stringify({ version: 1, sessionId: savedId, attemptAt: 1 }),
      ]);
      fixture.tmux(["set-environment", "-g", "PI_TMUX_TEMPORARY", savedId]);
      const invocations = join(fixture.directory, "list-tmux-commands");
      fixture.beforeCliTmux(`printf '%s\\n' "$5" >> ${JSON.stringify(invocations)}`);

      const result = fixture.run(["list", "--active", "--json"]);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(invocations, "utf8"), "list-panes\n-C\n");
      assert.deepEqual(JSON.parse(result.stdout), [
        {
          cwd: fixture.cwd,
          sessions: [
            {
              id: savedId,
              file: savedFile,
              state: null,
              title: "Saved title",
              publishPending: null,
            },
          ],
          empty: [{ id: emptyId, file: emptyFile, temporary: true }],
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("uses the saved title and omits temporary when a session disappears after enumeration", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      const file = conversationFile(fixture.agentDir, fixture.cwd, id, { title: "Saved title" });
      fixture.piSession("leaving", { id, file, temporary: true });
      fixture.plainSession("host");
      fixture.beforeCliTmux(`if [ "$5" = -C ]; then
  ${JSON.stringify(realTmux)} -S "$2" kill-session -t leaving || exit 1
fi`);

      const result = fixture.run(["list", "--active", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [
        {
          cwd: fixture.cwd,
          sessions: [{ id, file, state: null, title: "Saved title", publishPending: null }],
          empty: [],
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  for (const saved of [true, false]) {
    it(`preserves the missing-server rule after enumeration for ${saved ? "saved" : "empty"} panes`, async () => {
      const fixture = new SessionFixture();
      try {
        const id = randomUUID();
        const file = saved
          ? conversationFile(fixture.agentDir, fixture.cwd, id)
          : join(fixture.directory, `${id}.jsonl`);
        fixture.piSession("leaving", { id, file, temporary: true });
        fixture.beforeCliTmux(`if [ "$5" = -C ]; then
  ${JSON.stringify(realTmux)} -S "$2" kill-server || exit 1
  rm -f "$2"
fi`);

        const result = fixture.run(["list", "--active", "--json"]);
        if (saved) {
          assert.equal(result.status, 1, result.stderr);
          assert.equal(result.stdout, "");
          assert.match(
            result.stderr,
            /tmux show-options failed: (no server running|error connecting)/,
          );
        } else {
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(JSON.parse(result.stdout), [
            { cwd: fixture.cwd, sessions: [], empty: [{ id, file }] },
          ]);
        }
      } finally {
        await fixture.cleanup();
      }
    }, 20_000);
  }

  it("validates the published state, title, and lastRun independently", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      const savedFile = join(
        fixture.directory,
        "conversations",
        `2026-01-01T00-00-00-000Z_${id}.jsonl`,
      );
      mkdirSync(dirname(savedFile), { recursive: true });
      writeFileSync(
        savedFile,
        [
          JSON.stringify({
            type: "session",
            version: 1,
            id,
            cwd: fixture.cwd,
            timestamp: "2026-01-01T00:00:00.000Z",
          }),
          JSON.stringify({
            type: "session_info",
            id: "e1",
            parentId: null,
            timestamp: "2026-01-01T00:00:01.000Z",
            name: "Saved title",
          }),
        ].join("\n") + "\n",
      );
      fixture.piSession("saved", { id, file: savedFile });
      const pane = fixture.tmux(["display-message", "-p", "-t", "saved", "#{pane_id}"]);
      const entryOf = (listing: string) => {
        const sessions = JSON.parse(listing)[0].sessions;
        assert.equal(sessions.length, 1);
        return sessions[0];
      };
      const savedEntry = {
        id,
        file: savedFile,
        state: null,
        title: "Saved title",
        publishPending: null,
      };
      const lastRun = { atMs: 1735689600000, aborted: true };
      for (const value of [
        "{broken",
        JSON.stringify({
          version: 2,
          sessionId: id,
          state: "running",
          title: "From version 2",
          lastRun,
        }),
        JSON.stringify({
          version: 1,
          sessionId: "other-session",
          state: "running",
          title: "From another session",
          lastRun,
        }),
      ]) {
        fixture.tmux(["set-option", "-p", "-t", pane, "@pi_session_state", value]);
        const result = fixture.run(["list", "--active", "--json"]);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(
          entryOf(result.stdout),
          savedEntry,
          `an invalid option must disregard the published values: ${value}`,
        );
      }
      for (const [value, expected] of [
        [
          JSON.stringify({
            version: 1,
            sessionId: id,
            state: "waiting-approval",
            title: 42,
            lastRun,
          }),
          { ...savedEntry, state: "waiting-approval", lastRun },
        ],
        [
          JSON.stringify({
            version: 1,
            sessionId: id,
            state: "paused",
            title: "Published",
            lastRun,
          }),
          { ...savedEntry, title: "Published", lastRun },
        ],
        [
          JSON.stringify({ version: 1, sessionId: id, state: "running" }),
          { ...savedEntry, state: "running" },
        ],
        [
          JSON.stringify({ version: 1, sessionId: id, state: "running", title: null }),
          { ...savedEntry, state: "running" },
        ],
        [
          JSON.stringify({
            version: 1,
            sessionId: id,
            state: "running",
            title: "Published during the run",
            lastRun: { atMs: lastRun.atMs, aborted: "true" },
          }),
          { ...savedEntry, state: "running", title: "Published during the run" },
        ],
      ] as const) {
        fixture.tmux(["set-option", "-p", "-t", pane, "@pi_session_state", value]);
        const result = fixture.run(["list", "--active", "--json"]);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(entryOf(result.stdout), expected, `value: ${value}`);
      }
      fixture.tmux(["set-option", "-pu", "-t", pane, "@pi_session_state"]);
      const cleared = fixture.run(["list", "--active", "--json"]);
      assert.equal(cleared.status, 0, cleared.stderr);
      assert.deepEqual(entryOf(cleared.stdout), savedEntry);
    } finally {
      await fixture.cleanup();
    }
  }, 40_000);

  it("accepts a pi process descending from the pane shell and drops the pane after that process ends", async () => {
    const fixture = new SessionFixture();
    try {
      const shell = fixture.shellSession("shellhost");
      const pidFile = join(fixture.directory, "child.pid");
      fixture.tmux(["send-keys", "-t", shell.pane, `sleep 300 & echo $! > ${pidFile}`, "Enter"]);
      await waitUntil(() => existsSync(pidFile));
      const childPid = Number(readFileSync(pidFile, "utf8").trim());
      assert.ok(Number.isSafeInteger(childPid) && childPid > 0, `child pid: ${childPid}`);
      const id = randomUUID();
      const file = join(fixture.directory, "conversations", `${id}.jsonl`);
      fixture.tmux([
        "set-option",
        "-p",
        "-t",
        shell.pane,
        "@pi-tmux-session",
        Buffer.from(
          JSON.stringify({
            id,
            cwd: fixture.cwd,
            file,
            pid: Number(shell.pid),
            processPid: childPid,
            startup: "ready",
          }),
        ).toString("base64"),
      ]);
      const listed = fixture.run(["list", "--active", "--json"]);
      assert.equal(listed.status, 0, listed.stderr);
      assert.deepEqual(JSON.parse(listed.stdout), [
        { cwd: fixture.cwd, sessions: [], empty: [{ id, file }] },
      ]);
      process.kill(childPid, "SIGKILL");
      fixture.tmux(["send-keys", "-t", shell.pane, "Enter"]);
      await waitUntil(() => !existsSync(`/proc/${childPid}`));
      const after = fixture.run(["list", "--active", "--json"]);
      assert.equal(after.status, 0, after.stderr);
      assert.deepEqual(JSON.parse(after.stdout), [{ cwd: fixture.cwd, sessions: [], empty: [] }]);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("fails on invalid pi metadata and on tmux inspection failures", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      const file = join(fixture.directory, "conversations", `${id}.jsonl`);
      fixture.piSession("broken", { id, file });
      const pane = fixture.tmux(["display-message", "-p", "-t", "broken", "#{pane_id}"]);
      const pid = fixture.tmux(["display-message", "-p", "-t", "broken", "#{pane_pid}"]);
      fixture.tmux([
        "set-option",
        "-p",
        "-t",
        pane,
        "@pi-tmux-session",
        Buffer.from(
          JSON.stringify({
            id,
            cwd: fixture.cwd,
            file: "relative.jsonl",
            pid: Number(pid),
            startup: "ready",
          }),
        ).toString("base64"),
      ]);
      const metadataFailure = fixture.run(["list", "--active"]);
      assert.equal(metadataFailure.status, 1);
      assert.match(metadataFailure.stderr, /Invalid pi session metadata/);
      fixture.tmux(["kill-session", "-t", "broken"]);

      const wrapper = join(fixture.directory, "bin/tmux");
      rmSync(wrapper, { force: true });
      writeFileSync(
        wrapper,
        `#!/bin/sh
if [ "$1" != -S ] || [ "$2" != ${JSON.stringify(fixture.socket)} ]; then exit 64; fi
case "$*" in *list-panes*) printf '%s\\n' 'tmux: injected inspection failure' >&2; exit 1;; esac
exec ${JSON.stringify(realTmux)} "$@"
`,
        { mode: 0o700 },
      );
      fixture.plainSession("host");
      const inspectionFailure = fixture.run(["list", "--active"]);
      assert.equal(inspectionFailure.status, 1);
      assert.match(inspectionFailure.stderr, /Cannot inspect pi sessions/);
      assert.match(inspectionFailure.stderr, /tmux: injected inspection failure/);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("does not register a cwd whose last pane disappears before the locked recheck", async () => {
    const fixture = new SessionFixture();
    try {
      const otherCwd = join(fixture.directory, "other-workspace");
      mkdirSync(otherCwd);
      const id = randomUUID();
      const file = join(fixture.directory, "conversations", `${id}.jsonl`);
      fixture.piSessionIn("leaving", otherCwd, { id, file });
      fixture.plainSession("host");
      const firstInspection = join(fixture.directory, "first-pane-inspection");
      fixture.beforeCliTmux(`if [ "$5" = list-panes ]; then
  if [ -e ${JSON.stringify(firstInspection)} ]; then
    ${JSON.stringify(realTmux)} -S "$2" kill-session -t leaving || exit 1
  fi
  touch ${JSON.stringify(firstInspection)}
fi`);

      const snapshotBefore = readFileSync(restoreFile(fixture), "utf8");
      const result = fixture.run(["list", "--active", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [{ cwd: fixture.cwd, sessions: [], empty: [] }]);
      assert.equal(readFileSync(restoreFile(fixture), "utf8"), snapshotBefore);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("registers an unregistered running cwd during list and keeps existing registrations", async () => {
    const fixture = new SessionFixture();
    try {
      const otherCwd = join(fixture.directory, "other-workspace");
      mkdirSync(otherCwd, { recursive: true });
      const id = randomUUID();
      const file = join(fixture.directory, "conversations", `${id}.jsonl`);
      fixture.piSessionIn("other", otherCwd, { id, file });
      const result = fixture.run(["list", "--active", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [
        { cwd: fixture.cwd, sessions: [], empty: [] },
        { cwd: otherCwd, sessions: [], empty: [{ id, file }] },
      ]);
      assert.deepEqual(JSON.parse(readFileSync(restoreFile(fixture), "utf8")), {
        version: 1,
        generation: "",
        workspaces: [
          { cwd: fixture.cwd, sessions: [] },
          { cwd: otherCwd, sessions: [] },
        ],
      });
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});

describe("switch", () => {
  it("switches the only attached client to the session that owns the conversation", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      fixture.piSession("pi", {
        id,
        file: join(fixture.directory, "conversations", `${id}.jsonl`),
      });
      fixture.plainSession("plain");
      await fixture.attach("plain");
      const result = fixture.run(["switch", id]);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.deepEqual(
        fixture.clients().map((client) => client.session),
        ["pi"],
      );
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("accepts the client pid and the parent pid of the client process", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      fixture.piSession("pi", {
        id,
        file: join(fixture.directory, "conversations", `${id}.jsonl`),
      });
      await fixture.attach("pi");
      const client = fixture.clients()[0]!;
      const ppid = Number(
        /^PPid:\s+(\d+)$/m.exec(readFileSync(`/proc/${client.pid}/status`, "utf8"))![1]!,
      );
      for (const pid of [client.pid, ppid]) {
        const result = fixture.run(["switch", id, "--client-pid", String(pid)]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "");
      }
      assert.equal(fixture.clients()[0]!.session, "pi");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("fails when no client matches the pid or the conversation id is unknown", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      fixture.piSession("pi", {
        id,
        file: join(fixture.directory, "conversations", `${id}.jsonl`),
      });
      await fixture.attach("pi");
      const unknownPid = fixture.run(["switch", id, "--client-pid", "999999999"]);
      assert.equal(unknownPid.status, 3);
      assert.ok(unknownPid.stderr.includes("Cannot identify the tmux client"));
      const unknownId = fixture.run(["switch", randomUUID(), "--client-pid", "999999999"]);
      assert.equal(unknownId.status, 2);
      assert.ok(unknownId.stderr.includes("Session not found"));
      assert.equal(fixture.clients()[0]!.session, "pi");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("fails without --client-pid when zero or multiple clients are attached", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      fixture.piSession("pi", {
        id,
        file: join(fixture.directory, "conversations", `${id}.jsonl`),
      });
      const noClient = fixture.run(["switch", id]);
      assert.equal(noClient.status, 3);
      assert.ok(noClient.stderr.includes("Expected one attached tmux client, found 0"));
      await fixture.attach("pi");
      await fixture.attach("pi");
      const twoClients = fixture.run(["switch", id]);
      assert.equal(twoClients.status, 1);
      assert.ok(twoClients.stderr.includes("Expected one attached tmux client, found 2"));
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});

describe("send", () => {
  function sessionPane(fixture: SessionFixture, id: string): string {
    const panes = fixture
      .tmux(["list-panes", "-a", "-F", "#{pane_id}\t#{@pi-tmux-session}"])
      .split("\n")
      .filter(Boolean);
    for (const line of panes) {
      const [pane, encoded] = line.split("\t");
      const metadata = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"));
      if (metadata.id === id) return pane!;
    }
    assert.fail(`No pane is running for conversation ${id}`);
  }

  function messageOptions(fixture: SessionFixture, pane: string): Map<string, string> {
    const options = new Map<string, string>();
    for (const line of fixture.tmux(["show-options", "-p", "-t", pane]).split("\n")) {
      if (!line.startsWith("@pi-mux-msg-")) continue;
      const separator = line.indexOf(" ");
      options.set(line.slice(0, separator), line.slice(separator + 1));
    }
    return options;
  }

  function decodeEnvelope(value: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  }

  it("writes one attributed message option for the target conversation", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      fixture.piSession("pi", {
        id,
        file: join(fixture.directory, "conversations", `${id}.jsonl`),
      });
      const pane = sessionPane(fixture, id);
      const result = fixture.run(["send", id, "duplicate work detected; please wrap up"]);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      const options = messageOptions(fixture, pane);
      assert.equal(options.size, 1);
      const [entry] = options;
      assert.ok(entry);
      const [optionName, value] = entry;
      assert.match(optionName, /^@pi-mux-msg-[0-9a-f-]{36}$/);
      const envelope = decodeEnvelope(value);
      assert.equal(envelope.v, 1);
      assert.equal(envelope.id, optionName!.slice("@pi-mux-msg-".length));
      assert.equal(envelope.from, "external");
      assert.equal(envelope.text, "duplicate work detected; please wrap up");
      assert.ok(!Number.isNaN(Date.parse(envelope.at as string)));
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("attributes the sender from PI_SESSION_ID and joins multi-argument text", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      const sender = randomUUID();
      fixture.piSession("pi", {
        id,
        file: join(fixture.directory, "conversations", `${id}.jsonl`),
      });
      const pane = sessionPane(fixture, id);
      const result = spawnSync(process.execPath, ["run", source, "send", id, "stop", "now"], {
        cwd: fixture.cwd,
        env: { ...fixture.env, PI_SESSION_ID: sender },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const [entry] = messageOptions(fixture, pane);
      assert.ok(entry);
      const envelope = decodeEnvelope(entry[1]);
      assert.equal(envelope.from, sender);
      assert.equal(envelope.text, "stop now");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("rejects oversized text without writing an option", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      fixture.piSession("pi", {
        id,
        file: join(fixture.directory, "conversations", `${id}.jsonl`),
      });
      const pane = sessionPane(fixture, id);
      const result = fixture.run(["send", id, "x".repeat(2801)]);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes("the limit is 2800"));
      assert.equal(messageOptions(fixture, pane).size, 0);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("fails for an unknown conversation and for duplicate running conversations", async () => {
    const fixture = new SessionFixture();
    try {
      const unknown = fixture.run(["send", randomUUID(), "hello"]);
      assert.equal(unknown.status, 1);
      assert.ok(unknown.stderr.includes("Session not found"));
      const id = randomUUID();
      const file = join(fixture.directory, "conversations", `${id}.jsonl`);
      fixture.piSession("first", { id, file });
      fixture.piSession("second", { id, file });
      const duplicate = fixture.run(["send", id, "hello"]);
      assert.equal(duplicate.status, 1);
      assert.ok(duplicate.stderr.includes("Multiple pi processes are running"));
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("reports delivered when the receiving pane consumes the option before the write call returns", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      fixture.piSession("pi", {
        id,
        file: join(fixture.directory, "conversations", `${id}.jsonl`),
      });
      const pane = sessionPane(fixture, id);
      const wrapper = join(fixture.directory, "bin/tmux");
      const execTmux = `exec ${JSON.stringify(realTmux)} "$@"`;
      writeFileSync(
        wrapper,
        readFileSync(wrapper, "utf8").replace(
          execTmux,
          `if [ "$5" = source-file ] && [ "$6" = - ]; then
  ${JSON.stringify(realTmux)} "$@" || exit $?
  exec ${JSON.stringify(realTmux)} -S "$2" wait-for message-consumed
fi
${execTmux}`,
        ),
      );
      const child = Bun.spawn(
        [process.execPath, "run", source, "send", "--wait", "10", id, "handover please"],
        { cwd: fixture.cwd, env: fixture.env, stdout: "pipe", stderr: "pipe" },
      );
      let optionName: string | undefined;
      await waitUntil(() => {
        optionName = [...messageOptions(fixture, pane).keys()][0];
        return optionName !== undefined;
      });
      fixture.tmux(["set-option", "-pu", "-t", pane, optionName!]);
      fixture.tmux(["wait-for", "-S", "message-consumed"]);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      assert.equal(exitCode, 0, stderr);
      assert.equal(stdout.trim(), "delivered");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("reports the option name when --wait times out without consumption", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      fixture.piSession("pi", {
        id,
        file: join(fixture.directory, "conversations", `${id}.jsonl`),
      });
      const result = fixture.run(["send", "--wait", "1", id, "anybody there"]);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /@pi-mux-msg-[0-9a-f-]{36} was not consumed within 1 seconds/);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});

describe("list --displayed", () => {
  const headers = ["CLIENT PID", "WORKSPACE", "SESSION ID", "TMUX TARGET", "FILE"];

  it("lists each attached client separately, including clients displaying the same unsaved session", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      const file = join(fixture.directory, "conversations", id + ".jsonl");
      const cwd = join(fixture.directory, "unregistered");
      mkdirSync(cwd);
      fixture.piSessionIn("pi", cwd, { id, file });
      await fixture.attach("pi");
      await fixture.attach("pi");
      const other = { id: randomUUID(), file: join(fixture.directory, "other.jsonl") };
      fixture.piSession("other", other);
      await fixture.attach("other");
      fixture.plainSession("plain");
      await fixture.attach("plain");
      const clients = fixture.clients();
      const restoreBefore = readFileSync(restoreFile(fixture), "utf8");
      fixture.beforeCliTmux(`case "$6" in
  list-clients|list-panes) ;;
  *) echo "unexpected tmux command: $6" >&2; exit 64 ;;
esac`);
      const expected = clients.flatMap(({ pid, session }) => {
        if (session === "pi") return [{ clientPid: pid, id, cwd, file, target: "pi" }];
        if (session === "other")
          return [{ clientPid: pid, ...other, cwd: fixture.cwd, target: "other" }];
        return [];
      });

      const table = fixture.run(["list", "--displayed"]);
      assert.equal(table.status, 0, table.stderr);
      assert.deepEqual(tableRows(table.stdout), [
        headers,
        ...expected.map(({ clientPid, cwd, id, target, file }) => [
          String(clientPid),
          cwd,
          id,
          target,
          file,
        ]),
      ]);
      const result = fixture.run(["list", "--displayed", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.endsWith("\n"));
      assert.deepEqual(JSON.parse(result.stdout), expected);
      assert.deepEqual(fixture.clients(), clients);
      assert.equal(readFileSync(restoreFile(fixture), "utf8"), restoreBefore);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("filters by either client PID or parent PID and returns the actual client PID", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      const file = join(fixture.directory, "conversations", id + ".jsonl");
      fixture.piSession("pi", { id, file });
      await fixture.attach("pi");
      const { pid } = fixture.clients()[0]!;
      const ppid = /^PPid:\s+(\d+)$/m.exec(readFileSync("/proc/" + pid + "/status", "utf8"))?.[1];
      assert.ok(ppid);
      fixture.plainSession("plain");
      await fixture.attach("plain");

      for (const args of [
        ["--displayed", "--client-pid", String(pid), "--json"],
        ["--client-pid", ppid, "--json", "--displayed"],
      ]) {
        const result = fixture.run(["list", ...args]);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), [
          { clientPid: pid, id, cwd: fixture.cwd, file, target: "pi" },
        ]);
      }
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("rejects multiple PID matches even when only one displays pi", async () => {
    const fixture = new SessionFixture();
    try {
      fixture.piSession("pi", { id: randomUUID(), file: join(fixture.directory, "pi.jsonl") });
      await fixture.attach("pi");
      const { pid } = fixture.clients()[0]!;
      const ppid = /^PPid:\s+(\d+)$/m.exec(readFileSync("/proc/" + pid + "/status", "utf8"))?.[1];
      assert.ok(ppid);
      fixture.plainSession("plain");
      fixture.beforeCliTmux(`if [ "$6" = list-clients ]; then
  printf 'pi-client\\t%s\\tpi\\nplain-client\\t%s\\tplain\\n' ${pid} ${ppid}
  exit 0
fi`);
      const result = fixture.run(["list", "--displayed", "--client-pid", ppid, "--json"]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Multiple tmux clients match process/);
      assert.equal(result.stdout, "");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("reports an empty result without a server and does not start one", async () => {
    const fixture = new SessionFixture();
    try {
      const result = fixture.run(["list", "--displayed", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "[]\n");
      assert.equal(existsSync(fixture.socket), false);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("reports an empty result with no attached clients or no PID match", async () => {
    const fixture = new SessionFixture();
    try {
      fixture.piSession("pi", { id: randomUUID(), file: join(fixture.directory, "pi.jsonl") });
      const noClients = fixture.run(["list", "--displayed"]);
      assert.equal(noClients.status, 0, noClients.stderr);
      assert.deepEqual(tableRows(noClients.stdout), [headers]);

      await fixture.attach("pi");
      const noMatch = fixture.run(["list", "--displayed", "--json", "--client-pid", "999999999"]);
      assert.equal(noMatch.status, 0, noMatch.stderr);
      assert.equal(noMatch.stdout, "[]\n");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("ignores pi metadata in an inactive pane or window", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      const file = join(fixture.directory, "pi.jsonl");
      fixture.piSession("mixed", { id, file });
      await fixture.attach("mixed");
      fixture.tmux(["split-window", "-t", "mixed", "/bin/sleep", "300"]);
      const inactivePane = fixture.run(["list", "--displayed", "--json"]);
      assert.equal(inactivePane.status, 0, inactivePane.stderr);
      assert.equal(inactivePane.stdout, "[]\n");

      fixture.tmux(["last-pane", "-t", "mixed"]);
      fixture.plainWindow("mixed");
      const inactiveWindow = fixture.run(["list", "--displayed", "--json"]);
      assert.equal(inactiveWindow.status, 0, inactiveWindow.stderr);
      assert.equal(inactiveWindow.stdout, "[]\n");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("returns the displayed pi pane when the session has another pi window", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      const file = join(fixture.directory, "pi.jsonl");
      fixture.piSession("dual", { id, file });
      fixture.piWindow("dual", { id: randomUUID(), file: join(fixture.directory, "other.jsonl") });
      await fixture.attach("dual");
      const { pid } = fixture.clients()[0]!;
      const result = fixture.run(["list", "--displayed", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [
        { clientPid: pid, id, cwd: fixture.cwd, file, target: "dual" },
      ]);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  for (const command of ["list-clients", "list-panes"]) {
    it(`propagates a tmux ${command} failure instead of reporting no results`, async () => {
      const fixture = new SessionFixture();
      try {
        fixture.plainSession("plain");
        await fixture.attach("plain");
        fixture.beforeCliTmux(
          `if [ "$6" = ${command} ]; then echo 'injected tmux failure' >&2; exit 1; fi`,
        );
        const result = fixture.run(["list", "--displayed", "--json"]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /injected tmux failure/);
        assert.equal(result.stdout, "");
      } finally {
        await fixture.cleanup();
      }
    }, 20_000);
  }
});

class HistoryFixture {
  readonly directory: string;
  readonly agentDir: string;
  readonly cwd: string;
  readonly otherCwd: string;
  readonly env: Record<string, string>;
  readonly preloads: string[] = [];

  constructor() {
    mkdirSync(historyTestRoot, { recursive: true });
    this.directory = mkdtempSync(join(historyTestRoot, "test-"));
    this.agentDir = join(this.directory, "agent");
    this.cwd = join(this.directory, "workspace");
    this.otherCwd = join(this.directory, "other");
    this.env = {
      PATH: process.env.PATH ?? "",
      HOME: join(this.directory, "home"),
      XDG_RUNTIME_DIR: join(this.directory, "runtime"),
      PI_CODING_AGENT_DIR: this.agentDir,
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
    };
    mkdirSync(join(this.agentDir, "pi-tmux", "session-dirs"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(this.agentDir, "pi-tmux/pi-mux-restore.json"),
      JSON.stringify({
        version: 1,
        generation: "",
        workspaces: [
          { cwd: this.cwd, sessions: [] },
          { cwd: this.otherCwd, sessions: [] },
        ],
      }),
    );
  }

  subagentFile(cwd: string, id: string): string {
    const file = join(sessionGroupDirectory(this.agentDir, cwd), "subagents", `${id}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        type: "session",
        version: 1,
        id,
        cwd,
        timestamp: "2026-01-01T00:00:00.000Z",
      }) + "\n",
    );
    return file;
  }

  recordSessionRoot(root: string): void {
    const key = createHash("sha256").update(root).digest("hex");
    writeFileSync(
      join(this.agentDir, "pi-tmux", "session-dirs", `${key}.json`),
      JSON.stringify(root) + "\n",
    );
  }

  run(args: string[]) {
    return spawnSync(process.execPath, ["run", ...this.preloads, source, ...args], {
      env: this.env,
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  cleanup(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}

describe("history", () => {
  it("lists saved conversations of every registered workspace with titles", async () => {
    const fixture = new HistoryFixture();
    try {
      const titledId = randomUUID();
      const title = "Named\tsession\nwith\u001bcontrol\u202e";
      const titledFile = conversationFile(fixture.agentDir, fixture.cwd, titledId, {
        title,
        mtime: new Date("2026-01-02T00:00:00.000Z"),
        activity: "2026-01-02T00:00:01.000Z",
      });
      const untitledId = randomUUID();
      const untitledFile = conversationFile(fixture.agentDir, fixture.cwd, untitledId, {
        message: "fix the\n\n   build now",
        mtime: new Date("2026-01-01T00:00:00.000Z"),
      });
      fixture.subagentFile(fixture.cwd, randomUUID());
      const otherId = randomUUID();
      const otherFile = conversationFile(fixture.agentDir, fixture.otherCwd, otherId, {
        message: "review the diff",
        mtime: new Date("2026-01-03T00:00:00.000Z"),
        activity: "2026-01-03T00:00:01.000Z",
      });
      const table = fixture.run(["history"]);
      assert.equal(table.status, 0, table.stderr);
      assert.deepEqual(tableRows(table.stdout), [
        ["WORKSPACE", "SESSION ID", "UPDATED (UTC)", "TITLE"],
        [fixture.otherCwd, otherId, "2026-01-03T00:00:01.000Z", "review the diff"],
        [
          fixture.cwd,
          titledId,
          "2026-01-02T00:00:01.000Z",
          "Named\\u0009session\\u000awith\\u001bcontrol\\u202e",
        ],
        [fixture.cwd, untitledId, "2026-01-01T00:00:02.000Z", "fix the build now"],
      ]);

      const result = fixture.run(["history", "--json"]);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.endsWith("\n"));
      assert.deepEqual(JSON.parse(result.stdout), [
        historyEntry(otherFile, otherId, fixture.otherCwd, "review the diff", {
          mtime: Date.parse("2026-01-03T00:00:01.000Z"),
        }),
        historyEntry(titledFile, titledId, fixture.cwd, title, {
          mtime: Date.parse("2026-01-02T00:00:01.000Z"),
        }),
        historyEntry(untitledFile, untitledId, fixture.cwd, "fix the build now", {
          mtime: Date.parse("2026-01-01T00:00:02.000Z"),
        }),
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("restricts both formats to the requested cwd and returns no rows for unregistered cwds", async () => {
    const fixture = new HistoryFixture();
    try {
      const id = randomUUID();
      const file = conversationFile(fixture.agentDir, fixture.cwd, id, {});
      conversationFile(fixture.agentDir, fixture.otherCwd, randomUUID(), {});
      const headers = ["WORKSPACE", "SESSION ID", "UPDATED (UTC)", "TITLE"];
      const table = fixture.run(["history", "--cwd", fixture.cwd]);
      assert.equal(table.status, 0, table.stderr);
      assert.deepEqual(tableRows(table.stdout), [
        headers,
        [fixture.cwd, id, "2026-01-01T00:00:02.000Z", "-"],
      ]);

      for (const options of [
        ["--json", "--cwd", fixture.cwd],
        ["--cwd", fixture.cwd, "--json"],
      ]) {
        const restricted = fixture.run(["history", ...options]);
        assert.equal(restricted.status, 0, restricted.stderr);
        assert.deepEqual(JSON.parse(restricted.stdout), [
          historyEntry(file, id, fixture.cwd, null),
        ]);
      }

      const away = join(fixture.directory, "away");
      const emptyTable = fixture.run(["history", "--cwd", away]);
      assert.equal(emptyTable.status, 0, emptyTable.stderr);
      assert.deepEqual(tableRows(emptyTable.stdout), [headers]);
      const unregistered = fixture.run(["history", "--json", "--cwd", away]);
      assert.equal(unregistered.status, 0, unregistered.stderr);
      assert.deepEqual(JSON.parse(unregistered.stdout), []);
    } finally {
      fixture.cleanup();
    }
  });

  it("reports the session start time and the latest activity time", async () => {
    const fixture = new HistoryFixture();
    try {
      const activeId = randomUUID();
      const activeFile = conversationFile(fixture.agentDir, fixture.cwd, activeId, {
        mtime: new Date("2026-01-04T00:00:00.000Z"),
      });
      appendFileSync(
        activeFile,
        [
          { type: "custom", timestamp: "2026-01-02T11:00:00.000Z" },
          { type: "message", timestamp: "2026-01-02T12:00:00.000Z" },
          { type: "session_info", timestamp: "2026-01-02T13:00:00.000Z", name: "Late name" },
          { type: "compaction", timestamp: "2026-01-02T09:00:00.000Z" },
          { type: "message", text: "no timestamp" },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      const startedId = randomUUID();
      const startedFile = conversationFile(fixture.agentDir, fixture.cwd, startedId, {
        mtime: new Date("2026-01-03T00:00:00.000Z"),
      });
      const invalidId = randomUUID();
      const invalidFile = join(
        sessionGroupDirectory(fixture.agentDir, fixture.cwd),
        `2026-01-05T00-00-00-000Z_${invalidId}.jsonl`,
      );
      mkdirSync(dirname(invalidFile), { recursive: true });
      writeFileSync(
        invalidFile,
        JSON.stringify({ type: "session", version: 1, id: invalidId, cwd: fixture.cwd }) + "\n",
      );
      const result = fixture.run(["history", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [
        historyEntry(activeFile, activeId, fixture.cwd, "Late name", {
          mtime: Date.parse("2026-01-02T09:00:00.000Z"),
        }),
        historyEntry(startedFile, startedId, fixture.cwd, null),
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("ignores custom session directories recorded in session-dirs", async () => {
    const fixture = new HistoryFixture();
    try {
      const id = randomUUID();
      const root = join(
        fixture.directory,
        "alt-sessions",
        basename(sessionGroupDirectory(fixture.agentDir, fixture.cwd)),
      );
      const file = join(root, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
      mkdirSync(root, { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          type: "session",
          version: 1,
          id,
          cwd: fixture.cwd,
          timestamp: "2026-01-01T00:00:00.000Z",
        }) + "\n",
      );
      fixture.recordSessionRoot(root);
      const result = fixture.run(["history", "--json", "--cwd", fixture.cwd]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), []);
      assert.ok(existsSync(file));
    } finally {
      fixture.cleanup();
    }
  });

  it("skips conversations that disappear after listing", () => {
    const fixture = new HistoryFixture();
    try {
      const healthyId = randomUUID();
      const healthyFile = conversationFile(fixture.agentDir, fixture.cwd, healthyId, {});
      const deletedId = randomUUID();
      const deletedFile = conversationFile(fixture.agentDir, fixture.cwd, deletedId, {});
      const failStat = join(fixture.directory, "fail-stat.ts");
      writeFileSync(
        failStat,
        `import { spyOn } from "bun:test";
import * as fs from "node:fs";
const deleted = ${JSON.stringify(deletedFile)};
const original = fs.statSync;
spyOn(fs, "statSync").mockImplementation((...args) => {
  if (args[0] === deleted) throw Object.assign(new Error("deleted after listing"), { code: "ENOENT" });
  return Reflect.apply(original, fs, args);
});
`,
      );
      fixture.preloads.push("--preload", failStat);
      const result = fixture.run(["history", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [
        historyEntry(healthyFile, healthyId, fixture.cwd, null),
      ]);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("listing arguments", () => {
  it("rejects unsupported and repeated options", () => {
    for (const args of [
      ["current"],
      ["list", "--client-pid", "123"],
      ["list", "--active", "--client-pid", "123"],
      ["list", "--saved", "--client-pid", "123"],
      ["list", "--displayed", "--cwd", "/tmp"],
      ["list", "--displayed", "--saved"],
      ["list", "--active", "--displayed"],
      ["list", "--displayed", "--displayed"],
      ["list", "--displayed", "--client-pid"],
      ["list", "--displayed", "--client-pid", "0", "--json"],
      ["list", "--displayed", "--client-pid", "9007199254740993"],
      ["list", "--displayed", "--client-pid", "123", "--client-pid", "456"],
      ["list", "--displayed", "--json", "--json"],
      ["history", "--json", "--cwd", "relative"],
      ["history", "--cwd", "/tmp", "--json", "--json"],
    ]) {
      assert.throws(() => parseOperation(args), /usage: pi-mux/, args.join(" "));
    }
  });

  it("shows the listing options in top-level help", () => {
    const result = spawnSync(process.execPath, ["run", source, "--help"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pi-mux list \[--json\]/);
    assert.match(result.stdout, /pi-mux list --active \[--json\]/);
    assert.match(result.stdout, /pi-mux list --saved \[--cwd <absolute-cwd>\] \[--json\]/);
    assert.match(result.stdout, /pi-mux list --displayed \[--client-pid <pid>\] \[--json\]/);
    assert.doesNotMatch(result.stdout, /pi-mux current\b/);
    assert.match(result.stdout, /pi-mux history \[--cwd <absolute-cwd>\] \[--json\]/);
  });
});

type RestoreDocument = {
  version: 1;
  generation: string;
  workspaces: { cwd: string; sessions: string[] }[];
};

function restoreFile(fixture: { agentDir: string }): string {
  return join(fixture.agentDir, "pi-tmux/pi-mux-restore.json");
}

function restoreDocument(fixture: { agentDir: string }): RestoreDocument {
  return JSON.parse(readFileSync(restoreFile(fixture), "utf8"));
}

describe("unified workspace persistence", () => {
  it("lists registered empty and stopped workspaces without changing candidates or generation", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      const emptyCwd = join(fixture.directory, "registered-empty");
      const disappearedCwd = join(fixture.directory, "disappeared");
      const previous: RestoreDocument = {
        version: 1,
        generation: "saved-generation",
        workspaces: [
          { cwd: fixture.cwd, sessions: [id] },
          { cwd: emptyCwd, sessions: [] },
          { cwd: disappearedCwd, sessions: [] },
        ],
      };
      const bytes = JSON.stringify(previous);
      writeFileSync(restoreFile(fixture), bytes);
      const table = fixture.run(["list", "--active"]);
      assert.equal(table.status, 0, table.stderr);
      assert.deepEqual(tableRows(table.stdout), [["WORKSPACE", "SESSION ID", "STATE", "TITLE"]]);
      const result = fixture.run(["list", "--active", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.endsWith("\n"));
      assert.deepEqual(
        JSON.parse(result.stdout),
        previous.workspaces.map(({ cwd }) => ({ cwd, sessions: [], empty: [] })),
      );
      assert.equal(readFileSync(restoreFile(fixture), "utf8"), bytes);
      assert.equal(existsSync(fixture.socket), false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps an unregistered workspace absent until explicitly registered again", async () => {
    const fixture = new SessionFixture();
    try {
      assert.equal(fixture.run(["list", "--active"]).status, 0);
      const result = fixture.run(["workspace", "unregister", fixture.cwd]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.deepEqual(restoreDocument(fixture).workspaces, []);
      assert.deepEqual(JSON.parse(fixture.run(["list", "--active", "--json"]).stdout), []);
      assert.deepEqual(JSON.parse(fixture.run(["history", "--json"]).stdout), []);
      const registered = fixture.run(["workspace", "register", fixture.cwd]);
      assert.equal(registered.status, 0, registered.stderr);
      assert.deepEqual(restoreDocument(fixture).workspaces, [{ cwd: fixture.cwd, sessions: [] }]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("registers an empty workspace without starting tmux", async () => {
    const fixture = new SessionFixture();
    try {
      rmSync(restoreFile(fixture));
      const result = fixture.run(["workspace", "register", fixture.cwd]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.deepEqual(restoreDocument(fixture), {
        version: 1,
        generation: "",
        workspaces: [{ cwd: fixture.cwd, sessions: [] }],
      });
      assert.equal(existsSync(fixture.socket), false);
      assert.deepEqual(JSON.parse(fixture.run(["list", "--active", "--json"]).stdout), [
        { cwd: fixture.cwd, sessions: [], empty: [] },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it.skipIf(process.platform !== "win32")("persists workspace registration on Windows", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-mux-register-"));
    const agentDir = join(cwd, "agent");
    try {
      assert.ok(realTmux, "psmux must be available as tmux on PATH");
      const result = spawnSync(process.execPath, [source, "workspace", "register", cwd], {
        cwd,
        env: { ...process.env, USERPROFILE: cwd, PI_CODING_AGENT_DIR: agentDir },
        encoding: "utf8",
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const restore = join(agentDir, "pi-tmux", "pi-mux-restore.json");
      assert.deepEqual(JSON.parse(readFileSync(restore, "utf8")), {
        version: 1,
        generation: "",
        workspaces: [{ cwd, sessions: [] }],
      });
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  it("keeps candidates and registration after a failed atomic save and allows retry", () => {
    const fixture = new HistoryFixture();
    try {
      mkdirSync(fixture.otherCwd);
      const previous = JSON.stringify({
        version: 1,
        generation: "previous",
        workspaces: [{ cwd: fixture.cwd, sessions: ["retry-session"] }],
      });
      writeFileSync(restoreFile(fixture), previous);
      const failRename = join(fixture.directory, "fail-restore-rename.ts");
      writeFileSync(
        failRename,
        `import { spyOn } from "bun:test";
import * as fs from "node:fs";
const original = fs.renameSync;
spyOn(fs, "renameSync").mockImplementation((...args) => {
  if (args[1] === ${JSON.stringify(restoreFile(fixture))}) throw new Error("injected snapshot save failure");
  return Reflect.apply(original, fs, args);
});
`,
      );
      fixture.preloads.push("--preload", failRename);
      const failed = fixture.run(["workspace", "register", fixture.otherCwd]);
      assert.equal(failed.status, 1);
      assert.match(failed.stderr, /injected snapshot save failure/);
      assert.equal(readFileSync(restoreFile(fixture), "utf8"), previous);
      fixture.preloads.length = 0;
      const retried = fixture.run(["workspace", "register", fixture.otherCwd]);
      assert.equal(retried.status, 0, retried.stderr);
      assert.deepEqual(restoreDocument(fixture), {
        version: 1,
        generation: "previous",
        workspaces: [
          { cwd: fixture.cwd, sessions: ["retry-session"] },
          { cwd: fixture.otherCwd, sessions: [] },
        ],
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("serializes concurrent registration without dropping candidates or cwd entries", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      writeFileSync(
        restoreFile(fixture),
        JSON.stringify({
          version: 1,
          generation: "previous",
          workspaces: [{ cwd: fixture.cwd, sessions: [id] }],
        }),
      );
      const cwds = Array.from({ length: 6 }, (_, index) =>
        join(fixture.directory, `workspace-${index}`),
      );
      for (const cwd of cwds) mkdirSync(cwd);
      const commands = [
        ["list", "--active"],
        ["history"],
        ...cwds.map((cwd) => ["workspace", "register", cwd]),
      ];
      const results = await Promise.all(
        commands.map(async (args) => {
          const child = Bun.spawn([process.execPath, "run", source, ...args], {
            env: fixture.env,
            stdout: "pipe",
            stderr: "pipe",
          });
          const [status, stderr] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
          ]);
          return { status, stderr };
        }),
      );
      for (const result of results) assert.equal(result.status, 0, result.stderr);
      const snapshot = restoreDocument(fixture);
      assert.equal(snapshot.generation, "previous");
      assert.deepEqual(snapshot.workspaces.find(({ cwd }) => cwd === fixture.cwd)?.sessions, [id]);
      assert.deepEqual(
        snapshot.workspaces.map(({ cwd }) => cwd).sort(),
        [fixture.cwd, ...cwds].sort(),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("retains empty registrations and failed candidates across snapshot and close", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      const temporaryId = randomUUID();
      const failedId = randomUUID();
      const emptyCwd = join(fixture.directory, "empty");
      const generation = "current-generation";
      fixture.piSession("normal", { id, file: join(fixture.directory, "normal.jsonl") });
      fixture.piSession("temporary", {
        id: temporaryId,
        file: join(fixture.directory, "temporary.jsonl"),
        temporary: true,
      });
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", generation]);
      fixture.tmux(["set-option", "-g", `@pi-mux-restoring-${failedId}`, "1"]);
      writeFileSync(
        restoreFile(fixture),
        JSON.stringify({
          version: 1,
          generation,
          workspaces: [
            { cwd: fixture.cwd, sessions: [id, temporaryId, failedId] },
            { cwd: emptyCwd, sessions: [] },
          ],
        }),
      );
      const snapshot = fixture.run(["snapshot", generation]);
      assert.equal(snapshot.status, 0, snapshot.stderr);
      assert.deepEqual(restoreDocument(fixture).workspaces, [
        { cwd: fixture.cwd, sessions: [failedId, id] },
        { cwd: emptyCwd, sessions: [] },
      ]);
      const closed = fixture.run(["close", id]);
      assert.equal(closed.status, 0, closed.stderr);
      const failedClosed = fixture.run(["close", failedId]);
      assert.equal(failedClosed.status, 0, failedClosed.stderr);
      assert.deepEqual(restoreDocument(fixture).workspaces, [
        { cwd: fixture.cwd, sessions: [] },
        { cwd: emptyCwd, sessions: [] },
      ]);
      const afterClose = fixture.run(["snapshot", generation]);
      assert.equal(afterClose.status, 0, afterClose.stderr);
      assert.deepEqual(restoreDocument(fixture).workspaces[0]?.sessions, []);
    } finally {
      await fixture.cleanup();
    }
  });

  it("collects every managed session and restore marker with a bounded number of tmux calls", async () => {
    const fixture = new SessionFixture();
    try {
      const ids = Array.from({ length: 48 }, () => randomUUID());
      const generation = "batch-generation";
      for (const [index, id] of ids.entries()) {
        fixture.piSession(`managed-${index}`, { id, file: join(fixture.directory, `${id}.jsonl`) });
        fixture.tmux(["set-option", "-g", `@pi-mux-restoring-${id}`, "1"]);
      }
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", generation]);
      writeFileSync(
        restoreFile(fixture),
        JSON.stringify({
          version: 1,
          generation,
          workspaces: [{ cwd: fixture.cwd, sessions: ids }],
        }),
      );
      const wrapper = join(fixture.directory, "bin/tmux");
      const log = join(fixture.directory, "commands.log");
      const before = readFileSync(wrapper, "utf8");
      writeFileSync(
        wrapper,
        before.replace("exec ", `printf '%s\\n' "$5" >> ${JSON.stringify(log)}\nexec `),
      );
      const result = fixture.run(["snapshot", generation]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(restoreDocument(fixture).workspaces, [{ cwd: fixture.cwd, sessions: ids }]);
      const commands = readFileSync(log, "utf8").trim().split("\n");
      assert.equal(commands.filter((command) => command === "list-sessions").length, 1);
      assert.equal(commands.filter((command) => command === "-C").length, 2);
      assert.equal(commands.filter((command) => command === "show-environment").length, 0);
      assert.equal(commands.filter((command) => command === "display-message").length, 0);
      assert.equal(commands.filter((command) => command === "show-options").length, 2);
      assert.equal(commands.length, 5);
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves the snapshot when the batched tmux response is incomplete", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      fixture.piSession("managed", { id, file: join(fixture.directory, "managed.jsonl") });
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", "batch-generation"]);
      const wrapper = join(fixture.directory, "bin/tmux");
      const beforeWrapper = readFileSync(wrapper, "utf8");
      writeFileSync(
        wrapper,
        beforeWrapper.replace(
          "exec ",
          'if [ "$5" = -C ]; then printf "%s\\n" "%begin 1 1 0"; exit 1; fi\nexec ',
        ),
      );
      const before = readFileSync(restoreFile(fixture), "utf8");
      const result = fixture.run(["snapshot"]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /invalid tmux control response/);
      assert.equal(readFileSync(restoreFile(fixture), "utf8"), before);
    } finally {
      await fixture.cleanup();
    }
  });

  for (const state of ["trailing-whitespace", "mismatched", "hidden"] as const) {
    it(`keeps the existing temporary-environment comparison (${state})`, async () => {
      const fixture = new SessionFixture();
      try {
        const id = randomUUID();
        fixture.piSession("managed", { id, file: join(fixture.directory, "managed.jsonl") });
        fixture.tmux([
          "set-environment",
          ...(state === "hidden" ? ["-h"] : []),
          "-t",
          "managed",
          "PI_TMUX_TEMPORARY",
          state === "trailing-whitespace" ? `${id}\n ` : state === "hidden" ? id : randomUUID(),
        ]);
        fixture.tmux(["set-option", "-g", "@pi-mux-generation", "batch-generation"]);
        const result = fixture.run(["snapshot"]);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(restoreDocument(fixture).workspaces, [
          {
            cwd: fixture.cwd,
            sessions: state === "trailing-whitespace" ? [] : [id],
          },
        ]);
      } finally {
        await fixture.cleanup();
      }
    });
  }

  it("does not treat global environment values as session-local management or temporary state", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      fixture.piSession("managed", { id, file: join(fixture.directory, "managed.jsonl") });
      fixture.plainSession("unmanaged");
      fixture.tmux(["set-environment", "-gh", "PI_TMUX_SESSION_ID", randomUUID()]);
      fixture.tmux(["set-environment", "-g", "PI_TMUX_TEMPORARY", id]);
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", "batch-generation"]);
      const result = fixture.run(["snapshot"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(restoreDocument(fixture).workspaces, [{ cwd: fixture.cwd, sessions: [id] }]);
    } finally {
      await fixture.cleanup();
    }
  });

  for (const cwdSuffix of ['space 日本😀\\quote"\tline\nend', "dollar$path\u0001"]) {
    it(`preserves the session cwd when tmux quotes or escapes it (${JSON.stringify(cwdSuffix)})`, async () => {
      const fixture = new SessionFixture();
      let pid = "";
      try {
        const id = randomUUID();
        const cwd = join(fixture.directory, cwdSuffix);
        mkdirSync(cwd);
        pid = fixture.tmux([
          "new-session",
          "-d",
          "-s",
          "escaped",
          "-c",
          cwd,
          "-P",
          "-F",
          "#{pane_pid}",
          "/bin/sleep",
          "300",
        ]);
        fixture.tmux(["set-environment", "-t", "escaped", "PI_TMUX_SESSION_ID", id]);
        fixture.tmux(["set-option", "-g", "@pi-mux-generation", "batch-generation"]);
        const result = fixture.run(["snapshot"]);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(restoreDocument(fixture).workspaces, [
          { cwd: fixture.cwd, sessions: [] },
          { cwd, sessions: [id] },
        ]);
      } finally {
        await fixture.cleanup();
        if (pid) await waitUntil(() => !existsSync(`/proc/${pid}`));
      }
    });
  }

  for (const invalidId of ["", "invalid\nid", "invalid\u0001id", "hidden-id"]) {
    it(`rejects invalid or hidden session-local IDs without changing the snapshot (${JSON.stringify(invalidId)})`, async () => {
      const fixture = new SessionFixture();
      try {
        fixture.plainSession("invalid");
        fixture.tmux([
          "set-environment",
          ...(invalidId === "hidden-id" ? ["-h"] : []),
          "-t",
          "invalid",
          "PI_TMUX_SESSION_ID",
          invalidId,
        ]);
        fixture.tmux(["set-option", "-g", "@pi-mux-generation", "batch-generation"]);
        const before = readFileSync(restoreFile(fixture), "utf8");
        const result = fixture.run(["snapshot"]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Invalid conversation ID/);
        assert.equal(readFileSync(restoreFile(fixture), "utf8"), before);
      } finally {
        await fixture.cleanup();
      }
    });
  }

  for (const marker of [" 1 ", "", "invalid"]) {
    it(`preserves restore-marker validation when option values need decoding (${JSON.stringify(marker)})`, async () => {
      const fixture = new SessionFixture();
      try {
        const id = randomUUID();
        const generation = "batch-generation";
        fixture.plainSession("server");
        fixture.tmux(["set-option", "-g", "@pi-mux-generation", generation]);
        fixture.tmux(["set-option", "-g", `@pi-mux-restoring-${id}`, marker]);
        const before = JSON.stringify({
          version: 1,
          generation,
          workspaces: [{ cwd: fixture.cwd, sessions: [id] }],
        });
        writeFileSync(restoreFile(fixture), before);
        const result = fixture.run(["snapshot"]);
        if (marker === "invalid") {
          assert.equal(result.status, 1);
          assert.match(result.stderr, /Invalid in-memory restore state/);
          assert.equal(readFileSync(restoreFile(fixture), "utf8"), before);
        } else {
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(restoreDocument(fixture).workspaces, [
            { cwd: fixture.cwd, sessions: marker.trim() ? [id] : [] },
          ]);
        }
      } finally {
        await fixture.cleanup();
      }
    });
  }

  it("adopts a registration-only generation while rejecting stale snapshot hooks", async () => {
    const fixture = new SessionFixture();
    try {
      fixture.plainSession("server");
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", "current-generation"]);
      const previous = JSON.stringify({
        version: 1,
        generation: "",
        workspaces: [{ cwd: fixture.cwd, sessions: [] }],
      });
      writeFileSync(restoreFile(fixture), previous);
      const stale = fixture.run(["snapshot", "old-generation"]);
      assert.equal(stale.status, 0, stale.stderr);
      assert.equal(readFileSync(restoreFile(fixture), "utf8"), previous);
      const current = fixture.run(["snapshot", "current-generation"]);
      assert.equal(current.status, 0, current.stderr);
      assert.deepEqual(restoreDocument(fixture), {
        version: 1,
        generation: "current-generation",
        workspaces: [{ cwd: fixture.cwd, sessions: [] }],
      });
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", "another-generation"]);
      const before = readFileSync(restoreFile(fixture), "utf8");
      const mismatched = fixture.run(["snapshot", "another-generation"]);
      assert.equal(mismatched.status, 0, mismatched.stderr);
      assert.equal(readFileSync(restoreFile(fixture), "utf8"), before);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps registrations and retry candidates after restore failure and removes only missing saved sessions", async () => {
    const fixture = new SessionFixture();
    try {
      writeFileSync(join(fixture.directory, "bin/pi"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
      const missingId = randomUUID();
      const failedId = randomUUID();
      const failedCwd = join(fixture.directory, "missing-cwd");
      const emptyCwd = join(fixture.directory, "empty");
      conversationFile(fixture.agentDir, failedCwd, failedId);
      writeFileSync(
        restoreFile(fixture),
        JSON.stringify({
          version: 1,
          generation: "previous-generation",
          workspaces: [
            { cwd: fixture.cwd, sessions: [missingId] },
            { cwd: failedCwd, sessions: [failedId] },
            { cwd: emptyCwd, sessions: [] },
          ],
        }),
      );
      const restored = fixture.run(["restore"]);
      assert.equal(restored.status, 2, restored.stderr);
      assert.match(restored.stderr, /saved conversation not found; removed/);
      assert.match(restored.stderr, new RegExp(failedId));
      const snapshot = restoreDocument(fixture);
      assert.notEqual(snapshot.generation, "previous-generation");
      assert.deepEqual(snapshot.workspaces, [
        { cwd: fixture.cwd, sessions: [] },
        { cwd: failedCwd, sessions: [failedId] },
        { cwd: emptyCwd, sessions: [] },
      ]);
      const after = fixture.run(["snapshot", snapshot.generation]);
      assert.equal(after.status, 0, after.stderr);
      assert.deepEqual(restoreDocument(fixture), snapshot);
    } finally {
      await fixture.cleanup();
    }
  });

  it("retains empty registrations on running promotion", async () => {
    const fixture = new CloseFixture("none");
    try {
      fixture.start();
      fixture.tmux(["set-environment", "-t", "target", "PI_TMUX_TEMPORARY", fixture.id]);
      fixture.tmux(["set-option", "-g", `@pi-mux-restoring-${fixture.otherId}`, "1"]);
      const emptyCwd = join(fixture.directory, "empty");
      const previous = JSON.parse(readFileSync(fixture.restore, "utf8"));
      previous.workspaces.push({ cwd: emptyCwd, sessions: [] });
      writeFileSync(fixture.restore, JSON.stringify(previous));
      const result = notify(fixture, ["running", "--title", "null"]);
      assert.equal(result.status, 0, result.stderr);
      const snapshot = JSON.parse(readFileSync(fixture.restore, "utf8"));
      assert.deepEqual(
        snapshot.workspaces.find(({ cwd }: { cwd: string }) => cwd === emptyCwd),
        { cwd: emptyCwd, sessions: [] },
      );
      assert.deepEqual(
        snapshot.workspaces[0].sessions.sort(),
        [fixture.id, fixture.otherId].sort(),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("unregisters a live workspace without dropping another workspace or its retry candidate", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      const otherCwd = join(fixture.directory, "other");
      fixture.piSession("target", { id, file: join(fixture.directory, "target.jsonl") });
      writeFileSync(
        restoreFile(fixture),
        JSON.stringify({
          version: 1,
          generation: "current",
          workspaces: [
            { cwd: fixture.cwd, sessions: [id] },
            { cwd: otherCwd, sessions: ["retry-id"] },
          ],
        }),
      );
      const result = fixture.run(["workspace", "unregister", fixture.cwd]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fixture.tmux(["list-sessions", "-F", "#{session_id}"]), "");
      assert.deepEqual(restoreDocument(fixture), {
        version: 1,
        generation: "current",
        workspaces: [{ cwd: otherCwd, sessions: ["retry-id"] }],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves registration through temporary open, normal promotion, and independent new sessions", async () => {
    const fixture = new SessionFixture();
    try {
      writeFileSync(
        join(fixture.directory, "bin/pi"),
        `#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const fileIndex = process.argv.indexOf("--session");
const id = process.env.PI_TMUX_SESSION_ID;
const file = fileIndex >= 0 ? process.argv[fileIndex + 1] : join(process.env.PI_CODING_AGENT_DIR, "sessions", id + ".jsonl");
const metadata = { id, cwd: process.cwd(), file, pid: process.pid, startup: "ready" };
const result = spawnSync(${JSON.stringify(realTmux)}, ["-S", ${JSON.stringify(fixture.socket)}, "set-option", "-p", "-t", process.env.TMUX_PANE, "@pi-tmux-session", Buffer.from(JSON.stringify(metadata)).toString("base64")]);
if (result.status !== 0) process.exit(99);
await Bun.sleep(300000);
`,
        { mode: 0o700 },
      );
      writeFileSync(
        join(fixture.directory, "bin/tmux"),
        `#!/bin/sh
if [ "$1" != -S ] || [ "$2" != ${JSON.stringify(fixture.socket)} ]; then exit 64; fi
if [ "$3" = attach-session ]; then exit 0; fi
exec ${JSON.stringify(realTmux)} "$@"
`,
        { mode: 0o700 },
      );
      const id = randomUUID();
      conversationFile(fixture.agentDir, fixture.cwd, id);
      writeFileSync(
        restoreFile(fixture),
        JSON.stringify({
          version: 1,
          generation: "old-generation",
          workspaces: [{ cwd: fixture.cwd, sessions: [id] }],
        }),
      );
      const temporary = fixture.run(["open", "--temporary", id]);
      assert.equal(temporary.status, 0, temporary.stderr);
      assert.deepEqual(restoreDocument(fixture).workspaces, [{ cwd: fixture.cwd, sessions: [] }]);
      const beforePid = fixture.tmux(["list-panes", "-a", "-F", "#{pane_pid}"]);
      const normal = fixture.run(["open", id]);
      assert.equal(normal.status, 0, normal.stderr);
      assert.equal(fixture.tmux(["list-panes", "-a", "-F", "#{pane_pid}"]), beforePid);
      assert.deepEqual(restoreDocument(fixture).workspaces, [{ cwd: fixture.cwd, sessions: [id] }]);
      const firstNew = fixture.run(["new", "--detached"]);
      assert.equal(firstNew.status, 0, firstNew.stderr);
      const secondNew = fixture.run(["new", "--detached"]);
      assert.equal(secondNew.status, 0, secondNew.stderr);
      const firstId = /^Pi session (\S+)\n/.exec(firstNew.stdout)?.[1];
      const secondId = /^Pi session (\S+)\n/.exec(secondNew.stdout)?.[1];
      assert.ok(firstId && secondId);
      assert.notEqual(secondId, firstId);
      const list = fixture.run(["list", "--active", "--json"]);
      assert.equal(list.status, 0, list.stderr);
      const listed = JSON.parse(list.stdout);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].sessions[0].id, id);
      assert.deepEqual(
        listed[0].empty.map((entry: { id: string }) => entry.id).sort(),
        [firstId, secondId].sort(),
      );
    } finally {
      await fixture.cleanup();
    }
  }, 20000);
});

function prepareManagedPi(
  fixture: SessionFixture,
  publicationGates?: { metadata: string; state: string; id?: string },
): void {
  writeFileSync(
    join(fixture.directory, "bin/pi"),
    `#!${process.execPath}
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const id = process.env.PI_TMUX_SESSION_ID;
const sessionIndex = process.argv.indexOf("--session");
const file = sessionIndex >= 0
  ? process.argv[sessionIndex + 1]
  : join(process.env.PI_CODING_AGENT_DIR, "sessions", id + ".jsonl");
const pane = process.env.TMUX_PANE;
const metadata = {
  id,
  cwd: process.cwd(),
  file,
  pid: process.pid,
  startup: "ready",
  token: process.env.PI_TMUX_LAUNCH_TOKEN,
};
function tmux(args) {
  const result = spawnSync(${JSON.stringify(realTmux)}, ["-S", ${JSON.stringify(fixture.socket)}, ...args]);
  if (result.status !== 0) process.exit(99);
}
${
  publicationGates
    ? `const gated = ${publicationGates.id === undefined ? "true" : `id === ${JSON.stringify(publicationGates.id)}`};
while (gated && !(await Bun.file(${JSON.stringify(publicationGates.metadata)}).exists())) await Bun.sleep(10);`
    : ""
}
tmux(["set-option", "-p", "-t", pane, "@pi-tmux-session", Buffer.from(JSON.stringify(metadata)).toString("base64")]);
${publicationGates ? `while (gated && !(await Bun.file(${JSON.stringify(publicationGates.state)}).exists())) await Bun.sleep(10);` : ""}
tmux(["set-option", "-p", "-t", pane, "@pi_session_state", JSON.stringify({version:1,sessionId:id,state:"waiting-user"})]);
appendFileSync(${JSON.stringify(join(fixture.directory, "launches.jsonl"))}, JSON.stringify({id,cwd:process.cwd(),args:process.argv.slice(2)}) + "\\n");
await Bun.sleep(300000);
`,
    { mode: 0o700 },
  );
}

function restartState(fixture: SessionFixture, target: string, id: string, state: string): void {
  fixture.tmux([
    "set-option",
    "-p",
    "-t",
    target,
    "@pi_session_state",
    JSON.stringify({ version: 1, sessionId: id, state }),
  ]);
}

function startRestart(fixture: SessionFixture, args: string[] = []) {
  return startLifecycleCommand(fixture, ["restart", ...args]);
}

function startLifecycleCommand(fixture: SessionFixture, args: string[]) {
  return Bun.spawn([process.execPath, "run", source, ...args], {
    cwd: fixture.cwd,
    env: fixture.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function finishRestart(child: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  assert.equal(status, 0, stderr);
}

function addManagedSession(fixture: SessionFixture, name: string, state: string): string {
  const id = randomUUID();
  const file = conversationFile(fixture.agentDir, fixture.cwd, id);
  fixture.piSession(name, { id, file });
  fixture.tmux(["set-option", "-g", "@pi-mux-generation", "before-restart"]);
  restartState(fixture, name, id, state);
  return id;
}

function startReload(fixture: SessionFixture, args: string[] = []) {
  return Bun.spawn([process.execPath, "run", source, "reload", ...args], {
    cwd: fixture.cwd,
    env: fixture.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function finishReload(child: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

describe("inspect", () => {
  it("requires exactly one complete conversation ID", () => {
    assert.deepEqual(parseOperation(["inspect", "exact.id"]), { kind: "inspect", id: "exact.id" });
    for (const args of [[], ["--json", "exact.id"], ["exact.id", "extra"], ["../exact.id"]])
      assert.throws(() => parseOperation(["inspect", ...args]), /usage:/);
  });

  it("reports absence and resolves normal before archived saves without changing state", async () => {
    const fixture = new SessionFixture();
    try {
      fixture.plainSession("plain");
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", "stable"]);
      const id = "stopped-conversation";
      const archived = archiveConversation(conversationFile(fixture.agentDir, fixture.cwd, id));
      const normal = conversationFile(fixture.agentDir, fixture.cwd, id);
      const snapshot = JSON.stringify({
        version: 1,
        generation: "stable",
        workspaces: [{ cwd: fixture.cwd, sessions: [id] }],
      });
      writeFileSync(restoreFile(fixture), snapshot);
      const registry = join(fixture.agentDir, "pi-tmux/session-dirs");

      for (const [target, file] of [
        [id, normal],
        ["stopped", null],
      ] as const) {
        const result = fixture.run(["inspect", target]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.deepEqual(JSON.parse(result.stdout), { state: "absent", file });
      }
      rmSync(normal);
      const archivedResult = fixture.run(["inspect", id]);
      assert.equal(archivedResult.status, 0, archivedResult.stderr);
      assert.deepEqual(JSON.parse(archivedResult.stdout), { state: "absent", file: archived });
      assert.equal(readFileSync(restoreFile(fixture), "utf8"), snapshot);
      assert.deepEqual(readdirSync(registry), []);
      assert.equal(fixture.tmux(["list-sessions", "-F", "#{session_name}"]), "plain");
      assert.deepEqual(fixture.clients(), []);
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports absence on an initialized server with no sessions", async () => {
    const fixture = new SessionFixture();
    try {
      fixture.tmux(["start-server"]);
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", "stable"]);
      const result = fixture.run(["inspect", "missing"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { state: "absent", file: null });
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports published, managed starting, and restoring conversations as present", async () => {
    const fixture = new SessionFixture();
    try {
      fixture.plainSession("dispatcher-pi");
      fixture.tmux(["set-environment", "-t", "dispatcher-pi", "TICKET_DISPATCH_ROLE", "pi"]);
      fixture.piWindow("dispatcher-pi", {
        id: "published",
        file: join(fixture.cwd, "published.jsonl"),
      });
      fixture.tmux(["kill-pane", "-t", "dispatcher-pi:0"]);
      const launchToken = randomUUID();
      const pid = Number(
        fixture.tmux([
          "new-session",
          "-d",
          "-s",
          "starting",
          "-c",
          fixture.cwd,
          "-P",
          "-F",
          "#{pane_pid}",
          "-e",
          "PI_TMUX_SESSION_ID=initializing",
          "-e",
          `PI_TMUX_LAUNCH_TOKEN=${launchToken}`,
          "/bin/sleep",
          "300",
        ]),
      );
      fixture.tmux([
        "set-option",
        "-p",
        "-t",
        "starting",
        "@pi-mux-launch",
        JSON.stringify({ id: "initializing", pid, token: launchToken }),
      ]);
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", "stable"]);
      fixture.tmux(["set-option", "-g", "@pi-mux-restoring-restoring", "1"]);

      for (const id of ["published", "initializing", "restoring"]) {
        const result = fixture.run(["inspect", id]);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { state: "present" });
      }
      assert.equal(fixture.tmux(["show-options", "-gqv", "@pi-mux-restoring-restoring"]), "1");
    } finally {
      await fixture.cleanup();
    }
  });

  it("cannot infer absence from an unpublished dispatcher pi or orphaned launch record", async () => {
    const fixture = new SessionFixture();
    try {
      fixture.plainSession("unpublished");
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", "stable"]);
      fixture.tmux(["set-environment", "-t", "unpublished", "TICKET_DISPATCH_ROLE", "pi"]);
      const dispatcher = fixture.run(["inspect", "unknown-id"]);
      assert.equal(dispatcher.status, 1);
      assert.equal(dispatcher.stdout, "");
      assert.match(dispatcher.stderr, /Cannot identify the starting pi/);

      fixture.tmux(["set-environment", "-u", "-t", "unpublished", "TICKET_DISPATCH_ROLE"]);
      fixture.tmux(["set-option", "-p", "-t", "unpublished", "@pi-mux-launch", "orphan"]);
      const orphan = fixture.run(["inspect", "unknown-id"]);
      assert.equal(orphan.status, 1);
      assert.equal(orphan.stdout, "");
      assert.match(orphan.stderr, /Cannot identify the starting pi/);
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses duplicate saved and running matches", async () => {
    const fixture = new SessionFixture();
    try {
      fixture.plainSession("plain");
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", "stable"]);
      const id = "duplicate";
      const file = conversationFile(fixture.agentDir, fixture.cwd, id);
      conversationFile(fixture.agentDir, fixture.directory, id);
      const saved = fixture.run(["inspect", id]);
      assert.equal(saved.status, 1);
      assert.equal(saved.stdout, "");
      assert.match(saved.stderr, /Ambiguous session ID/);

      fixture.piWindow("plain", { id, file });
      fixture.piWindow("plain", { id, file });
      const running = fixture.run(["inspect", id]);
      assert.equal(running.status, 1);
      assert.equal(running.stdout, "");
      assert.match(running.stderr, /Multiple pi processes/);
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails without waiting during a concurrent pi-mux management operation", async () => {
    const fixture = new SessionFixture();
    const lock = createServer();
    try {
      fixture.plainSession("plain");
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", "stable"]);
      await holdSharedLock(fixture, lock);
      const result = fixture.run(["inspect", "missing"]);
      assert.equal(result.status, 75);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /holds the lock/);
    } finally {
      lock.close();
      await fixture.cleanup();
    }
  });

  it("cannot infer absence when an inventory query fails", async () => {
    const fixture = new SessionFixture();
    try {
      fixture.plainSession("plain");
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", "stable"]);
      fixture.beforeCliTmux(`if [ "$6" = list-panes ]; then
  printf '%s\\n' 'no current target' >&2
  exit 1
fi`);
      const result = fixture.run(["inspect", "missing"]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Cannot confirm an empty tmux pane inventory/);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects observations if the server generation changes during inspection", async () => {
    const fixture = new SessionFixture();
    try {
      fixture.plainSession("plain");
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", "before"]);
      fixture.beforeCliTmux(`if [ "$6" = list-panes ]; then
  ${JSON.stringify(realTmux)} -S "$2" set-option -g @pi-mux-generation after
fi`);
      const result = fixture.run(["inspect", "missing"]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Dedicated server changed during inspect/);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not create missing state or start an unavailable server", async () => {
    const fixture = new SessionFixture();
    try {
      const unavailable = fixture.run(["inspect", "missing"]);
      assert.equal(unavailable.status, 1);
      assert.equal(unavailable.stdout, "");
      assert.match(unavailable.stderr, /dedicated tmux server is not running/);
      assert.equal(existsSync(fixture.socket), false);
      const state = join(fixture.agentDir, "pi-tmux");
      rmSync(state, { recursive: true });
      const missingState = fixture.run(["inspect", "missing"]);
      assert.equal(missingState.status, 1);
      assert.equal(missingState.stdout, "");
      assert.match(missingState.stderr, /Cannot inspect session missing/);
      assert.equal(existsSync(state), false);
      assert.equal(existsSync(fixture.socket), false);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("inspect --dispatch-ticket", () => {
  const ownerId = "ticket-owner";
  const project = "調査;";
  const ticketId = "20260920-120418.follow-up";
  const scopedName = "handle_20260920-120418_follow-up";
  const name = `handle_${Buffer.from(project, "utf8").toString("hex")}_20260920-120418_follow-up`;

  function dispatchArgs(socket: string, cwd: string, prompt = "Investigate this ticket") {
    return ["inspect", "--dispatch-ticket", ownerId, socket, project, ticketId, name, cwd, prompt];
  }

  function initialize(fixture: SessionFixture, firstSession = "plain"): void {
    fixture.plainSession(firstSession);
    fixture.tmux(["set-option", "-g", "@pi-mux-generation", "stable"]);
  }

  it("accepts only the fixed shape and validates each input", () => {
    const args = dispatchArgs("/socket", "/workspace");
    assert.deepEqual(parseOperation(args), {
      kind: "inspect-dispatch-ticket",
      ownerId,
      socket: "/socket",
      project,
      ticketId,
      sessionName: name,
      cwd: "/workspace",
      prompt: "Investigate this ticket",
    });
    const scopedArgs = args.with(6, scopedName);
    assert.equal(parseOperation(scopedArgs).kind, "inspect-dispatch-ticket");
    assert.throws(() => parseOperation(args.slice(0, -1)), /Invalid argument count/);
    assert.throws(() => parseOperation([...args, "extra"]), /Invalid argument count/);
    for (const [index, value, error] of [
      [2, "--flag", /Invalid ticket owner ID/],
      [2, "owner\n", /Invalid ticket owner ID/],
      [3, "", /Invalid ticket dispatch socket/],
      [4, "a/b", /Invalid ticket project/],
      [4, "a\\b", /Invalid ticket project/],
      [4, "..", /Invalid ticket project/],
      [5, "20260920-120418/x", /Invalid ticket ID/],
      [5, "20260920-120418\n", /Invalid ticket ID/],
      [5, "20260920-120418-" + "a".repeat(237), /Invalid ticket ID/],
      [6, "not-a-handle", /Invalid ticket tmux session name/],
      [7, "./workspace", /absolute path/],
      [8, "", /Invalid ticket dispatch prompt/],
      [8, "prompt\0", /Invalid ticket dispatch prompt/],
    ] as const) {
      assert.throws(() => parseOperation(args.with(index, value)), error);
    }
  });

  it("accepts the Windows open ticket launch shape without weakening owner or ticket validation", () => {
    const [, , , ...sharedArgs] = dispatchArgs("/socket", "/workspace");
    const args = ["inspect", "--dispatch-open-ticket", ...sharedArgs];
    assert.deepEqual(parseOperation(args), {
      kind: "inspect-dispatch-ticket",
      socket: "/socket",
      project,
      ticketId,
      sessionName: name,
      cwd: "/workspace",
      prompt: "Investigate this ticket",
    });
    assert.throws(() => parseOperation([...args, ownerId]), /Invalid argument count/);
    assert.throws(() => parseOperation(args.with(4, "invalid")), /Invalid ticket ID/);
  });

  it("holds the lifecycle lock through tmux start and registers the normalized history cwd", async () => {
    const fixture = new SessionFixture();
    const gate = join(fixture.directory, "continue-start");
    let launch: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    try {
      initialize(fixture);
      const actualCwd = join(fixture.directory, "workspace #{pid};");
      const linkedCwd = join(fixture.directory, "workspace-link");
      mkdirSync(actualCwd);
      symlinkSync(actualCwd, linkedCwd);
      const alternateAgent = join(fixture.directory, "other-agent");
      mkdirSync(join(alternateAgent, "pi-tmux"), { recursive: true, mode: 0o700 });
      const alternateRuntime = join(fixture.directory, "alias");
      const aliasSocket = join(alternateRuntime, "pi-tmux/server.sock");
      mkdirSync(dirname(aliasSocket), { recursive: true, mode: 0o700 });
      symlinkSync(fixture.socket, aliasSocket);
      const wrapper = join(fixture.directory, "bin/tmux");
      const guardedTmux = readFileSync(wrapper, "utf8");
      writeFileSync(
        wrapper,
        guardedTmux.replace(
          `[ "$2" != ${JSON.stringify(fixture.socket)} ]`,
          `{ [ "$2" != ${JSON.stringify(fixture.socket)} ] && [ "$2" != ${JSON.stringify(aliasSocket)} ]; }`,
        ),
      );
      const alternateEnvironments = [
        { PI_CODING_AGENT_DIR: alternateAgent, XDG_RUNTIME_DIR: fixture.env.XDG_RUNTIME_DIR! },
        { PI_CODING_AGENT_DIR: alternateAgent, XDG_RUNTIME_DIR: alternateRuntime },
      ];
      for (const environment of alternateEnvironments) {
        const audit = fixture.run(["inspect", ownerId], environment);
        assert.equal(audit.status, 0, audit.stderr);
        assert.deepEqual(JSON.parse(audit.stdout), { state: "absent", file: null });
      }

      const history = conversationFile(fixture.agentDir, actualCwd, "inspection-saved");
      const hidden = fixture.run(["history", "--json"]);
      assert.equal(hidden.status, 0, hidden.stderr);
      assert.equal(hidden.stdout, "[]\n");

      fixture.tmux(["set-environment", "-g", "HOME", "/stale-home"]);
      fixture.tmux(["set-environment", "-g", "PATH", "/stale-path"]);
      const staleKeys = ["PI_TMUX_SESSION_ID", "PI_TMUX_FIRST_INPUT", "PI_SESSION_ID"];
      fixture.env.PI_TMUX_SESSION_ID = "stale-parent";
      for (const key of staleKeys.slice(1)) fixture.tmux(["set-environment", "-g", key, "stale"]);

      const reached = join(fixture.directory, "start-reached");
      fixture.beforeCliTmux(`if [ "$6" = new-session ]; then
  touch ${JSON.stringify(reached)}
  while [ ! -f ${JSON.stringify(gate)} ]; do sleep 0.02; done
fi`);
      const captured = join(fixture.directory, "start.json");
      const runner = join(fixture.directory, "fake-pi.ts");
      writeFileSync(
        join(fixture.directory, "bin/pi"),
        `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(runner)} -- "$@"
`,
        { mode: 0o700 },
      );
      writeFileSync(
        runner,
        `import { renameSync, writeFileSync } from "node:fs";
const keys = ${JSON.stringify(["HOME", "PATH", "PI_CODING_AGENT_DIR", ...staleKeys])};
const captured = ${JSON.stringify(captured)};
writeFileSync(captured + ".tmp", JSON.stringify({
  cwd: process.cwd(),
  argv: process.argv.slice(2),
  env: Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null])),
}));
renameSync(captured + ".tmp", captured);
await Bun.sleep(300000);
`,
      );
      const prompt = "--literal 'quote' $(printf sentinel);\nsecond line;";

      launch = Bun.spawn(
        [process.execPath, "run", source, ...dispatchArgs(fixture.socket, linkedCwd, prompt)],
        {
          cwd: fixture.cwd,
          env: fixture.env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await waitUntil(() => existsSync(reached));
      for (const environment of [{}, ...alternateEnvironments]) {
        const blocked = fixture.run(["inspect", ownerId], environment);
        assert.equal(blocked.status, 75);
        assert.equal(blocked.stdout, "");
        assert.match(blocked.stderr, /holds the lock/, blocked.stderr);
      }
      assert.equal(fixture.tmux(["list-sessions", "-F", "#{session_name}"]), "plain");
      assert.ok(restoreDocument(fixture).workspaces.some(({ cwd }) => cwd === actualCwd));

      writeFileSync(gate, "");
      const stdout = await new Response(launch.stdout).text();
      const stderr = await new Response(launch.stderr).text();
      assert.equal(await launch.exited, 0, stderr);
      assert.equal(stderr, "");
      const session = fixture.tmux(["display-message", "-p", "-t", name, "#{session_id}"]);
      assert.match(session, /^\$\d+$/);
      assert.equal(stdout, JSON.stringify({ state: "launched", session }) + "\n");
      await waitUntil(() => existsSync(captured));
      assert.deepEqual(JSON.parse(readFileSync(captured, "utf8")), {
        cwd: actualCwd,
        argv: ["--", prompt],
        env: {
          HOME: fixture.env.HOME,
          PATH: fixture.env.PATH,
          PI_CODING_AGENT_DIR: fixture.agentDir,
          PI_TMUX_SESSION_ID: null,
          PI_TMUX_FIRST_INPUT: null,
          PI_SESSION_ID: null,
        },
      });
      for (const [key, value] of Object.entries({
        TICKET_DISPATCH_ROLE: "pi",
        TICKET_DISPATCH_PROJECT: project,
        TICKET_DISPATCH_ID: ticketId,
      })) {
        assert.equal(fixture.tmux(["show-environment", "-t", session, key]), `${key}=${value}`);
      }
      const listed = fixture.run(["history", "--json"]);
      assert.equal(listed.status, 0, listed.stderr);
      const [{ file }] = JSON.parse(listed.stdout);
      assert.equal(file, history);
    } finally {
      writeFileSync(gate, "");
      if (launch) await launch.exited;
      await fixture.cleanup();
    }
  });

  it("does not register or launch for a present or restoring owner", async () => {
    const fixture = new SessionFixture();
    try {
      initialize(fixture);
      fixture.piSession("live-owner", { id: ownerId, file: join(fixture.cwd, "owner.jsonl") });
      const before = readFileSync(restoreFile(fixture), "utf8");
      const args = dispatchArgs(fixture.socket, fixture.directory);
      for (const source of ["live", "restoring"]) {
        if (source === "restoring") {
          fixture.tmux(["kill-session", "-t", "live-owner"]);
          fixture.tmux(["set-option", "-g", `@pi-mux-restoring-${ownerId}`, "1"]);
        }
        const result = fixture.run(args);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, '{"state":"present"}\n');
        assert.equal(readFileSync(restoreFile(fixture), "utf8"), before);
        assert.equal(
          fixture.tmux(["list-sessions", "-F", "#{session_name}"]).includes(name),
          false,
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails closed on invalid input or unverifiable server state", async () => {
    const fixture = new SessionFixture();
    try {
      initialize(fixture);
      const before = readFileSync(restoreFile(fixture), "utf8");
      const result = fixture.run(dispatchArgs(fixture.socket + "-other", fixture.directory));
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /socket does not match/);
      const missing = fixture.run(dispatchArgs(fixture.socket, join(fixture.directory, "missing")));
      assert.equal(missing.status, 1);
      assert.equal(missing.stdout, "");
      assert.match(missing.stderr, /ENOENT/);
      fixture.tmux(["set-option", "-g", `@pi-mux-restoring-${ownerId}`, "invalid"]);
      const args = dispatchArgs(fixture.socket, fixture.directory);
      const restore = fixture.run(args);
      assert.equal(restore.status, 1);
      assert.equal(restore.stdout, "");
      assert.match(restore.stderr, /Invalid in-memory restore state/);
      fixture.tmux(["set-option", "-gu", `@pi-mux-restoring-${ownerId}`]);
      fixture.beforeCliTmux(`if [ "$6" = list-panes ]; then
  ${JSON.stringify(realTmux)} -S "$2" set-option -g @pi-mux-generation changed
fi`);
      const generation = fixture.run(args);
      assert.equal(generation.status, 1);
      assert.equal(generation.stdout, "");
      assert.match(generation.stderr, /Dedicated server changed/);
      assert.equal(readFileSync(restoreFile(fixture), "utf8"), before);
      assert.equal(fixture.tmux(["list-sessions", "-F", "#{session_name}"]), "plain");
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports a tmux name collision without replacing the existing session", async () => {
    const fixture = new SessionFixture();
    try {
      initialize(fixture, name);
      prepareManagedPi(fixture);
      const panePid = () => fixture.tmux(["display-message", "-p", "-t", name, "#{pane_pid}"]);
      const before = panePid();
      const result = fixture.run(dispatchArgs(fixture.socket, fixture.cwd));
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /duplicate session/);
      assert.equal(panePid(), before);
      assert.equal(existsSync(join(fixture.directory, "launches.jsonl")), false);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("open detached with an expected file", () => {
  it("requires the exact detached shape and an absolute JSONL path", () => {
    assert.deepEqual(parseOperation(["open", "--detached", "--expect-file", "/old.jsonl", "id"]), {
      kind: "open-exact",
      id: "id",
      file: "/old.jsonl",
    });
    for (const args of [
      ["--expect-file", "/old.jsonl", "id"],
      ["--detached", "--temporary", "--expect-file", "/old.jsonl", "id"],
      ["--detached", "--expect-file", "old.jsonl", "id"],
      ["--detached", "--expect-file", "/old.json", "id"],
    ])
      assert.throws(() => parseOperation(["open", ...args]), /usage:/);
  });

  it("reopens the expected default or custom archive file despite a same-ID custom save", async () => {
    for (const archived of [false, true]) {
      const fixture = new SessionFixture();
      try {
        const id = "same-id";
        const normal = conversationFile(fixture.agentDir, fixture.cwd, id);
        const customRoot = join(fixture.directory, "custom saves");
        fixture.env.PI_CODING_AGENT_SESSION_DIR = customRoot;
        mkdirSync(customRoot);
        const custom = join(customRoot, "custom.jsonl");
        writeFileSync(custom, readFileSync(normal));
        const expected = archived ? archiveConversation(custom) : normal;
        if (archived) writeFileSync(custom, readFileSync(normal));
        prepareManagedPi(fixture);
        fixture.plainSession("plain");
        fixture.tmux(["set-option", "-g", "@pi-mux-generation", "stable"]);
        fixture.tmux(["set-option", "-g", "@pi-mux-restored", "stable"]);
        const command = ["open", "--detached", "--expect-file", expected, id];

        const opened = fixture.run(command);
        assert.equal(opened.status, 0, opened.stderr);
        const reused = fixture.run(command);
        assert.equal(reused.status, 0, reused.stderr);
        assert.equal(reused.stdout, opened.stdout);
        assert.deepEqual(fixture.clients(), []);
        const different = fixture.run(["open", "--detached", "--expect-file", custom, id]);
        assert.equal(different.status, 1, different.stderr);
        assert.match(different.stderr, /does not match the expected file and cwd/);
        assert.equal(different.stdout, "");
        const launchLog = join(fixture.directory, "launches.jsonl");
        await waitUntil(
          () => existsSync(launchLog) && readFileSync(launchLog, "utf8").endsWith("\n"),
        );
        const launches = readFileSync(launchLog, "utf8").trim().split("\n");
        assert.equal(launches.length, 1);
        const launch = JSON.parse(launches[0]!);
        assert.deepEqual(launch.args.slice(0, 2), ["--session", expected]);
        assert.equal(launch.cwd, fixture.cwd);
      } finally {
        await fixture.cleanup();
      }
    }
  });

  it("rejects a stale server, unrelated paths, moved files, mismatched headers, and starting sessions without launching", async () => {
    const fixture = new SessionFixture();
    try {
      const id = "old-id";
      const file = conversationFile(fixture.agentDir, fixture.cwd, id);
      const other = conversationFile(fixture.agentDir, fixture.cwd, "other-id");
      const outside = join(fixture.directory, "outside.jsonl");
      writeFileSync(outside, readFileSync(file));
      const link = join(dirname(file), "linked.jsonl");
      symlinkSync(outside, link);
      prepareManagedPi(fixture);
      const run = (path: string) => fixture.run(["open", "--detached", "--expect-file", path, id]);
      const noServer = run(file);
      assert.equal(noServer.status, 1, noServer.stderr);
      assert.match(noServer.stderr, /dedicated tmux server is not running/);
      assert.equal(existsSync(fixture.socket), false);

      fixture.plainSession("plain");
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", "stable"]);
      const stale = run(file);
      assert.equal(stale.status, 1, stale.stderr);
      assert.match(stale.stderr, /has not completed startup restore/);
      fixture.tmux(["set-option", "-g", "@pi-mux-restored", "stable"]);
      const archived = archiveConversation(file);
      const invalidCwd = join(dirname(archived), "invalid-cwd.jsonl");
      writeFileSync(invalidCwd, JSON.stringify({ type: "session", id, cwd: "relative" }) + "\n");
      for (const [path, error] of [
        [outside, /outside the supported session directories/],
        [file, /not a canonical regular file/],
        [link, /not a canonical regular file/],
        [other, /mismatched session header/],
        [invalidCwd, /mismatched session header/],
      ] as const) {
        const result = run(path);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, error);
        assert.equal(result.stdout, "");
      }
      const token = randomUUID();
      const pid = Number(
        fixture.tmux([
          "new-session",
          "-d",
          "-s",
          "initializing",
          "-c",
          fixture.cwd,
          "-P",
          "-F",
          "#{pane_pid}",
          "-e",
          `PI_TMUX_SESSION_ID=${id}`,
          "-e",
          `PI_TMUX_LAUNCH_TOKEN=${token}`,
          "/bin/sleep",
          "300",
        ]),
      );
      fixture.tmux([
        "set-option",
        "-p",
        "-t",
        "initializing",
        "@pi-mux-launch",
        JSON.stringify({ id, pid, token }),
      ]);
      const initializing = run(archived);
      assert.equal(initializing.status, 1, initializing.stderr);
      assert.equal(initializing.stdout, "");
      assert.match(initializing.stderr, /Cannot confirm the exact file of a starting session/);
      assert.equal(existsSync(join(fixture.directory, "launches.jsonl")), false);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("open detached", () => {
  it("accepts both flag orders and rejects duplicate, trailing, or extra arguments", () => {
    assert.deepEqual(parseOperation(["open", "id"]), {
      kind: "open",
      id: "id",
      detached: false,
      temporary: false,
    });
    for (const flags of [
      ["--temporary", "--detached"],
      ["--detached", "--temporary"],
    ])
      assert.deepEqual(parseOperation(["open", ...flags, "id"]), {
        kind: "open",
        id: "id",
        detached: true,
        temporary: true,
      });
    for (const args of [
      ["--detached"],
      ["id", "--detached"],
      ["--detached", "--detached", "id"],
      ["--temporary", "--temporary", "id"],
      ["--detached", "id", "extra"],
    ])
      assert.throws(() => parseOperation(["open", ...args]), /usage:/);
  });

  it("reopens and reuses a saved pi without changing a connected client", async () => {
    const fixture = new SessionFixture();
    try {
      const id = "saved-session";
      const savedCwd = join(fixture.directory, "original-cwd");
      mkdirSync(savedCwd);
      const file = conversationFile(fixture.agentDir, savedCwd, id);
      prepareManagedPi(fixture);
      fixture.plainSession("plain");
      await fixture.attach("plain");
      const clients = fixture.clients();
      fixture.beforeCliTmux(`if [ "$3" = attach-session ]; then exit 93; fi`);

      const opened = fixture.run(["open", "--detached", "--temporary", id]);
      assert.equal(opened.status, 0, opened.stderr);
      assert.deepEqual(fixture.clients(), clients);
      const target = fixture
        .tmux(["list-sessions", "-F", "#{session_id} #{session_name}"])
        .split("\n")
        .find((line) => line.includes(" pi-"))
        ?.split(" ")[0];
      assert.ok(target);
      const pid = fixture.tmux(["display-message", "-p", "-t", target, "#{pane_pid}"]);
      assert.equal(
        fixture.tmux(["display-message", "-p", "-t", target, "#{session_path}"]),
        savedCwd,
      );
      const metadata = fixture.tmux(["show-options", "-pqv", "-t", target, "@pi-tmux-session"]);
      assert.equal(JSON.parse(Buffer.from(metadata, "base64").toString("utf8")).file, file);
      assert.equal(
        opened.stdout,
        `Pi session ${id}\nAttach with: '${join(fixture.directory, "bin/tmux")}' '-S' '${fixture.socket}' 'attach-session' '-t' '${target}'\n`,
      );
      assert.equal(
        fixture.tmux(["show-environment", "-t", target, "PI_TMUX_TEMPORARY"]),
        `PI_TMUX_TEMPORARY=${id}`,
      );
      assert.ok(!restoreDocument(fixture).workspaces.some(({ sessions }) => sessions.includes(id)));

      const defaultOpen = fixture.run(["open", id]);
      assert.equal(defaultOpen.status, 93);
      assert.equal(defaultOpen.stdout, "");
      assert.deepEqual(
        restoreDocument(fixture).workspaces.find(({ cwd }) => cwd === savedCwd)?.sessions,
        [id],
      );
      const reopened = fixture.run(["open", "--temporary", "--detached", id]);
      assert.equal(reopened.status, 0, reopened.stderr);
      assert.equal(reopened.stdout, opened.stdout);
      assert.equal(fixture.tmux(["display-message", "-p", "-t", target, "#{pane_pid}"]), pid);
      assert.deepEqual(
        restoreDocument(fixture).workspaces.find(({ cwd }) => cwd === savedCwd)?.sessions,
        [id],
      );
      assert.deepEqual(fixture.clients(), clients);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not pass dispatch identity from the caller or tmux global environment to a reopened pi", async () => {
    const fixture = new SessionFixture();
    try {
      const id = "reopened";
      prepareManagedPi(fixture);
      conversationFile(fixture.agentDir, fixture.cwd, id);
      fixture.plainSession("plain");
      const dispatchKeys = [
        "TICKET_DISPATCH_ROLE",
        "TICKET_DISPATCH_PROJECT",
        "TICKET_DISPATCH_ID",
      ];
      for (const key of dispatchKeys) {
        fixture.env[key] = "from-caller";
        fixture.tmux(["set-environment", "-g", key, "from-server"]);
      }
      fixture.env.PI_MUX_TEST_ALLOWED = "caller-value";

      const result = fixture.run(["open", "--detached", id]);
      assert.equal(result.status, 0, result.stderr);
      const pid = fixture
        .tmux(["list-panes", "-a", "-F", "#{session_name} #{pane_pid}"])
        .split("\n")
        .find((line) => line.startsWith("pi-"))
        ?.split(" ")[1];
      assert.ok(pid);
      const environment = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      for (const key of dispatchKeys) {
        assert.ok(!environment.some((entry) => entry.startsWith(`${key}=`)), key);
        assert.equal(fixture.tmux(["show-environment", "-g", key]), `${key}=from-server`);
      }
      assert.ok(environment.includes("PI_MUX_TEST_ALLOWED=caller-value"));
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not print detached connection details when open fails", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      const result = fixture.run(["open", "--detached", "missing"]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Session not found/);
      assert.deepEqual(fixture.clients(), []);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("new initial request", () => {
  it("treats help flags as a help request instead of an initial request", () => {
    for (const args of [
      ["new", "--help"],
      ["new", "-h"],
      ["new", "--detached", "--help"],
      ["new", "--detached", "-h"],
      ["new", "--cwd", "/tmp/project", "--help"],
      ["new", "--cwd", "/tmp/project", "-h"],
    ])
      assert.deepEqual(parseOperation(args), { kind: "help" });
  });

  it("keeps plain and dash-prefixed initial requests", () => {
    assert.deepEqual(parseOperation(["new", "fix the failing test"]), {
      kind: "new",
      detached: false,
      clientPid: undefined,
      request: "fix the failing test",
      cwd: undefined,
    });
    assert.deepEqual(parseOperation(["new", "--detached", "fix the failing test"]), {
      kind: "new",
      detached: true,
      clientPid: undefined,
      request: "fix the failing test",
      cwd: undefined,
    });
    assert.deepEqual(parseOperation(["new", "--detached", "--detached"]), {
      kind: "new",
      detached: true,
      clientPid: undefined,
      request: "--detached",
      cwd: undefined,
    });
    assert.deepEqual(parseOperation(["new", "--"]), {
      kind: "new",
      detached: false,
      clientPid: undefined,
      request: "--",
      cwd: undefined,
    });
  });

  it("accepts a client pid before the initial request in any option order", () => {
    assert.deepEqual(parseOperation(["new", "--client-pid", "42"]), {
      kind: "new",
      detached: false,
      clientPid: 42,
      cwd: undefined,
    });
    assert.deepEqual(parseOperation(["new", "--client-pid", "42", "--detached", "fix it"]), {
      kind: "new",
      detached: true,
      clientPid: 42,
      request: "fix it",
      cwd: undefined,
    });
    assert.deepEqual(parseOperation(["new", "--detached", "--client-pid", "7"]), {
      kind: "new",
      detached: true,
      clientPid: 7,
      cwd: undefined,
    });
  });

  it("rejects malformed or repeated client pid options", () => {
    for (const args of [
      ["new", "--client-pid", "0"],
      ["new", "--client-pid", "-1"],
      ["new", "--client-pid", "1", "--client-pid", "2"],
      ["new", "--client-pid", "1", "extra", "extra"],
    ])
      assert.throws(() => parseOperation(args), /usage/);
    assert.deepEqual(parseOperation(["new", "--client-pid"]), {
      kind: "new",
      detached: false,
      clientPid: undefined,
      request: "--client-pid",
      cwd: undefined,
    });
  });

  it("accepts an absolute cwd option before the initial request in any option order", () => {
    assert.deepEqual(parseOperation(["new", "--cwd", "/tmp/project"]), {
      kind: "new",
      detached: false,
      clientPid: undefined,
      cwd: "/tmp/project",
    });
    assert.deepEqual(parseOperation(["new", "--cwd", "/tmp/project", "--detached", "fix it"]), {
      kind: "new",
      detached: true,
      clientPid: undefined,
      request: "fix it",
      cwd: "/tmp/project",
    });
    assert.deepEqual(parseOperation(["new", "--detached", "--cwd", "/tmp/project"]), {
      kind: "new",
      detached: true,
      clientPid: undefined,
      cwd: "/tmp/project",
    });
    assert.deepEqual(parseOperation(["new", "--client-pid", "42", "--cwd", "/tmp/project"]), {
      kind: "new",
      detached: false,
      clientPid: 42,
      cwd: "/tmp/project",
    });
    assert.deepEqual(parseOperation(["new", "--cwd", "/tmp/project", "--client-pid", "42"]), {
      kind: "new",
      detached: false,
      clientPid: 42,
      cwd: "/tmp/project",
    });
  });

  it("rejects relative or repeated cwd options and keeps a missing value as a request", () => {
    for (const args of [
      ["new", "--cwd", "relative/path"],
      ["new", "--cwd", "-h"],
      ["new", "--cwd", "/a", "--cwd", "/b"],
      ["new", "--cwd", "/a", "extra", "extra"],
    ])
      assert.throws(() => parseOperation(args), /usage/);
    assert.deepEqual(parseOperation(["new", "--cwd"]), {
      kind: "new",
      detached: false,
      clientPid: undefined,
      request: "--cwd",
      cwd: undefined,
    });
  });
});

function prepareNewEmpty(fixture: SessionFixture): void {
  writeFileSync(
    join(fixture.directory, "bin/pi"),
    `#!${process.execPath}
import { spawnSync } from "node:child_process";
const id = process.env.PI_TMUX_SESSION_ID;
const pane = process.env.TMUX_PANE;
const file = ${JSON.stringify(join(fixture.directory, "conversations"))} + "/" + id + ".jsonl";
const metadata = { id, cwd: process.cwd(), file, pid: process.pid, startup: "ready" };
function tmux(args) {
  const result = spawnSync(${JSON.stringify(realTmux)}, ["-S", ${JSON.stringify(fixture.socket)}, ...args]);
  if (result.status !== 0) process.exit(99);
}
tmux(["set-option", "-p", "-t", pane, "@pi-tmux-session", Buffer.from(JSON.stringify(metadata)).toString("base64")]);
await Bun.sleep(300000);
`,
    { mode: 0o700 },
  );
}

describe("new with a client switch", () => {
  it("secures a fresh empty pi and switches the client pid to it", async () => {
    const fixture = new SessionFixture();
    try {
      prepareNewEmpty(fixture);
      fixture.plainSession("plain");
      await fixture.attach("plain");
      const client = fixture.clients()[0]!;
      const result = fixture.run(["new", "--client-pid", String(client.pid)]);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const switched = fixture.clients()[0]!;
      assert.equal(switched.pid, client.pid);
      assert.match(switched.session, /^pi-[0-9a-f]{64}$/);
      const pane = fixture.tmux(["display-message", "-p", "-t", switched.session, "#{pane_id}"]);
      const metadata = JSON.parse(
        Buffer.from(
          fixture.tmux(["show-options", "-pqv", "-t", pane, "@pi-tmux-session"]),
          "base64",
        ).toString(),
      );
      assert.equal(metadata.cwd, fixture.cwd);
      assert.match(result.stdout, new RegExp(`^Pi session ${metadata.id}\\nAttach with: `));
      const second = fixture.run(["new", "--client-pid", String(client.pid)]);
      assert.equal(second.status, 0, second.stderr);
      const secondId = /^Pi session (\S+)\n/.exec(second.stdout)?.[1];
      assert.ok(secondId);
      assert.notEqual(secondId, metadata.id);
      const secondSession = `pi-${createHash("sha256").update(secondId).digest("hex")}`;
      assert.equal(fixture.clients()[0]!.session, secondSession);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("keeps the client display unchanged when the client pid matches no client", async () => {
    const fixture = new SessionFixture();
    try {
      prepareNewEmpty(fixture);
      fixture.plainSession("plain");
      await fixture.attach("plain");
      const before = fixture.clients()[0]!.session;
      const result = fixture.run(["new", "--client-pid", "999999999"]);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes("Cannot identify the tmux client"));
      assert.equal(fixture.clients()[0]!.session, before);
      const emptySessions = fixture
        .tmux(["list-sessions", "-F", "#{session_name}"])
        .split("\n")
        .filter((name) => /^pi-[0-9a-f]{64}$/.test(name));
      assert.equal(emptySessions.length, 1);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});

describe("new with a cwd option", () => {
  it("starts the empty pi in the requested cwd from a different working directory", async () => {
    const fixture = new SessionFixture();
    try {
      prepareNewEmpty(fixture);
      const from = join(fixture.directory, "from");
      const target = join(fixture.directory, "target");
      mkdirSync(from, { recursive: true, mode: 0o700 });
      mkdirSync(target, { recursive: true, mode: 0o700 });
      const result = spawnSync(
        process.execPath,
        ["run", source, "new", "--cwd", target, "--detached"],
        { cwd: from, env: fixture.env, encoding: "utf8", timeout: 10_000 },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const id = /^Pi session (\S+)\n/.exec(result.stdout)?.[1];
      assert.ok(id);
      const panes = fixture
        .tmux(["list-panes", "-F", "#{session_name}\t#{pane_current_path}"])
        .split("\n")
        .map((line) => line.split("\t"));
      const started = panes.filter(([, path]) => path === target);
      assert.equal(started.length, 1);
      const [sessionName] = started[0]!;
      assert.ok(sessionName);
      assert.match(sessionName, /^pi-[0-9a-f]{64}$/);
      const pane = fixture.tmux(["display-message", "-p", "-t", sessionName, "#{pane_id}"]);
      const metadata = JSON.parse(
        Buffer.from(
          fixture.tmux(["show-options", "-pqv", "-t", pane, "@pi-tmux-session"]),
          "base64",
        ).toString(),
      );
      assert.equal(metadata.cwd, target);
      assert.equal(metadata.id, id);
      assert.equal(panes.filter(([, path]) => path === fixture.cwd).length, 0);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});

describe("send parsing", () => {
  it("parses the target and the joined text without a wait", () => {
    assert.deepEqual(parseOperation(["send", "abc123", "hello"]), {
      kind: "send",
      id: "abc123",
      waitSeconds: undefined,
      text: "hello",
    });
    assert.deepEqual(parseOperation(["send", "abc123", "two", "words"]), {
      kind: "send",
      id: "abc123",
      waitSeconds: undefined,
      text: "two words",
    });
  });

  it("parses a single leading --wait with positive integer seconds", () => {
    assert.deepEqual(parseOperation(["send", "--wait", "5", "abc123", "hello"]), {
      kind: "send",
      id: "abc123",
      waitSeconds: 5,
      text: "hello",
    });
    assert.deepEqual(parseOperation(["send", "abc123", "--wait", "not-a-flag"]), {
      kind: "send",
      id: "abc123",
      waitSeconds: undefined,
      text: "--wait not-a-flag",
    });
    for (const args of [["0"], ["-1"], ["1.5"], ["x"]])
      assert.throws(
        () => parseOperation(["send", "--wait", ...args, "abc123", "hello"]),
        /usage/,
        `args: ${JSON.stringify(args)}`,
      );
  });

  it("shows help for send -h and keeps option-like text otherwise", () => {
    assert.deepEqual(parseOperation(["send", "-h"]), { kind: "help" });
    assert.deepEqual(parseOperation(["send", "--help"]), { kind: "help" });
    assert.deepEqual(parseOperation(["send", "abc123", "-h"]), {
      kind: "send",
      id: "abc123",
      waitSeconds: undefined,
      text: "-h",
    });
  });

  it("rejects blank text, NUL, and oversized text", () => {
    for (const args of [[""], ["  "], ["a\0b"]])
      assert.throws(
        () => parseOperation(["send", "abc123", ...args]),
        /usage/,
        `args: ${JSON.stringify(args)}`,
      );
    assert.equal([..."x".repeat(2800)].length, 2800);
    assert.deepEqual(parseOperation(["send", "abc123", "x".repeat(2800)]), {
      kind: "send",
      id: "abc123",
      waitSeconds: undefined,
      text: "x".repeat(2800),
    });
    assert.throws(() => parseOperation(["send", "abc123", "x".repeat(2801)]), /limit is 2800/);
    assert.throws(() => parseOperation(["send", "abc123", "あ".repeat(2801)]), /limit is 2800/);
  });
});

describe("state argument parsing", () => {
  const validSource = {
    socket: "/run/user/1000/pi-tmux/server.sock",
    serverPid: 4242,
    pane: "%3",
    pid: 9999,
    token: "0f1e2d3c-4b5a-6978-8976-a5b4c3d2e1f0",
  };
  const parsedSource = {
    socket: validSource.socket,
    serverPid: 4242,
    pane: "%3",
    pid: 9999,
    token: validSource.token,
  };

  it("parses source and title in both option orders", () => {
    assert.deepEqual(
      parseOperation([
        "state",
        "abc123",
        "running",
        "--source",
        JSON.stringify(validSource),
        "--title",
        '"Fix the build"',
      ]),
      {
        kind: "state",
        id: "abc123",
        source: parsedSource,
        notification: { clear: false, state: "running", title: "Fix the build" },
      },
    );
    assert.deepEqual(
      parseOperation([
        "state",
        "abc123",
        "waiting-user",
        "--title",
        "null",
        "--source",
        JSON.stringify(validSource),
      ]),
      {
        kind: "state",
        id: "abc123",
        source: parsedSource,
        notification: { clear: false, state: "waiting-user", title: null },
      },
    );
    assert.deepEqual(
      parseOperation(["state", "abc123", "--clear", "--source", JSON.stringify(validSource)]),
      {
        kind: "state",
        id: "abc123",
        source: parsedSource,
        notification: { clear: true },
      },
    );
  });

  it("documents state notifications with only source and title", () => {
    const result = spawnSync(process.execPath, ["run", source, "--help"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trimEnd().split("\n");
    assert.ok(lines.includes("  pi-mux state <session-id> <state> --source <JSON> --title <JSON>"));
    assert.ok(lines.includes("  pi-mux state <session-id> --clear --source <JSON>"));
    assert.doesNotMatch(result.stdout, /--last-settlement/);
  });

  it("accepts every documented state value and keeps literal titles", () => {
    const title = 'line1\n#{session_name} "quoted"';
    for (const state of ["running", "waiting-approval", "waiting-user"]) {
      const operation = parseOperation([
        "state",
        "abc123",
        state,
        "--title",
        JSON.stringify(title),
        "--source",
        JSON.stringify(validSource),
      ]);
      assert.ok(operation.kind === "state");
      assert.deepEqual(operation.notification, { clear: false, state, title });
    }
  });

  it("rejects missing or malformed conversation IDs", () => {
    assert.throws(
      () => parseOperation(["state"]),
      /state <missing>: Invalid complete conversation ID/,
    );
    assert.throws(
      () => parseOperation(["state", "Invalid ID!"]),
      /state Invalid ID!: Invalid complete conversation ID/,
    );
  });

  it("rejects invalid state values", () => {
    assert.throws(() => parseOperation(["state", "abc123"]), /state abc123: Invalid state/);
    for (const state of ["paused", "Running", "--clearing"])
      assert.throws(
        () =>
          parseOperation([
            "state",
            "abc123",
            state,
            "--source",
            JSON.stringify(validSource),
            "--title",
            "null",
          ]),
        /state abc123: Invalid state/,
        `state: ${state}`,
      );
  });

  it("rejects missing, duplicate, and unexpected arguments", () => {
    const base = ["state", "abc123", "running"];
    for (const args of [
      [...base, "--title", "null"],
      [...base, "--source", JSON.stringify(validSource)],
      ["state", "abc123", "--clear", "--source", JSON.stringify(validSource), "--title", "null"],
    ])
      assert.throws(
        () => parseOperation(args),
        /State requires source and title; clear requires only source/,
        JSON.stringify(args),
      );
    const origin = JSON.stringify(validSource);
    for (const args of [
      [...base, "--source", origin, "--source", origin, "--title", "null"],
      [...base, "--source", origin, "--title", "null", "--title", "null"],
      [...base, "extra", "--source", origin, "--title", "null"],
      [...base, "--source", origin, "--title"],
      [...base, "--wait", "5", "--source", origin, "--title", "null"],
    ])
      assert.throws(
        () => parseOperation(args),
        /Missing, duplicate, or unexpected state argument/,
        JSON.stringify(args),
      );
  });

  it("rejects the removed --last-settlement option", () => {
    assert.throws(
      () =>
        parseOperation([
          "state",
          "abc123",
          "waiting-user",
          "--source",
          JSON.stringify(validSource),
          "--title",
          "null",
          "--last-settlement",
          JSON.stringify({ atMs: 1, aborted: false }),
        ]),
      /Missing, duplicate, or unexpected state argument/,
    );
  });

  it("rejects invalid JSON and malformed source objects", () => {
    for (const value of ["{broken", "null", "[]", '"source"'])
      assert.throws(
        () => parseOperation(["state", "abc123", "running", "--source", value, "--title", "null"]),
        /state abc123:/,
        `source: ${value}`,
      );
    for (const changed of [
      { socket: "relative/server.sock" },
      { serverPid: 0 },
      { serverPid: -1 },
      { serverPid: 1.5 },
      { serverPid: "4242" },
      { pane: "3" },
      { pane: "%abc" },
      { pid: 0 },
      { pid: "9999" },
      { token: "not-a-uuid" },
    ]) {
      assert.throws(
        () =>
          parseOperation([
            "state",
            "abc123",
            "running",
            "--source",
            JSON.stringify({ ...validSource, ...changed }),
            "--title",
            "null",
          ]),
        /state abc123: Invalid source/,
        JSON.stringify(changed),
      );
    }
  });

  it("rejects titles that are neither strings nor null", () => {
    assert.throws(
      () =>
        parseOperation([
          "state",
          "abc123",
          "running",
          "--source",
          JSON.stringify(validSource),
          "--title",
          "{broken",
        ]),
      /state abc123:/,
    );
    for (const title of ["42", "true", "[]", '{"nested":true}'])
      assert.throws(
        () =>
          parseOperation([
            "state",
            "abc123",
            "running",
            "--source",
            JSON.stringify(validSource),
            "--title",
            title,
          ]),
        /state abc123: Invalid title/,
        `title: ${title}`,
      );
  });
});

describe("stop", () => {
  it("accepts no arguments", () => {
    assert.deepEqual(parseOperation(["stop"]), { kind: "stop" });
    assert.throws(() => parseOperation(["stop", "--force"]), /usage/);
  });

  it.skipIf(process.platform !== "linux")(
    "waits for input, saves the conversation, and leaves the server stopped",
    async () => {
      const fixture = new SessionFixture();
      let child: ReturnType<typeof startLifecycleCommand> | undefined;
      try {
        prepareManagedPi(fixture);
        const id = addManagedSession(fixture, "target", "running");
        const pid = fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_pid}"]);
        child = startLifecycleCommand(fixture, ["stop"]);
        await Bun.sleep(250);
        assert.equal(child.exitCode, null);
        assert.equal(existsSync(`/proc/${pid}`), true);
        restartState(fixture, "target", id, "waiting-user");
        await finishRestart(child);
        assert.equal(existsSync(`/proc/${pid}`), false);
        const server = spawnSync(realTmux!, [
          "-N",
          "-S",
          fixture.socket,
          "display-message",
          "-p",
          "#{pid}",
        ]);
        assert.equal(server.status, 1, server.stderr.toString());
        assert.deepEqual(restoreDocument(fixture).workspaces, [
          { cwd: fixture.cwd, sessions: [id] },
        ]);

        const restored = fixture.run(["restore"]);
        assert.equal(restored.status, 0, restored.stderr);
        const launch = JSON.parse(readFileSync(join(fixture.directory, "launches.jsonl"), "utf8"));
        assert.equal(launch.id, id);
      } finally {
        child?.kill();
        if (child) await child.exited;
        await fixture.cleanup();
      }
    },
    20_000,
  );

  it.skipIf(process.platform !== "linux")(
    "succeeds without starting an absent server",
    async () => {
      const fixture = new SessionFixture();
      try {
        prepareManagedPi(fixture);
        const snapshot = readFileSync(restoreFile(fixture), "utf8");
        const result = fixture.run(["stop"]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(existsSync(fixture.socket), false);
        assert.equal(readFileSync(restoreFile(fixture), "utf8"), snapshot);
      } finally {
        await fixture.cleanup();
      }
    },
    20_000,
  );
});

describe("restart", () => {
  it("accepts only the optional force argument", () => {
    assert.deepEqual(parseOperation(["restart"]), { kind: "restart", force: false });
    assert.deepEqual(parseOperation(["restart", "--force"]), { kind: "restart", force: true });
    for (const args of [["--force", "--force"], ["extra"], ["--force", "extra"]])
      assert.throws(() => parseOperation(["restart", ...args]), /usage/);
  });

  for (const state of ["waiting-user", "waiting-approval", "running"]) {
    it(`restarts ${state} with ${state === "waiting-user" ? "normal" : "force"} and restores the same conversation`, async () => {
      const fixture = new SessionFixture();
      try {
        prepareManagedPi(fixture);
        const id = addManagedSession(fixture, "target", state);
        const previousPid = fixture.tmux(["display-message", "-p", "#{pid}"]);
        const previousPi = fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_pid}"]);
        const result = fixture.run(["restart", ...(state === "waiting-user" ? [] : ["--force"])]);
        assert.equal(result.status, 0, result.stderr);
        assert.notEqual(fixture.tmux(["display-message", "-p", "#{pid}"]), previousPid);
        assert.equal(existsSync(`/proc/${previousPi}`), false);
        const launched = JSON.parse(
          readFileSync(join(fixture.directory, "launches.jsonl"), "utf8").trim(),
        );
        assert.equal(launched.id, id);
        assert.equal(launched.cwd, fixture.cwd);
        assert.ok(launched.args.includes("--session"));
        assert.notEqual(restoreDocument(fixture).generation, "before-restart");
        assert.deepEqual(restoreDocument(fixture).workspaces, [
          { cwd: fixture.cwd, sessions: [id] },
        ]);
        const stale = fixture.run(["snapshot", "before-restart"]);
        assert.equal(stale.status, 0, stale.stderr);
        assert.deepEqual(restoreDocument(fixture).workspaces, [
          { cwd: fixture.cwd, sessions: [id] },
        ]);
      } finally {
        await fixture.cleanup();
      }
    }, 20000);
  }

  for (const state of ["running", "waiting-approval", "unknown", "unpublished", "startup"]) {
    it(`waits for every pi when one is ${state} without blocking state notifications`, async () => {
      const fixture = new SessionFixture();
      let child: ReturnType<typeof startRestart> | undefined;
      try {
        prepareManagedPi(fixture);
        addManagedSession(fixture, "ready", "waiting-user");
        const id = addManagedSession(fixture, "blocked", state);
        const pid = Number(fixture.tmux(["display-message", "-p", "-t", "blocked", "#{pane_pid}"]));
        const pane = fixture.tmux(["display-message", "-p", "-t", "blocked", "#{pane_id}"]);
        if (state === "unpublished")
          fixture.tmux(["set-option", "-pu", "-t", pane, "@pi_session_state"]);
        if (state === "startup") {
          const encoded = fixture.tmux(["show-options", "-pqv", "-t", pane, "@pi-tmux-session"]);
          const metadata = JSON.parse(Buffer.from(encoded, "base64").toString());
          fixture.tmux([
            "set-option",
            "-p",
            "-t",
            pane,
            "@pi-tmux-session",
            Buffer.from(JSON.stringify({ ...metadata, startup: "accepted" })).toString("base64"),
          ]);
        }
        child = startRestart(fixture);
        await Bun.sleep(250);
        assert.equal(child.exitCode, null);
        assert.equal(existsSync(`/proc/${pid}`), true);
        if (state === "startup") {
          const encoded = fixture.tmux(["show-options", "-pqv", "-t", pane, "@pi-tmux-session"]);
          const metadata = JSON.parse(Buffer.from(encoded, "base64").toString());
          fixture.tmux([
            "set-option",
            "-p",
            "-t",
            pane,
            "@pi-tmux-session",
            Buffer.from(JSON.stringify({ ...metadata, startup: "ready" })).toString("base64"),
          ]);
        }
        const serverPid = Number(fixture.tmux(["display-message", "-p", "#{pid}"]));
        const origin = {
          socket: fixture.socket,
          serverPid,
          pane,
          pid,
          token: fixture.launchTokenOf("blocked"),
        };
        for (const phase of state === "waiting-approval"
          ? ["running", "waiting-user"]
          : ["waiting-user"]) {
          let notified = fixture.run([
            "state",
            id,
            phase,
            "--source",
            JSON.stringify(origin),
            "--title",
            "null",
          ]);
          for (let attempt = 0; notified.status === 75 && attempt < 30; attempt++) {
            await Bun.sleep(20);
            notified = fixture.run([
              "state",
              id,
              phase,
              "--source",
              JSON.stringify(origin),
              "--title",
              "null",
            ]);
          }
          assert.equal(notified.status, 0, notified.stderr);
          if (phase === "running") {
            await Bun.sleep(150);
            assert.equal(child.exitCode, null);
            assert.equal(existsSync(`/proc/${pid}`), true);
          }
        }
        await finishRestart(child);
      } finally {
        child?.kill();
        if (child) await child.exited;
        await fixture.cleanup();
      }
    }, 20000);
  }

  it("does not stop a running pi when force cannot read the snapshot", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      addManagedSession(fixture, "target", "running");
      const pid = fixture.tmux(["display-message", "-p", "#{pid}"]);
      writeFileSync(restoreFile(fixture), "{broken");
      const result = fixture.run(["restart", "--force"]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /snapshot/);
      assert.equal(fixture.tmux(["display-message", "-p", "#{pid}"]), pid);
      assert.equal(readFileSync(restoreFile(fixture), "utf8"), "{broken");
    } finally {
      await fixture.cleanup();
    }
  });

  it("retains retry candidates after post-stop restoration fails", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      const id = addManagedSession(fixture, "target", "waiting-user");
      writeFileSync(join(fixture.directory, "bin/pi"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
      const result = fixture.run(["restart"]);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, new RegExp(id));
      assert.deepEqual(restoreDocument(fixture).workspaces, [{ cwd: fixture.cwd, sessions: [id] }]);
    } finally {
      await fixture.cleanup();
    }
  }, 20000);
});

describe("restart safety", () => {
  for (const [notificationState, force] of [
    ["running", false],
    ["running", true],
    ["waiting-approval", false],
    ["waiting-approval", true],
  ] as const) {
    it(`accepts a real ${notificationState} notification immediately before stop (${force ? "force" : "normal"})`, async () => {
      const fixture = new SessionFixture();
      let child: ReturnType<typeof startRestart> | undefined;
      try {
        prepareManagedPi(fixture);
        const id = addManagedSession(fixture, "target", "waiting-user");
        const pane = fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_id}"]);
        const pid = Number(fixture.tmux(["display-message", "-p", "-t", pane, "#{pane_pid}"]));
        const serverPid = Number(fixture.tmux(["display-message", "-p", "#{pid}"]));
        const origin = {
          socket: fixture.socket,
          serverPid,
          pane,
          pid,
          token: fixture.launchTokenOf("target"),
        };
        const notification = [
          process.execPath,
          "run",
          source,
          "state",
          id,
          notificationState,
          "--source",
          JSON.stringify(origin),
          "--title",
          "null",
        ]
          .map((arg) => JSON.stringify(arg))
          .join(" ");
        const wrapper = join(fixture.directory, "bin/tmux");
        const before = readFileSync(wrapper, "utf8");
        const injected = join(fixture.directory, "injected-status");
        const pendingMarker = join(fixture.directory, "injected-pending");
        writeFileSync(
          wrapper,
          before.replace(
            "exec ",
            `if [ "$5" = source-file ] && [ ! -e ${JSON.stringify(injected)} ] && [ ! -e ${JSON.stringify(pendingMarker)} ]; then\n  touch ${JSON.stringify(pendingMarker)}\n  ${notification} > ${JSON.stringify(injected + ".stdout")} 2> ${JSON.stringify(injected + ".stderr")}\n  printf '%s' "$?" > ${JSON.stringify(injected)}\n  rm -f ${JSON.stringify(pendingMarker)}\nfi\nexec `,
          ),
        );
        child = startRestart(fixture, force ? ["--force"] : []);
        await waitUntil(() => existsSync(injected));
        assert.equal(
          readFileSync(injected, "utf8"),
          notificationState === "waiting-approval" ? "0" : "75",
          readFileSync(injected + ".stderr", "utf8"),
        );
        if (!force) {
          await Bun.sleep(150);
          assert.equal(child.exitCode, null);
          assert.equal(existsSync(`/proc/${pid}`), true);
          for (const state of notificationState === "waiting-approval"
            ? ["waiting-approval", "running", "waiting-user"]
            : ["running", "waiting-user"]) {
            let notification = fixture.run([
              "state",
              id,
              state,
              "--source",
              JSON.stringify(origin),
              "--title",
              "null",
            ]);
            for (let attempt = 0; notification.status === 75 && attempt < 30; attempt++) {
              await Bun.sleep(20);
              notification = fixture.run([
                "state",
                id,
                state,
                "--source",
                JSON.stringify(origin),
                "--title",
                "null",
              ]);
            }
            assert.equal(notification.status, 0, notification.stderr);
            if (state !== "waiting-user") {
              await Bun.sleep(150);
              assert.equal(child.exitCode, null);
              assert.equal(existsSync(`/proc/${pid}`), true);
            }
          }
        }
        await finishRestart(child);
        assert.equal(existsSync(`/proc/${pid}`), false);
        assert.deepEqual(restoreDocument(fixture).workspaces, [
          { cwd: fixture.cwd, sessions: [id] },
        ]);
      } finally {
        child?.kill();
        if (child) await child.exited;
        await fixture.cleanup();
      }
    }, 20000);
  }

  it("stops temporary and unsaved pi without adding them to the restored set", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      const id = addManagedSession(fixture, "target", "waiting-user");
      const temporaryId = randomUUID();
      const temporaryFile = conversationFile(fixture.agentDir, fixture.cwd, temporaryId);
      fixture.piSession("temporary", { id: temporaryId, file: temporaryFile, temporary: true });
      const emptyId = randomUUID();
      fixture.piSession("empty", { id: emptyId, file: join(fixture.directory, "unsaved.jsonl") });
      const encoded = fixture.tmux(["show-options", "-pqv", "-t", "empty", "@pi-tmux-session"]);
      const metadata = JSON.parse(Buffer.from(encoded, "base64").toString());
      fixture.tmux([
        "set-option",
        "-p",
        "-t",
        "empty",
        "@pi-tmux-session",
        Buffer.from(JSON.stringify({ ...metadata, startup: "accepted" })).toString("base64"),
      ]);
      const oldPids = fixture.tmux(["list-panes", "-a", "-F", "#{pane_pid}"]).split("\n");
      const result = fixture.run(["restart", "--force"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        oldPids.some((pid) => existsSync(`/proc/${pid}`)),
        false,
      );
      const listed = JSON.parse(fixture.run(["list", "--active", "--json"]).stdout);
      assert.deepEqual(
        listed[0].sessions.map((entry: { id: string }) => entry.id),
        [id],
      );
      assert.deepEqual(listed[0].empty, []);
      assert.deepEqual(restoreDocument(fixture).workspaces, [{ cwd: fixture.cwd, sessions: [id] }]);
      assert.equal(existsSync(temporaryFile), true);
    } finally {
      await fixture.cleanup();
    }
  }, 20000);

  it("keeps the old server and record when saving fails", async () => {
    const fixture = new SessionFixture();
    const stateDirectory = dirname(restoreFile(fixture));
    try {
      prepareManagedPi(fixture);
      addManagedSession(fixture, "target", "running");
      const pid = fixture.tmux(["display-message", "-p", "#{pid}"]);
      const before = readFileSync(restoreFile(fixture), "utf8");
      chmodSync(stateDirectory, 0o500);
      const result = fixture.run(["restart", "--force"]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /EACCES|permission denied/i);
      assert.equal(fixture.tmux(["display-message", "-p", "#{pid}"]), pid);
      assert.equal(readFileSync(restoreFile(fixture), "utf8"), before);
    } finally {
      chmodSync(stateDirectory, 0o700);
      await fixture.cleanup();
    }
  });

  it("rejects a server generation change while waiting", async () => {
    const fixture = new SessionFixture();
    let child: ReturnType<typeof startRestart> | undefined;
    try {
      prepareManagedPi(fixture);
      addManagedSession(fixture, "target", "running");
      child = startRestart(fixture);
      await Bun.sleep(250);
      assert.equal(child.exitCode, null);
      const pid = fixture.tmux(["display-message", "-p", "#{pid}"]);
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", "replacement"]);
      assert.equal(await child.exited, 1);
      assert.match(await new Response(child.stderr).text(), /server changed/);
      assert.equal(fixture.tmux(["display-message", "-p", "#{pid}"]), pid);
    } finally {
      child?.kill();
      if (child) await child.exited;
      await fixture.cleanup();
    }
  });

  for (const failure of ["generation-race", "stop", "start"]) {
    it(`preserves candidates on ${failure} and prevents shutdown hooks from erasing them`, async () => {
      const fixture = new SessionFixture();
      try {
        prepareManagedPi(fixture);
        const id = addManagedSession(fixture, "target", "waiting-user");
        const wrapper = join(fixture.directory, "bin/tmux");
        const before = readFileSync(wrapper, "utf8");
        const injected =
          failure === "generation-race"
            ? `if [ "$5" = source-file ]; then ${JSON.stringify(realTmux)} -S ${JSON.stringify(fixture.socket)} set-option -g @pi-mux-generation replacement; fi\n`
            : `if [ "$5" = ${failure === "stop" ? "source-file" : "start-server"} ]; then echo injected-${failure}-failure >&2; exit 1; fi\n`;
        writeFileSync(wrapper, before.replace("exec ", injected + "exec "));
        const result = fixture.run(["restart"]);
        assert.equal(result.status, 1, result.stderr);
        assert.deepEqual(restoreDocument(fixture).workspaces, [
          { cwd: fixture.cwd, sessions: [id] },
        ]);
        writeFileSync(wrapper, before);
        if (failure === "generation-race") {
          assert.match(result.stderr, /server changed/);
          assert.equal(fixture.tmux(["show-options", "-gqv", "@pi-mux-generation"]), "replacement");
        }
        if (failure === "stop") {
          fixture.tmux(["kill-session", "-t", "target"]);
          const hook = fixture.run(["snapshot", "before-restart"]);
          assert.equal(hook.status, 0, hook.stderr);
          assert.deepEqual(restoreDocument(fixture).workspaces, [
            { cwd: fixture.cwd, sessions: [id] },
          ]);
        }
        if (failure === "start") {
          const restored = fixture.run(["restore"]);
          assert.equal(restored.status, 0, restored.stderr);
          assert.deepEqual(restoreDocument(fixture).workspaces, [
            { cwd: fixture.cwd, sessions: [id] },
          ]);
        }
      } finally {
        await fixture.cleanup();
      }
    }, 20000);
  }

  it("preserves an unrelated tmux server", async () => {
    const fixture = new SessionFixture();
    const socket = join(fixture.directory, "outside.sock");
    try {
      prepareManagedPi(fixture);
      addManagedSession(fixture, "target", "waiting-user");
      const outside = spawnSync(
        realTmux!,
        [
          "-S",
          socket,
          "-f",
          "/dev/null",
          "new-session",
          "-d",
          "-s",
          "outside",
          "/bin/sleep",
          "300",
        ],
        { env: fixture.env, encoding: "utf8" },
      );
      assert.equal(outside.status, 0, outside.stderr);
      const result = fixture.run(["restart"]);
      assert.equal(result.status, 0, result.stderr);
      const alive = spawnSync(realTmux!, ["-S", socket, "has-session", "-t", "outside"], {
        env: fixture.env,
        encoding: "utf8",
      });
      assert.equal(alive.status, 0, alive.stderr);
    } finally {
      spawnSync(realTmux!, ["-S", socket, "kill-server"], { env: fixture.env });
      await fixture.cleanup();
    }
  }, 20000);

  it("rejects restart from inside the dedicated server before stopping it", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      addManagedSession(fixture, "target", "waiting-user");
      const before = readFileSync(restoreFile(fixture), "utf8");
      fixture.env.TMUX = `${fixture.socket},123,0`;
      const result = fixture.run(["restart", "--force"]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /outside/);
      assert.equal(readFileSync(restoreFile(fixture), "utf8"), before);
      assert.ok(fixture.tmux(["display-message", "-p", "#{pid}"]));
    } finally {
      await fixture.cleanup();
    }
  });

  it("serializes concurrent restarts and restores each conversation only once", async () => {
    const fixture = new SessionFixture();
    const children: ReturnType<typeof startRestart>[] = [];
    try {
      prepareManagedPi(fixture);
      const id = addManagedSession(fixture, "target", "running");
      children.push(startRestart(fixture), startRestart(fixture));
      await Bun.sleep(300);
      assert.equal(
        children.every((child) => child.exitCode === null),
        true,
      );
      restartState(fixture, "target", id, "waiting-user");
      const statuses = await Promise.all(children.map((child) => child.exited));
      assert.deepEqual(statuses.sort(), [0, 1]);
      assert.equal(
        readFileSync(join(fixture.directory, "launches.jsonl"), "utf8").trim().split("\n").length,
        1,
      );
    } finally {
      for (const child of children) {
        child.kill();
        await child.exited;
      }
      await fixture.cleanup();
    }
  }, 20000);

  it("restores the saved set when no server exists", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      const id = randomUUID();
      conversationFile(fixture.agentDir, fixture.cwd, id);
      writeFileSync(
        restoreFile(fixture),
        JSON.stringify({
          version: 1,
          generation: "previous",
          workspaces: [{ cwd: fixture.cwd, sessions: [id] }],
        }),
      );
      const result = fixture.run(["restart"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(restoreDocument(fixture).workspaces, [{ cwd: fixture.cwd, sessions: [id] }]);
    } finally {
      await fixture.cleanup();
    }
  }, 20000);
});

describe("reload", () => {
  it("accepts an optional conversation ID", () => {
    assert.deepEqual(parseOperation(["reload"]), { kind: "reload", id: undefined });
    const id = randomUUID();
    assert.deepEqual(parseOperation(["reload", id]), { kind: "reload", id });
    for (const args of [["--force"], [id, "extra"], ["invalid id"], [id, "--force"]])
      assert.throws(() => parseOperation(["reload", ...args]), /usage/);
  });

  it("reloads another ready conversation before the first replacement publishes metadata", async () => {
    const fixture = new SessionFixture();
    let child: ReturnType<typeof startReload> | undefined;
    try {
      const firstId = addManagedSession(fixture, "first", "waiting-user");
      const secondId = addManagedSession(fixture, "second", "running");
      const metadata = join(fixture.directory, "allow-first-publication");
      prepareManagedPi(fixture, { metadata, state: metadata, id: firstId });
      const launches = join(fixture.directory, "launches.jsonl");
      function firstPid() {
        return fixture.tmux(["display-message", "-p", "-t", "first", "#{pane_pid}"]);
      }
      const originalPid = firstPid();

      child = startReload(fixture);
      await waitUntil(() => firstPid() !== originalPid);
      restartState(fixture, "second", secondId, "waiting-user");
      await waitUntil(
        () => existsSync(launches) && readFileSync(launches, "utf8").includes(secondId),
      );
      assert.equal(fixture.tmux(["show-options", "-pqv", "-t", "first", "@pi-tmux-session"]), "");
      assert.equal(child.exitCode, null);

      writeFileSync(metadata, "");
      const result = await finishReload(child);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        result.stdout.trim().split("\n").sort(),
        [`reloaded ${firstId}`, `reloaded ${secondId}`].sort(),
      );
    } finally {
      child?.kill();
      await child?.exited;
      await fixture.cleanup();
    }
  }, 20000);

  it("confirms a replacement already in progress when scanning another target fails", async () => {
    const fixture = new SessionFixture();
    let child: ReturnType<typeof startReload> | undefined;
    try {
      const firstId = addManagedSession(fixture, "first", "waiting-user");
      addManagedSession(fixture, "second", "running");
      const allowPublication = join(fixture.directory, "allow-first-publication");
      const failScan = join(fixture.directory, "fail-next-scan");
      const scanFailed = join(fixture.directory, "scan-failed");
      prepareManagedPi(fixture, {
        metadata: allowPublication,
        state: allowPublication,
        id: firstId,
      });
      const wrapper = join(fixture.directory, "bin/tmux");
      writeFileSync(
        wrapper,
        readFileSync(wrapper, "utf8").replace(
          "exec ",
          `if [ "$5" = -C ] && [ -f ${JSON.stringify(failScan)} ]; then
  : > ${JSON.stringify(scanFailed)}
  exit 31
fi
exec `,
        ),
      );
      function firstPid() {
        return fixture.tmux(["display-message", "-p", "-t", "first", "#{pane_pid}"]);
      }
      const originalPid = firstPid();

      child = startReload(fixture);
      await waitUntil(() => firstPid() !== originalPid);
      writeFileSync(failScan, "");
      await waitUntil(() => existsSync(scanFailed));
      writeFileSync(allowPublication, "");

      const result = await finishReload(child);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /invalid tmux control response/);
      assert.equal(result.stdout.trim(), `reloaded ${firstId}`);
    } finally {
      child?.kill();
      await child?.exited;
      await fixture.cleanup();
    }
  }, 20000);

  it("replaces a waiting pi in place and keeps the server, session, pane, and record", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      const id = addManagedSession(fixture, "target", "waiting-user");
      const serverPid = fixture.tmux(["display-message", "-p", "#{pid}"]);
      const session = fixture.tmux(["display-message", "-p", "-t", "target", "#{session_id}"]);
      const pane = fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_id}"]);
      const oldPid = fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_pid}"]);
      const result = await finishReload(startReload(fixture));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), `reloaded ${id}`);
      assert.equal(fixture.tmux(["display-message", "-p", "#{pid}"]), serverPid);
      assert.equal(
        fixture.tmux(["display-message", "-p", "-t", "target", "#{session_id}"]),
        session,
      );
      assert.equal(fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_id}"]), pane);
      assert.equal(existsSync(`/proc/${oldPid}`), false);
      const newPid = fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_pid}"]);
      assert.notEqual(newPid, oldPid);
      assert.equal(fixture.tmux(["show-options", "-gqv", "@pi-mux-generation"]), "before-restart");
      const launch = JSON.parse(
        fixture.tmux(["show-options", "-pqv", "-t", pane, "@pi-mux-launch"]),
      );
      assert.equal(launch.id, id);
      assert.equal(launch.pid, Number(newPid));
      const metadata = JSON.parse(
        Buffer.from(
          fixture.tmux(["show-options", "-pqv", "-t", pane, "@pi-tmux-session"]),
          "base64",
        ).toString("utf8"),
      );
      assert.equal(metadata.id, launch.id);
      assert.equal(metadata.pid, launch.pid);
      assert.equal(metadata.token, launch.token);
      assert.notEqual(launch.token, fixture.launchTokenOf("target"));
      const hook = fixture.tmux(["show-options", "-gqv", "@pi-mux-snapshot"]);
      assert.ok(hook.includes(source), hook);
      assert.ok(hook.includes("snapshot"), hook);
      const launched = JSON.parse(
        readFileSync(join(fixture.directory, "launches.jsonl"), "utf8").trim(),
      );
      assert.equal(launched.id, id);
      assert.equal(launched.cwd, fixture.cwd);
      assert.ok(launched.args.includes("--session"));
      assert.deepEqual(restoreDocument(fixture), {
        version: 1,
        generation: "before-restart",
        workspaces: [{ cwd: fixture.cwd, sessions: [id] }],
      });
      const stale = fixture.run(["snapshot", "before-restart"]);
      assert.equal(stale.status, 0, stale.stderr);
      assert.deepEqual(restoreDocument(fixture).workspaces, [
        {
          cwd: fixture.cwd,
          sessions: [id],
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  }, 20000);

  it("waits for the replacement pi to publish its own state during concurrent reloads", async () => {
    const fixture = new SessionFixture();
    let first: ReturnType<typeof startReload> | undefined;
    let second: ReturnType<typeof startReload> | undefined;
    try {
      const metadata = join(fixture.directory, "allow-metadata");
      const state = join(fixture.directory, "allow-state");
      prepareManagedPi(fixture, { metadata, state });
      const id = addManagedSession(fixture, "target", "waiting-user");
      const pane = fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_id}"]);
      function panePid() {
        return fixture.tmux(["display-message", "-p", "-t", pane, "#{pane_pid}"]);
      }
      const oldPid = panePid();
      const oldState = fixture.run([
        "state",
        id,
        "waiting-user",
        "--source",
        JSON.stringify({
          socket: fixture.socket,
          serverPid: Number(fixture.tmux(["display-message", "-p", "#{pid}"])),
          pane,
          pid: Number(oldPid),
          token: fixture.launchTokenOf("target"),
        }),
        "--title",
        "null",
      ]);
      assert.equal(oldState.status, 0, oldState.stderr);
      const pending = JSON.stringify({ version: 1, sessionId: id, attemptAt: Date.now() });
      fixture.tmux(["set-option", "-p", "-t", pane, "@pi_session_state_pending", pending]);

      const scans = join(fixture.directory, "second-reload-scans");
      writeFileSync(scans, "");
      const wrapper = join(fixture.directory, "bin/tmux");
      writeFileSync(
        wrapper,
        readFileSync(wrapper, "utf8").replace(
          "exec ",
          `case "$PI_MUX_FIXTURE_SECOND_RELOAD:$5:$*" in
  1:-C:*@pi_session_state*) printf . >> ${JSON.stringify(scans)} ;;
esac
exec `,
        ),
      );
      first = startReload(fixture, [id]);
      await waitUntil(() => panePid() !== oldPid);
      const replacementPid = panePid();
      fixture.env.PI_MUX_FIXTURE_SECOND_RELOAD = "1";
      second = startReload(fixture, [id]);
      writeFileSync(metadata, "");
      const firstResult = await finishReload(first);
      assert.equal(firstResult.status, 0, firstResult.stderr);
      assert.equal(firstResult.stdout.trim(), `reloaded ${id}`);

      await waitUntil(() => panePid() !== replacementPid || readFileSync(scans).length >= 2);
      assert.equal(panePid(), replacementPid, "second reload replaced pi before state publication");
      assert.equal(second.exitCode, null);
      assert.equal(fixture.tmux(["show-options", "-pqv", "-t", pane, "@pi-mux-state-source"]), "");
      assert.equal(
        fixture.tmux(["show-options", "-pqv", "-t", pane, "@pi_session_state_pending"]),
        pending,
      );
      writeFileSync(state, "");
      const secondResult = await finishReload(second);
      assert.equal(secondResult.status, 0, secondResult.stderr);
      assert.equal(secondResult.stdout.trim(), `reloaded ${id}`);
      assert.notEqual(panePid(), replacementPid);
    } finally {
      first?.kill();
      second?.kill();
      await Promise.all([first?.exited, second?.exited]);
      await fixture.cleanup();
    }
  }, 20000);

  it("protects an unconfirmed replacement while another reload starts a different conversation", async () => {
    const fixture = new SessionFixture();
    const allowConfirmation = join(fixture.directory, "allow-confirmation");
    const confirmationBlocked = join(fixture.directory, "confirmation-blocked");
    const secondScans = join(fixture.directory, "second-scans");
    let first: ReturnType<typeof startReload> | undefined;
    let second: ReturnType<typeof startReload> | undefined;
    try {
      prepareManagedPi(fixture);
      const firstId = addManagedSession(fixture, "first", "waiting-user");
      const secondId = addManagedSession(fixture, "second", "waiting-user");
      const launches = join(fixture.directory, "launches.jsonl");
      const wrapper = join(fixture.directory, "bin/tmux");
      writeFileSync(
        wrapper,
        readFileSync(wrapper, "utf8").replace(
          "exec ",
          `case "$PI_MUX_FIXTURE_GATE_CONFIRMATION:$5:$*" in
  2:-C:*@pi-mux-pending-restart-blocker*) printf . >> ${JSON.stringify(secondScans)} ;;
  1:list-panes:*"#{pid}"*"#{@pi-mux-launch}"*)
    : > ${JSON.stringify(confirmationBlocked)}
    while [ ! -f ${JSON.stringify(allowConfirmation)} ]; do sleep 0.01; done ;;
esac
exec `,
        ),
      );
      function firstPid() {
        return fixture.tmux(["display-message", "-p", "-t", "first", "#{pane_pid}"]);
      }

      fixture.env.PI_MUX_FIXTURE_GATE_CONFIRMATION = "1";
      first = startReload(fixture, [firstId]);
      delete fixture.env.PI_MUX_FIXTURE_GATE_CONFIRMATION;
      await waitUntil(
        () =>
          existsSync(confirmationBlocked) &&
          existsSync(launches) &&
          readFileSync(launches, "utf8").includes(firstId),
      );
      const replacementPid = firstPid();

      fixture.env.PI_MUX_FIXTURE_GATE_CONFIRMATION = "2";
      writeFileSync(secondScans, "");
      second = startReload(fixture);
      await waitUntil(() => readFileSync(launches, "utf8").includes(secondId));
      const scansAfterSecondLaunch = readFileSync(secondScans).length;
      await waitUntil(
        () =>
          firstPid() !== replacementPid ||
          readFileSync(secondScans).length >= scansAfterSecondLaunch + 2,
      );
      assert.equal(firstPid(), replacementPid);
      assert.equal(first.exitCode, null);

      writeFileSync(allowConfirmation, "");
      const [firstResult, secondResult] = await Promise.all([
        finishReload(first),
        finishReload(second),
      ]);
      assert.equal(firstResult.status, 0, firstResult.stderr);
      assert.equal(firstResult.stdout.trim(), `reloaded ${firstId}`);
      assert.equal(secondResult.status, 0, secondResult.stderr);
      assert.deepEqual(
        secondResult.stdout.trim().split("\n").sort(),
        [`reloaded ${firstId}`, `reloaded ${secondId}`].sort(),
      );
    } finally {
      writeFileSync(allowConfirmation, "");
      first?.kill();
      second?.kill();
      await Promise.all([first?.exited, second?.exited]);
      await fixture.cleanup();
    }
  }, 20000);

  it("reports a failed respawn without announcing a reload", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      const id = addManagedSession(fixture, "target", "waiting-user");
      const oldPid = fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_pid}"]);
      const wrapper = join(fixture.directory, "bin/tmux");
      writeFileSync(
        wrapper,
        readFileSync(wrapper, "utf8").replace(
          "exec ",
          `case "$*" in
  *PI_MUX_RELOAD_SERVER_CHANGED*) echo "respawn-pane: fixture refusal" >&2; exit 1 ;;
esac
exec `,
        ),
      );

      const result = await finishReload(startReload(fixture, [id]));
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, "");
      assert.ok(result.stderr.includes(`reload ${id}:`), result.stderr);
      assert.match(result.stderr, /respawn-pane: fixture refusal/);
      assert.equal(fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_pid}"]), oldPid);
    } finally {
      await fixture.cleanup();
    }
  }, 20000);

  for (const state of ["waiting-approval", "running", "unknown", "unpublished", "startup"]) {
    it(`waits for a ${state} pi and replaces it when it becomes ready`, async () => {
      const fixture = new SessionFixture();
      let child: ReturnType<typeof startReload> | undefined;
      try {
        prepareManagedPi(fixture);
        const id = addManagedSession(fixture, "blocked", state);
        const pid = Number(fixture.tmux(["display-message", "-p", "-t", "blocked", "#{pane_pid}"]));
        const pane = fixture.tmux(["display-message", "-p", "-t", "blocked", "#{pane_id}"]);
        if (state === "unpublished")
          fixture.tmux(["set-option", "-pu", "-t", pane, "@pi_session_state"]);
        if (state === "startup") {
          const encoded = fixture.tmux(["show-options", "-pqv", "-t", pane, "@pi-tmux-session"]);
          const metadata = JSON.parse(Buffer.from(encoded, "base64").toString());
          fixture.tmux([
            "set-option",
            "-p",
            "-t",
            pane,
            "@pi-tmux-session",
            Buffer.from(JSON.stringify({ ...metadata, startup: "accepted" })).toString("base64"),
          ]);
        }
        child = startReload(fixture);
        await Bun.sleep(250);
        assert.equal(child.exitCode, null);
        assert.equal(existsSync(`/proc/${pid}`), true);
        if (state === "startup") {
          const encoded = fixture.tmux(["show-options", "-pqv", "-t", pane, "@pi-tmux-session"]);
          const metadata = JSON.parse(Buffer.from(encoded, "base64").toString());
          fixture.tmux([
            "set-option",
            "-p",
            "-t",
            pane,
            "@pi-tmux-session",
            Buffer.from(JSON.stringify({ ...metadata, startup: "ready" })).toString("base64"),
          ]);
        }
        const serverPid = Number(fixture.tmux(["display-message", "-p", "#{pid}"]));
        const origin = {
          socket: fixture.socket,
          serverPid,
          pane,
          pid,
          token: fixture.launchTokenOf("blocked"),
        };
        for (const phase of state === "waiting-approval"
          ? ["running", "waiting-user"]
          : ["waiting-user"]) {
          let notified = fixture.run([
            "state",
            id,
            phase,
            "--source",
            JSON.stringify(origin),
            "--title",
            "null",
          ]);
          for (let attempt = 0; notified.status === 75 && attempt < 100; attempt++) {
            await Bun.sleep(50);
            notified = fixture.run([
              "state",
              id,
              phase,
              "--source",
              JSON.stringify(origin),
              "--title",
              "null",
            ]);
          }
          assert.equal(notified.status, 0, notified.stderr);
          if (phase === "running") {
            await Bun.sleep(150);
            assert.equal(child.exitCode, null);
            assert.equal(existsSync(`/proc/${pid}`), true);
          }
        }
        const result = await finishReload(child);
        child = undefined;
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), `reloaded ${id}`);
        assert.equal(existsSync(`/proc/${pid}`), false);
      } finally {
        child?.kill();
        if (child) await child.exited;
        await fixture.cleanup();
      }
    }, 20000);
  }

  it("waits when a running notification is deferred during the replacement window", async () => {
    const fixture = new SessionFixture();
    let child: ReturnType<typeof startReload> | undefined;
    try {
      prepareManagedPi(fixture);
      const id = addManagedSession(fixture, "target", "waiting-user");
      const pane = fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_id}"]);
      const pid = Number(fixture.tmux(["display-message", "-p", "-t", pane, "#{pane_pid}"]));
      const serverPid = Number(fixture.tmux(["display-message", "-p", "#{pid}"]));
      const origin = {
        socket: fixture.socket,
        serverPid,
        pane,
        pid,
        token: fixture.launchTokenOf("target"),
      };
      const notification = [
        process.execPath,
        "run",
        source,
        "state",
        id,
        "running",
        "--source",
        JSON.stringify(origin),
        "--title",
        "null",
      ]
        .map((arg) => JSON.stringify(arg))
        .join(" ");
      const wrapper = join(fixture.directory, "bin/tmux");
      const before = readFileSync(wrapper, "utf8");
      const injected = join(fixture.directory, "injected-status");
      writeFileSync(
        wrapper,
        before.replace(
          "exec ",
          `if [ "$5" = if-shell ] && [ ! -e ${JSON.stringify(injected)} ]; then\n  ${notification} > ${JSON.stringify(injected + ".stdout")} 2> ${JSON.stringify(injected + ".stderr")}\n  printf '%s' "$?" > ${JSON.stringify(injected)}\nfi\nexec `,
        ),
      );
      child = startReload(fixture);
      await waitUntil(() => existsSync(injected));
      assert.equal(
        readFileSync(injected, "utf8"),
        "75",
        readFileSync(injected + ".stderr", "utf8"),
      );
      await Bun.sleep(150);
      assert.equal(child.exitCode, null);
      assert.equal(existsSync(`/proc/${pid}`), true);
      let notified = fixture.run([
        "state",
        id,
        "waiting-user",
        "--source",
        JSON.stringify(origin),
        "--title",
        "null",
      ]);
      for (let attempt = 0; notified.status === 75 && attempt < 100; attempt++) {
        await Bun.sleep(50);
        notified = fixture.run([
          "state",
          id,
          "waiting-user",
          "--source",
          JSON.stringify(origin),
          "--title",
          "null",
        ]);
      }
      assert.equal(notified.status, 0, notified.stderr);
      const result = await finishReload(child);
      child = undefined;
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(`/proc/${pid}`), false);
      assert.deepEqual(restoreDocument(fixture).workspaces, [
        {
          cwd: fixture.cwd,
          sessions: [id],
        },
      ]);
    } finally {
      child?.kill();
      if (child) await child.exited;
      await fixture.cleanup();
    }
  }, 20000);

  it("waits when a waiting-approval notification lands in the replacement window without writing the veto", async () => {
    const fixture = new SessionFixture();
    let child: ReturnType<typeof startReload> | undefined;
    try {
      prepareManagedPi(fixture);
      const id = addManagedSession(fixture, "target", "waiting-user");
      const pane = fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_id}"]);
      const pid = Number(fixture.tmux(["display-message", "-p", "-t", pane, "#{pane_pid}"]));
      const serverPid = Number(fixture.tmux(["display-message", "-p", "#{pid}"]));
      const origin = {
        socket: fixture.socket,
        serverPid,
        pane,
        pid,
        token: fixture.launchTokenOf("target"),
      };
      const notification = [
        process.execPath,
        "run",
        source,
        "state",
        id,
        "waiting-approval",
        "--source",
        JSON.stringify(origin),
        "--title",
        "null",
      ]
        .map((arg) => JSON.stringify(arg))
        .join(" ");
      const wrapper = join(fixture.directory, "bin/tmux");
      const before = readFileSync(wrapper, "utf8");
      const injected = join(fixture.directory, "injected-status");
      writeFileSync(
        wrapper,
        before.replace(
          "exec ",
          `if [ "$5" = if-shell ] && [ ! -e ${JSON.stringify(injected)} ]; then\n  ${notification} > ${JSON.stringify(injected + ".stdout")} 2> ${JSON.stringify(injected + ".stderr")}\n  printf '%s' "$?" > ${JSON.stringify(injected)}\nfi\nexec `,
        ),
      );
      child = startReload(fixture, [id]);
      await waitUntil(() => existsSync(injected));
      assert.equal(readFileSync(injected, "utf8"), "0", readFileSync(injected + ".stderr", "utf8"));
      await Bun.sleep(150);
      assert.equal(child.exitCode, null);
      assert.equal(existsSync(`/proc/${pid}`), true);
      let notified = fixture.run([
        "state",
        id,
        "waiting-user",
        "--source",
        JSON.stringify(origin),
        "--title",
        "null",
      ]);
      for (let attempt = 0; notified.status === 75 && attempt < 100; attempt++) {
        await Bun.sleep(50);
        notified = fixture.run([
          "state",
          id,
          "waiting-user",
          "--source",
          JSON.stringify(origin),
          "--title",
          "null",
        ]);
      }
      assert.equal(notified.status, 0, notified.stderr);
      const result = await finishReload(child);
      child = undefined;
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), `reloaded ${id}`);
      assert.equal(existsSync(`/proc/${pid}`), false);
    } finally {
      child?.kill();
      if (child) await child.exited;
      await fixture.cleanup();
    }
  }, 20000);

  it("keeps the restore record and reports a conversation whose pi exits immediately", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      const id = addManagedSession(fixture, "target", "waiting-user");
      writeFileSync(join(fixture.directory, "bin/pi"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
      const serverPid = fixture.tmux(["display-message", "-p", "#{pid}"]);
      const result = await finishReload(startReload(fixture));
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, new RegExp(id));
      assert.equal(result.stdout.trim(), "");
      assert.equal(fixture.tmux(["display-message", "-p", "#{pid}"]), serverPid);
      const snapshot = fixture.run(["snapshot"]);
      assert.equal(snapshot.status, 0, snapshot.stderr);
      assert.deepEqual(restoreDocument(fixture), {
        version: 1,
        generation: "before-restart",
        workspaces: [{ cwd: fixture.cwd, sessions: [id] }],
      });
    } finally {
      await fixture.cleanup();
    }
  }, 20000);

  it("restores the saved set when no server exists", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      const id = randomUUID();
      conversationFile(fixture.agentDir, fixture.cwd, id);
      writeFileSync(
        restoreFile(fixture),
        JSON.stringify({
          version: 1,
          generation: "previous",
          workspaces: [{ cwd: fixture.cwd, sessions: [id] }],
        }),
      );
      const result = await finishReload(startReload(fixture));
      assert.equal(result.status, 0, result.stderr);
      assert.notEqual(restoreDocument(fixture).generation, "previous");
      assert.deepEqual(restoreDocument(fixture).workspaces, [{ cwd: fixture.cwd, sessions: [id] }]);
    } finally {
      await fixture.cleanup();
    }
  }, 20000);

  it("rejects reload from inside the dedicated server before replacing pi", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      addManagedSession(fixture, "target", "waiting-user");
      const before = readFileSync(restoreFile(fixture), "utf8");
      const panePid = fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_pid}"]);
      fixture.env.TMUX = `${fixture.socket},123,0`;
      const result = await finishReload(startReload(fixture));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /outside/);
      assert.equal(readFileSync(restoreFile(fixture), "utf8"), before);
      assert.equal(fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_pid}"]), panePid);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a server generation change while waiting", async () => {
    const fixture = new SessionFixture();
    let child: ReturnType<typeof startReload> | undefined;
    try {
      prepareManagedPi(fixture);
      addManagedSession(fixture, "target", "running");
      child = startReload(fixture);
      await Bun.sleep(250);
      assert.equal(child.exitCode, null);
      const pid = fixture.tmux(["display-message", "-p", "#{pid}"]);
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", "replacement"]);
      assert.equal(await child.exited, 1);
      assert.match(await new Response(child.stderr).text(), /server changed/);
      assert.equal(fixture.tmux(["display-message", "-p", "#{pid}"]), pid);
    } finally {
      child?.kill();
      if (child) await child.exited;
      await fixture.cleanup();
    }
  }, 20000);

  it("reloads temporary and unsaved pi while preserving their state", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      const id = addManagedSession(fixture, "target", "waiting-user");
      const temporaryId = randomUUID();
      const temporaryFile = conversationFile(fixture.agentDir, fixture.cwd, temporaryId);
      fixture.piSession("temporary", { id: temporaryId, file: temporaryFile, temporary: true });
      restartState(fixture, "temporary", temporaryId, "waiting-user");
      const emptyId = randomUUID();
      fixture.piSession("empty", { id: emptyId, file: join(fixture.directory, "unsaved.jsonl") });
      restartState(fixture, "empty", emptyId, "waiting-user");
      const oldPids = fixture.tmux(["list-panes", "-a", "-F", "#{pane_pid}"]).split("\n");
      const result = await finishReload(startReload(fixture));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        oldPids.some((entry) => existsSync(`/proc/${entry}`)),
        false,
      );
      const launched = readFileSync(join(fixture.directory, "launches.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        launched.map(({ id: launchedId }) => launchedId).sort(),
        [emptyId, id, temporaryId].sort(),
      );
      assert.ok(
        launched
          .find(({ id: launchedId }) => launchedId === temporaryId)
          .args.includes("--session"),
      );
      assert.ok(
        launched.find(({ id: launchedId }) => launchedId === emptyId).args.includes("--session-id"),
      );
      const listed = JSON.parse(fixture.run(["list", "--active", "--json"]).stdout);
      assert.equal(listed.length, 1);
      assert.deepEqual(
        listed[0].sessions.map((entry: { id: string }) => entry.id).sort(),
        [id, temporaryId].sort(),
      );
      assert.equal(
        listed[0].sessions.find((entry: { id: string }) => entry.id === temporaryId)?.temporary,
        true,
      );
      assert.deepEqual(
        listed[0].empty.map((entry: { id: string }) => entry.id),
        [emptyId],
      );
      assert.deepEqual(
        restoreDocument(fixture).workspaces[0]!.sessions.sort(),
        [emptyId, id].sort(),
      );
      assert.equal(
        fixture.tmux(["show-environment", "-t", "temporary", "PI_TMUX_TEMPORARY"]),
        `PI_TMUX_TEMPORARY=${temporaryId}`,
      );
    } finally {
      await fixture.cleanup();
    }
  }, 20000);

  it("reports duplicate conversation IDs and keeps reloading the rest", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      const readyId = addManagedSession(fixture, "ready", "waiting-user");
      const duplicateId = randomUUID();
      const duplicateFile = conversationFile(fixture.agentDir, fixture.cwd, duplicateId);
      fixture.piSession("duplicate-a", { id: duplicateId, file: duplicateFile });
      fixture.piSession("duplicate-b", { id: duplicateId, file: duplicateFile });
      restartState(fixture, "duplicate-a", duplicateId, "waiting-user");
      restartState(fixture, "duplicate-b", duplicateId, "waiting-user");
      const duplicatePids = [
        fixture.tmux(["display-message", "-p", "-t", "duplicate-a", "#{pane_pid}"]),
        fixture.tmux(["display-message", "-p", "-t", "duplicate-b", "#{pane_pid}"]),
      ];
      const result = await finishReload(startReload(fixture));
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, new RegExp(duplicateId));
      assert.match(result.stderr, /Multiple pi processes/);
      assert.equal(result.stdout.trim(), `reloaded ${readyId}`);
      assert.equal(
        duplicatePids.every((entry) => existsSync(`/proc/${entry}`)),
        true,
      );
    } finally {
      await fixture.cleanup();
    }
  }, 20000);

  it("leaves unmanaged panes untouched and completes without targets", async () => {
    const fixture = new SessionFixture();
    try {
      fixture.plainSession("plain");
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", "before-restart"]);
      const plainPid = fixture.tmux(["display-message", "-p", "-t", "plain", "#{pane_pid}"]);
      const result = await finishReload(startReload(fixture));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(existsSync(`/proc/${plainPid}`), true);
      assert.match(fixture.tmux(["list-sessions", "-F", "#{session_name}"]), /plain/);
    } finally {
      await fixture.cleanup();
    }
  }, 20000);

  it("replaces only the targeted conversation and leaves a busy sibling untouched", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      const targetId = addManagedSession(fixture, "target", "waiting-user");
      const siblingId = addManagedSession(fixture, "sibling", "running");
      const siblingPane = fixture.tmux(["display-message", "-p", "-t", "sibling", "#{pane_id}"]);
      const siblingPid = fixture.tmux(["display-message", "-p", "-t", "sibling", "#{pane_pid}"]);
      const targetPid = fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_pid}"]);
      const result = await finishReload(startReload(fixture, [targetId]));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), `reloaded ${targetId}`);
      assert.equal(existsSync(`/proc/${targetPid}`), false);
      assert.equal(existsSync(`/proc/${siblingPid}`), true);
      assert.equal(
        fixture.tmux(["display-message", "-p", "-t", "sibling", "#{pane_pid}"]),
        siblingPid,
      );
      assert.deepEqual(
        JSON.parse(fixture.tmux(["show-options", "-pqv", "-t", siblingPane, "@pi_session_state"])),
        { version: 1, sessionId: siblingId, state: "running" },
      );
      const snapshot = restoreDocument(fixture);
      assert.equal(snapshot.generation, "before-restart");
      assert.deepEqual(snapshot.workspaces[0]!.sessions.sort(), [siblingId, targetId].sort());
    } finally {
      await fixture.cleanup();
    }
  }, 20000);

  it("waits for the targeted conversation when it is busy", async () => {
    const fixture = new SessionFixture();
    let child: ReturnType<typeof startReload> | undefined;
    try {
      prepareManagedPi(fixture);
      const id = addManagedSession(fixture, "target", "running");
      const pane = fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_id}"]);
      const pid = Number(fixture.tmux(["display-message", "-p", "-t", pane, "#{pane_pid}"]));
      child = startReload(fixture, [id]);
      await Bun.sleep(250);
      assert.equal(child.exitCode, null);
      assert.equal(existsSync(`/proc/${pid}`), true);
      const serverPid = Number(fixture.tmux(["display-message", "-p", "#{pid}"]));
      const origin = {
        socket: fixture.socket,
        serverPid,
        pane,
        pid,
        token: fixture.launchTokenOf("target"),
      };
      let notified = fixture.run([
        "state",
        id,
        "waiting-user",
        "--source",
        JSON.stringify(origin),
        "--title",
        "null",
      ]);
      for (let attempt = 0; notified.status === 75 && attempt < 100; attempt++) {
        await Bun.sleep(50);
        notified = fixture.run([
          "state",
          id,
          "waiting-user",
          "--source",
          JSON.stringify(origin),
          "--title",
          "null",
        ]);
      }
      assert.equal(notified.status, 0, notified.stderr);
      const result = await finishReload(child);
      child = undefined;
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), `reloaded ${id}`);
      assert.equal(existsSync(`/proc/${pid}`), false);
    } finally {
      child?.kill();
      if (child) await child.exited;
      await fixture.cleanup();
    }
  }, 20000);

  it("rejects a targeted reload without a server and preserves the restore record", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      const targetId = randomUUID();
      const siblingId = randomUUID();
      for (const id of [targetId, siblingId]) conversationFile(fixture.agentDir, fixture.cwd, id);
      const snapshot = {
        version: 1,
        generation: "before-restart",
        workspaces: [{ cwd: fixture.cwd, sessions: [targetId, siblingId] }],
      };
      writeFileSync(restoreFile(fixture), JSON.stringify(snapshot));

      const targeted = await finishReload(startReload(fixture, [targetId]));
      assert.equal(targeted.status, 1);
      assert.ok(targeted.stderr.includes(targetId));
      assert.match(targeted.stderr, /dedicated server is not running/);
      assert.equal(targeted.stdout, "");
      assert.equal(existsSync(fixture.socket), false);
      assert.deepEqual(restoreDocument(fixture), snapshot);

      const all = await finishReload(startReload(fixture));
      assert.equal(all.status, 0, all.stderr);
      assert.ok(existsSync(fixture.socket));
      assert.deepEqual(
        restoreDocument(fixture).workspaces[0]!.sessions.sort(),
        [siblingId, targetId].sort(),
      );
    } finally {
      await fixture.cleanup();
    }
  }, 20000);

  it("does not start a new server when the original exits after target validation", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      const id = addManagedSession(fixture, "target", "waiting-user");
      const before = readFileSync(restoreFile(fixture), "utf8");
      fixture.beforeCliTmux(`if [ "$5" = start-server ] || [ "$5" = source-file ]; then
  ${JSON.stringify(realTmux)} -S "$2" kill-server || exit 1
  rm -f "$2"
fi`);

      const result = await finishReload(startReload(fixture, [id]));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /tmux source-file failed/);
      assert.equal(result.stdout, "");
      assert.equal(existsSync(fixture.socket), false);
      assert.equal(readFileSync(restoreFile(fixture), "utf8"), before);
    } finally {
      await fixture.cleanup();
    }
  }, 20000);

  it("rejects a targeted conversation that is not running", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      const stoppedId = randomUUID();
      conversationFile(fixture.agentDir, fixture.cwd, stoppedId);
      addManagedSession(fixture, "target", "waiting-user");
      writeFileSync(
        restoreFile(fixture),
        JSON.stringify({
          version: 1,
          generation: "before-restart",
          workspaces: [{ cwd: fixture.cwd, sessions: [stoppedId] }],
        }),
      );
      const targetPid = fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_pid}"]);
      const result = await finishReload(startReload(fixture, [stoppedId]));
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(stoppedId));
      assert.match(result.stderr, /not running/);
      assert.equal(
        fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_pid}"]),
        targetPid,
      );
      assert.deepEqual(restoreDocument(fixture), {
        version: 1,
        generation: "before-restart",
        workspaces: [{ cwd: fixture.cwd, sessions: [stoppedId] }],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects an unknown targeted conversation ID", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      addManagedSession(fixture, "target", "waiting-user");
      const unknownId = randomUUID();
      const before = readFileSync(restoreFile(fixture), "utf8");
      const targetPid = fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_pid}"]);
      const result = await finishReload(startReload(fixture, [unknownId]));
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(unknownId));
      assert.match(result.stderr, /Session not found/);
      assert.equal(readFileSync(restoreFile(fixture), "utf8"), before);
      assert.equal(
        fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_pid}"]),
        targetPid,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports duplicate panes of the targeted conversation", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      const duplicateId = randomUUID();
      const duplicateFile = conversationFile(fixture.agentDir, fixture.cwd, duplicateId);
      fixture.piSession("duplicate-a", { id: duplicateId, file: duplicateFile });
      fixture.piSession("duplicate-b", { id: duplicateId, file: duplicateFile });
      fixture.tmux(["set-option", "-g", "@pi-mux-generation", "before-restart"]);
      restartState(fixture, "duplicate-a", duplicateId, "waiting-user");
      restartState(fixture, "duplicate-b", duplicateId, "waiting-user");
      const duplicatePids = [
        fixture.tmux(["display-message", "-p", "-t", "duplicate-a", "#{pane_pid}"]),
        fixture.tmux(["display-message", "-p", "-t", "duplicate-b", "#{pane_pid}"]),
      ];
      const result = await finishReload(startReload(fixture, [duplicateId]));
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, new RegExp(duplicateId));
      assert.match(result.stderr, /Multiple pi processes/);
      assert.equal(result.stdout.trim(), "");
      assert.equal(
        duplicatePids.every((entry) => existsSync(`/proc/${entry}`)),
        true,
      );
    } finally {
      await fixture.cleanup();
    }
  }, 20000);
});

describe("restore saved conversation resolution", () => {
  function recordCandidate(fixture: SessionFixture, id: string): void {
    writeFileSync(
      restoreFile(fixture),
      JSON.stringify({
        version: 1,
        generation: "previous",
        workspaces: [{ cwd: fixture.cwd, sessions: [id] }],
      }),
    );
  }

  for (const location of ["normal", "archive"] as const) {
    it(`restores from ${location} when it has priority`, async () => {
      const fixture = new SessionFixture();
      try {
        prepareManagedPi(fixture);
        const id = randomUUID();
        const file = conversationFile(fixture.agentDir, fixture.cwd, id);
        const archive = join(dirname(file), "archive");
        const archivedFile = join(archive, basename(file));
        mkdirSync(archive);
        writeFileSync(archivedFile, readFileSync(file));
        if (location === "archive") rmSync(file);
        recordCandidate(fixture, id);

        const result = fixture.run(["restore"]);
        assert.equal(result.status, 0, result.stderr);
        const metadata = fixture.tmux(["list-panes", "-a", "-F", "#{@pi-tmux-session}"]);
        const restored = JSON.parse(Buffer.from(metadata, "base64").toString("utf8"));
        const expectedFile = location === "normal" ? file : archivedFile;
        assert.equal(restored.file, expectedFile);
      } finally {
        await fixture.cleanup();
      }
    });
  }

  for (const failure of ["Invalid session header", "Ambiguous session ID"] as const) {
    it(`reports ${failure} without removing the restore candidate`, async () => {
      const fixture = new SessionFixture();
      try {
        prepareManagedPi(fixture);
        const id = randomUUID();
        const file = conversationFile(fixture.agentDir, fixture.cwd, id);
        const otherFile = join(dirname(file), "other.jsonl");
        writeFileSync(
          otherFile,
          failure === "Invalid session header" ? "{}\n" : readFileSync(file),
        );
        recordCandidate(fixture, id);

        const result = fixture.run(["restore"]);
        assert.equal(result.status, 2, result.stderr);
        assert.ok(result.stderr.includes(`restore ${id}: ${failure}`), result.stderr);
        assert.deepEqual(restoreDocument(fixture).workspaces, [
          { cwd: fixture.cwd, sessions: [id] },
        ]);
        assert.equal(existsSync(join(fixture.directory, "launches.jsonl")), false);
      } finally {
        await fixture.cleanup();
      }
    });
  }

  for (const session of ["missing", "present"] as const) {
    it(`handles a ${session} saved conversation when pane inspection fails`, async () => {
      const fixture = new SessionFixture();
      try {
        prepareManagedPi(fixture);
        const id = randomUUID();
        if (session === "present") conversationFile(fixture.agentDir, fixture.cwd, id);
        recordCandidate(fixture, id);
        fixture.beforeCliTmux(`if [ "$5" = list-panes ]; then
  printf '%s\\n' 'pane inspection failed' >&2
  exit 1
fi`);

        const result = fixture.run(["restore"]);
        if (session === "missing") {
          assert.equal(result.status, 0, result.stderr);
          assert.match(result.stderr, /saved conversation not found; removed/);
          assert.deepEqual(restoreDocument(fixture).workspaces, [
            { cwd: fixture.cwd, sessions: [] },
          ]);
        } else {
          assert.equal(result.status, 2, result.stderr);
          assert.match(result.stderr, /Cannot inspect pi sessions: pane inspection failed/);
          assert.deepEqual(restoreDocument(fixture).workspaces, [
            { cwd: fixture.cwd, sessions: [id] },
          ]);
        }
      } finally {
        await fixture.cleanup();
      }
    });
  }

  it("checks the saved cwd after inspecting live panes before restoring", async () => {
    const fixture = new SessionFixture();
    try {
      prepareManagedPi(fixture);
      const id = randomUUID();
      const file = conversationFile(fixture.agentDir, fixture.cwd, id);
      const otherCwd = join(fixture.directory, "other-workspace");
      mkdirSync(otherCwd);
      const replacement = conversationFile(fixture.agentDir, otherCwd, id);
      const stagedFile = join(fixture.directory, "replacement.jsonl");
      writeFileSync(stagedFile, readFileSync(replacement));
      rmSync(replacement);
      recordCandidate(fixture, id);
      fixture.beforeCliTmux(`if [ "$5" = list-panes ] && [ -f ${JSON.stringify(stagedFile)} ]; then
  mv -- ${JSON.stringify(stagedFile)} ${JSON.stringify(file)} || exit 1
fi`);

      const result = fixture.run(["restore"]);
      assert.equal(result.status, 2, result.stderr);
      assert.ok(
        result.stderr.includes(`restore ${id}: Saved working directory differs from snapshot`),
      );
      assert.deepEqual(restoreDocument(fixture).workspaces, [{ cwd: fixture.cwd, sessions: [id] }]);
      assert.equal(existsSync(join(fixture.directory, "launches.jsonl")), false);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("restore failure exit codes", () => {
  for (const contents of ["{broken", '{"version":1,"generation":"saved","workspaces":{}}']) {
    it(`returns 2 without changing an invalid restore record: ${contents}`, async () => {
      const fixture = new SessionFixture();
      try {
        writeFileSync(join(fixture.directory, "bin/pi"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
        writeFileSync(restoreFile(fixture), contents);
        const result = fixture.run(["restore"]);
        assert.equal(result.status, 2, result.stderr);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /snapshot/);
        assert.equal(readFileSync(restoreFile(fixture), "utf8"), contents);
      } finally {
        await fixture.cleanup();
      }
    });
  }

  it("returns 2 for an unreadable restore record without replacing it", async () => {
    const fixture = new SessionFixture();
    try {
      writeFileSync(join(fixture.directory, "bin/pi"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
      rmSync(restoreFile(fixture));
      mkdirSync(restoreFile(fixture));
      const result = fixture.run(["restore"]);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /Cannot read snapshot/);
      assert.equal(statSync(restoreFile(fixture)).isDirectory(), true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps exit code 1 for missing dependencies before inspecting the restore record", async () => {
    const fixture = new SessionFixture();
    try {
      fixture.env.PATH = join(fixture.directory, "bin");
      writeFileSync(restoreFile(fixture), "{broken restore");
      const result = fixture.run(["restore"]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Executable not found on PATH: pi/);
      assert.equal(readFileSync(restoreFile(fixture), "utf8"), "{broken restore");
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps exit code 1 for runtime directory preparation failure", async () => {
    const fixture = new SessionFixture();
    try {
      writeFileSync(join(fixture.directory, "bin/pi"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
      const previous = JSON.stringify({
        version: 1,
        generation: "saved",
        workspaces: [],
      });
      writeFileSync(restoreFile(fixture), previous);
      const runtimeDirectory = dirname(fixture.socket);
      rmSync(runtimeDirectory, { recursive: true });
      writeFileSync(runtimeDirectory, "blocked runtime directory");
      const result = fixture.run(["restore"]);
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stderr.includes(runtimeDirectory));
      assert.equal(readFileSync(restoreFile(fixture), "utf8"), previous);
    } finally {
      await fixture.cleanup();
    }
  });
});
