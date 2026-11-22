import { mock, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as nodeModule from "node:module";
import { join } from "node:path";
import * as util from "../util";

const scenario = process.argv[2]!;
const windows = scenario.startsWith("windows-");
Object.defineProperty(process, "platform", { value: windows ? "win32" : "linux" });
const events: unknown[][] = [];
const signals: { deadline: number; controller: AbortController }[] = [];
const pidFile = join(process.env.XDG_CACHE_HOME!, "pi/web-search/camoufox-server.pid");
let now = 0;
let probes = 0;
let pidFilePid: number | undefined =
  scenario === "restart" || scenario === "term-exit" ? 41001 : undefined;
const alive = new Set(pidFilePid ? [41001, 41002] : []);
if (scenario === "recycled" || windows) pidFilePid = 41003;
if (windows) alive.add(41003);
const nativeRead = fs.readFileSync;
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
  if (signal === "SIGKILL" || (scenario === "term-exit" && signal === "SIGTERM")) alive.delete(pid);
  return true;
});
spyOn(process, "exit").mockImplementation(((code: number) => {
  events.push(["exit", code]);
}) as never);

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
    scenario === "recover-cooldown" && path === pidFile ? { mtimeMs: -1000 } : nativeStat(path),
  readFileSync: (path: fs.PathOrFileDescriptor, options?: unknown) => {
    if (path === pidFile && !scenario.startsWith("internal")) {
      if (pidFilePid === undefined) throw new Error("no pid file");
      return `${pidFilePid}\n`;
    }
    if (String(path).startsWith("/proc/")) {
      const pid = Number(String(path).split("/")[2]);
      return ["bun", util.selfRunPath, pid === 41003 ? "search" : "__server"].join("\0");
    }
    return nativeRead(path, options as never);
  },
}));
mock.module("node:child_process", () => ({
  ...childProcess,
  spawn: (command: string, args: string[], options: unknown) => {
    events.push(["spawn", command, args, options, now]);
    return {
      on: () => {},
      unref: () => {
        events.push(["unref"]);
      },
    };
  },
  spawnSync: (command: string, args: string[], options?: childProcess.SpawnSyncOptions) => {
    if (command.endsWith("\\powershell.exe")) {
      events.push(["windowsStopCheck", options?.env?.BROWSE_SERVER_PID]);
      if (scenario === "windows-stop-timeout") {
        return {
          status: null,
          error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
        };
      }
      return { status: scenario === "windows-stop-failed" ? 2 : 0 };
    }
    events.push(["spawnSync", command, args]);
    if (command === "flock" && scenario === "recover-lost") return { status: 192 };
    if (command === "flock" && scenario === "recover-no-flock")
      return { error: new Error("ENOENT") };
    if (command === "pgrep" && windows) return { error: new Error("ENOENT") };
    if (command === "pgrep")
      return {
        status: 0,
        stdout: [...alive]
          .filter((pid) => pid !== 41001)
          .concat(
            [...alive].filter((pid) => pid !== 41001),
            [41003, process.pid],
          )
          .join("\n"),
      };
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
              events.push(["closeServer", fs.existsSync(pidFile)]);
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
    if (scenario === "internal-collision") {
      fs.mkdirSync(join(pidFile, ".."), { recursive: true });
      fs.writeFileSync(pidFile, "winner\n");
    }
    await runCamoufoxServer();
    events.push(["pid", fs.readFileSync(pidFile, "utf8").trim()]);
    if (scenario === "internal-foreign-pid") fs.writeFileSync(pidFile, "other\n");
    process.emit(process.env.FIXTURE_SIGNAL === "SIGINT" ? "SIGINT" : "SIGTERM");
    await Promise.resolve();
  } else if (scenario === "websocket-timeout") {
    healthy = await camoufoxServerHealthy("ws://fixture.invalid/", AbortSignal.timeout(15000));
  } else if (scenario.startsWith("openserp")) {
    await ensureOpenserpServer(AbortSignal.timeout(15000));
  } else if (scenario.startsWith("recover-")) {
    await recoverCamoufoxServer();
  } else if (windows || ["restart", "none", "term-exit", "recycled"].includes(scenario)) {
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
    pidFile: fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : null,
  }),
);
