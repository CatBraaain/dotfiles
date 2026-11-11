import * as vscode from "vscode";
import type { PiSession } from "./piMux";
import type { TmuxRuntimeStore } from "./tmux";

const OWNER_KEY = "PI_SESSIONS_DISPLAY_SOCKET";

export interface DisplayTerminals {
  find(): vscode.Terminal | undefined;
  create(session: PiSession): vscode.Terminal;
  createNew(cwd: string): vscode.Terminal;
}

export function editorTerminals(tmux: TmuxRuntimeStore): DisplayTerminals {
  return {
    find() {
      return vscode.window.terminals.find((terminal) => {
        const options = terminal.creationOptions;
        return (
          "env" in options &&
          options.env?.[OWNER_KEY] === tmux.socketPath &&
          terminal.exitStatus === undefined
        );
      });
    },
    create(session) {
      return create(session.cwd, ["open", session.sessionId]);
    },
    createNew(cwd) {
      return create(cwd, ["new"]);
    },
  };

  function create(cwd: string, shellArgs: string[]): vscode.Terminal {
    return vscode.window.createTerminal({
      cwd: vscode.Uri.file(cwd),
      location: vscode.TerminalLocation.Editor,
      shellPath: "pi-mux",
      shellArgs,
      env: { [OWNER_KEY]: tmux.socketPath, TMUX: null, TMUX_PANE: null },
      isTransient: false,
    });
  }
}
