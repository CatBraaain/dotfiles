import * as vscode from "vscode";
import { ensurePatched, installRoots, workbenchSearchDirs } from "./patch.ts";

declare const BUNDLED_SCM_COLLAPSE: string;

export function activate() {
  try {
    runPatch();
  } catch {
    // Plugin read errors and discovery failures must not disturb startup.
  }
}

function runPatch() {
  const result = ensurePatched({
    searchDirs: workbenchSearchDirs({
      execPath: process.execPath,
      mainFilename: require.main?.filename,
      extraRoots: installRoots(),
    }),
    plugins: [{ name: "scm-collapse.js", content: BUNDLED_SCM_COLLAPSE }],
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

function promptReload(message: string) {
  vscode.window.showInformationMessage(message, "Restart").then((button) => {
    if (button === "Restart") vscode.commands.executeCommand("workbench.action.reloadWindow");
  });
}

export function deactivate(): void {}
