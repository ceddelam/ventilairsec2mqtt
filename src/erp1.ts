/**
 * ERP1 radio telegrams carried in RADIO_ERP1 packets (protocol.md § 1).
 *
 * Data: RORG | payload | sender ID (4) | status (1).
 * Optional data on receive: sub-telegram count | destination (4) | level (−dBm) | security level.
 * Optional data on transmit: `03` | destination | `FF` | `00`.
 */
import { PacketType, type Esp3Packet } from './esp3/packet.ts';
import { BROADCAST_ID, idToBytes, normalizeId, readId, type EnOceanId } from './hex.ts';

/** Radio telegram types used here. */
export const Rorg = {
  /** Chained message piece. */
  CHAINED: 0x40,
  /** Universal Teach-in (UTE). */
  UTE: 0xd4,
  /** Manufacturer-specific communication (MSC). */
  MSC: 0xd1,
} as const;

/** A received (or reassembled) ERP1 telegram. */
export interface Erp1Telegram {
  readonly rorg: number;
  /** Bytes between the RORG and the sender ID. */
  readonly payload: Uint8Array;
  readonly senderId: EnOceanId;
  readonly status: number;
  /** Sub-telegram count, from the optional data. */
  readonly subTelegrams: number | undefined;
  /** Destination ID (`FFFFFFFF` = broadcast), from the optional data. */
  readonly destinationId: EnOceanId | undefined;
  /** Received level in dBm, a negative number, from the optional data. */
  readonly dbm: number | undefined;
  /** Security level, from the optional data. */
  readonly securityLevel: number | undefined;
}

/** Minimum ERP1 data length: RORG + sender + status. */
const MIN_DATA_LENGTH = 6;

/**
 * Parses RADIO_ERP1 data and optional data. Missing optional fields are `undefined`. Throws if
 * the data is shorter than RORG + sender + status.
 */
export function parseErp1(
  data: Uint8Array,
  optional: Uint8Array = new Uint8Array(0),
): Erp1Telegram {
  if (data.length < MIN_DATA_LENGTH) {
    throw new Error(`ERP1 data too short (${data.length} bytes)`);
  }
  const rorg = data[0] ?? 0;
  const statusIndex = data.length - 1;
  const level = optional[5];
  return {
    rorg,
    payload: data.slice(1, statusIndex - 4),
    senderId: readId(data, statusIndex - 4),
    status: data[statusIndex] ?? 0,
    subTelegrams: optional[0],
    destinationId: optional.length >= 5 ? readId(optional, 1) : undefined,
    dbm: level === undefined ? undefined : level === 0 ? 0 : -level,
    securityLevel: optional[6],
  };
}

/** Parses a RADIO_ERP1 packet. Throws if the packet has another type. */
export function parseErp1Packet(packet: Esp3Packet): Erp1Telegram {
  if (packet.type !== PacketType.RADIO_ERP1) {
    throw new Error(`Not a RADIO_ERP1 packet (type ${packet.type})`);
  }
  return parseErp1(packet.data, packet.optional);
}

/** Serialises the data part of a telegram: RORG | payload | sender | status. */
export function erp1Data(
  telegram: Pick<Erp1Telegram, 'rorg' | 'payload' | 'senderId' | 'status'>,
): Uint8Array {
  const data = new Uint8Array(1 + telegram.payload.length + 5);
  data[0] = telegram.rorg;
  data.set(telegram.payload, 1);
  data.set(idToBytes(telegram.senderId), 1 + telegram.payload.length);
  data[data.length - 1] = telegram.status;
  return data;
}

/** A telegram to transmit. */
export interface TransmitTelegram {
  readonly rorg: number;
  readonly payload: Uint8Array;
  readonly senderId: EnOceanId;
  readonly status: number;
  /** Destination; broadcast when omitted. */
  readonly destinationId?: EnOceanId;
}

/** Builds the RADIO_ERP1 packet that transmits `telegram` (optional `03 | dest | FF | 00`). */
export function buildErp1Packet(telegram: TransmitTelegram): Esp3Packet {
  const destination = normalizeId(telegram.destinationId ?? BROADCAST_ID);
  const optional = new Uint8Array(7);
  optional[0] = 0x03;
  optional.set(idToBytes(destination), 1);
  optional[5] = 0xff;
  optional[6] = 0x00;
  return {
    type: PacketType.RADIO_ERP1,
    data: erp1Data({ ...telegram, senderId: normalizeId(telegram.senderId) }),
    optional,
  };
}
