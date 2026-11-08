import type * as vscode from "vscode";
import { setTimeout as sleep } from "node:timers/promises";
import type { DisplayTerminals } from "./terminals";
import type { PiLaunch, PiRuntime, TmuxRuntimeStore } from "./tmux";
import { errorMessage } from "./guards";

export class TerminalRegistry {
  private display: vscode.Terminal | undefined;
  private displayedSession: string | undefined;
  private pending = Promise.resolve();
  private readonly closeWaiters = new Map<vscode.Terminal, () => void>();
  private readonly closed = new WeakSet<vscode.Terminal>();

  constructor(
    readonly runtimes: TmuxRuntimeStore,
    private readonly terminals: DisplayTerminals,
  ) {}

  /** Session the shared display terminal currently shows; undefined while it shows none. */
  get displayedSessionId(): string | undefined {
    return this.displayedSession;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    this.pending = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  async open(launch: PiLaunch): Promise<{ runtime: PiRuntime; terminal: vscode.Terminal }> {
    try {
      const runtime = await this.runtimes.ensure(launch);
      const terminal = await this.connect(runtime);
      return { runtime, terminal };
    } catch (error) {
      throw new Error(`Pi session ${launch.sessionId} in ${launch.cwd}: ${errorMessage(error)}`);
    }
  }

  async stop(sessionId: string): Promise<void> {
    const display = this.display ?? this.terminals.find();
    const displayedSession = this.displayedSession;
    const displayPid =
      display !== undefined && displayedSession === undefined ? await display.processId : undefined;
    const restoredTarget =
      displayPid === undefined
        ? undefined
        : (await this.runtimes.clients()).find((client) => client.pid === displayPid)?.target;
    const target = await this.runtimes.stop(sessionId);
    if (display !== undefined && (displayedSession === sessionId || restoredTarget === target)) {
      await this.closeDisplay(display);
      this.display = undefined;
      this.displayedSession = undefined;
    }
  }

  onTerminalClosed(closed: vscode.Terminal): void {
    if (this.display === closed) {
      this.display = undefined;
      this.displayedSession = undefined;
    }
    this.closed.add(closed);
    this.closeWaiters.get(closed)?.();
  }

  private async connect(runtime: PiRuntime): Promise<vscode.Terminal> {
    let restored = this.display ?? this.terminals.find();
    if (restored !== undefined) {
      const options = restored.creationOptions;
      const cwd = "cwd" in options ? options.cwd : undefined;
      const displayCwd = typeof cwd === "string" ? cwd : cwd?.fsPath;
      const hasLegacyTitle = options.name === "Pi" && restored.name === "Pi";
      if (restored.exitStatus !== undefined || displayCwd !== runtime.cwd || hasLegacyTitle) {
        await this.closeDisplay(restored);
        restored = undefined;
      }
    }
    const terminal = restored ?? this.terminals.create(runtime);
    this.display = terminal;
    try {
      const client = await this.waitForClient(terminal, runtime);
      if (client.target !== runtime.target) await this.runtimes.switchClient(client, runtime);
    } catch (error) {
      if (restored === undefined) await this.closeDisplay(terminal);
      throw error;
    }
    this.displayedSession = runtime.sessionId;
    return terminal;
  }

  private async closeDisplay(terminal: vscode.Terminal): Promise<void> {
    if (this.closed.has(terminal)) return;
    try {
      await new Promise<void>((resolve) => {
        this.closeWaiters.set(terminal, resolve);
        terminal.dispose();
      });
    } finally {
      this.closeWaiters.delete(terminal);
    }
  }

  private async waitForClient(terminal: vscode.Terminal, runtime: PiRuntime) {
    const pid = await terminal.processId;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && terminal.exitStatus === undefined) {
      const client = (await this.runtimes.clients()).find((entry) => entry.pid === pid);
      if (client !== undefined) return client;
      await sleep(50);
    }
    throw new Error(
      `Cannot attach Pi display client pid=${pid} to session ${runtime.sessionId} (${this.runtimes.socketName})`,
    );
  }
}
