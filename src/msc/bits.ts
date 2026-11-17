/**
 * Bit-field access on MSC payloads (protocol.md § 3).
 *
 * Offsets count from the most significant bit of the first payload byte (the `07` of `07 9x`),
 * as in EEP profiles. A field that does not fit in the received payload is absent.
 */

/**
 * Reads an unsigned field of `size` bits (1–32) at bit `offset`. Returns `undefined` when the
 * field extends beyond the payload (short frame), never 0.
 */
export function readBits(payload: Uint8Array, offset: number, size: number): number | undefined {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(size) || size < 1 || size > 32) {
    throw new RangeError(`Invalid bit field: offset ${offset}, size ${size}`);
  }
  if (offset + size > payload.length * 8) return undefined;
  let value = 0;
  for (let bit = offset; bit < offset + size; bit += 1) {
    const byte = payload[bit >> 3] ?? 0;
    // Multiplication instead of << keeps 32-bit fields unsigned.
    value = value * 2 + ((byte >> (7 - (bit & 7))) & 1);
  }
  return value;
}

/** Interprets an unsigned `bits`-wide value as two's complement. */
export function toSigned(value: number, bits: number): number {
  const half = 2 ** (bits - 1);
  return value >= half ? value - 2 * half : value;
}

/** Reads a signed (two's complement) field; `undefined` when absent. */
export function readSigned(payload: Uint8Array, offset: number, size: number): number | undefined {
  const value = readBits(payload, offset, size);
  return value === undefined ? undefined : toSigned(value, size);
}

/** Reads a 1-bit flag as a boolean; `undefined` when absent. */
export function readFlag(payload: Uint8Array, offset: number): boolean | undefined {
  const value = readBits(payload, offset, 1);
  return value === undefined ? undefined : value === 1;
}
