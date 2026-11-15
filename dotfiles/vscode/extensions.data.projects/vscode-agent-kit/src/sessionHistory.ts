import { open } from "node:fs/promises";
import { isRecord } from "./guards";
import type { PiMux, PiMuxHistoryEntry, PiMuxWorkspace } from "./piMux";

const HEADER_BYTES = 64 * 1024;
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

interface WorkspaceHistory {
  entries?: PiMuxHistoryEntry[];
  revision: number;
  dirty: boolean;
  failed?: boolean;
  retryMs: number;
  retryTimer?: ReturnType<typeof setTimeout>;
}

export class SessionHistory {
  private readonly workspaces = new Map<string, WorkspaceHistory>();
  private readonly files = new Map<string, string>();
  private readonly pendingFileChanges = new Map<string, { cwd: string; revision: number }>();
  private rootGeneration = 0;
  private liveFiles: { file: string; cwd: string }[] = [];
  private savedLiveFiles = new Set<string>();
  private pending: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private readonly mux: PiMux,
    private readonly retry: () => void,
    private readonly observeFiles: (files: readonly { file: string; cwd: string }[]) => void,
  ) {}

  sync(workspaces: readonly PiMuxWorkspace[]): void {
    const registered = new Set(workspaces.map(({ cwd }) => cwd));
    let changed = false;
    for (const [cwd, history] of this.workspaces) {
      if (registered.has(cwd)) continue;
      clearTimeout(history.retryTimer);
      this.workspaces.delete(cwd);
      changed = true;
    }
    for (const cwd of registered) {
      if (!this.workspaces.has(cwd)) {
        changed = true;
        this.workspaces.set(cwd, { revision: 0, dirty: true, retryMs: INITIAL_RETRY_MS });
      }
    }
    const savedLiveFiles = new Set<string>();
    for (const { cwd, sessions } of workspaces) {
      for (const { file } of sessions) {
        savedLiveFiles.add(file);
        if (this.savedLiveFiles.has(file)) continue;
        const history = this.workspaces.get(cwd)!;
        if (history.entries?.some((entry) => entry.file === file)) continue;
        history.revision += 1;
        history.dirty = true;
      }
    }
    this.savedLiveFiles = savedLiveFiles;
    const liveFiles = workspaces.flatMap(({ cwd, sessions, empty }) =>
      [...sessions, ...empty].map(({ file }) => ({ file, cwd })),
    );
    if (changed || JSON.stringify(liveFiles) !== JSON.stringify(this.liveFiles)) {
      this.liveFiles = liveFiles;
      this.publishFiles();
    }
  }

  invalidateAll(): void {
    for (const history of this.workspaces.values()) {
      history.revision += 1;
      history.dirty = true;
      clearTimeout(history.retryTimer);
      history.retryTimer = undefined;
    }
  }

  resetEntries(): void {
    this.rootGeneration += 1;
    this.files.clear();
    this.pendingFileChanges.clear();
    this.savedLiveFiles.clear();
    for (const history of this.workspaces.values()) {
      history.entries = undefined;
      history.failed = undefined;
      history.retryMs = INITIAL_RETRY_MS;
    }
    this.invalidateAll();
  }

  async fileChanged(file: string): Promise<boolean> {
    let cwd = this.files.get(file);
    if (cwd === undefined) cwd = await headerCwd(file);
    if (cwd === undefined) return false;
    const history = this.workspaces.get(cwd);
    if (history === undefined) return false;
    this.files.set(file, cwd);
    history.revision += 1;
    this.pendingFileChanges.set(file, { cwd, revision: history.revision });
    history.dirty = true;
    return true;
  }

  get entries(): PiMuxHistoryEntry[] {
    return [...this.workspaces.values()].flatMap(({ entries }) => entries ?? []);
  }

  get failed(): boolean {
    return [...this.workspaces.values()].some((history) => history.failed);
  }

  get ready(): boolean {
    return [...this.workspaces.values()].every(({ entries }) => entries !== undefined);
  }

  async load(visible: () => boolean): Promise<void> {
    if (this.pending !== undefined) return this.pending;
    const pending = this.drain(visible);
    this.pending = pending;
    try {
      await pending;
    } finally {
      this.pending = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const history of this.workspaces.values()) clearTimeout(history.retryTimer);
    this.workspaces.clear();
    this.files.clear();
    this.pendingFileChanges.clear();
  }

  private async drain(visible: () => boolean): Promise<void> {
    const batch = [...this.workspaces];
    for (const [cwd, history] of batch) {
      if (this.disposed || !visible()) return;
      if (
        this.workspaces.get(cwd) !== history ||
        !history.dirty ||
        history.retryTimer !== undefined
      )
        continue;
      const generation = this.rootGeneration;
      const revision = history.revision;
      history.dirty = false;
      try {
        const entries = await this.mux.history(cwd);
        if (
          this.disposed ||
          this.workspaces.get(cwd) !== history ||
          generation !== this.rootGeneration
        )
          continue;
        history.failed = false;
        history.entries = entries.filter((entry) => entry.cwd === cwd);
        history.retryMs = INITIAL_RETRY_MS;
        for (const [file, change] of this.pendingFileChanges) {
          if (change.cwd === cwd && change.revision <= revision)
            this.pendingFileChanges.delete(file);
        }
        this.publishFiles();
      } catch (error) {
        if (
          this.disposed ||
          this.workspaces.get(cwd) !== history ||
          generation !== this.rootGeneration
        )
          continue;
        history.failed = true;
        history.dirty = true;
        history.retryTimer = setTimeout(() => {
          history.retryTimer = undefined;
          if (!this.disposed) this.retry();
        }, history.retryMs);
        history.retryTimer.unref();
        history.retryMs = Math.min(history.retryMs * 2, MAX_RETRY_MS);
        throw error;
      }
    }
  }

  private publishFiles(): void {
    for (const [file, { cwd }] of this.pendingFileChanges) {
      if (!this.workspaces.has(cwd)) this.pendingFileChanges.delete(file);
    }
    this.files.clear();
    for (const { file, cwd } of [...this.entries, ...this.liveFiles]) this.files.set(file, cwd);
    for (const [file, { cwd }] of this.pendingFileChanges) this.files.set(file, cwd);
    this.observeFiles([...this.files].map(([file, cwd]) => ({ file, cwd })));
  }
}

async function headerCwd(file: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    const header: unknown = JSON.parse(line);
    return isRecord(header) && header.type === "session" && typeof header.cwd === "string"
      ? header.cwd
      : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || (isRecord(error) && error.code === "ENOENT")) return;
    throw error;
  } finally {
    await handle?.close();
  }
}
