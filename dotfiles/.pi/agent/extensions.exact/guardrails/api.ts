import { SandboxRunner } from "./sandbox-runner.ts";
import { executeGuardedTool, type GuardedToolRequest } from "./execute.ts";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve } from "node:path";
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

  pi.registerTool({
    name: "ask_permission",
    label: "ask_permission",
    description:
      "Ask the user to grant write access to a directory subtree, or to approve a command rejected as requiring a reason. For a path: request access only when the effective write action is ask or unset and the path is not credentials; explicit deny and credentials cannot be granted. Use it before edit-heavy work on such a path; for a worktree, request its creation path or parent. Once approved, the subtree becomes writable for the rest of the session (paths resolving to ask in the config stay read-only in the bash sandbox). For a command: pass the exact rejected command; the user can approve it once (re-sending the same bash call runs it without another dialog) or approve its matched config pattern for this turn or the rest of the session. Turn approval expires at the next user message.",
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
              bashWritable: outcome.bashWritable,
            })
          : outcome.status === "already granted"
            ? outcome.bashWritable
              ? `Already granted: ${outcome.grantedPath} is writable for the rest of the session, including via bash.`
              : `Already granted: ${outcome.grantedPath} is writable via fs tools, but not via bash.`
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
    guardrail.expireTurnCommandApprovals();
  });
  pi.on("session_start", (_event, ctx) => {
    guardrail.expireTurnCommandApprovals();
    if (guardrail.invalidCommandPatterns.length === 0) return;
    const patterns = guardrail.invalidCommandPatterns.map((p) => JSON.stringify(p)).join(", ");
    ctx.ui.notify(`guardrails: ignoring invalid command regex patterns: ${patterns}`, "warning");
  });
  return {
    async execute(request) {
      assertActive();
      return executeGuardedTool(guardrail, runner, cwd, request);
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
    "allow needs no permission request; ask can be requested but remains read-only through bash; deny cannot be granted. A path with no matching write rule can be requested unless it is a credential path.",
    'Before edit-heavy work on a requestable path, call ask_permission on the target subtree; for a worktree, use its creation path or parent. After bash reports "Read-only file system", request access only for a requestable path, respect whether the result permits bash writes, and do not rewrite the command to retry.',
  ].join("\n");
}

export type GuardrailsAPI = {
  execute(request: GuardedToolRequest): Promise<AgentToolResult<unknown>>;
};

export type { GuardedToolRequest } from "./execute.ts";
