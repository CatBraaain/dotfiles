import * as vscode from "vscode";
import type { PiRuntime, TmuxRuntimeStore } from "./tmux";

const OWNER_KEY = "PI_SESSIONS_DISPLAY_SOCKET";

export interface DisplayTerminals {
  find(): vscode.Terminal | undefined;
  create(runtime: PiRuntime): vscode.Terminal;
}

export function editorTerminals(tmux: TmuxRuntimeStore): DisplayTerminals {
  return {
    find() {
      return vscode.window.terminals.find((terminal) => {
        const options = terminal.creationOptions;
        return (
          "env" in options &&
          options.env?.[OWNER_KEY] === tmux.socketName &&
          terminal.exitStatus === undefined
        );
      });
    },
    create(runtime) {
      return vscode.window.createTerminal({
        name: "Pi",
        cwd: vscode.Uri.file(runtime.cwd),
        location: vscode.TerminalLocation.Editor,
        shellPath: tmux.executable,
        shellArgs: [...tmux.connectionArgs, "attach-session", "-t", runtime.target],
        env: { [OWNER_KEY]: tmux.socketName, TMUX: null, TMUX_PANE: null },
        isTransient: false,
      });
    },
  };
}
