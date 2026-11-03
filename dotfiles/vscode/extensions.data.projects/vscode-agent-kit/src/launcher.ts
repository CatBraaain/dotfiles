import * as vscode from "vscode";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { errorMessage } from "./guards";
import type { PiRuntime } from "./tmux";
import { basename, isAbsolute, join, resolve } from "node:path";
import { requireWorkDirectory } from "./workTarget";
import { encodeCwdDirName } from "./paths";
import { setSessionActive } from "./metadataStore";
import { summarizeSessionFile } from "./sessionFile";
import { listSessionFileNames, resolveLaunchCwd } from "./newSession";
import type { TerminalRegistry } from "./terminalRegistry";

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1_000;

export interface SessionLauncherDeps {
  sessionDir: string;
  metadataPath: string;
  registry: TerminalRegistry;
  onSessionDetected: (sessionId: string) => void | Promise<void>;
}

export class SessionLauncher implements vscode.Disposable {
  private disposed = false;
  private readonly pendingSessionIds = new Map<string, string>();

  constructor(private readonly deps: SessionLauncherDeps) {}

  async start(sessionCwds: readonly string[] = []): Promise<void> {
    await this.deps.registry.run(async () => {
      const selectedCwd = await chooseLaunchCwd(sessionCwds);
      if (selectedCwd === undefined || this.disposed) return;
      const cwd = await requireWorkDirectory(selectedCwd);
      const groupDir = join(this.deps.sessionDir, encodeCwdDirName(cwd));
      const sessionId = this.pendingSessionIds.get(cwd) ?? randomUUID();
      this.pendingSessionIds.set(cwd, sessionId);
      const { runtime, terminal } = await this.deps.registry.open({
        sessionId,
        cwd,
        args: ["--session-id", sessionId, "--session-dir", groupDir],
      });
      terminal.show();
      this.pendingSessionIds.delete(cwd);
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
        const result = setSessionActive(this.deps.metadataPath, info.header.id, true);
        if (!result.ok) {
          void vscode.window.showErrorMessage(result.message);
        }
        await this.deps.onSessionDetected(info.header.id);
        return;
      }
    }
  }
}

async function chooseLaunchCwd(sessionCwds: readonly string[]): Promise<string | undefined> {
  const defaultCwd = resolveLaunchCwd({
    workspaceFolders: vscode.workspace.workspaceFolders,
    activeDocumentUri: vscode.window.activeTextEditor?.document.uri,
    homeDir: homedir(),
  });
  const candidates = [
    ...new Set(
      [
        defaultCwd,
        ...(vscode.workspace.workspaceFolders ?? [])
          .filter((folder) => folder.uri.scheme === "file")
          .map((folder) => folder.uri.fsPath),
        ...sessionCwds,
      ]
        .filter(isAbsolute)
        .map((cwd) => resolve(cwd)),
    ),
  ];
  const choice = await vscode.window.showQuickPick(
    [
      ...candidates.map((cwd) => ({ label: basename(cwd) || cwd, description: cwd, cwd })),
      {
        label: "Choose another folder…",
        description: "Browse for a starting folder",
        cwd: undefined,
      },
    ],
    { title: "Start Pi session in…", matchOnDescription: true },
  );
  if (choice === undefined) return;
  let selectedCwd = choice.cwd;
  if (selectedCwd === undefined) {
    const folders = await vscode.window.showOpenDialog({
      title: "Start Pi session in…",
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(defaultCwd),
      openLabel: "Start here",
    });
    selectedCwd = folders?.[0]?.fsPath;
  }
  if (selectedCwd === undefined) return;
  return selectedCwd;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
