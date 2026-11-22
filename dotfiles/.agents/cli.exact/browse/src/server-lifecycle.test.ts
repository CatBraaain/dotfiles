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
}

function runServer(
  scenario: string,
  env: Record<string, string> = {},
  runtimeDir: "absolute" | "relative" | "empty" | "unset" = "absolute",
): Report {
  const root = mkdtempSync(join(tmpdir(), "browse-server-contract-"));
  try {
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      XDG_CACHE_HOME: root,
      LOCALAPPDATA: join(root, "Local AppData"),
      CAMOUFOX_HEADLESS: "1",
      CAMOUFOX_BASE_URL: "ws://127.0.0.1:9378/camoufox",
    };
    for (const name of ["CAMOUFOX_EXECUTABLE_PATH", "CAMOUFOX_PLAYWRIGHT_CORE", "XDG_RUNTIME_DIR"])
      delete childEnv[name];
    const runtimeHome = join(root, "runtime-dir");
    if (runtimeDir === "absolute") childEnv.XDG_RUNTIME_DIR = runtimeHome;
    if (runtimeDir === "relative") childEnv.XDG_RUNTIME_DIR = "relative-runtime-dir";
    if (runtimeDir === "empty") childEnv.XDG_RUNTIME_DIR = "";
    const child = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "fixtures/server-lifecycle.ts"), scenario],
      {
        cwd: root,
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
    assert.equal(launches[0]?.[2].at(-2), "__server");
    assert.equal(launches[0]?.[2].at(-1), "9378");
    assert.equal(launches[0]?.[3].detached, true);
    assert.equal(launches[0]?.[3].stdio[0], "ignore");
    assert.equal(typeof launches[0]?.[3].stdio[1], "number");
    assert.equal(launches[0]?.[3].stdio[1], launches[0]?.[3].stdio[2]);
    assert.equal(report.events.filter(([name]) => name === "unref").length, 1);
  });

  it("waits for the configured endpoint without starting a second process on the port", () => {
    const report = runServer("start-port-in-use");
    assert.equal(report.error, undefined);
    assert.equal(report.probes, 3);
    assert.equal(
      report.events.some(([name]) => name === "spawn"),
      false,
    );
  });

  it("fails without spawning when two local servers match the port", () => {
    const report = runServer("start-duplicate");
    assert.match(report.error!, /Multiple local Camoufox servers/);
    assert.equal(
      report.events.some(([name]) => name === "spawn"),
      false,
    );
  });

  it("rejects port zero before probing", () => {
    const report = runServer("start", { CAMOUFOX_BASE_URL: "ws://127.0.0.1:0/camoufox" });
    assert.match(report.error!, /nonzero port/);
    assert.equal(report.probes, 0);
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

describe.skipIf(process.platform === "win32")("server restart contract", () => {
  it("stops the matching process, escalates after ten seconds, then restarts", () => {
    const report = runServer("restart");
    assert.equal(report.error, undefined);
    const stops = report.events.filter(([name, , signal]) => name === "kill" && signal !== 0);
    assert.deepEqual(stops, [
      ["kill", 41001, "SIGTERM", 0],
      ["kill", 41001, "SIGKILL", 10000],
    ]);
    assert.ok(
      report.events.findIndex(([name]) => name === "spawn") >
        report.events.findLastIndex(([name, , signal]) => name === "kill" && signal === "SIGKILL"),
    );
    assert.equal(report.events.find(([name]) => name === "spawn")?.[2].at(-2), "__server");
  });

  it("does not accept a websocket response without readiness from its child", () => {
    const report = runServer("restart-no-ready");
    assert.match(report.error!, /camoufox server not ready/);
    assert.equal(report.probes, 1);
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

describe("Windows restart failures", () => {
  for (const [scenario, error] of [
    ["windows-stop-failed", /Cannot terminate the Windows Camoufox server/],
    ["windows-stop-timeout", /Could not confirm the Windows Camoufox server exited/],
  ] as const) {
    it(`does not launch another server after ${scenario}`, () => {
      const report = runServer(scenario);
      assert.match(report.error!, error);
      assert.equal(report.probes, 0);
      assert.equal(
        report.events.some(([name]) => name === "spawn"),
        false,
      );
    });
  }
});

describe.skipIf(process.platform !== "linux")("server stop contract", () => {
  it("refuses to stop any process when two match the same port", () => {
    const report = runServer("stop-duplicate");
    assert.match(report.error!, /Multiple local Camoufox servers/);
    assert.equal(
      report.events.some(([name]) => name === "kill"),
      false,
    );
  });

  it("succeeds without starting a server when no local server exists", () => {
    const report = runServer("stop-none");
    assert.equal(report.error, undefined);
    assert.equal(
      report.events.some(([name]) => name === "spawn" || name === "kill"),
      false,
    );
  });

  it("reports a pgrep failure instead of treating it as no match", () => {
    const report = runServer("stop-pgrep-error");
    assert.match(report.error!, /pgrep: invalid pattern/);
    assert.equal(
      report.events.some(([name]) => name === "kill"),
      false,
    );
  });

  it("reports a server that does not exit after SIGKILL", () => {
    const report = runServer("stop-hung");
    const escalations = report.events.filter(
      ([name, , signal]) => name === "kill" && signal === "SIGKILL",
    );
    assert.deepEqual(escalations, [["kill", 41001, "SIGKILL", 10000]]);
    assert.match(report.error!, /Camoufox server did not stop/);
  });

  it("ignores matching arguments from an executable other than browse or Bun", () => {
    const report = runServer("stop-other-executable");
    assert.equal(report.error, undefined);
    assert.equal(
      report.events.some(([name]) => name === "kill"),
      false,
    );
  });

  it("fails without signaling if the selected identity changes before signaling", () => {
    const report = runServer("stop-raced");
    assert.match(report.error!, /Cannot confirm the Linux Camoufox process identity/);
    assert.equal(
      report.events.some(([name]) => name === "kill"),
      false,
    );
  });

  it("does not send SIGKILL to a PID reused by a different command", () => {
    const report = runServer("stop-reused");
    assert.equal(report.error, undefined);
    assert.equal(
      report.events.some(([name, , signal]) => name === "kill" && signal === "SIGKILL"),
      false,
    );
  });
});

describe("internal server contract", () => {
  it.skipIf(process.platform === "win32")(
    "resolves default executable, playwright-cli's protocol library, and runtime directory",
    () => {
      const report = runServer("internal-headless", {}, "unset");
      assert.equal(report.error, undefined);
      const launch = report.events.find(([name]) => name === "launchServer")?.[1];
      assert.equal(launch.executablePath, join(homedir(), ".cache/camoufox/camoufox-bin"));
      assert.equal(launch.env.XDG_RUNTIME_DIR, `/run/user/${process.getuid?.() ?? 1000}`);
      assert.ok(
        report.events.some(
          ([name, command, args]) =>
            name === "spawnSync" && command === "which" && args[0] === "playwright-cli",
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
    },
  );

  it("starts with the Windows install path and the npm CLI package's protocol library", () => {
    const localAppData = join(tmpdir(), "Fixture Local AppData");
    const report = runServer("windows-internal", { LOCALAPPDATA: localAppData });
    assert.equal(report.error, undefined);
    const launch = report.events.find(([name]) => name === "launchServer")?.[1];
    assert.equal(launch.executablePath, join(localAppData, "Programs", "Camoufox", "camoufox.exe"));
    assert.equal(launch.port, 9378);
    assert.ok(
      !report.events.some(([name, path]) => name === "require" && path === "fixture-playwright"),
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    it(`closes the browser and exits on ${signal}`, () => {
      const report = runServer("internal-headless", { FIXTURE_SIGNAL: signal });
      assert.equal(report.error, undefined);
      assert.deepEqual(
        report.events.find(([name]) => name === "closeServer"),
        ["closeServer"],
      );
      assert.deepEqual(report.events.at(-1), ["exit", 0]);
    });
  }

  it("reports when a different server already owns the port", () => {
    const report = runServer("internal-collision");
    assert.match(report.error!, /EADDRINUSE/);
    assert.equal(
      report.events.some(([name]) => name === "closeServer"),
      false,
    );
  });

  it("honors executable and playwright overrides, binds the configured endpoint, and keeps headless helpers off", () => {
    const report = runServer(
      "internal-headless",
      {
        CAMOUFOX_EXECUTABLE_PATH: "/fixture/camoufox",
        CAMOUFOX_PLAYWRIGHT_CORE: "/fixture/playwright",
        CAMOUFOX_BASE_URL: "ws://127.0.0.2:9991/custom",
      },
      "absolute",
    );
    const launch = report.events.find(([name]) => name === "launchServer")?.[1];
    assert.equal(report.error, undefined);
    assert.equal(launch.executablePath, "/fixture/camoufox");
    assert.equal(launch.host, "127.0.0.2");
    assert.equal(launch.port, 9991);
    assert.equal(launch.wsPath, "/custom");
    assert.equal(launch.env.XDG_RUNTIME_DIR.endsWith("runtime-dir"), true);
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

  it.skipIf(process.platform === "win32")(
    "arbitrates recovery with the restart lock and drains every slot except its own",
    () => {
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
      assert.deepEqual(slotFiles, [
        "browse-slot-0.lock",
        "browse-slot-1.lock",
        "browse-slot-3.lock",
      ]);
      assert.deepEqual(lock[2].slice(-3), ["__locked", "server", "restart"]);
      assert.equal(report.events.filter(([name]) => name === "probe").length, 0);
    },
  );

  for (const scenario of ["recover-lost", "recover-cooldown"]) {
    it.skipIf(process.platform === "win32")(
      `waits for healthy without submitting another restart: ${scenario}`,
      () => {
        const report = runServer(scenario, {}, "absolute");
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
      },
    );
  }

  it.skipIf(process.platform === "win32")(
    "reports a failed restart instead of treating it as a lock win",
    () => {
      const report = runServer("recover-failed");
      assert.match(report.error!, /Camoufox recovery restart failed: 1/);
      assert.equal(
        report.events.some(([name]) => name === "spawn"),
        false,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "performs the restart directly when flock is unavailable",
    () => {
      const report = runServer("recover-no-flock");
      assert.equal(report.error, undefined);
      assert.equal(report.events.filter(([name]) => name === "spawn").length, 1);
      assert.equal(report.probes, 3);
    },
  );
});
