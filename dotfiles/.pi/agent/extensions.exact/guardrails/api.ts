import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { SandboxRunner, type ScopedExecution } from "./sandbox-runner.ts";

export type { ScopedExecution } from "./sandbox-runner.ts";
import { executeGuardedTool, type GuardedToolRequest } from "./execute.ts";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pathCovers } from "./config.ts";
import { Guardrail, writeApprovalNote } from "./guardrail.ts";
import { withNormalizedPath } from "./normalize-path.ts";
import { WorkerPool } from "./worker-pool.ts";

export function createGuardrailsAPI(pi: ExtensionAPI, configPath?: string): GuardrailsAPI {
  let active = true;
  function assertActive(): void {
    if (!active) throw new Error("guardrails API is no longer active");
  }
  const cwd = process.cwd();
  const guardrail = new Guardrail(cwd, configPath);
  const buildArgs = guardrail.buildArgs.bind(guardrail);
  const pool = new WorkerPool(cwd, buildArgs);
  const runner = new SandboxRunner(cwd, buildArgs, pool);

  const scopedExecution = new AsyncLocalStorage<ScopedExecutionState>();

  function getScopedExecutionState(id: string): ScopedExecutionState | undefined {
    const scope = scopedExecution.getStore();
    return scope?.id === id ? scope : undefined;
  }

  pi.registerTool({
    name: "ask_permission",
    label: "ask_permission",
    description:
      "ディレクトリとその配下への書き込み許可、または理由が必要として拒否されたコマンドの実行承認をユーザーに求める。" +
      " パスの場合は、実効書き込みルールが `ask` または未設定で、認証情報のパスでない場合に限って申請できる。明示的な `deny` と認証情報のパスは許可できない。" +
      " 対象パスで編集作業が多い場合は、着手前に使う。承認すると、対象ディレクトリとその配下に対する Guardrails の書き込み権限がセッション終了まで更新され、その権限を使うすべてのツールで共有される。明示的な `deny` と認証情報のパスは保護されたまま。" +
      " コマンドの場合は、拒否されたコマンドをそのまま渡す。ユーザーは1回限りで承認するか、一致した設定パターンをこのターン中またはセッション終了まで承認できる。" +
      " 1回限りの承認後は、同じ `bash` 呼び出しを再送すると確認なしで実行される。ターン承認は次のユーザーメッセージで失効する。",
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
    pool.shutdown();
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
      const scope = request.toolName === "bash" ? getScopedExecutionState(request.id) : undefined;
      if (!scope) return executeGuardedTool(guardrail, pool, cwd, request);
      const { call, command, sessionId } = scope;
      const signal = request.signal
        ? AbortSignal.any([scope.signal, request.signal])
        : scope.signal;
      if (scope.closed) throw new Error("Scoped execution grant has been revoked");
      if (
        scope.used ||
        request.params.command !== command ||
        request.context.sessionManager?.getSessionId() !== sessionId
      )
        throw new Error("Scoped execution grant does not match this Bash call");
      scope.used = true;
      signal.throwIfAborted();
      guardrail.assertScopedCommandAllowed([call.executable, ...call.args]);
      const protectedPaths = guardrail.planScopedWriteProtection(
        call.write?.paths ?? [],
        call.write?.directories ?? [],
        pool.sandboxed(),
        call.write?.unlinkSymlinks,
      );
      const result = await runner.runScopedExecution(
        call,
        protectedPaths,
        signal,
        request.executor,
      );
      scope.executed = true;
      return result;
    },
    grantScopedExecution(call, id, sessionId, signal) {
      assertActive();
      signal.throwIfAborted();
      call = validateScopedExecution(call, pool.sandboxed());
      const command = `/bin/false scoped-execution-${randomUUID()}`;
      const scope: ScopedExecutionState = {
        id,
        sessionId,
        call,
        command,
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
          if (scope.closed) throw new Error("Scoped execution grant has been revoked");
          return scopedExecution.run(scope, task);
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
    assertScopedWriteAllowed(paths, directories, unlinkSymlinks) {
      assertActive();
      if (directories === undefined) guardrail.assertScopedWriteAllowed(paths);
      else
        guardrail.planScopedWriteProtection(paths, directories, pool.sandboxed(), unlinkSymlinks);
    },
    grantExistingDirectory(path, validate) {
      assertActive();
      return guardrail.grantExistingDirectory(path, validate);
    },
  };
}

function validateScopedExecution(call: ScopedExecution, sandboxed: boolean): ScopedExecution {
  function absolute(path: string): boolean {
    return isAbsolute(path) && resolve(path) === path && !path.includes("\0");
  }
  function scopedDirectory(path: string): boolean {
    return absolute(path) && path !== dirname(path);
  }

  const { executable, cwd, args, env, allowedCodes, write } = call;
  if (
    !absolute(executable) ||
    !absolute(cwd) ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    Object.entries(env).some(
      ([key, val]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        (val !== undefined && (typeof val !== "string" || val.includes("\0"))),
    ) ||
    allowedCodes.some((code) => !Number.isInteger(code) || code < 1 || code > 255 || code === 125)
  )
    throw new Error("Invalid scoped execution input");
  const copy = {
    executable,
    cwd,
    args: [...args],
    env: { ...env },
    allowedCodes: [...allowedCodes],
  };
  if (!write) return copy;

  const {
    directories,
    paths,
    unlinkSymlinks,
    createDirectories,
    readOnlyView,
    readOnlyFile,
    validate,
  } = write;
  if (
    directories.length === 0 ||
    directories.some((path) => !scopedDirectory(path)) ||
    paths.some(
      (path) =>
        !absolute(path) ||
        !directories.some(
          (dir) =>
            pathCovers(dir, path) || (createDirectories?.includes(path) && pathCovers(path, dir)),
        ),
    ) ||
    createDirectories?.some((path) => !scopedDirectory(path) || !paths.includes(path)) ||
    unlinkSymlinks?.some(
      (path) =>
        !paths.includes(path) || directories.includes(path) || createDirectories?.includes(path),
    ) ||
    (readOnlyView &&
      (!scopedDirectory(readOnlyView.directory) ||
        readOnlyView.paths.some(
          (path) =>
            !scopedDirectory(path) ||
            path === readOnlyView.directory ||
            !pathCovers(readOnlyView.directory, path) ||
            directories.some((dir) => pathCovers(dir, path) || pathCovers(path, dir)),
        ) ||
        directories.some((path) => pathCovers(path, readOnlyView.directory)) ||
        !directories.some((path) => pathCovers(readOnlyView.directory, path)))) ||
    (readOnlyFile &&
      (!absolute(readOnlyFile.path) ||
        typeof readOnlyFile.contents !== "string" ||
        paths.some((path) => pathCovers(readOnlyFile.path, path)) ||
        directories.some((path) => pathCovers(readOnlyFile.path, path)) ||
        !(readOnlyView
          ? pathCovers(readOnlyView.directory, readOnlyFile.path) &&
            readOnlyFile.path !== readOnlyView.directory
          : directories.some(
              (path) => path !== readOnlyFile.path && pathCovers(path, readOnlyFile.path),
            ))))
  )
    throw new Error("Invalid scoped write plan");
  if (sandboxed) {
    const realExecutable = realpathSync.native(executable);
    if (
      directories.some((path) => pathCovers(path, executable) || pathCovers(path, realExecutable))
    )
      throw new Error("Scoped executable overlaps a writable directory");
  }
  return {
    ...copy,
    write: {
      paths: [...paths],
      directories: [...directories],
      unlinkSymlinks: unlinkSymlinks && [...unlinkSymlinks],
      createDirectories: createDirectories && [...createDirectories],
      readOnlyView: readOnlyView && {
        directory: readOnlyView.directory,
        paths: [...readOnlyView.paths],
      },
      readOnlyFile: readOnlyFile && { ...readOnlyFile },
      validate,
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
    'Before edit-heavy work on a requestable path, call ask_permission on the target subtree. After bash reports "Read-only file system", request access only for a requestable path. All tools using Guardrails write permissions share the approved scope and lifetime. Do not rewrite the command to retry.',
  ].join("\n");
}

type ScopedExecutionState = {
  id: string;
  sessionId: string;
  call: ScopedExecution;
  command: string;
  signal: AbortSignal;
  used: boolean;
  executed: boolean;
  closed: boolean;
};

type ScopedExecutionGrant = {
  command: string;
  readonly executed: boolean;
  run<T>(task: () => Promise<T>): Promise<T>;
  dispose(): void;
};

export type DirectoryWriteAccess = {
  grantScopedExecution(
    call: ScopedExecution,
    id: string,
    sessionId: string,
    signal: AbortSignal,
  ): ScopedExecutionGrant;
  assertDirectoryGrantAllowed(path: string): void;
  assertScopedWriteAllowed(
    paths: readonly string[],
    directories?: readonly string[],
    unlinkSymlinks?: readonly string[],
  ): void;
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
