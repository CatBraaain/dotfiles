import type * as vscode from "vscode";
import { requireWorkDirectory } from "./workDirectory";
import { addActiveSession } from "./sessionStateStore";
import type { TerminalRegistry } from "./terminalRegistry";
import type { EmptySessionPool } from "./emptySessionPool";

export interface SessionLauncherDeps {
  statePath: string;
  registry: TerminalRegistry;
  emptySessions?: EmptySessionPool;
  onSessionStarted: (sessionId: string) => void | Promise<void>;
}

export class SessionLauncher implements vscode.Disposable {
  private disposed = false;

  constructor(private readonly deps: SessionLauncherDeps) {}

  async start(cwd: string): Promise<string | undefined> {
    const workDir = await requireWorkDirectory(cwd);
    if (this.disposed) return;
    this.deps.registry.presentExisting();
    return this.deps.registry.run(async () => {
      if (this.disposed) return;
      const sessionId = await this.deps.registry.mux.newSession(workDir);
      const previousSessionId = this.deps.registry.displayedSessionId;
      const { terminal } = await this.deps.registry.open({ sessionId, cwd: workDir });
      terminal.show();
      if (this.disposed) return;
      this.deps.emptySessions?.observeOpened(workDir, sessionId);
      const registration = addActiveSession(this.deps.statePath, workDir, sessionId);
      if (!registration.ok) throw new Error(registration.message);
      await this.deps.onSessionStarted(sessionId);
      return previousSessionId;
    });
  }

  dispose(): void {
    this.disposed = true;
  }
}
