/**
 * ESP3 packets: encoding and incremental decoding (protocol.md § 1).
 *
 * Layout: `55` | data length (2 bytes, big-endian) | optional length (1) | packet type (1) |
 * header CRC8 | data | optional data | CRC8 of data + optional data.
 */
import { crc8 } from './crc8.ts';

/** First byte of every ESP3 packet. */
export const SYNC_BYTE = 0x55;

/** ESP3 packet types. */
export const PacketType = {
  RADIO_ERP1: 0x01,
  RESPONSE: 0x02,
  RADIO_SUB_TEL: 0x03,
  EVENT: 0x04,
  COMMON_COMMAND: 0x05,
  SMART_ACK_COMMAND: 0x06,
  REMOTE_MAN_COMMAND: 0x07,
  RADIO_MESSAGE: 0x09,
  RADIO_ERP2: 0x0a,
} as const;

/** Numeric value of a {@link PacketType}. */
export type PacketTypeValue = (typeof PacketType)[keyof typeof PacketType];

/** A decoded (or to-be-encoded) ESP3 packet. */
export interface Esp3Packet {
  /** Packet type, see {@link PacketType}. Unknown types are kept as numbers. */
  readonly type: number;
  readonly data: Uint8Array;
  readonly optional: Uint8Array;
}

const HEADER_LENGTH = 6; // sync + 4 header bytes + header CRC

/** Encodes a packet into its full byte representation, CRCs included. */
export function encodePacket(packet: Esp3Packet): Uint8Array {
  const { type, data, optional } = packet;
  if (data.length > 0xffff) throw new RangeError('ESP3 data too long');
  if (optional.length > 0xff) throw new RangeError('ESP3 optional data too long');
  if (!Number.isInteger(type) || type < 0 || type > 0xff) {
    throw new RangeError(`Invalid ESP3 packet type: ${type}`);
  }
  const out = new Uint8Array(HEADER_LENGTH + data.length + optional.length + 1);
  out[0] = SYNC_BYTE;
  out[1] = data.length >> 8;
  out[2] = data.length & 0xff;
  out[3] = optional.length;
  out[4] = type;
  out[5] = crc8(out, 1, 5);
  out.set(data, HEADER_LENGTH);
  out.set(optional, HEADER_LENGTH + data.length);
  out[out.length - 1] = crc8(out, HEADER_LENGTH, out.length - 1);
  return out;
}

/** Why bytes were discarded by the {@link Esp3Decoder}. */
export type DiscardReason = 'garbage' | 'bad_header_crc' | 'bad_data_crc' | 'too_long';

/** Options of {@link Esp3Decoder}. */
export interface Esp3DecoderOptions {
  /**
   * Largest accepted data + optional length. A header announcing more is treated like a bad
   * header (resynchronisation), so that a corrupted length cannot stall the decoder.
   * Default 1024: ERP1 telegrams and common command responses are far shorter.
   */
  readonly maxPayloadLength?: number;
  /** Called for every discarded byte run, e.g. for debug logging. */
  readonly onDiscard?: (reason: DiscardReason, bytes: Uint8Array) => void;
}

/** Counters kept by the {@link Esp3Decoder}. */
export interface Esp3DecoderStats {
  packets: number;
  garbageBytes: number;
  badHeaderCrc: number;
  badDataCrc: number;
  tooLong: number;
}

/**
 * Incremental ESP3 decoder: feed it arbitrary chunks of the byte stream, get complete packets
 * back.
 *
 * - Bytes before a `55` are dropped.
 * - On a bad header CRC the `55` is dropped and the search starts again from the next byte.
 * - On a bad data CRC the packet is skipped. The search for the next `55` restarts right after
 *   the dropped `55` (not after the announced length), so that a header CRC that matched by
 *   chance cannot swallow the valid packets that follow.
 */
export class Esp3Decoder {
  readonly stats: Esp3DecoderStats = {
    packets: 0,
    garbageBytes: 0,
    badHeaderCrc: 0,
    badDataCrc: 0,
    tooLong: 0,
  };

  readonly #maxPayloadLength: number;
  readonly #onDiscard: ((reason: DiscardReason, bytes: Uint8Array) => void) | undefined;
  #buffer: Uint8Array = new Uint8Array(0);

  constructor(options: Esp3DecoderOptions = {}) {
    this.#maxPayloadLength = options.maxPayloadLength ?? 1024;
    this.#onDiscard = options.onDiscard;
  }

  /** Number of bytes waiting for the rest of a packet. */
  get pendingBytes(): number {
    return this.#buffer.length;
  }

  /** Drops any partial packet (e.g. after a reconnection). */
  reset(): void {
    this.#buffer = new Uint8Array(0);
  }

  /** Feeds a chunk and returns the packets it completes (possibly none). */
  push(chunk: Uint8Array): Esp3Packet[] {
    const buffer = new Uint8Array(this.#buffer.length + chunk.length);
    buffer.set(this.#buffer, 0);
    buffer.set(chunk, this.#buffer.length);

    const packets: Esp3Packet[] = [];
    let pos = 0;
    for (;;) {
      const sync = buffer.indexOf(SYNC_BYTE, pos);
      if (sync < 0) {
        this.#discard('garbage', buffer.subarray(pos));
        pos = buffer.length;
        break;
      }
      if (sync > pos) this.#discard('garbage', buffer.subarray(pos, sync));
      pos = sync;
      if (buffer.length - pos < HEADER_LENGTH) break; // wait for the header

      if (crc8(buffer, pos + 1, pos + 5) !== buffer[pos + 5]) {
        this.#discard('bad_header_crc', buffer.subarray(pos, pos + 1));
        pos += 1;
        continue;
      }
      const dataLength = ((buffer[pos + 1] ?? 0) << 8) | (buffer[pos + 2] ?? 0);
      const optionalLength = buffer[pos + 3] ?? 0;
      if (dataLength + optionalLength > this.#maxPayloadLength) {
        this.#discard('too_long', buffer.subarray(pos, pos + 1));
        pos += 1;
        continue;
      }
      const total = HEADER_LENGTH + dataLength + optionalLength + 1;
      if (buffer.length - pos < total) break; // wait for the rest

      const dataStart = pos + HEADER_LENGTH;
      const crcIndex = pos + total - 1;
      if (crc8(buffer, dataStart, crcIndex) !== buffer[crcIndex]) {
        this.#discard('bad_data_crc', buffer.subarray(pos, pos + 1));
        pos += 1;
        continue;
      }
      packets.push({
        type: buffer[pos + 4] ?? 0,
        data: buffer.slice(dataStart, dataStart + dataLength),
        optional: buffer.slice(dataStart + dataLength, crcIndex),
      });
      this.stats.packets += 1;
      pos += total;
    }
    this.#buffer = buffer.slice(pos);
    return packets;
  }

  #discard(reason: DiscardReason, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    switch (reason) {
      case 'garbage':
        this.stats.garbageBytes += bytes.length;
        break;
      case 'bad_header_crc':
        this.stats.badHeaderCrc += 1;
        break;
      case 'bad_data_crc':
        this.stats.badDataCrc += 1;
        break;
      case 'too_long':
        this.stats.tooLong += 1;
        break;
    }
    this.#onDiscard?.(reason, bytes.slice());
  }
}
