/**
 * MQTT broker settings: external broker from the options, or the Home Assistant Supervisor's
 * broker (`GET http://supervisor/services/mqtt`, mqtt-interface.md § 8).
 */
import type { ExternalBroker, Options } from './config.ts';

/** Supervisor services endpoint for MQTT. */
export const SUPERVISOR_MQTT_URL = 'http://supervisor/services/mqtt';

/** Where the broker settings came from, plus the settings. */
export interface BrokerSettings extends ExternalBroker {
  readonly source: 'options' | 'supervisor';
}

/** The broker could not be determined. */
export class BrokerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerConfigError';
  }
}

/** The subset of `fetch` used here, injectable for tests. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** Options of {@link resolveBroker}. */
export interface ResolveBrokerOptions {
  /** Environment (reads `SUPERVISOR_TOKEN`). Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Default: global `fetch`. */
  readonly fetch?: FetchLike;
  /** Request timeout (ms). Default 10 s. */
  readonly timeoutMs?: number;
}

function field(data: Readonly<Record<string, unknown>>, key: string): unknown {
  return data[key];
}

/**
 * Returns the broker to connect to: the external one when `mqtt_host` is set, otherwise the
 * Supervisor's. Throws a {@link BrokerConfigError} with a clear message when the Supervisor is
 * unreachable, the token is missing or no MQTT service is available.
 */
export async function resolveBroker(
  options: Pick<Options, 'mqtt'>,
  resolveOptions: ResolveBrokerOptions = {},
): Promise<BrokerSettings> {
  if (options.mqtt !== undefined) return { ...options.mqtt, source: 'options' };

  const env = resolveOptions.env ?? process.env;
  const token = env.SUPERVISOR_TOKEN?.trim();
  if (token === undefined || token === '') {
    throw new BrokerConfigError(
      'mqtt_host is empty and SUPERVISOR_TOKEN is not set: set mqtt_host to use an external ' +
        'broker, or run as a Home Assistant app to use the Supervisor MQTT service',
    );
  }
  const doFetch: FetchLike = resolveOptions.fetch ?? ((url, init) => fetch(url, init));
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await doFetch(SUPERVISOR_MQTT_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(resolveOptions.timeoutMs ?? 10_000),
    });
  } catch (error) {
    throw new BrokerConfigError(
      `Cannot reach the Supervisor (${SUPERVISOR_MQTT_URL}): ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const record =
    typeof body === 'object' && body !== null ? (body as Readonly<Record<string, unknown>>) : {};
  if (!response.ok || field(record, 'result') !== 'ok') {
    const message = field(record, 'message');
    throw new BrokerConfigError(
      `No MQTT service from the Supervisor (HTTP ${response.status}` +
        `${typeof message === 'string' && message !== '' ? `: ${message}` : ''}): install and ` +
        'start an MQTT broker app (e.g. Mosquitto), or set mqtt_host',
    );
  }
  const dataValue = field(record, 'data');
  const data =
    typeof dataValue === 'object' && dataValue !== null
      ? (dataValue as Readonly<Record<string, unknown>>)
      : {};
  const host = field(data, 'host');
  const port = field(data, 'port');
  if (typeof host !== 'string' || host === '' || typeof port !== 'number') {
    throw new BrokerConfigError(
      'Invalid MQTT service data from the Supervisor (host or port missing)',
    );
  }
  const text = (key: string): string | undefined => {
    const value = field(data, key);
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  return {
    source: 'supervisor',
    host,
    port,
    username: text('username'),
    password: text('password'),
    tls: field(data, 'ssl') === true,
  };
}
