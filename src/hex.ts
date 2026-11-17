/**
 * Hexadecimal and EnOcean ID helpers.
 *
 * EnOcean IDs are handled as 8-character upper-case hexadecimal strings (for example
 * `0400AA01`): easy to compare, to log and to use in MQTT topics.
 */

/** An EnOcean ID as an 8-character upper-case hexadecimal string. */
export type EnOceanId = string;

/** The broadcast destination ID. */
export const BROADCAST_ID: EnOceanId = 'FFFFFFFF';

const ID_PATTERN = /^[0-9A-F]{8}$/;

/** Formats bytes as upper-case hexadecimal, optionally separated (e.g. by a space). */
export function toHex(bytes: Uint8Array, separator = ''): string {
  const parts: string[] = [];
  for (const byte of bytes) {
    parts.push(byte.toString(16).toUpperCase().padStart(2, '0'));
  }
  return parts.join(separator);
}

/**
 * Parses hexadecimal text into bytes. Spaces are ignored; anything else that is not a pair of
 * hexadecimal digits throws.
 */
export function fromHex(text: string): Uint8Array {
  const compact = text.replace(/\s+/g, '');
  if (compact.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(compact)) {
    throw new Error(`Invalid hexadecimal string: "${text}"`);
  }
  const bytes = new Uint8Array(compact.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Returns true when `value` is an 8-digit hexadecimal ID (any case). */
export function isEnOceanId(value: string): boolean {
  return ID_PATTERN.test(value.trim().toUpperCase());
}

/** Normalises an ID (trims, upper-cases) and throws if it is not 8 hexadecimal digits. */
export function normalizeId(value: string): EnOceanId {
  const id = value.trim().toUpperCase();
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Invalid EnOcean ID: "${value}" (expected 8 hexadecimal digits)`);
  }
  return id;
}

/** Reads a 4-byte ID at `offset`. The caller guarantees the bytes exist. */
export function readId(bytes: Uint8Array, offset: number): EnOceanId {
  return toHex(bytes.subarray(offset, offset + 4));
}

/** Converts an ID to its 4 bytes. */
export function idToBytes(id: EnOceanId): Uint8Array {
  return fromHex(normalizeId(id));
}

/** Converts an ID to an unsigned 32-bit integer. */
export function idToNumber(id: EnOceanId): number {
  return Number.parseInt(normalizeId(id), 16);
}

/** Converts an unsigned 32-bit integer to an ID. */
export function numberToId(value: number): EnOceanId {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`Not a 32-bit ID: ${value}`);
  }
  return value.toString(16).toUpperCase().padStart(8, '0');
}
