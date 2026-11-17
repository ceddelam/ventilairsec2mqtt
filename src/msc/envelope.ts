/**
 * MSC envelope (RORG `D1`, protocol.md § 3): 12-bit manufacturer ID then 4-bit command number.
 */
import { readBits } from './bits.ts';

/** Ventilairsec manufacturer ID. */
export const VENTILAIRSEC_MANUFACTURER = 0x079;

/** Manufacturer and command of an MSC payload. */
export interface MscHeader {
  readonly manufacturer: number;
  readonly command: number;
}

/** Reads the MSC header; `undefined` when the payload is shorter than 2 bytes. */
export function parseMscHeader(payload: Uint8Array): MscHeader | undefined {
  const manufacturer = readBits(payload, 0, 12);
  const command = readBits(payload, 12, 4);
  if (manufacturer === undefined || command === undefined) return undefined;
  return { manufacturer, command };
}

/** Builds the 2-byte MSC header `07 9x` for a Ventilairsec command. */
export function mscHeaderBytes(command: number): [number, number] {
  if (!Number.isInteger(command) || command < 0 || command > 15) {
    throw new RangeError(`Invalid MSC command: ${command}`);
  }
  return [VENTILAIRSEC_MANUFACTURER >> 4, ((VENTILAIRSEC_MANUFACTURER & 0x0f) << 4) | command];
}
