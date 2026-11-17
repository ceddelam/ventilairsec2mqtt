/**
 * Supervised connection to the stick (protocol.md § 1): reconnection with backoff, silence
 * detection on TCP, fallback port with periodic probing of the primary port.
 */
import { EventEmitter } from 'node:events';
import type { ChainReassemblerOptions } from './chain.ts';
import { validateBaseId, type BaseIdInfo, type Esp3Event } from './esp3/commands.ts';
import type { Erp1Telegram, TransmitTelegram } from './erp1.ts';
import { normalizeId, type EnOceanId } from './hex.ts';
import { noopLogger, type Logger } from './logger.ts';
import { Stick, StickTimeoutError, type Incident, type SendResult } from './stick.ts';
import { systemTimers, type TimerHandle, type Timers } from './timers.ts';
import type { Transport } from './transport/types.ts';
import { createTransport } from './transport/url.ts';

/** Which configured port is in use. */
export type PortRole = 'primary' | 'fallback';

/** Lifecycle state of a {@link StickConnection}. */
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'waiting' | 'stopped';

/** Payload of the `connected` event. */
export interface ConnectedInfo {
  readonly port: PortRole;
  readonly url: string;
  readonly baseId: EnOceanId;
  readonly remainingWrites: number | undefined;
}

/** Payload of the `disconnected` event. */
export interface DisconnectedInfo {
  readonly port: PortRole;
  readonly url: string;
  /** `closed`, `silence`, `switching` or `stopped`. */
  readonly reason: 'closed' | 'silence' | 'switching' | 'stopped';
  readonly detail: string;
}

/** Payload of the `connectFailed` event. */
export interface ConnectFailedInfo {
  readonly port: PortRole;
  readonly url: string;
  readonly error: string;
  /** Consecutive failures on this port. */
  readonly failures: number;
  /** Delay before the next attempt (ms). */
  readonly retryInMs: number;
}

/** Payload of the `portSwitched` event. */
export interface PortSwitchedInfo {
  readonly from: PortRole;
  readonly to: PortRole;
  readonly reason: 'primary_failures' | 'primary_available';
}

/** Events emitted by a {@link StickConnection}. */
export interface StickConnectionEvents {
  connected: [info: ConnectedInfo];
  disconnected: [info: DisconnectedInfo];
  connectFailed: [info: ConnectFailedInfo];
  portSwitched: [info: PortSwitchedInfo];
  telegram: [telegram: Erp1Telegram];
  event: [event: Esp3Event];
  incident: [incident: Incident];
}

/** Reconnection backoff: `initialDelayMs × factor^n`, capped at `maxDelayMs`. */
export interface BackoffOptions {
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly factor?: number;
}

/** Options of {@link StickConnection}. */
export interface StickConnectionOptions {
  /** Primary connection URL: `socket://host:port` or a serial device path. */
  readonly primary: string;
  /** Optional fallback connection URL. */
  readonly fallback?: string | undefined;
  readonly logger?: Logger;
  readonly timers?: Timers;
  /** RESPONSE timeout (ms). Default 1000. */
  readonly responseTimeoutMs?: number;
  /** Default: 1 s, × 2, up to 60 s. */
  readonly backoff?: BackoffOptions;
  /** On TCP, reconnect after this long without any byte (ms). Default 10 min; 0 disables. */
  readonly silenceTimeoutMs?: number;
  /** Switch to the fallback after this many consecutive failures on the primary. Default 3. */
  readonly failuresBeforeFallback?: number;
  /** While on the fallback, probe the primary this often (ms). Default 5 min. */
  readonly primaryProbeIntervalMs?: number;
  /**
   * Explicit opt-in: write this Base ID when the stick reports another one. Limited operation
   * (about 10 writes per stick lifetime), attempted at most once per connection object.
   */
  readonly forceBaseId?: EnOceanId | undefined;
  /** Chained message reassembly options. */
  readonly chain?: Omit<ChainReassemblerOptions, 'now' | 'onDrop'>;
  /** Creates the transport for a URL. Default {@link createTransport}. */
  readonly transportFactory?: (url: string) => Transport;
}

/**
 * Keeps a {@link Stick} connected. Call {@link start}; listen to `telegram`, `event`,
 * `incident` and the state events; transmit with {@link send}.
 */
export class StickConnection extends EventEmitter<StickConnectionEvents> {
  readonly #primary: string;
  readonly #fallback: string | undefined;
  readonly #logger: Logger;
  readonly #timers: Timers;
  readonly #responseTimeoutMs: number;
  readonly #initialDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #factor: number;
  readonly #silenceTimeoutMs: number;
  readonly #failuresBeforeFallback: number;
  readonly #probeIntervalMs: number;
  readonly #forceBaseId: EnOceanId | undefined;
  readonly #chain: Omit<ChainReassemblerOptions, 'now' | 'onDrop'> | undefined;
  readonly #transportFactory: (url: string) => Transport;

  #state: ConnectionState = 'idle';
  #active: PortRole = 'primary';
  #generation = 0;
  #failures = 0;
  #attempt = 0;
  #stick: Stick | undefined;
  #baseIdInfo: BaseIdInfo | undefined;
  #baseIdWriteAttempted = false;
  #reconnectTimer: TimerHandle | undefined;
  #silenceTimer: TimerHandle | undefined;
  #probeTimer: TimerHandle | undefined;
  #probing = false;

  constructor(options: StickConnectionOptions) {
    super();
    this.#primary = options.primary.trim();
    const fallback = options.fallback?.trim();
    this.#fallback = fallback === '' ? undefined : fallback;
    this.#logger = options.logger ?? noopLogger;
    this.#timers = options.timers ?? systemTimers;
    this.#responseTimeoutMs = options.responseTimeoutMs ?? 1000;
    this.#initialDelayMs = options.backoff?.initialDelayMs ?? 1000;
    this.#maxDelayMs = options.backoff?.maxDelayMs ?? 60_000;
    this.#factor = options.backoff?.factor ?? 2;
    this.#silenceTimeoutMs = options.silenceTimeoutMs ?? 10 * 60_000;
    this.#failuresBeforeFallback = options.failuresBeforeFallback ?? 3;
    this.#probeIntervalMs = options.primaryProbeIntervalMs ?? 5 * 60_000;
    if (options.forceBaseId !== undefined) {
      const id = normalizeId(options.forceBaseId);
      validateBaseId(id);
      this.#forceBaseId = id;
    }
    this.#chain = options.chain;
    this.#transportFactory = options.transportFactory ?? ((url) => createTransport(url));
  }

  /** Current lifecycle state. */
  get state(): ConnectionState {
    return this.#state;
  }

  /** Port in use (or being tried). */
  get activePort(): PortRole {
    return this.#active;
  }

  /** Base ID of the connected stick, once read. */
  get baseId(): EnOceanId | undefined {
    return this.#baseIdInfo?.baseId;
  }

  /** Starts connecting (no-op when already started). */
  start(): void {
    if (this.#state !== 'idle' && this.#state !== 'stopped') return;
    this.#failures = 0;
    this.#attempt = 0;
    this.#active = 'primary';
    void this.#connect();
  }

  /** Stops everything and closes the link. */
  async stop(): Promise<void> {
    this.#state = 'stopped';
    this.#generation += 1;
    this.#clearTimer('reconnect');
    this.#clearTimer('silence');
    this.#clearTimer('probe');
    await this.#dropLink('stopped', 'Stopped');
  }

  /** Transmits a telegram; `not_connected` when no stick is connected. */
  async send(telegram: TransmitTelegram): Promise<SendResult> {
    const stick = this.#stick;
    if (stick === undefined || this.#state !== 'connected') {
      return {
        confirmed: false,
        reason: 'not_connected',
        returnCode: undefined,
        detail: 'No stick connected',
      };
    }
    return stick.send(telegram);
  }

  #url(role: PortRole): string {
    return role === 'fallback' && this.#fallback !== undefined ? this.#fallback : this.#primary;
  }

  #newStick(url: string): Stick {
    return new Stick(this.#transportFactory(url), {
      logger: this.#logger,
      timers: this.#timers,
      responseTimeoutMs: this.#responseTimeoutMs,
      ...(this.#chain === undefined ? {} : { chain: this.#chain }),
    });
  }

  async #connect(): Promise<void> {
    this.#clearTimer('reconnect');
    this.#generation += 1;
    const generation = this.#generation;
    const port = this.#active;
    const url = this.#url(port);
    this.#state = 'connecting';
    this.#logger.info(`Connecting to the stick on ${url} (${port})`);

    let stick: Stick | undefined;
    let info: BaseIdInfo;
    try {
      stick = this.#newStick(url);
      await stick.open();
      if (generation !== this.#generation) {
        await stick.close();
        return;
      }
      info = await stick.readBaseId();
      info = await this.#maybeWriteBaseId(stick, info);
    } catch (error) {
      await stick?.close().catch(() => undefined);
      if (generation !== this.#generation) return;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof StickTimeoutError) {
        this.emit('incident', { reason: 'no_answer', detail: `${url}: ${message}` });
      }
      this.#onConnectFailure(port, url, message);
      return;
    }
    if (generation !== this.#generation) {
      await stick.close().catch(() => undefined);
      return;
    }

    this.#stick = stick;
    this.#baseIdInfo = info;
    this.#failures = 0;
    this.#attempt = 0;
    this.#state = 'connected';
    stick.on('telegram', (telegram) => this.emit('telegram', telegram));
    stick.on('event', (event) => this.emit('event', event));
    stick.on('incident', (incident) => this.emit('incident', incident));
    const transport = stick.transport;
    const watchSilence = transport.kind === 'tcp' && this.#silenceTimeoutMs > 0;
    transport.on('data', () => {
      if (watchSilence && this.#stick === stick) this.#armSilence(stick);
    });
    transport.on('close', (error) => {
      if (this.#stick !== stick) return;
      void this.#linkLost('closed', error ? error.message : 'Link closed');
    });
    if (watchSilence) this.#armSilence(stick);
    if (port === 'fallback') this.#scheduleProbe();
    this.#logger.info(`Stick connected on ${url}, Base ID ${info.baseId}`);
    this.emit('connected', {
      port,
      url,
      baseId: info.baseId,
      remainingWrites: info.remainingWrites,
    });
  }

  async #maybeWriteBaseId(stick: Stick, info: BaseIdInfo): Promise<BaseIdInfo> {
    const wanted = this.#forceBaseId;
    if (wanted === undefined || info.baseId === wanted || this.#baseIdWriteAttempted) return info;
    this.#baseIdWriteAttempted = true;
    if (info.remainingWrites === 0) {
      this.#logger.error(`Cannot write Base ID ${wanted}: the stick has no writes left`);
      return info;
    }
    this.#logger.warn(
      `Base ID ${info.baseId} differs from the requested ${wanted}: writing it ` +
        `(${info.remainingWrites === undefined ? 'unknown number of' : String(info.remainingWrites)} writes left)`,
    );
    try {
      await stick.writeBaseId(wanted);
    } catch (error) {
      if (error instanceof StickTimeoutError) throw error;
      this.#logger.error(
        `Base ID write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return info;
    }
    return stick.readBaseId();
  }

  #onConnectFailure(port: PortRole, url: string, error: string): void {
    this.#failures += 1;
    const switchToFallback =
      port === 'primary' &&
      this.#fallback !== undefined &&
      this.#failures >= this.#failuresBeforeFallback;
    const retryInMs = switchToFallback ? 0 : this.#nextDelay();
    this.#logger.warn(`Stick connection failed on ${url}: ${error}`);
    this.emit('connectFailed', { port, url, error, failures: this.#failures, retryInMs });
    if (switchToFallback) {
      this.#switchTo('fallback', 'primary_failures');
      this.#scheduleProbe();
    }
    this.#scheduleReconnect(retryInMs);
  }

  #nextDelay(): number {
    const delay = Math.min(this.#initialDelayMs * this.#factor ** this.#attempt, this.#maxDelayMs);
    this.#attempt += 1;
    return delay;
  }

  #switchTo(to: PortRole, reason: PortSwitchedInfo['reason']): void {
    const from = this.#active;
    this.#active = to;
    this.#failures = 0;
    this.#attempt = 0;
    this.#logger.warn(`Switching from the ${from} port to the ${to} port (${reason})`);
    this.emit('portSwitched', { from, to, reason });
  }

  #scheduleReconnect(delayMs: number): void {
    if (this.#state === 'stopped') return;
    this.#state = 'waiting';
    this.#clearTimer('reconnect');
    this.#reconnectTimer = this.#timers.setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connect();
    }, delayMs);
  }

  async #linkLost(reason: 'closed' | 'silence', detail: string): Promise<void> {
    await this.#dropLink(reason, detail);
    this.#scheduleReconnect(this.#nextDelay());
  }

  /** Closes the current link, if any, and emits `disconnected`. */
  async #dropLink(reason: DisconnectedInfo['reason'], detail: string): Promise<void> {
    this.#clearTimer('silence');
    const stick = this.#stick;
    if (stick === undefined) return;
    this.#stick = undefined;
    this.#baseIdInfo = undefined;
    stick.removeAllListeners();
    stick.transport.removeAllListeners();
    const port = this.#active;
    const url = stick.transport.description;
    this.#logger.warn(`Stick disconnected from ${url}: ${detail}`);
    this.emit('disconnected', { port, url, reason, detail });
    await stick.close().catch(() => undefined);
  }

  #armSilence(stick: Stick): void {
    this.#clearTimer('silence');
    this.#silenceTimer = this.#timers.setTimeout(() => {
      this.#silenceTimer = undefined;
      if (this.#stick !== stick) return;
      void this.#linkLost('silence', `No data for ${this.#silenceTimeoutMs} ms`);
    }, this.#silenceTimeoutMs);
  }

  #scheduleProbe(): void {
    this.#clearTimer('probe');
    if (this.#fallback === undefined || this.#active !== 'fallback' || this.#state === 'stopped') {
      return;
    }
    this.#probeTimer = this.#timers.setTimeout(() => {
      this.#probeTimer = undefined;
      void this.#probePrimary();
    }, this.#probeIntervalMs);
  }

  async #probePrimary(): Promise<void> {
    if (this.#probing || this.#active !== 'fallback' || this.#state === 'stopped') return;
    this.#probing = true;
    let answered = false;
    const stick = this.#newStick(this.#primary);
    try {
      await stick.open();
      await stick.readBaseId();
      answered = true;
    } catch (error) {
      this.#logger.debug(
        `Primary port probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await stick.close().catch(() => undefined);
      this.#probing = false;
    }
    // State may have changed while probing.
    if (!this.#runningOnFallback()) return;
    if (!answered) {
      this.#scheduleProbe();
      return;
    }
    this.#generation += 1; // cancels a connection attempt in progress on the fallback
    this.#clearTimer('reconnect');
    await this.#dropLink('switching', 'Primary port available again');
    if (!this.#runningOnFallback()) return;
    this.#switchTo('primary', 'primary_available');
    await this.#connect();
  }

  #runningOnFallback(): boolean {
    return this.#state !== 'stopped' && this.#active === 'fallback';
  }

  #clearTimer(which: 'reconnect' | 'silence' | 'probe'): void {
    const handle =
      which === 'reconnect'
        ? this.#reconnectTimer
        : which === 'silence'
          ? this.#silenceTimer
          : this.#probeTimer;
    if (handle !== undefined) this.#timers.clearTimeout(handle);
    if (which === 'reconnect') this.#reconnectTimer = undefined;
    else if (which === 'silence') this.#silenceTimer = undefined;
    else this.#probeTimer = undefined;
  }
}
