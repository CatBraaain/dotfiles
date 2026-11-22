import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { quote } from "shell-quote";
import { SandboxRunner, worktreeRemovalArgs, type WorktreeRemoval } from "./sandbox-runner.ts";
import { executeGuardedTool, type GuardedToolRequest } from "./execute.ts";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Guardrail, writeApprovalNote } from "./guardrail.ts";
import { withNormalizedPath } from "./normalize-path.ts";

export function createGuardrailsAPI(pi: ExtensionAPI, configPath?: string): GuardrailsAPI {
  let active = true;
  function assertActive(): void {
    if (!active) throw new Error("guardrails API is no longer active");
  }
  const cwd = process.cwd();
  const guardrail = new Guardrail(cwd, configPath);
  const runner = new SandboxRunner(cwd, (mode, commandCwd) =>
    guardrail.buildArgs(mode, commandCwd),
  );

  const removalScope = new AsyncLocalStorage<RemovalScope>();

  function getRemovalScope(id: string): RemovalScope | undefined {
    const scope = removalScope.getStore();
    return scope?.id === id ? scope : undefined;
  }

  pi.registerTool({
    name: "ask_permission",
    label: "ask_permission",
    description:
      "Ask the user to grant write access to a directory subtree, or to approve a command rejected as requiring a reason. For a path: request access only when the effective write action is ask or unset and the path is not credentials; explicit deny and credentials cannot be granted. Use it before edit-heavy work on such a path; for a worktree, request its creation path or parent. Approval updates Guardrails write permissions for the subtree for the rest of the session. All tools using those permissions share the grant. Explicit deny and credentials remain protected. For a command: pass the exact rejected command; the user can approve it once (re-sending the same bash call runs it without another dialog) or approve its matched config pattern for this turn or the rest of the session. Turn approval expires at the next user message.",
    promptSnippet: "Ask the user for write access to a directory subtree or command approval",
    promptGuidelines: [
      writePermissionGuideline(guardrail.getWritePathsByFinalAction()),
      'When bash rejects a command with "Command requires a reason", call ask_permission with that exact command and a reason instead of rewriting the command.',
    ],
    // No Type.Union/anyOf here: some models (e.g. GLM-5.3-Flash) fail to generate
    // arguments for union schemas. See SPEC §3.
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            "Directory to request write access for. Absolute path (~ allowed); relative paths resolve against the current cwd. A file path requests its parent directory subtree.",
        }),
      ),
      command: Type.Optional(
        Type.String({
          description:
            'Exact command string that bash rejected with "Command requires a reason". Pass it verbatim; the user can approve it once, or approve its matched config pattern for this turn or the rest of the session. Turn approval expires at the next user message.',
        }),
      ),
      reason: Type.String({
        description:
          "Why write access or command execution is needed. Shown to the user in the confirmation dialog as a decision hint; keep it to one or two sentences.",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, context) {
      assertActive();
      const hasPath = typeof params.path === "string";
      const hasCommand = typeof params.command === "string";
      if (hasPath === hasCommand) {
        throw new Error(
          'ask_permission requires exactly one of "path" or "command", plus "reason". ' +
            'Example: {"path": "/some/dir", "reason": "..."} or {"command": "git push", "reason": "..."}',
        );
      }
      if (typeof params.command === "string") {
        const outcome = await guardrail.requestCommandPermission(
          params.command,
          params.reason.trim(),
          context,
        );
        const text =
          outcome.status === "granted"
            ? outcome.grant === "session"
              ? `User approved this command via ask_permission (in this session). Every command matching the pattern ${outcome.approvedPattern} now runs via bash without further confirmation for the rest of the session.`
              : outcome.grant === "turn"
                ? `User approved this command via ask_permission (in this turn). Every command matching the pattern ${outcome.approvedPattern} now runs via bash without further confirmation until the next user message.`
                : "User approved this command via ask_permission; re-send the same bash call to run it (one-shot)."
            : outcome.status === "already granted"
              ? outcome.approvedPattern !== undefined
                ? outcome.grant === "turn"
                  ? `No approval needed: every command matching the turn-approved pattern ${outcome.approvedPattern} runs via bash without confirmation until the next user message.`
                  : `No approval needed: every command matching the session-approved pattern ${outcome.approvedPattern} runs via bash without confirmation.`
                : `No approval needed: ${outcome.command} is allowed by config.`
              : `User denied this command.` +
                (outcome.reason === undefined ? "" : `\nUser reason: ${outcome.reason}`);
        return {
          content: [{ type: "text" as const, text }],
          details: {
            status: outcome.status,
            command: outcome.command,
            ...(outcome.status === "granted"
              ? {
                  grant: outcome.grant,
                  ...(outcome.approvedPattern !== undefined
                    ? { approvedPattern: outcome.approvedPattern }
                    : {}),
                }
              : {}),
            ...(outcome.status === "already granted" && outcome.approvedPattern !== undefined
              ? {
                  approvedPattern: outcome.approvedPattern,
                  ...(outcome.grant === "turn" ? { grant: "turn" } : {}),
                }
              : {}),
            ...(outcome.status === "denied" && outcome.reason !== undefined
              ? { reason: outcome.reason }
              : {}),
          },
        };
      }
      const normalized = withNormalizedPath(params) as { path: string };
      const outcome = await guardrail.requestWritePermission(
        resolve(cwd, normalized.path),
        params.reason.trim(),
        context,
      );
      const text =
        outcome.status === "granted"
          ? writeApprovalNote({
              operation: "write",
              scope: "directory",
              grantedPath: outcome.grantedPath,
            })
          : outcome.status === "already granted"
            ? `Already granted: Guardrails permits writes to the requested path ${resolve(cwd, normalized.path)}. All tools using Guardrails write permissions share this permission. No new permission was added.`
            : `User denied write access to ${outcome.grantedPath}.` +
              (outcome.reason === undefined ? "" : `\nUser reason: ${outcome.reason}`);
      return {
        content: [{ type: "text" as const, text }],
        details: {
          status: outcome.status,
          grantedPath: outcome.grantedPath,
          ...(outcome.status === "denied" && outcome.reason !== undefined
            ? { reason: outcome.reason }
            : {}),
        },
      };
    },
  });

  pi.on("input", () => {
    guardrail.expireTurnCommandApprovals();
    return { action: "continue" };
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "user") guardrail.expireTurnCommandApprovals();
  });
  pi.on("session_shutdown", () => {
    active = false;
    guardrail.clearDirectoryGrants();
    guardrail.expireTurnCommandApprovals();
  });
  pi.on("session_start", (_event, ctx) => {
    guardrail.clearDirectoryGrants();
    guardrail.expireTurnCommandApprovals();
    if (guardrail.invalidCommandPatterns.length === 0) return;
    const patterns = guardrail.invalidCommandPatterns.map((p) => JSON.stringify(p)).join(", ");
    ctx.ui.notify(`guardrails: ignoring invalid command regex patterns: ${patterns}`, "warning");
  });
  return {
    async execute(request) {
      assertActive();
      const scope = request.toolName === "bash" ? getRemovalScope(request.id) : undefined;
      if (!scope) return executeGuardedTool(guardrail, runner, cwd, request);
      const { removal, command, sessionId } = scope;
      const signal = request.signal
        ? AbortSignal.any([scope.signal, request.signal])
        : scope.signal;
      if (scope.closed) throw new Error("Worktree removal grant has been revoked");
      if (
        scope.used ||
        request.params.command !== command ||
        request.context.sessionManager?.getSessionId() !== sessionId
      )
        throw new Error("Worktree removal does not match this Bash call");
      scope.used = true;
      signal.throwIfAborted();
      await guardrail.authorizeCommand(
        quote(["git", ...worktreeRemovalArgs(removal)]),
        request.context,
      );
      assertActive();
      signal.throwIfAborted();
      if (scope.closed) throw new Error("Worktree removal grant has been revoked");
      guardrail.assertWorktreeRemovalAllowed(
        dirname(removal.path),
        join(removal.common, "worktrees"),
      );
      const result = await runner.runWorktreeRemoval(removal, scope.validate, signal);
      scope.executed = true;
      return result;
    },
    async confirmWorktreeRemoval(path, ctx, signal) {
      if (!ctx.hasUI) throw new Error("Worktree removal requires user confirmation");
      return guardrail.withUiLock(async () => {
        assertActive();
        signal.throwIfAborted();
        return ctx.ui.confirm("Remove managed worktree?", JSON.stringify(path), { signal });
      });
    },
    grantWorktreeRemoval(removal, id, sessionId, validate, signal) {
      assertActive();
      if (!runner.sandboxed()) throw new Error("Worktree removal requires bwrap isolation");
      signal.throwIfAborted();
      const command = `/bin/false worktree-removal-${randomUUID()}`;
      const scope: RemovalScope = {
        id,
        sessionId,
        removal,
        command,
        validate,
        signal,
        used: false,
        executed: false,
        closed: false,
      };
      return {
        command,
        get executed() {
          return scope.executed;
        },
        run(task) {
          if (scope.closed) throw new Error("Worktree removal grant has been revoked");
          return removalScope.run(scope, task);
        },
        dispose() {
          scope.closed = true;
        },
      };
    },
    assertDirectoryGrantAllowed(path) {
      assertActive();
      guardrail.assertDirectoryGrantAllowed(path);
    },
    grantExistingDirectory(path, validate) {
      assertActive();
      return guardrail.grantExistingDirectory(path, validate);
    },
  };
}

function writePermissionGuideline(paths: {
  allow: string[];
  ask: string[];
  deny: string[];
}): string {
  const listPaths = (action: string, paths: string[]) => [
    `${action}:`,
    ...(paths.length > 0 ? paths.map((path) => `- ${JSON.stringify(path)}`) : ["- (none)"]),
  ];
  return [
    "Effective write paths grouped by final action in guardrails.yaml:",
    ...listPaths("allow", paths.allow),
    ...listPaths("ask", paths.ask),
    ...listPaths("deny", paths.deny),
    "The last matching rule determines each action, not path specificity. Credentials override listed ancestors and are never listed.",
    "allow needs no permission request; ask requires approval to update Guardrails write permissions for the approved scope; deny cannot be granted. A path with no matching write rule can be requested unless it is a credential path.",
    'Before edit-heavy work on a requestable path, call ask_permission on the target subtree; for a worktree, use its creation path or parent. After bash reports "Read-only file system", request access only for a requestable path. All tools using Guardrails write permissions share the approved scope and lifetime. Do not rewrite the command to retry.',
  ].join("\n");
}

type RemovalScope = {
  id: string;
  sessionId: string;
  removal: WorktreeRemoval;
  command: string;
  validate: () => void;
  signal: AbortSignal;
  used: boolean;
  executed: boolean;
  closed: boolean;
};

type WorktreeRemovalGrant = {
  command: string;
  readonly executed: boolean;
  run<T>(task: () => Promise<T>): Promise<T>;
  dispose(): void;
};

export type DirectoryWriteAccess = {
  confirmWorktreeRemoval(
    path: string,
    ctx: ExtensionContext,
    signal: AbortSignal,
  ): Promise<boolean>;
  grantWorktreeRemoval(
    removal: WorktreeRemoval,
    id: string,
    sessionId: string,
    validate: () => void,
    signal: AbortSignal,
  ): WorktreeRemovalGrant;
  assertDirectoryGrantAllowed(path: string): void;
  grantExistingDirectory(path: string, validate?: () => boolean): () => void;
};

export type GuardrailsAPI = DirectoryWriteAccess & {
  execute(request: GuardedToolRequest): Promise<AgentToolResult<unknown>>;
};

const DIRECTORY_ACCESS_CHANNEL = "dotfiles.guardrails.directory-write-access";

type DirectoryAccessRequest = {
  sessionId: string;
  receive(access: DirectoryWriteAccess): void;
};

export function publishDirectoryWriteAccess(pi: ExtensionAPI, access: DirectoryWriteAccess): void {
  let sessionId: string | undefined;
  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
  });
  pi.on("session_shutdown", () => {
    sessionId = undefined;
  });
  pi.events.on(DIRECTORY_ACCESS_CHANNEL, (data) => {
    const request = data as DirectoryAccessRequest;
    if (
      sessionId !== undefined &&
      request?.sessionId === sessionId &&
      typeof request.receive === "function"
    )
      request.receive(access);
  });
}

export function getDirectoryWriteAccess(pi: ExtensionAPI, sessionId: string): DirectoryWriteAccess {
  let access: DirectoryWriteAccess | undefined;
  pi.events.emit(DIRECTORY_ACCESS_CHANNEL, {
    sessionId,
    receive(value) {
      access = value;
    },
  } satisfies DirectoryAccessRequest);
  if (!access) throw new Error("Guardrails directory write access is unavailable for this session");
  return access;
}

export type { GuardedToolContext, GuardedToolRequest } from "./execute.ts";
export { normalizeToolPath } from "./normalize-path.ts";
