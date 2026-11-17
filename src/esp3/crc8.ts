/**
 * CRC8 used by ESP3: polynomial 0x07, initial value 0, no reflection, no final XOR
 * (protocol.md § 1).
 */

const TABLE = buildTable();

function buildTable(): Uint8Array {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
    table[i] = crc;
  }
  return table;
}

/** Computes the ESP3 CRC8 of `bytes[start..end)`. */
export function crc8(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0;
  for (let i = start; i < end; i += 1) {
    crc = TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0;
  }
  return crc;
}
