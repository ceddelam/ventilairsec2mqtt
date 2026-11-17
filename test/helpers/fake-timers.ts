/** Manual clock and timers: time only moves with {@link FakeTimers.advance}. */
import type { TimerHandle, Timers } from '../../src/timers.ts';

interface Scheduled {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
}

export class FakeTimers implements Timers {
  #now: number;
  #nextId = 1;
  readonly #scheduled = new Map<number, Scheduled>();

  constructor(start = Date.UTC(2026, 0, 15, 10, 20, 30)) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#scheduled.set(id, { id, at: this.#now + Math.max(0, delayMs), callback });
    return { id };
  }

  clearTimeout(handle: TimerHandle): void {
    if (typeof handle === 'object' && 'id' in handle) {
      this.#scheduled.delete((handle as { id: number }).id);
    }
  }

  /** Number of pending timers. */
  get pending(): number {
    return this.#scheduled.size;
  }

  /** Moves time forward, running every timer due on the way (in order). */
  advance(ms: number): void {
    const end = this.#now + ms;
    for (;;) {
      let next: Scheduled | undefined;
      for (const timer of this.#scheduled.values()) {
        if (timer.at <= end && (next === undefined || timer.at < next.at)) next = timer;
      }
      if (next === undefined) break;
      this.#scheduled.delete(next.id);
      this.#now = next.at;
      next.callback();
    }
    this.#now = end;
  }
}
