/**
 * JSON state of the ventilation unit (mqtt-interface.md § 3), built from decoded status frames.
 *
 * Only known values are published; a value missing from a frame keeps its last known value;
 * `null` means unknown or disabled (raw value outside the known table, disabled setpoint, not
 * applicable bypass opening…).
 */
import type { EnOceanId } from '../hex.ts';
import type {
  ProbePosition,
  UnitComplement1,
  UnitComplement2,
  UnitConfiguration,
  UnitCurrentData,
  UnitMaintenance,
  UnitOptions,
  UnitPairedSensor,
  UnitProbes,
  UnitStatusFrame,
  UnitType,
} from '../msc/unit.ts';
import type { UnitCard } from './discovery.ts';
import type { Feature } from './entities.ts';

/** A JSON value. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
/** A JSON object. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/** One entry of the `paired_sensors` list (§ 5.8). */
export interface PairedSensorEntry extends JsonObject {
  id: string | null;
  room: string | number | null;
  profile: string | number | null;
  index: number | null;
}

/** Optimistic changes applied after a confirmed order (§ 6). */
export interface OptimisticChange {
  readonly mode?: string;
  readonly boost?: boolean;
  readonly boostEndsAt?: string | null;
  readonly holiday?: boolean;
  readonly holidayEndsAt?: string | null;
  readonly fixedAirflow?: boolean;
  readonly overVentilation?: boolean;
  readonly timeSchedule?: boolean;
  readonly bypassSource?: string;
  readonly preheatSetpoint?: number | null;
  readonly maxSupplyTemperature?: number;
  readonly hydroRSetpoint?: number | null;
  readonly solarRSetpoint?: number | null;
}

/** Filter life estimate (§ 3): max(0, 365 − 7 × weeks − 3) days. */
export function filterDaysLeft(weeksSinceMaintenance: number): number {
  return Math.max(0, 365 - 7 * weeksSinceMaintenance - 3);
}

/** Error code as two upper-case hexadecimal digits. */
export function errorCodeText(code: number): string {
  return code.toString(16).toUpperCase().padStart(2, '0');
}

const PROBE_FEATURES: Partial<Record<ProbePosition, Feature>> = {
  water_loop: 'probe_water_loop',
  solar: 'probe_solar',
  bypass: 'probe_bypass',
};

function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Accumulates the unit's status frames into its JSON state. */
export class UnitModel {
  readonly #values = new Map<string, JsonValue>();
  readonly #seenCommands = new Set<number>();
  readonly #probeFeatures = new Map<5 | 6, Set<Feature>>();
  #configFeatures = new Set<Feature>();
  #bypassFeatures = new Set<Feature>();
  #functionByte: number | undefined;
  #unitType: UnitType | undefined;
  #firmwareVersion: string | undefined;
  #hardwareVersion: string | undefined;
  #machineId: EnOceanId | undefined;
  #pairedSensors: PairedSensorEntry[] = [];
  #lastCommand: number | undefined;

  /** Last function byte received (`CMD 0`, offset 24), needed by function-byte orders. */
  get functionByte(): number | undefined {
    return this.#functionByte;
  }

  /** True once `CMD 4`, `5`, `6` and `7` have each been received: the entity set is known. */
  get compositionKnown(): boolean {
    return [4, 5, 6, 7].every((command) => this.#seenCommands.has(command));
  }

  /** Optional equipment currently reported. */
  get features(): ReadonlySet<Feature> {
    const features = new Set<Feature>([...this.#configFeatures, ...this.#bypassFeatures]);
    for (const set of this.#probeFeatures.values()) for (const f of set) features.add(f);
    return features;
  }

  /** Device card facts. */
  get card(): UnitCard {
    return {
      unitType: this.#unitType,
      firmwareVersion: this.#firmwareVersion,
      hardwareVersion: this.#hardwareVersion,
      machineId: this.#machineId,
    };
  }

  /** Paired sensors of the last `CMD 8` series. */
  get pairedSensors(): readonly PairedSensorEntry[] {
    return this.#pairedSensors;
  }

  /** The JSON state, keys sorted. */
  state(): JsonObject {
    const state: JsonObject = {};
    for (const key of [...this.#values.keys()].sort()) state[key] = this.#values.get(key) ?? null;
    return state;
  }

  /** Reads one value (`undefined` when not known yet). */
  get(key: string): JsonValue | undefined {
    return this.#values.get(key);
  }

  /** Sets a value kept by the app (`boost_duration`, `holiday_duration`, `…_ends_at`). */
  set(key: string, value: JsonValue): void {
    this.#values.set(key, value);
  }

  #set(key: string, value: JsonValue | undefined): void {
    if (value !== undefined) this.#values.set(key, value);
  }

  /** Enumeration: `null` when the raw value is outside the table, kept when absent. */
  #setEnum(key: string, value: string | undefined, raw: number | undefined): void {
    if (raw !== undefined) this.#values.set(key, value ?? null);
  }

  /**
   * Applies a decoded status frame received at `at` (ms since the epoch) with level `dbm`.
   * The caller checks the machine ID of `CMD 3` frames before.
   */
  apply(frame: UnitStatusFrame, at: number, dbm: number | undefined): void {
    this.#set('last_seen', new Date(at).toISOString());
    this.#set('signal_strength', dbm);
    const previousCommand = this.#lastCommand;
    this.#lastCommand = frame.command;
    this.#seenCommands.add(frame.command);
    switch (frame.command) {
      case 0:
        this.#applyCurrentData(frame, at);
        return;
      case 1:
        this.#applyComplement1(frame);
        return;
      case 2:
        this.#applyComplement2(frame);
        return;
      case 3:
        this.#applyMaintenance(frame);
        return;
      case 4:
        this.#applyConfiguration(frame);
        return;
      case 5:
      case 6:
        this.#applyProbes(frame);
        return;
      case 7:
        this.#applyOptions(frame);
        return;
      case 8:
        this.#applyPairedSensor(frame, previousCommand !== 8);
        return;
      default:
        return;
    }
  }

  #applyCurrentData(f: UnitCurrentData, at: number): void {
    this.#setEnum('mode', f.mode, f.modeRaw);
    if (f.functionByte !== undefined) this.#functionByte = f.functionByte;
    if (f.functions !== undefined) {
      this.#set('bypass_source', f.functions.bypassSource);
      this.#set('time_schedule', f.functions.timeSchedule);
      this.#set('fixed_airflow', f.functions.fixedAirflow);
      this.#set('over_ventilation', f.functions.overVentilation);
      this.#set('holiday', f.functions.holiday);
      if (!f.functions.holiday) this.#set('holiday_ends_at', null);
    }
    this.#set('boost', f.boostActive);
    if (f.boostActive === false) this.#set('boost_ends_at', null);
    if (f.boostMinutesLeft !== undefined) {
      this.#set('boost_ends_at', new Date(at + f.boostMinutesLeft * 60_000).toISOString());
    }
    this.#set('preheat_setpoint', f.preheatSetpoint);
    this.#set('max_supply_temperature', f.maxSupplyTemperature);
    this.#set('hydror_setpoint', f.hydroRSetpoint);
    this.#set('solarr_setpoint', f.solarRSetpoint);
    this.#set('firmware_update', f.firmwareUpdate);
    this.#set('pairing_mode', f.pairingMode);
    this.#setEnum('season', f.season, f.seasonRaw);
  }

  #applyComplement1(f: UnitComplement1): void {
    this.#set('airflow', f.airflow);
    this.#set('preheat_power', f.preheatPower);
    this.#setEnum('system_state', f.systemState, f.systemStateRaw);
    this.#set('motor_speed', f.motorSpeed);
  }

  #applyComplement2(f: UnitComplement2): void {
    this.#set('outdoor_temperature', f.outdoorTemperature);
    if (f.pressureSetpointRaw !== undefined) {
      this.#set('pressure_setpoint', f.pressureSetpointRaw / 10);
    }
    this.#set('filter_clogging', f.filterClogging);
    this.#set('water_loop_duty_cycle', f.waterLoopDutyCycle);
    this.#set('operating_time', f.operatingTimeDays);
  }

  #applyMaintenance(f: UnitMaintenance): void {
    if (f.machineId !== undefined) {
      this.#machineId ??= f.machineId;
      this.#set('machine_id', this.#machineId);
    }
    if (f.errorCode1Raw !== undefined || f.errorCode2Raw !== undefined) {
      this.#set('problem', f.errors.length > 0);
      this.#set(
        'error_codes',
        f.errors.map((error) => errorCodeText(error.code)),
      );
      this.#set(
        'error_labels',
        f.errors.map((error) => error.label),
      );
    }
    const tests: [string, boolean | undefined][] = [
      ['air_quality', f.selfTest.airQuality],
      ['motor', f.selfTest.motor],
      ['preheating', f.selfTest.preheating],
      ['probe', f.selfTest.probe],
      ['overall', f.selfTest.overall],
    ];
    const known = tests.filter((entry): entry is [string, boolean] => entry[1] !== undefined);
    if (known.length > 0) {
      const results: JsonObject = {};
      for (const [name, ok] of known) results[name] = ok ? 'ok' : 'failed';
      this.#set(
        'self_test',
        known.some(([, ok]) => !ok),
      );
      this.#set('self_test_results', results);
    }
    if (f.weeksSinceMaintenance !== undefined) {
      this.#set('weeks_since_maintenance', f.weeksSinceMaintenance);
      this.#set('filter_days_left', filterDaysLeft(f.weeksSinceMaintenance));
    }
  }

  #applyConfiguration(f: UnitConfiguration): void {
    this.#setEnum('unit_type', f.unitType, f.unitTypeRaw);
    if (f.unitTypeRaw !== undefined) this.#unitType = f.unitType;
    this.#set('upstream_bypass_present', f.upstreamBypassPresent);
    this.#set('solarr_present', f.solarRPresent);
    this.#set('hydror_present', f.hydroRPresent);
    if (f.hydroRPresent !== undefined || f.solarRPresent !== undefined) {
      const features = new Set<Feature>();
      if (f.hydroRPresent === true) features.add('hydror');
      if (f.solarRPresent === true) features.add('solarr');
      this.#configFeatures = features;
    }
    this.#set('ventilated_volume', f.ventilatedVolume);
    const { installationYear: y, installationMonth: m, installationDay: d } = f;
    if (y !== undefined && m !== undefined && d !== undefined) {
      this.#set(
        'installation_date',
        isValidDate(y, m, d)
          ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
          : null,
      );
    }
    if (f.firmwareVersion !== undefined) {
      this.#firmwareVersion = f.firmwareVersion;
      this.#set('firmware_version', f.firmwareVersion);
    }
    if (f.hardwareVersion !== undefined) {
      this.#hardwareVersion = f.hardwareVersion;
      this.#set('hardware_version', f.hardwareVersion);
    }
  }

  #applyProbes(f: UnitProbes): void {
    const features = new Set<Feature>();
    for (const probe of f.probes) {
      if (probe.position === null || probe.position === undefined) continue;
      this.#set(`${probe.position}_temperature`, probe.temperature);
      this.#set(`${probe.position}_humidity`, probe.humidity);
      const feature = PROBE_FEATURES[probe.position];
      if (feature !== undefined) features.add(feature);
    }
    this.#probeFeatures.set(f.command, features);
  }

  #applyOptions(f: UnitOptions): void {
    const features = new Set<Feature>();
    for (const slot of f.bypasses) {
      const prefix = slot.slot === 1 ? 'bypass' : `bypass_${slot.slot}`;
      this.#set(`${prefix}_opening`, slot.opening);
      if (slot.positionRaw !== undefined) this.#set(`${prefix}_position`, slot.position ?? null);
      // Unused slots report opening 0 and position 255 (protocol.md § 5.7).
      const used =
        (slot.positionRaw !== undefined && slot.positionRaw !== 255) ||
        (slot.openingRaw !== undefined && slot.openingRaw !== 0 && slot.openingRaw !== 255);
      if (used && slot.slot === 2) features.add('bypass_2');
      if (used && slot.slot === 3) features.add('bypass_3');
    }
    this.#bypassFeatures = features;
    this.#set('hydror_valve_opening', f.hydroRValveOpening);
  }

  #applyPairedSensor(f: UnitPairedSensor, newSeries: boolean): void {
    // The unit sends one CMD 8 per sensor in a row: a CMD 8 after another command starts a new
    // list, so that sensors removed from the unit disappear.
    const entry: PairedSensorEntry = {
      id: f.sensorId ?? null,
      room: f.room ?? f.roomRaw ?? null,
      profile: f.profile ?? f.profileRaw ?? null,
      index: f.sensorIndex ?? null,
    };
    const list = newSeries ? [] : this.#pairedSensors.filter((s) => s.id !== entry.id);
    list.push(entry);
    this.#pairedSensors = list;
    this.#set('paired_sensors', list);
  }

  /** The Assistant listed among the paired sensors (profile `assistant`), if any. */
  pairedAssistantId(): EnOceanId | undefined {
    const found = this.#pairedSensors.find((s) => s.profile === 'assistant' && s.id !== null);
    return found?.id ?? undefined;
  }

  /** Applies the expected effect of a confirmed order until the next status frame. */
  applyOptimistic(change: OptimisticChange): void {
    const entries: [string, JsonValue | undefined][] = [
      ['mode', change.mode],
      ['boost', change.boost],
      ['boost_ends_at', change.boostEndsAt],
      ['holiday', change.holiday],
      ['holiday_ends_at', change.holidayEndsAt],
      ['fixed_airflow', change.fixedAirflow],
      ['over_ventilation', change.overVentilation],
      ['time_schedule', change.timeSchedule],
      ['bypass_source', change.bypassSource],
      ['preheat_setpoint', change.preheatSetpoint],
      ['max_supply_temperature', change.maxSupplyTemperature],
      ['hydror_setpoint', change.hydroRSetpoint],
      ['solarr_setpoint', change.solarRSetpoint],
    ];
    for (const [key, value] of entries) this.#set(key, value);
  }
}
