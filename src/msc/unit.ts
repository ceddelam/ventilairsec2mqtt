/**
 * Ventilation unit status frames (`D1-079-01`, commands 0 to 8, protocol.md § 5).
 *
 * Conventions for decoded fields:
 * - `undefined`: the field is absent from the frame (short frame), or its raw value is not in
 *   the known table (the `…Raw` field then holds it);
 * - `null`: the frame explicitly says "disabled", "no probe" or "not applicable";
 * - `…Raw` fields hold the byte as received.
 */
import { numberToId, type EnOceanId } from '../hex.ts';
import { readBits, readFlag, readSigned } from './bits.ts';
import { parseMscHeader } from './envelope.ts';
import { errorLabel, type UnitError } from './errors.ts';
import { decodeFunctionByte, type FunctionFlags } from './function-byte.ts';

/** Ventilation mode (§ 5.1, raw `0`–`3`). */
export type UnitMode = 'standby' | 'eco' | 'standard' | 'comfort';
/** Modes indexed by their raw value. */
export const UNIT_MODES: readonly UnitMode[] = ['standby', 'eco', 'standard', 'comfort'];

/** Season (§ 5.1, raw `0`–`2`). */
export type Season = 'summer' | 'winter' | 'mid_season';
/** Seasons indexed by their raw value. */
export const SEASONS: readonly Season[] = ['summer', 'winter', 'mid_season'];

/** System state (§ 5.2, raw `0`–`4`). */
export type SystemState = 'boost' | 'holiday' | 'standby' | 'fixed_airflow' | 'normal';
/** System states indexed by their raw value. */
export const SYSTEM_STATES: readonly SystemState[] = [
  'boost',
  'holiday',
  'standby',
  'fixed_airflow',
  'normal',
];

/** Unit type (§ 5.5, raw `1`–`3`). */
export type UnitType = 'purevent' | 'urban' | 'erp';
const UNIT_TYPES: Readonly<Record<number, UnitType>> = { 1: 'purevent', 2: 'urban', 3: 'erp' };

/** Internal probe position (§ 5.6, raw `0`–`4`; `255` = no probe). */
export type ProbePosition = 'supply' | 'intake' | 'water_loop' | 'solar' | 'bypass';
/** Probe positions indexed by their raw value. */
export const PROBE_POSITIONS: readonly ProbePosition[] = [
  'supply',
  'intake',
  'water_loop',
  'solar',
  'bypass',
];

/** Bypass position (§ 5.7, raw `0`–`4`; `255` = unknown). */
export type BypassPosition =
  'inactive' | 'other_heat_source' | 'solar_heat_source' | 'earth_tube' | 'manual';
/** Bypass positions indexed by their raw value. */
export const BYPASS_POSITIONS: readonly BypassPosition[] = [
  'inactive',
  'other_heat_source',
  'solar_heat_source',
  'earth_tube',
  'manual',
];

/** Room of a paired sensor (§ 5.8, raw `0`–`10`). */
export type Room =
  | 'unknown'
  | 'living_room'
  | 'kitchen'
  | 'bathroom_1'
  | 'bathroom_2'
  | 'bedroom_1'
  | 'bedroom_2'
  | 'bedroom_3'
  | 'bedroom_4'
  | 'utility_room'
  | 'neutral_zone';
/** Rooms indexed by their raw value. */
export const ROOMS: readonly Room[] = [
  'unknown',
  'living_room',
  'kitchen',
  'bathroom_1',
  'bathroom_2',
  'bedroom_1',
  'bedroom_2',
  'bedroom_3',
  'bedroom_4',
  'utility_room',
  'neutral_zone',
];

/** Profile of a paired sensor (§ 5.8, raw `1`–`4`). */
export type SensorProfile = 'assistant' | 'A5-04-01' | 'A5-09-04' | 'D2-04-08';
const SENSOR_PROFILES: Readonly<Record<number, SensorProfile>> = {
  1: 'assistant',
  2: 'A5-04-01',
  3: 'A5-09-04',
  4: 'D2-04-08',
};

/** Raw sentinel: electric preheating disabled (§ 5.1). */
export const PREHEAT_DISABLED = 4;
/** Raw sentinel: Hydro'R disabled (§ 5.1); `0` is reported when the option is absent. */
export const HYDROR_DISABLED = 6;
/** Raw sentinel: SolarR disabled (§ 5.1). */
export const SOLARR_DISABLED = 0;

/** `CMD 0` — current data (§ 5.1). */
export interface UnitCurrentData {
  readonly command: 0;
  readonly mode: UnitMode | undefined;
  readonly modeRaw: number | undefined;
  /** Function byte as received; needed to build function-byte orders (§ 6.1). */
  readonly functionByte: number | undefined;
  /** Known bits of the function byte (bits 24, 25 and 29 are unknown: see `functionByte`). */
  readonly functions: FunctionFlags | undefined;
  /** `0` off, `1`/`255` on with unknown time left, `2`–`200` minutes left. */
  readonly boostRaw: number | undefined;
  readonly boostActive: boolean | undefined;
  /** Minutes left when the unit reports them (`2`–`200`), otherwise `undefined`. */
  readonly boostMinutesLeft: number | undefined;
  readonly preheatSetpointRaw: number | undefined;
  /** °C; `null` = disabled (raw `4`). */
  readonly preheatSetpoint: number | null | undefined;
  /** °C. */
  readonly maxSupplyTemperature: number | undefined;
  readonly hydroRSetpointRaw: number | undefined;
  /** °C; `null` = disabled (raw `6`) or option absent (raw `0`). */
  readonly hydroRSetpoint: number | null | undefined;
  readonly solarRSetpointRaw: number | undefined;
  /** °C; `null` = disabled or option absent (raw `0`). */
  readonly solarRSetpoint: number | null | undefined;
  readonly firmwareUpdate: boolean | undefined;
  readonly pairingMode: boolean | undefined;
  readonly test: boolean | undefined;
  /** Bit 79, meaning unknown. */
  readonly localisationRaw: number | undefined;
  readonly season: Season | undefined;
  readonly seasonRaw: number | undefined;
  /** `0` periodic storage, `1` event-driven [P]; absent on firmware 3.7. */
  readonly eventTypeRaw: number | undefined;
}

/** `CMD 1` — complement 1 (§ 5.2). */
export interface UnitComplement1 {
  readonly command: 1;
  /** m³/h. */
  readonly airflow: number | undefined;
  /** %. */
  readonly preheatPower: number | undefined;
  readonly systemState: SystemState | undefined;
  readonly systemStateRaw: number | undefined;
  /** 0–5, read-only. */
  readonly motorSpeed: number | undefined;
}

/** `CMD 2` — complement 2 (§ 5.3). */
export interface UnitComplement2 {
  readonly command: 2;
  /** °C, signed. */
  readonly outdoorTemperature: number | undefined;
  /** Target of the fan control loop, raw (unit unconfirmed: tenths of a pascal?). */
  readonly pressureSetpointRaw: number | undefined;
  /** %. */
  readonly filterClogging: number | undefined;
  /** %. */
  readonly waterLoopDutyCycle: number | undefined;
  /** Operating time counter, days. */
  readonly operatingTimeDays: number | undefined;
}

/** Self-test results of `CMD 3`: `true` = OK, `false` = failed. */
export interface SelfTest {
  readonly airQuality: boolean | undefined;
  readonly motor: boolean | undefined;
  readonly preheating: boolean | undefined;
  readonly probe: boolean | undefined;
  readonly overall: boolean | undefined;
}

/** `CMD 3` — maintenance (§ 5.4). */
export interface UnitMaintenance {
  readonly command: 3;
  /** Never changes: a frame with another machine ID was badly reassembled. */
  readonly machineId: EnOceanId | undefined;
  readonly selfTest: SelfTest;
  readonly errorCode1Raw: number | undefined;
  readonly errorCode2Raw: number | undefined;
  /** Active errors (codes `00` and `FF` mean none). */
  readonly errors: readonly UnitError[];
  readonly weeksSinceMaintenance: number | undefined;
  /** Unit unknown; absent on firmware 3.7. */
  readonly consumptionRaw: number | undefined;
}

/** `CMD 4` — configuration (§ 5.5). */
export interface UnitConfiguration {
  readonly command: 4;
  readonly unitType: UnitType | undefined;
  readonly unitTypeRaw: number | undefined;
  readonly upstreamBypassPresent: boolean | undefined;
  readonly solarRPresent: boolean | undefined;
  readonly hydroRPresent: boolean | undefined;
  /** m³, read-only. */
  readonly ventilatedVolume: number | undefined;
  /** Full year (raw + 2000). */
  readonly installationYear: number | undefined;
  readonly installationMonth: number | undefined;
  readonly installationDay: number | undefined;
  /** `major.minor` from the two nibbles, e.g. `3.7`. */
  readonly firmwareVersion: string | undefined;
  readonly firmwareVersionRaw: number | undefined;
  /** Same encoding; absent on firmware 3.7. */
  readonly hardwareVersion: string | undefined;
  readonly hardwareVersionRaw: number | undefined;
}

/** One internal probe slot of `CMD 5` / `CMD 6`. */
export interface ProbeSlot {
  /** Slot number: 0–2 in `CMD 5`, 3–4 in `CMD 6`. */
  readonly slot: number;
  readonly positionRaw: number;
  /** `null` = no probe in this slot (raw `255`); `undefined` = unknown raw value. */
  readonly position: ProbePosition | null | undefined;
  /** °C, signed; `undefined` when absent or when the slot has no probe. */
  readonly temperature: number | undefined;
  /** %; can exceed 100. `undefined` when absent or when the slot has no probe. */
  readonly humidity: number | undefined;
}

/** `CMD 5` / `CMD 6` — internal probes (§ 5.6). */
export interface UnitProbes {
  readonly command: 5 | 6;
  /** Slots present in the frame (a slot cut before its position byte is left out). */
  readonly probes: readonly ProbeSlot[];
}

/** One bypass slot of `CMD 7`. */
export interface BypassSlot {
  /** 1–3. */
  readonly slot: number;
  readonly openingRaw: number | undefined;
  /** %; `null` = not applicable (raw `255`). An unused slot reports `0`, not `255`. */
  readonly opening: number | null | undefined;
  readonly positionRaw: number | undefined;
  /** `null` = unknown (raw `255`, also reported by unused slots). */
  readonly position: BypassPosition | null | undefined;
}

/** `CMD 7` — options (§ 5.7). */
export interface UnitOptions {
  readonly command: 7;
  /** Slots present in the frame (bypass 1, 2, 3). */
  readonly bypasses: readonly BypassSlot[];
  /** %. */
  readonly hydroRValveOpening: number | undefined;
}

/** `CMD 8` — one paired sensor (§ 5.8). */
export interface UnitPairedSensor {
  readonly command: 8;
  readonly sensorId: EnOceanId | undefined;
  readonly room: Room | undefined;
  readonly roomRaw: number | undefined;
  readonly profile: SensorProfile | undefined;
  readonly profileRaw: number | undefined;
  readonly sensorIndex: number | undefined;
}

/** Commands 9–15: unknown content, kept raw. */
export interface UnitUnknownFrame {
  readonly command: 9 | 10 | 11 | 12 | 13 | 14 | 15;
  /** Payload bytes after the 2-byte MSC header. */
  readonly data: Uint8Array;
}

/** A decoded unit status frame, discriminated by `command`. */
export type UnitStatusFrame =
  | UnitCurrentData
  | UnitComplement1
  | UnitComplement2
  | UnitMaintenance
  | UnitConfiguration
  | UnitProbes
  | UnitOptions
  | UnitPairedSensor
  | UnitUnknownFrame;

function lookup<T>(
  table: readonly T[] | Readonly<Record<number, T>>,
  raw: number | undefined,
): T | undefined {
  if (raw === undefined) return undefined;
  return (table as Readonly<Record<number, T | undefined>>)[raw];
}

function sentinel(raw: number | undefined, disabled: readonly number[]): number | null | undefined {
  if (raw === undefined) return undefined;
  return disabled.includes(raw) ? null : raw;
}

function version(raw: number | undefined): string | undefined {
  return raw === undefined ? undefined : `${raw >> 4}.${raw & 0x0f}`;
}

function decodeCurrentData(p: Uint8Array): UnitCurrentData {
  const modeRaw = readBits(p, 16, 8);
  const functionByte = readBits(p, 24, 8);
  const boostRaw = readBits(p, 32, 8);
  const preheatSetpointRaw = readBits(p, 40, 8);
  const hydroRSetpointRaw = readBits(p, 56, 8);
  const solarRSetpointRaw = readBits(p, 64, 8);
  const seasonRaw = readBits(p, 80, 8);
  return {
    command: 0,
    mode: lookup(UNIT_MODES, modeRaw),
    modeRaw,
    functionByte,
    functions: functionByte === undefined ? undefined : decodeFunctionByte(functionByte),
    boostRaw,
    boostActive: boostRaw === undefined ? undefined : boostRaw !== 0,
    boostMinutesLeft:
      boostRaw !== undefined && boostRaw >= 2 && boostRaw <= 200 ? boostRaw : undefined,
    preheatSetpointRaw,
    preheatSetpoint: sentinel(preheatSetpointRaw, [PREHEAT_DISABLED]),
    maxSupplyTemperature: readBits(p, 48, 8),
    hydroRSetpointRaw,
    hydroRSetpoint: sentinel(hydroRSetpointRaw, [HYDROR_DISABLED, 0]),
    solarRSetpointRaw,
    solarRSetpoint: sentinel(solarRSetpointRaw, [SOLARR_DISABLED]),
    firmwareUpdate: readFlag(p, 76),
    pairingMode: readFlag(p, 77),
    test: readFlag(p, 78),
    localisationRaw: readBits(p, 79, 1),
    season: lookup(SEASONS, seasonRaw),
    seasonRaw,
    eventTypeRaw: readBits(p, 88, 8),
  };
}

function decodeComplement1(p: Uint8Array): UnitComplement1 {
  const systemStateRaw = readBits(p, 40, 8);
  return {
    command: 1,
    airflow: readBits(p, 16, 16),
    preheatPower: readBits(p, 32, 8),
    systemState: lookup(SYSTEM_STATES, systemStateRaw),
    systemStateRaw,
    motorSpeed: readBits(p, 48, 8),
  };
}

function decodeComplement2(p: Uint8Array): UnitComplement2 {
  return {
    command: 2,
    outdoorTemperature: readSigned(p, 16, 8),
    pressureSetpointRaw: readBits(p, 24, 16),
    filterClogging: readBits(p, 40, 8),
    waterLoopDutyCycle: readBits(p, 48, 8),
    operatingTimeDays: readBits(p, 56, 16),
  };
}

function decodeMaintenance(p: Uint8Array): UnitMaintenance {
  const machineId = readBits(p, 16, 32);
  const errorCode1Raw = readBits(p, 56, 8);
  const errorCode2Raw = readBits(p, 64, 8);
  const errors: UnitError[] = [];
  for (const code of [errorCode1Raw, errorCode2Raw]) {
    if (code === undefined) continue;
    const label = errorLabel(code);
    if (label !== undefined) errors.push({ code, label });
  }
  return {
    command: 3,
    machineId: machineId === undefined ? undefined : numberToId(machineId),
    selfTest: {
      airQuality: readFlag(p, 51),
      motor: readFlag(p, 52),
      preheating: readFlag(p, 53),
      probe: readFlag(p, 54),
      overall: readFlag(p, 55),
    },
    errorCode1Raw,
    errorCode2Raw,
    errors,
    weeksSinceMaintenance: readBits(p, 72, 8),
    consumptionRaw: readBits(p, 80, 8),
  };
}

function decodeConfiguration(p: Uint8Array): UnitConfiguration {
  const unitTypeRaw = readBits(p, 16, 8);
  const year = readBits(p, 48, 8);
  const firmwareVersionRaw = readBits(p, 72, 8);
  const hardwareVersionRaw = readBits(p, 80, 8);
  return {
    command: 4,
    unitType: lookup(UNIT_TYPES, unitTypeRaw),
    unitTypeRaw,
    upstreamBypassPresent: readFlag(p, 29),
    solarRPresent: readFlag(p, 30),
    hydroRPresent: readFlag(p, 31),
    ventilatedVolume: readBits(p, 32, 16),
    installationYear: year === undefined ? undefined : 2000 + year,
    installationMonth: readBits(p, 56, 8),
    installationDay: readBits(p, 64, 8),
    firmwareVersion: version(firmwareVersionRaw),
    firmwareVersionRaw,
    hardwareVersion: version(hardwareVersionRaw),
    hardwareVersionRaw,
  };
}

const NO_PROBE = 255;

function decodeProbes(p: Uint8Array, command: 5 | 6): UnitProbes {
  const firstSlot = command === 5 ? 0 : 3;
  const count = command === 5 ? 3 : 2;
  const probes: ProbeSlot[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = 16 + 24 * i;
    const positionRaw = readBits(p, base, 8);
    if (positionRaw === undefined) break;
    const present = positionRaw !== NO_PROBE;
    probes.push({
      slot: firstSlot + i,
      positionRaw,
      position: present ? lookup(PROBE_POSITIONS, positionRaw) : null,
      temperature: present ? readSigned(p, base + 8, 8) : undefined,
      humidity: present ? readBits(p, base + 16, 8) : undefined,
    });
  }
  return { command, probes };
}

function decodeOptions(p: Uint8Array): UnitOptions {
  const bypasses: BypassSlot[] = [];
  for (let i = 0; i < 3; i += 1) {
    const base = 16 + 16 * i;
    const openingRaw = readBits(p, base, 8);
    const positionRaw = readBits(p, base + 8, 8);
    if (openingRaw === undefined) break;
    bypasses.push({
      slot: i + 1,
      openingRaw,
      opening: sentinel(openingRaw, [255]),
      positionRaw,
      position:
        positionRaw === undefined
          ? undefined
          : positionRaw === 255
            ? null
            : lookup(BYPASS_POSITIONS, positionRaw),
    });
  }
  return { command: 7, bypasses, hydroRValveOpening: readBits(p, 64, 8) };
}

function decodePairedSensor(p: Uint8Array): UnitPairedSensor {
  const sensorId = readBits(p, 16, 32);
  const roomRaw = readBits(p, 48, 8);
  const profileRaw = readBits(p, 56, 8);
  return {
    command: 8,
    sensorId: sensorId === undefined ? undefined : numberToId(sensorId),
    room: lookup(ROOMS, roomRaw),
    roomRaw,
    profile: lookup(SENSOR_PROFILES, profileRaw),
    profileRaw,
    sensorIndex: readBits(p, 64, 8),
  };
}

/**
 * Decodes a unit status MSC payload (starting with `07 9x`). Returns `undefined` when the
 * payload is too short to hold the MSC header. Does not check the manufacturer nor who sent
 * the frame: use {@link classifyTelegram} to tell status frames from unit → Assistant frames.
 */
export function decodeUnitStatus(payload: Uint8Array): UnitStatusFrame | undefined {
  const header = parseMscHeader(payload);
  if (header === undefined) return undefined;
  switch (header.command) {
    case 0:
      return decodeCurrentData(payload);
    case 1:
      return decodeComplement1(payload);
    case 2:
      return decodeComplement2(payload);
    case 3:
      return decodeMaintenance(payload);
    case 4:
      return decodeConfiguration(payload);
    case 5:
      return decodeProbes(payload, 5);
    case 6:
      return decodeProbes(payload, 6);
    case 7:
      return decodeOptions(payload);
    case 8:
      return decodePairedSensor(payload);
    default:
      return { command: header.command as UnitUnknownFrame['command'], data: payload.slice(2) };
  }
}
