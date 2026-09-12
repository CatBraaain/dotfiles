// subagent-slots — per-parent FIFO semaphore capping concurrent one-shot
// subagent runs at two (pi parity). Callers await `acquire()` before starting
// a child and run the returned release once the child settles. A queued
// caller whose abort signal fires leaves the queue and the acquire promise
// rejects immediately.

export type ReleaseSlot = () => void;

interface QueueEntry {
  grant(release: ReleaseSlot): void;
  onAbort(): void;
}

export class SubagentSlots {
  readonly #limit: number;
  #active = 0;
  #queue: QueueEntry[] = [];

  constructor(limit = 2) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
    this.#limit = limit;
  }

  /** Pending callers behind the semaphore (diagnostics for logs). */
  get waiting(): number {
    return this.#queue.length;
  }

  /**
   * Reserve one slot, resolving immediately while fewer than the limit are
   * active and in FIFO order otherwise. When `signal` aborts while queued,
   * the caller leaves the queue and the promise rejects.
   * @returns A release function; calling it more than once is a no-op.
   */
  acquire(signal?: AbortSignal): Promise<ReleaseSlot> {
    if (signal?.aborted) {
      return Promise.reject(new Error("cancelled while waiting for a free subagent slot"));
    }
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<ReleaseSlot>((resolve, reject) => {
      const onAbort = () => {
        const index = this.#queue.indexOf(entry);
        if (index >= 0) {
          this.#queue.splice(index, 1);
          reject(new Error("cancelled while waiting for a free subagent slot"));
        }
      };
      const entry: QueueEntry = {
        grant: (release) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(release);
        },
        onAbort,
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(entry);
    });
  }

  private makeRelease(): ReleaseSlot {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#queue.shift();
      if (next) next.grant(this.makeRelease());
      else this.#active -= 1;
    };
  }
}
