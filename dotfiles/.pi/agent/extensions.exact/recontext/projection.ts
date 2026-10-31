import { createHash, randomUUID } from "node:crypto";
import {
  convertToLlm,
  type ContextEditEntryDraft,
  type ProjectedSessionEntry,
  type ExtensionContext,
  type SessionBoundaryDraft,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export type ProjectionManager = ExtensionContext["sessionManager"];

export const REPLACEMENT_STATE = "recontext-projection";
const REPLACEMENT_COMMITTED = "recontext-committed";
const STATE_VERSION = 1;

const replacementSchema = Type.Object({
  version: Type.Literal(STATE_VERSION),
  id: Type.String(),
  sessionId: Type.String(),
  targets: Type.Array(Type.Object({ id: Type.String(), fingerprint: Type.String() }), {
    minItems: 1,
  }),
  suppressed: Type.Array(Type.Object({ id: Type.String(), fingerprint: Type.String() })),
  anchorId: Type.Union([Type.String(), Type.Null()]),
  content: Type.String(),
});
export type ReplacementState = Static<typeof replacementSchema>;

export interface ReplacementProjection {
  entries: ProjectedSessionEntry[];
  drafts: SessionBoundaryDraft[];
  modelChanged: boolean;
}

export function createReplacement(
  manager: ProjectionManager,
  entries: ProjectedSessionEntry[],
  targetIds: ReadonlySet<string>,
  summary: string,
): ReplacementState {
  const selected = entries.filter(
    (entry) =>
      targetIds.has(entry.sourceEntry.id) &&
      entry.messages.some((message) => message.role !== "system"),
  );
  const targets = selected.filter((entry) => isEditable(entry.sourceEntry));
  if (targets.length === 0) throw new Error("No editable message can hold the replacement");
  const suppressed = selected.filter((entry) => !isEditable(entry.sourceEntry));
  const anchor = targets.find((entry) => isUserAnchor(entry.sourceEntry));
  return {
    version: STATE_VERSION,
    id: randomUUID(),
    sessionId: manager.getSessionId(),
    targets: targets.map((entry) => ({
      id: entry.sourceEntry.id,
      fingerprint: fingerprint(entry.messages),
    })),
    suppressed: suppressed.map((entry) => ({
      id: entry.sourceEntry.id,
      fingerprint: fingerprint(entry.messages),
    })),
    anchorId: anchor?.sourceEntry.id ?? null,
    content: summaryContent(summary),
  };
}

export function pendingProjection(
  manager: ProjectionManager,
  initial = manager.buildSessionProjection().entries,
): ReplacementProjection {
  const branch = manager.getBranch();
  const committed = new Set(
    branch.flatMap((entry) =>
      entry.type === "custom" &&
      entry.customType === REPLACEMENT_COMMITTED &&
      typeof entry.data === "string"
        ? [entry.data]
        : [],
    ),
  );
  let entries = initial;
  const drafts: SessionBoundaryDraft[] = [];
  let modelChanged = false;
  for (const entry of branch) {
    if (
      entry.type !== "custom" ||
      entry.customType !== REPLACEMENT_STATE ||
      !isReplacementState(entry.data)
    )
      continue;
    const state = entry.data;
    if (state.sessionId !== manager.getSessionId()) continue;
    if (!committed.has(state.id)) {
      if (!isReplacementCurrent(manager, entries, state)) continue;
      const edits = replacementEdits(state);
      entries = applyProjectionEdits(entries, edits);
      drafts.push(...edits, replacementCommitDraft(state));
      modelChanged = true;
    }
    const hidden = new Map(state.suppressed.map((target) => [target.id, target.fingerprint]));
    entries = entries.map((entry) => {
      const expected = hidden.get(entry.sourceEntry.id);
      if (expected === undefined || expected !== fingerprint(entry.messages)) return entry;
      modelChanged = true;
      return {
        sourceEntry: entry.sourceEntry,
        messages: entry.messages.filter((message) => message.role === "system"),
      };
    });
  }
  return { entries, drafts, modelChanged };
}

export function isReplacementCurrent(
  manager: ProjectionManager,
  entries: ProjectedSessionEntry[],
  state: ReplacementState,
): boolean {
  if (manager.getSessionId() !== state.sessionId) return false;
  const byId = new Map(entries.map((entry) => [entry.sourceEntry.id, entry]));
  return [...state.targets, ...state.suppressed].every((target) => {
    const entry = byId.get(target.id);
    return entry && fingerprint(entry.messages) === target.fingerprint;
  });
}

export function replacementEdits(state: ReplacementState): ContextEditEntryDraft[] {
  return state.targets.map((target) => ({
    type: "context_edit",
    targetId: target.id,
    replacement: target.id === state.anchorId ? { content: state.content } : null,
  }));
}

export function replacementCommitDraft(state: ReplacementState): SessionBoundaryDraft {
  return { type: "custom", customType: REPLACEMENT_COMMITTED, data: state.id };
}

export function applyProjectionEdits(
  entries: ProjectedSessionEntry[],
  edits: ContextEditEntryDraft[],
): ProjectedSessionEntry[] {
  const byId = new Map(edits.map((edit) => [edit.targetId, edit.replacement]));
  return entries.map((entry) => {
    if (!byId.has(entry.sourceEntry.id)) return entry;
    const replacement = byId.get(entry.sourceEntry.id);
    return {
      sourceEntry: entry.sourceEntry,
      messages: replacement
        ? entry.messages.map((message) => replaceContent(message, replacement.content))
        : [],
    };
  });
}

export function projectPendingMessages(
  messages: AgentMessage[],
  manager: ProjectionManager,
): AgentMessage[] {
  const current = manager.buildSessionProjection().entries;
  const pending = pendingProjection(manager, current);
  if (!pending.modelChanged) return messages;
  const sources = matchMessageSources(messages, current, false);
  const replacements = new Map(
    pending.entries.map((entry) => [entry.sourceEntry.id, entry.messages]),
  );
  return messages.flatMap((message, index) => {
    const source = sources[index];
    if (!source) return [message];
    const replacement = replacements.get(source.sourceEntry.id);
    if (!replacement || replacement === source.messages) return [message];
    const match = replacement.find((candidate) => messageKey(candidate) === messageKey(message));
    if (!match) return [];
    return isEditable(source.sourceEntry) && "content" in match
      ? [replaceContent(message, match.content)]
      : [message];
  });
}

export function matchMessageSources(
  messages: AgentMessage[] | Message[],
  entries: ProjectedSessionEntry[],
  llm = true,
): Array<ProjectedSessionEntry | undefined> {
  const sources = new Map<string, ProjectedSessionEntry[]>();
  for (const entry of entries) {
    const projected = llm ? convertToLlm(entry.messages) : entry.messages;
    for (const message of projected) {
      if (message.role === "system") continue;
      const key = messageKey(message);
      const matches = sources.get(key) ?? [];
      matches.push(entry);
      sources.set(key, matches);
    }
  }
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.role === "system") continue;
    const key = messageKey(message);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    if (sources.get(key)?.length !== count)
      throw new Error("Request messages cannot be mapped unambiguously to the active session");
  }
  return messages.map((message) =>
    message.role === "system" ? undefined : sources.get(messageKey(message))?.shift(),
  );
}

export function replaceRequestMessages(
  messages: Message[],
  sources: Array<ProjectedSessionEntry | undefined>,
  state: ReplacementState,
): Message[] {
  const targets = new Set([...state.targets, ...state.suppressed].map((target) => target.id));
  return messages.flatMap((message, index) => {
    const id = sources[index]?.sourceEntry.id;
    if (!id || !targets.has(id)) return [message];
    return id === state.anchorId && message.role === "user"
      ? [{ ...message, content: state.content }]
      : [];
  });
}

export function isEditable(entry: SessionEntry): boolean {
  return (
    entry.type === "custom_message" ||
    (entry.type === "message" && ["user", "assistant", "toolResult"].includes(entry.message.role))
  );
}

export function summaryContent(summary: string): string {
  const message = convertToLlm([
    { role: "compactionSummary", summary, tokensBefore: 0, timestamp: 0 },
  ])[0];
  if (!message || message.role !== "user") throw new Error("The summary wrapper is unavailable");
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}

function isUserAnchor(entry: SessionEntry): boolean {
  return (
    entry.type === "custom_message" || (entry.type === "message" && entry.message.role === "user")
  );
}

function replaceContent(
  message: AgentMessage,
  content: NonNullable<ContextEditEntryDraft["replacement"]>["content"],
): AgentMessage {
  if (message.role === "user") return { ...message, content: content as typeof message.content };
  if (message.role === "custom") return { ...message, content: content as typeof message.content };
  if (message.role === "assistant")
    return {
      ...message,
      content: (typeof content === "string"
        ? [{ type: "text", text: content }]
        : content) as typeof message.content,
    };
  if (message.role === "toolResult")
    return {
      ...message,
      content: (typeof content === "string"
        ? [{ type: "text", text: content }]
        : content) as typeof message.content,
    };
  return message;
}

function messageKey(message: AgentMessage | Message): string {
  return `${message.role}:${message.timestamp}:${message.role === "toolResult" ? message.toolCallId : ""}`;
}

function fingerprint(messages: AgentMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function isReplacementState(value: unknown): value is ReplacementState {
  return (
    Value.Check(replacementSchema, value) &&
    (value.anchorId === null || value.targets.some((target) => target.id === value.anchorId))
  );
}
