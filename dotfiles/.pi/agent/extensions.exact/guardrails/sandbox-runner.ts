import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  type ToolName,
  type ToolSession,
  pathCovers,
  sanitizeSandboxEnvironment,
} from "./config.ts";
import type { SandboxMode } from "./sandbox.ts";

type RunOptions = {
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  onData?: (data: Buffer, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
  timeout?: number;
  mode?: SandboxMode;
  cooperativeCancellation?: boolean;
  sandbox?: { args: string[]; mountFds: number[] };
};

export type WorktreeRemoval = {
  git: string;
  main: string;
  common: string;
  path: string;
  objectFormat: "sha1" | "sha256";
  refFormat: "files" | "reftable";
};

export function worktreeRemovalArgs({ main, common, path }: WorktreeRemoval): string[] {
  return [
    "-C",
    main,
    `--git-dir=${common}`,
    `--work-tree=${main}`,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "worktree",
    "remove",
    "--",
    path,
  ];
}

export function worktreeRemovalGit(): string {
  for (const path of ["/usr/bin/git", "/run/current-system/sw/bin/git"]) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("Worktree removal requires a system Git executable");
}

function worktreeRemovalSandbox(removal: WorktreeRemoval): string[] {
  const { common, git, main, path, refFormat } = removal;
  const args = [
    "--die-with-parent",
    "--unshare-pid",
    "--unshare-net",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--clearenv",
    "--setenv",
    "PATH",
    dirname(git),
    "--setenv",
    "LC_ALL",
    "C",
    "--setenv",
    "GIT_CONFIG_GLOBAL",
    "/dev/null",
    "--setenv",
    "GIT_CONFIG_SYSTEM",
    "/dev/null",
    "--setenv",
    "GIT_NO_LAZY_FETCH",
    "1",
    "--setenv",
    "GIT_ALLOW_PROTOCOL",
    "",
    "--setenv",
    "GIT_OPTIONAL_LOCKS",
    "0",
    "--setenv",
    "GIT_COMMON_DIR",
    common,
    "--tmpfs",
    common,
  ];
  const refs = refFormat === "reftable" ? ["reftable"] : ["refs", "packed-refs"];
  for (const entry of ["HEAD", "objects", "info", ...refs]) {
    const source = join(common, entry);
    args.push("--ro-bind-try", source, source);
  }
  return [
    ...args,
    "--ro-bind-data",
    "0",
    join(common, "config"),
    "--bind-fd",
    "4",
    join(common, "worktrees"),
    "--remount-ro",
    common,
    "--bind-fd",
    "3",
    dirname(path),
    "--chdir",
    main,
    "--",
  ];
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

  async runWorktreeRemoval(
    removal: WorktreeRemoval,
    validate: () => void,
    signal: AbortSignal,
  ): Promise<AgentToolResult<unknown>> {
    if (!this.sandboxed()) throw new Error("Worktree removal requires bwrap isolation");
    const parent = dirname(removal.path);
    const { git, objectFormat, refFormat } = removal;
    if (
      pathCovers(parent, removal.main) ||
      pathCovers(parent, removal.common) ||
      pathCovers(removal.common, parent) ||
      pathCovers(parent, git)
    )
      throw new Error(`Worktree removal mounts overlap: ${parent}`);
    const extensions = [
      ...(objectFormat === "sha256" ? ["objectFormat = sha256"] : []),
      ...(refFormat === "reftable" ? ["refStorage = reftable"] : []),
    ];
    const config = [
      "[core]",
      `repositoryformatversion = ${extensions.length > 0 ? 1 : 0}`,
      ...(extensions.length > 0 ? ["[extensions]", ...extensions] : []),
      "",
    ].join("\n");
    const sandboxArgs = worktreeRemovalSandbox(removal);
    const mountFds: number[] = [];
    const mountPaths = [parent, join(removal.common, "worktrees")];
    try {
      for (const path of mountPaths)
        mountFds.push(
          openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
        );
      validate();
      for (const [index, path] of mountPaths.entries()) {
        const opened = fstatSync(mountFds[index]!, { bigint: true });
        const current = lstatSync(path, { bigint: true });
        if (!current.isDirectory() || current.dev !== opened.dev || current.ino !== opened.ino)
          throw new Error(`Worktree removal mount changed: ${path}`);
      }
      const result = await this.run(git, worktreeRemovalArgs(removal), {
        input: config,
        signal,
        timeout: 60,
        sandbox: { args: sandboxArgs, mountFds },
      });
      const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8").trim();
      if (result.exitCode !== 0)
        throw new Error(output || `Git worktree removal failed (exit ${result.exitCode})`);
      return {
        content: [{ type: "text", text: output || `Removed ${removal.path}` }],
        details: { exitCode: result.exitCode },
      };
    } finally {
      for (const fd of mountFds) closeSync(fd);
    }
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
          cwd: this.cwd,
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
