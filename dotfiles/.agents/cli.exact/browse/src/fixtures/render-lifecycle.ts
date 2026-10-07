import { mock } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tryRecoveryBackends } from "../backends";
import { RENDER_TIMEOUT_MS, stateDir } from "../config";

const scenario = process.argv[2] ?? "success";
const timers = new Set<ReturnType<typeof setTimeout>>();
const signals: AbortSignal[] = [];
const commands: string[] = [];
const pendingAfterRender: number[] = [];
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
let deadlinesFired = 0;
let renders = 0;

globalThis.setTimeout = ((callback: () => void, delay?: number) => {
  if (delay !== RENDER_TIMEOUT_MS) return nativeSetTimeout(callback, delay);
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

mock.module(join(import.meta.dir, "../server.ts"), () => ({
  ensureCamoufoxServer: async () => {},
  camoufoxServerHealthy: async () => true,
  recoverCamoufoxServer: async () => {},
  restartInFlight: () => false,
  waitForRestartToFinish: () => {},
}));
mock.module("node:child_process", () => ({
  ...childProcess,
  execFile: (
    _command: string,
    args: string[],
    options: { signal: AbortSignal },
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    const command = args[1]!;
    commands.push(command);
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

mkdirSync(stateDir(), { recursive: true });
const { camoufoxRender, shouldRetryCamoufox, recoverCamoufoxBeforeRetry } =
  await import("../camoufox");
const render = async () => {
  renders += 1;
  try {
    return await camoufoxRender("https://fixture.invalid/", "fixture-session");
  } finally {
    pendingAfterRender.push(timers.size);
  }
};
let html: string | undefined;
let error: string | undefined;
try {
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
  JSON.stringify({ stage: "complete", html, error, renders, commands, pendingAfterRender }),
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
