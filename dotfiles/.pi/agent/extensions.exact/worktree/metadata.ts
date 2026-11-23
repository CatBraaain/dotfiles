import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const WORKSPACES_ENTRY_TYPE = "session-worktree-metadata";

export interface WorkspaceUpdate {
  changed: boolean;
  workspaces: string[];
}

type SessionAccess = Pick<ExtensionContext["sessionManager"], "getEntries" | "getHeader">;
type EntryWriter = Pick<ExtensionAPI, "appendEntry">;

const WorkspacesSchema = Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true });
const SnapshotOwnerSchema = Type.Object({
  sessionId: Type.String(),
  workspaces: Type.Optional(Type.Unknown()),
});

export function getWorkspaces(manager: SessionAccess): string[] {
  const header = manager.getHeader();
  if (!header) return [];

  for (const entry of manager.getEntries().toReversed()) {
    if (entry.type !== "custom" || entry.customType !== WORKSPACES_ENTRY_TYPE) continue;
    const snapshot = entry.data;
    if (!Value.Check(SnapshotOwnerSchema, snapshot) || snapshot.sessionId !== header.id) continue;
    if (!isWorkspaceList(snapshot.workspaces))
      throw new Error(`Invalid workspaces in custom entry ${entry.id}`);
    return [...snapshot.workspaces];
  }

  return [];
}

export function saveWorkspaces(
  pi: EntryWriter,
  manager: SessionAccess,
  sessionId: string,
  workspaces: string[],
): WorkspaceUpdate {
  const normalized = [...new Set(workspaces)];
  if (!isWorkspaceList(normalized))
    throw new Error("Workspaces must contain absolute paths without NUL");
  const previous = getWorkspaces(manager);
  const changed = JSON.stringify(previous) !== JSON.stringify(normalized);
  if (changed) pi.appendEntry(WORKSPACES_ENTRY_TYPE, { sessionId, workspaces: normalized });
  return { changed, workspaces: [...normalized] };
}

function isWorkspaceList(workspaces: unknown): workspaces is string[] {
  return (
    Value.Check(WorkspacesSchema, workspaces) &&
    workspaces.every((path) => isAbsolute(path) && !path.includes("\0"))
  );
}
