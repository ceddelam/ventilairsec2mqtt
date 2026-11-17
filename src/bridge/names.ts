/** Entity names shown in Home Assistant. */

const NAMES = {
  // Ventilation unit: controls
  mode: 'Mode',
  boost: 'Boost',
  boost_duration: 'Boost duration',
  holiday: 'Holiday',
  holiday_duration: 'Holiday duration',
  fixed_airflow: 'Fixed airflow',
  over_ventilation: 'Over-ventilation',
  time_schedule: 'Time schedule',
  bypass_source: 'Bypass source',
  preheat_setpoint: 'Preheating setpoint',
  max_supply_temperature: 'Maximum supply temperature',
  hydror_setpoint: "Hydro'R setpoint",
  solarr_setpoint: 'SolarR setpoint',
  refresh: 'Refresh',
  filter_reset: 'Filter reset',
  sync_clock: 'Sync clock',
  // Ventilation unit: measurements and states
  system_state: 'System state',
  airflow: 'Airflow',
  motor_speed: 'Motor speed',
  preheat_power: 'Preheating power',
  outdoor_temperature: 'Outdoor temperature',
  supply_temperature: 'Supply temperature',
  supply_humidity: 'Supply humidity',
  intake_temperature: 'Intake temperature',
  intake_humidity: 'Intake humidity',
  water_loop_temperature: 'Water loop temperature',
  water_loop_humidity: 'Water loop humidity',
  solar_temperature: 'Solar temperature',
  solar_humidity: 'Solar humidity',
  bypass_temperature: 'Bypass temperature',
  bypass_humidity: 'Bypass humidity',
  season: 'Season',
  filter_clogging: 'Filter clogging',
  filter_days_left: 'Filter days left',
  pressure_setpoint: 'Pressure setpoint',
  ventilated_volume: 'Ventilated volume',
  bypass_opening: 'Bypass opening',
  bypass_2_opening: 'Bypass 2 opening',
  bypass_3_opening: 'Bypass 3 opening',
  hydror_valve_opening: "Hydro'R valve opening",
  water_loop_duty_cycle: 'Water loop duty cycle',
  operating_time: 'Operating time',
  weeks_since_maintenance: 'Weeks since maintenance',
  installation_date: 'Installation date',
  problem: 'Problem',
  self_test: 'Self-test',
  firmware_update: 'Firmware update',
  pairing_mode: 'Pairing mode',
  paired_sensors: 'Paired sensors',
  signal_strength: 'Signal strength',
  last_seen: 'Last seen',
  // Assistant
  temperature: 'Temperature',
  humidity: 'Humidity',
  battery: 'Battery',
  // Bridge
  connection: 'Connection',
  stick_problem: 'Stick problem',
  active_port: 'Active port',
  sender_id: 'Sender ID',
} as const satisfies Readonly<Record<string, string>>;

/** Every entity key that has a name. */
export type EntityKey = keyof typeof NAMES;

/** Name of an entity. */
export function entityName(key: EntityKey): string {
  return NAMES[key];
}

/** All the keys of the name table (for tests). */
export function namedKeys(): EntityKey[] {
  return Object.keys(NAMES) as EntityKey[];
}
