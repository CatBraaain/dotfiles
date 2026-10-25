/**
 * Time seam shared by the agents animation loop and the tool-renderer pending
 * row. Tests replace members of this object to make spinner frames
 * deterministic; both consumers must observe the same stubbed instance.
 */
export const spinnerTimers: {
  set: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clear: (timer: ReturnType<typeof setInterval>) => void;
  now: () => number;
} = {
  set: (callback, intervalMs) => setInterval(callback, intervalMs),
  clear: (timer) => clearInterval(timer),
  now: () => Date.now(),
};
