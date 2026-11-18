// Bounded-concurrency helpers for filesystem-heavy operations.
import { cpus } from "node:os";

export const fileOperationConcurrency = Math.min(64, Math.max(8, cpus().length * 4));

export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  operate: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await operate(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

export class IoLimiter {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    while (this.active >= this.limit)
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}
