import * as vscode from "vscode";
import { homedir } from "node:os";
import type { PiSession } from "./pi-mux";

const OWNER_KEY = "PI_SESSIONS_DISPLAY";
const OWNER_VALUE = "1";

export interface DisplayTerminals {
  find(): vscode.Terminal | undefined;
  create(session: PiSession): vscode.Terminal;
  createNew(cwd: string): vscode.Terminal;
  canFocus(terminal: vscode.Terminal): boolean;
}

export function isDisplayTerminal(terminal: vscode.Terminal | undefined): boolean {
  const options = terminal?.creationOptions;
  return (
    options !== undefined &&
    "env" in options &&
    options.env?.[OWNER_KEY] === OWNER_VALUE &&
    terminal?.exitStatus === undefined
  );
}

export function editorTerminals(): DisplayTerminals {
  return {
    canFocus(terminal) {
      return (
        vscode.window.state.focused &&
        vscode.window.activeTerminal === terminal &&
        vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTerminal
      );
    },
    find() {
      return vscode.window.terminals.find(isDisplayTerminal);
    },
    create(session) {
      return vscode.window.createTerminal({
        cwd: vscode.Uri.file(homedir()),
        location: vscode.TerminalLocation.Editor,
        shellPath: "pi-mux",
        shellArgs: session.temporary
          ? ["open", "--temporary", session.sessionId]
          : ["open", session.sessionId],
        env: { [OWNER_KEY]: OWNER_VALUE, TMUX: null, TMUX_PANE: null },
        isTransient: false,
      });
    },
    createNew(cwd: string) {
      return vscode.window.createTerminal({
        cwd: vscode.Uri.file(homedir()),
        location: vscode.TerminalLocation.Editor,
        shellPath: "pi-mux",
        shellArgs: ["new", "--cwd", cwd],
        env: { [OWNER_KEY]: OWNER_VALUE, TMUX: null, TMUX_PANE: null },
        isTransient: false,
      });
    },
  };
}
