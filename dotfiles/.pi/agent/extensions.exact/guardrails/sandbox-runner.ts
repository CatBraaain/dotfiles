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
import { fileURLToPath } from "node:url";
import { getPackageDir, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { type ToolName, type ToolSession, sanitizeSandboxEnvironment } from "./config.ts";
import type { SandboxMode } from "./sandbox.ts";

type RunOptions = {
  input?: string | Buffer;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onData?: (data: Buffer, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
  timeout?: number;
  mode?: SandboxMode;
  cooperativeCancellation?: boolean;
  maxOutputBytes?: number;
  sandbox?: { args: string[]; mountFds: number[] };
};

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
    readonly buildArgs: (mode: SandboxMode, commandCwd?: string, readOnly?: boolean) => string[],
    readonly sandboxed: () => boolean = platformSandboxes,
  ) {}

  async runTool(
    toolName: ToolName,
    params: unknown,
    options: {
      mode: SandboxMode;
      cwd?: string;
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
        cwd: options.cwd,
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

  async runScopedExecution(
    call: ScopedExecution,
    protectedPaths: readonly string[],
    signal: AbortSignal,
  ): Promise<AgentToolResult<unknown>> {
    const { executable, args, cwd, env, write, allowedCodes } = call;
    if (!this.sandboxed()) {
      write?.validate();
      const result = await this.runTool(
        "bash",
        {
          command: scopedShellCommand([executable, ...args], env),
          timeout: 60,
        },
        { mode: "bash", cwd, signal },
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
      : this.buildArgs("bash", cwd, true);
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
        timeout: 60,
        maxOutputBytes: 8 * 1024 * 1024,
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
      const environment = sanitizeSandboxEnvironment({
        ...process.env,
        ...options.env,
      });
      const isolated = this.sandboxed();
      if (options.sandbox && !isolated) throw new Error("bwrap isolation is unavailable");
      const child = spawn(
        isolated ? "bwrap" : command,
        isolated
          ? [
              ...(options.sandbox?.args ?? this.buildArgs(options.mode ?? "fs")),
              command,
              ...commandArgs,
            ]
          : commandArgs,
        {
          cwd: options.cwd ?? this.cwd,
          env: environment,
          stdio: [
            options.input === undefined ? "ignore" : "pipe",
            "pipe",
            "pipe",
            ...(options.sandbox?.mountFds ?? []),
          ],
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      let outputBytes = 0;
      let outputExceeded = false;
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
      function collect(buffers: Buffer[], chunk: Buffer): void {
        outputBytes += chunk.length;
        if (options.maxOutputBytes !== undefined && outputBytes > options.maxOutputBytes) {
          if (!outputExceeded) stopExecution();
          outputExceeded = true;
        } else buffers.push(chunk);
      }
      child.stdout?.on("data", (chunk: Buffer) => {
        collect(stdout, chunk);
        options.onData?.(chunk, "stdout");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        collect(stderr, chunk);
        options.onData?.(chunk, "stderr");
      });
      child.on("error", (error: Error) => {
        processError = error;
      });
      child.on("close", (exitCode) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        options.signal?.removeEventListener("abort", onAbort);
        if (processError) return rejectRun(processError);
        if (outputExceeded) return rejectRun(new Error("Scoped command output exceeds the limit"));
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
