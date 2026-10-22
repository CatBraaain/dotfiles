import * as vscode from "vscode";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { errorMessage } from "./guards";

export async function followWorkTarget(
  cwd: string,
  editorUri?: vscode.Uri,
): Promise<void> {
  const directory = await requireWorkDirectory(cwd);
  const uri = vscode.Uri.file(directory);
  if (vscode.workspace.getWorkspaceFolder(uri) === undefined) {
    void offerWorkspaceFolder(directory).catch((error: unknown) => {
      void vscode.window.showErrorMessage(
        `Failed to add session work folder: ${errorMessage(error)}`,
      );
    });
    return;
  }
  await vscode.commands.executeCommand("revealInExplorer", uri);
  await openWorkChanges(directory, editorUri);
}

export async function requireWorkDirectory(cwd: string): Promise<string> {
  if (!isAbsolute(cwd))
    throw new Error(`Work folder must be an absolute path: ${cwd}`);
  const directory = resolve(cwd);
  if (!(await stat(directory)).isDirectory())
    throw new Error(`Work folder is not a directory: ${directory}`);
  return directory;
}

export function isWithinDirectory(
  directory: string,
  filePath: string,
): boolean {
  const child = relative(directory, filePath);
  return (
    child === "" ||
    (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
  );
}

interface GitChange {
  readonly uri: vscode.Uri;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly workingTreeChanges: GitChange[];
    readonly indexChanges: GitChange[];
  };
  readonly ui: { readonly selected: boolean };
  status(): Promise<void>;
}

interface GitApi {
  readonly repositories: readonly GitRepository[];
  openRepository(uri: vscode.Uri): Promise<GitRepository | null>;
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

async function offerWorkspaceFolder(directory: string): Promise<void> {
  const addFolder = "Add folder to workspace";
  const choice = await vscode.window.showInformationMessage(
    `Work folder is not in this workspace: ${directory}. Add it to browse files and changes here. Adding a folder may reload the window; select the session again after reload.`,
    addFolder,
  );
  if (choice !== addFolder) return;
  const cwd = await requireWorkDirectory(directory);
  const uri = vscode.Uri.file(cwd);
  if (vscode.workspace.getWorkspaceFolder(uri) !== undefined) return;
  const added = vscode.workspace.updateWorkspaceFolders(
    vscode.workspace.workspaceFolders?.length ?? 0,
    0,
    { uri },
  );
  if (!added)
    throw new Error(`Could not add work folder to workspace: ${directory}`);
}

async function openWorkChanges(
  directory: string,
  editorUri: vscode.Uri | undefined,
): Promise<void> {
  const uri = vscode.Uri.file(directory);
  const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (extension === undefined) {
    void vscode.window.showInformationMessage(
      `Files selected: ${directory}. Enable the VS Code Git extension to view changes.`,
    );
    return;
  }
  const git = (await extension.activate()).getAPI(1);
  const repository = await git.openRepository(uri);
  if (
    repository === null ||
    !isWithinDirectory(repository.rootUri.fsPath, directory)
  ) {
    void vscode.window.showInformationMessage(
      `No Git repository for work folder: ${directory}`,
    );
    return;
  }
  await repository.status();
  const changes = [
    ...repository.state.workingTreeChanges,
    ...repository.state.indexChanges,
  ].filter((change) => isWithinDirectory(directory, change.uri.fsPath));
  const activeFile = editorUri?.fsPath;
  const change =
    changes.find((candidate) => candidate.uri.fsPath === activeFile) ??
    changes[0];
  if (change === undefined) {
    void vscode.window.showInformationMessage(
      `No Git changes in work folder: ${directory}`,
    );
    return;
  }
  await vscode.commands.executeCommand("workbench.view.scm");
  let selected = false;
  try {
    selected = await focusRepository(git, repository);
  } finally {
    await vscode.commands.executeCommand("git.openChange", change.uri);
  }
  if (!selected) {
    throw new Error(
      `Could not select SCM repository for work folder: ${directory}. Keep the repository visible in Source Control and select the session again.`,
    );
  }
}

async function focusRepository(
  git: GitApi,
  target: GitRepository,
): Promise<boolean> {
  const focusTimeoutMs = 5_000;
  const inputSettleTimeoutMs = 350;
  const pollIntervalMs = 50;
  const deadline = Date.now() + focusTimeoutMs;
  const maxMoves = git.repositories.length * 2 + 1;
  for (let move = 0; move < maxMoves && Date.now() < deadline; move++) {
    if (target.ui.selected) return true;
    const previous = git.repositories.find(
      (repository) => repository.ui.selected,
    );
    await vscode.commands.executeCommand("workbench.scm.action.focusNextInput");
    const moveDeadline = Math.min(deadline, Date.now() + inputSettleTimeoutMs);
    while (Date.now() < moveDeadline) {
      if (target.ui.selected) return true;
      const current = git.repositories.find(
        (repository) => repository.ui.selected,
      );
      if (current !== previous) break;
      await new Promise((resolvePoll) =>
        setTimeout(resolvePoll, pollIntervalMs),
      );
    }
  }
  return target.ui.selected;
}
