/**
 * Pairing with the unit through UTE teach-in (RORG `D4`, protocol.md § 7).
 */
import { Rorg, type Erp1Telegram, type TransmitTelegram } from './erp1.ts';
import { normalizeId, type EnOceanId } from './hex.ts';

/** Fields of a UTE teach-in query (payload of a RORG `D4` telegram). */
export interface UteQuery {
  /** First payload byte (`80` for the unit's query). */
  readonly commandByte: number;
  readonly channels: number;
  /** 11-bit manufacturer ID (`079` for Ventilairsec). */
  readonly manufacturer: number;
  readonly type: number;
  readonly func: number;
  readonly rorg: number;
}

const UTE_PAYLOAD_LENGTH = 7;

/**
 * Parses a UTE telegram payload; `undefined` when the telegram is not RORG `D4` or is too short.
 */
export function parseUte(telegram: Erp1Telegram): UteQuery | undefined {
  const p = telegram.payload;
  if (telegram.rorg !== Rorg.UTE || p.length < UTE_PAYLOAD_LENGTH) return undefined;
  return {
    commandByte: p[0] ?? 0,
    channels: p[1] ?? 0,
    manufacturer: (((p[3] ?? 0) & 0x07) << 8) | (p[2] ?? 0),
    type: p[4] ?? 0,
    func: p[5] ?? 0,
    rorg: p[6] ?? 0,
  };
}

/**
 * True when `telegram` is a UTE teach-in query that expects an answer: bidirectional (bit 7 = 1),
 * response expected (bit 6 = 0), teach-in request (bits 5-4 = `00`), "query" command
 * (bits 3-0 = `0`). The unit's query starts with `80`.
 */
export function isTeachInQuery(telegram: Erp1Telegram): boolean {
  const query = parseUte(telegram);
  if (query === undefined) return false;
  const b = query.commandByte;
  const bidirectional = (b & 0x80) !== 0;
  const responseExpected = (b & 0x40) === 0;
  const teachInRequest = (b & 0x30) === 0x00;
  const queryCommand = (b & 0x0f) === 0x0;
  return bidirectional && responseExpected && teachInRequest && queryCommand;
}

/** UTE response command byte: bidirectional, teach-in accepted, "response" command. */
export const UTE_RESPONSE_ACCEPTED = 0x91;

/**
 * Builds the pairing response to a teach-in query: `D4 91` then the next 6 bytes of the query,
 * sent from `senderId`, addressed to the unit (the query's sender), status `00`.
 */
export function buildTeachInResponse(query: Erp1Telegram, senderId: EnOceanId): TransmitTelegram {
  if (!isTeachInQuery(query)) throw new Error('Not a UTE teach-in query expecting a response');
  const payload = new Uint8Array(UTE_PAYLOAD_LENGTH);
  payload[0] = UTE_RESPONSE_ACCEPTED;
  payload.set(query.payload.subarray(1, UTE_PAYLOAD_LENGTH), 1);
  return {
    rorg: Rorg.UTE,
    payload,
    senderId: normalizeId(senderId),
    status: 0x00,
    destinationId: query.senderId,
  };
}

/** Durations and switch of the automatic pairing answer. */
export interface PairingPolicyOptions {
  /** Answer queries at all. Turn off once paired. */
  readonly enabled: boolean;
  /** Minimum delay between two answers (ms). Default 10 min. */
  readonly minIntervalMs?: number;
  /** Only answer when the unit addressed nothing to our ID for this long (ms). Default 15 min. */
  readonly quietPeriodMs?: number;
}

/** Timestamps the policy decides on (ms, same clock as `now`). */
export interface PairingPolicyState {
  /** When we last answered a query. */
  readonly lastAnswerAt: number | undefined;
  /** When the unit last sent a telegram addressed to our sender ID. */
  readonly lastAddressedToUsAt: number | undefined;
}

/** Default minimum delay between two answers: 10 min. */
export const DEFAULT_PAIRING_MIN_INTERVAL_MS = 10 * 60_000;
/** Default quiet period before answering: 15 min. */
export const DEFAULT_PAIRING_QUIET_PERIOD_MS = 15 * 60_000;

/**
 * Pure decision: should a teach-in query received at `now` be answered? Yes only when enabled,
 * no answer was sent during the last `minIntervalMs`, and the unit addressed nothing to our ID
 * during the last `quietPeriodMs` (a paired unit keeps asking for hours).
 */
export function shouldAnswerTeachIn(
  now: number,
  state: PairingPolicyState,
  options: PairingPolicyOptions,
): boolean {
  if (!options.enabled) return false;
  const minInterval = options.minIntervalMs ?? DEFAULT_PAIRING_MIN_INTERVAL_MS;
  const quietPeriod = options.quietPeriodMs ?? DEFAULT_PAIRING_QUIET_PERIOD_MS;
  if (state.lastAnswerAt !== undefined && now - state.lastAnswerAt < minInterval) return false;
  if (state.lastAddressedToUsAt !== undefined && now - state.lastAddressedToUsAt < quietPeriod) {
    return false;
  }
  return true;
}
