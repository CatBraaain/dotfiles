import { basename, join } from "node:path";
import { homedir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const WORKTREE_COMMAND_NAME = "worktree";
export const WORKTREE_BACK_COMMAND_NAME = "worktree-back";
export const WORKTREE_TOOL_NAME = "worktree";
export const PROJECTS_DIR = join(homedir(), "projects");

export type ExecResult = { stdout: string; stderr: string; code: number };

/** Executes a git subcommand in a working directory. */
export type GitRunner = (
  args: string[],
  options?: { cwd?: string },
) => Promise<ExecResult>;

export type MigrateDeps = {
  git: GitRunner;
  /** Copies the session file with a rewritten cwd header and returns the new file path. */
  forkSession: (sourceFile: string, targetCwd: string) => string;
};

/** Generates the fallback branch name `wt-<yyyymmdd-hhmmss>` for a migration. */
export function generateBranchName(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const datePart = [
    String(date.getFullYear()),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("");
  const timePart = [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join(
    "",
  );
  return `wt-${datePart}-${timePart}`;
}

/** Builds the worktree path `<projectsDir>/<repoName>-<branch>`. */
export function buildWorktreePath(projectsDir: string, repoName: string, branch: string): string {
  return join(projectsDir, `${repoName}-${branch}`);
}

/** Extracts the main worktree path (first entry) from `git worktree list --porcelain`. */
export function parseMainWorktreePath(porcelainOutput: string): string | undefined {
  for (const block of porcelainOutput.split("\n\n")) {
    const worktreeLine = block
      .split("\n")
      .find((line) => line.startsWith("worktree "));
    if (worktreeLine) return worktreeLine.slice("worktree ".length);
  }
  return undefined;
}

/** A worktree migration failure with a user-facing message. */
export class WorktreeMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeMigrationError";
  }
}

function formatFailure(step: string, result: ExecResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return `${step} failed: ${detail}`;
}

export type MigrateOptions = {
  /** Current session working directory. */
  sourceCwd: string;
  /** Absolute path of the current session file. */
  sessionFile: string;
  /** Destination working directory (worktree path, or main worktree on the way back). */
  targetCwd: string;
  /** Branch to create for the new worktree. Omitted when migrating back to the main worktree. */
  createBranch?: string;
  /** Label attached to the stash entry used to carry uncommitted changes. */
  stashLabel: string;
};

export type MigrationOutcome = {
  newSessionFile: string;
  carriedChanges: boolean;
};

/**
 * Performs the file/git side of a migration: worktree creation, carrying
 * uncommitted changes, and forking the session file with a rewritten cwd.
 *
 * Session switching is deliberately left to the command handler so the old
 * `ctx` stays valid until `ctx.switchSession` is awaited as the last step.
 */
export async function migrateSession(
  deps: MigrateDeps,
  options: MigrateOptions,
): Promise<MigrationOutcome> {
  if (options.createBranch !== undefined) {
    const addResult = await deps.git(
      ["worktree", "add", options.targetCwd, "-b", options.createBranch],
      { cwd: options.sourceCwd },
    );
    if (addResult.code !== 0) {
      throw new WorktreeMigrationError(
        formatFailure("git worktree add", addResult),
      );
    }
  }

  let carriedChanges = false;
  const statusResult = await deps.git(["status", "--porcelain"], { cwd: options.sourceCwd });
  if (statusResult.code !== 0) {
    throw new WorktreeMigrationError(formatFailure("git status", statusResult));
  }
  if (statusResult.stdout.trim().length > 0) {
    const stashResult = await deps.git(
      ["stash", "push", "-u", "-m", options.stashLabel],
      { cwd: options.sourceCwd },
    );
    if (stashResult.code !== 0) {
      throw new WorktreeMigrationError(formatFailure("git stash push", stashResult));
    }
    const popResult = await deps.git(["stash", "pop"], { cwd: options.targetCwd });
    if (popResult.code !== 0) {
      throw new WorktreeMigrationError(
        `git stash pop failed; changes remain on the stash stack. Run "git stash list" in ${options.targetCwd} to recover. (${popResult.stderr.trim()})`,
      );
    }
    carriedChanges = true;
  }

  const newSessionFile = deps.forkSession(options.sessionFile, options.targetCwd);
  return { newSessionFile, carriedChanges };
}

type RepoContext = {
  /** Normalized repository root (`git rev-parse --show-toplevel`). */
  toplevel: string;
  /** Main worktree path from `git worktree list --porcelain`. */
  mainPath: string;
  isMainWorktree: boolean;
};

async function inspectRepo(git: GitRunner, cwd: string): Promise<RepoContext> {
  const [toplevelResult, porcelainResult] = await Promise.all([
    git(["rev-parse", "--show-toplevel"], { cwd }),
    git(["worktree", "list", "--porcelain"], { cwd }),
  ]);
  if (toplevelResult.code !== 0) {
    throw new WorktreeMigrationError(
      `not inside a git repository: ${cwd}`,
    );
  }
  if (porcelainResult.code !== 0) {
    throw new WorktreeMigrationError(formatFailure("git worktree list", porcelainResult));
  }
  const mainPath = parseMainWorktreePath(porcelainResult.stdout);
  if (!mainPath) {
    throw new WorktreeMigrationError("git worktree list returned no main worktree");
  }
  const toplevel = toplevelResult.stdout.trim();
  return { toplevel, mainPath, isMainWorktree: toplevel === mainPath };
}

async function switchToSession(
  ctx: ExtensionCommandContext,
  newSessionFile: string,
  message: string,
): Promise<void> {
  await ctx.switchSession(newSessionFile, {
    withSession: async (newCtx) => {
      newCtx.ui.notify(message, "info");
    },
  });
}

export default function worktreeExtension(
  pi: ExtensionAPI,
  overrides: {
    git?: GitRunner;
    projectsDir?: string;
    forkSession?: (sourceFile: string, targetCwd: string) => string;
  } = {},
): void {
  const git: GitRunner = overrides.git ?? ((args, options) => pi.exec("git", args, options));
  const projectsDir = overrides.projectsDir ?? PROJECTS_DIR;
  const deps: MigrateDeps = {
    git,
    forkSession:
      overrides.forkSession ??
      ((sourceFile, targetCwd) => {
        const forked = SessionManager.forkFrom(sourceFile, targetCwd).getSessionFile();
        if (!forked) throw new WorktreeMigrationError("forked session has no file");
        return forked;
      }),
  };

  const notifyError = (ctx: ExtensionCommandContext, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(message, "error");
  };

  pi.registerCommand(WORKTREE_COMMAND_NAME, {
    description:
      "Migrate this session into a git worktree at ~/projects/<repo>-<branch>, keeping the conversation",
    handler: async (args, ctx) => {
      try {
        const repo = await inspectRepo(git, ctx.cwd);
        if (!repo.isMainWorktree) {
          ctx.ui.notify("already in a worktree; use /worktree-back to return", "error");
          return;
        }
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile) {
          ctx.ui.notify("this session has no session file yet; send a message first", "error");
          return;
        }
        const branch = args.trim() || generateBranchName(new Date());
        const worktreePath = buildWorktreePath(projectsDir, basename(repo.toplevel), branch);
        const outcome = await migrateSession(deps, {
          sourceCwd: ctx.cwd,
          sessionFile,
          targetCwd: worktreePath,
          createBranch: branch,
          stashLabel: `worktree-migration:${branch}`,
        });
        const carried = outcome.carriedChanges ? " (uncommitted changes carried)" : "";
        await switchToSession(
          ctx,
          outcome.newSessionFile,
          `worktree session: ${branch} at ${worktreePath}${carried}`,
        );
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });

  pi.registerCommand(WORKTREE_BACK_COMMAND_NAME, {
    description: "Return a worktree session to the main worktree, keeping the conversation",
    handler: async (_args, ctx) => {
      try {
        const repo = await inspectRepo(git, ctx.cwd);
        if (repo.isMainWorktree) {
          ctx.ui.notify("already in the main worktree", "error");
          return;
        }
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile) {
          ctx.ui.notify("this session has no session file yet; send a message first", "error");
          return;
        }
        const outcome = await migrateSession(deps, {
          sourceCwd: ctx.cwd,
          sessionFile,
          targetCwd: repo.mainPath,
          stashLabel: "worktree-migration:back",
        });
        const carried = outcome.carriedChanges ? " (uncommitted changes carried)" : "";
        await switchToSession(ctx, outcome.newSessionFile, `back to ${repo.mainPath}${carried}`);
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });

  pi.registerTool({
    name: WORKTREE_TOOL_NAME,
    label: "Worktree",
    description:
      "Migrate this pi session into a dedicated git worktree so write-heavy work cannot collide with parallel sessions. Queues /worktree as a follow-up command.",
    promptSnippet: "Migrate this session into a dedicated git worktree",
    promptGuidelines: [
      "Use worktree (optionally with a descriptive branch name) before starting write-heavy work such as editing or creating multiple files, when the session is still on the main worktree.",
    ],
    parameters: Type.Object({
      branch: Type.Optional(
        Type.String({ description: "Branch name for the new worktree (default: auto-generated)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const command = params.branch
        ? `${WORKTREE_COMMAND_NAME} ${params.branch}`
        : WORKTREE_COMMAND_NAME;
      pi.sendUserMessage(`/${command}`, { deliverAs: "followUp", expandPromptTemplates: true });
      return {
        content: [
          { type: "text" as const, text: `Queued /${command} as a follow-up command.` },
        ],
        details: { command },
      };
    },
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "quit") return;
    try {
      const repo = await inspectRepo(git, ctx.cwd);
      if (repo.isMainWorktree) return;
      const status = await git(["status", "--porcelain"], { cwd: ctx.cwd });
      if (status.code !== 0) return; // best effort: keep the worktree on failure
      const dirty = status.stdout.trim().length > 0;
      if (dirty) {
        const branch = (await git(["branch", "--show-current"], { cwd: ctx.cwd })).stdout.trim();
        const message = `[pi] auto-commit on exit (${branch || "detached"})`;
        await git(["add", "-A"], { cwd: ctx.cwd });
        const commit = await git(["commit", "-m", message], { cwd: ctx.cwd });
        if (commit.code !== 0) {
          if (ctx.hasUI) {
            ctx.ui.notify(`worktree cleanup: ${formatFailure("git commit", commit)}`, "warning");
          }
          return;
        }
      }
      // Run removal from the main worktree; git refuses to remove the worktree
      // the process is currently sitting in.
      const remove = await git(["worktree", "remove", repo.toplevel], { cwd: repo.mainPath });
      if (remove.code !== 0 && ctx.hasUI) {
        ctx.ui.notify(`worktree cleanup: ${formatFailure("git worktree remove", remove)}`, "warning");
      }
    } catch {
      // Shutdown-time best effort: never block quitting on cleanup errors.
    }
  });
}
