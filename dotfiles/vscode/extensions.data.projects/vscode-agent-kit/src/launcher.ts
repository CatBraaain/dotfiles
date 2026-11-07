import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { errorMessage } from "./guards";
import type { PiRuntime } from "./tmux";
import { join, resolve } from "node:path";
import { requireWorkDirectory } from "./workDirectory";
import { encodeCwdDirName } from "./paths";
import { addActiveSession } from "./metadataStore";
import { summarizeSessionFile } from "./sessionFile";
import { listSessionFileNames } from "./newSession";
import type { TerminalRegistry } from "./terminalRegistry";

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1_000;

export interface SessionLauncherDeps {
  sessionDir: string;
  statePath: string;
  registry: TerminalRegistry;
  onSessionDetected: (sessionId: string) => void | Promise<void>;
}

export class SessionLauncher implements vscode.Disposable {
  private disposed = false;
  private readonly pendingSessionIds = new Map<string, string>();

  constructor(private readonly deps: SessionLauncherDeps) {}

  /** Launch one new Pi conversation in the given workspace cwd. */
  async start(cwd: string): Promise<void> {
    await this.deps.registry.run(async () => {
      const workDir = await requireWorkDirectory(cwd);
      if (this.disposed) return;
      const groupDir = join(this.deps.sessionDir, encodeCwdDirName(workDir));
      const sessionId = this.pendingSessionIds.get(workDir) ?? randomUUID();
      this.pendingSessionIds.set(workDir, sessionId);
      const { runtime, terminal } = await this.deps.registry.open({
        sessionId,
        cwd: workDir,
        args: ["--session-id", sessionId, "--session-dir", groupDir],
      });
      terminal.show();
      this.pendingSessionIds.delete(workDir);
      void this.waitForNewSession(runtime, groupDir, Date.now()).catch((error) => {
        void vscode.window.showErrorMessage(
          `Failed to detect Pi session ${sessionId}: ${errorMessage(error)}`,
        );
      });
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  private async waitForNewSession(
    runtime: PiRuntime,
    groupDir: string,
    launchedAt: number,
  ): Promise<void> {
    while (!this.disposed && Date.now() - launchedAt < POLL_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);
      if (this.disposed) return;
      if (!(await this.deps.registry.runtimes.isAlive(runtime))) return;
      const candidates = (await listSessionFileNames(groupDir)).filter((name) =>
        name.endsWith(`_${runtime.sessionId}.jsonl`),
      );
      for (const name of candidates) {
        const info = await summarizeSessionFile(join(groupDir, name));
        if (info?.header.id !== runtime.sessionId || resolve(info.header.cwd) !== runtime.cwd)
          continue;
        const result = addActiveSession(this.deps.statePath, runtime.cwd, info.header.id);
        if (!result.ok) {
          void vscode.window.showErrorMessage(result.message);
        }
        await this.deps.onSessionDetected(info.header.id);
        return;
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
