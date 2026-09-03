// Runs inside the sandboxed-tools bwrap sandbox: executes one pi-standard tool
// definition per invocation and prints the result as a JSON envelope on stdout.
//
// The pi package cannot be imported by its bare specifier here (no jiti
// virtualModules outside the pi process), so the extension passes the pi
// package directory via SANDBOXED_TOOLS_PI_PACKAGE_DIR and we import its entry
// dynamically. Type-only imports are erased at runtime and stay safe.
import { readFileSync } from "node:fs";
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

export async function executeToolRequest(
  toolName: string,
  request: ToolRequest,
): Promise<AgentToolResult<any>> {
  const pi = await importPiTools();
  const cwd = process.cwd();
  const definitions: Record<ToolName, () => ToolDefinition<any, any, any>> = {
    read: () => pi.createReadToolDefinition(cwd),
    write: () => pi.createWriteToolDefinition(cwd),
    edit: () => pi.createEditToolDefinition(cwd),
    grep: () => pi.createGrepToolDefinition(cwd),
    find: () => pi.createFindToolDefinition(cwd),
    ls: () => pi.createLsToolDefinition(cwd),
    bash: () => pi.createBashToolDefinition(cwd),
  };
  const createDefinition = definitions[toolName as ToolName];
  if (!createDefinition) throw new Error(`Unknown tool: ${toolName}`);
  const context = toolName === "bash" ? buildBashContext(request.session) : undefined;
  return createDefinition().execute(
    request.toolCallId ?? "cli",
    request.params,
    undefined,
    undefined,
    context as never,
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
