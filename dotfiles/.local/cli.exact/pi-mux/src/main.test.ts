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
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseOperation } from "./main";

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

const switchTestRoot = "/tmp/work/dotfiles/pi-mux-switch-current";
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
    mkdirSync(switchTestRoot, { recursive: true });
    this.directory = mkdtempSync(join(switchTestRoot, "test-"));
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
    const [session, pane, pid] = this.startPane(name);
    this.tmux(["set-environment", "-t", session, "PI_TMUX_SESSION_ID", entry.id]);
    if (entry.temporary)
      this.tmux(["set-environment", "-t", session, "PI_TMUX_TEMPORARY", entry.id]);
    this.publishPiMetadata(pane, pid, entry, this.launchTokenOf(name));
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
          cwd: this.cwd,
          file: entry.file,
          pid: Number(pid),
          startup: "ready",
          token,
        }),
      ).toString("base64"),
    ]);
  }

  private startPane(name: string): [string, string, string] {
    const [session, pane, pid] = this.tmux([
      "new-session",
      "-d",
      "-s",
      name,
      "-c",
      this.cwd,
      "-P",
      "-F",
      "#{session_id}\t#{pane_id}\t#{pane_pid}",
      "/bin/sleep",
      "300",
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
    const command = `tmux -S ${JSON.stringify(this.socket)} attach-session -t ${JSON.stringify(session)}`;
    const child = Bun.spawn(["script", "-qfc", command, "/dev/null"], {
      env: this.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    this.attached.push(child);
    await waitUntil(() => this.clients().some((client) => client.session === session));
  }

  run(args: string[]) {
    return spawnSync(process.execPath, ["run", source, ...args], {
      cwd: this.cwd,
      env: this.env,
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

describe("list workspace panes", () => {
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
      const result = fixture.run(["list"]);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [
        {
          cwd: fixture.cwd,
          sessions: [{ id: savedId, file: savedFile, state: null, title: "Saved title" }],
          empty: [{ id: emptyId, file: emptyFile, temporary: true }],
        },
      ]);
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
      assert.equal(unknownPid.status, 1);
      assert.ok(unknownPid.stderr.includes("Cannot identify the tmux client"));
      const unknownId = fixture.run(["switch", randomUUID()]);
      assert.equal(unknownId.status, 1);
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
      assert.equal(noClient.status, 1);
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

describe("current", () => {
  it("prints the metadata of the pi pane the client displays", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      const file = join(fixture.directory, "conversations", `${id}.jsonl`);
      fixture.piSession("pi", { id, file });
      await fixture.attach("pi");
      const expected = { id, cwd: fixture.cwd, file, target: "pi" };
      assert.deepEqual(JSON.parse(fixture.run(["current"]).stdout), expected);
      const clientPid = fixture.clients()[0]!.pid;
      assert.deepEqual(
        JSON.parse(fixture.run(["current", "--client-pid", String(clientPid)]).stdout),
        expected,
      );
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("fails when the client shows a pane without pi metadata", async () => {
    const fixture = new SessionFixture();
    try {
      fixture.plainSession("plain");
      await fixture.attach("plain");
      const result = fixture.run(["current"]);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes("does not show a pi pane"));
      assert.equal(result.stdout, "");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("fails when the displayed pane is not pi, even though the session has a pi pane", async () => {
    const fixture = new SessionFixture();
    try {
      const id = randomUUID();
      fixture.piSession("mixed", {
        id,
        file: join(fixture.directory, "conversations", `${id}.jsonl`),
      });
      fixture.plainWindow("mixed");
      await fixture.attach("mixed");
      const result = fixture.run(["current"]);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes("does not show a pi pane"));
      assert.equal(result.stdout, "");
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it("returns the displayed pi pane when the session has another pi pane", async () => {
    const fixture = new SessionFixture();
    try {
      const displayedId = randomUUID();
      const otherId = randomUUID();
      const displayedFile = join(fixture.directory, "conversations", `${displayedId}.jsonl`);
      fixture.piSession("dual", { id: displayedId, file: displayedFile });
      fixture.piWindow("dual", {
        id: otherId,
        file: join(fixture.directory, "conversations", `${otherId}.jsonl`),
      });
      await fixture.attach("dual");
      const expected = { id: displayedId, cwd: fixture.cwd, file: displayedFile, target: "dual" };
      assert.deepEqual(JSON.parse(fixture.run(["current"]).stdout), expected);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
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
      const titledFile = conversationFile(fixture.agentDir, fixture.cwd, titledId, {
        title: "Named session",
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
      const result = fixture.run(["history"]);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [
        historyEntry(otherFile, otherId, fixture.otherCwd, "review the diff", {
          mtime: Date.parse("2026-01-03T00:00:01.000Z"),
        }),
        historyEntry(titledFile, titledId, fixture.cwd, "Named session", {
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

  it("restricts to the requested cwd and returns an empty array for unregistered cwds", async () => {
    const fixture = new HistoryFixture();
    try {
      const id = randomUUID();
      const file = conversationFile(fixture.agentDir, fixture.cwd, id, {});
      conversationFile(fixture.agentDir, fixture.otherCwd, randomUUID(), {});
      const restricted = fixture.run(["history", "--cwd", fixture.cwd]);
      assert.equal(restricted.status, 0, restricted.stderr);
      assert.deepEqual(JSON.parse(restricted.stdout), [historyEntry(file, id, fixture.cwd, null)]);
      const unregistered = fixture.run(["history", "--cwd", join(fixture.directory, "away")]);
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
      const result = fixture.run(["history"]);
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
      const result = fixture.run(["history", "--cwd", fixture.cwd]);
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
      const result = fixture.run(["history"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [
        historyEntry(healthyFile, healthyId, fixture.cwd, null),
      ]);
    } finally {
      fixture.cleanup();
    }
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
      const result = fixture.run(["list"]);
      assert.equal(result.status, 0, result.stderr);
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
      assert.equal(fixture.run(["list"]).status, 0);
      const result = fixture.run(["workspace", "unregister", fixture.cwd]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.deepEqual(restoreDocument(fixture).workspaces, []);
      assert.deepEqual(JSON.parse(fixture.run(["list"]).stdout), []);
      assert.deepEqual(JSON.parse(fixture.run(["history"]).stdout), []);
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
      assert.deepEqual(JSON.parse(fixture.run(["list"]).stdout), [
        { cwd: fixture.cwd, sessions: [], empty: [] },
      ]);
    } finally {
      await fixture.cleanup();
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
        ["list"],
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

  it("preserves registration through temporary open, normal promotion, and empty-new reuse", async () => {
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
      assert.equal(secondNew.stdout, firstNew.stdout);
      const list = fixture.run(["list"]);
      assert.equal(list.status, 0, list.stderr);
      const listed = JSON.parse(list.stdout);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].sessions[0].id, id);
      assert.equal(listed[0].empty.length, 1);
    } finally {
      await fixture.cleanup();
    }
  }, 20000);
});

function prepareManagedPi(fixture: SessionFixture): void {
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
tmux(["set-option", "-p", "-t", pane, "@pi-tmux-session", Buffer.from(JSON.stringify(metadata)).toString("base64")]);
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
  return Bun.spawn([process.execPath, "run", source, "restart", ...args], {
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
  it("secures an empty pi and switches the client pid to it, reusing the same empty pi", async () => {
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
      assert.match(switched.session, /^pi-empty/);
      const pane = fixture.tmux(["display-message", "-p", "-t", switched.session, "#{pane_id}"]);
      const metadata = JSON.parse(
        Buffer.from(
          fixture.tmux(["show-options", "-pqv", "-t", pane, "@pi-tmux-session"]),
          "base64",
        ).toString(),
      );
      assert.equal(metadata.cwd, fixture.cwd);
      assert.match(result.stdout, new RegExp(`^Pi session ${metadata.id}\\nAttach with: `));
      const reused = fixture.run(["new", "--client-pid", String(client.pid)]);
      assert.equal(reused.status, 0, reused.stderr);
      assert.match(reused.stdout, new RegExp(`^Pi session ${metadata.id}\\n`));
      assert.equal(fixture.clients()[0]!.session, switched.session);
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
        .filter((name) => name.startsWith("pi-empty"));
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
      assert.match(sessionName, /^pi-empty/);
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
        writeFileSync(
          wrapper,
          before.replace(
            "exec ",
            `if [ "$5" = if-shell ] && [ ! -e ${JSON.stringify(injected)} ]; then\n  ${notification} > ${JSON.stringify(injected + ".stdout")} 2> ${JSON.stringify(injected + ".stderr")}\n  printf '%s' "$?" > ${JSON.stringify(injected)}\nfi\nexec `,
          ),
        );
        child = startRestart(fixture, force ? ["--force"] : []);
        await waitUntil(() => existsSync(injected));
        assert.equal(
          readFileSync(injected, "utf8"),
          "75",
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
      const listed = JSON.parse(fixture.run(["list"]).stdout);
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
            ? `if [ "$5" = if-shell ]; then ${JSON.stringify(realTmux)} -S ${JSON.stringify(fixture.socket)} set-option -g @pi-mux-generation replacement; fi\n`
            : `if [ "$5" = ${failure === "stop" ? "if-shell" : "start-server"} ]; then echo injected-${failure}-failure >&2; exit 1; fi\n`;
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
      assert.equal(fixture.tmux(["display-message", "-p", "-t", "target", "#{session_id}"]), session);
      assert.equal(fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_id}"]), pane);
      assert.equal(existsSync(`/proc/${oldPid}`), false);
      const newPid = fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_pid}"]);
      assert.notEqual(newPid, oldPid);
      assert.equal(fixture.tmux(["show-options", "-gqv", "@pi-mux-generation"]), "before-restart");
      const launch = JSON.parse(fixture.tmux(["show-options", "-pqv", "-t", pane, "@pi-mux-launch"]));
      assert.equal(launch.id, id);
      assert.equal(launch.pid, Number(newPid));
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
      assert.deepEqual(restoreDocument(fixture).workspaces, [{
        cwd: fixture.cwd,
        sessions: [id],
      }]);
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
      assert.deepEqual(restoreDocument(fixture).workspaces, [{
        cwd: fixture.cwd,
        sessions: [id],
      }]);
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
      assert.ok(launched.find(({ id: launchedId }) => launchedId === temporaryId).args.includes("--session"));
      assert.ok(launched.find(({ id: launchedId }) => launchedId === emptyId).args.includes("--session-id"));
      const listed = JSON.parse(fixture.run(["list"]).stdout);
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
      assert.equal(fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_pid}"]), targetPid);
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
      assert.equal(fixture.tmux(["display-message", "-p", "-t", "target", "#{pane_pid}"]), targetPid);
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
