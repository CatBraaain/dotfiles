import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { type ToolName, type ToolSession, sanitizeSandboxEnvironment } from "./config.ts";
import type { SandboxMode } from "./sandbox.ts";

type RunOptions = {
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  onData?: (data: Buffer, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
  timeout?: number;
  mode?: SandboxMode;
};

type RunResult = { exitCode: number | null; stdout: Buffer; stderr: Buffer };

type RunToolsResponse = { ok: true; result: AgentToolResult<any> } | { ok: false; error: string };

export class SandboxRunner {
  private readonly runToolsPath = join(dirname(fileURLToPath(import.meta.url)), "run-tools.ts");
  private readonly piPackageDir = getPackageDir();

  constructor(
    private readonly cwd: string,
    readonly buildArgs: (mode: SandboxMode, commandCwd?: string) => string[],
  ) {}

  async runTool(
    toolName: ToolName,
    params: unknown,
    options: {
      mode: SandboxMode;
      signal?: AbortSignal;
      session?: ToolSession;
      onData?: (data: Buffer, stream: "stdout" | "stderr") => void;
    },
  ): Promise<AgentToolResult<any>> {
    const request = JSON.stringify({ toolCallId: "cli", params, session: options.session });
    const execution = await this.run("bun", [this.runToolsPath, toolName], {
      input: request,
      mode: options.mode,
      signal: options.signal,
      env: { ...process.env, GUARDRAIL_PI_PACKAGE_DIR: this.piPackageDir },
      onData: options.onData,
    });
    const response = parseRunToolsResponse(execution);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  }

  private run(
    command: string,
    commandArgs: string[],
    options: RunOptions = {},
  ): Promise<RunResult> {
    options.signal?.throwIfAborted();
    return withSandboxSlot(() => {
      options.signal?.throwIfAborted();
      return this.runSandboxProcess(command, commandArgs, options);
    });
  }

  private runSandboxProcess(
    command: string,
    commandArgs: string[],
    options: RunOptions,
  ): Promise<RunResult> {
    return new Promise((resolveRun, rejectRun) => {
      options.signal?.throwIfAborted();
      const environment = sanitizeSandboxEnvironment({ ...process.env, ...options.env });
      const child = spawn(
        "bwrap",
        [...this.buildArgs(options.mode ?? "fs"), command, ...commandArgs],
        {
          cwd: this.cwd,
          env: environment,
          stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      const timeoutHandle =
        options.timeout && options.timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, options.timeout * 1000)
          : undefined;
      const onAbort = () => child.kill("SIGKILL");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        options.onData?.(chunk, "stdout");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        options.onData?.(chunk, "stderr");
      });
      child.on("error", rejectRun);
      child.on("close", (exitCode) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        options.signal?.removeEventListener("abort", onAbort);
        if (options.signal?.aborted) return rejectRun(new Error("aborted"));
        if (timedOut) return rejectRun(new Error(`timeout:${options.timeout}`));
        resolveRun({
          exitCode,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      });
      if (options.input !== undefined) child.stdin?.end(options.input);
    });
  }
}

const MAX_CONCURRENT_SANDBOX_RUNS = 4;

let runningSandboxRuns = 0;
const sandboxWaiters: (() => void)[] = [];

async function withSandboxSlot<T>(run: () => Promise<T>): Promise<T> {
  if (runningSandboxRuns >= MAX_CONCURRENT_SANDBOX_RUNS)
    await new Promise<void>((resolve) => sandboxWaiters.push(resolve));
  runningSandboxRuns++;
  try {
    return await run();
  } finally {
    runningSandboxRuns--;
    sandboxWaiters.shift()?.();
  }
}

function parseRunToolsResponse(execution: RunResult): RunToolsResponse {
  try {
    const parsed = JSON.parse(execution.stdout.toString("utf8")) as {
      ok?: boolean;
      result?: AgentToolResult<any>;
      error?: string;
    };
    if (parsed.ok === true && parsed.result !== undefined)
      return { ok: true, result: parsed.result };
    if (parsed.ok === false && typeof parsed.error === "string")
      return { ok: false, error: parsed.error };
  } catch {}
  const stderrText = execution.stderr.toString("utf8").trim();
  const exitDetail =
    execution.exitCode !== null
      ? `run-tools exited with code ${execution.exitCode}`
      : "run-tools terminated";
  return { ok: false, error: stderrText || exitDetail };
}
