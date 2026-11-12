import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  readonly membership: string;
  readonly conversation: string;
  readonly env: Record<string, string>;
  readonly membershipBefore: string;
  readonly conversationBefore = "saved conversation sentinel\n";
  readonly generation = randomUUID();
  pid = 0;

  constructor(failure: Failure) {
    assert.ok(realTmux, "tmux must be installed for the isolated close tests");
    mkdirSync(temporaryRoot, { recursive: true });
    this.directory = mkdtempSync(join(temporaryRoot, "test-"));
    this.socket = join(this.directory, "runtime/pi-tmux/server.sock");
    this.cwd = join(this.directory, "workspace");
    this.restore = join(this.directory, "agent/pi-tmux/pi-mux-restore.json");
    this.membership = join(this.directory, "agent/session-state.json");
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
    this.membershipBefore = JSON.stringify({
      sentinel: "preserved",
      "active-workspaces": {
        [this.cwd]: { "active-sessions": { [this.id]: {}, [this.otherId]: {} } },
      },
    });
    writeFileSync(this.membership, this.membershipBefore);
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
        assert.equal(readFileSync(fixture.membership, "utf8"), fixture.membershipBefore);
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
        assert.equal(readFileSync(fixture.membership, "utf8"), fixture.membershipBefore);
        assert.equal(readFileSync(fixture.conversation, "utf8"), fixture.conversationBefore);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

function processStarted(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
}

function stateSource(fixture: CloseFixture) {
  const [serverPid, pane] = fixture
    .tmux(["display-message", "-p", "#{pid}\t#{pane_id}"])
    .split("\t");
  return {
    socket: fixture.socket,
    serverPid: Number(serverPid),
    serverStartTime: processStarted(Number(serverPid)),
    pane: pane!,
    pid: fixture.pid,
    started: processStarted(fixture.pid),
  };
}

function notify(fixture: CloseFixture, args: string[], origin = stateSource(fixture)) {
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

function publicState(fixture: CloseFixture): string {
  return fixture.tmux(["show-options", "-pqv", "@pi_session_state"]);
}

describe("state notifications", () => {
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
      assert.match(result.stderr, /no longer matches/);
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

  it("publishes and clears in an uninitialized external server independently of invalid membership", async () => {
    const fixture = new CloseFixture("none");
    try {
      fixture.start();
      fixture.tmux(["set-option", "-gu", "@pi-mux-generation"]);
      writeFileSync(fixture.membership, "{broken");
      const before = readFileSync(fixture.restore, "utf8");
      const title = "Quotes ' \"\n #{pane_id}; $(touch /unsafe)";
      for (const state of ["waiting-user", "running", "waiting-approval"] as const) {
        const result = notify(fixture, [state, "--title", JSON.stringify(title)]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout + result.stderr, "");
        assert.deepEqual(JSON.parse(publicState(fixture)), {
          version: 1,
          sessionId: fixture.id,
          state,
          title,
        });
      }
      assert.equal(readFileSync(fixture.membership, "utf8"), "{broken");
      assert.equal(readFileSync(fixture.restore, "utf8"), before);
      assert.equal(fixture.tmux(["show-options", "-gqv", "@pi-mux-generation"]), "");
      const cleared = notify(fixture, ["--clear"]);
      assert.equal(cleared.status, 0, cleared.stderr);
      assert.equal(publicState(fixture), "");
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns 75 without changes when another operation holds the shared lock", async () => {
    const fixture = new CloseFixture("none");
    const lock = createServer();
    try {
      fixture.start();
      const key = createHash("sha256")
        .update(join(fixture.directory, "agent/pi-tmux"))
        .digest("hex");
      await new Promise<void>((resolve, reject) => {
        lock.once("error", reject);
        lock.listen(`\0pi-mux-${process.getuid!()}-${key}`, resolve);
      });
      const before = readFileSync(fixture.restore, "utf8");
      const result = notify(fixture, ["running", "--title", "null"]);
      assert.equal(result.status, 75, result.stderr);
      assert.match(result.stderr, /lock/);
      assert.equal(publicState(fixture), "");
      assert.equal(readFileSync(fixture.restore, "utf8"), before);
    } finally {
      if (lock.listening) await new Promise<void>((resolve) => lock.close(() => resolve()));
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
      assert.equal(readFileSync(fixture.membership, "utf8"), fixture.membershipBefore);
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
        { serverStartTime: "0" },
        { pane: "%99999" },
        { pid: process.pid },
        { started: "0" },
      ]) {
        const result = notify(fixture, ["running", "--title", "null"], { ...original, ...changed });
        assert.equal(result.status, 1, JSON.stringify(changed));
        assert.equal(publicState(fixture), before);
        assert.equal(readFileSync(fixture.restore, "utf8"), snapshot);
      }
      const staleClear = notify(fixture, ["--clear"], { ...original, started: "0" });
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
