import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const WORKSPACES_ENTRY_TYPE = "session-worktree-metadata";
export const DECLARATIONS_ENTRY_TYPE = "session-worktree-declarations";
export const WORKTREE_NAME_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

export interface WorktreeDeclaration {
  name: string;
  path: string;
}

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

const WORKTREE_NAME = new RegExp(WORKTREE_NAME_PATTERN);
const DeclarationsSchema = Type.Object({
  worktrees: Type.Array(
    Type.Object({ name: Type.String({ pattern: WORKTREE_NAME_PATTERN }), path: Type.String() }),
  ),
});

export function getDeclarations(manager: SessionAccess): WorktreeDeclaration[] {
  const latest = manager
    .getEntries()
    .findLast((entry) => entry.type === "custom" && entry.customType === DECLARATIONS_ENTRY_TYPE);
  if (!latest || latest.type !== "custom") return [];
  const data = latest.data;
  if (
    !Value.Check(DeclarationsSchema, data) ||
    !data.worktrees.every(
      ({ name, path }) => isWorktreeName(name) && isWorkspacePath(path) && path === resolve(path),
    ) ||
    new Set(data.worktrees.map(({ name }) => name)).size !== data.worktrees.length ||
    new Set(data.worktrees.map(({ path }) => path)).size !== data.worktrees.length
  )
    throw new Error(`Invalid worktrees in custom entry ${latest.id}`);
  return data.worktrees.map(({ name, path }) => ({ name, path }));
}

export function saveDeclarations(
  pi: EntryWriter,
  previous: WorktreeDeclaration[],
  worktrees: WorktreeDeclaration[],
): boolean {
  const changed = JSON.stringify(previous) !== JSON.stringify(worktrees);
  if (changed) pi.appendEntry(DECLARATIONS_ENTRY_TYPE, { worktrees });
  return changed;
}

export function isWorktreeName(name: string): boolean {
  return (
    typeof name === "string" && WORKTREE_NAME.test(name) && !/^wt-(?:agents|copilot)-/.test(name)
  );
}

function isWorkspacePath(path: string): boolean {
  return isAbsolute(path) && !path.includes("\0");
}
