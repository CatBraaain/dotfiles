import type * as vscode from "vscode";
import { requireWorkDirectory } from "./workDirectory";
import { addActiveSession } from "./sessionStateStore";
import type { TerminalRegistry } from "./terminalRegistry";

export interface SessionLauncherDeps {
  statePath: string;
  registry: TerminalRegistry;
  onSessionStarted: (sessionId: string) => void | Promise<void>;
}

export class SessionLauncher implements vscode.Disposable {
  private disposed = false;

  constructor(private readonly deps: SessionLauncherDeps) {}

  async start(cwd: string): Promise<void> {
    await this.deps.registry.run(async () => {
      const workDir = await requireWorkDirectory(cwd);
      if (this.disposed) return;
      const sessionId = await this.deps.registry.mux.newSession(workDir);
      const result = addActiveSession(this.deps.statePath, workDir, sessionId);
      if (!result.ok) throw new Error(result.message);
      try {
        const { terminal } = await this.deps.registry.open({ sessionId, cwd: workDir });
        terminal.show();
      } finally {
        await this.deps.onSessionStarted(sessionId);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
  }
}
