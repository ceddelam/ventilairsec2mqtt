/**
 * The unit's function byte (protocol.md § 5.1 offset 24, § 6.1 rank 2).
 *
 * Bit numbers below count from the least significant bit of the byte:
 * bit 5 bypass source (1 = other source), bit 4 time schedule, bit 3 fixed airflow,
 * bit 1 over-ventilation, bit 0 holiday. Bits 7, 6 and 2 have no known meaning.
 */

/** Bit masks of the function byte. */
export const FunctionBit = {
  BYPASS_OTHER_SOURCE: 0x20,
  TIME_SCHEDULE: 0x10,
  FIXED_AIRFLOW: 0x08,
  OVER_VENTILATION: 0x02,
  HOLIDAY: 0x01,
} as const;

/** Bypass source: `roof` (bit 5 = 0) or `other` heat source (bit 5 = 1). */
export type BypassSource = 'roof' | 'other';

/** Decoded function byte. */
export interface FunctionFlags {
  readonly bypassSource: BypassSource;
  readonly timeSchedule: boolean;
  readonly fixedAirflow: boolean;
  readonly overVentilation: boolean;
  readonly holiday: boolean;
}

/** Decodes the known bits of a function byte. */
export function decodeFunctionByte(byte: number): FunctionFlags {
  return {
    bypassSource: byte & FunctionBit.BYPASS_OTHER_SOURCE ? 'other' : 'roof',
    timeSchedule: (byte & FunctionBit.TIME_SCHEDULE) !== 0,
    fixedAirflow: (byte & FunctionBit.FIXED_AIRFLOW) !== 0,
    overVentilation: (byte & FunctionBit.OVER_VENTILATION) !== 0,
    holiday: (byte & FunctionBit.HOLIDAY) !== 0,
  };
}

/** The function-byte settings an order can change. */
export interface FunctionChange {
  readonly bypassSource?: BypassSource;
  readonly timeSchedule?: boolean;
  readonly fixedAirflow?: boolean;
  readonly overVentilation?: boolean;
}

/**
 * Computes the function byte to send (protocol.md § 6.1): starts from the last byte received,
 * applies the requested changes and clears the holiday bit (holidays go through rank 3).
 * Unknown bits are kept as received.
 */
export function updateFunctionByte(lastReceived: number, change: FunctionChange): number {
  if (!Number.isInteger(lastReceived) || lastReceived < 0 || lastReceived > 0xff) {
    throw new RangeError(`Invalid function byte: ${lastReceived}`);
  }
  let byte = lastReceived;
  const apply = (mask: number, on: boolean | undefined): void => {
    if (on === undefined) return;
    byte = on ? byte | mask : byte & ~mask;
  };
  apply(
    FunctionBit.BYPASS_OTHER_SOURCE,
    change.bypassSource === undefined ? undefined : change.bypassSource === 'other',
  );
  apply(FunctionBit.TIME_SCHEDULE, change.timeSchedule);
  apply(FunctionBit.FIXED_AIRFLOW, change.fixedAirflow);
  apply(FunctionBit.OVER_VENTILATION, change.overVentilation);
  return byte & ~FunctionBit.HOLIDAY & 0xff;
}
