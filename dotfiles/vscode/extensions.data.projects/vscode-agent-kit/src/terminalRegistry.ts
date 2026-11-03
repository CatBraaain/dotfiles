import type * as vscode from "vscode";
import { setTimeout as sleep } from "node:timers/promises";
import type { DisplayTerminals } from "./terminals";
import type { PiLaunch, PiRuntime, TmuxRuntimeStore } from "./tmux";
import { errorMessage } from "./guards";

export class TerminalRegistry {
  private display: vscode.Terminal | undefined;
  private pending = Promise.resolve();

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
  }

  private async connect(runtime: PiRuntime): Promise<vscode.Terminal> {
    const existing = this.display?.exitStatus === undefined ? this.display : undefined;
    const restored = existing ?? this.terminals.find();
    const terminal = restored ?? this.terminals.create(runtime);
    this.display = terminal;
    try {
      const client = await this.waitForClient(terminal, runtime);
      if (client.target !== runtime.target) await this.runtimes.switchClient(client, runtime);
    } catch (error) {
      if (restored === undefined) {
        terminal.dispose();
        this.onTerminalClosed(terminal);
      }
      throw error;
    }
    return terminal;
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
