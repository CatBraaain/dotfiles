import {
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { getWorkspaces, saveWorkspaces, type WorkspaceUpdate } from "./metadata.ts";
import {
  applyWorkspaceChanges,
  detectWorkspaceChanges,
  findWorktreeScopes,
  loadWorktreeSnapshot,
  normalizeWorkspacePath,
  retainLiveWorkspaces,
  type BashQuery,
  type WorkspaceChanges,
  type WorktreeAction,
  type WorktreeScope,
  type WorktreeSnapshot,
} from "./worktrees.ts";

const MESSAGE_TYPE = "session-worktrees";
const NoticeSchema = Type.Object({ summary: Type.String() });
const QueryDetailsSchema = Type.Object({
  truncation: Type.Optional(Type.Object({ truncated: Type.Optional(Type.Boolean()) })),
});
interface Observation {
  snapshot: WorktreeSnapshot;
  actions: WorktreeAction[];
  paths: string[];
}
interface PendingCall {
  generation: number;
  sessionId: string;
  observations: Observation[];
}

export default function sessionMetadataExtension(pi: ExtensionAPI): void {
  let generation = 0;
  let updateQueue: Promise<void> = Promise.resolve();
  const pending = new Map<string, PendingCall>();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = updateQueue.then(task);
    updateQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function isCurrent(expected: number, ctx: ExtensionContext, sessionId: string): boolean {
    return generation === expected && ctx.sessionManager.getSessionId() === sessionId;
  }

  function backgroundRunner(ctx: ExtensionContext): BashQuery {
    return async function run(command) {
      ctx.signal?.throwIfAborted();
      const result = await pi.exec("bash", ["-c", command], { cwd: ctx.cwd, signal: ctx.signal });
      ctx.signal?.throwIfAborted();
      if (
        result.code !== 0 ||
        result.killed ||
        ("truncated" in result && result.truncated === true)
      )
        throw new Error(`Git worktree query failed: ${result.stderr || result.stdout}`);
      return result.stdout;
    };
  }

  function toolRunner(ctx: ExtensionToolContext, signal: AbortSignal | undefined): BashQuery {
    return async function run(command) {
      signal?.throwIfAborted();
      const outcome = await ctx
        .executeTool("bash", { command }, { signal })
        .catch((error: unknown) => {
          throw new QueryFailure(error);
        });
      try {
        signal?.throwIfAborted();
        const text = queryText(outcome.result);
        if (outcome.isError) throw new Error(`Git worktree query failed: ${text}`);
        return text;
      } catch (error) {
        throw new QueryFailure(error, outcome);
      }
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
      await enqueue(async () => {
        if (!isCurrent(call.generation, ctx, call.sessionId)) return;
        const run = backgroundRunner(ctx);
        const after: WorktreeSnapshot[] = [];
        const changes: WorkspaceChanges = { added: [], moved: [], removed: [] };
        for (const observation of call.observations) {
          const snapshot = await loadWorktreeSnapshot(observation.snapshot.cwd, run);
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
        const live = await retainLiveWorkspaces(proposed, run, after);
        if (!isCurrent(call.generation, ctx, call.sessionId)) return;
        const update = saveWorkspaces(pi, ctx.sessionManager, live);
        if (update.changed) notifyUpdated(pi, previous, update, changes);
      });
    } catch (error) {
      if (isCurrent(call.generation, ctx, call.sessionId)) notifyFailure(error);
    }
  }

  pi.on("session_start", () => {
    generation++;
    pending.clear();
  });

  pi.on("session_shutdown", () => {
    generation++;
    pending.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
    const expected = generation;
    const sessionId = ctx.sessionManager.getSessionId();
    let scopes: WorktreeScope[];
    try {
      scopes = findWorktreeScopes(event.input.command, ctx.cwd);
    } catch {
      return;
    }
    if (scopes.length === 0) return;
    try {
      const observations: Observation[] = [];
      for (const scope of scopes) {
        const known = observations.find(
          (observation) =>
            observation.snapshot.cwd === scope.cwd ||
            observation.snapshot.worktrees.some((worktree) => worktree.path === scope.cwd) ||
            observation.paths.includes(scope.cwd),
        );
        const snapshot =
          known?.snapshot ?? (await loadWorktreeSnapshot(scope.cwd, backgroundRunner(ctx)));
        const existing =
          known ?? observations.find((observation) => observation.snapshot.cwd === snapshot.cwd);
        if (existing) {
          existing.actions = [...new Set([...existing.actions, ...scope.actions])];
          existing.paths.push(...scope.paths);
        } else observations.push({ snapshot, actions: scope.actions, paths: scope.paths });
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

  pi.registerTool({
    name: "session_worktree",
    label: "Session worktree",
    description:
      "Register or unregister a Git worktree for the calling session. Use for an existing worktree or a handoff from another session. Returns the updated workspaces after the standard session API accepts the snapshot. Does not create or delete worktrees.",
    parameters: Type.Object({
      action: StringEnum(["register", "unregister"] as const),
      path: Type.String({
        minLength: 1,
        description: "Worktree root, absolute or relative to the session cwd",
      }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const expected = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      return enqueue(async () => {
        if (!isCurrent(expected, ctx, sessionId))
          throw new Error("Session changed before worktree registration");
        const path = normalizeWorkspacePath(params.path, ctx.cwd);
        const run = toolRunner(ctx, signal);
        const snapshots: WorktreeSnapshot[] = [];
        if (params.action === "register") {
          const snapshot = await loadWorktreeSnapshot(path, run);
          if (!snapshot.worktrees.some((worktree) => worktree.path === path))
            throw new Error(`Not a Git worktree root: ${path}`);
          snapshots.push(snapshot);
        }
        if (!isCurrent(expected, ctx, sessionId))
          throw new Error("Session changed during worktree registration");
        const previous = getWorkspaces(ctx.sessionManager);
        const proposed =
          params.action === "register"
            ? [...previous, path]
            : previous.filter((workspace) => workspace !== path);
        const live = await retainLiveWorkspaces(proposed, run, snapshots);
        if (!isCurrent(expected, ctx, sessionId))
          throw new Error("Session changed during worktree registration");
        const update = saveWorkspaces(pi, ctx.sessionManager, live);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(update) }],
          details: update,
        };
      }).catch((error: unknown) => {
        if (error instanceof QueryFailure && error.response)
          return {
            content: [
              {
                type: "text" as const,
                text: `Session worktree ${params.action} failed for ${params.path}: ${errorMessage(error.reason)}`,
              },
            ],
            isError: true,
            details: { bash: error.response, reason: error.reason },
          };
        if (error instanceof QueryFailure) throw error.reason;
        if (signal?.aborted) throw signal.reason;
        throw new Error(
          `Session worktree ${params.action} failed for ${params.path}: ${errorMessage(error)}`,
          { cause: error },
        );
      });
    },
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

class QueryFailure extends Error {
  constructor(
    readonly reason: unknown,
    readonly response?: Awaited<ReturnType<ExtensionToolContext["executeTool"]>>,
  ) {
    super(errorMessage(reason));
  }
}

function queryText(result: {
  content: { type: string; text?: string }[];
  details?: unknown;
  isError?: boolean;
}): string {
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  if (result.isError) throw new Error(`Git worktree query failed: ${text}`);
  if (Value.Check(QueryDetailsSchema, result.details) && result.details.truncation?.truncated)
    throw new Error("Git worktree query was truncated");
  return text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
