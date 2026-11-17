/**
 * The MQTT bridge (mqtt-interface.md): turns the stick's telegrams into Home Assistant devices,
 * entities and JSON states, and MQTT orders into radio telegrams.
 *
 * The bridge owns no connection: it listens to a {@link BridgeLink} (a `StickConnection`) and
 * publishes through a {@link MqttPublisher}. The caller subscribes to {@link Bridge.subscriptions},
 * forwards messages to {@link Bridge.handleMessage} and calls {@link Bridge.onMqttConnected}
 * after each (re)connection to the broker.
 */
import { classifyTelegram } from '../classify.ts';
import type { ConnectedInfo, PortRole, StickConnectionEvents } from '../connection.ts';
import type { Erp1Telegram, TransmitTelegram } from '../erp1.ts';
import { idToNumber, type EnOceanId } from '../hex.ts';
import { noopLogger, type Logger } from '../logger.ts';
import { MachineIdGuard } from '../machine-id.ts';
import type { AssistantFrame } from '../msc/assistant.ts';
import { updateFunctionByte, type FunctionChange } from '../msc/function-byte.ts';
import type { UnitStatusFrame } from '../msc/unit.ts';
import {
  buildClockTelegram,
  buildSettingsTelegram,
  mergeSettings,
  type SettingsOrder,
} from '../orders.ts';
import { buildTeachInResponse, shouldAnswerTeachIn } from '../pairing.ts';
import type { Incident, SendResult } from '../stick.ts';
import { systemTimers, type TimerHandle, type Timers } from '../timers.ts';
import { AssistantModel } from './assistant-model.ts';
import {
  changesFunctionByte,
  InvalidOrderError,
  parseJsonOrder,
  parseKeyOrder,
  type DurationSwitch,
  type ParsedOrder,
} from './commands.ts';
import type { Options } from './config.ts';
import {
  assistantDiscovery,
  bridgeDiscovery,
  discoveryTopic,
  topics,
  unitDiscovery,
  type AppInfo,
  type DiscoveryContext,
  type RemovedComponent,
} from './discovery.ts';
import type { Platform } from './entities.ts';
import { errorMessage } from './log.ts';
import type { StateStoreLike } from './state-store.ts';
import { UnitModel, type JsonObject, type OptimisticChange } from './unit-model.ts';
import { AvailabilityTracker, IncidentTracker, THIRTY_MINUTES } from './watchdog.ts';

/** What the bridge needs from the stick connection. */
export interface BridgeLink {
  on<K extends keyof StickConnectionEvents>(
    event: K,
    listener: (...args: StickConnectionEvents[K]) => void,
  ): unknown;
  off<K extends keyof StickConnectionEvents>(
    event: K,
    listener: (...args: StickConnectionEvents[K]) => void,
  ): unknown;
  send(telegram: TransmitTelegram): Promise<SendResult>;
}

/** What the bridge needs from the MQTT client. */
export interface MqttPublisher {
  /** True while connected to the broker; nothing is published otherwise. */
  readonly connected: boolean;
  publish(topic: string, payload: string, options: { readonly retain: boolean }): Promise<void>;
}

/** Options used by the bridge. */
export type BridgeSettings = Pick<
  Options,
  | 'vmiId'
  | 'assistantId'
  | 'senderId'
  | 'syncClock'
  | 'acceptPairing'
  | 'topicPrefix'
  | 'discoveryPrefix'
>;

/** Constructor options of {@link Bridge}. */
export interface BridgeOptions {
  readonly settings: BridgeSettings;
  readonly app: AppInfo;
  readonly link: BridgeLink;
  readonly mqtt: MqttPublisher;
  readonly store: StateStoreLike;
  readonly timers?: Timers;
  readonly logger?: Logger;
  /** Clock sync period (ms). Default 1 h. */
  readonly clockSyncIntervalMs?: number;
  /** How long a function-byte order waits for the first `CMD 0` (ms). Default 15 min. */
  readonly pendingOrderTimeoutMs?: number;
  /** Availability timeout and stick problem clearing delay (ms). Default 30 min. */
  readonly timeoutMs?: number;
  /** Ask the unit for a full status after each stick connection. Default true. */
  readonly refreshOnConnect?: boolean;
}

/** A settings order with durations resolved; the function byte is computed at send time. */
interface ResolvedOrder {
  readonly settings: SettingsOrder;
  readonly functionChange: FunctionChange;
}

type AssistantSource = 'option' | 'paired_list' | 'frame' | 'state_file';

const HOUR = 60 * 60_000;

function defined<T extends object>(value: { [K in keyof T]: T[K] | undefined }): T {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (item !== undefined) result[key] = item;
  return result as T;
}

function durationValue(value: DurationSwitch | undefined, stored: number): number | undefined {
  if (value === undefined) return undefined;
  if (value === 'on') return stored;
  if (value === 'off') return 0;
  return value;
}

function setpointValue(value: number | 'off' | undefined): number | null | undefined {
  return value === 'off' ? null : value;
}

/** The bridge between the stick and MQTT. */
export class Bridge {
  readonly #settings: BridgeSettings;
  readonly #link: BridgeLink;
  readonly #mqtt: MqttPublisher;
  readonly #store: StateStoreLike;
  readonly #timers: Timers;
  readonly #logger: Logger;
  readonly #ctx: DiscoveryContext;
  readonly #topics: ReturnType<typeof topics>;
  readonly #clockSyncIntervalMs: number;
  readonly #pendingOrderTimeoutMs: number;
  readonly #refreshOnConnect: boolean;
  readonly #timeoutMs: number;

  readonly #unit = new UnitModel();
  readonly #unitAvailability: AvailabilityTracker;
  readonly #incidents: IncidentTracker;
  readonly #machineId = new MachineIdGuard();
  #assistant = new AssistantModel();
  #assistantAvailability: AvailabilityTracker | undefined;
  #assistantId: EnOceanId | undefined;
  #assistantSource: AssistantSource | undefined;
  readonly #staleAssistants = new Set<EnOceanId>();

  #connected = false;
  #activePort: PortRole = 'primary';
  #baseId: EnOceanId | undefined;
  #senderId: EnOceanId | undefined;
  #lastAnswerAt: number | undefined;
  #lastAddressedToUsAt: number | undefined;

  #unitDiscoveryText: string | undefined;
  #unitComponents: ReadonlyMap<string, Platform> = new Map();
  #pending: { order: ResolvedOrder; timer: TimerHandle } | undefined;
  #orders: Promise<void> = Promise.resolve();
  #clockTimer: TimerHandle | undefined;
  #started = false;
  #stopped = false;
  #unitHeard = false;

  readonly #listeners = {
    connected: (info: ConnectedInfo) => {
      this.#onConnected(info);
    },
    disconnected: () => {
      this.#connected = false;
      this.#publishBridgeState();
    },
    portSwitched: ({ to }: { to: PortRole }) => {
      this.#activePort = to;
      this.#publishBridgeState();
    },
    incident: (incident: Incident) => {
      this.#raiseIncident(incident.reason, incident.detail);
    },
    telegram: (telegram: Erp1Telegram) => {
      this.#onTelegram(telegram);
    },
  };

  constructor(options: BridgeOptions) {
    this.#settings = options.settings;
    this.#link = options.link;
    this.#mqtt = options.mqtt;
    this.#store = options.store;
    this.#timers = options.timers ?? systemTimers;
    this.#logger = options.logger ?? noopLogger;
    this.#clockSyncIntervalMs = options.clockSyncIntervalMs ?? HOUR;
    this.#pendingOrderTimeoutMs = options.pendingOrderTimeoutMs ?? 15 * 60_000;
    this.#refreshOnConnect = options.refreshOnConnect ?? true;
    this.#timeoutMs = options.timeoutMs ?? THIRTY_MINUTES;
    this.#ctx = {
      topicPrefix: this.#settings.topicPrefix,
      discoveryPrefix: this.#settings.discoveryPrefix,
      app: options.app,
      vmiId: this.#settings.vmiId,
    };
    this.#topics = topics(this.#ctx, this.#settings.vmiId);
    this.#unitAvailability = new AvailabilityTracker(
      this.#timers,
      (state) => {
        this.#logger.info(`Unit ${this.#settings.vmiId} ${state}`);
        this.#publish(this.#topics.availability(this.#settings.vmiId), state);
      },
      this.#timeoutMs,
    );
    this.#incidents = new IncidentTracker(
      this.#timers,
      () => {
        if (!this.#incidents.active) this.#logger.info('Stick problem cleared');
        this.#publishBridgeState();
      },
      this.#timeoutMs,
    );
  }

  /** Topics to subscribe to. */
  subscriptions(): string[] {
    return [this.#topics.set, this.#topics.setKey('+'), `${this.#settings.discoveryPrefix}/status`];
  }

  /** The current sender ID (option or the stick's Base ID), once connected. */
  get senderId(): EnOceanId | undefined {
    return this.#senderId;
  }

  /** The Assistant ID in use (configured or learned). */
  get assistantId(): EnOceanId | undefined {
    return this.#assistantId;
  }

  /** Current unit JSON state (for tests and diagnostics). */
  unitState(): JsonObject {
    return this.#unit.state();
  }

  /** Current Assistant JSON state. */
  assistantState(): JsonObject {
    return this.#assistant.state();
  }

  /** Current bridge JSON state. */
  bridgeState(): JsonObject {
    const state: JsonObject = {
      active_port: this.#activePort,
      connection: this.#connected,
      stick_problem: this.#incidents.active,
      stick_problem_reason: this.#incidents.reason ?? null,
    };
    if (this.#baseId !== undefined) state.base_id = this.#baseId;
    if (this.#senderId !== undefined) state.sender_id = this.#senderId;
    return state;
  }

  /** Resolves once every order received so far has been handled. */
  idle(): Promise<void> {
    return this.#orders;
  }

  /** Attaches to the link and starts the timers. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    const { boostDuration, holidayDuration, learnedAssistantId } = this.#store.state;
    this.#unit.set('boost_duration', boostDuration);
    this.#unit.set('holiday_duration', holidayDuration);
    if (this.#settings.assistantId !== undefined) {
      this.#setAssistant(this.#settings.assistantId, 'option');
      if (learnedAssistantId !== undefined && learnedAssistantId !== this.#settings.assistantId) {
        this.#staleAssistants.add(learnedAssistantId);
      }
    } else if (learnedAssistantId !== undefined) {
      this.#setAssistant(learnedAssistantId, 'state_file');
    }
    this.#unitAvailability.start();
    const l = this.#listeners;
    this.#link.on('connected', l.connected);
    this.#link.on('disconnected', l.disconnected);
    this.#link.on('portSwitched', l.portSwitched);
    this.#link.on('incident', l.incident);
    this.#link.on('telegram', l.telegram);
    this.#scheduleClockSync();
  }

  /** Publishes `offline`, stops the timers and detaches from the link. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const l = this.#listeners;
    this.#link.off('connected', l.connected);
    this.#link.off('disconnected', l.disconnected);
    this.#link.off('portSwitched', l.portSwitched);
    this.#link.off('incident', l.incident);
    this.#link.off('telegram', l.telegram);
    this.#unitAvailability.stop();
    this.#assistantAvailability?.stop();
    this.#incidents.stop();
    if (this.#clockTimer !== undefined) this.#timers.clearTimeout(this.#clockTimer);
    if (this.#pending !== undefined) this.#timers.clearTimeout(this.#pending.timer);
    this.#pending = undefined;
    if (this.#mqtt.connected) {
      await this.#mqtt
        .publish(this.#topics.bridgeAvailability, 'offline', { retain: true })
        .catch((error: unknown) => {
          this.#logger.warn(`Cannot publish offline: ${errorMessage(error)}`);
        });
    }
  }

  /** To call after each (re)connection to the broker: publishes everything. */
  onMqttConnected(): void {
    this.#logger.info('Connected to the MQTT broker');
    this.#publishAll();
  }

  /** Handles a message on one of {@link subscriptions}. */
  handleMessage(topic: string, payload: string): void {
    if (topic === `${this.#settings.discoveryPrefix}/status`) {
      if (payload.trim() === 'online') {
        this.#logger.info('Home Assistant is online: publishing discovery and states');
        this.#publishAll();
      }
      return;
    }
    let order: ParsedOrder;
    try {
      if (topic === this.#topics.set) order = parseJsonOrder(payload);
      else if (topic.startsWith(`${this.#topics.set}/`)) {
        order = parseKeyOrder(topic.slice(this.#topics.set.length + 1), payload);
      } else return;
    } catch (error) {
      if (!(error instanceof InvalidOrderError)) throw error;
      this.#logger.warn(`Rejected order on ${topic}: ${error.message}`);
      return;
    }
    this.#logger.info(`Order on ${topic}: ${payload}`);
    this.#enqueue(() => this.#execute(order));
  }

  /** Runs order tasks one at a time; a failure is logged and does not block the next ones. */
  #enqueue(task: () => Promise<void>): void {
    this.#orders = this.#orders.then(task).catch((error: unknown) => {
      this.#logger.error(`Order failed: ${errorMessage(error)}`);
    });
  }

  // --- Publishing -------------------------------------------------------------------------

  #publish(topic: string, payload: string, retain = true): void {
    if (!this.#mqtt.connected || this.#stopped) return;
    this.#mqtt.publish(topic, payload, { retain }).catch((error: unknown) => {
      this.#logger.warn(`Cannot publish on ${topic}: ${errorMessage(error)}`);
    });
  }

  #publishJson(topic: string, payload: unknown): void {
    this.#publish(topic, JSON.stringify(payload));
  }

  #publishAll(): void {
    if (!this.#mqtt.connected || this.#stopped) return;
    this.#publish(this.#topics.bridgeAvailability, 'online');
    const bridge = bridgeDiscovery(this.#ctx);
    this.#publishJson(bridge.topic, bridge.payload);
    this.#publishBridgeState();
    for (const stale of this.#staleAssistants) this.#removeAssistantDevice(stale);
    this.#staleAssistants.clear();
    this.#publishUnitDiscovery(true);
    this.#publishUnitState();
    const unitAvailability = this.#unitAvailability.state;
    if (unitAvailability !== undefined) {
      this.#publish(this.#topics.availability(this.#settings.vmiId), unitAvailability);
    }
    if (this.#assistantId !== undefined) {
      const discovery = assistantDiscovery(this.#ctx, this.#assistantId);
      this.#publishJson(discovery.topic, discovery.payload);
      this.#publishAssistantState();
      const availability = this.#assistantAvailability?.state;
      if (availability !== undefined) {
        this.#publish(this.#topics.availability(this.#assistantId), availability);
      }
    }
  }

  #publishBridgeState(): void {
    this.#publishJson(this.#topics.bridgeState, this.bridgeState());
  }

  /**
   * Publishes the unit state once a status frame was received in this run: until then the
   * retained state of the previous run stays (values kept by the app join the first publish).
   */
  #publishUnitState(): void {
    if (!this.#unitHeard) return;
    this.#publishJson(this.#topics.device(this.#settings.vmiId), this.#unit.state());
  }

  #publishAssistantState(): void {
    if (this.#assistantId === undefined) return;
    const state = this.#assistant.state();
    if (Object.keys(state).length === 0) return;
    this.#publishJson(this.#topics.device(this.#assistantId), state);
  }

  /**
   * Publishes the unit's discovery once its composition is known, when it changed (or always
   * with `force`). Components that disappeared are first published with their platform only,
   * which removes them in Home Assistant, then the device is published without them.
   */
  #publishUnitDiscovery(force: boolean): void {
    if (!this.#unit.compositionKnown || !this.#mqtt.connected) return;
    const features = this.#unit.features;
    const card = this.#unit.card;
    const discovery = unitDiscovery(this.#ctx, card, features);
    const text = JSON.stringify(discovery.payload);
    if (!force && text === this.#unitDiscoveryText) return;
    const removed: RemovedComponent[] = [];
    for (const [key, platform] of this.#unitComponents) {
      if (!discovery.components.has(key)) removed.push({ key, platform });
    }
    if (removed.length > 0) {
      this.#logger.info(`Removing entities: ${removed.map((r) => r.key).join(', ')}`);
      this.#publishJson(discovery.topic, unitDiscovery(this.#ctx, card, features, removed).payload);
    }
    const added = [...discovery.components.keys()].filter((k) => !this.#unitComponents.has(k));
    if (this.#unitComponents.size > 0 && added.length > 0) {
      this.#logger.info(`Adding entities: ${added.join(', ')}`);
    }
    this.#publishJson(discovery.topic, discovery.payload);
    this.#unitDiscoveryText = text;
    this.#unitComponents = discovery.components;
  }

  #removeAssistantDevice(id: EnOceanId): void {
    this.#logger.info(`Removing the Assistant device ${id}`);
    this.#publish(discoveryTopic(this.#ctx, id), '');
    this.#publish(this.#topics.device(id), '');
    this.#publish(this.#topics.availability(id), '');
  }

  // --- Link events ------------------------------------------------------------------------

  #onConnected(info: ConnectedInfo): void {
    this.#connected = true;
    this.#activePort = info.port;
    this.#baseId = info.baseId;
    const option = this.#settings.senderId;
    this.#senderId = option ?? info.baseId;
    if (option !== undefined) {
      const offset = idToNumber(option) - idToNumber(info.baseId);
      if (offset < 0 || offset > 0x7f) {
        this.#logger.warn(
          `sender_id ${option} is outside the stick's Base ID range ` +
            `(${info.baseId} + 0…127): the stick may refuse to transmit`,
        );
      }
    }
    this.#logger.info(`Sender ID ${this.#senderId}`);
    this.#publishBridgeState();
    if (this.#settings.syncClock) void this.#sendClock('connection');
    // Ask for a full status now rather than waiting up to 10 min for the next periodic one:
    // discovery needs CMD 4 to 7 before it can list the unit's entities.
    if (this.#refreshOnConnect) {
      this.#enqueue(() =>
        this.#sendSettings({ settings: { oneShot: 'refresh' }, functionChange: {} }),
      );
    }
  }

  #raiseIncident(reason: string, detail: string): void {
    this.#logger.warn(`Stick problem (${reason}): ${detail}`);
    this.#incidents.raise(reason);
  }

  #onTelegram(telegram: Erp1Telegram): void {
    const senderId = this.#senderId;
    if (senderId === undefined || this.#stopped) return;
    const now = this.#timers.now();
    const unitId = this.#settings.vmiId;
    if (telegram.senderId === unitId && telegram.destinationId === senderId) {
      this.#lastAddressedToUsAt = now;
    }
    const classified = classifyTelegram(telegram, {
      unitId,
      assistantId: this.#assistantId,
      receiverIds: [senderId],
    });
    switch (classified.kind) {
      case 'unit_status':
        this.#onUnitStatus(classified.status, telegram, now);
        return;
      case 'assistant':
        this.#onAssistant(classified.frame, telegram, now);
        return;
      case 'teach_in_query':
        this.#unitAvailability.seen();
        void this.#onTeachIn(telegram, now);
        return;
      case 'unit_to_assistant':
      case 'unit_to_other':
        this.#logger.debug(
          `Unit frame CMD ${classified.command} to ${telegram.destinationId ?? '?'} not decoded`,
        );
        this.#unitAvailability.seen();
        return;
      case 'ignored':
        this.#logger.debug(`Ignored telegram from ${telegram.senderId}: ${classified.reason}`);
        return;
    }
  }

  #onUnitStatus(status: UnitStatusFrame, telegram: Erp1Telegram, now: number): void {
    this.#logger.debug(`Unit status CMD ${status.command} (${telegram.dbm ?? '?'} dBm)`);
    if (status.command === 3 && status.machineId !== undefined) {
      const check = this.#machineId.check(status.machineId);
      if (check.result === 'mismatch') {
        this.#raiseIncident(
          'machine_id_mismatch',
          `status frame with machine ID ${check.machineId} instead of ${check.expected}: ` +
            'another program may be reading the stick; frame ignored',
        );
        return;
      }
    }
    this.#unitAvailability.seen();
    this.#unit.apply(status, now, telegram.dbm);
    this.#unitHeard = true;
    if (status.command === 8) {
      const assistant = this.#unit.pairedAssistantId();
      if (assistant !== undefined) this.#learnAssistant(assistant, 'paired_list');
    }
    this.#publishUnitDiscovery(false);
    this.#publishUnitState();
    if (status.command === 0 && this.#pending !== undefined) {
      const { order, timer } = this.#pending;
      this.#timers.clearTimeout(timer);
      this.#pending = undefined;
      this.#logger.info('Function byte received: sending the waiting order');
      this.#enqueue(() => this.#sendSettings(order));
    }
  }

  #onAssistant(frame: AssistantFrame, telegram: Erp1Telegram, now: number): void {
    if (this.#assistantId === undefined) this.#learnAssistant(telegram.senderId, 'frame');
    if (telegram.senderId !== this.#assistantId) return;
    this.#logger.debug(`Assistant CMD ${frame.command} (${telegram.dbm ?? '?'} dBm)`);
    this.#assistantAvailability?.seen();
    this.#assistant.apply(frame, now, telegram.dbm);
    this.#publishAssistantState();
  }

  #learnAssistant(id: EnOceanId, source: 'paired_list' | 'frame'): void {
    if (this.#settings.assistantId !== undefined || id === this.#assistantId) {
      if (id === this.#assistantId && source === 'paired_list') this.#assistantSource = source;
      return;
    }
    // A frame never overrides the unit's own paired list.
    if (source === 'frame' && this.#assistantSource === 'paired_list') return;
    const previous = this.#assistantId;
    this.#logger.info(
      `Assistant ID ${id} learned from ${source === 'frame' ? 'its frames' : "the unit's paired sensors"}` +
        (previous === undefined ? '' : ` (was ${previous})`),
    );
    if (previous !== undefined) this.#removeAssistantDevice(previous);
    this.#setAssistant(id, source);
    void this.#store.update({ learnedAssistantId: id });
    const discovery = assistantDiscovery(this.#ctx, id);
    this.#publishJson(discovery.topic, discovery.payload);
  }

  #setAssistant(id: EnOceanId, source: AssistantSource): void {
    this.#assistantAvailability?.stop();
    this.#assistantId = id;
    this.#assistantSource = source;
    this.#assistant = new AssistantModel();
    this.#assistantAvailability = new AvailabilityTracker(
      this.#timers,
      (state) => {
        this.#logger.info(`Assistant ${id} ${state}`);
        this.#publish(this.#topics.availability(id), state);
      },
      this.#timeoutMs,
    );
    if (this.#started) this.#assistantAvailability.start();
  }

  async #onTeachIn(telegram: Erp1Telegram, now: number): Promise<void> {
    const senderId = this.#senderId;
    if (senderId === undefined) return;
    const answer = shouldAnswerTeachIn(
      now,
      { lastAnswerAt: this.#lastAnswerAt, lastAddressedToUsAt: this.#lastAddressedToUsAt },
      { enabled: this.#settings.acceptPairing },
    );
    if (!answer) {
      this.#logger.debug('Teach-in query from the unit not answered (policy)');
      return;
    }
    this.#lastAnswerAt = now;
    this.#logger.info(`Answering the unit's teach-in query as ${senderId}`);
    const result = await this.#link.send(buildTeachInResponse(telegram, senderId));
    if (result.confirmed) this.#logger.info('Teach-in response sent');
    else this.#logger.warn(`Teach-in response not sent: ${result.detail}`);
  }

  // --- Orders -----------------------------------------------------------------------------

  async #execute(order: ParsedOrder): Promise<void> {
    const durations: Partial<{ boostDuration: number; holidayDuration: number }> = {};
    if (order.boostDuration !== undefined) {
      durations.boostDuration = order.boostDuration;
      this.#unit.set('boost_duration', order.boostDuration);
    }
    if (order.holidayDuration !== undefined) {
      durations.holidayDuration = order.holidayDuration;
      this.#unit.set('holiday_duration', order.holidayDuration);
    }
    if (Object.keys(durations).length > 0) {
      await this.#store.update(durations);
      this.#publishUnitState();
    }

    const { boostDuration, holidayDuration } = this.#store.state;
    const settings = defined<SettingsOrder>({
      mode: order.mode,
      holidayDays: durationValue(order.holiday, holidayDuration),
      boostMinutes: durationValue(order.boost, boostDuration),
      preheatSetpoint: order.preheatSetpoint,
      maxSupplyTemperature: order.maxSupplyTemperature,
      hydroRSetpoint: order.hydroRSetpoint,
      solarRSetpoint: order.solarRSetpoint,
      oneShot: order.oneShot,
    });
    const resolved: ResolvedOrder = { settings, functionChange: order.functionChange };
    if (changesFunctionByte(order) && this.#unit.functionByte === undefined) {
      this.#queue(resolved);
    } else if (Object.keys(settings).length > 0 || changesFunctionByte(order)) {
      await this.#sendSettings(resolved);
    }
    if (order.syncClock) await this.#sendClock('order');
  }

  /** Keeps a function-byte order until the first `CMD 0` and asks the unit for its status. */
  #queue(order: ResolvedOrder): void {
    const previous = this.#pending;
    if (previous !== undefined) this.#timers.clearTimeout(previous.timer);
    const merged: ResolvedOrder =
      previous === undefined
        ? order
        : {
            settings: mergeSettings(previous.order.settings, order.settings),
            functionChange: { ...previous.order.functionChange, ...order.functionChange },
          };
    const timer = this.#timers.setTimeout(() => {
      this.#pending = undefined;
      this.#logger.warn('No CMD 0 frame received in time: waiting order dropped');
    }, this.#pendingOrderTimeoutMs);
    this.#pending = { order: merged, timer };
    this.#logger.info(
      'Order on the function byte: waiting for the unit status (CMD 0), refresh requested',
    );
    if (previous === undefined) {
      this.#enqueue(() =>
        this.#sendSettings({ settings: { oneShot: 'refresh' }, functionChange: {} }),
      );
    }
  }

  async #sendSettings(order: ResolvedOrder): Promise<void> {
    const senderId = this.#senderId;
    if (senderId === undefined) {
      this.#logger.warn('Order not sent: the stick is not connected');
      return;
    }
    let settings = order.settings;
    if (Object.values(order.functionChange).some((v) => v !== undefined)) {
      const last = this.#unit.functionByte;
      if (last === undefined) {
        this.#queue(order);
        return;
      }
      settings = { ...settings, functionByte: updateFunctionByte(last, order.functionChange) };
    }
    let telegram;
    try {
      telegram = buildSettingsTelegram(settings, senderId);
    } catch (error) {
      this.#logger.warn(`Order not sent: ${errorMessage(error)}`);
      return;
    }
    const result = await this.#link.send(telegram);
    if (!result.confirmed) {
      this.#logger.warn(`Order not sent: ${result.detail}`);
      return;
    }
    this.#logger.info('Order transmitted');
    this.#unit.applyOptimistic(this.#optimistic(order));
    this.#publishUnitState();
  }

  #optimistic(order: ResolvedOrder): OptimisticChange {
    const now = this.#timers.now();
    const { settings: s, functionChange: f } = order;
    const endsAt = (amount: number | undefined, unitMs: number): string | null | undefined =>
      amount === undefined
        ? undefined
        : amount > 0
          ? new Date(now + amount * unitMs).toISOString()
          : null;
    return defined<OptimisticChange>({
      mode: s.mode,
      boost: s.boostMinutes === undefined ? undefined : s.boostMinutes > 0,
      boostEndsAt: endsAt(s.boostMinutes, 60_000),
      holiday: s.holidayDays === undefined ? undefined : s.holidayDays > 0,
      holidayEndsAt: endsAt(s.holidayDays, 24 * HOUR),
      fixedAirflow: f.fixedAirflow,
      overVentilation: f.overVentilation,
      timeSchedule: f.timeSchedule,
      bypassSource: f.bypassSource,
      preheatSetpoint: setpointValue(s.preheatSetpoint),
      maxSupplyTemperature: s.maxSupplyTemperature,
      hydroRSetpoint: setpointValue(s.hydroRSetpoint),
      solarRSetpoint: setpointValue(s.solarRSetpoint),
    });
  }

  #scheduleClockSync(): void {
    if (!this.#settings.syncClock) return;
    this.#clockTimer = this.#timers.setTimeout(() => {
      this.#clockTimer = undefined;
      if (this.#stopped) return;
      void this.#sendClock('hourly');
      this.#scheduleClockSync();
    }, this.#clockSyncIntervalMs);
  }

  async #sendClock(reason: 'connection' | 'hourly' | 'order'): Promise<void> {
    const senderId = this.#senderId;
    if (senderId === undefined || !this.#connected) {
      this.#logger.debug(`Clock not sent (${reason}): the stick is not connected`);
      return;
    }
    const date = new Date(this.#timers.now());
    const result = await this.#link.send(buildClockTelegram(date, senderId));
    if (result.confirmed) this.#logger.debug(`Clock sent (${reason})`);
    else this.#logger.warn(`Clock not sent (${reason}): ${result.detail}`);
  }
}
