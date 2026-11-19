const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");

exports.activate = function activate(context) {
  let busy = false;
  let maxOwnedDisplays = 0;
  let maxTerminalTabs = 0;
  function recordDisplays() {
    maxOwnedDisplays = Math.max(
      maxOwnedDisplays,
      vscode.window.terminals.filter(
        (terminal) => terminal.creationOptions.env?.PI_SESSIONS_DISPLAY === "1",
      ).length,
    );
    maxTerminalTabs = Math.max(
      maxTerminalTabs,
      vscode.window.tabGroups.all.flatMap((group) =>
        group.tabs.filter((tab) => tab.input instanceof vscode.TabInputTerminal),
      ).length,
    );
  }
  recordDisplays();
  context.subscriptions.push(
    vscode.commands.registerCommand("fixture.openLegacyDisplay", function openLegacyDisplay() {
      const { socketName, target, cwd } = JSON.parse(
        fs.readFileSync(path.join(process.env.PI_REVIEW_BASE, "legacy-display.json"), "utf8"),
      );
      vscode.window
        .createTerminal({
          name: "Pi",
          cwd: vscode.Uri.file(cwd),
          location: vscode.TerminalLocation.Editor,
          shellPath: "tmux",
          shellArgs: ["-S", socketName, "-f", "/dev/null", "attach-session", "-t", target],
          env: { PI_SESSIONS_DISPLAY: "1", TMUX: null, TMUX_PANE: null },
          isTransient: false,
        })
        .show();
    }),
    vscode.window.onDidOpenTerminal(recordDisplays),
    vscode.window.onDidCloseTerminal(recordDisplays),
    vscode.window.tabGroups.onDidChangeTabs(recordDisplays),
  );
  const timer = setInterval(async function observe() {
    if (busy) return;
    busy = true;
    try {
      const snapshot = {
        hostPid: process.pid,
        maxOwnedDisplays,
        maxTerminalTabs,
        folders: vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath),
        windowTitle: vscode.workspace.getConfiguration("window").inspect("title"),
        workspaceFileScheme: vscode.workspace.workspaceFile?.scheme,
        terminals: await Promise.all(
          vscode.window.terminals.map(async (terminal) => ({
            name: terminal.name,
            pid: await terminal.processId,
            exit: terminal.exitStatus,
            owned: terminal.creationOptions.env?.PI_SESSIONS_DISPLAY === "1",
            options: terminal.creationOptions,
          })),
        ),
        activeEditor: vscode.window.activeTextEditor?.document.uri.toString(),
        tabs: vscode.window.tabGroups.all.flatMap((group) =>
          group.tabs.map((tab) => ({
            label: tab.label,
            active: tab.isActive,
            terminal: tab.input instanceof vscode.TabInputTerminal,
            uri: tab.input?.uri?.toString(),
            original: tab.input?.original?.toString(),
            modified: tab.input?.modified?.toString(),
          })),
        ),
      };
      const target = path.join(process.env.PI_REVIEW_BASE, "snapshot.json");
      fs.writeFileSync(`${target}.tmp`, JSON.stringify(snapshot));
      fs.renameSync(`${target}.tmp`, target);
    } catch (error) {
      fs.writeFileSync(path.join(process.env.PI_REVIEW_BASE, "probe-error.txt"), String(error));
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
