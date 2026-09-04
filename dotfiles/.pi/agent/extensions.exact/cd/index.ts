import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const CD_COMMAND_NAME = "cd";
export const CD_TOOL_NAME = "cd";

/** User message sent after a tool-triggered move so the agent loop continues. */
export const RESUME_MESSAGE = "Continue the task in the new working directory.";

/** Expands a leading `~` to the home directory and resolves the rest against cwd. */
export function resolveTargetPath(rawPath: string, cwd: string): string {
  if (rawPath === "~") return homedir();
  if (rawPath.startsWith("~/")) return join(homedir(), rawPath.slice(2));
  return resolve(cwd, rawPath);
}

/** Returns true when the path exists and is a directory. */
export function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Copies the session file with a rewritten cwd header and returns the new file path. */
export type ForkSession = (sourceFile: string, targetCwd: string) => string;

async function switchToSession(
  ctx: ExtensionCommandContext,
  newSessionFile: string,
  message: string,
  resumeMessage?: string,
): Promise<void> {
  await ctx.switchSession(newSessionFile, {
    withSession: async (newCtx) => {
      newCtx.ui.notify(message, "info");
      if (resumeMessage !== undefined) {
        await newCtx.sendUserMessage(resumeMessage);
      }
    },
  });
}

export default function cdExtension(
  pi: ExtensionAPI,
  overrides: { forkSession?: ForkSession } = {},
): void {
  const forkSession: ForkSession =
    overrides.forkSession ??
    ((sourceFile, targetCwd) => {
      const forked = SessionManager.forkFrom(sourceFile, targetCwd).getSessionFile();
      if (!forked) throw new Error("forked session has no file");
      return forked;
    });

  const notifyError = (ctx: ExtensionCommandContext, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(message, "error");
  };

  // Set by the cd tool so a tool-triggered move resumes the agent loop after
  // the switch. Human-invoked commands leave it unset.
  let resumeNextSwitch = false;

  pi.registerCommand(CD_COMMAND_NAME, {
    description: "Move this session (conversation and context) to the given directory",
    handler: async (args, ctx) => {
      const resume = resumeNextSwitch;
      resumeNextSwitch = false;
      try {
        const rawPath = args.trim();
        if (!rawPath) {
          ctx.ui.notify("usage: /cd <path>", "error");
          return;
        }
        const target = resolveTargetPath(rawPath, ctx.cwd);
        if (!isDirectoryPath(target)) {
          ctx.ui.notify(`not a directory: ${target}`, "error");
          return;
        }
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile) {
          ctx.ui.notify("this session has no session file yet; send a message first", "error");
          return;
        }
        const newSessionFile = forkSession(sessionFile, target);
        await switchToSession(
          ctx,
          newSessionFile,
          `moved to ${target}`,
          resume ? RESUME_MESSAGE : undefined,
        );
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });

  pi.registerTool({
    name: CD_TOOL_NAME,
    label: "cd",
    description:
      "Switch this session's working directory to the given path. Queues /cd as a follow-up command.",
    promptSnippet: "Switch this session's working directory",
    promptGuidelines: [
      "bash `cd` only changes that shell's directory; the session cwd stays the same. Use the cd tool to move the session to another directory (a git worktree, another repository, etc.). Before starting write-heavy work, follow the git skill's worktree workflow: create a worktree and move the session there with cd.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description:
          "Destination directory. Absolute path (~ allowed); relative paths resolve against the current cwd",
      }),
    }),
    async execute(_toolCallId, params) {
      resumeNextSwitch = true;
      const command = `${CD_COMMAND_NAME} ${params.path}`;
      pi.sendUserMessage(`/${command}`, { deliverAs: "followUp", expandPromptTemplates: true });
      return {
        content: [{ type: "text" as const, text: `Queued /${command} as a follow-up command.` }],
        details: { command },
      };
    },
  });
}
