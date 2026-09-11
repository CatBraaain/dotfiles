import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

/** A user message that /undo reverts the conversation to. */
export interface UndoTarget {
  /** Session entry ID of the user message to undo. */
  entryId: string;
  /** Text of the user message, restored into the editor after undoing. */
  text: string;
}

function isUserMessageEntry(entry: SessionEntry): entry is SessionMessageEntry & {
  message: UserMessage;
} {
  return entry.type === "message" && entry.message.role === "user";
}

/**
 * Extract the text parts of a message content; non-text parts (images) are ignored.
 * Joined without a separator so that the result matches the text the built-in /tree
 * restores for the same message (contentText with an empty separator).
 */
export function extractMessageText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Find the entry /undo reverts to: the last user message on the active branch.
 * `branchEntries` is the branch as returned by getBranch() (leaf first, root last).
 * Returns undefined when the branch has no user message.
 */
export function findUndoTarget(branchEntries: SessionEntry[]): UndoTarget | undefined {
  const entry = branchEntries.find(isUserMessageEntry);
  if (!entry) return undefined;
  return { entryId: entry.id, text: extractMessageText(entry.message.content) };
}
