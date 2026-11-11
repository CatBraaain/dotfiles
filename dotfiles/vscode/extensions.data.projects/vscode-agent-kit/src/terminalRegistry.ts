import type * as vscode from "vscode";
import { setTimeout as sleep } from "node:timers/promises";
import type { DisplayTerminals } from "./terminals";
import type { PiRuntime, TmuxRuntimeStore } from "./tmux";
import { PiMux, type PiSession } from "./piMux";
import { errorMessage } from "./guards";

export class TerminalRegistry {
  private display: vscode.Terminal | undefined;
  private displayedSession: string | undefined;
  private pending = Promise.resolve();
  private readonly closeWaiters = new Map<vscode.Terminal, () => void>();
  private readonly attachments = new Map<vscode.Terminal, AbortController>();
  private readonly closed = new WeakSet<vscode.Terminal>();

  constructor(
    readonly runtimes: TmuxRuntimeStore,
    private readonly terminals: DisplayTerminals,
    readonly mux: PiMux = new PiMux(),
  ) {}

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

  async open(launch: PiSession): Promise<{ runtime: PiRuntime; terminal: vscode.Terminal }> {
    try {
      const isAlive = (await this.mux.list()).some((session) => session.id === launch.sessionId);
      const target = isAlive ? await this.runtimes.resolveTarget(launch.sessionId) : undefined;
      if (isAlive && target === undefined) {
        throw new Error(`Cannot resolve tmux target for session ${launch.sessionId}`);
      }
      return await this.connect(launch, target);
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
        : (await this.runtimes.clients()).find(
            (client) => client.pid === displayPid || client.parentPid === displayPid,
          )?.target;
    const target = await this.runtimes.stop(sessionId);
    if (displayedSession === sessionId || (target !== undefined && restoredTarget === target)) {
      if (display !== undefined) await this.closeDisplay(display);
      this.display = undefined;
      this.displayedSession = undefined;
    }
  }

  onTerminalClosed(closed: vscode.Terminal): void {
    if (this.display === closed) {
      this.display = undefined;
    }
    this.closed.add(closed);
    this.attachments.get(closed)?.abort(new Error("Pi display closed during attachment"));
    this.closeWaiters.get(closed)?.();
  }

  private async connect(
    session: PiSession,
    target: string | undefined,
  ): Promise<{ runtime: PiRuntime; terminal: vscode.Terminal }> {
    let restored = this.display ?? this.terminals.find();
    if (restored !== undefined) {
      const options = restored.creationOptions;
      const cwd = "cwd" in options ? options.cwd : undefined;
      const displayCwd = typeof cwd === "string" ? cwd : cwd?.fsPath;
      const hasLegacyTitle = options.name === "Pi" && restored.name === "Pi";
      if (
        restored.exitStatus !== undefined ||
        displayCwd !== session.cwd ||
        hasLegacyTitle ||
        target === undefined
      ) {
        await this.closeDisplay(restored);
        restored = undefined;
      }
    }
    const terminal = restored ?? this.terminals.create(session);
    try {
      const { client, runtime } = await this.waitForClient(terminal, session, target);
      if (client.target !== runtime.target) await this.runtimes.switchClient(client, runtime);
      this.display = terminal;
      this.displayedSession = runtime.sessionId;
      return { runtime, terminal };
    } catch (error) {
      if (restored === undefined) await this.closeDisplay(terminal);
      throw error;
    }
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

  private async waitForClient(
    terminal: vscode.Terminal,
    session: PiSession,
    target: string | undefined,
  ) {
    const controller = new AbortController();
    const closed = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
        once: true,
      });
    });
    this.attachments.set(terminal, controller);
    try {
      if (this.closed.has(terminal))
        controller.abort(new Error("Pi display closed during attachment"));
      return await Promise.race([
        this.pollClient(terminal, session, target, controller.signal),
        closed,
      ]);
    } finally {
      controller.abort();
      this.attachments.delete(terminal);
    }
  }

  private async pollClient(
    terminal: vscode.Terminal,
    session: PiSession,
    target: string | undefined,
    signal: AbortSignal,
  ) {
    const pid = await terminal.processId;
    signal.throwIfAborted();
    if (pid === undefined)
      throw new Error(`Pi display process did not start for session ${session.sessionId}`);
    while (terminal.exitStatus === undefined) {
      signal.throwIfAborted();
      const [clients, resolvedTarget] = await Promise.all([
        this.runtimes.clients(),
        target ?? this.runtimes.resolveTarget(session.sessionId),
      ]);
      signal.throwIfAborted();
      if (terminal.exitStatus !== undefined) break;
      const client = clients.find((entry) => entry.pid === pid || entry.parentPid === pid);
      if (client !== undefined && resolvedTarget !== undefined) {
        return { client, runtime: { ...session, target: resolvedTarget } };
      }
      await sleep(50, undefined, { signal });
    }
    throw new Error(
      `Pi display exited before attaching pid=${pid} to session ${session.sessionId} (${this.runtimes.socketPath})`,
    );
  }
}
