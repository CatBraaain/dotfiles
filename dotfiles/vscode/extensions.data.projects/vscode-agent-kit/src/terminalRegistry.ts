import type * as vscode from "vscode";
import { setTimeout as sleep } from "node:timers/promises";
import type { DisplayTerminals } from "./terminals";
import type { PiRuntime, TmuxRuntimeStore } from "./tmux";
import { PiMux, type PiSession } from "./piMux";
import { errorMessage } from "./guards";
import { sameWorkDirectory } from "./workDirectory";

export class TerminalRegistry implements vscode.Disposable {
  private disposed = false;
  private display: vscode.Terminal | undefined;
  private displayedSession: string | undefined;
  private pending = Promise.resolve();
  private displayChanges = Promise.resolve();
  private readonly newDisplays = new WeakMap<vscode.Terminal, string>();
  private readonly closeWaiters = new Map<
    vscode.Terminal,
    { promise: Promise<void>; resolve: () => void }
  >();
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

  async presentNew(cwd: string): Promise<vscode.Terminal> {
    this.requireActive();
    const display = this.currentDisplay();
    if (
      display !== undefined &&
      display.exitStatus === undefined &&
      !this.closeWaiters.has(display)
    ) {
      display.show();
      return display;
    }
    return this.changeDisplay(async () => {
      const current = this.currentDisplay();
      if (
        current !== undefined &&
        (current.exitStatus !== undefined || this.closeWaiters.has(current))
      ) {
        await this.closeDisplay(current);
      }
      this.requireActive();
      const terminal = this.currentDisplay() ?? this.createNewDisplay(cwd);
      terminal.show();
      return terminal;
    });
  }

  async openNew(cwd: string, presented: vscode.Terminal): Promise<PiRuntime> {
    try {
      if (this.closed.has(presented) && this.currentDisplay() === undefined) {
        throw new Error("Pi display closed before attachment");
      }
      const cold = this.currentDisplay();
      if (cold !== undefined && this.newDisplays.get(cold) === cwd) {
        try {
          const { runtime } = await this.waitForClient(cold, { cwd });
          this.newDisplays.delete(cold);
          this.displayedSession = runtime.sessionId;
          cold.show();
          return runtime;
        } catch (error) {
          if (!this.disposed) await this.closeDisplay(cold);
          throw error;
        }
      }
      this.requireActive();
      const sessionId = await this.mux.newSession(cwd);
      this.requireActive();
      const { runtime, terminal } = await this.open({ sessionId, cwd });
      terminal.show();
      return runtime;
    } catch (error) {
      throw new Error(`New Pi session in ${cwd}: ${errorMessage(error)}`);
    }
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
    const display = this.currentDisplay();
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
      if (display !== undefined) await this.changeDisplay(() => this.closeDisplay(display));
      this.displayedSession = undefined;
    }
  }

  onTerminalClosed(terminal: vscode.Terminal): void {
    if (this.display === terminal) this.display = undefined;
    this.closed.add(terminal);
    this.attachments.get(terminal)?.abort(new Error("Pi display closed during attachment"));
    this.closeWaiters.get(terminal)?.resolve();
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.attachments.values()) {
      controller.abort(new Error("Pi display registry disposed"));
    }
    for (const waiter of this.closeWaiters.values()) waiter.resolve();
  }

  private requireActive(): void {
    if (this.disposed) throw new Error("Pi display registry disposed");
  }

  private currentDisplay(): vscode.Terminal | undefined {
    const terminal = this.display ?? this.terminals.find();
    return terminal !== undefined && !this.closed.has(terminal) ? terminal : undefined;
  }

  private createNewDisplay(cwd: string): vscode.Terminal {
    const terminal = this.terminals.createNew(cwd);
    this.newDisplays.set(terminal, cwd);
    this.display = terminal;
    return terminal;
  }

  private changeDisplay<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.displayChanges.then(() => {
      this.requireActive();
      return operation();
    });
    this.displayChanges = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private async connect(session: PiSession, target: string | undefined) {
    const { terminal, created } = await this.changeDisplay(async () => {
      let restored = this.currentDisplay();
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
      this.requireActive();
      const terminal = restored ?? this.terminals.create(session);
      this.display = terminal;
      return { terminal, created: restored === undefined };
    });
    try {
      const { client, runtime } = await this.waitForClient(terminal, session, target);
      if (client.target !== runtime.target) await this.runtimes.switchClient(client, runtime);
      this.requireActive();
      if (this.closed.has(terminal)) throw new Error("Pi display closed during attachment");
      this.newDisplays.delete(terminal);
      this.displayedSession = runtime.sessionId;
      return { runtime, terminal };
    } catch (error) {
      if (created && !this.disposed) await this.changeDisplay(() => this.closeDisplay(terminal));
      throw error;
    }
  }

  private async closeDisplay(terminal: vscode.Terminal): Promise<void> {
    if (this.closed.has(terminal)) return;
    const existing = this.closeWaiters.get(terminal);
    if (existing !== undefined) return existing.promise;
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
      resolve = complete;
    });
    this.closeWaiters.set(terminal, { promise, resolve });
    try {
      terminal.dispose();
      await promise;
    } finally {
      this.closeWaiters.delete(terminal);
    }
  }

  private async waitForClient(
    terminal: vscode.Terminal,
    session: { cwd: string; sessionId?: string },
    target?: string,
  ) {
    this.requireActive();
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
    session: { cwd: string; sessionId?: string },
    target: string | undefined,
    signal: AbortSignal,
  ) {
    const pid = await terminal.processId;
    signal.throwIfAborted();
    if (pid === undefined) throw new Error(`Pi display process did not start in ${session.cwd}`);
    while (terminal.exitStatus === undefined) {
      signal.throwIfAborted();
      const [clients, resolvedTarget] = await Promise.all([
        this.runtimes.clients(),
        session.sessionId === undefined
          ? undefined
          : (target ?? this.runtimes.resolveTarget(session.sessionId)),
      ]);
      signal.throwIfAborted();
      if (terminal.exitStatus !== undefined) break;
      const client = clients.find((entry) => entry.pid === pid || entry.parentPid === pid);
      if (client !== undefined) {
        const runtime =
          session.sessionId === undefined
            ? await this.runtimes.resolveSession(client.target)
            : resolvedTarget === undefined
              ? undefined
              : { cwd: session.cwd, sessionId: session.sessionId, target: resolvedTarget };
        signal.throwIfAborted();
        if (runtime !== undefined && runtime.target !== undefined) {
          if (!(await sameWorkDirectory(runtime.cwd, session.cwd)))
            throw new Error(`Pi display cwd mismatch: ${runtime.cwd} (expected ${session.cwd})`);
          signal.throwIfAborted();
          return { client, runtime: { ...runtime, cwd: session.cwd } };
        }
      }
      await sleep(50, undefined, { signal });
    }
    throw new Error(
      `Pi display exited before attaching pid=${pid} in ${session.cwd} (${this.runtimes.socketPath})`,
    );
  }
}
