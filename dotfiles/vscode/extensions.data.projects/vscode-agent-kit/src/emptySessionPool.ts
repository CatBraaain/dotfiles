import type * as vscode from "vscode";
import type { PiMux, PiMuxWorkspace } from "./piMux";
import { realpath } from "node:fs/promises";
import { errorMessage, isRecord } from "./guards";
import { sessionFileExists } from "./sessionStore";
import { requireWorkDirectory, sameWorkDirectory } from "./workDirectory";

interface EmptySession {
  id: string;
  file: string;
}

interface WorkspaceSlot {
  directory?: string;
  pending: boolean;
  refill: boolean;
  sessions: Map<string, EmptySession>;
}

interface WorkspaceSuspension {
  directory?: string;
  aliases: Set<string>;
  completed: boolean;
  absentAliases: Set<string>;
}

export interface EmptySessionPoolDeps {
  mux: PiMux;
  onError: (message: string) => void;
  fileExists?: (path: string) => Promise<boolean>;
}

export class EmptySessionPool implements vscode.Disposable {
  private readonly workspaces = new Map<string, WorkspaceSlot>();
  private readonly physicalWorkspaces = new Map<string, WorkspaceSlot>();
  private readonly consumed = new Set<string>();
  private readonly suspensions = new Map<string, WorkspaceSuspension>();
  private readonly preparations = new Set<{
    cwd: string;
    directoryResolution: Promise<string | undefined>;
    promise: Promise<void>;
  }>();
  private disposed = false;

  constructor(private readonly deps: EmptySessionPoolDeps) {}

  syncWorkspaces(cwds: readonly string[]): void {
    if (this.disposed) return;
    const registered = new Set(cwds);
    for (const [cwd, suspension] of this.suspensions) {
      if (!suspension.completed) continue;
      if ([...suspension.absentAliases].some((alias) => registered.has(alias))) {
        this.suspensions.delete(cwd);
        continue;
      }
      for (const alias of suspension.aliases) {
        if (!registered.has(alias)) suspension.absentAliases.add(alias);
      }
    }
    for (const cwd of this.workspaces.keys()) {
      if (!registered.has(cwd)) this.workspaces.delete(cwd);
    }
    for (const [directory, slot] of this.physicalWorkspaces) {
      if (this.registeredCwd(slot) === undefined) this.physicalWorkspaces.delete(directory);
    }
    for (const cwd of registered) {
      if (this.workspaces.has(cwd)) continue;
      const slot: WorkspaceSlot = { pending: false, refill: false, sessions: new Map() };
      this.workspaces.set(cwd, slot);
      this.ensure(slot);
    }
  }

  async suspendWorkspace(cwd: string): Promise<void> {
    const suspension: WorkspaceSuspension = {
      aliases: new Set([cwd]),
      completed: false,
      absentAliases: new Set(),
    };
    this.suspensions.set(cwd, suspension);
    suspension.directory = await workspaceDirectory(cwd);
    await Promise.all(
      [...this.preparations].map(async (preparation) => {
        const directory = await preparation.directoryResolution.catch(() => undefined);
        if (preparation.cwd !== cwd && directory !== suspension.directory) return;
        suspension.aliases.add(preparation.cwd);
        await preparation.promise;
      }),
    );
    for (const [candidate, slot] of this.workspaces) {
      if (!this.isSuspended(candidate, slot.directory)) continue;
      slot.sessions.clear();
      slot.refill = false;
    }
  }

  completeUnregister(cwd: string): void {
    const suspension = this.suspensions.get(cwd);
    if (suspension !== undefined) suspension.completed = true;
  }

  async resumeWorkspace(cwd: string): Promise<void> {
    if (this.disposed || this.suspensions.size === 0) return;
    const directory = await workspaceDirectory(cwd);
    let resumed = false;
    for (const [candidate, suspension] of this.suspensions) {
      if (!suspension.aliases.has(cwd) && suspension.directory !== directory) continue;
      this.suspensions.delete(candidate);
      resumed = true;
    }
    if (!resumed) return;
    for (const slot of new Set(this.workspaces.values())) {
      if (slot.directory === directory || this.workspaces.get(cwd) === slot) this.ensure(slot);
    }
  }

  observeOpened(cwd: string, sessionId: string): void {
    if (this.disposed) return;
    void this.resumeWorkspace(cwd)
      .then(async () => {
        const slot = this.workspaces.get(cwd);
        if (slot !== undefined) await this.track(slot, sessionId);
      })
      .catch((error: unknown) => this.report(cwd, error));
  }

  onSessionFileChanged(file: string): void {
    if (this.disposed) return;
    for (const slot of new Set(this.workspaces.values())) {
      for (const session of slot.sessions.values()) {
        if (session.file !== file) continue;
        void this.consumeSaved(slot, session).catch((error: unknown) => {
          const cwd = this.registeredCwd(slot);
          if (cwd !== undefined) this.report(cwd, error);
        });
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.workspaces.clear();
    this.physicalWorkspaces.clear();
    this.suspensions.clear();
  }

  private ensure(slot: WorkspaceSlot): void {
    const cwd = this.registeredCwd(slot);
    if (cwd === undefined || slot.pending) return;
    slot.pending = true;
    const directoryResolution = findPrewarmDirectory(cwd);
    const promise = this.prepare(cwd, slot, directoryResolution)
      .catch((error: unknown) => this.report(cwd, error))
      .finally(() => {
        this.preparations.delete(preparation);
        slot.pending = false;
        if (!slot.refill) return;
        slot.refill = false;
        this.ensure(slot);
      });
    const preparation = { cwd, directoryResolution, promise };
    this.preparations.add(preparation);
  }

  private async prepare(
    cwd: string,
    slot: WorkspaceSlot,
    directoryResolution: Promise<string | undefined>,
  ): Promise<void> {
    const physicalDirectory = await directoryResolution;
    slot.directory = physicalDirectory;
    if (physicalDirectory === undefined) return;
    for (const [candidate, suspension] of this.suspensions) {
      if (
        suspension.completed &&
        suspension.absentAliases.size > 0 &&
        suspension.directory === physicalDirectory &&
        !suspension.aliases.has(cwd)
      )
        this.suspensions.delete(candidate);
    }
    if (this.registeredCwd(slot) === undefined) return;
    const shared = this.physicalWorkspaces.get(physicalDirectory);
    if (shared !== undefined && shared !== slot) {
      this.workspaces.set(cwd, shared);
      for (const [id, session] of slot.sessions) shared.sessions.set(id, session);
      if (slot.refill && shared.pending) shared.refill = true;
      this.ensure(shared);
      return;
    }
    this.physicalWorkspaces.set(physicalDirectory, slot);
    const registered = this.registeredCwd(slot);
    if (registered === undefined) return;
    const sessionId = await this.deps.mux.newSession(registered);
    if (this.registeredCwd(slot) === undefined) return;
    await this.track(slot, sessionId);
  }

  private async track(slot: WorkspaceSlot, sessionId: string): Promise<void> {
    const cwd = this.registeredCwd(slot);
    if (this.consumed.has(sessionId) || cwd === undefined) return;
    const file = await findPlannedSessionFile(await this.deps.mux.list(), sessionId, cwd);
    if (this.registeredCwd(slot) === undefined || this.consumed.has(sessionId)) return;
    const empty = { id: sessionId, file };
    slot.sessions.set(sessionId, empty);
    await this.consumeSaved(slot, empty);
  }

  private async consumeSaved(slot: WorkspaceSlot, session: EmptySession): Promise<void> {
    const saved = await (this.deps.fileExists ?? sessionFileExists)(session.file);
    if (!saved || this.registeredCwd(slot) === undefined || this.consumed.has(session.id)) return;
    this.consumed.add(session.id);
    slot.sessions.delete(session.id);
    if (slot.pending) slot.refill = true;
    else this.ensure(slot);
  }

  private registeredCwd(slot: WorkspaceSlot): string | undefined {
    if (this.disposed) return undefined;
    for (const [cwd, registeredSlot] of this.workspaces) {
      if (registeredSlot === slot && !this.isSuspended(cwd, slot.directory)) return cwd;
    }
    return undefined;
  }

  private isSuspended(cwd: string, directory: string | undefined): boolean {
    for (const suspension of this.suspensions.values()) {
      if (
        !suspension.aliases.has(cwd) &&
        (directory === undefined || suspension.directory !== directory)
      )
        continue;
      suspension.aliases.add(cwd);
      return true;
    }
    return false;
  }

  private report(cwd: string, error: unknown): void {
    if (!this.disposed) this.deps.onError(`Empty Pi session in ${cwd}: ${errorMessage(error)}`);
  }
}

async function workspaceDirectory(cwd: string): Promise<string> {
  try {
    return await realpath(cwd);
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return cwd;
    throw error;
  }
}

async function findPrewarmDirectory(cwd: string): Promise<string | undefined> {
  try {
    return await realpath(await requireWorkDirectory(cwd));
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Resolve the planned file path of a prewarmed session: the `empty` entry,
 * or the saved `sessions` entry when the conversation file appeared before tracking. */
async function findPlannedSessionFile(
  workspaces: readonly PiMuxWorkspace[],
  sessionId: string,
  cwd: string,
): Promise<string> {
  for (const workspace of workspaces) {
    const session =
      workspace.empty.find(({ id }) => id === sessionId) ??
      workspace.sessions.find(({ id }) => id === sessionId);
    if (session === undefined || !(await sameWorkDirectory(workspace.cwd, cwd))) continue;
    return session.file;
  }
  throw new Error(`Cannot locate the session file for Pi ${sessionId} in ${cwd}`);
}
