/**
 * Machine ID consistency check (protocol.md § 5.4): the machine ID never changes, so a status
 * frame carrying another one was badly reassembled or comes from another program reading the
 * same stick.
 */
import type { EnOceanId } from './hex.ts';

/** Outcome of {@link MachineIdGuard.check}. */
export type MachineIdCheck =
  | { readonly result: 'first'; readonly machineId: EnOceanId }
  | { readonly result: 'same'; readonly machineId: EnOceanId }
  | { readonly result: 'mismatch'; readonly machineId: EnOceanId; readonly expected: EnOceanId };

/** Remembers the first machine ID seen and flags any different one. */
export class MachineIdGuard {
  #expected: EnOceanId | undefined;

  /** @param expected Known machine ID, if any; otherwise the first one seen is kept. */
  constructor(expected?: EnOceanId) {
    this.#expected = expected;
  }

  /** The reference machine ID, once known. */
  get expected(): EnOceanId | undefined {
    return this.#expected;
  }

  /** Checks a machine ID from a `CMD 3` frame. A mismatch does not change the reference. */
  check(machineId: EnOceanId): MachineIdCheck {
    if (this.#expected === undefined) {
      this.#expected = machineId;
      return { result: 'first', machineId };
    }
    if (machineId === this.#expected) return { result: 'same', machineId };
    return { result: 'mismatch', machineId, expected: this.#expected };
  }
}
