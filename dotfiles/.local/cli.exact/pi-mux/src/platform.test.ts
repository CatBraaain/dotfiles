import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { platformFor } from "./platform";

const linux = platformFor("linux");
const windows = platformFor("win32");

describe("runtime paths", () => {
  it("derives the POSIX runtime root from XDG_RUNTIME_DIR", () => {
    assert.equal(
      linux.runtimeStateRoot({ XDG_RUNTIME_DIR: "/isolated runtime" }),
      "/isolated runtime",
    );
  });

  it("falls back to /run/user on POSIX without XDG_RUNTIME_DIR", () => {
    assert.equal(linux.runtimeStateRoot({}), `/run/user/${process.getuid!()}`);
  });

  it("rejects a relative POSIX runtime root", () => {
    assert.throws(
      () => linux.runtimeStateRoot({ XDG_RUNTIME_DIR: "relative" }),
      /must be absolute/,
    );
  });

  it("uses ~/.local/state on Windows regardless of XDG_RUNTIME_DIR", () => {
    assert.equal(
      windows.runtimeStateRoot({ XDG_RUNTIME_DIR: "/isolated" }),
      join(homedir(), ".local", "state"),
    );
  });

  it("uses an abstract socket on POSIX and a named pipe on Windows", () => {
    const key = "abc123";
    assert.equal(linux.lockAddress(key), `\0pi-mux-${process.getuid!()}-${key}`);
    assert.equal(windows.lockAddress(key), `\\\\.\\pipe\\pi-mux-${key}`);
  });
});

describe("directory and file safety", () => {
  const uid = process.getuid!();
  const owned = { isDirectory: () => true, uid, mode: 0o700 };
  const foreign = { isDirectory: () => true, uid: uid + 1, mode: 0o700 };
  const groupReadable = { isDirectory: () => true, uid, mode: 0o750 };
  const notDirectory = { isDirectory: () => false, uid, mode: 0o700 };

  it("enforces ownership and mode on POSIX", () => {
    linux.assertDirectorySafety(owned, "/runtime");
    for (const stat of [foreign, groupReadable, notDirectory])
      assert.throws(
        () => linux.assertDirectorySafety(stat, "/runtime"),
        /Unsafe runtime directory/,
      );
  });

  it("checks only the directory type on Windows", () => {
    for (const stat of [owned, foreign, groupReadable])
      windows.assertDirectorySafety(stat, "C:\\state");
    assert.throws(
      () => windows.assertDirectorySafety(notDirectory, "C:\\state"),
      /Unsafe runtime directory/,
    );
  });

  it("verifies cache entry ownership on POSIX only", () => {
    assert.equal(linux.ownedFileEntry(owned), true);
    assert.equal(linux.ownedFileEntry(groupReadable), false);
    assert.equal(windows.ownedFileEntry(groupReadable), true);
  });
});

describe("process inspection", () => {
  const dead = (() => {
    const child = Bun.spawn(["true"]);
    return { pid: child.pid, exited: child.exited };
  })();

  it("resolves the parent pid on POSIX only", () => {
    assert.equal(linux.processParentPid(process.pid), process.ppid);
    assert.equal(windows.processParentPid(process.pid), undefined);
  });

  it("walks the ancestry on POSIX and disables it on Windows", () => {
    assert.equal(linux.processDescendsFrom(process.pid, process.ppid), true);
    assert.equal(linux.processDescendsFrom(process.pid, process.pid), true);
    assert.equal(linux.processDescendsFrom(process.ppid, process.pid), false);
    assert.equal(linux.processAncestryAvailable, true);
    assert.equal(windows.processAncestryAvailable, false);
    assert.equal(windows.processDescendsFrom(process.pid, process.ppid), false);
  });

  it("checks liveness on both platforms", async () => {
    assert.equal(linux.processIsAlive(process.pid), true);
    assert.equal(windows.processIsAlive(process.pid), true);
    await dead.exited;
    assert.equal(linux.processIsAlive(dead.pid), false);
    assert.equal(windows.processIsAlive(dead.pid), false);
  });
});

describe("shell command generation", () => {
  it("quotes display commands with POSIX shell quoting", () => {
    assert.equal(
      linux.quoteCommand(["tmux", "-S", "/run/user/1000/pi-tmux/server.sock", "attach-session"]),
      `'tmux' '-S' '/run/user/1000/pi-tmux/server.sock' 'attach-session'`,
    );
    assert.equal(linux.quoteCommand(["it's", "x y"]), `'it'\\''s' 'x y'`);
  });

  it("quotes display commands with PowerShell call syntax on Windows", () => {
    assert.equal(
      windows.quoteCommand(["tmux", "-S", "C:\\state\\server.sock"]),
      `& 'tmux' '-S' 'C:\\state\\server.sock'`,
    );
    assert.equal(windows.quoteCommand(["it's"]), `& 'it''s'`);
  });

  it("builds POSIX pane commands through /usr/bin/env", () => {
    assert.equal(
      linux.paneCommand(["/usr/bin/pi", "--session", "abc"], ["TMUX", "PI_SESSION_ID"]),
      `'/usr/bin/env' '-u' 'TMUX' '-u' 'PI_SESSION_ID' '/usr/bin/pi' '--session' 'abc'`,
    );
  });

  it("builds PowerShell pane commands with environment removals on Windows", () => {
    assert.equal(
      windows.paneCommand(["C:\\bin\\pi.exe", "--session", "abc"], ["TMUX"]),
      `& { $env:TMUX=$null; & 'C:\\bin\\pi.exe' '--session' 'abc' }`,
    );
    assert.equal(windows.paneCommand(["C:\\bin\\pi.exe"], []), `& 'C:\\bin\\pi.exe'`);
  });

  it("ignores invalid environment names on Windows", () => {
    assert.equal(
      windows.paneCommand(["pi"], ["ok_name", "bad name; calc"]),
      `& { $env:ok_name=$null; & 'pi' }`,
    );
  });

  it("builds POSIX hook commands with environment assignments", () => {
    assert.equal(
      linux.hookCommand(["/usr/bin/pi-mux", "snapshot"], { HOME: "/home/u", PATH: "/bin" }),
      `'/usr/bin/env' 'HOME=/home/u' 'PATH=/bin' '/usr/bin/pi-mux' 'snapshot'`,
    );
  });

  it("builds PowerShell hook commands on Windows", () => {
    assert.equal(
      windows.hookCommand(["C:\\bin\\pi-mux.exe", "snapshot"], {
        PI_CODING_AGENT_DIR: "C:\\agent",
      }),
      `& { $env:PI_CODING_AGENT_DIR='C:\\agent'; & 'C:\\bin\\pi-mux.exe' 'snapshot' }`,
    );
  });
});
