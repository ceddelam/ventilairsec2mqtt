/**
 * Orders received on MQTT (mqtt-interface.md § 6): JSON on `<prefix>/<vmi_id>/set`, raw value
 * on `<prefix>/<vmi_id>/set/<key>`. Values are validated and rejected when invalid, never
 * clamped.
 */
import type { BypassSource, FunctionChange } from '../msc/function-byte.ts';
import { UNIT_MODES, type UnitMode } from '../msc/unit.ts';
import { SETTING_RANGES } from '../orders.ts';
import { BOOST_DURATION, HOLIDAY_DURATION } from './state-store.ts';

/** An order value was rejected. */
export class InvalidOrderError extends Error {
  /** The offending key (or `order` for the whole order). */
  readonly key: string;

  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = 'InvalidOrderError';
    this.key = key;
  }
}

/** Switch value: on (with the stored duration), off, or an explicit duration (`0` = stop). */
export type DurationSwitch = 'on' | 'off' | number;

/** A validated order, before durations and the function byte are resolved. */
export interface ParsedOrder {
  readonly mode?: UnitMode;
  readonly boost?: DurationSwitch;
  readonly holiday?: DurationSwitch;
  readonly functionChange: FunctionChange;
  readonly preheatSetpoint?: number | 'off';
  readonly maxSupplyTemperature?: number;
  readonly hydroRSetpoint?: number | 'off';
  readonly solarRSetpoint?: number | 'off';
  readonly oneShot?: 'refresh' | 'filter_reset';
  readonly boostDuration?: number;
  readonly holidayDuration?: number;
  readonly syncClock: boolean;
}

/** Keys accepted in an order. */
export const ORDER_KEYS = [
  'mode',
  'boost',
  'holiday',
  'fixed_airflow',
  'over_ventilation',
  'time_schedule',
  'bypass_source',
  'preheat_setpoint',
  'max_supply_temperature',
  'hydror_setpoint',
  'solarr_setpoint',
  'boost_duration',
  'holiday_duration',
  'refresh',
  'filter_reset',
  'sync_clock',
] as const;

/** An order key. */
export type OrderKey = (typeof ORDER_KEYS)[number];

function isOrderKey(key: string): key is OrderKey {
  return (ORDER_KEYS as readonly string[]).includes(key);
}

function describe(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  return value === undefined ? 'nothing' : JSON.stringify(value);
}

/** `true`/`false` or `ON`/`OFF` (any case, as JSON booleans or strings). */
function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'on' || text === 'true') return true;
    if (text === 'off' || text === 'false') return false;
  }
  return undefined;
}

function requireBoolean(key: string, value: unknown): boolean {
  const result = parseBoolean(value);
  if (result === undefined) {
    throw new InvalidOrderError(key, `expected true/false or ON/OFF, got ${describe(value)}`);
  }
  return result;
}

/** An integer as a JSON number or a string (`"30"`, `"30.0"`). */
function parseInteger(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^\s*-?\d+(\.0*)?\s*$/.test(value)) return Number(value);
  return undefined;
}

function requireInteger(key: string, value: unknown, min: number, max: number): number {
  const number = parseInteger(value);
  if (number === undefined || number < min || number > max) {
    throw new InvalidOrderError(
      key,
      `expected an integer in ${min}–${max}, got ${describe(value)}`,
    );
  }
  return number;
}

function requireChoice<T extends string>(key: string, value: unknown, choices: readonly T[]): T {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : undefined;
  const found = choices.find((choice) => choice === text);
  if (found === undefined) {
    throw new InvalidOrderError(
      key,
      `expected one of ${choices.join(', ')}, got ${describe(value)}`,
    );
  }
  return found;
}

function durationSwitch(key: string, value: unknown, max: number): DurationSwitch {
  const flag = parseBoolean(value);
  if (flag !== undefined) return flag ? 'on' : 'off';
  const number = parseInteger(value);
  if (number === undefined || number < 0 || number > max) {
    throw new InvalidOrderError(
      key,
      `expected true/false, ON/OFF or an integer in 0–${max}, got ${describe(value)}`,
    );
  }
  return number;
}

function setpoint(key: string, value: unknown, min: number, max: number): number | 'off' {
  if (typeof value === 'string' && value.trim().toLowerCase() === 'off') return 'off';
  const number = parseInteger(value);
  if (number === undefined || number < min || number > max) {
    throw new InvalidOrderError(
      key,
      `expected off or an integer in ${min}–${max}, got ${describe(value)}`,
    );
  }
  return number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function applyKey(order: Mutable<ParsedOrder>, key: OrderKey, value: unknown): void {
  const fn = order.functionChange as Mutable<FunctionChange>;
  switch (key) {
    case 'mode':
      order.mode = requireChoice(key, value, UNIT_MODES);
      return;
    case 'boost':
      order.boost = durationSwitch(key, value, SETTING_RANGES.boostMinutes.max);
      return;
    case 'holiday':
      order.holiday = durationSwitch(key, value, SETTING_RANGES.holidayDays.max);
      return;
    case 'fixed_airflow':
      fn.fixedAirflow = requireBoolean(key, value);
      return;
    case 'over_ventilation':
      fn.overVentilation = requireBoolean(key, value);
      return;
    case 'time_schedule':
      fn.timeSchedule = requireBoolean(key, value);
      return;
    case 'bypass_source':
      fn.bypassSource = requireChoice<BypassSource>(key, value, ['roof', 'other']);
      return;
    case 'preheat_setpoint': {
      const { min, max } = SETTING_RANGES.preheatSetpoint;
      order.preheatSetpoint = setpoint(key, value, min, max);
      return;
    }
    case 'max_supply_temperature': {
      const { min, max } = SETTING_RANGES.maxSupplyTemperature;
      order.maxSupplyTemperature = requireInteger(key, value, min, max);
      return;
    }
    case 'hydror_setpoint': {
      const { min, max } = SETTING_RANGES.hydroRSetpoint;
      order.hydroRSetpoint = setpoint(key, value, min, max);
      return;
    }
    case 'solarr_setpoint': {
      const { min, max } = SETTING_RANGES.solarRSetpoint;
      order.solarRSetpoint = setpoint(key, value, min, max);
      return;
    }
    case 'boost_duration':
      order.boostDuration = requireInteger(key, value, BOOST_DURATION.min, BOOST_DURATION.max);
      return;
    case 'holiday_duration':
      order.holidayDuration = requireInteger(
        key,
        value,
        HOLIDAY_DURATION.min,
        HOLIDAY_DURATION.max,
      );
      return;
    case 'refresh':
    case 'filter_reset':
      if (order.oneShot !== undefined && order.oneShot !== key) {
        throw new InvalidOrderError(key, 'refresh and filter_reset cannot share one order');
      }
      order.oneShot = key;
      return;
    case 'sync_clock':
      order.syncClock = true;
      return;
  }
}

/** Validates `[key, value]` pairs into one order. Throws an {@link InvalidOrderError}. */
export function parseOrderEntries(entries: readonly (readonly [string, unknown])[]): ParsedOrder {
  if (entries.length === 0) throw new InvalidOrderError('order', 'empty order');
  const order: Mutable<ParsedOrder> = { functionChange: {}, syncClock: false };
  for (const [key, value] of entries) {
    if (!isOrderKey(key)) {
      throw new InvalidOrderError(key, `unknown key (expected one of ${ORDER_KEYS.join(', ')})`);
    }
    applyKey(order, key, value);
  }
  return order;
}

/** Parses a JSON order (`<prefix>/<vmi_id>/set`). */
export function parseJsonOrder(payload: string): ParsedOrder {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    throw new InvalidOrderError('order', `not valid JSON: ${describe(payload)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidOrderError('order', `expected a JSON object, got ${describe(payload)}`);
  }
  return parseOrderEntries(Object.entries(raw));
}

/** Parses a raw value order (`<prefix>/<vmi_id>/set/<key>`). */
export function parseKeyOrder(key: string, payload: string): ParsedOrder {
  return parseOrderEntries([[key, payload]]);
}

/** True when the order changes the function byte. */
export function changesFunctionByte(order: ParsedOrder): boolean {
  return Object.values(order.functionChange).some((value) => value !== undefined);
}
