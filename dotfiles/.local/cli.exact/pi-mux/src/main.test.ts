import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
      "workspace",
    ])
      mkdirSync(join(this.directory, directory), { recursive: true, mode: 0o700 });
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
