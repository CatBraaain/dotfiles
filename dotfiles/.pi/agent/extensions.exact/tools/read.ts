import { constants, readFileSync, statSync } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import type { WASMagic } from "wasmagic";
import {
  executeOpenedStandardRead,
  executeToolRequest,
  type OpenedReadExecutor,
  type ToolRequest,
} from "../guardrails/run-tools.ts";

const DETECTION_MAX_BYTES = 7 * 1024 * 1024;
let detector: Promise<WASMagic> | undefined;

async function detectOpenFileMimeType(file: FileHandle, size: bigint): Promise<string | null> {
  const magic = await (detector ??= import("wasmagic").then(({ WASMagic }) => WASMagic.create()));
  const buffer = Buffer.allocUnsafe(Math.min(Number(size), DETECTION_MAX_BYTES));
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return magic.detect(buffer.subarray(0, length)) || null;
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

export function isVisionImageFile(imagePath: string, detectedMimeType: string | null): boolean {
  if (detectedMimeType === "image/svg+xml") return false;
  return detectedMimeType === null
    ? IMAGE_EXTENSIONS.has(extname(imagePath).toLowerCase())
    : detectedMimeType.startsWith("image/");
}

function imageReadErrorMessage(
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

function readPath(request: ToolRequest): string {
  const path = (request.params as { path?: unknown } | null)?.path;
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
    throw new Error("Read requires an absolute file path");
  return path;
}

export const executeOpenedRead: OpenedReadExecutor = async (request, file, size) => {
  const path = readPath(request);
  const mimeType = await detectOpenFileMimeType(file, size);
  if (isVisionImageFile(path, mimeType)) {
    const model = request.executorData;
    if (model?.supportsImages !== true) {
      const provider = typeof model?.provider === "string" ? model.provider : undefined;
      const id = typeof model?.modelId === "string" ? model.modelId : undefined;
      return {
        content: [{ type: "text", text: imageReadErrorMessage(path, { provider, id }) }],
        details: {},
        isError: true,
      };
    }
    const bytes = await file.readFile();
    return {
      content: [
        {
          type: "image",
          data: bytes.toString("base64"),
          mimeType: mimeType ?? "application/octet-stream",
        },
      ],
      details: {},
    };
  }
  if (!shouldReadInFull(path)) return executeOpenedStandardRead(request, file, size);
  const text = await file.readFile("utf8");
  return { content: [{ type: "text", text }], structuredContent: text, details: undefined };
};

async function executeRead(request: ToolRequest) {
  const path = readPath(request);
  if (!(await stat(path)).isFile()) return executeToolRequest("read", request);
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
    return await executeOpenedRead(request, file, info.size);
  } finally {
    await file.close();
  }
}

function shouldReadInFull(path: string): boolean {
  if (basename(path) === "SKILL.md") return true;
  for (
    let directory = dirname(path);
    directory !== dirname(directory);
    directory = dirname(directory)
  ) {
    if (basename(directory) !== "references") continue;
    if (hasSkillFile(dirname(directory))) return true;
  }
  return false;
}

function hasSkillFile(skillDirectory: string): boolean {
  try {
    return statSync(join(skillDirectory, "SKILL.md"), { throwIfNoEntry: false })?.isFile() ?? false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM")
      return false;
    throw error;
  }
}

async function main(): Promise<void> {
  try {
    const request = JSON.parse(readFileSync(0, "utf8")) as ToolRequest;
    const result = await executeRead(request);
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
