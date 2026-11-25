import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { TmuxConfig } from "./configuration";
import { platform } from "./platform";
import { type Candidate, errorMessage, SESSION_ID_PATTERN } from "./session-model";

export type RestoreState = {
  version: 1;
  generation: string;
  cwds: string[];
  sessions: Candidate[];
};

type Workspace = { cwd: string; sessions: string[] };

type Snapshot = {
  version: 1;
  generation: string;
  workspaces: Workspace[];
};

export function uniqueCandidates(candidates: Candidate[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const previous = byId.get(candidate.id);
    if (previous && previous.cwd !== candidate.cwd)
      throw new Error(`Conflicting working directories for conversation ${candidate.id}`);
    byId.set(candidate.id, candidate);
  }
  return [...byId.values()];
}

function snapshotPath(config: TmuxConfig): string {
  return join(config.stateDirectory, "pi-mux-restore.json");
}

export class SnapshotReadError extends Error {}

export function readSnapshot(config: TmuxConfig): RestoreState | undefined {
  const path = snapshotPath(config);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SnapshotReadError(`Cannot read snapshot ${path}: ${errorMessage(error)}`);
  }
  const state = raw as Partial<Snapshot> | null;
  if (
    !state ||
    state.version !== 1 ||
    typeof state.generation !== "string" ||
    !Array.isArray(state.workspaces)
  )
    throw new SnapshotReadError(`Invalid snapshot: ${path}`);
  for (const workspace of state.workspaces) {
    if (
      !workspace ||
      typeof workspace.cwd !== "string" ||
      !isAbsolute(workspace.cwd) ||
      !Array.isArray(workspace.sessions)
    )
      throw new SnapshotReadError(`Invalid snapshot workspace: ${path}`);
    for (const id of workspace.sessions) {
      if (typeof id !== "string" || !SESSION_ID_PATTERN.test(id))
        throw new SnapshotReadError(`Invalid snapshot candidate: ${path}`);
    }
  }
  const sessions = state.workspaces.flatMap((workspace) =>
    workspace.sessions.map((id) => ({ id, cwd: workspace.cwd })),
  );
  try {
    uniqueCandidates(sessions);
  } catch (error) {
    throw new SnapshotReadError(errorMessage(error));
  }
  if (state.generation === "" && sessions.length > 0)
    throw new SnapshotReadError(`Invalid snapshot generation: ${path}`);
  return {
    version: 1,
    generation: state.generation,
    cwds: [...new Set(state.workspaces.map(({ cwd }) => cwd))],
    sessions,
  };
}

export function writeSnapshot(config: TmuxConfig, state: RestoreState): void {
  const workspaces = new Map<string, Workspace>(
    state.cwds.map((cwd) => [cwd, { cwd, sessions: [] }]),
  );
  for (const { id, cwd } of uniqueCandidates(state.sessions)) {
    let workspace = workspaces.get(cwd);
    if (!workspace) {
      workspace = { cwd, sessions: [] };
      workspaces.set(cwd, workspace);
    }
    workspace.sessions.push(id);
  }
  const snapshot: Snapshot = {
    version: state.version,
    generation: state.generation,
    workspaces: [...workspaces.values()],
  };
  const temporary = join(config.stateDirectory, `${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(snapshot) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, snapshotPath(config));
  if (platform.windows) return;
  const directory = openSync(config.stateDirectory, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function registerWorkspaces(config: TmuxConfig, cwds: string[]): void {
  const previous = readSnapshot(config);
  const registered = [...new Set([...(previous?.cwds ?? []), ...cwds])];
  if (registered.length === previous?.cwds.length) return;
  writeSnapshot(config, {
    ...previous,
    version: 1,
    generation: previous?.generation ?? "",
    cwds: registered,
    sessions: previous?.sessions ?? [],
  });
}
