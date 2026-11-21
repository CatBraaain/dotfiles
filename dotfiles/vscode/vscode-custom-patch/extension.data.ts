// VS Code entry: guarantee the workbench patch matches the deployed plugins
// folder at every startup, and keep the user informed through notifications.
// Patch failures stay quiet here; apply-side runs report errors loudly.
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { ensurePatched, installRoots, workbenchSearchDirs } from "./patch.data.ts";

export function activate(context: vscode.ExtensionContext) {
  try {
    runPatch(context);
  } catch {
    // Plugin read errors and discovery failures must not disturb startup.
  }
}

function runPatch(context: vscode.ExtensionContext) {
  const result = ensurePatched({
    searchDirs: workbenchSearchDirs({
      execPath: process.execPath,
      mainFilename: require.main?.filename,
      extraRoots: installRoots(),
    }),
    pluginsDir: pluginsDir(context),
  });

  if (result === "patched") promptReload("Custom scripts patch updated. Restart to apply.");
  else if (result === "unpatched") promptReload("Custom scripts patch removed. Restart to finish.");
  else if (result === "unwritable")
    vscode.window.showWarningMessage("Custom scripts: workbench.html is not writable.");
  else if (result === "backup-missing")
    vscode.window.showWarningMessage(
      "Custom scripts: patch backup is missing; leaving the patch in place.",
    );
}

// globalStorageUri resolves to <user settings dir>/globalStorage/<extension
// id>, so the user settings dir is two levels up. The plugins folder deploys
// as its sibling folder.
function pluginsDir(context: vscode.ExtensionContext): string {
  const userDir = dirname(dirname(context.globalStorageUri.fsPath));
  return join(userDir, "vscode-custom-patch-plugins");
}

function promptReload(message: string) {
  vscode.window.showInformationMessage(message, "Restart").then((button) => {
    if (button === "Restart") vscode.commands.executeCommand("workbench.action.reloadWindow");
  });
}

export function deactivate(): void {}
