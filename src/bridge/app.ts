/**
 * Composition of the app: state file, MQTT broker (external or Supervisor), stick connection
 * and bridge. Used by `main.ts` and by the end-to-end test.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect, type IClientOptions, type MqttClient } from 'mqtt';
import { StickConnection, type StickConnectionOptions } from '../connection.ts';
import type { Logger } from '../logger.ts';
import type { Timers } from '../timers.ts';
import { Bridge, type MqttPublisher } from './bridge.ts';
import type { Options } from './config.ts';
import { topics, type AppInfo } from './discovery.ts';
import { errorMessage } from './log.ts';
import { StateStore } from './state-store.ts';
import { resolveBroker, type BrokerSettings, type ResolveBrokerOptions } from './supervisor.ts';

/** Reads the app name, version and support URL (`homepage`) from package.json. */
export function readAppInfo(): AppInfo {
  const raw = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as Partial<Record<'name' | 'version' | 'homepage', unknown>>;
  return {
    name: typeof raw.name === 'string' ? raw.name : 'ventilairsec2mqtt',
    version: typeof raw.version === 'string' ? raw.version : '0.0.0',
    supportUrl: typeof raw.homepage === 'string' ? raw.homepage : undefined,
  };
}

/** Options of {@link startApp}. */
export interface StartAppOptions {
  readonly options: Options;
  /** State file path (`/data/state.json` in the app). */
  readonly stateFile: string;
  readonly logger: Logger;
  /** Supervisor lookup (environment, fetch), for tests. */
  readonly supervisor?: ResolveBrokerOptions;
  readonly timers?: Timers;
  /** Extra stick connection options (e.g. a transport factory), for tests. */
  readonly link?: Partial<Omit<StickConnectionOptions, 'primary' | 'fallback' | 'forceBaseId'>>;
  /** MQTT reconnection period (ms). Default 5 s. */
  readonly mqttReconnectPeriodMs?: number;
  readonly app?: AppInfo;
}

/** A running app. */
export interface RunningApp {
  readonly bridge: Bridge;
  readonly link: StickConnection;
  readonly mqtt: MqttClient;
  readonly broker: BrokerSettings;
  /** Publishes `offline`, closes the stick and the MQTT connection. */
  stop(): Promise<void>;
}

/** Starts the app. Throws a `BrokerConfigError` when no broker can be determined. */
export async function startApp(start: StartAppOptions): Promise<RunningApp> {
  const { options, logger } = start;
  const app = start.app ?? readAppInfo();
  logger.info(`${app.name} ${app.version} starting (unit ${options.vmiId})`);

  const store = new StateStore(start.stateFile, logger);
  await store.load();
  const broker = await resolveBroker(options, start.supervisor);
  logger.info(
    `MQTT broker ${broker.tls ? 'mqtts' : 'mqtt'}://${broker.host}:${broker.port} ` +
      `(${broker.source === 'supervisor' ? 'from the Supervisor' : 'from the options'})`,
  );

  const link = new StickConnection({
    ...start.link,
    primary: options.serialPort,
    fallback: options.fallbackPort,
    forceBaseId: options.forceBaseId,
    logger,
    ...(start.timers === undefined ? {} : { timers: start.timers }),
  });

  const t = topics(options, options.vmiId);
  const clientOptions: IClientOptions = {
    host: broker.host,
    port: broker.port,
    protocol: broker.tls ? 'mqtts' : 'mqtt',
    clientId: `ventilairsec2mqtt_${options.vmiId}_${randomBytes(3).toString('hex')}`,
    reconnectPeriod: start.mqttReconnectPeriodMs ?? 5000,
    connectTimeout: 30_000,
    will: { topic: t.bridgeAvailability, payload: Buffer.from('offline'), retain: true, qos: 1 },
    ...(broker.username === undefined ? {} : { username: broker.username }),
    ...(broker.password === undefined ? {} : { password: broker.password }),
  };
  const client = connect(clientOptions);
  const publisher: MqttPublisher = {
    get connected() {
      return client.connected;
    },
    publish: async (topic, payload, { retain }) => {
      await client.publishAsync(topic, payload, { retain, qos: 1 });
    },
  };

  const bridge = new Bridge({
    settings: options,
    app,
    link,
    mqtt: publisher,
    store,
    logger,
    ...(start.timers === undefined ? {} : { timers: start.timers }),
  });
  bridge.start();

  client.on('connect', () => {
    client.subscribeAsync(bridge.subscriptions(), { qos: 1 }).catch((error: unknown) => {
      logger.error(`MQTT subscription failed: ${errorMessage(error)}`);
    });
    bridge.onMqttConnected();
  });
  client.on('message', (topic, payload) => {
    bridge.handleMessage(topic, payload.toString('utf8'));
  });
  client.on('error', (error) => {
    logger.error(`MQTT: ${error.message}`);
  });
  client.on('offline', () => {
    logger.warn('MQTT broker unreachable, reconnecting');
  });

  link.start();

  let stopping: Promise<void> | undefined;
  return {
    bridge,
    link,
    mqtt: client,
    broker,
    stop: () => {
      stopping ??= (async () => {
        await bridge.stop();
        await link.stop();
        await client.endAsync().catch((error: unknown) => {
          logger.warn(`MQTT disconnect: ${errorMessage(error)}`);
        });
      })();
      return stopping;
    },
  };
}
