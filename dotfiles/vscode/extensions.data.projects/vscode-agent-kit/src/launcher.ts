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
    const presentation = this.deps.registry.presentNew(workDir).then(
      (terminal) => ({ ok: true as const, terminal }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    return this.deps.registry.run(async () => {
      const result = await presentation;
      if (this.disposed) return;
      if (!result.ok) throw result.error;
      const previousSessionId = this.deps.registry.displayedSessionId;
      const runtime = await this.deps.registry.openNew(workDir, result.terminal);
      if (this.disposed) return;
      this.deps.emptySessions?.observeOpened(workDir, runtime.sessionId);
      const registration = addActiveSession(this.deps.statePath, workDir, runtime.sessionId);
      if (!registration.ok) throw new Error(registration.message);
      await this.deps.onSessionStarted(runtime.sessionId);
      return previousSessionId;
    });
  }

  dispose(): void {
    this.disposed = true;
  }
}
