// Runs inside the sandboxed-tools bwrap sandbox: executes one pi-standard tool
// definition per invocation and prints the result as a JSON envelope on stdout.
//
// The pi package cannot be imported by its bare specifier here (no jiti
// virtualModules outside the pi process), so the extension passes the pi
// package directory via SANDBOXED_TOOLS_PI_PACKAGE_DIR and we import its entry
// dynamically. Type-only imports are erased at runtime and stay safe.
import { readFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";

type ToolName = "read" | "write" | "edit" | "grep" | "find" | "ls" | "bash";

/** Session metadata used only by the bash definition to expose PI_* env vars. */
export type ToolSession = {
  sessionId?: string;
  sessionFile?: string;
  provider?: string;
  modelId?: string;
  reasoningLevel?: string;
};

export type ToolRequest = {
  toolCallId?: string;
  params: unknown;
  session?: ToolSession;
};

async function importPiTools(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
  const packageDir = process.env.SANDBOXED_TOOLS_PI_PACKAGE_DIR;
  if (!packageDir) throw new Error("SANDBOXED_TOOLS_PI_PACKAGE_DIR is not set");
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
 * Loopback receiver that streams the bash command's stderr to this process's
 * stderr, line by line (SPEC §7 progress display).
 *
 * The receiver is wired through the pi bash definition's commandPrefix: the
 * prefix opens a /dev/tcp connection to this server as fd 8 and re-routes the
 * command's fd 2 through `tee >(cat >&8) >&2`. tee feeds BOTH pi's own stderr
 * capture (so the final result envelope is unchanged) and `cat >&8`, which
 * streams a copy to this server. Received lines are written to process.stderr
 * as raw bytes; the extension reads them and forwards each line to onUpdate.
 * When the shell cannot connect (non-bash shell, no loopback networking) the
 * prefix skips the tee entirely and behavior is unchanged.
 */
export function startStderrTeeReceiver(): Promise<{
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
      // Buffer raw bytes and write only complete lines, so multibyte UTF-8
      // split across TCP chunks never decodes mid-sequence.
      let pending = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        for (
          let newlineAt = pending.indexOf(0x0a);
          newlineAt !== -1;
          newlineAt = pending.indexOf(0x0a)
        ) {
          process.stderr.write(pending.subarray(0, newlineAt + 1));
          pending = pending.subarray(newlineAt + 1);
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

export async function executeToolRequest(
  toolName: string,
  request: ToolRequest,
): Promise<AgentToolResult<any>> {
  const pi = await importPiTools();
  const cwd = process.cwd();
  if (toolName === "bash") {
    const context = buildBashContext(request.session);
    // Receiver startup failure falls back to the plain definition: the command
    // still runs and its stderr still reaches the final result envelope.
    const tee = await startStderrTeeReceiver().catch(() => undefined);
    try {
      const definition = pi.createBashToolDefinition(
        cwd,
        tee === undefined ? undefined : { commandPrefix: tee.commandPrefix },
      );
      return await definition.execute(
        request.toolCallId ?? "cli",
        request.params,
        undefined,
        undefined,
        context as never,
      );
    } finally {
      await tee?.close();
    }
  }
  const definitions: Record<Exclude<ToolName, "bash">, () => ToolDefinition<any, any, any>> = {
    read: () => pi.createReadToolDefinition(cwd),
    write: () => pi.createWriteToolDefinition(cwd),
    edit: () => pi.createEditToolDefinition(cwd),
    grep: () => pi.createGrepToolDefinition(cwd),
    find: () => pi.createFindToolDefinition(cwd),
    ls: () => pi.createLsToolDefinition(cwd),
  };
  const createDefinition = definitions[toolName as Exclude<ToolName, "bash">];
  if (!createDefinition) throw new Error(`Unknown tool: ${toolName}`);
  return createDefinition().execute(
    request.toolCallId ?? "cli",
    request.params,
    undefined,
    undefined,
    undefined,
  );
}

if (import.meta.main) {
  const toolName = process.argv[2] ?? "";
  try {
    const request = JSON.parse(readFileSync(0, "utf8")) as ToolRequest;
    const result = await executeToolRequest(toolName, request);
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(JSON.stringify({ ok: false, error: message }));
    process.exit(1);
  }
}
