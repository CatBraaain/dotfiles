import { basename, isAbsolute } from "node:path";
import type { ExecFile } from "./git-worktrees";
import { errorMessage } from "./guards";

export const SELECT_SCM_REPOSITORIES = "agentKit.scm.selectRepositories";

export interface DisplayedScmSession {
  readonly sessionId: string;
  readonly cwd: string;
}

interface SessionScmDeps {
  readonly sessionWorktrees: (sessionId: string, cwd: string) => Promise<string[] | undefined>;
  readonly isSessionUnsaved: (sessionId: string) => Promise<boolean>;
  readonly execFile: ExecFile;
  readonly detectedRoots: () => readonly string[] | undefined;
  readonly selectRepositories: (paths: string[]) => PromiseLike<unknown>;
  readonly log: (message: string) => void;
}

type SelectionResult = "applied" | "pending" | "unavailable";

interface TrackedScmSession extends DisplayedScmSession {
  files: Map<string, boolean>;
  worktrees?: string[];
  hasLoadedWorktrees: boolean;
}

interface RefreshRun {
  requested: boolean;
  readonly done: Promise<void>;
}

export class SessionScmSelection {
  private session: TrackedScmSession | undefined;
  private isEnabled = true;
  private version = 0;
  private refreshRun: RefreshRun | undefined;
  private selectionInFlight: Promise<SelectionResult> | undefined;
  private lastAttempt: { key: string; result: SelectionResult } | undefined;
  private lastProblem: string | undefined;

  constructor(private readonly deps: SessionScmDeps) {}

  track(session: DisplayedScmSession | undefined): void {
    const previous = this.session;
    if (previous?.sessionId === session?.sessionId && previous?.cwd === session?.cwd) return;
    this.session = session && { ...session, files: new Map(), hasLoadedWorktrees: false };
    this.version += 1;
    this.lastAttempt = undefined;
    this.lastProblem = undefined;
    void this.refresh();
  }

  updateSessionFiles(entries: readonly { id: string; file: string; isSaved: boolean }[]): void {
    const session = this.session;
    if (!session) return;
    const files = new Map<string, boolean>();
    for (const { id, file, isSaved } of entries) {
      if (id === session.sessionId && (isSaved || !files.has(file))) files.set(file, isSaved);
    }
    if (
      files.size === session.files.size &&
      [...files].every(([file, isSaved]) => session.files.get(file) === isSaved)
    )
      return;
    session.files = files;
    this.invalidateWorktrees(session);
  }

  onSessionFileChanged(filePath: string): void {
    const session = this.session;
    if (!session) return;
    const file = basename(filePath);
    const prefixEnd = file.indexOf("_");
    const sessionFile = `${session.sessionId}.jsonl`;
    const matchesId =
      file === sessionFile || (prefixEnd >= 0 && file.slice(prefixEnd + 1) === sessionFile);
    if (matchesId || session.files.has(filePath)) this.invalidateWorktrees(session);
  }

  async toggle(): Promise<void> {
    this.isEnabled = !this.isEnabled;
    this.version += 1;
    if (!this.isEnabled) {
      this.refreshRun = undefined;
      await this.selectionInFlight;
      return;
    }
    this.lastAttempt = undefined;
    if (this.session) this.session.worktrees = undefined;
    await this.refresh();
  }

  refresh(): Promise<void> {
    if (!this.isEnabled) return Promise.resolve();
    if (this.refreshRun !== undefined) {
      this.refreshRun.requested = true;
      return this.refreshRun.done;
    }
    const run: RefreshRun = {
      requested: true,
      done: Promise.resolve().then(() => this.drain(run)),
    };
    this.refreshRun = run;
    return run.done;
  }

  private invalidateWorktrees(session: TrackedScmSession): void {
    session.worktrees = undefined;
    this.version += 1;
    void this.refresh();
  }

  private async drain(run: RefreshRun): Promise<void> {
    while (this.refreshRun === run && run.requested) {
      run.requested = false;
      const session = this.session;
      const version = this.version;
      if (session === undefined) continue;
      try {
        await this.apply(session, version);
      } catch (error) {
        if (version === this.version)
          this.report(`SCM selection for Pi session ${session.sessionId}: ${errorMessage(error)}`);
      }
    }
    if (this.refreshRun === run) this.refreshRun = undefined;
  }

  private async apply(session: TrackedScmSession, version: number): Promise<void> {
    if (this.selectionInFlight !== undefined) {
      await this.selectionInFlight;
      if (version !== this.version) return;
    }
    const worktrees = session.worktrees ?? (await this.loadWorktrees(session, version));
    if (version !== this.version || worktrees === undefined) return;
    const paths = await resolveWorktreeScope(session.cwd, worktrees, this.deps.execFile);
    if (version !== this.version) return;

    const detected = this.deps.detectedRoots();
    const targets = [...paths].sort();
    const detectedTargets =
      detected === undefined ? null : targets.filter((path) => detected.includes(path));
    const key = JSON.stringify([targets, detectedTargets]);
    const attempt = this.lastAttempt;
    if (attempt?.key === key && attempt.result !== "pending") {
      if (attempt.result === "applied") this.lastProblem = undefined;
      return;
    }
    const selection = this.select(paths);
    this.selectionInFlight = selection;
    const result = await selection;
    this.selectionInFlight = undefined;
    if (version !== this.version) return;
    this.lastAttempt = { key, result };
    if (result === "applied") {
      this.lastProblem = undefined;
    } else {
      this.report(
        `SCM selection ${result} for Pi session ${session.sessionId}: ${paths.join(", ")}`,
      );
    }
  }

  private async loadWorktrees(
    session: TrackedScmSession,
    version: number,
  ): Promise<string[] | undefined> {
    const worktrees = await this.deps.sessionWorktrees(session.sessionId, session.cwd);
    if (worktrees !== undefined) session.hasLoadedWorktrees = true;
    if (version !== this.version) return undefined;
    if (worktrees === undefined) {
      const isUnsaved =
        !session.hasLoadedWorktrees && (await this.deps.isSessionUnsaved(session.sessionId));
      if (!isUnsaved || session.hasLoadedWorktrees)
        throw new Error("Saved session metadata is missing");
    }
    if (version !== this.version) return undefined;
    session.worktrees = worktrees ?? [];
    return session.worktrees;
  }

  private async select(paths: string[]): Promise<SelectionResult> {
    try {
      const result = await this.deps.selectRepositories(paths);
      return result === "applied" || result === "pending" ? result : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  private report(message: string): void {
    if (this.lastProblem === message) return;
    this.lastProblem = message;
    this.deps.log(message);
  }
}

function isAbsolutePath(path: unknown): path is string {
  return typeof path === "string" && isAbsolute(path) && !path.includes("\0");
}

async function resolveWorktreeScope(
  cwd: string,
  ownedPaths: readonly string[],
  execFile: ExecFile,
): Promise<string[]> {
  const [list, root] = await Promise.all([
    execFile("git", ["worktree", "list", "--porcelain", "-z"], { cwd }),
    execFile("git", ["rev-parse", "--show-toplevel"], { cwd }),
  ]);
  const [main, ...linked] = worktreePaths(list.stdout);
  const cwdRoot = root.stdout.replace(/\r?\n$/, "");
  if (main === undefined || (cwdRoot !== main && !linked.includes(cwdRoot)))
    throw new Error(`Could not resolve the main Git worktree from ${cwd}`);

  const candidates = ownedPaths.filter((path) => path !== main && linked.includes(path));
  if (candidates.length === 0) return [main];

  const common = await execFile(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd },
  );
  const existing = await Promise.all(
    candidates.map(async (path) => {
      try {
        const candidate = await execFile(
          "git",
          ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-prefix"],
          { cwd: path },
        );
        return candidate.stdout === `${common.stdout}\n` ? path : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return [main, ...existing.filter((path) => path !== undefined)];
}

function worktreePaths(porcelain: string): (string | undefined)[] {
  return porcelain
    .split("\0\0")
    .filter(Boolean)
    .map((record) => {
      const [root, ...fields] = record.split("\0");
      if (!root.startsWith("worktree ")) return undefined;
      const path = root.slice("worktree ".length);
      const isUnavailable = fields.some(
        (field) => field === "bare" || field === "prunable" || field.startsWith("prunable "),
      );
      return !isUnavailable && isAbsolutePath(path) ? path : undefined;
    });
}
