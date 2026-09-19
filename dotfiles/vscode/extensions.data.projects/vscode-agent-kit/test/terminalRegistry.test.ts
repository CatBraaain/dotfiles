import { describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { TerminalRegistry } from "../src/terminalRegistry";

/** A minimal Terminal stand-in: the registry only reads exitStatus (undefined = live). */
function stubTerminal(exitStatus?: vscode.TerminalExitStatus): vscode.Terminal {
  return { exitStatus } as vscode.Terminal;
}

/** A terminal VS Code reports as exited. `reason` is a numeric enum; any number satisfies it. */
function exitedTerminal(): vscode.Terminal {
  return stubTerminal({ code: 0, reason: 0 });
}

describe("TerminalRegistry", () => {
  it("returns undefined for a session with no mapped terminal", () => {
    const registry = new TerminalRegistry();
    expect(registry.get("s1")).toBeUndefined();
  });

  it("returns the live terminal mapped to the session, so it can be reused", () => {
    const registry = new TerminalRegistry();
    const terminal = stubTerminal();
    registry.set("s1", terminal);
    expect(registry.get("s1")).toBe(terminal);
  });

  it("replaces the mapped terminal when the same session is set again", () => {
    const registry = new TerminalRegistry();
    const replacement = stubTerminal();
    registry.set("s1", stubTerminal());
    registry.set("s1", replacement);
    expect(registry.get("s1")).toBe(replacement);
  });

  it("does not reuse a terminal that has exited: get clears the mapping", () => {
    const registry = new TerminalRegistry();
    registry.set("s1", exitedTerminal());
    expect(registry.get("s1")).toBeUndefined();
    expect(registry.has("s1")).toBe(false);
  });

  it("reports an exited terminal's id as claimed until get re-checks liveness", () => {
    const registry = new TerminalRegistry();
    registry.set("s1", exitedTerminal());
    expect(registry.has("s1")).toBe(true); // another launch must not claim this id
    expect(registry.get("s1")).toBeUndefined();
    expect(registry.has("s1")).toBe(false);
  });

  it("drops the mapping when VS Code reports the terminal closed", () => {
    const registry = new TerminalRegistry();
    const terminal = stubTerminal();
    registry.set("s1", terminal);
    registry.onTerminalClosed(stubTerminal());
    expect(registry.get("s1")).toBe(terminal); // unrelated close leaves the mapping
    registry.onTerminalClosed(terminal);
    expect(registry.get("s1")).toBeUndefined();
    expect(registry.has("s1")).toBe(false);
  });

  it("drops every session id mapped to the closed terminal", () => {
    const registry = new TerminalRegistry();
    const terminal = stubTerminal();
    registry.set("s1", terminal);
    registry.set("s2", terminal);
    registry.onTerminalClosed(terminal);
    expect(registry.has("s1")).toBe(false);
    expect(registry.has("s2")).toBe(false);
  });
});
