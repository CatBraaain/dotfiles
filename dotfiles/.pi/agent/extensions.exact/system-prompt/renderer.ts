import { randomUUID } from "node:crypto";
import { closeSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SettingsManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { parse, quote } from "shell-quote";

const EDITOR_TIMEOUT_SECONDS = 24 * 60 * 60;

export function writePromptSnapshot(sessionId: string, prompt: string, directory = "/tmp"): string {
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error("Invalid session ID");
  const path = join(directory, `${sessionId}_system_prompt.md`);
  const temporaryPath = `${path}.${randomUUID()}`;
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, prompt, "utf8");
    renameSync(temporaryPath, path);
  } finally {
    closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
  return path;
}

export function editorCommand(command: string, path: string): string {
  const arguments_ = parse(command, process.env);
  if (arguments_.length === 0 || arguments_.some((argument) => typeof argument !== "string"))
    throw new Error("External editor must be a command with arguments, without shell operators");
  return quote([...(arguments_ as string[]), path]);
}

export async function openPromptSnapshot(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: ExtensionCommandContext,
  prompt: string | undefined,
): Promise<void> {
  if (prompt === undefined) {
    ctx.ui.notify("No system prompt has been sent in this session yet.", "info");
    return;
  }
  try {
    const command = SettingsManager.create(ctx.cwd, undefined, {
      projectTrusted: ctx.isProjectTrusted(),
    }).getExternalEditorCommand();
    const path = writePromptSnapshot(ctx.sessionManager.getSessionId(), prompt);
    const result = await pi.exec("bash", ["-c", editorCommand(command, path)], {
      cwd: ctx.cwd,
      timeout: EDITOR_TIMEOUT_SECONDS * 1000,
    });
    if (
      result.killed ||
      ("truncated" in result && result.truncated === true) ||
      result.code !== 0
    ) {
      throw new Error(result.stderr || result.stdout || "External editor failed");
    }
  } catch (error) {
    ctx.ui.notify(
      `Cannot view system prompt: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}
