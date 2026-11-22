import { existsSync, lstatSync, readFileSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { isAbsolute, join, win32 } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Draft = { id: string; text: string; directory: string };
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

export function registerLegacyDraftRecovery(pi: Pick<ExtensionAPI, "on">) {
  let draft: Draft | undefined;

  pi.on("agent_settled", (_event, ctx) => {
    confirm(ctx);
  });

  return function recover(ctx: ExtensionContext): void {
    const id = ctx.sessionManager.getSessionId();
    if (!UUID.test(id) || !ctx.hasUI) return;
    try {
      draft = loadDraft(id, ctx.cwd);
      if (!draft || confirm(ctx)) return;
      restore(ctx, draft.text);
    } catch {
      ctx.ui.notify(
        `Could not recover the first input draft. Run pi-mux close ${id}, then pi-mux open ${id} to retry.`,
        "warning",
      );
    }
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

function matchesText(content: unknown, text: string): boolean {
  if (content === text) return true;
  if (!Array.isArray(content) || content.length !== 1) return false;
  return content[0]?.type === "text" && content[0].text === text;
}

function restore(ctx: ExtensionContext, text: string): void {
  const existing = ctx.ui.getEditorText();
  if (existing === "") ctx.ui.setEditorText(text);
  else if (existing !== text) ctx.ui.setEditorText(text + "\n" + existing);
  ctx.ui.notify(
    "Recovered first input. Check whether it was sent before submitting again.",
    "warning",
  );
}

function draftRoot(): string | undefined {
  return firstInputRoot({
    agentDir: getAgentDir(),
    localAppData: process.env.LOCALAPPDATA,
    platform: process.platform,
  });
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
  return { id, text, directory };
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

function discardAcceptedDraft(draft: Draft): void {
  unlinkSync(join(draft.directory, "text"));
  rmSync(join(draft.directory, "attempted"), { force: true });
  unlinkSync(join(draft.directory, "context.json"));
  rmdirSync(draft.directory);
}
