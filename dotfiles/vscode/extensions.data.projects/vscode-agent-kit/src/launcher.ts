import * as vscode from "vscode";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { requireWorkDirectory } from "./workTarget";
import { encodeCwdDirName } from "./paths";
import { setSessionActive } from "./metadataStore";
import { summarizeSessionFile } from "./sessionFile";
import { isLaunchedSession, listSessionFileNames, newSessionCandidates, resolveLaunchCwd } from "./newSession";
import type { TerminalRegistry } from "./terminalRegistry";

/**
 * "New Session" flow: launch `pi` in a fresh editor terminal at the launch cwd,
 * then poll that cwd's session group directory until pi writes the new session
 * file. On detection: map the terminal to the new session id, mark it active,
 * and reload the tree. The launch-cwd and detection decisions live in
 * ./newSession (VS Code API free, unit tested there).
 */

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

  constructor(private readonly deps: SessionLauncherDeps) {}

  async start(sessionCwds: readonly string[] = []): Promise<void> {
    const selectedCwd = await chooseLaunchCwd(sessionCwds);
    if (selectedCwd === undefined) return;
    const cwd = await requireWorkDirectory(selectedCwd);
    const groupDir = join(this.deps.sessionDir, encodeCwdDirName(cwd));
    const known = new Set(await listSessionFileNames(groupDir));
    const terminal = vscode.window.createTerminal({
      name: "pi",
      cwd: vscode.Uri.file(cwd),
      location: vscode.TerminalLocation.Editor,
    });
    terminal.sendText("pi", true);
    terminal.show();
    void this.waitForNewSession(terminal, cwd, groupDir, known, Date.now());
  }

  dispose(): void {
    this.disposed = true;
  }

  private async waitForNewSession(
    terminal: vscode.Terminal,
    cwd: string,
    groupDir: string,
    known: Set<string>,
    launchedAt: number,
  ): Promise<void> {
    while (!this.disposed && Date.now() - launchedAt < POLL_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);
      if (this.disposed) return;
      if (terminal.exitStatus !== undefined) return; // pi exited without creating a session
      const candidates = await newSessionCandidates(groupDir, known);
      for (const filePath of candidates) {
        const info = await summarizeSessionFile(filePath);
        if (info === null) continue;
        const launched = isLaunchedSession(info.header, {
          cwd,
          launchedAtMs: launchedAt,
          isClaimed: (id) => this.deps.registry.has(id),
        });
        if (!launched) continue;
        this.deps.registry.set(info.header.id, terminal);
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
      { label: "Choose another folder…", description: "Browse for a starting folder", cwd: undefined },
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
