import { mock, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tryRecoveryBackends } from "../backends";
import { RENDER_TIMEOUT_MS, stateDir } from "../config";
import { writeNpmPlaywrightFixture } from "./npm-playwright";

const scenario = process.argv[2] ?? "success";
const isFreshCacheScenario = scenario === "fresh-cache";
const isWindowsNpmScenario = scenario === "windows-npm";
const isLinuxWrapperScenario = scenario === "linux-wrapper";
const isLinuxScenario = scenario === "linux-direct" || isLinuxWrapperScenario;
const isDirectScenario = isLinuxScenario || scenario === "windows-direct";
const isNativeWindows = process.platform === "win32";
const fixtureUrl =
  isWindowsNpmScenario || isDirectScenario
    ? "https://fixture.invalid/?query=a&literal=%PATH%"
    : "https://fixture.invalid/";
const nativeExecFile = childProcess.execFile;
if (!isDirectScenario) process.env.PLAYWRIGHT_MCP_TIMEOUT_NAVIGATION = "60000";
const cliEntry =
  isNativeWindows || isWindowsNpmScenario || isDirectScenario ? setupPlaywrightCli() : undefined;

function setupPlaywrightCli(): string | undefined {
  const prefix = join(stateDir(), "npm prefix");
  process.env.PWTEST_CLI_GLOBAL_CONFIG = prefix;
  const { entry, shim } = writeNpmPlaywrightFixture(
    prefix,
    `const assert = require("node:assert/strict");
     const args = process.argv.slice(2);
     assert.deepEqual(args, JSON.parse(process.env.FIXTURE_PLAYWRIGHT_ARGS));
     const [session, command, argument] = args;
     assert.equal(session, "-s=fixture-session");
     assert.ok(process.env.PLAYWRIGHT_MCP_CONFIG.endsWith("playwright-cli.config.json"));
     if (command === "open") assert.equal(argument, ${JSON.stringify(fixtureUrl)});
     if (command === "run-code") console.log("### Result\\n" + JSON.stringify(require("playwright-core")));
    `,
    `const assert = require("node:assert/strict");
     module.exports = {
       mode: "settled",
       html: "<html>Windows npm fixture</html>",
       firefox: {
         async connect() {
           return {
             async newPage() {
               return {
                 once() {},
                 async goto(url) { assert.equal(url, ${JSON.stringify(fixtureUrl)}); },
                 async evaluate() { return "<html>Direct fixture</html>"; },
                 async waitForLoadState() {},
                 async waitForTimeout() {},
               };
             },
             async close() {},
           };
         },
       },
     };`,
  );

  if (isLinuxScenario) {
    const nativeWhich = Bun.which;
    const executable = isLinuxWrapperScenario ? shim : entry;
    spyOn(Bun, "which").mockImplementation((command, options) =>
      command === "playwright-cli" ? executable : nativeWhich(command, options),
    );
    Object.defineProperty(process, "platform", { value: "linux" });
    return undefined;
  }
  if (isNativeWindows) {
    process.env.PATH = prefix + delimiter + process.env.PATH;
  } else {
    const nativeWhich = Bun.which;
    spyOn(Bun, "which").mockImplementation((command, options) => {
      if (command === "playwright-cli.cmd") return shim;
      if (command === "node.exe") return process.execPath;
      return nativeWhich(command, options);
    });
    Object.defineProperty(process, "platform", { value: "win32" });
  }
  return entry;
}
const timers = new Set<ReturnType<typeof setTimeout>>();
const signals: AbortSignal[] = [];
const commands: string[] = [];
const pendingAfterRender: number[] = [];
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
let deadlinesFired = 0;
let renders = 0;
let reachedProbe = false;
const healthDeadlines: number[] = [];
const renderBudgets: number[] = [];
const polling: number[] = [];
const idleOptions: unknown[] = [];
let virtualNow = 0;
let idleTimedOutAt: number | undefined;
const pageReadsAt: number[] = [];
const healthStages: {
  stage: string;
  signalIndex: number;
  startedAt: number;
  finishedAt: number;
  aborted: boolean;
}[] = [];
const healthSignals: { signal: AbortSignal; controller: AbortController; deadline: number }[] = [];
const virtualHealth = scenario.startsWith("health-budget-");
if (scenario.startsWith("health-") || scenario === "challenge-timeout") {
  spyOn(Date, "now").mockImplementation(() => virtualNow);
}
function advance(ms: number): void {
  virtualNow += ms;
  for (const record of healthSignals) {
    if (virtualNow >= record.deadline) record.controller.abort();
  }
}
function consumeHealthStage(stage: string, signal: AbortSignal, durationMs: number): boolean {
  const signalIndex = healthSignals.findIndex((record) => record.signal === signal);
  if (signalIndex < 0) throw new Error("health stage did not receive a timeout signal");
  const record = healthSignals[signalIndex]!;
  const startedAt = virtualNow;
  advance(Math.min(durationMs, Math.max(0, record.deadline - virtualNow)));
  healthStages.push({
    stage,
    signalIndex,
    startedAt,
    finishedAt: virtualNow,
    aborted: signal.aborted,
  });
  return !signal.aborted;
}
const nativeSignalTimeout = AbortSignal.timeout;
{
  AbortSignal.timeout = (ms: number) => {
    healthDeadlines.push(ms);
    if (virtualHealth) {
      const controller = new AbortController();
      healthSignals.push({ signal: controller.signal, controller, deadline: virtualNow + ms });
      return controller.signal;
    }
    return nativeSignalTimeout(scenario === "health-open-timeout" ? 20 : ms);
  };
}

globalThis.setTimeout = ((callback: () => void, delay?: number) => {
  if (isWindowsNpmScenario || delay !== RENDER_TIMEOUT_MS) return nativeSetTimeout(callback, delay);
  renderBudgets.push(delay);
  const timer = nativeSetTimeout(
    () => {
      timers.delete(timer);
      deadlinesFired += 1;
      callback();
    },
    scenario === "timeout" ? 20 : 300,
  );
  timers.add(timer);
  return timer;
}) as typeof setTimeout;
globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
  timers.delete(timer);
  nativeClearTimeout(timer);
}) as typeof clearTimeout;

if (isFreshCacheScenario) {
  globalThis.WebSocket = class extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }

    close() {}
  } as unknown as typeof WebSocket;
} else {
  mock.module(join(import.meta.dir, "../server.ts"), () => ({
    ensureCamoufoxServer: async () => {},
    camoufoxServerHealthy: async (_url: string, signal: AbortSignal) => {
      if (virtualHealth) return consumeHealthStage("websocket", signal, 1000);
      return scenario !== "health-websocket-down";
    },
    recoverCamoufoxServer: async () => {},
  }));
}
mock.module("node:child_process", () => ({
  ...childProcess,
  execFile: (
    executable: string,
    argv: string[],
    options: { signal: AbortSignal; env?: NodeJS.ProcessEnv },
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    if (cliEntry && argv[0] !== cliEntry) {
      queueMicrotask(() => callback(new Error("Expected the npm package bin entry"), ""));
      return;
    }
    const args = cliEntry ? argv.slice(1) : argv;
    const command = args[1]!;
    commands.push(command);
    if (isWindowsNpmScenario) {
      nativeExecFile(
        executable,
        argv,
        {
          ...options,
          env: { ...options.env, FIXTURE_PLAYWRIGHT_ARGS: JSON.stringify(args) },
        },
        callback,
      );
      return;
    }
    if (virtualHealth && command === "close") {
      const isInitialClose = commands.length === 1;
      const duration = isInitialClose ? 1000 : scenario === "health-budget-success" ? 400 : 0;
      const succeeded = consumeHealthStage(
        isInitialClose ? "initial-close" : "final-close",
        options.signal,
        duration,
      );
      queueMicrotask(() => callback(succeeded ? null : new Error("aborted"), ""));
      return;
    }
    if (command === "run-code" && scenario.startsWith("challenge-")) {
      const snippet = Function(`return (${args[2]})`)() as (page: unknown) => Promise<unknown>;
      let idle!: () => void;
      let rejectIdle!: (error: Error) => void;
      let idleDeadline = 0;
      const page = {
        evaluate: async () => {
          pageReadsAt.push(virtualNow);
          return scenario === "challenge-detected"
            ? '<form id="captcha-form"></form>'
            : "<html>ready</html>";
        },
        waitForLoadState: (_state: string, options: { timeout: number }) => {
          idleOptions.push(options);
          idleDeadline = virtualNow + options.timeout;
          return new Promise<void>((resolve, reject) => {
            idle = resolve;
            rejectIdle = reject;
          });
        },
        waitForTimeout: async (ms: number) => {
          polling.push(ms);
          if (scenario === "challenge-timeout") {
            advance(ms);
            if (virtualNow >= idleDeadline && idleTimedOutAt === undefined) {
              idleTimedOutAt = virtualNow;
              rejectIdle(new Error("networkidle timeout"));
            }
          } else if (polling.length === 2) idle();
          await new Promise((resolve) => nativeSetTimeout(resolve, 0));
        },
      };
      void snippet(page).then((result) =>
        callback(null, "### Result\n" + JSON.stringify(result) + "\n"),
      );
      return;
    }
    if (command === "open" && scenario.startsWith("health-")) {
      if (
        virtualHealth &&
        !consumeHealthStage(
          "open",
          options.signal,
          scenario === "health-budget-success" ? 2500 : 4000,
        )
      ) {
        queueMicrotask(() => callback(new Error("aborted"), ""));
        return;
      }
      if (scenario === "health-open-timeout") {
        options.signal.addEventListener("abort", () => callback(new Error("aborted"), ""), {
          once: true,
        });
      } else {
        void fetch(args[2]!).then(async (response) => {
          reachedProbe = (await response.text()).includes("<body>ok</body>");
          callback(null, "");
        });
      }
      return;
    }
    if (command === "open") {
      signals.push(options.signal);
      if (scenario === "timeout") {
        options.signal.addEventListener("abort", () => callback(new Error("aborted"), ""), {
          once: true,
        });
        return;
      }
    }
    queueMicrotask(() => {
      const openFailed = command === "open" && scenario === "open-error";
      const closeFailed = command === "close" && scenario === "close-error";
      const challenge =
        scenario === "retry-error" || (scenario === "retry-success" && renders === 1);
      const result =
        scenario === "parse-error"
          ? "invalid result"
          : `### Result\n${JSON.stringify({ mode: challenge ? "challenge" : "settled", html: "<html>ready</html>" })}\n`;
      callback(
        openFailed || closeFailed ? new Error("fixture failure") : null,
        command === "run-code" ? result : "",
      );
    });
  },
}));

if (process.env.BROWSE_FIXTURE_GATE === "1") {
  console.log(JSON.stringify({ stage: "started" }));
  await new Promise<void>((resolve) =>
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    }),
  );
}

if (!isFreshCacheScenario) mkdirSync(stateDir(), { recursive: true });
const {
  camoufoxRender,
  camoufoxServerResponsive,
  shouldRetryCamoufox,
  recoverCamoufoxBeforeRetry,
} = await import("../camoufox");
const render = async () => {
  renders += 1;
  try {
    return await camoufoxRender(fixtureUrl, "fixture-session");
  } finally {
    pendingAfterRender.push(timers.size);
  }
};
let html: string | undefined;
let error: string | undefined;
try {
  if (scenario.startsWith("health-")) {
    console.log(
      JSON.stringify({
        stage: "complete",
        responsive: await camoufoxServerResponsive(),
        reachedProbe,
        healthDeadlines,
        commands,
        virtualNow,
        healthStages,
      }),
    );
    process.exit(0);
  }
  html = scenario.startsWith("retry-")
    ? (
        await tryRecoveryBackends(
          "web fetch",
          [["fixture", render]],
          () => false,
          shouldRetryCamoufox,
          recoverCamoufoxBeforeRetry,
        )
      ).payload
    : await render();
} catch (failure) {
  error = failure instanceof Error ? failure.message : String(failure);
}
console.log(
  JSON.stringify({
    stage: "complete",
    html,
    error,
    renders,
    commands,
    pendingAfterRender,
    healthDeadlines,
    renderBudgets,
    polling,
    idleOptions,
    virtualNow,
    idleTimedOutAt,
    pageReadsAt,
  }),
);
process.exitCode = error ? 1 : 0;
process.on("exit", () => {
  console.log(
    JSON.stringify({
      stage: "exit",
      deadlinesFired,
      aborted: signals.map((signal) => signal.aborted),
    }),
  );
});
