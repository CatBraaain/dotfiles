import { mock } from "bun:test";
import * as childProcess from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import * as camoufox from "../camoufox";
import * as server from "../server";
import * as util from "../util";

const scenario = process.env.BROWSE_FIXTURE_SCENARIO ?? "success";
const nativeSpawnSync = childProcess.spawnSync;
function trace(event: Record<string, unknown>): void {
  if (process.env.BROWSE_FIXTURE_TRACE)
    appendFileSync(
      process.env.BROWSE_FIXTURE_TRACE,
      JSON.stringify({ pid: process.pid, ...event }) + "\n",
    );
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

mock.module("node:child_process", () => ({
  ...childProcess,
  spawnSync: (command: string, args: string[], options: childProcess.SpawnSyncOptions = {}) => {
    trace({ event: "spawnSync", command, args });
    if (scenario === "no-flock") return { error: new Error("ENOENT"), status: null };
    if (command !== "flock") throw new Error(`unexpected process: ${command}`);
    const executableIndex = args.indexOf(process.execPath);
    const childArgs =
      executableIndex < 0
        ? args
        : [
            ...args.slice(0, executableIndex + 1),
            "--preload",
            import.meta.path,
            ...args.slice(executableIndex + 1),
          ];
    return nativeSpawnSync(command, childArgs, options);
  },
}));
mock.module("../server", () => ({
  ...server,
  ensureOpenserpServer: async () => {},
  startCamoufoxServer: async () => {
    if (scenario === "start-timeout") throw new Error("camoufox server not ready at fixture");
  },
  restartCamoufoxServer: async () => {
    trace({ event: "restart" });
  },
}));
mock.module("../camoufox", () => ({
  ...camoufox,
  camoufoxRender: async (url: string, session: string) => {
    trace({ event: "begin", url, session, slot: process.env.BROWSE_SLOT });
    if (process.env.BROWSE_FIXTURE_GATE) {
      const deadline = Date.now() + 4000;
      while (!existsSync(process.env.BROWSE_FIXTURE_GATE)) {
        if (Date.now() > deadline) throw new Error("fixture gate timeout");
        await sleep(10);
      }
    }
    trace({ event: "end", url, session });
    if (scenario === "abort") throw new Error("render: aborted");
    return "<html>Fixture</html>";
  },
  recoverCamoufoxBeforeRetry: async () => ({ shouldRetry: true, consumesRecoveryBudget: true }),
}));
mock.module("../util", () => ({
  ...util,
  runWithStdin: async (command: string, args: string[], html: string) => {
    trace({ event: "convert", command, args, html });
    return "# Article\n\nBody";
  },
}));
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  trace({ event: "fetch", url });
  if (url.includes("/parse?")) {
    if (scenario === "failure") return new Response("", { status: 503 });
    return Response.json({
      results: [{ rank: 1, title: "Found", url: "https://example.com/", snippet: "Summary" }],
    });
  }
  if (url.includes("reddit.com"))
    return scenario === "failure-fetch"
      ? new Response("", { status: 403 })
      : Response.json({ title: "Reddit fixture" });
  return new Response("<html>not a feed</html>");
}) as typeof fetch;
