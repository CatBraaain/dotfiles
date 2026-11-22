import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, win32 } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getTmuxPaths, launchToken } from "./shared.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Draft = { id: string; cwd: string; request: string; text: string; directory: string };
type Ready = { id: string; pane: string; serverPid: number };
type DraftLocation = { agentDir: string; localAppData?: string; platform: NodeJS.Platform };

export function firstInputRoot({
  agentDir,
  localAppData,
  platform,
}: DraftLocation): string | undefined {
  if (platform === "win32") {
    if (!localAppData || !/^[a-z]:[\\/]/i.test(localAppData)) return undefined;
    return win32.join(localAppData, "pi-mux-first-input");
  }
  return join(agentDir, "pi-tmux", "first-input");
}

export function registerFirstInputHandoff(
  pi: ExtensionAPI,
  published: (ctx: ExtensionContext) => Promise<Ready | undefined>,
) {
  let warm = process.env.PI_TMUX_STARTUP_MODE === "warm";
  const requested = process.env.PI_TMUX_FIRST_INPUT;
  const sessionId = process.env.PI_TMUX_SESSION_ID;
  let draft: Draft | undefined;
  let unlockInput: (() => void) | undefined;

  pi.on("session_shutdown", () => unlockInput?.());
  pi.on("agent_settled", (_event, ctx) => {
    confirm(ctx);
  });
  pi.on("user_bash", (_event, ctx) => {
    if (ctx.sessionManager.getSessionId() === sessionId) warm = false;
  });

  pi.on("input", async (event, ctx) => {
    if (unlockInput && event.source === "interactive") {
      restore(ctx, event.text, "First input handoff is in progress. Wait before submitting again.");
      return { action: "handled" };
    }
    if (
      !warm ||
      ctx.mode !== "tui" ||
      !ctx.hasUI ||
      event.source !== "interactive" ||
      event.streamingBehavior !== undefined ||
      event.images?.length ||
      !event.text.trim() ||
      /^[/!]/.test(event.text.trimStart()) ||
      ctx.sessionManager.getSessionId() !== sessionId ||
      !ctx.isIdle() ||
      hasConversationContext(ctx)
    )
      return;

    warm = false;
    try {
      if (ctx.ui.getEditorText() !== "") throw new Error("Editor already contains another draft");
      unlockInput = ctx.ui.onTerminalInput(() => ({ consume: true }));
      ctx.ui.notify("Replacing Pi. Wait before typing or submitting again.", "info");
      const owner = await published(ctx);
      if (!owner || owner.id !== ctx.sessionManager.getSessionId() || !UUID.test(owner.id))
        throw new Error("Warm session is not ready");
      if (ctx.ui.getEditorText() !== "" || !ctx.isIdle() || hasConversationContext(ctx))
        throw new Error("Warm session changed before handoff");
      draft = saveDraft(owner.id, ctx.cwd, event.text);
      const result = await pi.exec(
        "pi-mux",
        [
          "first-input",
          draft.id,
          draft.request,
          JSON.stringify({
            socket: getTmuxPaths().socketPath,
            serverPid: owner.serverPid,
            pane: owner.pane,
            pid: process.pid,
            token: launchToken(),
          }),
        ],
        { cwd: ctx.cwd },
      );
      if (result.code !== 0 || result.killed) throw new Error("Cannot replace pi");
    } catch {
      unlockInput?.();
      unlockInput = undefined;
      if (!draft) warm = true;
      restore(ctx, event.text, "First input handoff failed. Review the draft and submit it again.");
    }
    return { action: "handled" };
  });

  return {
    ready(ctx: ExtensionContext): void {
      const id = ctx.sessionManager.getSessionId();
      if (!UUID.test(id) || !ctx.hasUI) return;
      try {
        draft = loadDraft(id, ctx.cwd);
        if (!draft) return;
        warm = false;
        if (requested !== draft.request || !claimDraft(draft)) {
          if (!confirm(ctx))
            restore(
              ctx,
              draft.text,
              "Recovered first input. Check whether it was sent before submitting again.",
            );
          return;
        }
        ctx.ui.notify(`If the first input is not accepted, ${recoveryInstructions(id)}`, "info");
        pi.sendUserMessage(draft.text);
      } catch {
        ctx.ui.notify(
          `First input handoff could not be confirmed. ${recoveryInstructions(id)}`,
          "warning",
        );
      }
    },
  };

  function confirm(ctx: ExtensionContext): boolean {
    if (!draft || ctx.sessionManager.getSessionId() !== draft.id) return false;
    const file = ctx.sessionManager.getSessionFile();
    if (!file || !existsSync(file)) return false;
    const { text } = draft;
    const accepted = ctx.sessionManager
      .getEntries()
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          matchesText(entry.message.content, text),
      );
    if (!accepted) return false;
    try {
      discardAcceptedDraft(draft);
      draft = undefined;
    } catch {
      ctx.ui.notify(
        "First input was accepted, but its recovery file could not be removed.",
        "warning",
      );
    }
    return true;
  }
}

function recoveryInstructions(id: string): string {
  return `run pi-mux close ${id} if Pi is still running, then pi-mux open ${id} to recover the draft.`;
}

function matchesText(content: unknown, text: string): boolean {
  if (content === text) return true;
  if (!Array.isArray(content) || content.length !== 1) return false;
  return content[0]?.type === "text" && content[0].text === text;
}

function hasConversationContext(ctx: ExtensionContext): boolean {
  return ctx.sessionManager
    .getEntries()
    .some(
      (entry) =>
        entry.type === "message" ||
        entry.type === "custom_message" ||
        entry.type === "compaction" ||
        entry.type === "branch_summary",
    );
}

function restore(ctx: ExtensionContext, text: string, notice: string): void {
  if (ctx.ui.getEditorText() === "") ctx.ui.setEditorText(text);
  else if (ctx.ui.getEditorText() !== text)
    ctx.ui.setEditorText(text + "\n" + ctx.ui.getEditorText());
  ctx.ui.notify(notice, "warning");
}

function draftRoot(): string | undefined {
  return firstInputRoot({
    agentDir: getAgentDir(),
    localAppData: process.env.LOCALAPPDATA,
    platform: process.platform,
  });
}

function saveDraft(id: string, cwd: string, text: string): Draft {
  const root = draftRoot();
  if (!root) throw new Error("No local user data directory");
  if (process.platform !== "win32") assertPrivateDirectory(join(root, ".."));
  mkdirSync(root, { mode: 0o700, recursive: true });
  assertPrivateDirectory(root);
  const request = randomUUID();
  const directory = join(root, id);
  if (lstatSync(directory, { throwIfNoEntry: false }))
    throw new Error("First input already exists");
  const temporary = mkdtempSync(join(root, ".draft-"));
  try {
    writeNewFile(join(temporary, "context.json"), JSON.stringify({ id, cwd, request }));
    writeNewFile(join(temporary, "text"), text);
    syncDirectory(temporary);
    renameSync(temporary, directory);
    syncDirectory(root);
    syncDirectory(join(root, ".."));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return { id, cwd, request, text, directory };
}

function loadDraft(id: string, cwd: string): Draft | undefined {
  const root = draftRoot();
  if (!root) return;
  const directory = join(root, id);
  if (!existsSync(join(directory, "text"))) return;
  if (process.platform !== "win32") assertPrivateDirectory(join(root, ".."));
  assertPrivateDirectory(root);
  assertPrivateDirectory(directory);
  const metadata = JSON.parse(readPrivateFile(join(directory, "context.json")));
  if (
    metadata?.id !== id ||
    metadata.cwd !== cwd ||
    !isAbsolute(cwd) ||
    typeof metadata.request !== "string" ||
    !UUID.test(metadata.request)
  )
    throw new Error("First input does not match this session");
  const text = readPrivateFile(join(directory, "text"));
  if (!text.trim()) throw new Error("First input is empty");
  return { id, cwd, request: metadata.request, text, directory };
}

function writeNewFile(path: string, text: string): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, text, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readPrivateFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || !isPrivate(stat)) throw new Error("Unsafe first input file");
  return readFileSync(path, "utf8");
}

function isPrivate(stat: { uid: number; mode: number }): boolean {
  return (
    process.platform === "win32" || (stat.uid === process.getuid!() && (stat.mode & 0o077) === 0)
  );
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || !isPrivate(stat)) throw new Error("Unsafe first input directory");
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const directory = openSync(path, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function claimDraft(draft: Draft): boolean {
  try {
    writeNewFile(join(draft.directory, "attempted"), "");
    syncDirectory(draft.directory);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function discardAcceptedDraft(draft: Draft): void {
  unlinkSync(join(draft.directory, "text"));
  rmSync(join(draft.directory, "attempted"), { force: true });
  unlinkSync(join(draft.directory, "context.json"));
  rmdirSync(draft.directory);
}
