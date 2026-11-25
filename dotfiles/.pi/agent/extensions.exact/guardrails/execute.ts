import { resolve } from "node:path";
import type {
  AgentToolResult,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Guardrail, writeApprovalNote, type PathApproval, type ToolContext } from "./guardrail.ts";
import { SandboxRunner, type ExecutorDescriptor } from "./sandbox-runner.ts";
import { withNormalizedPath } from "./normalize-path.ts";
import type { ToolName, ToolSession } from "./config.ts";

export async function executeGuardedTool(
  guardrail: Guardrail,
  runner: SandboxRunner,
  cwd: string,
  request: GuardedToolRequest,
): Promise<AgentToolResult<unknown>> {
  request.signal?.throwIfAborted();
  const { toolName, signal, context, onUpdate } = request;
  if (!SUPPORTED_TOOLS.has(toolName)) throw new Error(`Unsupported guarded tool: ${toolName}`);
  const normalized = withNormalizedPath(request.params);
  const params = (
    toolName === "bash"
      ? normalized
      : { ...normalized, path: resolve(cwd, (normalized.path as string | undefined) ?? ".") }
  ) as Record<string, unknown>;
  let approval: PathApproval | undefined;
  let commandApproved = false;
  if (toolName === "bash") {
    commandApproved = await guardrail.authorizeCommand(params.command as string, context);
  } else {
    const path = params.path as string;
    if (toolName !== "write")
      await guardrail.authorizePath(
        "read",
        path,
        context,
        toolName === "read" && process.platform === "win32" ? signal : undefined,
      );
    if (toolName === "write" || toolName === "edit") {
      approval = await guardrail.authorizePath("write", path, context);
    }
  }
  signal?.throwIfAborted();
  if (toolName === "read" && process.platform === "win32") {
    return runner.runWindowsRead(params, {
      authorize: async (path, authorizationSignal) => {
        await guardrail.authorizePath("read", path, context, authorizationSignal);
      },
      executor: request.executor,
      signal,
    });
  }
  if (toolName === "read" && process.platform === "linux" && !runner.sandboxed())
    throw new Error("Read requires fs sandbox isolation");
  const result = await runner.runTool(toolName as ToolName, params, {
    mode: toolName === "bash" ? "bash" : "fs",
    executor: request.executor,
    signal,
    session: toolName === "bash" ? sessionFromContext(context) : undefined,
    onData: toolName === "bash" && onUpdate ? stderrLineUpdater(onUpdate) : undefined,
  });
  const notes: string[] = [];
  if (toolName === "bash") {
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    if (text.includes("Read-only file system")) notes.push(EROFS_HINT);
    if (commandApproved) notes.push(COMMAND_APPROVAL_NOTE);
  }
  if (approval) notes.push(writeApprovalNote(approval));
  if (notes.length === 0) return result;
  return {
    ...result,
    content: [...result.content, ...notes.map((text) => ({ type: "text" as const, text }))],
  };
}

export type GuardedToolContext = Pick<ExtensionContext, "hasUI" | "model" | "thinkingLevel"> & {
  ui?: ToolContext["ui"];
  executeTool?: ExtensionToolContext["executeTool"];
  sessionManager?: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getSessionFile">;
};

export type GuardedToolRequest = {
  id: string;
  toolName: string;
  params: Record<string, unknown>;
  executor?: ExecutorDescriptor;
  signal?: AbortSignal;
  onUpdate?: (result: AgentToolResult<unknown>) => void;
  context: GuardedToolContext;
};

const SUPPORTED_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls", "bash"]);
const COMMAND_APPROVAL_NOTE = "User approved this command via confirmation.";
const EROFS_HINT =
  "Sandbox blocked this write. Do not rewrite the command and retry with bash. Request access with ask_permission only when the target's effective write action is ask or unset and it is not a credentials path; explicit deny cannot be granted. Approval updates Guardrails write permissions for the approved scope for all tools using those permissions; explicit deny and credentials remain protected.";

function sessionFromContext(context: GuardedToolContext): ToolSession {
  return {
    sessionId: context?.sessionManager?.getSessionId?.(),
    sessionFile: context?.sessionManager?.getSessionFile?.(),
    provider: context?.model?.provider,
    modelId: context?.model?.id,
    reasoningLevel: context?.thinkingLevel,
  };
}

function stderrLineUpdater(
  onUpdate: (partialResult: AgentToolResult<any>) => void,
): (data: Buffer, stream: "stdout" | "stderr") => void {
  let pending = Buffer.alloc(0);
  return (data, stream) => {
    if (stream !== "stderr") return;
    pending = Buffer.concat([pending, data]);
    for (
      let newlineAt = pending.indexOf(0x0a);
      newlineAt !== -1;
      newlineAt = pending.indexOf(0x0a)
    ) {
      const line = pending.subarray(0, newlineAt).toString("utf8").replace(/\r$/, "");
      pending = pending.subarray(newlineAt + 1);
      if (line !== "") onUpdate({ content: [{ type: "text", text: line }], details: {} });
    }
  };
}
