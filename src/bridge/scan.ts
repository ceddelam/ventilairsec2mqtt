/**
 * Scan mode (empty `vmi_id`): the program connects to the stick and the broker, publishes only
 * the bridge device, and logs every Ventilairsec device it hears, so users can find the IDs to
 * put in the options. Nothing is transmitted on the radio.
 */
import type { ConnectedInfo, PortRole } from '../connection.ts';
import { Rorg, type Erp1Telegram } from '../erp1.ts';
import { idToNumber, type EnOceanId } from '../hex.ts';
import { noopLogger, type Logger } from '../logger.ts';
import { decodeAssistant } from '../msc/assistant.ts';
import { parseMscHeader, VENTILAIRSEC_MANUFACTURER } from '../msc/envelope.ts';
import { decodeUnitStatus } from '../msc/unit.ts';
import { isTeachInQuery, parseUte } from '../pairing.ts';
import type { Incident } from '../stick.ts';
import { systemTimers, type Timers } from '../timers.ts';
import type { BridgeLink, MqttPublisher } from './bridge.ts';
import type { Options } from './config.ts';
import { bridgeDiscovery, topics, type AppInfo, type DiscoveryContext } from './discovery.ts';
import { errorMessage } from './log.ts';
import type { JsonObject } from './unit-model.ts';
import { IncidentTracker, THIRTY_MINUTES } from './watchdog.ts';

/**
 * Takes the place of the unit ID in the scan-mode bridge device identifier
 * (`ventilairsec2mqtt_bridge_scan`), so the scan device never collides with a configured one.
 */
export const SCAN_ID = 'scan';

/** What a heard device probably is. */
export type ScanGuess =
  | 'unit_to_us'
  | 'unit_to_assistant'
  | 'unit_to_other'
  | 'assistant'
  | 'probable_unit'
  | 'probable_assistant'
  | 'unknown'
  | 'teach_in';

/** One distinct finding of the scanner. */
export interface ScanFinding {
  readonly senderId: EnOceanId;
  readonly guess: ScanGuess;
  readonly destinationId: EnOceanId | undefined;
  readonly dbm: number | undefined;
  /** The log line (without level). */
  readonly message: string;
}

/** IDs of the stick: frames addressed to them are addressed to us. */
export interface OwnIds {
  readonly baseId: EnOceanId;
  /** `sender_id` option, when set. */
  readonly senderId?: EnOceanId | undefined;
}

const BASE_ID_RANGE = 0x7f;

function describe(guess: ScanGuess, command: number, reason: string): string {
  switch (guess) {
    case 'unit_to_us':
      return `ventilation unit (D1-079-01), status CMD ${command} addressed to this stick (paired with it)`;
    case 'unit_to_assistant':
      return `ventilation unit (D1-079-01), CMD ${command} addressed to its Assistant`;
    case 'unit_to_other':
      return `ventilation unit (D1-079-01), CMD ${command} addressed to another receiver`;
    case 'assistant':
      return `Assistant (D1-079-00), CMD ${command} addressed to the unit`;
    case 'probable_unit':
      return `probably a ventilation unit (CMD ${command}; ${reason})`;
    case 'probable_assistant':
      return `probably an Assistant (CMD ${command}; ${reason})`;
    case 'unknown':
      return `Ventilairsec device of unknown role (CMD ${command})`;
    case 'teach_in':
      return 'ventilation unit asking to pair (UTE teach-in query, sent for about 6 h after power-on)';
  }
}

function hint(guess: ScanGuess, senderId: EnOceanId, destination: string): string {
  switch (guess) {
    case 'unit_to_us':
      return ` → set vmi_id to ${senderId}`;
    case 'unit_to_other':
      return ` → candidate for vmi_id; it reports to ${destination}, not to this stick (see pairing)`;
    case 'probable_unit':
    case 'teach_in':
      return ' → candidate for vmi_id';
    case 'assistant':
    case 'probable_assistant':
      return ' → candidate for assistant_id (optional, learnt automatically)';
    case 'unit_to_assistant':
    case 'unknown':
      return '';
  }
}

/**
 * Finds the Ventilairsec devices in received telegrams and guesses their role. Pure: feed it
 * telegrams, it returns each finding once (a sender is reported again when its guess or its
 * destination changes, e.g. once its role becomes known).
 *
 * Certain: a unit addresses its status to the stick it is paired with, and asks to pair with
 * UTE queries; an Assistant addresses its frames to a unit or appears in the unit's paired
 * sensor list. Without these, the guess comes from the frame shape: a unit sends short `CMD 0`
 * frames to its Assistant, and an Assistant's `CMD 1` / `CMD 3` decode as plausible battery,
 * temperature and humidity; the peer of a probable unit or Assistant is then probably the other.
 */
export class DeviceScanner {
  readonly #seen = new Set<string>();
  readonly #units = new Set<EnOceanId>();
  readonly #assistants = new Set<EnOceanId>();
  readonly #likelyUnits = new Set<EnOceanId>();
  readonly #likelyAssistants = new Set<EnOceanId>();

  /** Senders identified as units so far. */
  get units(): readonly EnOceanId[] {
    return [...this.#units];
  }

  /** Senders identified as Assistants so far (frames to a unit, or a unit's paired list). */
  get assistants(): readonly EnOceanId[] {
    return [...this.#assistants];
  }

  /** Returns the new findings of `telegram` (usually none or one). */
  observe(telegram: Erp1Telegram, own: OwnIds): ScanFinding[] {
    if (telegram.rorg === Rorg.UTE) return this.#teachIn(telegram);
    if (telegram.rorg !== Rorg.MSC) return [];
    const header = parseMscHeader(telegram.payload);
    if (header?.manufacturer !== VENTILAIRSEC_MANUFACTURER) return [];

    const sender = telegram.senderId;
    const destination = telegram.destinationId;
    const command = header.command;
    const findings: ScanFinding[] = [];
    let guess: ScanGuess;
    let reason = '';
    if (destination !== undefined && isOwn(destination, own)) {
      guess = 'unit_to_us';
      this.#units.add(sender);
      findings.push(...this.#pairedSensor(telegram));
    } else if (this.#units.has(sender)) {
      guess =
        destination !== undefined && this.#assistants.has(destination)
          ? 'unit_to_assistant'
          : 'unit_to_other';
      findings.push(...this.#pairedSensor(telegram));
    } else if (
      this.#assistants.has(sender) ||
      (destination !== undefined && this.#units.has(destination))
    ) {
      guess = 'assistant';
      this.#assistants.add(sender);
    } else if (command === 0 && telegram.payload.length === 6) {
      guess = 'probable_unit';
      reason = 'short frame, as a unit sends to its Assistant';
      this.#likelyUnits.add(sender);
      if (destination !== undefined) this.#likelyAssistants.add(destination);
    } else if (plausibleAssistantFrame(telegram.payload) !== undefined) {
      guess = 'probable_assistant';
      reason = plausibleAssistantFrame(telegram.payload) ?? '';
      this.#likelyAssistants.add(sender);
      if (destination !== undefined) this.#likelyUnits.add(destination);
    } else if (this.#likelyUnits.has(sender)) {
      guess = 'probable_unit';
      reason = 'a probable Assistant talks to it';
    } else if (this.#likelyAssistants.has(sender)) {
      guess = 'probable_assistant';
      reason = 'a probable unit talks to it';
    } else {
      guess = 'unknown';
    }
    const finding = this.#finding(telegram, guess, describe(guess, command, reason));
    return finding === undefined ? findings : [finding, ...findings];
  }

  #teachIn(telegram: Erp1Telegram): ScanFinding[] {
    const query = parseUte(telegram);
    if (query === undefined || !isTeachInQuery(telegram)) return [];
    if (query.manufacturer !== VENTILAIRSEC_MANUFACTURER) {
      const finding = this.#finding(
        telegram,
        'unknown',
        `teach-in query from another manufacturer (0x${query.manufacturer.toString(16).padStart(3, '0')}), ignored`,
      );
      return finding === undefined ? [] : [finding];
    }
    this.#units.add(telegram.senderId);
    const finding = this.#finding(telegram, 'teach_in', describe('teach_in', 0, ''));
    return finding === undefined ? [] : [finding];
  }

  /** `CMD 8` from a unit: its paired sensors, one per frame. */
  #pairedSensor(telegram: Erp1Telegram): ScanFinding[] {
    const status = decodeUnitStatus(telegram.payload);
    if (status?.command !== 8 || status.sensorId === undefined) return [];
    const sensor = status.sensorId;
    const key = `paired ${telegram.senderId} ${sensor}`;
    if (this.#seen.has(key)) return [];
    this.#seen.add(key);
    if (status.profile === 'assistant') this.#assistants.add(sensor);
    const profile = status.profile ?? `raw ${status.profileRaw ?? '?'}`;
    const room = status.room ?? `raw ${status.roomRaw ?? '?'}`;
    return [
      {
        senderId: sensor,
        guess: status.profile === 'assistant' ? 'assistant' : 'unknown',
        destinationId: undefined,
        dbm: undefined,
        message:
          `Unit ${telegram.senderId} lists paired sensor ${sensor} (profile ${profile}, room ${room})` +
          (status.profile === 'assistant' ? ' → candidate for assistant_id' : ''),
      },
    ];
  }

  #finding(telegram: Erp1Telegram, guess: ScanGuess, what: string): ScanFinding | undefined {
    const sender = telegram.senderId;
    const destination = telegram.destinationId;
    const key = `${sender} ${guess} ${destination ?? '-'}`;
    if (this.#seen.has(key)) return undefined;
    this.#seen.add(key);
    const to = destination ?? 'unknown destination';
    const level = telegram.dbm === undefined ? '? dBm' : `${telegram.dbm} dBm`;
    return {
      senderId: sender,
      guess,
      destinationId: destination,
      dbm: telegram.dbm,
      message: `Heard ${sender} → ${to} (${level}): ${what}${hint(guess, sender, to)}`,
    };
  }
}

/** "t °C, h %" when an Assistant `CMD 1` / `CMD 3` decoding of `payload` is plausible. */
function plausibleAssistantFrame(payload: Uint8Array): string | undefined {
  const frame = decodeAssistant(payload);
  if (
    frame?.kind !== 'measurement' ||
    frame.temperature === undefined ||
    frame.temperature > 125 ||
    frame.humidity === undefined ||
    frame.humidity > 100 ||
    (frame.batteryRaw ?? 0) > 6
  ) {
    return undefined;
  }
  return `${frame.temperature} °C, ${frame.humidity} %`;
}

function isOwn(id: EnOceanId, own: OwnIds): boolean {
  if (own.senderId !== undefined && id === own.senderId) return true;
  const offset = idToNumber(id) - idToNumber(own.baseId);
  return offset >= 0 && offset <= BASE_ID_RANGE;
}

/** Options used in scan mode. */
export type ScanSettings = Pick<Options, 'senderId' | 'topicPrefix' | 'discoveryPrefix'>;

/** Constructor options of {@link ScanBridge}. */
export interface ScanBridgeOptions {
  readonly settings: ScanSettings;
  readonly app: AppInfo;
  readonly link: BridgeLink;
  readonly mqtt: MqttPublisher;
  readonly timers?: Timers;
  readonly logger?: Logger;
  /** Stick problem clearing delay (ms). Default 30 min. */
  readonly timeoutMs?: number;
}

/**
 * The scan-mode counterpart of `Bridge`: same bridge device and JSON state, no unit or
 * Assistant device, no transmission; findings are logged at info level.
 */
export class ScanBridge {
  readonly scanner = new DeviceScanner();
  readonly #settings: ScanSettings;
  readonly #link: BridgeLink;
  readonly #mqtt: MqttPublisher;
  readonly #logger: Logger;
  readonly #ctx: DiscoveryContext;
  readonly #topics: ReturnType<typeof topics>;
  readonly #incidents: IncidentTracker;
  #connected = false;
  #activePort: PortRole = 'primary';
  #baseId: EnOceanId | undefined;
  #started = false;
  #stopped = false;

  readonly #listeners = {
    connected: (info: ConnectedInfo) => {
      this.#connected = true;
      this.#activePort = info.port;
      this.#baseId = info.baseId;
      this.#logger.info(
        `Scan mode: listening (stick Base ID ${info.baseId}); every Ventilairsec device heard ` +
          'is logged once. Status frames come at least every 10 min.',
      );
      this.#publishState();
    },
    disconnected: () => {
      this.#connected = false;
      this.#publishState();
    },
    portSwitched: ({ to }: { to: PortRole }) => {
      this.#activePort = to;
      this.#publishState();
    },
    incident: (incident: Incident) => {
      this.#logger.warn(`Stick problem (${incident.reason}): ${incident.detail}`);
      this.#incidents.raise(incident.reason);
    },
    telegram: (telegram: Erp1Telegram) => {
      this.#onTelegram(telegram);
    },
  };

  constructor(options: ScanBridgeOptions) {
    this.#settings = options.settings;
    this.#link = options.link;
    this.#mqtt = options.mqtt;
    this.#logger = options.logger ?? noopLogger;
    this.#ctx = {
      topicPrefix: this.#settings.topicPrefix,
      discoveryPrefix: this.#settings.discoveryPrefix,
      app: options.app,
      vmiId: SCAN_ID,
    };
    this.#topics = topics(this.#ctx, SCAN_ID);
    this.#incidents = new IncidentTracker(
      options.timers ?? systemTimers,
      () => {
        this.#publishState();
      },
      options.timeoutMs ?? THIRTY_MINUTES,
    );
  }

  /** Topics to subscribe to: only the Home Assistant birth message. */
  subscriptions(): string[] {
    return [`${this.#settings.discoveryPrefix}/status`];
  }

  /** Current bridge JSON state (same keys as `Bridge`). */
  bridgeState(): JsonObject {
    const state: JsonObject = {
      active_port: this.#activePort,
      connection: this.#connected,
      stick_problem: this.#incidents.active,
      stick_problem_reason: this.#incidents.reason ?? null,
    };
    if (this.#baseId !== undefined) {
      state.base_id = this.#baseId;
      state.sender_id = this.#settings.senderId ?? this.#baseId;
    }
    return state;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#logger.warn(
      'vmi_id is empty: scan mode. The bridge only logs the Ventilairsec devices it hears; ' +
        'set vmi_id (and restart) once the unit is found.',
    );
    const l = this.#listeners;
    this.#link.on('connected', l.connected);
    this.#link.on('disconnected', l.disconnected);
    this.#link.on('portSwitched', l.portSwitched);
    this.#link.on('incident', l.incident);
    this.#link.on('telegram', l.telegram);
  }

  /**
   * Removes the scan-mode bridge device (empty retained discovery, so it does not linger once
   * `vmi_id` is set) and publishes `offline`.
   */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const l = this.#listeners;
    this.#link.off('connected', l.connected);
    this.#link.off('disconnected', l.disconnected);
    this.#link.off('portSwitched', l.portSwitched);
    this.#link.off('incident', l.incident);
    this.#link.off('telegram', l.telegram);
    this.#incidents.stop();
    if (!this.#mqtt.connected) return;
    const discovery = bridgeDiscovery(this.#ctx);
    for (const [topic, payload] of [
      [discovery.topic, ''],
      [this.#topics.bridgeAvailability, 'offline'],
    ] as const) {
      await this.#mqtt.publish(topic, payload, { retain: true }).catch((error: unknown) => {
        this.#logger.warn(`Cannot publish on ${topic}: ${errorMessage(error)}`);
      });
    }
  }

  /** To call after each (re)connection to the broker. */
  onMqttConnected(): void {
    this.#logger.info('Connected to the MQTT broker');
    this.#publishAll();
  }

  handleMessage(topic: string, payload: string): void {
    if (topic === `${this.#settings.discoveryPrefix}/status` && payload.trim() === 'online') {
      this.#publishAll();
    }
  }

  #publish(topic: string, payload: string): void {
    if (!this.#mqtt.connected || this.#stopped) return;
    this.#mqtt.publish(topic, payload, { retain: true }).catch((error: unknown) => {
      this.#logger.warn(`Cannot publish on ${topic}: ${errorMessage(error)}`);
    });
  }

  #publishAll(): void {
    this.#publish(this.#topics.bridgeAvailability, 'online');
    const discovery = bridgeDiscovery(this.#ctx);
    this.#publish(discovery.topic, JSON.stringify(discovery.payload));
    this.#publishState();
  }

  #publishState(): void {
    this.#publish(this.#topics.bridgeState, JSON.stringify(this.bridgeState()));
  }

  #onTelegram(telegram: Erp1Telegram): void {
    const baseId = this.#baseId;
    if (baseId === undefined || this.#stopped) return;
    const findings = this.scanner.observe(telegram, {
      baseId,
      senderId: this.#settings.senderId,
    });
    if (findings.length === 0) {
      this.#logger.debug(`Scan: telegram from ${telegram.senderId} (nothing new)`);
    }
    for (const finding of findings) this.#logger.info(finding.message);
  }
}
