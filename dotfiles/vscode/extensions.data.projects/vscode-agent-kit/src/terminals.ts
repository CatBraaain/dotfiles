import * as vscode from "vscode";
import { homedir } from "node:os";
import type { PiSession } from "./piMux";

const OWNER_KEY = "PI_SESSIONS_DISPLAY";
const OWNER_VALUE = "1";

export interface DisplayTerminals {
  find(): vscode.Terminal | undefined;
  create(session: PiSession): vscode.Terminal;
}

export function editorTerminals(): DisplayTerminals {
  return {
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
  };
}
