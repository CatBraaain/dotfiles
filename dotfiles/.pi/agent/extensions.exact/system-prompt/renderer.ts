import { randomUUID } from "node:crypto";
import { closeSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parse, quote } from "shell-quote";
import { requestBackgroundBash } from "../tools/background-bash.ts";

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
    const outcome = await requestBackgroundBash({
      id: `view-system-prompt-${randomUUID()}`,
      context: ctx,
      params: { command: editorCommand(command, path), timeout: EDITOR_TIMEOUT_SECONDS },
    });
    if (outcome.status !== "completed") {
      throw outcome.status === "aborted" ? outcome.reason : outcome.error;
    }
    const output = outcome.result.structuredContent;
    const succeeded =
      typeof output === "object" &&
      output !== null &&
      "exit_code" in output &&
      output.exit_code === 0;
    if (outcome.result.isError || !succeeded) {
      const detail = outcome.result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      throw new Error(detail || "External editor failed");
    }
  } catch (error) {
    ctx.ui.notify(
      `Cannot view system prompt: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}
