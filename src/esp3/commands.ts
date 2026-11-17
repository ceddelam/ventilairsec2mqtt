/**
 * ESP3 common commands used by the bridge and RESPONSE / EVENT packets (protocol.md § 1).
 */
import { idToBytes, idToNumber, readId, type EnOceanId } from '../hex.ts';
import { PacketType, type Esp3Packet } from './packet.ts';

/** Common command codes (packet type `05`). */
export const CommonCommand = {
  CO_WR_RESET: 0x02,
  CO_WR_IDBASE: 0x07,
  CO_RD_IDBASE: 0x08,
} as const;

/** RESPONSE return codes (first data byte of a packet of type `02`). */
export const ReturnCode = {
  OK: 0x00,
  ERROR: 0x01,
  NOT_SUPPORTED: 0x02,
  WRONG_PARAM: 0x03,
  OPERATION_DENIED: 0x04,
  LOCK_SET: 0x05,
  BUFFER_TO_SMALL: 0x06,
  NO_FREE_BUFFER: 0x07,
  FLASH_HW_ERROR: 0x82,
  BASEID_OUT_OF_RANGE: 0x90,
  BASEID_MAX_REACHED: 0x91,
} as const;

const RETURN_CODE_NAMES = new Map<number, string>(
  Object.entries(ReturnCode).map(([name, code]) => [code, name]),
);

/** Human-readable name of a return code, e.g. `OK` or `0x42` when unknown. */
export function returnCodeName(code: number): string {
  return RETURN_CODE_NAMES.get(code) ?? `0x${code.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** EVENT codes (first data byte of a packet of type `04`). */
export const EventCode = {
  SA_RECLAIM_NOT_SUCCESSFUL: 0x01,
  SA_CONFIRM_LEARN: 0x02,
  SA_LEARN_ACK: 0x03,
  CO_READY: 0x04,
  CO_EVENT_SECUREDEVICES: 0x05,
  CO_DUTYCYCLE_LIMIT: 0x06,
  CO_TRANSMIT_FAILED: 0x07,
} as const;

const EVENT_CODE_NAMES = new Map<number, string>(
  Object.entries(EventCode).map(([name, code]) => [code, name]),
);

/** Human-readable name of an event code, e.g. `CO_READY` or `0x42` when unknown. */
export function eventCodeName(code: number): string {
  return EVENT_CODE_NAMES.get(code) ?? `0x${code.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** A RESPONSE packet split into its return code and the rest. */
export interface Esp3Response {
  readonly returnCode: number;
  /** Response data after the return code. */
  readonly data: Uint8Array;
  readonly optional: Uint8Array;
}

/** An EVENT packet split into its code and the rest. */
export interface Esp3Event {
  readonly code: number;
  readonly name: string;
  /** Event data after the code. */
  readonly data: Uint8Array;
  readonly optional: Uint8Array;
}

/** Parses a RESPONSE packet. Throws if the packet is not a RESPONSE or is empty. */
export function parseResponse(packet: Esp3Packet): Esp3Response {
  if (packet.type !== PacketType.RESPONSE) {
    throw new Error(`Not a RESPONSE packet (type ${packet.type})`);
  }
  const returnCode = packet.data[0];
  if (returnCode === undefined) throw new Error('Empty RESPONSE packet');
  return { returnCode, data: packet.data.slice(1), optional: packet.optional };
}

/** Parses an EVENT packet. Throws if the packet is not an EVENT or is empty. */
export function parseEvent(packet: Esp3Packet): Esp3Event {
  if (packet.type !== PacketType.EVENT) {
    throw new Error(`Not an EVENT packet (type ${packet.type})`);
  }
  const code = packet.data[0];
  if (code === undefined) throw new Error('Empty EVENT packet');
  return { code, name: eventCodeName(code), data: packet.data.slice(1), optional: packet.optional };
}

function commonCommand(code: number, args: Uint8Array = new Uint8Array(0)): Esp3Packet {
  const data = new Uint8Array(1 + args.length);
  data[0] = code;
  data.set(args, 1);
  return { type: PacketType.COMMON_COMMAND, data, optional: new Uint8Array(0) };
}

/** `CO_RD_IDBASE`: asks the stick for its Base ID. */
export function buildReadIdBase(): Esp3Packet {
  return commonCommand(CommonCommand.CO_RD_IDBASE);
}

/** `CO_WR_RESET`: resets the stick (sent after a Base ID write). */
export function buildReset(): Esp3Packet {
  return commonCommand(CommonCommand.CO_WR_RESET);
}

/** Lowest valid Base ID. */
export const BASE_ID_MIN = 0xff800000;
/** Highest valid Base ID. */
export const BASE_ID_MAX = 0xffffff80;

/**
 * Checks that `id` can be written as a Base ID: within `FF800000`–`FFFFFF80` and a multiple of
 * `0x80`. Throws a `RangeError` otherwise.
 */
export function validateBaseId(id: EnOceanId): void {
  const value = idToNumber(id);
  if (value < BASE_ID_MIN || value > BASE_ID_MAX) {
    throw new RangeError(`Base ID ${id} out of range FF800000–FFFFFF80`);
  }
  if (value % 0x80 !== 0) {
    throw new RangeError(`Base ID ${id} is not a multiple of 0x80`);
  }
}

/**
 * `CO_WR_IDBASE`: writes the Base ID. The stick accepts a limited number of writes over its
 * lifetime (10): only use on explicit request. Validates the ID first.
 */
export function buildWriteIdBase(id: EnOceanId): Esp3Packet {
  validateBaseId(id);
  return commonCommand(CommonCommand.CO_WR_IDBASE, idToBytes(id));
}

/** Content of a successful `CO_RD_IDBASE` response. */
export interface BaseIdInfo {
  readonly baseId: EnOceanId;
  /** Number of Base ID writes left, when the stick reports it (optional data). */
  readonly remainingWrites: number | undefined;
}

/** Parses the response to `CO_RD_IDBASE`. Throws on a non-OK return code or short data. */
export function parseBaseIdResponse(response: Esp3Response): BaseIdInfo {
  if (response.returnCode !== ReturnCode.OK) {
    throw new Error(`CO_RD_IDBASE failed: ${returnCodeName(response.returnCode)}`);
  }
  if (response.data.length < 4) throw new Error('CO_RD_IDBASE response too short');
  return { baseId: readId(response.data, 0), remainingWrites: response.optional[0] };
}
