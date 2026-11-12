import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
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
  readonly membership: string;
  readonly env: Record<string, string>;
  private readonly attached: Bun.Subprocess[] = [];
  private readonly panePids: number[] = [];

  constructor() {
    assert.ok(realTmux && Bun.which("script"), "tmux and script must be installed");
    mkdirSync(switchTestRoot, { recursive: true });
    this.directory = mkdtempSync(join(switchTestRoot, "test-"));
    this.socket = join(this.directory, "runtime/pi-tmux/server.sock");
    this.cwd = join(this.directory, "workspace");
    this.agentDir = join(this.directory, "agent");
    this.membership = join(this.agentDir, "session-state.json");
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
      this.membership,
      JSON.stringify({ "active-workspaces": { [this.cwd]: { "active-sessions": {} } } }),
    );
  }

  piSession(name: string, entry: { id: string; file: string; temporary?: boolean }): void {
    const [session, pane, pid] = this.startPane(name);
    this.tmux(["set-environment", "-t", session, "PI_TMUX_SESSION_ID", entry.id]);
    if (entry.temporary)
      this.tmux(["set-environment", "-t", session, "PI_TMUX_TEMPORARY", entry.id]);
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
        }),
      ).toString("base64"),
    ]);
  }

  plainSession(name: string): void {
    this.startPane(name);
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
  options: { title?: string; mtime?: Date },
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
  ];
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  if (options.mtime) utimesSync(file, options.mtime, options.mtime);
  return file;
}

function historyEntry(file: string, id: string, cwd: string, title: string | null) {
  const stat = statSync(file);
  return {
    id,
    cwd,
    file,
    title,
    mtime: Math.round(stat.mtimeMs),
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
  it("prints the metadata of the session the client displays", async () => {
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
      assert.ok(result.stderr.includes("does not show a pi session"));
      assert.equal(result.stdout, "");
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
  readonly membership: string;

  constructor() {
    mkdirSync(historyTestRoot, { recursive: true });
    this.directory = mkdtempSync(join(historyTestRoot, "test-"));
    this.agentDir = join(this.directory, "agent");
    this.cwd = join(this.directory, "workspace");
    this.otherCwd = join(this.directory, "other");
    this.membership = join(this.agentDir, "session-state.json");
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
      this.membership,
      JSON.stringify({
        "active-workspaces": {
          [this.cwd]: { "active-sessions": {} },
          [this.otherCwd]: { "active-sessions": {} },
        },
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
    return spawnSync(process.execPath, ["run", source, ...args], {
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
      });
      const untitledId = randomUUID();
      const untitledFile = conversationFile(fixture.agentDir, fixture.cwd, untitledId, {
        mtime: new Date("2026-01-01T00:00:00.000Z"),
      });
      fixture.subagentFile(fixture.cwd, randomUUID());
      const otherId = randomUUID();
      const otherFile = conversationFile(fixture.agentDir, fixture.otherCwd, otherId, {
        mtime: new Date("2026-01-03T00:00:00.000Z"),
      });
      const result = fixture.run(["history"]);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [
        historyEntry(otherFile, otherId, fixture.otherCwd, null),
        historyEntry(titledFile, titledId, fixture.cwd, "Named session"),
        historyEntry(untitledFile, untitledId, fixture.cwd, null),
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
});
