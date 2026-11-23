import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ExecFile } from "./git-worktrees";
import { errorMessage, isRecord } from "./guards";

export const SELECT_SCM_REPOSITORIES = "agentKit.scm.selectRepositories";
const WORKTREE_METADATA_ENTRY = "session-worktree-metadata";

export interface DisplayedScmSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly filePath?: string;
}

interface SessionScmDeps {
  readonly execFile: ExecFile;
  readonly detectedRoots: () => readonly string[] | undefined;
  readonly selectRepositories: (paths: string[]) => PromiseLike<unknown>;
  readonly log: (message: string) => void;
}

export class SessionScmSelection {
  private session: DisplayedScmSession | undefined;
  private version = 0;
  private requested = false;
  private pending: Promise<void> | undefined;
  private worktreeMetadata: { signature: string; paths: string[] } | undefined;
  private hasSeenSessionFile = false;
  private lastAttempt: { key: string; result: "applied" | "pending" | "unavailable" } | undefined;
  private lastProblem: string | undefined;

  constructor(private readonly deps: SessionScmDeps) {}

  track(session: DisplayedScmSession | undefined): void {
    const previous = this.session;
    const sameScope = previous?.sessionId === session?.sessionId && previous?.cwd === session?.cwd;
    if (sameScope && previous?.filePath === session?.filePath) return;
    this.session = session;
    this.version += 1;
    this.worktreeMetadata = undefined;
    this.hasSeenSessionFile = false;
    if (!sameScope) {
      this.lastAttempt = undefined;
      this.lastProblem = undefined;
    }
    void this.refresh();
  }

  updateSessionFile(sessionId: string, filePath: string): void {
    const session = this.session;
    if (session?.sessionId === sessionId) this.track({ ...session, filePath });
  }

  onSessionFileChanged(filePath: string): void {
    if (filePath !== this.session?.filePath) return;
    this.version += 1;
    this.worktreeMetadata = undefined;
    void this.refresh();
  }

  refresh(): Promise<void> {
    this.requested = true;
    this.pending ??= this.drain();
    return this.pending;
  }

  private async drain(): Promise<void> {
    await Promise.resolve();
    while (this.requested) {
      this.requested = false;
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
    this.pending = undefined;
  }

  private async apply(session: DisplayedScmSession, version: number): Promise<void> {
    const ownedPaths = await this.loadOwnedWorktreePaths(session, version);
    if (version !== this.version) return;
    const paths = await resolveWorktreeScope(session.cwd, ownedPaths, this.deps.execFile);
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
    const result = await this.select(paths);
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

  private async loadOwnedWorktreePaths(
    { filePath, sessionId }: DisplayedScmSession,
    version: number,
  ): Promise<string[]> {
    if (filePath === undefined) return [];
    try {
      const file = await stat(filePath);
      if (version === this.version) this.hasSeenSessionFile = true;
      if (!file.isFile()) throw new Error("Session path is not a regular file");
      const { dev, ino, ctimeMs, mtimeMs, size } = file;
      const signature = JSON.stringify([dev, ino, ctimeMs, mtimeMs, size]);
      if (this.worktreeMetadata?.signature === signature) return this.worktreeMetadata.paths;
      const paths = parseOwnedWorktreePaths(await readFile(filePath, "utf8"), sessionId);
      if (version === this.version) this.worktreeMetadata = { signature, paths };
      return paths;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !this.hasSeenSessionFile) return [];
      throw new Error(`Could not read worktree metadata from ${filePath}: ${errorMessage(error)}`);
    }
  }

  private async select(paths: string[]): Promise<"applied" | "pending" | "unavailable"> {
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

function parseOwnedWorktreePaths(jsonl: string, sessionId: string): string[] {
  const lines = jsonl.split("\n");
  const headerIndex = lines.findIndex((line) => line.trim() !== "");
  if (headerIndex === -1) return [];
  const header: unknown = JSON.parse(lines[headerIndex]);
  if (!isRecord(header) || header.type !== "session" || typeof header.id !== "string" || !header.id)
    throw new Error("Invalid session header");
  if (header.id !== sessionId)
    throw new Error("Session header does not match the selected session");

  for (let index = lines.length - 1; index > headerIndex; index--) {
    const line = lines[index];
    if (line.trim() === "") continue;
    const entry: unknown = JSON.parse(line);
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== WORKTREE_METADATA_ENTRY)
      continue;
    if (!isRecord(entry.data) || entry.data.sessionId !== header.id) continue;
    return validateWorktreePaths(entry.data.workspaces);
  }
  return [];
}

function validateWorktreePaths(workspaces: unknown): string[] {
  if (!Array.isArray(workspaces)) throw new Error("Invalid worktree metadata paths");
  const paths = new Set<string>();
  for (const path of workspaces) {
    if (!isAbsolutePath(path) || resolve(path) !== path || paths.has(path))
      throw new Error("Invalid worktree metadata paths");
    paths.add(path);
  }
  return [...paths];
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
