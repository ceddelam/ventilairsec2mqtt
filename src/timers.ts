/** Opaque handle returned by {@link Timers.setTimeout}. */
export type TimerHandle = object | number;

/**
 * Clock and timer abstraction, injectable so that time-dependent code can be tested without
 * waiting.
 */
export interface Timers {
  /** Current time in milliseconds (epoch or any monotonic origin). */
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Timers backed by the global `Date.now`, `setTimeout` and `clearTimeout`. */
export const systemTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  },
};
