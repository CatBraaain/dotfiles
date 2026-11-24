import { statSync } from "node:fs";
import { win32 } from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { getWorkspaces, saveWorkspaces, type WorkspaceUpdate } from "./metadata.ts";
import {
  applyWorkspaceChanges,
  detectWorkspaceChanges,
  findWorktreeScopes,
  parseUnavailableDirectory,
  parseWorktreeSnapshot,
  retainLiveWorkspaces,
  WorktreeDirectoryUnavailable,
  type SnapshotQuery,
  type WorkspaceChanges,
  type WorktreeAction,
  type WorktreeScope,
  type WorktreeSnapshot,
} from "./worktrees.ts";

const MESSAGE_TYPE = "session-worktrees";
const NoticeSchema = Type.Object({ summary: Type.String() });
interface Observation {
  snapshot: WorktreeSnapshot;
  actions: WorktreeAction[];
  paths: string[];
  destinations: string[];
}
interface PendingCall {
  generation: number;
  sessionId: string;
  observations: Observation[];
}

export default function sessionMetadataExtension(pi: ExtensionAPI): void {
  let generation = 0;
  const enqueueMetadata = serialQueue();
  const pending = new Map<string, PendingCall>();

  function resetSession(): void {
    generation++;
    pending.clear();
  }

  function isCurrent(expected: number, ctx: ExtensionContext, sessionId: string): boolean {
    return generation === expected && ctx.sessionManager.getSessionId() === sessionId;
  }

  function snapshotQuery(ctx: ExtensionContext): SnapshotQuery {
    return async function query(request) {
      ctx.signal?.throwIfAborted();
      const args = ["worktree", "snapshot", JSON.stringify(request)];
      const result = await pi.exec(piMuxExecutable(), args, { cwd: ctx.cwd, signal: ctx.signal });
      ctx.signal?.throwIfAborted();
      const truncated = "truncated" in result && result.truncated === true;
      if (!result.killed && !truncated) {
        if (result.code === 0) return parseWorktreeSnapshot(result.stdout, request.paths.length);
        if (result.code === 1 && result.stdout === "") {
          const unavailable = parseUnavailableDirectory(result.stderr, request.paths.length);
          if (unavailable) throw unavailable;
        }
      }
      throw new Error(
        `Git worktree query failed: ${result.stderr || result.stdout || result.code}`,
      );
    };
  }

  function notifyFailure(error: unknown): void {
    pi.sendMessage(
      {
        customType: MESSAGE_TYPE,
        content: `Session worktree metadata update failed: ${errorMessage(error)}`,
        display: true,
        details: { summary: "Worktree metadata update failed" },
      },
      { deliverAs: "steer" },
    );
  }

  async function finishCall(toolCallId: string, ctx: ExtensionContext): Promise<void> {
    const call = pending.get(toolCallId);
    pending.delete(toolCallId);
    if (!call || !isCurrent(call.generation, ctx, call.sessionId)) return;
    try {
      await enqueueMetadata(async () => {
        if (!isCurrent(call.generation, ctx, call.sessionId)) return;
        const query = snapshotQuery(ctx);
        const after: WorktreeSnapshot[] = [];
        const changes: WorkspaceChanges = { added: [], moved: [], removed: [] };
        for (const observation of call.observations) {
          const snapshot = await query({
            shellDirectories: [],
            gitDirectories: [observation.snapshot.cwd],
            paths: [],
          });
          after.push(snapshot);
          const delta = detectWorkspaceChanges(
            observation.snapshot,
            snapshot,
            observation.actions,
            observation.paths,
          );
          changes.added.push(...delta.added);
          changes.moved.push(...delta.moved);
          changes.removed.push(...delta.removed);
        }
        if (!isCurrent(call.generation, ctx, call.sessionId)) return;
        const previous = getWorkspaces(ctx.sessionManager);
        const proposed = applyWorkspaceChanges(previous, changes);
        const live = await retainLiveWorkspaces(proposed, query, after);
        if (!isCurrent(call.generation, ctx, call.sessionId)) return;
        const update = saveWorkspaces(pi, ctx.sessionManager, call.sessionId, live);
        if (update.changed) notifyUpdated(pi, previous, update, changes);
      });
    } catch (error) {
      if (isCurrent(call.generation, ctx, call.sessionId)) notifyFailure(error);
    }
  }

  pi.on("session_start", resetSession);
  pi.on("session_shutdown", resetSession);

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
    const expected = generation;
    const sessionId = ctx.sessionManager.getSessionId();
    let scopes: WorktreeScope[];
    try {
      scopes = findWorktreeScopes(event.input.command);
    } catch {
      return;
    }
    if (scopes.length === 0) return;
    try {
      const observations: Observation[] = [];
      const query = snapshotQuery(ctx);
      for (const scope of scopes) {
        if (!isCurrent(expected, ctx, sessionId)) return;
        await observeScope(observations, scope, query);
      }
      if (isCurrent(expected, ctx, sessionId))
        pending.set(event.toolCallId, { generation: expected, sessionId, observations });
    } catch (error) {
      if (isCurrent(expected, ctx, sessionId)) notifyFailure(error);
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "bash") await finishCall(event.toolCallId, ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.durationMs !== undefined) await finishCall(event.toolCallId, ctx);
    else pending.delete(event.toolCallId);
  });

  pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => {
    const content =
      typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    const summary = Value.Check(NoticeSchema, message.details)
      ? message.details.summary
      : "Worktree metadata";
    return new Text(theme.fg("dim", options.expanded ? content : summary), options.outputPad, 0);
  });
}

export function piMuxExecutable(
  platform = process.platform,
  path = process.env.PATH ?? "",
  isFile = (candidate: string) => statSync(candidate, { throwIfNoEntry: false })?.isFile() ?? false,
): string {
  if (platform !== "win32") return "pi-mux";
  for (const entry of path.split(";")) {
    const directory = entry.replace(/^"(.*)"$/, "$1");
    if (!win32.isAbsolute(directory) || win32.parse(directory).root.length === 1) continue;
    const candidate = win32.join(directory, "pi-mux.exe");
    if (isFile(candidate)) return candidate;
  }
  throw new Error("pi-mux.exe not found on absolute Windows PATH directories");
}

async function observeScope(
  observations: Observation[],
  { actions, destinationIndexes, ...request }: WorktreeScope,
  query: SnapshotQuery,
): Promise<void> {
  let snapshot: WorktreeSnapshot;
  try {
    snapshot = await query(request);
  } catch (error) {
    if (!(error instanceof WorktreeDirectoryUnavailable)) throw error;
    const creating = observations.find((observation) =>
      observation.destinations.includes(error.directory),
    );
    if (!creating) throw error;
    mergeObservation(creating, actions, error.paths, destinationIndexes);
    return;
  }

  const existing = observations.find((observation) => observation.snapshot.cwd === snapshot.cwd);
  if (existing) {
    mergeObservation(existing, actions, snapshot.paths, destinationIndexes);
  } else {
    const destinations = destinationIndexes.map((index) => snapshot.paths[index]!);
    observations.push({ snapshot, actions, paths: [...snapshot.paths], destinations });
  }
}

function mergeObservation(
  observation: Observation,
  actions: WorktreeAction[],
  paths: string[],
  destinationIndexes: number[],
): void {
  observation.actions = [...new Set([...observation.actions, ...actions])];
  observation.paths.push(...paths);
  observation.destinations.push(...destinationIndexes.map((index) => paths[index]!));
}

function serialQueue() {
  let tail: Promise<void> = Promise.resolve();
  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

function notifyUpdated(
  pi: ExtensionAPI,
  previous: string[],
  update: WorkspaceUpdate,
  observed: WorkspaceChanges,
): void {
  const moved = observed.moved.filter(
    ({ from, to }) => previous.includes(from) && update.workspaces.includes(to),
  );
  const added = update.workspaces.filter(
    (path) => !previous.includes(path) && !moved.some((move) => move.to === path),
  );
  const removed = previous.filter(
    (path) => !update.workspaces.includes(path) && !moved.some((move) => move.from === path),
  );
  const changes = { added, moved, removed };
  const count = added.length + moved.length + removed.length;
  pi.sendMessage(
    {
      customType: MESSAGE_TYPE,
      content: `Session worktree metadata updated. ${JSON.stringify({ changes, workspaces: update.workspaces })}`,
      display: true,
      details: {
        summary: `Worktree metadata updated (${count} ${count === 1 ? "change" : "changes"})`,
        ...changes,
      },
    },
    { deliverAs: "steer" },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
