/**
 * Orders sent to the unit (protocol.md § 6): settings (`CMD 0`), clock (`CMD 1`).
 *
 * Transmission: RORG `D1`, sender = paired ID, status `80`, destination broadcast.
 * Values are validated: out-of-range values throw an {@link OrderError}, never clamped.
 */
import { Rorg, type TransmitTelegram } from './erp1.ts';
import { BROADCAST_ID, normalizeId, type EnOceanId } from './hex.ts';
import { mscHeaderBytes } from './msc/envelope.ts';
import { FunctionBit } from './msc/function-byte.ts';
import {
  HYDROR_DISABLED,
  PREHEAT_DISABLED,
  SOLARR_DISABLED,
  UNIT_MODES,
  type UnitMode,
} from './msc/unit.ts';

/** Status byte of the orders. */
export const ORDER_STATUS = 0x80;

/** Rank value meaning "leave unchanged". */
export const UNCHANGED = 0xff;

/** Rank-9 one-shot commands. */
export const OneShotCommand = {
  /** Request a data refresh [P]. */
  refresh: 1,
  /** Filter reset (after a filter change) [T]. */
  filter_reset: 4,
} as const;

/** Name of a rank-9 one-shot command. */
export type OneShotCommandName = keyof typeof OneShotCommand;

/** Valid ranges of the settings (inclusive). */
export const SETTING_RANGES = {
  holidayDays: { min: 0, max: 254 },
  boostMinutes: { min: 0, max: 200 },
  preheatSetpoint: { min: 12, max: 18 },
  maxSupplyTemperature: { min: 20, max: 45 },
  hydroRSetpoint: { min: 8, max: 28 },
  solarRSetpoint: { min: 18, max: 30 },
} as const;

/**
 * A `CMD 0` settings order. Every field is optional; missing fields are sent as `FF`
 * (unchanged), so several settings can share one frame.
 */
export interface SettingsOrder {
  /** Rank 1. */
  readonly mode?: UnitMode;
  /**
   * Rank 2: the whole function byte, built with {@link updateFunctionByte} from the last byte
   * received. The holiday bit (0) must be clear.
   */
  readonly functionByte?: number;
  /** Rank 3: holiday length in days, `0` = stop. */
  readonly holidayDays?: number;
  /** Rank 4: boost length in minutes, `0` = stop. */
  readonly boostMinutes?: number;
  /** Rank 5: °C (12–18) or `off` (sends `4`). */
  readonly preheatSetpoint?: number | 'off';
  /** Rank 6: °C (20–45). */
  readonly maxSupplyTemperature?: number;
  /** Rank 7: °C (8–28) or `off` (sends `6`). */
  readonly hydroRSetpoint?: number | 'off';
  /** Rank 8: °C (18–30) or `off` (sends `0`). */
  readonly solarRSetpoint?: number | 'off';
  /** Rank 9: one-shot command. */
  readonly oneShot?: OneShotCommandName;
}

/** Thrown when an order holds an invalid value. */
export class OrderError extends RangeError {
  /** The offending field. */
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'OrderError';
    this.field = field;
  }
}

function checkInteger(field: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new OrderError(field, `${value} is not an integer in ${min}–${max}`);
  }
  return value;
}

function setpoint(
  field: keyof typeof SETTING_RANGES,
  value: number | 'off' | undefined,
  off: number,
): number {
  if (value === undefined) return UNCHANGED;
  if (value === 'off') return off;
  const range = SETTING_RANGES[field];
  return checkInteger(field, value, range.min, range.max);
}

/**
 * Encodes a settings order as an MSC payload: `07 90` then the 9 ranks. Throws an
 * {@link OrderError} on an invalid value or an empty order.
 */
export function encodeSettings(order: SettingsOrder): Uint8Array {
  const ranks = new Uint8Array(9).fill(UNCHANGED);

  if (order.mode !== undefined) {
    const index = UNIT_MODES.indexOf(order.mode);
    if (index < 0) throw new OrderError('mode', `unknown mode "${order.mode}"`);
    ranks[0] = index;
  }
  if (order.functionByte !== undefined) {
    const byte = checkInteger('functionByte', order.functionByte, 0, 0xfe);
    if ((byte & FunctionBit.HOLIDAY) !== 0) {
      throw new OrderError('functionByte', 'the holiday bit must be clear (use holidayDays)');
    }
    ranks[1] = byte;
  }
  if (order.holidayDays !== undefined) {
    const { min, max } = SETTING_RANGES.holidayDays;
    ranks[2] = checkInteger('holidayDays', order.holidayDays, min, max);
  }
  if (order.boostMinutes !== undefined) {
    const { min, max } = SETTING_RANGES.boostMinutes;
    ranks[3] = checkInteger('boostMinutes', order.boostMinutes, min, max);
  }
  ranks[4] = setpoint('preheatSetpoint', order.preheatSetpoint, PREHEAT_DISABLED);
  if (order.maxSupplyTemperature !== undefined) {
    const { min, max } = SETTING_RANGES.maxSupplyTemperature;
    ranks[5] = checkInteger('maxSupplyTemperature', order.maxSupplyTemperature, min, max);
  }
  ranks[6] = setpoint('hydroRSetpoint', order.hydroRSetpoint, HYDROR_DISABLED);
  ranks[7] = setpoint('solarRSetpoint', order.solarRSetpoint, SOLARR_DISABLED);
  if (order.oneShot !== undefined) {
    const code = (OneShotCommand as Record<string, number | undefined>)[order.oneShot];
    if (code === undefined) {
      throw new OrderError('oneShot', `unknown command "${order.oneShot}"`);
    }
    ranks[8] = code;
  }
  if (ranks.every((rank) => rank === UNCHANGED)) {
    throw new OrderError('order', 'nothing to send');
  }

  const payload = new Uint8Array(11);
  payload.set(mscHeaderBytes(0), 0);
  payload.set(ranks, 2);
  return payload;
}

/** Merges orders into one; later orders win on the same field. */
export function mergeSettings(...orders: readonly SettingsOrder[]): SettingsOrder {
  return Object.assign({}, ...orders) as SettingsOrder;
}

/**
 * Encodes the clock order (`CMD 1`): `07 91` then year (2 digits), month, day, hour, minute,
 * second, in the local time of `date`.
 */
export function encodeClock(date: Date): Uint8Array {
  if (Number.isNaN(date.getTime())) throw new OrderError('date', 'invalid date');
  return Uint8Array.of(
    ...mscHeaderBytes(1),
    date.getFullYear() % 100,
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  );
}

/** Wraps an order payload into the telegram to transmit (status `80`, broadcast). */
export function buildOrderTelegram(payload: Uint8Array, senderId: EnOceanId): TransmitTelegram {
  return {
    rorg: Rorg.MSC,
    payload,
    senderId: normalizeId(senderId),
    status: ORDER_STATUS,
    destinationId: BROADCAST_ID,
  };
}

/** Builds the telegram of a settings order. */
export function buildSettingsTelegram(order: SettingsOrder, senderId: EnOceanId): TransmitTelegram {
  return buildOrderTelegram(encodeSettings(order), senderId);
}

/** Builds the telegram of a clock order. */
export function buildClockTelegram(date: Date, senderId: EnOceanId): TransmitTelegram {
  return buildOrderTelegram(encodeClock(date), senderId);
}
