import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

interface Report {
  events: any[][];
  error?: string;
  healthy?: boolean;
  now: number;
  probes: number;
  pid: number;
  pidFile: string | null;
}

function runServer(scenario: string, env: Record<string, string> = {}): Report {
  const root = mkdtempSync(join(tmpdir(), "browse-server-contract-"));
  try {
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      XDG_CACHE_HOME: root,
      CAMOUFOX_HEADLESS: "1",
    };
    for (const name of ["CAMOUFOX_EXECUTABLE_PATH", "CAMOUFOX_PLAYWRIGHT_CORE", "XDG_RUNTIME_DIR"])
      delete childEnv[name];
    const child = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "fixtures/server-lifecycle.ts"), scenario],
      {
        env: { ...childEnv, ...env },
        timeout: 5000,
      },
    );
    assert.equal(child.exitCode, 0, child.stderr.toString());
    const lastLine = child.stdout.toString().trim().split("\n").at(-1)!;
    return JSON.parse(lastLine);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("server startup contract", () => {
  it("returns immediately without spawning when websocket health succeeds", () => {
    const report = runServer("ready");
    assert.equal(report.error, undefined);
    assert.equal(report.probes, 1);
    assert.deepEqual(
      report.events.filter(([name]) => name === "spawn"),
      [],
    );
  });

  it("spawns __server detached with append logging and polls every 250ms until ready", () => {
    const report = runServer("start");
    assert.equal(report.error, undefined);
    assert.deepEqual(
      report.events.filter(([name]) => name === "probe").map((event) => event[1]),
      [0, 250, 500],
    );
    const launches = report.events.filter(([name]) => name === "spawn");
    assert.equal(launches.length, 1);
    assert.equal(launches[0]?.[2].at(-1), "__server");
    assert.equal(launches[0]?.[3].detached, true);
    assert.equal(launches[0]?.[3].stdio[0], "ignore");
    assert.equal(typeof launches[0]?.[3].stdio[1], "number");
    assert.equal(launches[0]?.[3].stdio[1], launches[0]?.[3].stdio[2]);
    assert.equal(report.events.filter(([name]) => name === "unref").length, 1);
  });

  it("abandons startup at 15 seconds rather than waiting forever", () => {
    const report = runServer("timeout");
    assert.match(report.error!, /camoufox server not ready/);
    assert.equal(report.now, 15000);
    assert.ok(report.events.some(([name, timeout]) => name === "timeout" && timeout === 15000));
  });

  it("uses detached __locked server start when a render needs an unconnected server", () => {
    const report = runServer("ensure");
    assert.equal(report.error, undefined);
    const launch = report.events.find(([name]) => name === "spawn")!;
    assert.deepEqual(launch[2].slice(-3), ["__locked", "server", "start"]);
    assert.equal(launch[3].detached, true);
    assert.equal(report.probes, 3);
  });
});

describe("server restart contract", () => {
  it("stops the deduplicated PID-file and pgrep union, escalates after ten seconds, then restarts", () => {
    const report = runServer("restart");
    assert.equal(report.error, undefined);
    const stops = report.events.filter(([name, , signal]) => name === "kill" && signal !== 0);
    assert.deepEqual(stops, [
      ["kill", 41001, "SIGTERM", 0],
      ["kill", 41002, "SIGTERM", 0],
      ["kill", 41001, "SIGKILL", 10000],
      ["kill", 41002, "SIGKILL", 10000],
    ]);
    assert.ok(
      report.events.findIndex(([name]) => name === "spawn") >
        report.events.findLastIndex(([name, , signal]) => name === "kill" && signal === "SIGKILL"),
    );
    assert.equal(report.events.find(([name]) => name === "spawn")?.[2].at(-1), "__server");
  });

  it("does not escalate processes that terminate after SIGTERM", () => {
    const report = runServer("term-exit");
    assert.equal(report.error, undefined);
    assert.equal(
      report.events.filter(([name, , signal]) => name === "kill" && signal === "SIGKILL").length,
      0,
    );
    assert.equal(report.now, 500);
  });

  it("does not signal a live recycled PID on Windows", () => {
    const report = runServer("windows-recycled", { SystemRoot: "C:\\Windows" });
    assert.equal(report.error, undefined);
    assert.deepEqual(
      report.events.find(([name]) => name === "windowsStopCheck"),
      ["windowsStopCheck", "41003"],
    );
    assert.deepEqual(
      report.events.filter(([name, , signal]) => name === "kill" && signal !== 0),
      [],
    );
    assert.equal(report.events.filter(([name]) => name === "spawn").length, 1);
  });

  for (const [scenario, error] of [
    ["windows-stop-failed", "Could not stop the verified Camoufox server"],
    ["windows-stop-timeout", "Could not determine the Camoufox server stop result"],
  ] as const) {
    it(`aborts Windows restart after ${scenario}`, () => {
      const report = runServer(scenario, { SystemRoot: "C:\\Windows" });
      assert.ok(report.error?.includes(error), report.error ?? "Restart did not report an error");
      assert.equal(report.probes, 0);
      assert.equal(
        report.events.some(([name]) => name === "spawn"),
        false,
      );
    });
  }

  for (const scenario of ["none", "recycled"]) {
    it(`skips stopping ${scenario === "none" ? "absent servers" : "a recycled non-server PID"} and starts a server`, () => {
      const report = runServer(scenario);
      assert.equal(report.error, undefined);
      assert.deepEqual(
        report.events.filter(([name]) => name === "kill"),
        [],
      );
      assert.equal(report.events.filter(([name]) => name === "spawn").length, 1);
    });
  }
});

describe("internal server contract", () => {
  it("resolves default executable, playwright-cli's protocol library, and runtime directory", () => {
    const report = runServer("internal-headless");
    assert.equal(report.error, undefined);
    const launch = report.events.find(([name]) => name === "launchServer")?.[1];
    assert.equal(launch.executablePath, join(homedir(), ".cache/camoufox/camoufox-bin"));
    assert.equal(launch.env.XDG_RUNTIME_DIR, `/run/user/${process.getuid?.() ?? 1000}`);
    assert.ok(
      report.events.some(
        ([name, command, args]) =>
          name === "spawnSync" &&
          ["which", "where"].includes(command) &&
          args[0] === "playwright-cli",
      ),
    );
    assert.ok(
      report.events.some(([name, module]) => name === "resolve" && module === "playwright-core"),
    );
    assert.ok(
      report.events.some(
        ([name, module]) => name === "resolve" && module === "camoufox-js/dist/utils.js",
      ),
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    it(`writes its PID only after listening and clears it before browser close on ${signal}`, () => {
      const report = runServer("internal-headless", { FIXTURE_SIGNAL: signal });
      assert.equal(report.error, undefined);
      assert.deepEqual(
        report.events.find(([name]) => name === "pid"),
        ["pid", String(report.pid)],
      );
      assert.ok(
        report.events.findIndex(([name]) => name === "launchServer") <
          report.events.findIndex(([name]) => name === "pid"),
      );
      assert.deepEqual(
        report.events.find(([name]) => name === "closeServer"),
        ["closeServer", false],
      );
      assert.equal(report.pidFile, null);
      assert.deepEqual(report.events.at(-1), ["exit", 0]);
      assert.equal(report.events.filter(([name]) => name === "kill").length, 0);
    });
  }

  it("does not remove another server's PID file during shutdown", () => {
    const report = runServer("internal-foreign-pid");
    assert.equal(report.pidFile, "other\n");
    assert.deepEqual(
      report.events.find(([name]) => name === "closeServer"),
      ["closeServer", true],
    );
  });

  it("leaves the winner's PID record intact when a second launch loses the port race", () => {
    const report = runServer("internal-collision");
    assert.match(report.error!, /EADDRINUSE/);
    assert.equal(report.pidFile, "winner\n");
    assert.equal(
      report.events.filter(([name]) => name === "pid" || name === "closeServer").length,
      0,
    );
  });

  it("honors executable and playwright overrides, binds the configured endpoint, and keeps headless helpers off", () => {
    const report = runServer("internal-headless", {
      CAMOUFOX_EXECUTABLE_PATH: "/fixture/camoufox",
      CAMOUFOX_PLAYWRIGHT_CORE: "/fixture/playwright",
      CAMOUFOX_BASE_URL: "ws://127.0.0.2:9991/custom",
      XDG_RUNTIME_DIR: "/fixture/runtime",
    });
    const launch = report.events.find(([name]) => name === "launchServer")?.[1];
    assert.equal(report.error, undefined);
    assert.equal(launch.executablePath, "/fixture/camoufox");
    assert.equal(launch.host, "127.0.0.2");
    assert.equal(launch.port, 9991);
    assert.equal(launch.wsPath, "/custom");
    assert.equal(launch.env.XDG_RUNTIME_DIR, "/fixture/runtime");
    assert.equal(report.events.filter(([name]) => name === "display" || name === "vnc").length, 0);
    assert.ok(
      report.events.some(([name, path]) => name === "require" && path === "/fixture/playwright"),
    );
    assert.ok(!Object.keys(launch.env).some((name) => name.startsWith("MOZ_DISABLE_")));
  });

  it("prepares headed helpers first and forces Xvfb and X11 even when Wayland is inherited", () => {
    const report = runServer("internal-headed", { WAYLAND_DISPLAY: "wayland-0" });
    assert.equal(report.error, undefined);
    const names = report.events.map(([name]) => name);
    assert.ok(names.indexOf("display") < names.indexOf("vnc"));
    assert.ok(names.indexOf("vnc") < names.indexOf("launchOptions"));
    const fingerprint = report.events.find(([name]) => name === "launchOptions")?.[1];
    const launch = report.events.find(([name]) => name === "launchServer")?.[1];
    assert.equal(fingerprint.headless, false);
    assert.equal(fingerprint.virtual_display, ":99");
    assert.equal(launch.env.DISPLAY, ":99");
    assert.equal(launch.env.MOZ_ENABLE_WAYLAND, "0");
    assert.equal(launch.env.EXISTING, "kept");
  });
});

describe("bootstrap and recovery timing", () => {
  it("cuts a half-open websocket health probe off after one second", () => {
    const report = runServer("websocket-timeout");
    assert.equal(report.error, undefined);
    assert.equal(report.healthy, false);
    assert.deepEqual(
      report.events.filter(([name]) => name === "timer"),
      [["timer", 1000]],
    );
    assert.equal(report.now, 1000);
  });

  for (const scenario of ["openserp", "openserp-timeout"]) {
    it(`starts openserp detached and polls /ready with a 15-second ceiling: ${scenario}`, () => {
      const report = runServer(scenario, { OPENSERP_BASE_URL: "http://127.0.0.1:7070" });
      const launch = report.events.find(([name]) => name === "spawn")!;
      assert.equal(launch[1], "openserp");
      assert.deepEqual(launch[2], [
        "serve",
        "-a",
        "127.0.0.1",
        "-p",
        "7070",
        "--quiet",
        "--log_level",
        "error",
      ]);
      assert.equal(launch[3].detached, true);
      assert.equal(launch[3].stdio, "ignore");
      const probes = report.events.filter(([name]) => name === "http-probe");
      assert.deepEqual(
        probes.slice(0, 3).map((event) => event.slice(1)),
        [
          ["http://127.0.0.1:7070/ready", 0],
          ["http://127.0.0.1:7070/ready", 250],
          ["http://127.0.0.1:7070/ready", 500],
        ],
      );
      if (scenario === "openserp-timeout") {
        assert.match(report.error!, /openserp server not ready/);
        assert.equal(report.now, 15000);
      } else assert.equal(report.error, undefined);
    });
  }

  it("arbitrates recovery with the restart lock and drains every slot except its own", () => {
    const report = runServer("recover-won", { BROWSE_SLOT: "2" });
    assert.equal(report.error, undefined);
    const lock = report.events.find(
      ([name, command]) => name === "spawnSync" && command === "flock",
    )!;
    assert.deepEqual(lock[2].slice(0, 3), ["-n", "-E", "192"]);
    assert.ok(lock[2][3].endsWith("browse-restart.lock"));
    const slotFiles = (lock[2] as string[])
      .filter((arg) => /browse-slot-/.test(arg))
      .map((arg) => basename(arg));
    assert.deepEqual(slotFiles, ["browse-slot-0.lock", "browse-slot-1.lock", "browse-slot-3.lock"]);
    assert.deepEqual(lock[2].slice(-3), ["__locked", "server", "restart"]);
    assert.equal(report.events.filter(([name]) => name === "probe").length, 0);
  });

  for (const scenario of ["recover-lost", "recover-cooldown"]) {
    it(`waits for healthy without submitting another restart: ${scenario}`, () => {
      const report = runServer(scenario);
      assert.equal(report.error, undefined);
      assert.equal(report.probes, 3);
      assert.equal(report.events.filter(([name]) => name === "spawn").length, 0);
      const flockCalls = report.events.filter(
        ([name, command]) => name === "spawnSync" && command === "flock",
      );
      assert.equal(flockCalls.length, scenario === "recover-lost" ? 1 : 0);
      assert.deepEqual(
        report.events.filter(([name]) => name === "timeout"),
        [["timeout", 15000]],
      );
    });
  }

  it("performs the restart directly when flock is unavailable", () => {
    const report = runServer("recover-no-flock");
    assert.equal(report.error, undefined);
    assert.equal(report.events.filter(([name]) => name === "spawn").length, 1);
    assert.equal(report.probes, 3);
  });
});
