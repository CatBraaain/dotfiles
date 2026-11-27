import type * as vscode from "vscode";
import { realpath } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { DisplayTerminals } from "./terminals";
import type { PiMuxCurrentSession } from "./pi-mux";
import { hasLiveSession, PiMux, type PiSession } from "./pi-mux";
import { errorMessage } from "./guards";
import { sameWorkDirectory } from "./work-directory";
import { cwdGroupKey } from "./grouping";
import type { DisplayedScmSession } from "./session-scm";

const SWITCH_RETRY_WINDOW_MS = 60_000;

interface DisplayRecovery {
  previous: PiSession;
  requestedCwd: string;
  cancelled: boolean;
}

export class DisplayRecoveryCancelledError extends Error {}

export class SwitchTargetExitedError extends Error {}

export interface EarlyNewSession {
  readonly terminal: vscode.Terminal;
  readonly session: Promise<PiSession | undefined>;
}

export class TerminalRegistry implements vscode.Disposable {
  private disposed = false;
  private display: vscode.Terminal | undefined;
  private displayedSession: string | undefined;
  private displayedSessionCwd: string | undefined;
  private pending = Promise.resolve();
  private displayChanges = Promise.resolve();
  private presentationVersion = 0;
  private readonly recoveries = new Set<DisplayRecovery>();
  private readonly closeWaiters = new Map<
    vscode.Terminal,
    { promise: Promise<void>; resolve: () => void }
  >();
  private readonly attachments = new Map<vscode.Terminal, AbortController>();
  private readonly closed = new WeakSet<vscode.Terminal>();

  constructor(
    private readonly terminals: DisplayTerminals,
    readonly mux: PiMux = new PiMux(),
    private readonly onDisplayedSession?: (session: DisplayedScmSession | undefined) => void,
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

  preparePresentation(mode: "reveal" | "focus" = "reveal"): (terminal: vscode.Terminal) => boolean {
    const version = ++this.presentationVersion;
    return (terminal) => this.present(terminal, mode, version);
  }

  private present(terminal: vscode.Terminal, mode: "reveal" | "focus", version: number): boolean {
    if (this.disposed || this.closed.has(terminal)) return false;
    const preserveFocus = mode === "reveal" || version !== this.presentationVersion;
    terminal.show(preserveFocus);
    void terminal.processId.then(
      (pid) => {
        const canPresent =
          pid !== undefined &&
          !this.disposed &&
          version === this.presentationVersion &&
          !this.closed.has(terminal) &&
          terminal.exitStatus === undefined &&
          this.currentDisplay() === terminal &&
          this.terminals.canFocus(terminal);
        if (canPresent) terminal.show(preserveFocus);
      },
      () => {},
    );
    return true;
  }

  presentExisting(): void {
    const display = this.currentDisplay();
    if (display !== undefined && !this.closeWaiters.has(display))
      this.present(display, "reveal", this.presentationVersion);
  }

  async prepareNew(
    cwd: string,
    present: (terminal: vscode.Terminal) => void,
  ): Promise<EarlyNewSession | undefined> {
    if (this.currentDisplay() !== undefined) return undefined;
    let resolveCreation!: (early: EarlyNewSession | undefined) => void;
    let rejectCreation!: (error: unknown) => void;
    const creation = new Promise<EarlyNewSession | undefined>((resolve, reject) => {
      resolveCreation = resolve;
      rejectCreation = reject;
    });
    this.changeDisplay(async () => {
      this.requireActive();
      if (this.currentDisplay() !== undefined) {
        resolveCreation(undefined);
        return;
      }
      const terminal = this.terminals.createNew(cwd);
      this.display = terminal;
      present(terminal);
      const session = this.captureNewSession(terminal, cwd);
      resolveCreation({ terminal, session });
      await session;
    }).catch(rejectCreation);
    return creation;
  }

  keepsEarlyDisplay(early: EarlyNewSession, session: PiSession): boolean {
    return (
      !this.disposed &&
      !this.closed.has(early.terminal) &&
      early.terminal.exitStatus === undefined &&
      this.currentDisplay() === early.terminal &&
      this.displayedSession === session.sessionId
    );
  }

  async open(
    session: PiSession,
    intent: "select" | "activate" = "select",
    signal?: AbortSignal,
    requiredLiveFile?: string,
  ): Promise<{ terminal: vscode.Terminal }> {
    const recovery: DisplayRecovery | undefined =
      this.displayedSession !== undefined && this.displayedSessionCwd !== undefined
        ? {
            previous: { sessionId: this.displayedSession, cwd: this.displayedSessionCwd },
            requestedCwd: session.cwd,
            cancelled: false,
          }
        : undefined;
    if (recovery !== undefined) this.recoveries.add(recovery);
    try {
      signal?.throwIfAborted();
      const workspaces = await this.mux.list();
      signal?.throwIfAborted();
      if (
        requiredLiveFile !== undefined &&
        !workspaces.some(({ sessions }) =>
          sessions.some(({ id, file }) => id === session.sessionId && file === requiredLiveFile),
        )
      ) {
        throw new SwitchTargetExitedError(
          `Pi session ${session.sessionId} is no longer running that file`,
        );
      }
      const reuseDisplay = intent === "select" && hasLiveSession(workspaces, session.sessionId);
      const display = await this.connect(session, reuseDisplay, signal, recovery);
      if (this.disposed || this.closed.has(display.terminal)) return display;
      this.onDisplayedSession?.({ sessionId: session.sessionId, cwd: session.cwd });
      return display;
    } catch (error) {
      signal?.throwIfAborted();
      if (
        error instanceof DisplayRecoveryCancelledError ||
        error instanceof SwitchTargetExitedError
      )
        throw error;
      throw new Error(`Pi session ${session.sessionId} in ${session.cwd}: ${errorMessage(error)}`);
    } finally {
      if (recovery !== undefined) this.recoveries.delete(recovery);
    }
  }

  async confirmSessionDisplay(
    terminal: vscode.Terminal,
    sessionId: string,
    file: string,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    const canConfirm = () => isCurrent() && this.canConfirmDisplay(terminal, sessionId);
    const deadlineMs = performance.now() + SWITCH_RETRY_WINDOW_MS;
    const timeout = new AbortController();
    let pid: number | undefined;
    try {
      pid = await Promise.race([
        terminal.processId,
        sleep(SWITCH_RETRY_WINDOW_MS, undefined, { signal: timeout.signal }),
      ]);
    } finally {
      timeout.abort();
    }
    if (pid === undefined) return false;
    while (canConfirm() && performance.now() < deadlineMs) {
      const current = await this.mux.current(pid);
      if (!canConfirm()) return false;
      if (current?.id === sessionId) {
        const displayedFile = current.file === file ? file : await realpath(current.file);
        return displayedFile === file && canConfirm();
      }
      await sleep(50);
    }
    return false;
  }

  private canConfirmDisplay(terminal: vscode.Terminal, sessionId: string): boolean {
    return (
      !this.disposed &&
      terminal.exitStatus === undefined &&
      this.currentDisplay() === terminal &&
      this.displayedSession === sessionId
    );
  }

  async displayForSession(sessionId: string): Promise<vscode.Terminal | undefined> {
    const display = this.currentDisplay();
    if (display === undefined || display.exitStatus !== undefined) return undefined;
    if (this.displayedSession !== undefined) {
      return this.displayedSession === sessionId ? display : undefined;
    }
    return (await this.resolveRestoredSession(display))?.id === sessionId ? display : undefined;
  }

  async stop(sessionId: string): Promise<void> {
    const display = this.currentDisplay();
    let displayedSessionId = this.displayedSession;
    if (displayedSessionId === undefined && display !== undefined) {
      const restored =
        (await this.resolveRestoredSession(display)) ??
        (await this.resolveRestoredSession(display));
      displayedSessionId = restored?.id;
    }

    await this.mux.closeSession(sessionId);
    if (displayedSessionId !== sessionId) return;

    if (display !== undefined) {
      await this.changeDisplay(() => this.closeDisplay(display));
    }
    this.displayedSession = undefined;
    this.displayedSessionCwd = undefined;
    this.onDisplayedSession?.(undefined);
  }

  cancelDisplayRecovery(cwd: string): void {
    for (const recovery of this.recoveries) {
      if (
        [recovery.previous.cwd, recovery.requestedCwd].some(
          (pendingCwd) => cwdGroupKey(pendingCwd) === cwdGroupKey(cwd),
        )
      )
        recovery.cancelled = true;
    }
  }

  onTerminalClosed(terminal: vscode.Terminal): void {
    if (this.display === terminal) {
      this.display = undefined;
      if (!this.closeWaiters.has(terminal)) this.onDisplayedSession?.(undefined);
    }
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

  private async connect(
    session: PiSession,
    reuseDisplay: boolean,
    signal?: AbortSignal,
    recovery?: DisplayRecovery,
  ) {
    const { terminal, created } = await this.changeDisplay(async () => {
      signal?.throwIfAborted();
      let restored = this.currentDisplay();
      let previousClosed = false;
      if (restored !== undefined) {
        const options = restored.creationOptions;
        const hasLegacyTitle = options.name === "Pi" && restored.name === "Pi";
        if (restored.exitStatus !== undefined || hasLegacyTitle || !reuseDisplay) {
          await this.closeDisplay(restored);
          previousClosed = true;
          restored = undefined;
        }
      }
      this.requireActive();
      signal?.throwIfAborted();
      const terminal =
        restored ??
        (await this.createDisplay(session, previousClosed ? recovery : undefined, signal));
      this.display = terminal;
      return { terminal, created: restored === undefined };
    });
    try {
      if (!created) await this.waitForClient(terminal, session, signal);
      this.requireActive();
      signal?.throwIfAborted();
      if (this.closed.has(terminal)) throw new Error("Pi display closed during attachment");
      this.displayedSession = session.sessionId;
      this.displayedSessionCwd = session.cwd;
      return { terminal };
    } catch (error) {
      if (created && !this.disposed) await this.changeDisplay(() => this.closeDisplay(terminal));
      throw error;
    }
  }

  private async createDisplay(
    session: PiSession,
    recovery: DisplayRecovery | undefined,
    signal?: AbortSignal,
  ): Promise<vscode.Terminal> {
    try {
      return this.terminals.create(session);
    } catch (error) {
      if (recovery === undefined) throw error;
      let restored: vscode.Terminal | undefined;
      try {
        restored = await this.restoreDisplay(recovery, signal);
        this.requireRecoveryActive(recovery, signal);
        if (restored !== undefined) {
          if (this.closed.has(restored)) throw new Error("Pi display closed during restoration");
          this.present(restored, "reveal", this.presentationVersion);
        }
      } catch (recoveryError) {
        if (restored !== undefined && !this.closed.has(restored)) {
          if (this.disposed) {
            restored.dispose();
            this.onTerminalClosed(restored);
          } else await this.closeDisplay(restored);
        }
        this.requireRecoveryActive(recovery, signal);
        throw new Error(
          `${errorMessage(error)}; failed to restore display: ${errorMessage(recoveryError)}`,
        );
      }
      const result =
        restored === undefined
          ? ""
          : `; showing previous Pi session ${recovery.previous.sessionId}`;
      throw new Error(`${errorMessage(error)}${result}`);
    }
  }

  private requireRecoveryActive(recovery: DisplayRecovery, signal?: AbortSignal): void {
    if (this.disposed || recovery.cancelled || signal?.aborted)
      throw new DisplayRecoveryCancelledError("Pi display restoration cancelled");
  }

  private async restoreDisplay(
    recovery: DisplayRecovery,
    signal?: AbortSignal,
  ): Promise<vscode.Terminal | undefined> {
    this.requireRecoveryActive(recovery, signal);
    const workspaces = await this.mux.list();
    this.requireRecoveryActive(recovery, signal);
    for (const { cwd, sessions, empty } of workspaces) {
      const previous = [...sessions, ...empty].find(({ id }) => id === recovery.previous.sessionId);
      if (previous === undefined) continue;
      const terminal = this.terminals.create({
        sessionId: previous.id,
        cwd,
        ...(previous.temporary ? { temporary: true as const } : {}),
      });
      this.display = terminal;
      return terminal;
    }
    return undefined;
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

  private waitForClient(
    terminal: vscode.Terminal,
    session: PiSession,
    requestSignal?: AbortSignal,
  ): Promise<void> {
    return this.withAttachment(terminal, requestSignal, (signal) =>
      this.pollClient(terminal, session, signal),
    );
  }

  private async withAttachment<T>(
    terminal: vscode.Terminal,
    requestSignal: AbortSignal | undefined,
    poll: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.requireActive();
    requestSignal?.throwIfAborted();
    const controller = new AbortController();
    const signal = controller.signal;
    function abortRequest(): void {
      controller.abort(requestSignal?.reason);
    }
    requestSignal?.addEventListener("abort", abortRequest, { once: true });
    const closed = new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
    this.attachments.set(terminal, controller);
    try {
      if (this.closed.has(terminal))
        controller.abort(new Error("Pi display closed during attachment"));
      return await Promise.race([poll(signal), closed]);
    } finally {
      requestSignal?.removeEventListener("abort", abortRequest);
      controller.abort();
      this.attachments.delete(terminal);
    }
  }

  private async captureNewSession(
    terminal: vscode.Terminal,
    cwd: string,
  ): Promise<PiSession | undefined> {
    try {
      const session = await this.withAttachment(terminal, undefined, (signal) =>
        this.pollFirstSession(terminal, cwd, signal),
      );
      if (this.disposed || this.closed.has(terminal)) return undefined;
      this.displayedSession = session.sessionId;
      this.displayedSessionCwd = session.cwd;
      this.onDisplayedSession?.(session);
      return session;
    } catch (error) {
      if (this.disposed || this.closed.has(terminal)) return undefined;
      await this.closeDisplay(terminal);
      throw new Error(`Pi new session in ${cwd}: ${errorMessage(error)}`);
    }
  }

  private async pollFirstSession(
    terminal: vscode.Terminal,
    cwd: string,
    signal: AbortSignal,
  ): Promise<DisplayedScmSession> {
    const pid = await terminal.processId;
    signal.throwIfAborted();
    if (pid === undefined) throw new Error(`Pi display process did not start in ${cwd}`);
    while (terminal.exitStatus === undefined) {
      signal.throwIfAborted();
      const current = await this.mux.current(pid);
      signal.throwIfAborted();
      if (terminal.exitStatus !== undefined) break;
      if (current !== undefined) {
        const inRequestedCwd =
          current.cwd === cwd || (await sameWorkDirectory(current.cwd, cwd).catch(() => false));
        if (!inRequestedCwd)
          throw new Error(`Pi display attached to ${current.cwd} instead of ${cwd}`);
        return { sessionId: current.id, cwd };
      }
      await sleep(50, undefined, { signal });
    }
    throw new Error(`Pi display exited before attaching pid=${pid} in ${cwd}`);
  }

  private async pollClient(
    terminal: vscode.Terminal,
    session: PiSession,
    signal: AbortSignal,
  ): Promise<void> {
    const pid = await terminal.processId;
    signal.throwIfAborted();
    if (pid === undefined) throw new Error(`Pi display process did not start in ${session.cwd}`);
    const switchDeadlineMs = performance.now() + SWITCH_RETRY_WINDOW_MS;
    let switchAccepted = false;
    while (terminal.exitStatus === undefined) {
      signal.throwIfAborted();
      const current = await this.mux.current(pid);
      signal.throwIfAborted();
      if (terminal.exitStatus !== undefined) break;
      if (current?.id === session.sessionId) return;
      if (performance.now() >= switchDeadlineMs)
        throw new Error(`Timed out switching to Pi session ${session.sessionId}`);
      if (!switchAccepted) {
        const switchResult = await this.mux.switch(session.sessionId, pid);
        signal.throwIfAborted();
        if (switchResult === "target-missing")
          throw new SwitchTargetExitedError(`Pi session ${session.sessionId} is no longer running`);
        switchAccepted = switchResult === "switched";
      }
      await sleep(50, undefined, { signal });
    }
    throw new Error(`Pi display exited before attaching pid=${pid} in ${session.cwd}`);
  }
}
