import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { errorMessage } from "./guards";
import type { PiRuntime } from "./tmux";
import { join, resolve } from "node:path";
import { requireWorkDirectory } from "./workDirectory";
import { encodeCwdDirName } from "./paths";
import { addActiveSession } from "./sessionStateStore";
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

/** A launch whose session file pi has not written yet. `detection` polls the
 * group directory for that file and runs while the launch stays pending. */
interface PendingLaunch {
  sessionId: string;
  detection: Promise<void> | undefined;
}

export class SessionLauncher implements vscode.Disposable {
  private disposed = false;
  private readonly pendingLaunches = new Map<string, PendingLaunch>();

  constructor(private readonly deps: SessionLauncherDeps) {}

  /** Launch one new Pi conversation in the given workspace cwd. While a
   * launch in that cwd is still pending, New Session reconnects to its Pi
   * instead of starting another one, because a pending Pi cannot be selected
   * from the session list. */
  async start(cwd: string): Promise<void> {
    await this.deps.registry.run(async () => {
      const workDir = await requireWorkDirectory(cwd);
      if (this.disposed) return;
      const groupDir = join(this.deps.sessionDir, encodeCwdDirName(workDir));
      const pending = this.pendingLaunches.get(workDir);
      const sessionId = pending?.sessionId ?? randomUUID();
      const launch = pending ?? { sessionId, detection: undefined };
      this.pendingLaunches.set(workDir, launch);
      const { runtime, terminal } = await this.deps.registry.open({
        sessionId,
        cwd: workDir,
        args: ["--session-id", sessionId, "--session-dir", groupDir],
      });
      terminal.show();
      if (launch.detection === undefined) {
        launch.detection = this.detectNewSession(runtime, groupDir, workDir, launch);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  private detectNewSession(
    runtime: PiRuntime,
    groupDir: string,
    workDir: string,
    launch: PendingLaunch,
  ): Promise<void> {
    return this.waitForNewSession(runtime, groupDir, Date.now(), workDir, launch).catch((error) => {
      void vscode.window.showErrorMessage(
        `Failed to detect Pi session ${runtime.sessionId}: ${errorMessage(error)}`,
      );
    });
  }

  private async waitForNewSession(
    runtime: PiRuntime,
    groupDir: string,
    launchedAt: number,
    workDir: string,
    launch: PendingLaunch,
  ): Promise<void> {
    try {
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
    } finally {
      // The pending entry blocks new Pi launches in this cwd, so release it
      // however the polling ends: detection, a dead Pi, or the timeout.
      if (this.pendingLaunches.get(workDir) === launch) {
        this.pendingLaunches.delete(workDir);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
