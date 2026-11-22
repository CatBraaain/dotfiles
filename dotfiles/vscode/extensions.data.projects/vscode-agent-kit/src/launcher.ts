import type * as vscode from "vscode";
import { requireWorkDirectory } from "./workDirectory";
import type { TerminalRegistry } from "./terminalRegistry";
import type { PiSession } from "./piMux";

export interface SessionLauncherDeps {
  registry: TerminalRegistry;
  onSessionStarted: (sessionId: string) => void | Promise<void>;
}

export class SessionLauncher implements vscode.Disposable {
  private disposed = false;

  constructor(private readonly deps: SessionLauncherDeps) {}

  async start(cwd: string, onPresented?: () => void): Promise<string | undefined> {
    const workDir = await requireWorkDirectory(cwd);
    if (this.disposed) return;
    const present = this.deps.registry.preparePresentation("focus");
    this.deps.registry.presentExisting();
    const early = await this.deps.registry.prepareNew(workDir, present);
    if (early !== undefined) onPresented?.();
    return this.deps.registry.run(async () => {
      if (this.disposed) return;
      const previousSessionId = this.deps.registry.displayedSessionId;
      const session: PiSession | undefined =
        early === undefined
          ? { sessionId: await this.deps.registry.mux.newSession(workDir), cwd: workDir }
          : await early.session;
      if (session === undefined || this.disposed) return;
      const adopted = early !== undefined && this.deps.registry.keepsEarlyDisplay(early, session);
      if (!adopted) {
        const { terminal } = await this.deps.registry.open(session);
        present(terminal);
        if (early === undefined) onPresented?.();
      }
      if (this.disposed) return;
      await this.deps.onSessionStarted(session.sessionId);
      return previousSessionId;
    });
  }

  dispose(): void {
    this.disposed = true;
  }
}
