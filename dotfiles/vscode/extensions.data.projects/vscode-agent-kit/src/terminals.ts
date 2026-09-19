import * as vscode from "vscode";
import type { SessionSummary } from "./sessionStore";
import { shellQuote } from "./shellQuote";

/**
 * Create a terminal in the Editor Area for the given session and start
 * `pi --session <file>` in it. Resuming appends to the existing session file;
 * the extension never creates or modifies session files itself.
 */
export function createSessionTerminal(session: SessionSummary): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: session.displayName,
    cwd: vscode.Uri.file(session.cwd),
    location: vscode.TerminalLocation.Editor,
  });
  terminal.sendText(`pi --session ${shellQuote(session.filePath)}`, true);
  return terminal;
}
