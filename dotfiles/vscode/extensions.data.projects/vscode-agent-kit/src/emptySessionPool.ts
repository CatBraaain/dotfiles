import type * as vscode from "vscode";
import type { PiMux } from "./piMux";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { errorMessage } from "./guards";
import { readSessionStateStore, registeredWorkspaceCwds } from "./sessionStateStore";
import { sessionFileExists } from "./sessionStore";
import { requireWorkDirectory, sameWorkDirectory } from "./workDirectory";

interface EmptySession {
  id: string;
  file: string;
}

interface WorkspaceSlot {
  pending: boolean;
  refill: boolean;
  sessions: Map<string, EmptySession>;
}

export interface EmptySessionPoolDeps {
  statePath: string;
  mux: PiMux;
  onError: (message: string) => void;
  fileExists?: (path: string) => Promise<boolean>;
}

export class EmptySessionPool implements vscode.Disposable {
  private readonly workspaces = new Map<string, WorkspaceSlot>();
  private readonly physicalWorkspaces = new Map<string, WorkspaceSlot>();
  private readonly consumed = new Set<string>();
  private disposed = false;

  constructor(private readonly deps: EmptySessionPoolDeps) {}

  syncWorkspaces(): void {
    if (this.disposed) return;
    const state = readSessionStateStore(this.deps.statePath);
    if (state.status === "error") {
      this.deps.onError(state.message);
      return;
    }
    const registered = new Set(
      registeredWorkspaceCwds(state.status === "ok" ? state.data : undefined),
    );
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

  observeOpened(cwd: string, sessionId: string): void {
    const slot = this.workspaces.get(cwd);
    if (this.disposed || slot === undefined) return;
    void this.track(slot, sessionId).catch((error: unknown) => this.report(cwd, error));
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
  }

  private ensure(slot: WorkspaceSlot): void {
    const cwd = this.registeredCwd(slot);
    if (cwd === undefined || slot.pending) return;
    slot.pending = true;
    void this.prepare(cwd, slot)
      .catch((error: unknown) => this.report(cwd, error))
      .finally(() => {
        slot.pending = false;
        if (!slot.refill) return;
        slot.refill = false;
        this.ensure(slot);
      });
  }

  private async prepare(cwd: string, slot: WorkspaceSlot): Promise<void> {
    const directory = await requireWorkDirectory(cwd);
    const physicalDirectory = await realpath(directory);
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
    const session = (await this.deps.mux.list()).find((entry) => entry.id === sessionId);
    if (this.registeredCwd(slot) === undefined || this.consumed.has(sessionId)) return;
    if (
      session?.file === null ||
      session === undefined ||
      !isAbsolute(session.file) ||
      !(await sameWorkDirectory(session.cwd, cwd))
    ) {
      throw new Error(`Cannot locate the session file for Pi ${sessionId} in ${cwd}`);
    }
    if (this.registeredCwd(slot) === undefined || this.consumed.has(sessionId)) return;
    const empty = { id: sessionId, file: session.file };
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
      if (registeredSlot === slot) return cwd;
    }
    return undefined;
  }

  private report(cwd: string, error: unknown): void {
    if (!this.disposed) this.deps.onError(`Empty Pi session in ${cwd}: ${errorMessage(error)}`);
  }
}
