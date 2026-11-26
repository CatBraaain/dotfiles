import { type ChildProcess, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { getPackageDir, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  sanitizeSandboxEnvironment,
  type ExecutorDescriptor,
  type ExtensionToWorkerMessage,
  type ToolName,
  type ToolRequest,
  type ToolSession,
} from "./config.ts";
import type { SandboxMode } from "./sandbox.ts";

export type RunToolOptions = {
  mode: SandboxMode;
  executor: ExecutorDescriptor;
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
  session?: ToolSession;
  toolCallId?: string;
  onStderrLine?: (line: string) => void;
};

type PendingRequest = {
  responseReceived: boolean;
  cancelSent: boolean;
  cancelReason?: Error;
  cancelTimer?: ReturnType<typeof setTimeout>;
  onStderrLine?: (line: string) => void;
  resolve: (result: AgentToolResult<any>) => void;
  reject: (error: Error) => void;
};

type Worker = {
  mode: SandboxMode;
  key: string;
  child: ChildProcess;
  lines: Interface;
  pending: Map<number, PendingRequest>;
  retiring: boolean;
  stopped: boolean;
  exited: boolean;
  settled: boolean;
  stderrTail: Buffer;
  spawnError?: Error;
  failure?: Error;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  exitTimer?: ReturnType<typeof setTimeout>;
  stopTimer?: ReturnType<typeof setTimeout>;
};

const CANCEL_GRACE_MS = 1000;
const EXIT_GRACE_MS = 2000;
const STDERR_TAIL_BYTES = 8192;

export function validateExecutor(executor: ExecutorDescriptor | undefined): asserts executor {
  if (
    typeof executor?.entrypoint !== "string" ||
    !isAbsolute(executor.entrypoint) ||
    executor.entrypoint.includes("\0")
  )
    throw new Error("Executor entrypoint must be an absolute file path");
}

// bwrap relies on Linux-only user namespaces; every other platform runs the
// worker as a direct child process with authorization checks only.
function platformSandboxes(): boolean {
  return process.platform === "linux";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolResult(value: unknown): value is AgentToolResult<any> {
  return isRecord(value) && Array.isArray(value.content);
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("aborted", { cause: signal.reason });
}

// The child's exit event can trail the process death by a few milliseconds.
function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class WorkerPool {
  private readonly workers = new Map<SandboxMode, Worker>();
  private nextRequestId = 1;

  constructor(
    private readonly cwd: string,
    readonly buildArgs: (mode: SandboxMode, commandCwd?: string) => string[],
    readonly sandboxed: () => boolean = platformSandboxes,
  ) {}

  async runTool(
    toolName: ToolName,
    params: unknown,
    options: RunToolOptions,
  ): Promise<AgentToolResult<any>> {
    options.signal?.throwIfAborted();
    validateExecutor(options.executor);
    const worker = this.acquireWorker(options.mode, options.executor.entrypoint);
    const id = this.nextRequestId++;
    const { promise, resolve, reject } = Promise.withResolvers<AgentToolResult<any>>();
    const pending: PendingRequest = {
      responseReceived: false,
      cancelSent: false,
      onStderrLine: options.onStderrLine,
      resolve,
      reject,
    };
    worker.pending.set(id, pending);
    const onAbort = () => this.cancel(worker, id, pending, cancellationError(options.signal!));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutHandle =
      options.timeout === undefined
        ? undefined
        : setTimeout(
            () => this.cancel(worker, id, pending, new Error(`timeout:${options.timeout}`)),
            options.timeout * 1000,
          );
    const request: ToolRequest = {
      toolCallId: options.toolCallId,
      params,
      session: options.session,
      executorData: options.executor.data,
      cwd: options.cwd,
    };
    this.write(worker, { id, tool: toolName, request });
    if (options.signal?.aborted) onAbort();
    try {
      return await promise;
    } finally {
      clearTimeout(timeoutHandle);
      clearTimeout(pending.cancelTimer);
      options.signal?.removeEventListener("abort", onAbort);
      worker.pending.delete(id);
      this.finishRetirement(worker);
    }
  }

  shutdown(): void {
    for (const worker of this.workers.values()) {
      worker.retiring = true;
      this.stop(worker);
    }
    this.workers.clear();
  }

  /** Command line of one worker process; tests replace this to skip bwrap. */
  launchCommand(entrypoint: string, sandboxArgs: string[]): { command: string; args: string[] } {
    return this.sandboxed()
      ? { command: "bwrap", args: [...sandboxArgs, "bun", entrypoint, "--worker"] }
      : { command: "bun", args: [entrypoint, "--worker"] };
  }

  private acquireWorker(mode: SandboxMode, entrypoint: string): Worker {
    const sandboxArgs = this.sandboxed() ? this.buildArgs(mode) : [];
    const key = JSON.stringify({ entrypoint, sandboxArgs });
    const current = this.workers.get(mode);
    if (current && this.isReusable(current, key)) return current;
    if (current) this.retire(current);
    const worker = this.spawnWorker(mode, key, entrypoint, sandboxArgs);
    this.workers.set(mode, worker);
    return worker;
  }

  private isReusable(worker: Worker, key: string): boolean {
    return (
      !worker.exited && !worker.retiring && worker.key === key && isProcessAlive(worker.child.pid)
    );
  }

  private spawnWorker(
    mode: SandboxMode,
    key: string,
    entrypoint: string,
    sandboxArgs: string[],
  ): Worker {
    const { command, args } = this.launchCommand(entrypoint, sandboxArgs);
    const child = spawn(command, args, {
      cwd: this.cwd,
      env: sanitizeSandboxEnvironment({
        ...process.env,
        GUARDRAIL_PI_PACKAGE_DIR: getPackageDir(),
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const worker: Worker = {
      mode,
      key,
      child,
      lines: createInterface({ input: child.stdout!, crlfDelay: Infinity, terminal: false }),
      pending: new Map(),
      retiring: false,
      stopped: false,
      exited: false,
      settled: false,
      stderrTail: Buffer.alloc(0),
      exitCode: null,
      exitSignal: null,
    };
    child.stdin?.on("error", (error) => {
      worker.failure ??= new Error(`Worker input failed: ${error.message}`);
      this.settleExit(worker);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      worker.stderrTail = Buffer.concat([worker.stderrTail, chunk]).subarray(-STDERR_TAIL_BYTES);
    });
    worker.lines.on("line", (line) => this.receive(worker, line));
    child.once("error", (error) => {
      worker.spawnError = error;
    });
    child.once("exit", (code, signal) => {
      worker.exited = true;
      worker.exitCode = code;
      worker.exitSignal = signal;
      worker.exitTimer = setTimeout(() => this.settleExit(worker), EXIT_GRACE_MS);
    });
    child.once("close", () => this.settleExit(worker));
    return worker;
  }

  private write(worker: Worker, message: ExtensionToWorkerMessage): void {
    worker.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private receive(worker: Worker, line: string): void {
    if (worker.settled) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.terminate(worker, `sent a non-JSON line: ${JSON.stringify(line.slice(0, 200))}`);
      return;
    }
    if (!isRecord(message) || typeof message.id !== "number") {
      this.terminate(worker, "sent a message without a numeric id");
      return;
    }
    const pending = worker.pending.get(message.id);
    if (pending === undefined || pending.responseReceived) return;
    if (typeof message.stderr === "string") {
      pending.onStderrLine?.(message.stderr);
      return;
    }
    if (message.ok === true && isToolResult(message.result)) {
      this.respond(pending, { result: message.result });
      return;
    }
    if (message.ok === false && typeof message.error === "string") {
      this.respond(pending, { error: new Error(message.error) });
      return;
    }
    this.terminate(worker, `sent an invalid response for request ${message.id}`);
  }

  private respond(
    pending: PendingRequest,
    outcome: { result: AgentToolResult<any> } | { error: Error },
  ): void {
    pending.responseReceived = true;
    clearTimeout(pending.cancelTimer);
    const rejection = pending.cancelReason ?? ("error" in outcome ? outcome.error : undefined);
    if (rejection) pending.reject(rejection);
    else pending.resolve((outcome as { result: AgentToolResult<any> }).result);
  }

  private cancel(worker: Worker, id: number, pending: PendingRequest, reason: Error): void {
    if (pending.responseReceived || worker.settled) return;
    pending.cancelReason ??= reason;
    if (pending.cancelSent) return;
    pending.cancelSent = true;
    this.write(worker, { id, cancel: true });
    pending.cancelTimer = setTimeout(() => {
      if (pending.responseReceived || worker.settled) return;
      this.terminate(worker, `did not answer the cancellation of request ${id}`);
    }, CANCEL_GRACE_MS);
  }

  private retire(worker: Worker): void {
    worker.retiring = true;
    this.finishRetirement(worker);
  }

  private finishRetirement(worker: Worker): void {
    if (worker.retiring && worker.pending.size === 0) this.stop(worker);
  }

  private stop(worker: Worker): void {
    if (worker.stopped || worker.settled) return;
    worker.stopped = true;
    worker.child.stdin?.end();
    worker.stopTimer = setTimeout(() => {
      if (!worker.settled) worker.child.kill("SIGKILL");
    }, EXIT_GRACE_MS);
  }

  private terminate(worker: Worker, detail: string): void {
    worker.failure ??= new Error(`Worker ${detail}`);
    worker.child.kill("SIGKILL");
  }

  private settleExit(worker: Worker): void {
    if (worker.settled) return;
    worker.settled = true;
    clearTimeout(worker.exitTimer);
    clearTimeout(worker.stopTimer);
    worker.lines.close();
    const failure = this.exitFailure(worker);
    for (const pending of worker.pending.values()) {
      if (pending.responseReceived) continue;
      pending.responseReceived = true;
      clearTimeout(pending.cancelTimer);
      pending.reject(pending.cancelReason ?? failure);
    }
    worker.pending.clear();
    if (this.workers.get(worker.mode) === worker) this.workers.delete(worker.mode);
  }

  private exitFailure(worker: Worker): Error {
    if (worker.spawnError) return new Error(`Worker failed to start: ${worker.spawnError.message}`);
    if (worker.failure) return worker.failure;
    const stderr = worker.stderrTail.toString("utf8").trim();
    const exit = worker.exitSignal
      ? `was killed by ${worker.exitSignal}`
      : `exited with code ${worker.exitCode ?? "unknown"}`;
    return new Error(stderr ? `Worker ${exit}: ${stderr}` : `Worker ${exit}`);
  }
}
