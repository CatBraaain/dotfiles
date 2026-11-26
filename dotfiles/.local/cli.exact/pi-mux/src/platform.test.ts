import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { platformFor } from "./platform";
import { selectWindowsChildren } from "./windows-process";

const linux = platformFor("linux");
const windows = platformFor("win32");

describe("runtime paths", () => {
  it("derives the POSIX runtime root from XDG_RUNTIME_DIR", () => {
    assert.equal(
      linux.runtimeStateRoot({ XDG_RUNTIME_DIR: "/isolated runtime" }),
      "/isolated runtime",
    );
  });

  it.skipIf(process.platform === "win32")(
    "falls back to /run/user on POSIX without XDG_RUNTIME_DIR",
    () => {
      assert.equal(linux.runtimeStateRoot({}), `/run/user/${process.getuid!()}`);
    },
  );

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

  it.skipIf(process.platform === "win32")("uses an abstract socket on POSIX", () => {
    assert.equal(linux.lockAddress("abc123"), `\0pi-mux-${process.getuid!()}-abc123`);
  });

  it("uses a named pipe on Windows", () => {
    assert.equal(windows.lockAddress("abc123"), "\\\\.\\pipe\\pi-mux-abc123");
  });
});

describe("directory and file safety", () => {
  const uid = process.getuid?.() ?? 1000;
  const owned = { isDirectory: () => true, uid, mode: 0o700 };
  const foreign = { isDirectory: () => true, uid: uid + 1, mode: 0o700 };
  const groupReadable = { isDirectory: () => true, uid, mode: 0o750 };
  const notDirectory = { isDirectory: () => false, uid, mode: 0o700 };

  it.skipIf(process.platform === "win32")("enforces ownership and mode on POSIX", () => {
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

  it.skipIf(process.platform === "win32")(
    "verifies cache entry ownership and mode on POSIX",
    () => {
      assert.equal(linux.ownedFileEntry(owned), true);
      assert.equal(linux.ownedFileEntry(groupReadable), false);
    },
  );

  it("accepts group-readable cache entries on Windows", () => {
    assert.equal(windows.ownedFileEntry(groupReadable), true);
  });
});

describe("process inspection", () => {
  const dead = (() => {
    const child = Bun.spawn([process.execPath, "-e", ""]);
    return { pid: child.pid, exited: child.exited };
  })();

  it.skipIf(process.platform !== "linux")("resolves the client parent pid on POSIX", async () => {
    assert.deepEqual(await linux.clientPidsFor(process.ppid, [process.pid]), [process.pid]);
  });

  it.skipIf(process.platform !== "win32")(
    "matches Windows client PIDs and verified direct children",
    async () => {
      const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(15_000)"]);
      try {
        assert.deepEqual(await windows.clientPidsFor(process.pid, [child.pid]), [child.pid]);
        assert.deepEqual(await windows.clientPidsFor(child.pid, [child.pid]), [child.pid]);
        assert.deepEqual(await windows.clientPidsFor(process.pid, [process.pid, child.pid]), [
          process.pid,
          child.pid,
        ]);
        assert.deepEqual(await windows.clientPidsFor(process.ppid, [child.pid]), []);
        await dead.exited;
        assert.deepEqual(await windows.clientPidsFor(process.pid, [dead.pid]), []);
      } finally {
        child.kill();
        await child.exited;
      }
    },
    16_000,
  );

  it.skipIf(process.platform !== "linux")(
    "walks the ancestry on POSIX and disables it on Windows",
    () => {
      assert.equal(linux.processDescendsFrom(process.pid, process.ppid), true);
      assert.equal(linux.processDescendsFrom(process.pid, process.pid), true);
      assert.equal(linux.processDescendsFrom(process.ppid, process.pid), false);
      assert.equal(linux.processAncestryAvailable, true);
      assert.equal(windows.processAncestryAvailable, false);
      assert.equal(windows.processDescendsFrom(process.pid, process.ppid), false);
    },
  );

  it("checks liveness on both platforms", async () => {
    assert.equal(linux.processIsAlive(process.pid), true);
    assert.equal(windows.processIsAlive(process.pid), true);
    await dead.exited;
    assert.equal(linux.processIsAlive(dead.pid), false);
    assert.equal(windows.processIsAlive(dead.pid), false);
  });
});

describe("Windows client ancestry", () => {
  const parentPid = 100;
  const clientPid = 200;
  const parent = {
    state: "live",
    process: { creationTime: 10n, matchesExecutable: true },
  } as const;

  function child(creationTime: bigint, directParentPid = parentPid) {
    return { state: "live", process: { creationTime, parentPid: directParentPid } } as const;
  }

  it("does not match a child older than or as old as a process that reused its parent's PID", () => {
    for (const creationTime of [9n, 10n]) {
      assert.deepEqual(
        selectWindowsChildren(parentPid, parent, [clientPid], () => child(creationTime)),
        [],
      );
    }
  });

  it("does not match when the live parent has a different executable", () => {
    const differentExecutable = {
      ...parent,
      process: { ...parent.process, matchesExecutable: false },
    };
    assert.deepEqual(
      selectWindowsChildren(parentPid, differentExecutable, [clientPid], () => child(11n)),
      [],
    );
  });

  it("rejects an unknown candidate even after confirming another match", () => {
    const unknownPid = 201;
    assert.throws(
      () =>
        selectWindowsChildren(parentPid, parent, [clientPid, unknownPid], (pid) =>
          pid === clientPid ? child(11n) : { state: "unknown" },
        ),
      /Cannot inspect client process 201/,
    );
  });

  it("rejects a possible match when the parent's executable cannot be verified", () => {
    const unknownExecutable = {
      ...parent,
      process: { ...parent.process, matchesExecutable: undefined },
    };
    assert.throws(
      () => selectWindowsChildren(parentPid, unknownExecutable, [clientPid], () => child(11n)),
      /Cannot verify parent process identity/,
    );
  });

  it("excludes an unrelated candidate even when the requested parent cannot be inspected", () => {
    assert.deepEqual(
      selectWindowsChildren(parentPid, { state: "unknown" }, [clientPid], () => child(11n, 300)),
      [],
    );
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

  it("only forwards environment names that psmux accepts on Windows", () => {
    assert.equal(windows.acceptsTmuxEnvironmentKey("PI_MUX_PROBE"), true);
    assert.equal(windows.acceptsTmuxEnvironmentKey("ProgramFiles(x86)"), false);
    assert.equal(linux.acceptsTmuxEnvironmentKey("ProgramFiles(x86)"), true);
  });

  it("restores Windows environment names that psmux cannot accept in the pane", () => {
    assert.equal(
      windows.paneCommand(["pi"], [], { PATH: "C:\\bin", "ProgramFiles(x86)": "It's here”" }),
      `& { [Environment]::SetEnvironmentVariable('ProgramFiles(x86)', 'It''s here”'); & 'pi' }`,
    );
  });

  it("quotes Windows environment names removed from the pane", () => {
    assert.equal(
      windows.paneCommand(["pi"], ["ok_name", "with 'quotes’ and spaces"]),
      `& { $env:ok_name=$null; [Environment]::SetEnvironmentVariable('with ''quotes’’ and spaces', $null); & 'pi' }`,
    );
  });

  it("passes a Windows pane command as PowerShell executable and arguments", () => {
    const script = `& 'C:\\Program Files\\pi.exe'`;
    const [executable, ...args] = windows.tmuxPaneCommand(script);
    assert.match(executable!, /\\powershell\.exe$/i);
    assert.deepEqual(args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    assert.equal(
      Buffer.from(args.at(-1)!, "base64").toString("utf16le"),
      `${script}; exit $LASTEXITCODE`,
    );
  });

  it("passes all POSIX new-session assignments through unchanged", () => {
    const launch = linux.newSessionLaunch(["pi"], { Path: "/bin", "other-name": "value" }, []);
    assert.deepEqual(launch.environmentArgs, ["-e", "Path=/bin", "-e", "other-name=value"]);
    assert.equal(launch.paneCommand, linux.paneCommand(["pi"], []));
  });

  it("uses only psmux-compatible names for Windows new-session assignments", () => {
    const value = "C:\\Program Files (x86)";
    const launch = windows.newSessionLaunch(
      ["pi"],
      { Path: "C:\\bin", "ProgramFiles(x86)": value },
      [],
    );
    assert.deepEqual(launch.environmentArgs.slice(0, 2), ["-e", "Path=C:\\bin"]);
    assert.equal(launch.environmentArgs.length, 4);
    assert.equal(launch.environmentArgs[2], "-e");
    const [key, encoded] = launch.environmentArgs[3]!.split(/=(.*)/s);
    assert.match(key!, /^[A-Za-z_][A-Za-z0-9_]*$/);
    assert.ok(encoded);
    const encodedCommand = windows.tmuxPaneCommand(launch.paneCommand).at(-1)!;
    const script = Buffer.from(encodedCommand, "base64").toString("utf16le");
    assert.ok(!script.includes(value));
    assert.ok(!script.includes(encoded));
  });

  it("leaves the Windows pane command unchanged when no names need transport", () => {
    const launch = windows.newSessionLaunch(["pi"], { Path: "C:\\bin" }, ["TMUX"]);
    assert.deepEqual(launch.environmentArgs, ["-e", "Path=C:\\bin"]);
    assert.equal(launch.paneCommand, windows.paneCommand(["pi"], ["TMUX"]));
  });

  const powerShell = Bun.which("pwsh") ?? Bun.which("powershell");
  it.skipIf(!powerShell)(
    "restores Windows names as literal data and hides the transport from pi",
    async () => {
      const value = "C:\\Program Files (x86)\\日本語'\"; $name = data\n";
      const envKey = "ProgramFiles(x86)";
      const staleKey = "CommonProgramFiles(x86)";
      const dateKey = "2025-01-02T03:04:05Z";
      const probe = `console.log(JSON.stringify([process.env['${envKey}'], process.env['${staleKey}'], process.env['${dateKey}'], Object.keys(process.env).some(name => name.startsWith('PI_TMUX_ENV_'))]))`;
      const launch = windows.newSessionLaunch(
        [process.execPath, "-e", probe],
        { [envKey]: value, [dateKey]: dateKey },
        [staleKey],
      );
      const assignment = launch.environmentArgs[1]!;
      const equalsAt = assignment.indexOf("=");
      const transportKey = assignment.slice(0, equalsAt);
      const pane = Bun.spawn(
        [powerShell!, ...windows.tmuxPaneCommand(launch.paneCommand).slice(1)],
        {
          env: {
            ...process.env,
            [envKey]: "old",
            [staleKey]: "old",
            [transportKey]: assignment.slice(equalsAt + 1),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(pane.stdout).text(),
        new Response(pane.stderr).text(),
        pane.exited,
      ]);
      assert.equal(code, 0, stderr);
      assert.deepEqual(JSON.parse(stdout), [value, null, dateKey, false]);
    },
  );

  it.skipIf(!powerShell)(
    "does not launch pi when the Windows environment transport is missing",
    async () => {
      const launch = windows.newSessionLaunch(
        [process.execPath, "-e", "console.log('launched')"],
        { "ProgramFiles(x86)": "C:\\Program Files (x86)" },
        [],
      );
      const pane = Bun.spawn(
        [powerShell!, ...windows.tmuxPaneCommand(launch.paneCommand).slice(1)],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(pane.stdout).text(),
        new Response(pane.stderr).text(),
        pane.exited,
      ]);
      assert.notEqual(code, 0);
      assert.equal(stdout, "");
      assert.match(stderr, /Cannot restore pi-mux session environment/);
    },
  );

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
