const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");

exports.activate = function activate(context) {
  let busy = false;
  const timer = setInterval(async function observe() {
    if (busy) return;
    busy = true;
    try {
      const extension = vscode.extensions.getExtension("vscode.git");
      const git = extension
        ? (await extension.activate()).getAPI(1)
        : undefined;
      const snapshot = {
        hostPid: process.pid,
        folders: vscode.workspace.workspaceFolders?.map(
          (folder) => folder.uri.fsPath,
        ),
        terminals: await Promise.all(
          vscode.window.terminals.map(async (terminal) => ({
            name: terminal.name,
            pid: await terminal.processId,
            exit: terminal.exitStatus,
          })),
        ),
        activeEditor: vscode.window.activeTextEditor?.document.uri.toString(),
        tabs: vscode.window.tabGroups.all.flatMap((group) =>
          group.tabs.map((tab) => ({
            label: tab.label,
            active: tab.isActive,
            uri: tab.input?.uri?.toString(),
            original: tab.input?.original?.toString(),
            modified: tab.input?.modified?.toString(),
          })),
        ),
        repositories: git?.repositories.map((repository) => ({
          root: repository.rootUri.fsPath,
          selected: repository.ui.selected,
        })),
      };
      const target = path.join(process.env.PI_REVIEW_BASE, "snapshot.json");
      fs.writeFileSync(`${target}.tmp`, JSON.stringify(snapshot));
      fs.renameSync(`${target}.tmp`, target);
    } catch (error) {
      fs.writeFileSync(
        path.join(process.env.PI_REVIEW_BASE, "probe-error.txt"),
        String(error),
      );
    } finally {
      busy = false;
    }
  }, 100);
  context.subscriptions.push({
    dispose() {
      clearInterval(timer);
    },
  });
};
