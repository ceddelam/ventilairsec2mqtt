/**
 * App options (mqtt-interface.md § 8): loaded from a JSON file (`/data/options.json` in the
 * Home Assistant app), trimmed, validated, defaults applied.
 */
import { readFile } from 'node:fs/promises';
import { validateBaseId } from '../esp3/commands.ts';
import { BROADCAST_ID, normalizeId, type EnOceanId } from '../hex.ts';
import { parseConnectionUrl } from '../transport/url.ts';
import { LOG_LEVELS, type LogLevel } from './log.ts';

/** Default options file inside the Home Assistant app. */
export const DEFAULT_OPTIONS_PATH = '/data/options.json';
/** Default state file inside the Home Assistant app. */
export const DEFAULT_STATE_PATH = '/data/state.json';

/** External MQTT broker settings (`mqtt_host` set). */
export interface ExternalBroker {
  readonly host: string;
  readonly port: number;
  readonly username: string | undefined;
  readonly password: string | undefined;
  readonly tls: boolean;
}

/** Validated options. */
export interface Options {
  /** Primary stick URL: `socket://host:port` or a serial device path. */
  readonly serialPort: string;
  readonly fallbackPort: string | undefined;
  /** `undefined`: scan mode (no unit yet; the program only logs the devices it hears). */
  readonly vmiId: EnOceanId | undefined;
  readonly assistantId: EnOceanId | undefined;
  readonly senderId: EnOceanId | undefined;
  readonly forceBaseId: EnOceanId | undefined;
  readonly syncClock: boolean;
  readonly acceptPairing: boolean;
  readonly topicPrefix: string;
  readonly discoveryPrefix: string;
  readonly logLevel: LogLevel;
  /** `undefined`: use the Supervisor's broker (`mqtt_host` empty). */
  readonly mqtt: ExternalBroker | undefined;
}

/** Invalid options; `problems` lists every error found. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid options:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Result of {@link parseOptions}: options and non-fatal warnings (e.g. unknown keys). */
export interface ParsedOptions {
  readonly options: Options;
  readonly warnings: readonly string[];
}

/** Every option key (mqtt-interface.md § 8). */
export const OPTION_KEYS: readonly string[] = [
  'serial_port',
  'fallback_port',
  'vmi_id',
  'assistant_id',
  'sender_id',
  'force_base_id',
  'sync_clock',
  'accept_pairing',
  'topic_prefix',
  'discovery_prefix',
  'log_level',
  'mqtt_host',
  'mqtt_port',
  'mqtt_user',
  'mqtt_password',
  'mqtt_tls',
];
const KNOWN_KEYS = new Set(OPTION_KEYS);

/** One or more topic levels made of letters, digits, `_` and `-`. */
const TOPIC_PATH = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

class Reader {
  readonly problems: string[] = [];
  readonly #raw: Readonly<Record<string, unknown>>;

  constructor(raw: Readonly<Record<string, unknown>>) {
    this.#raw = raw;
  }

  /** Trimmed string, or `undefined` when absent, null or empty. */
  string(key: string): string | undefined {
    const value = this.#raw[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      this.problems.push(`${key}: expected a string, got ${JSON.stringify(value)}`);
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  boolean(key: string, fallback: boolean): boolean {
    const value = this.#raw[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const text = value.trim().toLowerCase();
      if (text === '') return fallback;
      if (text === 'true') return true;
      if (text === 'false') return false;
    }
    this.problems.push(`${key}: expected true or false, got ${JSON.stringify(value)}`);
    return fallback;
  }

  integer(key: string, min: number, max: number): number | undefined {
    const value = this.#raw[key];
    if (value === undefined || value === null) return undefined;
    let number: number;
    if (typeof value === 'number') number = value;
    else if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) number = Number(value);
    else if (typeof value === 'string' && value.trim() === '') return undefined;
    else number = Number.NaN;
    if (!Number.isInteger(number) || number < min || number > max) {
      this.problems.push(
        `${key}: expected an integer in ${min}–${max}, got ${JSON.stringify(value)}`,
      );
      return undefined;
    }
    return number;
  }

  id(key: string): EnOceanId | undefined {
    const text = this.string(key);
    if (text === undefined) return undefined;
    let id: EnOceanId;
    try {
      id = normalizeId(text);
    } catch {
      this.problems.push(`${key}: "${text}" is not an EnOcean ID (8 hexadecimal digits)`);
      return undefined;
    }
    if (id === BROADCAST_ID || id === '00000000') {
      this.problems.push(`${key}: ${id} is not a device ID`);
      return undefined;
    }
    return id;
  }

  choice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
    const text = this.string(key)?.toLowerCase();
    if (text === undefined) return fallback;
    const found = choices.find((choice) => choice === text);
    if (found === undefined) {
      this.problems.push(`${key}: expected one of ${choices.join(', ')}, got "${text}"`);
      return fallback;
    }
    return found;
  }

  topicPath(key: string, fallback: string): string {
    const text = this.string(key);
    if (text === undefined) return fallback;
    if (!TOPIC_PATH.test(text)) {
      this.problems.push(
        `${key}: "${text}" must be MQTT topic levels made of letters, digits, "_" or "-" ` +
          `separated by "/" (no wildcard, no leading or trailing "/")`,
      );
      return fallback;
    }
    return text;
  }
}

/**
 * Validates raw options (the parsed JSON object). Throws a {@link ConfigError} listing every
 * problem. Unknown keys are reported as warnings.
 */
export function parseOptions(raw: unknown): ParsedOptions {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(['the options file must hold a JSON object']);
  }
  const record = raw as Readonly<Record<string, unknown>>;
  const r = new Reader(record);
  const warnings = Object.keys(record)
    .filter((key) => !KNOWN_KEYS.has(key))
    .map((key) => `Unknown option "${key}" ignored`);

  const serialPort = r.string('serial_port');
  if (serialPort === undefined) r.problems.push('serial_port: required');
  const fallbackPort = r.string('fallback_port');
  for (const [key, url] of [
    ['serial_port', serialPort],
    ['fallback_port', fallbackPort],
  ] as const) {
    if (url === undefined) continue;
    try {
      parseConnectionUrl(url);
    } catch (error) {
      r.problems.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Empty vmi_id = scan mode (the program logs the devices it hears to help find the IDs).
  const vmiId = r.id('vmi_id');
  const assistantId = r.id('assistant_id');
  const senderId = r.id('sender_id');
  const forceBaseId = r.id('force_base_id');
  if (forceBaseId !== undefined) {
    try {
      validateBaseId(forceBaseId);
    } catch (error) {
      r.problems.push(`force_base_id: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (vmiId !== undefined && assistantId === vmiId) {
    r.problems.push('assistant_id: must differ from vmi_id');
  }
  if (vmiId !== undefined && senderId === vmiId) {
    r.problems.push('sender_id: must differ from vmi_id');
  }

  const logLevel = r.choice('log_level', LOG_LEVELS, 'info');

  const host = r.string('mqtt_host');
  const tls = r.boolean('mqtt_tls', false);
  const port = r.integer('mqtt_port', 1, 65_535) ?? (tls ? 8883 : 1883);
  const username = r.string('mqtt_user');
  const password = r.string('mqtt_password');
  if (password !== undefined && username === undefined) {
    r.problems.push('mqtt_password: set without mqtt_user');
  }

  const options: Options = {
    serialPort: serialPort ?? '',
    fallbackPort,
    vmiId,
    assistantId,
    senderId,
    forceBaseId,
    syncClock: r.boolean('sync_clock', true),
    acceptPairing: r.boolean('accept_pairing', true),
    topicPrefix: r.topicPath('topic_prefix', 'ventilairsec2mqtt'),
    discoveryPrefix: r.topicPath('discovery_prefix', 'homeassistant'),
    logLevel,
    mqtt: host === undefined ? undefined : { host, port, username, password, tls },
  };
  if (r.problems.length > 0) throw new ConfigError(r.problems);
  return { options, warnings };
}

/** Reads and validates an options file. Throws a {@link ConfigError} on any problem. */
export async function loadOptions(path: string): Promise<ParsedOptions> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError([
      `cannot read the options file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError([
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  return parseOptions(raw);
}
