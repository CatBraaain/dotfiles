import type * as vscode from "vscode";

/**
 * Maps session ids to the terminals this extension created for them.
 * Not persisted: after a VS Code restart the mapping starts empty and sessions
 * open a fresh terminal (`pi --session <file>`).
 *
 * VS Code types only (type-only import): the reuse and cleanup rules are plain
 * logic over { id -> terminal }, unit-testable without VS Code.
 */
export class TerminalRegistry {
  private readonly terminalsBySessionId = new Map<string, vscode.Terminal>();

  /** The live terminal for a session, or undefined when absent or already exited. */
  get(sessionId: string): vscode.Terminal | undefined {
    const terminal = this.terminalsBySessionId.get(sessionId);
    if (terminal === undefined) return undefined;
    if (terminal.exitStatus !== undefined) {
      this.terminalsBySessionId.delete(sessionId);
      return undefined;
    }
    return terminal;
  }

  set(sessionId: string, terminal: vscode.Terminal): void {
    this.terminalsBySessionId.set(sessionId, terminal);
  }

  /** Whether any terminal (live or not) is currently mapped to the session id. */
  has(sessionId: string): boolean {
    return this.terminalsBySessionId.has(sessionId);
  }

  /** Drop the mapping for a terminal that VS Code reported closed. */
  onTerminalClosed(closed: vscode.Terminal): void {
    for (const [sessionId, terminal] of this.terminalsBySessionId) {
      if (terminal === closed) {
        this.terminalsBySessionId.delete(sessionId);
      }
    }
  }
}
