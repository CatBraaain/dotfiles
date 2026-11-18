import * as vscode from "vscode";
import { homedir } from "node:os";
import type { PiSession } from "./piMux";

const OWNER_KEY = "PI_SESSIONS_DISPLAY";
const OWNER_VALUE = "1";

export const NEW_SESSION_COMMAND = 'cd "$1" && exec pi-mux new';

export interface DisplayTerminals {
  find(): vscode.Terminal | undefined;
  create(session: PiSession): vscode.Terminal;
  createNew(cwd: string): vscode.Terminal;
  canFocus(terminal: vscode.Terminal): boolean;
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
      return vscode.window.terminals.find((terminal) => {
        const options = terminal.creationOptions;
        return (
          "env" in options &&
          options.env?.[OWNER_KEY] === OWNER_VALUE &&
          terminal.exitStatus === undefined
        );
      });
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
        shellPath: "sh",
        shellArgs: ["-c", NEW_SESSION_COMMAND, "pi-mux-new", cwd],
        env: { [OWNER_KEY]: OWNER_VALUE, TMUX: null, TMUX_PANE: null },
        isTransient: false,
      });
    },
  };
}
