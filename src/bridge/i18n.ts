/**
 * Entity names in English and French (`language` option). Keys, enum options and attributes
 * stay in English.
 */
import type { Language } from './config.ts';

type Names = Readonly<Record<Language, string>>;

const NAMES = {
  // Ventilation unit: controls
  mode: { en: 'Mode', fr: 'Mode' },
  boost: { en: 'Boost', fr: 'Boost' },
  boost_duration: { en: 'Boost duration', fr: 'Durée du boost' },
  holiday: { en: 'Holiday', fr: 'Vacances' },
  holiday_duration: { en: 'Holiday duration', fr: 'Durée des vacances' },
  fixed_airflow: { en: 'Fixed airflow', fr: 'Débit fixe' },
  over_ventilation: { en: 'Over-ventilation', fr: 'Surventilation' },
  time_schedule: { en: 'Time schedule', fr: 'Programmation horaire' },
  bypass_source: { en: 'Bypass source', fr: 'Source du bypass' },
  preheat_setpoint: { en: 'Preheating setpoint', fr: 'Consigne de préchauffage' },
  max_supply_temperature: {
    en: 'Maximum supply temperature',
    fr: 'Température de soufflage maximale',
  },
  hydror_setpoint: { en: "Hydro'R setpoint", fr: "Consigne Hydro'R" },
  solarr_setpoint: { en: 'SolarR setpoint', fr: 'Consigne SolarR' },
  refresh: { en: 'Refresh', fr: 'Actualiser' },
  filter_reset: { en: 'Filter reset', fr: 'Réinitialiser le filtre' },
  sync_clock: { en: 'Sync clock', fr: "Synchroniser l'horloge" },
  // Ventilation unit: measurements and states
  system_state: { en: 'System state', fr: 'État du système' },
  airflow: { en: 'Airflow', fr: "Débit d'air" },
  motor_speed: { en: 'Motor speed', fr: 'Vitesse du moteur' },
  preheat_power: { en: 'Preheating power', fr: 'Puissance de préchauffage' },
  outdoor_temperature: { en: 'Outdoor temperature', fr: 'Température extérieure' },
  supply_temperature: { en: 'Supply temperature', fr: 'Température de soufflage' },
  supply_humidity: { en: 'Supply humidity', fr: 'Humidité de soufflage' },
  intake_temperature: { en: 'Intake temperature', fr: "Température d'entrée d'air" },
  intake_humidity: { en: 'Intake humidity', fr: "Humidité d'entrée d'air" },
  water_loop_temperature: { en: 'Water loop temperature', fr: "Température de la boucle d'eau" },
  water_loop_humidity: { en: 'Water loop humidity', fr: "Humidité de la boucle d'eau" },
  solar_temperature: { en: 'Solar temperature', fr: 'Température solaire' },
  solar_humidity: { en: 'Solar humidity', fr: 'Humidité solaire' },
  bypass_temperature: { en: 'Bypass temperature', fr: 'Température du bypass' },
  bypass_humidity: { en: 'Bypass humidity', fr: 'Humidité du bypass' },
  season: { en: 'Season', fr: 'Saison' },
  filter_clogging: { en: 'Filter clogging', fr: 'Encrassement du filtre' },
  filter_days_left: { en: 'Filter days left', fr: 'Jours restants du filtre' },
  pressure_setpoint: { en: 'Pressure setpoint', fr: 'Consigne de pression' },
  ventilated_volume: { en: 'Ventilated volume', fr: 'Volume ventilé' },
  bypass_opening: { en: 'Bypass opening', fr: 'Ouverture du bypass' },
  bypass_2_opening: { en: 'Bypass 2 opening', fr: 'Ouverture du bypass 2' },
  bypass_3_opening: { en: 'Bypass 3 opening', fr: 'Ouverture du bypass 3' },
  hydror_valve_opening: { en: "Hydro'R valve opening", fr: "Ouverture de la vanne Hydro'R" },
  water_loop_duty_cycle: {
    en: 'Water loop duty cycle',
    fr: "Taux de fonctionnement de la boucle d'eau",
  },
  operating_time: { en: 'Operating time', fr: 'Durée de fonctionnement' },
  weeks_since_maintenance: { en: 'Weeks since maintenance', fr: "Semaines depuis l'entretien" },
  installation_date: { en: 'Installation date', fr: "Date d'installation" },
  problem: { en: 'Problem', fr: 'Problème' },
  self_test: { en: 'Self-test', fr: 'Autotest' },
  firmware_update: { en: 'Firmware update', fr: 'Mise à jour du micrologiciel' },
  pairing_mode: { en: 'Pairing mode', fr: 'Mode appairage' },
  paired_sensors: { en: 'Paired sensors', fr: 'Capteurs appairés' },
  signal_strength: { en: 'Signal strength', fr: 'Puissance du signal' },
  last_seen: { en: 'Last seen', fr: 'Dernière réception' },
  // Assistant
  temperature: { en: 'Temperature', fr: 'Température' },
  humidity: { en: 'Humidity', fr: 'Humidité' },
  battery: { en: 'Battery', fr: 'Batterie' },
  // Bridge
  connection: { en: 'Connection', fr: 'Connexion' },
  stick_problem: { en: 'Stick problem', fr: 'Problème de clé' },
  active_port: { en: 'Active port', fr: 'Port actif' },
  sender_id: { en: 'Sender ID', fr: "ID d'émission" },
} as const satisfies Readonly<Record<string, Names>>;

/** Every entity key that has a name. */
export type EntityKey = keyof typeof NAMES;

/** Name of an entity in `language`. */
export function entityName(key: EntityKey, language: Language): string {
  return NAMES[key][language];
}

/** All the keys of the name table (for tests). */
export function namedKeys(): EntityKey[] {
  return Object.keys(NAMES) as EntityKey[];
}
