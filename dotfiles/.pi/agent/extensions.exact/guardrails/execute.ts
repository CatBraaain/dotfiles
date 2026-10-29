import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { AgentToolResult, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Guardrail, writeApprovalNote, type PathApproval } from "./guardrail.ts";
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
  const params = normalized as Record<string, unknown>;
  let approval: PathApproval | undefined;
  let commandApproved = false;
  if (toolName === "bash") {
    commandApproved = await guardrail.authorizeCommand(params.command as string, context);
  } else {
    const path = resolve(cwd, (params.path as string | undefined) ?? ".");
    if (toolName !== "write") await guardrail.authorizePath("read", path, context);
    if (toolName === "write" || toolName === "edit") {
      approval = await guardrail.authorizePath("write", path, context);
    }
  }
  signal?.throwIfAborted();
  const result =
    toolName === "read" && isVisionImageFile(resolve(cwd, params.path as string))
      ? readImage(resolve(cwd, params.path as string), context)
      : await runner.runTool(toolName as ToolName, params, {
          mode: toolName === "bash" ? "bash" : "fs",
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

function readImage(imagePath: string, context: ExtensionToolContext): AgentToolResult<unknown> {
  const model = context?.model;
  if (!modelSupportsImages(model ?? {})) {
    return {
      content: [{ type: "text", text: imageReadErrorMessage(imagePath, model) }],
      details: {},
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "image",
        data: readFileSync(imagePath).toString("base64"),
        mimeType: imageMimeType(imagePath) ?? "application/octet-stream",
      },
    ],
    details: {},
  };
}

export type GuardedToolRequest = {
  id: string;
  toolName: string;
  params: Record<string, unknown>;
  signal?: AbortSignal;
  onUpdate?: (result: AgentToolResult<unknown>) => void;
  context: ExtensionToolContext;
};

const SUPPORTED_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls", "bash"]);
const COMMAND_APPROVAL_NOTE = "User approved this command via confirmation.";
const EROFS_HINT =
  "Sandbox blocked this write. Do not rewrite the command and retry with bash. Request access with ask_permission only when the target's effective write action is ask or unset and it is not a credentials path; explicit deny cannot be granted. If the result says bash writes are unavailable, use fs tools instead.";

function sessionFromContext(context: any): ToolSession {
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

function imageMimeType(path: string): string | null {
  const result = spawnSync("file", ["--brief", "--mime-type", "--", path], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function isVisionImageFile(
  imagePath: string,
  detectedMimeType = imageMimeType(imagePath),
): boolean {
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
