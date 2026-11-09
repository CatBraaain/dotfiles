import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const WORKSPACES_ENTRY_TYPE = "session-worktree-metadata";

export interface WorkspaceUpdate {
  changed: boolean;
  workspaces: string[];
}

type SessionAccess = Pick<ExtensionContext["sessionManager"], "getEntries">;
type EntryWriter = Pick<ExtensionAPI, "appendEntry">;

const WorkspacesSchema = Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true });
const MetadataSchema = Type.Object({ workspaces: WorkspacesSchema });

export function getWorkspaces(manager: SessionAccess): string[] {
  const latest = manager
    .getEntries()
    .findLast((entry) => entry.type === "custom" && entry.customType === WORKSPACES_ENTRY_TYPE);
  if (!latest || latest.type !== "custom") return [];
  if (!Value.Check(MetadataSchema, latest.data) || !latest.data.workspaces.every(isWorkspacePath))
    throw new Error(`Invalid workspaces in custom entry ${latest.id}`);
  return [...latest.data.workspaces];
}

export function saveWorkspaces(
  pi: EntryWriter,
  manager: SessionAccess,
  workspaces: string[],
): WorkspaceUpdate {
  const normalized = [...new Set(workspaces)];
  if (!Value.Check(WorkspacesSchema, normalized) || !normalized.every(isWorkspacePath))
    throw new Error("Workspaces must contain absolute paths without NUL");
  const previous = getWorkspaces(manager);
  const changed = JSON.stringify(previous) !== JSON.stringify(normalized);
  if (changed) pi.appendEntry(WORKSPACES_ENTRY_TYPE, { workspaces: normalized });
  return { changed, workspaces: [...normalized] };
}

function isWorkspacePath(path: string): boolean {
  return isAbsolute(path) && !path.includes("\0");
}
