import { spawn } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
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
  cooperativeCancellation?: boolean;
};

type RunResult = { exitCode: number | null; stdout: Buffer; stderr: Buffer };

type RunToolsResponse = { ok: true; result: AgentToolResult<any> } | { ok: false; error: string };

// bwrap relies on Linux-only user namespaces; every other platform runs the
// worker as a direct child process with authorization checks only.
function platformSandboxes(): boolean {
  return process.platform === "linux";
}

export class SandboxRunner {
  private readonly runToolsPath = join(dirname(fileURLToPath(import.meta.url)), "run-tools.ts");
  private readonly piPackageDir = getPackageDir();

  constructor(
    private readonly cwd: string,
    readonly buildArgs: (mode: SandboxMode, commandCwd?: string) => string[],
    readonly sandboxed: () => boolean = platformSandboxes,
  ) {}

  async runTool(
    toolName: ToolName,
    params: unknown,
    options: {
      mode: SandboxMode;
      executor?: { entrypoint: string };
      imageMimeType?: string;
      signal?: AbortSignal;
      session?: ToolSession;
      onData?: (data: Buffer, stream: "stdout" | "stderr") => void;
    },
  ): Promise<AgentToolResult<any>> {
    const entrypoint = options.executor?.entrypoint ?? this.runToolsPath;
    if (
      options.executor !== undefined &&
      (typeof options.executor.entrypoint !== "string" ||
        !isAbsolute(options.executor.entrypoint) ||
        options.executor.entrypoint.includes("\0"))
    ) {
      throw new Error("Executor entrypoint must be an absolute file path");
    }
    const request = JSON.stringify({
      toolCallId: "cli",
      params,
      session: options.session,
      imageMimeType: options.imageMimeType,
    });
    const cooperativeCancellation = toolName === "bash" && options.executor === undefined;
    const execution = await this.run(
      "bun",
      [entrypoint, toolName, ...(cooperativeCancellation ? ["--cancel-on-stdin-close"] : [])],
      {
        input: request,
        cooperativeCancellation,
        mode: options.mode,
        signal: options.signal,
        env: { ...process.env, GUARDRAIL_PI_PACKAGE_DIR: this.piPackageDir },
        onData: options.onData,
      },
    );
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
    return this.runSandboxProcess(command, commandArgs, options);
  }

  private runSandboxProcess(
    command: string,
    commandArgs: string[],
    options: RunOptions,
  ): Promise<RunResult> {
    return new Promise((resolveRun, rejectRun) => {
      options.signal?.throwIfAborted();
      const environment = sanitizeSandboxEnvironment({ ...process.env, ...options.env });
      const isolated = this.sandboxed();
      const child = spawn(
        isolated ? "bwrap" : command,
        isolated ? [...this.buildArgs(options.mode ?? "fs"), command, ...commandArgs] : commandArgs,
        {
          cwd: this.cwd,
          env: environment,
          stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      let processError: Error | undefined;
      let inputError: Error | undefined;
      function stopExecution(): void {
        if (options.cooperativeCancellation) child.stdin?.end();
        else child.kill("SIGKILL");
      }
      child.stdin?.on("error", (error: Error) => {
        inputError = error;
      });
      const timeoutHandle =
        options.timeout && options.timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              stopExecution();
            }, options.timeout * 1000)
          : undefined;
      const onAbort = stopExecution;
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        options.onData?.(chunk, "stdout");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        options.onData?.(chunk, "stderr");
      });
      child.on("error", (error: Error) => {
        processError = error;
      });
      child.on("close", (exitCode) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        options.signal?.removeEventListener("abort", onAbort);
        if (processError) return rejectRun(processError);
        if (inputError)
          return rejectRun(new Error("Sandbox worker input failed", { cause: inputError }));
        const execution = {
          exitCode,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        };
        if (options.cooperativeCancellation && (options.signal?.aborted || timedOut)) {
          const response = parseRunToolsResponse(execution);
          if (!response.ok)
            return rejectRun(
              new Error(
                timedOut ? `timeout:${options.timeout}: ${response.error}` : response.error,
              ),
            );
        }
        if (options.signal?.aborted) return rejectRun(new Error("aborted"));
        if (timedOut) return rejectRun(new Error(`timeout:${options.timeout}`));
        resolveRun(execution);
      });
      if (options.input !== undefined) {
        if (options.cooperativeCancellation) child.stdin?.write(`${options.input}\n`);
        else child.stdin?.end(options.input);
      }
      if (options.signal?.aborted) onAbort();
    });
  }
}

function parseRunToolsResponse(execution: RunResult): RunToolsResponse {
  try {
    const parsed = JSON.parse(execution.stdout.toString("utf8")) as {
      ok?: boolean;
      result?: AgentToolResult<any>;
      error?: string;
    };
    if (execution.exitCode === 0 && parsed.ok === true && parsed.result !== undefined)
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
