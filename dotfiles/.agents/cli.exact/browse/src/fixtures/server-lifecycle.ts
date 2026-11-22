import { mock, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as nodeModule from "node:module";
import { openLinuxProcess } from "../linux-process";
import { join } from "node:path";
import * as util from "../util";

const scenario = process.argv[2]!;
if (scenario.startsWith("windows-")) {
  Object.defineProperty(process, "platform", { value: "win32" });
}
const events: unknown[][] = [];
const signals: { deadline: number; controller: AbortController }[] = [];
const port = "9378";
let now = 0;
let probes = 0;
let openedTarget = false;
const liveTargets = [
  "start-port-in-use",
  "restart",
  "term-exit",
  "stop-hung",
  "stop-reused",
  "stop-raced",
  "stop-other-executable",
  "recover-cooldown",
].includes(scenario);
const alive = new Set(liveTargets ? [41001] : []);
if (scenario === "stop-duplicate" || scenario === "start-duplicate") {
  alive.add(41001);
  alive.add(41002);
}
const nativeRead = fs.readFileSync;
const nativeReadlink = fs.readlinkSync;
const nativeStat = fs.statSync;
const nativeSetTimeout = setTimeout;
if (scenario === "websocket-timeout") {
  globalThis.setTimeout = ((callback: () => void, ms: number) => {
    events.push(["timer", ms]);
    now += ms;
    return nativeSetTimeout(callback, 0);
  }) as typeof setTimeout;
}
const nativeRequire = nodeModule.createRequire(import.meta.url);

spyOn(Date, "now").mockImplementation(() => now);
spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
  events.push(["timeout", ms]);
  const controller = new AbortController();
  signals.push({ controller, deadline: now + ms });
  return controller.signal;
});
spyOn(process, "kill").mockImplementation((pid, signal) => {
  events.push(["kill", pid, signal, now]);
  if (!alive.has(pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
  const exitsOnTerm = scenario === "term-exit";
  if ((signal === "SIGKILL" && scenario !== "stop-hung") || (signal === "SIGTERM" && exitsOnTerm)) {
    alive.delete(pid);
  }
  return true;
});
spyOn(process, "exit").mockImplementation(((code: number) => {
  events.push(["exit", code]);
}) as never);

mock.module("../windows-process", () => ({
  findWindowsServerProcesses: () => {
    if (scenario.startsWith("windows-stop-")) return [{ pid: 41001, identity: "fixture" }];
    return [...alive].map((pid) => ({ pid, identity: "fixture" }));
  },
  stopWindowsProcess: () => {
    if (scenario === "windows-stop-failed") {
      throw new Error("Cannot terminate the Windows Camoufox server");
    }
    if (scenario === "windows-stop-timeout") {
      throw new Error("Could not confirm the Windows Camoufox server exited");
    }
    throw new Error("Unexpected Windows process stop in this fixture");
  },
}));
mock.module("../linux-process", () => ({
  openLinuxProcess: (pid: number): ReturnType<typeof openLinuxProcess> => {
    openedTarget = true;
    return {
      send(signal) {
        process.kill(pid, signal);
      },
      hasExited() {
        if (scenario === "stop-reused" && now >= 100 && pid === 41001) return true;
        return !alive.has(pid);
      },
      close() {},
    };
  },
}));
mock.module("../util", () => ({
  ...util,
  delay: async (ms: number) => {
    events.push(["delay", ms]);
    now += ms;
    for (const { deadline, controller } of signals) if (now >= deadline) controller.abort();
  },
}));
mock.module("node:fs", () => ({
  ...fs,
  statSync: (path: string) =>
    path.startsWith("/proc/") ? { uid: process.geteuid?.() } : nativeStat(path),
  readlinkSync: (path: string) => {
    if (!path.startsWith("/proc/")) return nativeReadlink(path);
    return scenario === "stop-other-executable"
      ? "/usr/bin/tail"
      : fs.realpathSync(process.execPath);
  },
  readFileSync: (path: fs.PathOrFileDescriptor, options?: unknown) => {
    if (String(path).startsWith("/proc/")) {
      const pid = Number(String(path).split("/")[2]);
      if (pid !== 41003 && !alive.has(pid))
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      const reused =
        (scenario === "stop-reused" && now >= 100) || (scenario === "stop-raced" && openedTarget);
      if (String(path).endsWith("/stat")) {
        const fields = ["S", ...Array(18).fill("0"), reused ? "1235" : "1234"];
        return pid + " (browse) " + fields.join(" ");
      }
      return (
        ["bun", util.selfRunPath, pid === 41003 ? "search" : "__server", port].join("\0") + "\0"
      );
    }
    return nativeRead(path, options as never);
  },
}));
mock.module("node:child_process", () => ({
  ...childProcess,
  spawn: (command: string, args: string[], options: unknown) => {
    events.push(["spawn", command, args, options, now]);
    alive.add(42000);
    return {
      pid: 42000,
      exitCode: null,
      on: (event: string, listener: (message: unknown) => void) => {
        if (event === "message" && scenario !== "restart-no-ready") listener("camoufox-ready");
      },
      unref: () => {
        events.push(["unref"]);
      },
    };
  },
  spawnSync: (command: string, args: string[]) => {
    events.push(["spawnSync", command, args]);
    if (command === "flock" && scenario === "recover-lost") return { status: 192 };
    if (command === "flock" && scenario === "recover-failed") return { status: 1 };
    if (command === "flock" && scenario === "recover-no-flock")
      return { error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) };
    if (command === "pgrep" && scenario === "stop-pgrep-error") {
      return { status: 2, stderr: "invalid pattern" };
    }
    if (command === "pgrep") {
      return { status: 0, stdout: [...alive, 41003, process.pid].join("\n") };
    }
    if (command === "ps" && scenario === "recover-cooldown") return { status: 0, stdout: "1\n" };
    if (command === "which" || command === "where") return { status: 0, stdout: process.execPath };
    return { status: 0, stdout: "" };
  },
}));

class FixtureWebSocket extends EventTarget {
  constructor(_url: string) {
    super();
    probes++;
    events.push(["probe", now]);
    const healthy =
      scenario === "ready" ||
      scenario.startsWith("internal") ||
      (scenario !== "timeout" && probes >= 3);
    if (scenario === "websocket-timeout") return;
    queueMicrotask(() => this.dispatchEvent(new Event(healthy ? "open" : "error")));
  }
  close() {
    events.push(["socket-close"]);
  }
}
globalThis.WebSocket = FixtureWebSocket as unknown as typeof WebSocket;

mock.module("../display", () => ({
  DISPLAY_NUMBER: 99,
  resolveHeadless: () => scenario !== "internal-headed",
  ensureDisplay: async () => {
    events.push(["display"]);
  },
  ensureX11vnc: async () => {
    events.push(["vnc"]);
  },
}));
const fixtureCamoufoxPath = join(import.meta.dir, "fixture-camoufox.ts");
mock.module(fixtureCamoufoxPath, () => ({
  launchOptions: async (options: Record<string, unknown>) => {
    events.push(["launchOptions", options]);
    return { executablePath: options.executable_path, env: { DISPLAY: ":99", EXISTING: "kept" } };
  },
}));
function fixtureRequire(path: string) {
  events.push(["require", path]);
  if (path === process.env.CAMOUFOX_PLAYWRIGHT_CORE || path === "fixture-playwright") {
    return {
      firefox: {
        launchServer: async (options: unknown) => {
          events.push(["launchServer", options]);
          if (scenario === "internal-collision") throw new Error("EADDRINUSE");
          return {
            close: async () => {
              events.push(["closeServer"]);
            },
          };
        },
      },
    };
  }
  return nativeRequire(path);
}
fixtureRequire.resolve = (name: string) => {
  events.push(["resolve", name]);
  return name.startsWith("camoufox-js") ? fixtureCamoufoxPath : "fixture-playwright";
};
mock.module("node:module", () => ({ ...nodeModule, createRequire: () => fixtureRequire }));

const {
  startCamoufoxServer,
  stopCamoufoxServer,
  ensureCamoufoxServer,
  ensureOpenserpServer,
  recoverCamoufoxServer,
  camoufoxServerHealthy,
  restartCamoufoxServer,
  runCamoufoxServer,
} = await import("../server");
let error: string | undefined;
let healthy: boolean | undefined;
if (scenario.startsWith("openserp")) {
  globalThis.fetch = (async (input: unknown) => {
    events.push(["http-probe", String(input), now]);
    probes++;
    return new Response("", { status: scenario !== "openserp-timeout" && probes >= 3 ? 200 : 503 });
  }) as typeof fetch;
}
try {
  if (scenario.startsWith("internal")) {
    await runCamoufoxServer();
    process.emit(process.env.FIXTURE_SIGNAL === "SIGINT" ? "SIGINT" : "SIGTERM");
    await Promise.resolve();
  } else if (scenario === "websocket-timeout") {
    healthy = await camoufoxServerHealthy("ws://fixture.invalid/", AbortSignal.timeout(15000));
  } else if (scenario.startsWith("openserp")) {
    await ensureOpenserpServer(AbortSignal.timeout(15000));
  } else if (scenario.startsWith("recover-")) {
    await recoverCamoufoxServer();
  } else if (scenario.startsWith("stop-")) {
    await stopCamoufoxServer();
  } else if (
    scenario.startsWith("windows-") ||
    ["restart", "none", "term-exit", "recycled", "restart-no-ready"].includes(scenario)
  ) {
    await restartCamoufoxServer();
  } else if (scenario === "ensure") {
    await ensureCamoufoxServer(AbortSignal.timeout(15000));
  } else {
    await startCamoufoxServer();
  }
} catch (failure) {
  error = String(failure);
}
console.log(
  JSON.stringify({
    events,
    error,
    healthy,
    now,
    probes,
    pid: process.pid,
  }),
);
