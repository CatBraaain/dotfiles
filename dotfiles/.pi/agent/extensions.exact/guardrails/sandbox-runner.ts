import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmdirSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getPackageDir, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { type ExecutorDescriptor } from "./config.ts";
import type { SandboxMode } from "./sandbox.ts";
import type { WorkerPool } from "./worker-pool.ts";

export type ScopedExecution = {
  executable: string;
  cwd: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  allowedCodes: readonly number[];
  write?: {
    paths: readonly string[];
    directories: readonly string[];
    unlinkSymlinks?: readonly string[];
    readOnlyFile?: { path: string; contents: string };
    readOnlyView?: { directory: string; paths: readonly string[] };
    createDirectories?: readonly string[];
    validate(): void;
  };
};

type RunOptions = {
  input?: string;
  signal?: AbortSignal;
  timeout: number;
  maxOutputBytes: number;
  sandbox: { args: string[]; mountFds: number[] };
};

type RunResult = { exitCode: number | null; stdout: Buffer; stderr: Buffer };

type BuildArgs = (mode: SandboxMode, commandCwd?: string, readOnly?: boolean) => string[];

const SCOPED_TIMEOUT_SECONDS = 60;
const SCOPED_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

function scopedShellCommand(argv: readonly string[], env: NodeJS.ProcessEnv): string {
  function shellArg(value: string): string {
    return "'" + value.replaceAll("'", "'\\''") + "'";
  }
  const environment = Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}=${value}`);
  const command = ["env", "-i", ...environment, ...argv].map(shellArg).join(" ");
  return [
    "exec 3>&1",
    `scoped_error=$(MSYS2_ARG_CONV_EXCL='*' ${command} 2>&1 >&3)`,
    "scoped_status=$?",
    'if [ -n "$scoped_error" ]; then printf "%s\\n" "$scoped_error" >&2; exit 125; fi',
    'exit "$scoped_status"',
  ].join("\n");
}

function validateMountDirectory(path: string): void {
  if (
    !isAbsolute(path) ||
    path !== resolve(path) ||
    path === dirname(path) ||
    !lstatSync(path).isDirectory() ||
    realpathSync.native(path) !== path
  )
    throw new Error(`Invalid scoped execution directory: ${path}`);
}

export class SandboxRunner {
  constructor(
    private readonly cwd: string,
    private readonly buildArgs: BuildArgs,
    private readonly pool: WorkerPool,
  ) {}

  private sandboxed(): boolean {
    return this.pool.sandboxed();
  }

  async runScopedExecution(
    call: ScopedExecution,
    protectedPaths: readonly string[],
    signal: AbortSignal,
    executor: ExecutorDescriptor,
  ): Promise<AgentToolResult<unknown>> {
    const { executable, args, cwd, env, write, allowedCodes } = call;
    if (!this.sandboxed()) {
      write?.validate();
      const result = await this.pool.runTool(
        "bash",
        {
          command: scopedShellCommand([executable, ...args], env),
          timeout: SCOPED_TIMEOUT_SECONDS,
        },
        { mode: "bash", cwd, signal, executor, timeout: SCOPED_TIMEOUT_SECONDS },
      );
      const output = result.structuredContent as {
        output?: string;
        truncated?: boolean;
        exit_code?: number;
      };
      if (
        !output ||
        typeof output.output !== "string" ||
        output.output.includes("\uFFFD") ||
        output.truncated !== false ||
        typeof output.exit_code !== "number"
      )
        throw new Error("Invalid or truncated scoped execution result");
      if (
        output.exit_code !== 0 &&
        (!allowedCodes.includes(output.exit_code) || output.output !== "")
      )
        throw new Error(output.output.trim() || `Scoped command failed (exit ${output.exit_code})`);
      return { content: [], details: { output: output.exit_code === 0 ? output.output : "" } };
    }

    const mounts: number[] = [];
    const created = new Map<string, { dev: bigint; ino: bigint }>();
    const sandboxArgs = write
      ? ["--die-with-parent", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev"]
      : [...this.buildArgs("bash", cwd, true)];
    sandboxArgs.push("--unshare-pid", "--unshare-net", "--clearenv");
    for (const [name, value] of Object.entries(env))
      if (value !== undefined) sandboxArgs.push("--setenv", name, value);
    let outcome: AgentToolResult<unknown>;
    let cleanupFailure: { cause: unknown } | undefined;
    try {
      if (write) {
        write.validate();
        for (const path of write.createDirectories ?? []) {
          if (!isAbsolute(path) || path !== resolve(path) || !write.paths.includes(path))
            throw new Error(`Unvalidated scoped creation directory: ${path}`);
          validateMountDirectory(dirname(path));
          mkdirSync(path);
          created.set(path, lstatSync(path, { bigint: true }));
        }
        const directories = [...new Set(write.directories)].sort((a, b) => a.length - b.length);
        const view = write.readOnlyView;
        if (view) {
          validateMountDirectory(view.directory);
          sandboxArgs.push("--tmpfs", view.directory);
          for (const path of view.paths) sandboxArgs.push("--ro-bind-try", path, path);
        }
        for (const path of directories) {
          validateMountDirectory(path);
          const fd = openSync(
            path,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          mounts.push(fd);
          sandboxArgs.push("--bind-fd", String(mounts.length + 2), path);
        }
        for (const path of protectedPaths) sandboxArgs.push("--ro-bind", path, path);
        if (write.readOnlyFile) sandboxArgs.push("--ro-bind-data", "0", write.readOnlyFile.path);
        if (view) sandboxArgs.push("--remount-ro", view.directory);
        write.validate();
        for (const [index, path] of directories.entries()) {
          const opened = fstatSync(mounts[index]!, { bigint: true });
          const current = lstatSync(path, { bigint: true });
          if (!current.isDirectory() || current.dev !== opened.dev || current.ino !== opened.ino)
            throw new Error(`Scoped execution mount changed: ${path}`);
        }
      }
      if (write) sandboxArgs.push("--chdir", cwd);
      sandboxArgs.push("--");
      const result = await this.run(executable, [...args], {
        ...(write?.readOnlyFile ? { input: write.readOnlyFile.contents } : {}),
        sandbox: { args: sandboxArgs, mountFds: mounts },
        timeout: SCOPED_TIMEOUT_SECONDS,
        maxOutputBytes: SCOPED_OUTPUT_LIMIT_BYTES,
        signal,
      });
      const decode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const stderr = decode.decode(result.stderr).trim();
      if (
        result.exitCode === null ||
        (!allowedCodes.includes(result.exitCode) && result.exitCode !== 0)
      )
        throw new Error(stderr || `Scoped command failed (exit ${result.exitCode})`);
      if (stderr) throw new Error(`Scoped command wrote to stderr: ${stderr}`);
      outcome = {
        content: [],
        details: { output: result.exitCode === 0 ? decode.decode(result.stdout) : "" },
      };
    } finally {
      for (const fd of mounts) closeSync(fd);
      for (const [path, initial] of [...created].reverse()) {
        try {
          const current = lstatSync(path, { bigint: true });
          if (current.isDirectory() && current.dev === initial.dev && current.ino === initial.ino)
            rmdirSync(path);
        } catch (error) {
          if (
            !["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")
          )
            cleanupFailure ??= { cause: error };
        }
      }
    }
    if (cleanupFailure) throw new Error("Scoped directory cleanup failed", cleanupFailure);
    return outcome;
  }

  private run(command: string, commandArgs: string[], options: RunOptions): Promise<RunResult> {
    return new Promise((resolveRun, rejectRun) => {
      options.signal?.throwIfAborted();
      const child = spawn("bwrap", [...options.sandbox.args, command, ...commandArgs], {
        cwd: this.cwd,
        env: {
          ...process.env,
          GUARDRAIL_PI_PACKAGE_DIR: getPackageDir(),
        },
        stdio: [
          options.input === undefined ? "ignore" : "pipe",
          "pipe",
          "pipe",
          ...options.sandbox.mountFds,
        ],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let outputExceeded = false;
      let timedOut = false;
      let processError: Error | undefined;
      let inputError: Error | undefined;
      const onAbort = () => child.kill("SIGKILL");
      child.stdin?.on("error", (error: Error) => {
        inputError = error;
      });
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeout * 1000);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      function collect(buffers: Buffer[], chunk: Buffer): void {
        outputBytes += chunk.length;
        if (outputBytes > options.maxOutputBytes) {
          if (!outputExceeded) child.kill("SIGKILL");
          outputExceeded = true;
        } else buffers.push(chunk);
      }
      child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.on("error", (error: Error) => {
        processError = error;
      });
      child.on("close", (exitCode) => {
        clearTimeout(timeoutHandle);
        options.signal?.removeEventListener("abort", onAbort);
        if (processError) return rejectRun(processError);
        if (outputExceeded) return rejectRun(new Error("Scoped command output exceeds the limit"));
        if (inputError)
          return rejectRun(new Error("Scoped command input failed", { cause: inputError }));
        if (options.signal?.aborted) return rejectRun(new Error("aborted"));
        if (timedOut) return rejectRun(new Error(`timeout:${options.timeout}`));
        resolveRun({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
      if (options.input !== undefined) child.stdin?.end(options.input);
      if (options.signal?.aborted) onAbort();
    });
  }
}
