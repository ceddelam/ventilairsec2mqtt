/**
 * Time-based states: device availability (offline after 30 min without a frame) and the stick
 * problem flag (cleared 30 min after the last incident). Timers are injected.
 */
import type { TimerHandle, Timers } from '../timers.ts';

/** 30 minutes, the timeout of both trackers (mqtt-interface.md § 2 and § 5). */
export const THIRTY_MINUTES = 30 * 60_000;

/** Availability payload. */
export type Availability = 'online' | 'offline';

/**
 * Device availability: `online` on each frame, `offline` once `timeoutMs` pass without one.
 * The timer starts with {@link start}, so a device never heard goes offline too.
 */
export class AvailabilityTracker {
  readonly #timers: Timers;
  readonly #timeoutMs: number;
  readonly #onChange: (availability: Availability) => void;
  #state: Availability | undefined;
  #timer: TimerHandle | undefined;

  constructor(
    timers: Timers,
    onChange: (availability: Availability) => void,
    timeoutMs = THIRTY_MINUTES,
  ) {
    this.#timers = timers;
    this.#onChange = onChange;
    this.#timeoutMs = timeoutMs;
  }

  /** Current state; `undefined` until the first frame or timeout. */
  get state(): Availability | undefined {
    return this.#state;
  }

  /** Arms the timeout without a frame. */
  start(): void {
    this.#arm();
  }

  /** A frame was received. */
  seen(): void {
    this.#arm();
    this.#change('online');
  }

  stop(): void {
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #arm(): void {
    this.stop();
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined;
      this.#change('offline');
    }, this.#timeoutMs);
  }

  #change(state: Availability): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#onChange(state);
  }
}

/**
 * A problem flag raised by incidents and cleared `clearAfterMs` after the last one. `reason`
 * holds the last incident's reason.
 */
export class IncidentTracker {
  readonly #timers: Timers;
  readonly #clearAfterMs: number;
  readonly #onChange: () => void;
  #reason: string | undefined;
  #timer: TimerHandle | undefined;

  constructor(timers: Timers, onChange: () => void, clearAfterMs = THIRTY_MINUTES) {
    this.#timers = timers;
    this.#onChange = onChange;
    this.#clearAfterMs = clearAfterMs;
  }

  get active(): boolean {
    return this.#reason !== undefined;
  }

  /** Reason of the last incident while active. */
  get reason(): string | undefined {
    return this.#reason;
  }

  /** Records an incident: raises the flag and restarts the clearing delay. */
  raise(reason: string): void {
    this.stop();
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined;
      this.#reason = undefined;
      this.#onChange();
    }, this.#clearAfterMs);
    const changed = this.#reason !== reason;
    this.#reason = reason;
    if (changed) this.#onChange();
  }

  stop(): void {
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
