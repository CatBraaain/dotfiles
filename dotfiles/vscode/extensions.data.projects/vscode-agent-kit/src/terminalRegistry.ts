import type * as vscode from "vscode";
import { setTimeout as sleep } from "node:timers/promises";
import type { DisplayTerminals } from "./terminals";
import type { PiMuxCurrentSession, PiRuntime } from "./piMux";
import { PiMux, hasLiveSession, type PiSession } from "./piMux";
import { errorMessage } from "./guards";
import { requireWorkDirectory } from "./workDirectory";
import { cwdGroupKey } from "./grouping";

/** A display switched to a replacement session; used to roll back on close failure. */
interface SwitchedDisplay {
  clientPid: number;
  previousId: string;
}

export class TerminalRegistry implements vscode.Disposable {
  private disposed = false;
  private display: vscode.Terminal | undefined;
  private displayedSession: string | undefined;
  private displayedSessionCwd: string | undefined;
  private pending = Promise.resolve();
  private displayChanges = Promise.resolve();
  private readonly closeWaiters = new Map<
    vscode.Terminal,
    { promise: Promise<void>; resolve: () => void }
  >();
  private readonly attachments = new Map<vscode.Terminal, AbortController>();
  private readonly closed = new WeakSet<vscode.Terminal>();

  constructor(
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

  presentExisting(): void {
    const display = this.currentDisplay();
    if (display !== undefined && !this.closeWaiters.has(display)) display.show();
  }

  async open(
    launch: PiSession,
    intent: "select" | "unarchive" = "select",
  ): Promise<{ runtime: PiRuntime; terminal: vscode.Terminal }> {
    try {
      const workspaces = await this.mux.list();
      const isAlive = hasLiveSession(workspaces, launch.sessionId);
      return await this.connect(launch, isAlive && intent === "select");
    } catch (error) {
      throw new Error(`Pi session ${launch.sessionId} in ${launch.cwd}: ${errorMessage(error)}`);
    }
  }

  async displayForSession(sessionId: string): Promise<vscode.Terminal | undefined> {
    const display = this.currentDisplay();
    if (display === undefined || display.exitStatus !== undefined) return undefined;
    if (this.displayedSession !== undefined) {
      return this.displayedSession === sessionId ? display : undefined;
    }
    return (await this.resolveRestoredSession(display))?.id === sessionId ? display : undefined;
  }

  async stop(
    sessionId: string,
    options: { replacement?: PiSession; confirmedDisplay?: vscode.Terminal } = {},
  ): Promise<{ switched: boolean; switchError?: string }> {
    const { replacement, confirmedDisplay } = options;
    const display = this.currentDisplay();
    let isDisplayed =
      this.displayedSession === sessionId ||
      (display !== undefined && display === confirmedDisplay);
    let displayedCwd = this.displayedSession === sessionId ? this.displayedSessionCwd : undefined;
    let switchError: string | undefined;
    if (isDisplayed && displayedCwd === undefined && display !== undefined) {
      const restored = await this.resolveRestoredSession(display);
      displayedCwd = restored?.id === sessionId ? restored?.cwd : undefined;
    } else if (!isDisplayed && this.displayedSession === undefined && display !== undefined) {
      const restored = await this.resolveRestoredSession(display);
      isDisplayed = restored?.id === sessionId;
      displayedCwd = isDisplayed ? restored?.cwd : undefined;
    }
    let switched: SwitchedDisplay | undefined;
    if (isDisplayed && display !== undefined && replacement !== undefined) {
      try {
        switched = await this.switchBeforeStop(display, sessionId, replacement, displayedCwd);
      } catch (error) {
        switchError = errorMessage(error);
      }
    }
    try {
      await this.mux.closeSession(sessionId);
    } catch (error) {
      if (switched !== undefined) {
        try {
          await this.mux.switch(switched.previousId, switched.clientPid);
        } catch (rollbackError) {
          throw new Error(
            `${errorMessage(error)}; failed to restore display: ${errorMessage(rollbackError)}`,
          );
        }
      }
      throw error;
    }
    if (isDisplayed) {
      if (
        switched !== undefined &&
        replacement !== undefined &&
        display !== undefined &&
        !this.closed.has(display)
      ) {
        this.displayedSession = replacement.sessionId;
        this.displayedSessionCwd = replacement.cwd;
      } else {
        if (display !== undefined) {
          await this.changeDisplay(() => this.closeDisplay(display));
        }
        this.displayedSession = undefined;
        this.displayedSessionCwd = undefined;
      }
    }
    return { switched: switched !== undefined, switchError };
  }

  private async switchBeforeStop(
    display: vscode.Terminal,
    sessionId: string,
    replacement: PiSession,
    displayedCwd: string | undefined,
  ): Promise<SwitchedDisplay> {
    if (
      display.exitStatus !== undefined ||
      displayedCwd === undefined ||
      cwdGroupKey(displayedCwd) !== cwdGroupKey(replacement.cwd)
    ) {
      throw new Error(`Pi display cwd mismatch for ${replacement.sessionId}`);
    }
    await requireWorkDirectory(replacement.cwd);
    const pid = await display.processId;
    if (pid === undefined || this.closed.has(display)) {
      throw new Error(`Pi display is no longer attached: ${sessionId}`);
    }
    const previous = await this.mux.current(pid);
    if (previous === undefined) throw new Error(`Pi display is no longer attached: ${sessionId}`);
    if (!(await this.mux.switch(replacement.sessionId, pid)))
      throw new Error(`Pi session is no longer running: ${replacement.sessionId}`);
    return { clientPid: pid, previousId: previous.id };
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

  private async resolveRestoredSession(
    display: vscode.Terminal,
  ): Promise<PiMuxCurrentSession | undefined> {
    try {
      const pid = await display.processId;
      if (pid === undefined) return undefined;
      return await this.mux.current(pid);
    } catch {
      return undefined;
    }
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

  private async connect(session: PiSession, reuseDisplay: boolean) {
    const { terminal, created } = await this.changeDisplay(async () => {
      let restored = this.currentDisplay();
      if (restored !== undefined) {
        const options = restored.creationOptions;
        const hasLegacyTitle = options.name === "Pi" && restored.name === "Pi";
        if (restored.exitStatus !== undefined || hasLegacyTitle || !reuseDisplay) {
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
      const runtime = await this.waitForClient(terminal, session);
      this.requireActive();
      if (this.closed.has(terminal)) throw new Error("Pi display closed during attachment");
      this.displayedSession = runtime.sessionId;
      this.displayedSessionCwd = runtime.cwd;
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

  private async waitForClient(terminal: vscode.Terminal, session: PiSession): Promise<PiRuntime> {
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
      return await Promise.race([this.pollClient(terminal, session, controller.signal), closed]);
    } finally {
      controller.abort();
      this.attachments.delete(terminal);
    }
  }

  private async pollClient(
    terminal: vscode.Terminal,
    session: PiSession,
    signal: AbortSignal,
  ): Promise<PiRuntime> {
    const pid = await terminal.processId;
    signal.throwIfAborted();
    if (pid === undefined) throw new Error(`Pi display process did not start in ${session.cwd}`);
    while (terminal.exitStatus === undefined) {
      signal.throwIfAborted();
      const current = await this.mux.current(pid);
      signal.throwIfAborted();
      if (terminal.exitStatus !== undefined) break;
      const runtime = await this.runtimeFor(current, session, pid);
      if (runtime !== undefined) return runtime;
      await sleep(50, undefined, { signal });
    }
    throw new Error(`Pi display exited before attaching pid=${pid} in ${session.cwd}`);
  }

  /** Interpret `pi-mux current`: a matching session attaches; anything else switches first. */
  private async runtimeFor(
    current: PiMuxCurrentSession | undefined,
    session: PiSession,
    clientPid: number,
  ): Promise<PiRuntime | undefined> {
    if (current?.id !== session.sessionId) {
      await this.mux.switch(session.sessionId, clientPid);
      return undefined;
    }
    return { sessionId: session.sessionId, cwd: session.cwd, target: current.target };
  }
}
