import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TICKET_ENTRY = "pi-mux-ticket";
const VIEW_ENTRY = "pi-mux-viewed";
const TICKET_ID_PATTERN = /^[0-9]{8}-[0-9]{6}(?:[-._][A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const VIEW_OPTION_NAME = /^@pi-mux-view-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const RESPONSE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const VIEW_RECEIPT_MAX_ENCODED_LENGTH = 16_384;

type SessionManager = Pick<
  ExtensionContext["sessionManager"],
  "getSessionId" | "getEntries" | "getBranch" | "getSessionFile"
>;
type EntryWriter = Pick<ExtensionAPI, "appendEntry">;

export function recordDispatchTicket(
  pi: EntryWriter,
  manager: SessionManager,
  env: NodeJS.ProcessEnv,
): void {
  if (env.TICKET_DISPATCH_ROLE !== "pi") return;
  const project = env.TICKET_DISPATCH_PROJECT;
  const id = env.TICKET_DISPATCH_ID;
  if (
    !project ||
    project === "." ||
    project === ".." ||
    /[/\\\0]/.test(project) ||
    !id ||
    id.length > 252 ||
    !TICKET_ID_PATTERN.test(id)
  )
    return;
  const sessionId = manager.getSessionId();
  const alreadyRecorded = manager
    .getEntries()
    .some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === TICKET_ENTRY &&
        isRecord(entry.data) &&
        entry.data.sessionId === sessionId,
    );
  if (!alreadyRecorded) pi.appendEntry(TICKET_ENTRY, { sessionId, ticket: { project, id } });
}

export function viewOptions(output: string): { name: string; encoded: string }[] {
  return output.split("\n").flatMap((line) => {
    const [name, encoded] = line.split(" ", 2);
    return name && encoded && VIEW_OPTION_NAME.test(name) ? [{ name, encoded }] : [];
  });
}

export function recordViewReceipt(pi: EntryWriter, manager: SessionManager, encoded: string): void {
  const receipt = parseReceipt(encoded);
  const sessionId = manager.getSessionId();
  if (!receipt || receipt.sessionId !== sessionId || receipt.processPid !== process.pid) return;
  const file = manager.getSessionFile();
  if (!file || canonicalPath(file) !== receipt.file) return;
  const { responseId, viewedAt } = receipt;
  if (
    responseId !== null &&
    !manager
      .getBranch()
      .some(
        (entry) =>
          entry.id === responseId &&
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          Array.isArray(entry.message.content) &&
          entry.message.content.some(
            (block) =>
              block?.type === "text" && typeof block.text === "string" && block.text.trim(),
          ),
      )
  )
    return;
  const stat = lstatSync(receipt.file, { bigint: true, throwIfNoEntry: false });
  if (!stat?.isFile() || [stat.dev, stat.ino, stat.birthtimeNs].join(":") !== receipt.fileIdentity)
    return;
  pi.appendEntry(VIEW_ENTRY, { sessionId, viewedAt, responseId });
}

function parseReceipt(encoded: string) {
  if (encoded.length > VIEW_RECEIPT_MAX_ENCODED_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    return;
  let receipt: unknown;
  try {
    receipt = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return;
  }
  if (!isRecord(receipt)) return;
  const { v, sessionId, processPid, file, fileIdentity, responseId, viewedAt } = receipt;
  if (
    v !== 1 ||
    typeof sessionId !== "string" ||
    typeof processPid !== "number" ||
    typeof file !== "string" ||
    !isAbsolute(file) ||
    file.includes("\0") ||
    typeof fileIdentity !== "string" ||
    !/^\d+:\d+:-?\d+$/.test(fileIdentity) ||
    (responseId !== null &&
      (typeof responseId !== "string" || !RESPONSE_ID_PATTERN.test(responseId))) ||
    typeof viewedAt !== "string"
  )
    return;
  const time = Date.parse(viewedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== viewedAt) return;
  return { sessionId, processPid, file, fileIdentity, responseId, viewedAt };
}

function canonicalPath(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
