/**
 * JSON state of the Assistant wall sensor (mqtt-interface.md § 4).
 */
import type { AssistantFrame } from '../msc/assistant.ts';
import type { JsonObject, JsonValue } from './unit-model.ts';

/**
 * Battery percentage from the raw level `0`–`6`: raw × 100 / 6, rounded (the encoding is still
 * open, protocol.md § 4). `null` for a raw value above 6.
 */
export function batteryPercent(raw: number): number | null {
  if (raw < 0 || raw > 6) return null;
  return Math.round((raw * 100) / 6);
}

/** Accumulates the Assistant's frames into its JSON state. */
export class AssistantModel {
  readonly #values = new Map<string, JsonValue>();

  /** The JSON state, keys sorted. */
  state(): JsonObject {
    const state: JsonObject = {};
    for (const key of [...this.#values.keys()].sort()) state[key] = this.#values.get(key) ?? null;
    return state;
  }

  /** Applies a frame received at `at` (ms since the epoch) with level `dbm`. */
  apply(frame: AssistantFrame, at: number, dbm: number | undefined): void {
    this.#values.set('last_seen', new Date(at).toISOString());
    if (dbm !== undefined) this.#values.set('signal_strength', dbm);
    if (frame.kind !== 'measurement') return;
    if (frame.temperature !== undefined) this.#values.set('temperature', frame.temperature);
    if (frame.humidity !== undefined) this.#values.set('humidity', frame.humidity);
    if (frame.batteryRaw !== undefined) {
      this.#values.set('battery', batteryPercent(frame.batteryRaw));
      this.#values.set('battery_raw', frame.batteryRaw);
    }
  }
}
