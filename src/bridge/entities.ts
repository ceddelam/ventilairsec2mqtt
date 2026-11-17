/**
 * Entity catalog of the three devices (mqtt-interface.md § 3–5): platform, category, class,
 * unit, options and which JSON state keys feed the state and the attributes.
 */
import type { EntityKey } from './i18n.ts';

/** Home Assistant MQTT platforms used. */
export type Platform = 'sensor' | 'binary_sensor' | 'switch' | 'select' | 'number' | 'button';

/**
 * How the value template reads the JSON state:
 * - `value`: the key as is;
 * - `flag`: a boolean as `ON` / `OFF`;
 * - `setpoint`: `null` (disabled) as `off`, otherwise the number;
 * - `count`: the length of a list.
 */
export type ValueKind = 'value' | 'flag' | 'setpoint' | 'count';

/** Optional equipment that brings its own entities. */
export type Feature =
  | 'hydror'
  | 'solarr'
  | 'probe_water_loop'
  | 'probe_solar'
  | 'probe_bypass'
  | 'bypass_2'
  | 'bypass_3';

/** One entity. */
export interface EntityDef {
  readonly key: EntityKey;
  readonly platform: Platform;
  readonly category?: 'diagnostic' | 'config';
  readonly deviceClass?: string;
  readonly unit?: string;
  readonly stateClass?: 'measurement' | 'total_increasing';
  readonly precision?: number;
  /** Enum sensor or select options. */
  readonly options?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly icon?: string;
  /** Default `value`; ignored for buttons. */
  readonly value?: ValueKind;
  /** JSON state key read for the state, when it differs from `key`. */
  readonly source?: string;
  /** Attributes: attribute name → JSON state key. */
  readonly attributes?: Readonly<Record<string, string>>;
  /** Attributes taken as a whole from a JSON object in the state. */
  readonly attributesFrom?: string;
  /** Only exists when the unit reports this equipment. */
  readonly requires?: Feature;
}

const range = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

const temperature = { deviceClass: 'temperature', unit: '°C', stateClass: 'measurement' } as const;
const humidity = { deviceClass: 'humidity', unit: '%', stateClass: 'measurement' } as const;
const percent = { unit: '%', stateClass: 'measurement' } as const;

/** Ventilation unit entities (§ 3). */
export const UNIT_ENTITIES: readonly EntityDef[] = [
  // Controls
  {
    key: 'mode',
    platform: 'select',
    options: ['standby', 'eco', 'standard', 'comfort'],
    icon: 'mdi:fan',
  },
  {
    key: 'boost',
    platform: 'switch',
    value: 'flag',
    icon: 'mdi:fan-plus',
    attributes: { ends_at: 'boost_ends_at' },
  },
  {
    key: 'boost_duration',
    platform: 'number',
    category: 'config',
    min: 5,
    max: 200,
    step: 5,
    unit: 'min',
    icon: 'mdi:timer-outline',
  },
  {
    key: 'holiday',
    platform: 'switch',
    value: 'flag',
    icon: 'mdi:bag-suitcase',
    attributes: { ends_at: 'holiday_ends_at' },
  },
  {
    key: 'holiday_duration',
    platform: 'number',
    category: 'config',
    min: 1,
    max: 254,
    step: 1,
    unit: 'd',
    icon: 'mdi:calendar-range',
  },
  { key: 'fixed_airflow', platform: 'switch', value: 'flag', icon: 'mdi:fan-lock' },
  { key: 'over_ventilation', platform: 'switch', value: 'flag', icon: 'mdi:fan-chevron-up' },
  {
    key: 'time_schedule',
    platform: 'switch',
    category: 'config',
    value: 'flag',
    icon: 'mdi:calendar-clock',
  },
  {
    key: 'bypass_source',
    platform: 'select',
    category: 'config',
    options: ['roof', 'other'],
    icon: 'mdi:valve',
  },
  {
    key: 'preheat_setpoint',
    platform: 'select',
    category: 'config',
    value: 'setpoint',
    options: ['off', ...range(12, 18)],
    icon: 'mdi:thermometer',
  },
  {
    key: 'max_supply_temperature',
    platform: 'number',
    category: 'config',
    deviceClass: 'temperature',
    unit: '°C',
    min: 20,
    max: 45,
    step: 1,
  },
  {
    key: 'hydror_setpoint',
    platform: 'select',
    category: 'config',
    value: 'setpoint',
    options: ['off', ...range(8, 28)],
    icon: 'mdi:thermometer-water',
    requires: 'hydror',
  },
  {
    key: 'solarr_setpoint',
    platform: 'select',
    category: 'config',
    value: 'setpoint',
    options: ['off', ...range(18, 30)],
    icon: 'mdi:solar-power',
    requires: 'solarr',
  },
  { key: 'refresh', platform: 'button', category: 'diagnostic', icon: 'mdi:refresh' },
  { key: 'filter_reset', platform: 'button', category: 'config', icon: 'mdi:air-filter' },
  { key: 'sync_clock', platform: 'button', category: 'diagnostic', icon: 'mdi:clock-check' },
  // Measurements and states
  {
    key: 'system_state',
    platform: 'sensor',
    deviceClass: 'enum',
    options: ['boost', 'holiday', 'standby', 'fixed_airflow', 'normal'],
    icon: 'mdi:state-machine',
  },
  {
    key: 'airflow',
    platform: 'sensor',
    deviceClass: 'volume_flow_rate',
    unit: 'm³/h',
    stateClass: 'measurement',
  },
  { key: 'motor_speed', platform: 'sensor', stateClass: 'measurement', icon: 'mdi:fan' },
  { key: 'preheat_power', platform: 'sensor', deviceClass: 'power_factor', ...percent },
  { key: 'outdoor_temperature', platform: 'sensor', ...temperature },
  { key: 'supply_temperature', platform: 'sensor', ...temperature },
  { key: 'supply_humidity', platform: 'sensor', ...humidity },
  { key: 'intake_temperature', platform: 'sensor', ...temperature },
  { key: 'intake_humidity', platform: 'sensor', ...humidity },
  {
    key: 'water_loop_temperature',
    platform: 'sensor',
    ...temperature,
    requires: 'probe_water_loop',
  },
  { key: 'water_loop_humidity', platform: 'sensor', ...humidity, requires: 'probe_water_loop' },
  { key: 'solar_temperature', platform: 'sensor', ...temperature, requires: 'probe_solar' },
  { key: 'solar_humidity', platform: 'sensor', ...humidity, requires: 'probe_solar' },
  { key: 'bypass_temperature', platform: 'sensor', ...temperature, requires: 'probe_bypass' },
  { key: 'bypass_humidity', platform: 'sensor', ...humidity, requires: 'probe_bypass' },
  {
    key: 'season',
    platform: 'sensor',
    deviceClass: 'enum',
    options: ['summer', 'winter', 'mid_season'],
    icon: 'mdi:weather-partly-snowy',
  },
  { key: 'filter_clogging', platform: 'sensor', ...percent, icon: 'mdi:air-filter' },
  {
    key: 'filter_days_left',
    platform: 'sensor',
    deviceClass: 'duration',
    unit: 'd',
    stateClass: 'measurement',
    icon: 'mdi:air-filter',
  },
  {
    key: 'pressure_setpoint',
    platform: 'sensor',
    category: 'diagnostic',
    deviceClass: 'pressure',
    unit: 'Pa',
    stateClass: 'measurement',
    precision: 1,
  },
  {
    key: 'ventilated_volume',
    platform: 'sensor',
    category: 'diagnostic',
    deviceClass: 'volume',
    unit: 'm³',
  },
  {
    key: 'bypass_opening',
    platform: 'sensor',
    category: 'diagnostic',
    ...percent,
    icon: 'mdi:valve',
    attributes: { position: 'bypass_position' },
  },
  {
    key: 'bypass_2_opening',
    platform: 'sensor',
    category: 'diagnostic',
    ...percent,
    icon: 'mdi:valve',
    attributes: { position: 'bypass_2_position' },
    requires: 'bypass_2',
  },
  {
    key: 'bypass_3_opening',
    platform: 'sensor',
    category: 'diagnostic',
    ...percent,
    icon: 'mdi:valve',
    attributes: { position: 'bypass_3_position' },
    requires: 'bypass_3',
  },
  {
    key: 'hydror_valve_opening',
    platform: 'sensor',
    category: 'diagnostic',
    ...percent,
    icon: 'mdi:valve',
    requires: 'hydror',
  },
  {
    key: 'water_loop_duty_cycle',
    platform: 'sensor',
    category: 'diagnostic',
    ...percent,
    requires: 'hydror',
  },
  {
    key: 'operating_time',
    platform: 'sensor',
    category: 'diagnostic',
    deviceClass: 'duration',
    unit: 'd',
    stateClass: 'total_increasing',
  },
  {
    key: 'weeks_since_maintenance',
    platform: 'sensor',
    category: 'diagnostic',
    unit: 'wk',
    icon: 'mdi:wrench-clock',
  },
  { key: 'installation_date', platform: 'sensor', category: 'diagnostic', deviceClass: 'date' },
  {
    key: 'problem',
    platform: 'binary_sensor',
    deviceClass: 'problem',
    value: 'flag',
    attributes: { codes: 'error_codes', labels: 'error_labels' },
  },
  {
    key: 'self_test',
    platform: 'binary_sensor',
    category: 'diagnostic',
    deviceClass: 'problem',
    value: 'flag',
    attributesFrom: 'self_test_results',
  },
  {
    key: 'firmware_update',
    platform: 'binary_sensor',
    category: 'diagnostic',
    value: 'flag',
    icon: 'mdi:update',
  },
  {
    key: 'pairing_mode',
    platform: 'binary_sensor',
    category: 'diagnostic',
    value: 'flag',
    icon: 'mdi:link-variant',
  },
  {
    key: 'paired_sensors',
    platform: 'sensor',
    category: 'diagnostic',
    value: 'count',
    icon: 'mdi:access-point-network',
    attributes: { sensors: 'paired_sensors' },
  },
  {
    key: 'signal_strength',
    platform: 'sensor',
    category: 'diagnostic',
    deviceClass: 'signal_strength',
    unit: 'dBm',
    stateClass: 'measurement',
  },
  { key: 'last_seen', platform: 'sensor', category: 'diagnostic', deviceClass: 'timestamp' },
];

/** Assistant entities (§ 4). */
export const ASSISTANT_ENTITIES: readonly EntityDef[] = [
  { key: 'temperature', platform: 'sensor', ...temperature, precision: 1 },
  { key: 'humidity', platform: 'sensor', ...humidity },
  {
    key: 'battery',
    platform: 'sensor',
    category: 'diagnostic',
    deviceClass: 'battery',
    unit: '%',
    stateClass: 'measurement',
    attributes: { raw: 'battery_raw' },
  },
  {
    key: 'signal_strength',
    platform: 'sensor',
    category: 'diagnostic',
    deviceClass: 'signal_strength',
    unit: 'dBm',
    stateClass: 'measurement',
  },
  { key: 'last_seen', platform: 'sensor', category: 'diagnostic', deviceClass: 'timestamp' },
];

/** Bridge entities (§ 5). */
export const BRIDGE_ENTITIES: readonly EntityDef[] = [
  {
    key: 'connection',
    platform: 'binary_sensor',
    category: 'diagnostic',
    deviceClass: 'connectivity',
    value: 'flag',
  },
  {
    key: 'stick_problem',
    platform: 'binary_sensor',
    deviceClass: 'problem',
    value: 'flag',
    attributes: { reason: 'stick_problem_reason' },
  },
  {
    key: 'active_port',
    platform: 'sensor',
    category: 'diagnostic',
    deviceClass: 'enum',
    options: ['primary', 'fallback'],
    icon: 'mdi:usb-port',
  },
  { key: 'sender_id', platform: 'sensor', category: 'diagnostic', icon: 'mdi:identifier' },
];

/** True for platforms that receive orders. */
export function hasCommand(platform: Platform): boolean {
  return (
    platform === 'switch' || platform === 'select' || platform === 'number' || platform === 'button'
  );
}
