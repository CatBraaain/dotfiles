// Runs as the resident Tools worker (`bun run-tools.ts --worker`): reads JSON
// Lines requests from stdin and writes response envelopes to stdout.
//
// The pi package cannot be imported by its bare specifier here (no jiti
// virtualModules outside the pi process), so the extension passes the pi
// package directory via GUARDRAIL_PI_PACKAGE_DIR and we import its entry
// dynamically. Type-only imports are erased at runtime and stay safe.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type {
  AgentToolResult,
  BashToolInput,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  ToolName,
  ToolRequest,
  ToolSession,
  WorkerRequestMessage,
  WorkerToExtensionMessage,
} from "../guardrails/config.ts";
import { executeRead } from "./read.ts";

type PiTools = typeof import("@earendil-works/pi-coding-agent");
type ToolError = string;

const TOOL_NAMES: readonly ToolName[] = ["read", "write", "edit", "grep", "find", "ls", "bash"];
const NAMESPACE_PROBE_TIMEOUT_MS = 5000;
const SHUTDOWN_GRACE_MS = 2000;

let piTools: Promise<PiTools> | undefined;

function importPiTools(): Promise<PiTools> {
  return (piTools ??= loadPiTools());
}

async function loadPiTools(): Promise<PiTools> {
  const packageDir = process.env.GUARDRAIL_PI_PACKAGE_DIR;
  if (!packageDir) throw new Error("GUARDRAIL_PI_PACKAGE_DIR is not set");
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    main?: string;
  };
  const entryPath = join(packageDir, manifest.main ?? "dist/index.js");
  return import(pathToFileURL(entryPath).href) as Promise<
    typeof import("@earendil-works/pi-coding-agent")
  >;
}

// Only the bash definition reads the context (PI_* env vars); other definitions
// must receive undefined because a partial fake model would break them.
function buildBashContext(session: ToolSession | undefined) {
  if (!session) return undefined;
  return {
    sessionManager: {
      getSessionId: () => session.sessionId ?? "",
      getSessionFile: () => session.sessionFile,
    },
    model: session.provider ? { provider: session.provider, id: session.modelId } : undefined,
    thinkingLevel: session.reasoningLevel,
  };
}

/** How long close() waits for the tee connection to finish before force-closing. */
const STDERR_TEE_DRAIN_MS = 100;

/**
 * Loopback receiver that streams the bash command's stderr line by line
 * to `onLine` (SPEC §7 progress display).
 *
 * The receiver is wired through the pi bash definition's shell command: the
 * prefix opens a /dev/tcp connection to this server as fd 8 and re-routes the
 * command's fd 2 through `tee >(cat >&8) >&2`. tee feeds BOTH pi's own stderr
 * capture (so the final result envelope is unchanged) and `cat >&8`, which
 * streams a copy to this server. Received lines are handed to `onLine` as
 * complete lines without the newline; empty lines are skipped. When the shell
 * cannot connect (non-bash shell, no loopback networking) the prefix skips the
 * tee entirely and behavior is unchanged.
 */
export function startStderrTeeReceiver(onLine: (line: string) => void): Promise<{
  commandPrefix: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolveReady, rejectReady) => {
    let connection: Socket | undefined;
    // Resolves once the accepted connection has fully closed.
    let connectionClosed: Promise<void> = Promise.resolve();
    const server = createServer((socket) => {
      if (connection !== undefined) {
        socket.destroy();
        return;
      }
      connection = socket;
      // A socket error (e.g. RST) must not crash this process: the progress
      // display silently stops while the envelope stays intact, so ignore it.
      socket.on("error", () => {});
      connectionClosed = new Promise((resolveClosed) => socket.once("close", resolveClosed));
      // Buffer raw bytes and emit only complete lines, so multibyte UTF-8
      // split across TCP chunks never decodes mid-sequence.
      let pending = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        for (
          let newlineAt = pending.indexOf(0x0a);
          newlineAt !== -1;
          newlineAt = pending.indexOf(0x0a)
        ) {
          const line = pending.subarray(0, newlineAt).toString("utf8").replace(/\r$/, "");
          pending = pending.subarray(newlineAt + 1);
          if (line !== "") onLine(line);
        }
      });
    });
    server.once("error", rejectReady);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close();
        rejectReady(new Error("stderr tee receiver has no port"));
        return;
      }
      resolveReady({
        commandPrefix: [
          `if [ -n "$BASH_VERSION" ] && { exec 8>/dev/tcp/127.0.0.1/${address.port}; } 2>/dev/null; then`,
          "  eval 'exec 2> >(tee >(cat >&8) >&2)'",
          "fi",
        ].join("\n"),
        close: async () => {
          // Wait for the connection to finish (the tee's cat closes fd 8
          // after the command's stderr reaches EOF) so the last in-flight
          // lines are received instead of destroyed; bounded so a stuck
          // connection cannot outlive the JSON envelope on stdout.
          let drainTimer: ReturnType<typeof setTimeout> | undefined;
          const drainDeadline = new Promise<void>((resolveDeadline) => {
            drainTimer = setTimeout(resolveDeadline, STDERR_TEE_DRAIN_MS);
          });
          await Promise.race([connectionClosed, drainDeadline]);
          clearTimeout(drainTimer);
          connection?.destroy();
          await new Promise<void>((resolveServerClose) => server.close(() => resolveServerClose()));
        },
      });
    });
  });
}

let namespaceProbed = false;
let namespaceFailure: ToolError | undefined;

/**
 * Linux runs every bash request inside its own nested user and PID namespace,
 * so processes that escape the shell's process group (`setsid`, daemons) die
 * with the request. Returns the reason when that isolation is unavailable.
 */
function namespaceSupportFailure(): ToolError | undefined {
  if (!namespaceProbed) {
    namespaceProbed = true;
    namespaceFailure = probeNamespaceSupport();
  }
  return namespaceFailure;
}

function probeNamespaceSupport(): ToolError | undefined {
  if (process.platform !== "linux") return undefined;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return "cannot determine the worker uid or gid";
  const probe = spawnSync(
    "unshare",
    [
      "--user",
      `--map-user=${uid}`,
      `--map-group=${gid}`,
      "--mount",
      "--pid",
      "--fork",
      "--mount-proc",
      "true",
    ],
    { encoding: "utf8", timeout: NAMESPACE_PROBE_TIMEOUT_MS },
  );
  if (probe.error) return `unshare is unavailable: ${probe.error.message}`;
  if (probe.status !== 0)
    return `unshare cannot create user and PID namespaces: ${probe.stderr.trim() || `exit ${probe.status}`}`;
  return undefined;
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Places the command in its own namespaces on Linux and prepends the tee prefix. */
function wrapCommand(pi: PiTools, command: string, commandPrefix: string | undefined): string {
  if (process.platform !== "linux")
    return commandPrefix === undefined ? command : `${commandPrefix}\n${command}`;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const shell = shellQuote(pi.getShellConfig().shell);
  const namespaced = `exec unshare --user --map-user=${uid} --map-group=${gid} --mount --pid --fork --mount-proc ${shell} -c ${shellQuote(command)}`;
  return commandPrefix === undefined ? namespaced : `${commandPrefix}\n${namespaced}`;
}

const FS_DEFINITIONS: Record<
  Exclude<ToolName, "read" | "bash">,
  (pi: PiTools, cwd: string) => ToolDefinition<any, any, any>
> = {
  write: (pi, cwd) => pi.createWriteToolDefinition(cwd),
  edit: (pi, cwd) => pi.createEditToolDefinition(cwd),
  grep: (pi, cwd) => pi.createGrepToolDefinition(cwd),
  find: (pi, cwd) => pi.createFindToolDefinition(cwd),
  ls: (pi, cwd) => pi.createLsToolDefinition(cwd),
};

export async function executeToolRequest(
  tool: ToolName,
  request: ToolRequest,
  signal: AbortSignal,
  onStderrLine: (line: string) => void = () => {},
): Promise<AgentToolResult<any>> {
  signal.throwIfAborted();
  const pi = await importPiTools();
  const cwd = request.cwd ?? process.cwd();
  if (tool === "read") return executeRead(request, pi, cwd, signal);
  if (tool === "bash") return executeBash(pi, request, cwd, signal, onStderrLine);
  return FS_DEFINITIONS[tool](pi, cwd).execute(
    request.toolCallId ?? "cli",
    request.params,
    signal,
    undefined,
    // Only the bash definition reads the context (see buildBashContext); the
    // other definitions never touch it, so the required parameter stays
    // undefined at runtime.
    undefined as never,
  );
}

async function executeBash(
  pi: PiTools,
  request: ToolRequest,
  cwd: string,
  signal: AbortSignal,
  onStderrLine: (line: string) => void,
): Promise<AgentToolResult<any>> {
  const failure = namespaceSupportFailure();
  if (failure) throw new Error(`Bash requires per-request process isolation: ${failure}`);
  // Receiver startup failure falls back to the plain definition: the command
  // still runs and its stderr still reaches the final result envelope.
  const tee = await startStderrTeeReceiver(onStderrLine).catch(() => undefined);
  try {
    const definition = pi.createBashToolDefinition(cwd, {
      spawnHook: ({ command, cwd: hookCwd, env }) => ({
        command: wrapCommand(pi, command, tee?.commandPrefix),
        cwd: hookCwd,
        env,
      }),
    });
    return await definition.execute(
      request.toolCallId ?? "cli",
      // JSON boundary: the bash definition validates its own params at runtime.
      request.params as BashToolInput,
      signal,
      undefined,
      buildBashContext(request.session) as never,
    );
  } finally {
    await tee?.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && (TOOL_NAMES as readonly string[]).includes(value);
}

function requestError(request: unknown): ToolError | undefined {
  if (!isRecord(request) || !isRecord(request.params)) return "Invalid tool request";
  if (request.toolCallId !== undefined && typeof request.toolCallId !== "string")
    return "Invalid tool call ID";
  if (request.cwd !== undefined && (typeof request.cwd !== "string" || !isAbsolute(request.cwd)))
    return "Invalid tool request cwd";
  if (request.executorData !== undefined && !isRecord(request.executorData))
    return "Invalid executor data";
  if (request.session === undefined) return undefined;
  if (!isRecord(request.session)) return "Invalid tool session";
  for (const key of ["sessionId", "sessionFile", "provider", "modelId", "reasoningLevel"]) {
    if (key in request.session && typeof request.session[key] !== "string")
      return `Invalid tool session field: ${key}`;
  }
  return undefined;
}

type ParsedMessage =
  | { id: number; cancel: true }
  | { id: number; tool: ToolName; request: ToolRequest }
  | { id?: number; error: ToolError };

function parseMessage(line: string): ParsedMessage {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch (error) {
    return { error: `Invalid worker message: ${errorMessage(error)}` };
  }
  if (!isRecord(message)) return { error: "Invalid worker message" };
  const { id, tool, request, cancel } = message;
  if (typeof id !== "number" || !Number.isInteger(id))
    return { error: "Invalid worker message id" };
  if (cancel === true) return { id, cancel: true };
  if (!isToolName(tool)) return { id, error: `Unknown tool: ${String(tool)}` };
  const error = requestError(request);
  if (error) return { id, error };
  return { id, tool, request: request as ToolRequest };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function send(message: WorkerToExtensionMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function runRequest(
  message: WorkerRequestMessage,
  active: Map<number, AbortController>,
): Promise<void> {
  const controller = new AbortController();
  active.set(message.id, controller);
  try {
    const result = await executeToolRequest(
      message.tool,
      message.request,
      controller.signal,
      (stderr) => send({ id: message.id, stderr }),
    );
    send({ id: message.id, ok: true, result });
  } catch (error) {
    send({ id: message.id, ok: false, error: errorMessage(error) });
  } finally {
    active.delete(message.id);
  }
}

async function runWorker(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  const active = new Map<number, AbortController>();
  const requests = new Set<Promise<void>>();
  for await (const line of lines) {
    const message = parseMessage(line);
    if ("error" in message) {
      if (message.id === undefined) process.stderr.write(`${message.error}\n`);
      else send({ id: message.id, ok: false, error: message.error });
      continue;
    }
    if ("cancel" in message) {
      active.get(message.id)?.abort();
      continue;
    }
    if (active.has(message.id)) {
      send({ id: message.id, ok: false, error: `Request id ${message.id} is already active` });
      continue;
    }
    const request = runRequest(message, active);
    requests.add(request);
    void request.finally(() => requests.delete(request));
  }
  for (const controller of active.values()) controller.abort();
  const pending = [...requests];
  if (pending.length === 0) return;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const graceExpired = new Promise<false>((resolveExpired) => {
    graceTimer = setTimeout(() => resolveExpired(false), SHUTDOWN_GRACE_MS);
  });
  const settled = await Promise.race([Promise.allSettled(pending).then(() => true), graceExpired]);
  clearTimeout(graceTimer);
  if (!settled) process.exit(1);
}

if (import.meta.main && process.argv[2] === "--worker") await runWorker();
