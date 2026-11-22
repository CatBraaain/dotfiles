import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { getDirectoryWriteAccess } from "../guardrails/api.ts";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  getDeclarations,
  getWorkspaces,
  isWorktreeName,
  saveDeclarations,
  saveWorkspaces,
  WORKTREE_NAME_PATTERN,
  type WorkspaceUpdate,
} from "./metadata.ts";
import {
  createDeclaredWorktree,
  loadDeclarationRepository,
  managedWorktreePath,
  pathExists,
  planWorktreeRemoval,
  verifyDeclaredWorktree,
} from "./declarations.ts";
import {
  applyWorkspaceChanges,
  detectWorkspaceChanges,
  findWorktreeScopes,
  loadWorktreeSnapshot,
  retainLiveWorkspaces,
  type BashQuery,
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
}
interface PendingCall {
  generation: number;
  sessionId: string;
  observations: Observation[];
}

export default function sessionMetadataExtension(pi: ExtensionAPI, home = homedir()): void {
  let generation = 0;
  let lifetime = new AbortController();
  const granted = new Map<string, () => void>();

  function revoke(name: string): void {
    granted.get(name)?.();
    granted.delete(name);
  }

  function resetSession(): void {
    lifetime.abort();
    lifetime = new AbortController();
    generation++;
    pending.clear();
    for (const name of granted.keys()) revoke(name);
  }
  const enqueueMetadata = serialQueue();
  const enqueueDeclaration = serialQueue();
  const pending = new Map<string, PendingCall>();

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

  pi.on("session_start", resetSession);
  pi.on("session_shutdown", resetSession);

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
      "Declare a named worktree for this session before editing it. Reuses an existing managed worktree or creates one from the repository's main HEAD. Unregister only clears the declaration and its write grant. Remove deletes an existing managed worktree after user confirmation, without forcing removal or deleting its branch.",
    reachesTools: (input) => (input?.action === "remove" ? ["bash"] : []),
    parameters: Type.Object({
      action: StringEnum(["declare", "unregister", "remove"] as const),
      name: Type.String({
        pattern: WORKTREE_NAME_PATTERN,
        description: "Managed worktree name in kebab-case",
      }),
    }),
    async execute(id, { action, name }, signal, _onUpdate, ctx) {
      if (!isWorktreeName(name)) throw new Error(`Invalid worktree name: ${name}`);
      if (action !== "declare" && action !== "unregister" && action !== "remove")
        throw new Error("Invalid worktree action");
      const expected = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      const operationSignal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);

      function checkCurrent(): void {
        if (!isCurrent(expected, ctx, sessionId))
          throw new Error("Session changed during the worktree operation");
        operationSignal.throwIfAborted();
      }

      let target: string | undefined;
      return enqueueDeclaration(async () => {
        checkCurrent();
        if (action === "unregister") {
          revoke(name);
          const previous = getDeclarations(ctx.sessionManager);
          const worktrees = previous.filter((entry) => entry.name !== name);
          const changed = saveDeclarations(pi, previous, worktrees);
          return toolResult({ name, changed, worktrees });
        }

        const access = getDirectoryWriteAccess(pi, sessionId);
        const previous = getDeclarations(ctx.sessionManager);
        const repository = await loadDeclarationRepository(ctx.cwd, operationSignal);
        const path = managedWorktreePath(home, repository.main, name);
        target = path;
        checkCurrent();
        if (action === "remove") {
          const existing = verifyDeclaredWorktree(repository, path);
          if (!existing) throw new Error(`Not a linked worktree of this repository: ${path}`);
          if (!(await access.confirmWorktreeRemoval(path, ctx, operationSignal)))
            throw new Error("Worktree removal was not approved");
          checkCurrent();
          const removal = await planWorktreeRemoval(repository, path, existing, operationSignal);
          function validate(): void {
            checkCurrent();
            if (!existing?.isCurrent()) throw new Error(`Worktree changed before removal: ${path}`);
          }
          let failure: { cause: unknown } | undefined;
          const grant = access.grantWorktreeRemoval(
            removal,
            `${id}/1`,
            sessionId,
            validate,
            operationSignal,
          );
          try {
            const outcome = await grant.run(() =>
              ctx.executeTool("bash", { command: grant.command }, { signal: operationSignal }),
            );
            if (outcome.isError || outcome.result.isError)
              throw new Error(
                outcome.result.content
                  .map((part) => (part.type === "text" ? part.text : ""))
                  .join("\n"),
              );
            if (!grant.executed) throw new Error("Guardrails did not run the scoped Bash call");
          } catch (cause) {
            failure = { cause };
          } finally {
            grant.dispose();
          }
          checkCurrent();
          const remaining = await loadDeclarationRepository(repository.main, operationSignal);
          checkCurrent();
          const registered = remaining.subtrees.has(path);
          const exists = pathExists(path);
          if (remaining.common !== repository.common || remaining.main !== repository.main)
            throw new Error(`Repository changed during removal: ${path}`);
          if (registered !== exists)
            throw new Error(
              `Incomplete removal: directory ${exists ? "exists" : "is absent"}, Git registration ${registered ? "exists" : "is absent"}`,
              failure,
            );
          if (failure) throw failure.cause;
          if (exists) throw new Error(`Git did not remove the worktree: ${path}`);
          const worktrees = previous.filter((entry) => entry.name !== name || entry.path !== path);
          revoke(name);
          saveDeclarations(pi, previous, worktrees);
          await enqueueMetadata(async () => {
            if (!isCurrent(expected, ctx, sessionId)) return;
            try {
              const recorded = getWorkspaces(ctx.sessionManager);
              const update = saveWorkspaces(
                pi,
                ctx.sessionManager,
                recorded.filter((workspace) => workspace !== path),
              );
              if (update.changed)
                notifyUpdated(pi, recorded, update, { added: [], moved: [], removed: [path] });
            } catch (error) {
              notifyFailure(error);
            }
          });
          return toolResult({ name, path, status: "removed", worktrees });
        }
        access.assertDirectoryGrantAllowed(path);
        const live = previous.filter((entry) => {
          if (verifyDeclaredWorktree(repository, entry.path)) return true;
          revoke(entry.name);
          return false;
        });
        const existing = verifyDeclaredWorktree(repository, path);
        if (!existing && pathExists(path))
          throw new Error(`Not a linked worktree of this repository: ${path}`);
        const worktree =
          existing ?? (await createDeclaredWorktree(repository, path, name, operationSignal));
        checkCurrent();
        if (!worktree.isCurrent()) throw new Error(`Worktree changed before declaration: ${path}`);
        const declaration = { name, path };
        const worktrees = live.some((entry) => entry.name === name && entry.path === path)
          ? live
          : [...live.filter((entry) => entry.name !== name && entry.path !== path), declaration];
        saveDeclarations(pi, previous, worktrees);
        const revokeGrant = access.grantExistingDirectory(path, worktree.isCurrent);
        revoke(name);
        granted.set(name, revokeGrant);
        return toolResult({ ...declaration, status: existing ? "reused" : "created", worktrees });
      }).catch((error: unknown) => {
        throw new Error(
          `Session worktree ${action} failed for ${target ?? name}: ${errorMessage(error)}`,
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

function toolResult<T>(details: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
