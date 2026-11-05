import type * as vscode from "vscode";
import { setTimeout as sleep } from "node:timers/promises";
import type { DisplayTerminals } from "./terminals";
import type { PiLaunch, PiRuntime, TmuxRuntimeStore } from "./tmux";
import { errorMessage } from "./guards";

export class TerminalRegistry {
  private display: vscode.Terminal | undefined;
  private pending = Promise.resolve();
  private readonly closeWaiters = new Map<vscode.Terminal, () => void>();
  private readonly closed = new WeakSet<vscode.Terminal>();

  constructor(
    readonly runtimes: TmuxRuntimeStore,
    private readonly terminals: DisplayTerminals,
  ) {}

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

  onTerminalClosed(closed: vscode.Terminal): void {
    if (this.display === closed) this.display = undefined;
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
