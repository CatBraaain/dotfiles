import { quote } from "shell-quote";
import { extname, resolve } from "node:path";
import type {
  AgentToolResult,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Guardrail, writeApprovalNote, type PathApproval, type ToolContext } from "./guardrail.ts";
import { SandboxRunner } from "./sandbox-runner.ts";
import { withNormalizedPath } from "./normalize-path.ts";
import type { ToolName, ToolSession } from "./config.ts";
import { modelSupportsImages } from "../shared/image-input.ts";

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
    commandApproved = await guardrail.authorizeCommand(
      params.command as string,
      context,
      request.approvalMode,
    );
  } else {
    const path = params.path as string;
    if (toolName !== "write") await guardrail.authorizePath("read", path, context);
    if (toolName === "write" || toolName === "edit") {
      approval = await guardrail.authorizePath("write", path, context);
    }
  }
  signal?.throwIfAborted();
  const detectedMimeType =
    toolName === "read"
      ? await imageMimeType(params.path as string, guardrail, runner, request)
      : null;
  const result =
    toolName === "read" && isVisionImageFile(params.path as string, detectedMimeType)
      ? await readImage(params.path as string, detectedMimeType, runner, request)
      : await runner.runTool(toolName as ToolName, params, {
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

async function readImage(
  imagePath: string,
  mimeType: string | null,
  runner: SandboxRunner,
  request: GuardedToolRequest,
): Promise<AgentToolResult<unknown>> {
  request.signal?.throwIfAborted();
  const model = request.context?.model;
  if (!modelSupportsImages(model ?? {})) {
    return {
      content: [{ type: "text", text: imageReadErrorMessage(imagePath, model) }],
      details: {},
      isError: true,
    };
  }
  return runner.runTool(
    "read",
    { path: imagePath },
    {
      mode: "fs",
      signal: request.signal,
      imageMimeType: mimeType ?? "application/octet-stream",
    },
  );
}

export type GuardedToolContext = Pick<ExtensionContext, "hasUI" | "model" | "thinkingLevel"> & {
  ui?: ToolContext["ui"];
  executeTool?: ExtensionToolContext["executeTool"];
  sessionManager?: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getSessionFile">;
};

export type GuardedToolRequest = {
  id: string;
  toolName: string;
  approvalMode?: "prompt" | "existing-only";
  params: Record<string, unknown>;
  executor?: { entrypoint: string };
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

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tiff",
  ".tif",
]);

async function imageMimeType(
  path: string,
  guardrail: Guardrail,
  runner: SandboxRunner,
  request: GuardedToolRequest,
): Promise<string | null> {
  if (typeof request.context?.executeTool !== "function")
    throw new Error("Image detection requires the registered bash tool via context.executeTool");
  const fileArgs = ["file", "-E", "--dereference", "--brief", "--mime-type", "--", path];
  await guardrail.authorizeCommand(quote(fileArgs), request.context, request.approvalMode);
  request.signal?.throwIfAborted();
  const outcome = await request.context.executeTool(
    "bash",
    { command: quote(["bwrap", ...runner.buildArgs("fs"), ...fileArgs]) },
    { signal: request.signal },
  );
  request.signal?.throwIfAborted();
  const output = outcome.result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (outcome.isError || outcome.result.isError)
    throw new Error(`Image detection failed for ${path}: ${output}`);
  const mimeType = output.split(/\r?\n/, 1)[0]?.trim() || null;
  if (mimeType !== null && !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType))
    throw new Error(`Invalid image detection response for ${path}: ${output}`);
  return mimeType;
}

function isVisionImageFile(imagePath: string, detectedMimeType: string | null): boolean {
  if (detectedMimeType === "image/svg+xml") return false;
  return detectedMimeType === null
    ? IMAGE_EXTENSIONS.has(extname(imagePath).toLowerCase())
    : detectedMimeType.startsWith("image/");
}

export { isVisionImageFile };

export function imageReadErrorMessage(
  imagePath: string,
  model?: { provider?: string; id?: string },
): string {
  const modelName = model?.provider && model?.id ? ` (${model.provider}/${model.id})` : "";
  return (
    `The current model${modelName} does not support image input; the image was not sent to the model. ` +
    `Delegate image reading to the vision agent via subagent: have the child read the image ` +
    `with read and report its observation as text. If you cannot spawn subagents, report ` +
    `that image reading is needed to the requester. Path: ${imagePath}`
  );
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
