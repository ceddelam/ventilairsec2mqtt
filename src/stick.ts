/**
 * ESP3 session with an EnOcean stick over one {@link Transport}: request/response for common
 * commands and radio transmissions, reception of telegrams (chained messages reassembled) and
 * EVENT packets.
 */
import { EventEmitter } from 'node:events';
import { ChainReassembler, type ChainReassemblerOptions } from './chain.ts';
import {
  buildReadIdBase,
  buildReset,
  buildWriteIdBase,
  parseBaseIdResponse,
  parseEvent,
  parseResponse,
  returnCodeName,
  ReturnCode,
  type BaseIdInfo,
  type Esp3Event,
  type Esp3Response,
} from './esp3/commands.ts';
import { Esp3Decoder, encodePacket, PacketType, type Esp3Packet } from './esp3/packet.ts';
import {
  buildErp1Packet,
  parseErp1Packet,
  Rorg,
  type Erp1Telegram,
  type TransmitTelegram,
} from './erp1.ts';
import { normalizeId, toHex, type EnOceanId } from './hex.ts';
import { noopLogger, type Logger } from './logger.ts';
import { systemTimers, type TimerHandle, type Timers } from './timers.ts';
import type { Transport } from './transport/types.ts';

/** Why an incident was raised. */
export type IncidentReason = 'transmission_not_confirmed' | 'no_answer' | 'machine_id_mismatch';

/** Something phase 2 should surface (e.g. as a "stick problem"). */
export interface Incident {
  readonly reason: IncidentReason;
  readonly detail: string;
}

/** Result of {@link Stick.send}. */
export type SendResult =
  | { readonly confirmed: true; readonly returnCode: number }
  | {
      readonly confirmed: false;
      /** `rejected`: the stick answered with an error code; `no_answer`: it did not answer. */
      readonly reason: 'rejected' | 'no_answer' | 'not_connected';
      readonly returnCode: number | undefined;
      readonly detail: string;
    };

/** Events emitted by a {@link Stick}. */
export interface StickEvents {
  /** A complete telegram (chained messages already reassembled). */
  telegram: [telegram: Erp1Telegram];
  /** An EVENT packet from the stick. */
  event: [event: Esp3Event];
  /** A transmission not confirmed or a command without answer. */
  incident: [incident: Incident];
}

/** Options of {@link Stick}. */
export interface StickOptions {
  readonly logger?: Logger;
  readonly timers?: Timers;
  /** How long to wait for a RESPONSE (ms). Default 1000. */
  readonly responseTimeoutMs?: number;
  /** Chained message reassembly options (the clock comes from `timers`). */
  readonly chain?: Omit<ChainReassemblerOptions, 'now' | 'onDrop'>;
}

/** The stick did not answer a command in time. */
export class StickTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StickTimeoutError';
  }
}

/** The transport closed while a command was waiting. */
export class StickClosedError extends Error {
  constructor(message = 'Stick connection closed') {
    super(message);
    this.name = 'StickClosedError';
  }
}

interface PendingRequest {
  readonly label: string;
  readonly bytes: Uint8Array;
  readonly resolve: (response: Esp3Response) => void;
  readonly reject: (error: Error) => void;
  retriesLeft: number;
  timer: TimerHandle | undefined;
}

/**
 * One ESP3 session over a transport. Commands are serialised: one outstanding request at a
 * time, the others wait in a queue. The first command after `open()` is sent again once if it
 * gets no answer (ser2net may swallow it).
 */
export class Stick extends EventEmitter<StickEvents> {
  readonly transport: Transport;
  readonly #logger: Logger;
  readonly #timers: Timers;
  readonly #timeoutMs: number;
  readonly #decoder: Esp3Decoder;
  readonly #reassembler: ChainReassembler;
  readonly #queue: PendingRequest[] = [];
  #current: PendingRequest | undefined;
  #open = false;
  #retryNextCommand = true;
  readonly #onData = (chunk: Uint8Array): void => {
    this.#receive(chunk);
  };
  readonly #onClose = (error: Error | undefined): void => {
    this.#open = false;
    this.#failAll(new StickClosedError(error ? `Link closed: ${error.message}` : 'Link closed'));
  };

  constructor(transport: Transport, options: StickOptions = {}) {
    super();
    this.transport = transport;
    this.#logger = options.logger ?? noopLogger;
    this.#timers = options.timers ?? systemTimers;
    this.#timeoutMs = options.responseTimeoutMs ?? 1000;
    this.#decoder = new Esp3Decoder({
      onDiscard: (reason, bytes) => {
        this.#logger.debug(`RX discarded (${reason}): ${toHex(bytes)}`);
      },
    });
    this.#reassembler = new ChainReassembler({
      ...options.chain,
      now: () => this.#timers.now(),
      onDrop: (reason, detail) => {
        this.#logger.debug(`Chained piece dropped (${reason}): ${detail}`);
      },
    });
  }

  /** True between a successful `open()` and the link closing. */
  get isOpen(): boolean {
    return this.#open;
  }

  /** Opens the transport and starts listening. */
  async open(): Promise<void> {
    this.transport.on('data', this.#onData);
    this.transport.on('close', this.#onClose);
    try {
      await this.transport.open();
    } catch (error) {
      this.#detach();
      throw error;
    }
    this.#open = true;
    this.#retryNextCommand = true;
    this.#decoder.reset();
    this.#reassembler.clear();
  }

  /** Closes the transport; waiting commands fail with {@link StickClosedError}. */
  async close(): Promise<void> {
    this.#open = false;
    this.#detach();
    this.#failAll(new StickClosedError());
    await this.transport.close();
  }

  /**
   * Sends a packet and waits for the RESPONSE. Rejects with {@link StickTimeoutError} when the
   * stick does not answer, {@link StickClosedError} when the link closes.
   */
  request(packet: Esp3Packet, label = `type ${packet.type}`): Promise<Esp3Response> {
    if (!this.#open) return Promise.reject(new StickClosedError('Stick not open'));
    return new Promise<Esp3Response>((resolve, reject) => {
      const retriesLeft = this.#retryNextCommand ? 1 : 0;
      this.#retryNextCommand = false;
      this.#queue.push({
        label,
        bytes: encodePacket(packet),
        resolve,
        reject,
        retriesLeft,
        timer: undefined,
      });
      this.#pump();
    });
  }

  /** Reads the stick's Base ID (`CO_RD_IDBASE`). */
  async readBaseId(): Promise<BaseIdInfo> {
    const response = await this.request(buildReadIdBase(), 'CO_RD_IDBASE');
    return parseBaseIdResponse(response);
  }

  /**
   * Writes the Base ID (`CO_WR_IDBASE`) then resets the stick (`CO_WR_RESET`). The stick only
   * accepts a few writes over its lifetime: call on explicit request only. Throws on a
   * rejected write.
   */
  async writeBaseId(id: EnOceanId): Promise<void> {
    const baseId = normalizeId(id);
    const packet = buildWriteIdBase(baseId);
    this.#logger.warn(`Writing Base ID ${baseId} to the stick (limited number of writes)`);
    const response = await this.request(packet, 'CO_WR_IDBASE');
    if (response.returnCode !== ReturnCode.OK) {
      throw new Error(`CO_WR_IDBASE failed: ${returnCodeName(response.returnCode)}`);
    }
    try {
      await this.request(buildReset(), 'CO_WR_RESET');
    } catch (error) {
      // The stick may restart before answering.
      this.#logger.warn(`No answer to CO_WR_RESET: ${String(error)}`);
    }
    this.#retryNextCommand = true;
  }

  /**
   * Transmits a radio telegram and reports whether the stick confirmed it (RESPONSE `OK`).
   * Never throws for a missing confirmation: an `incident` is emitted instead.
   */
  async send(telegram: TransmitTelegram): Promise<SendResult> {
    if (!this.#open) {
      return {
        confirmed: false,
        reason: 'not_connected',
        returnCode: undefined,
        detail: 'Stick not open',
      };
    }
    let response: Esp3Response;
    try {
      response = await this.request(buildErp1Packet(telegram), 'RADIO_ERP1');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof StickClosedError) {
        return { confirmed: false, reason: 'not_connected', returnCode: undefined, detail };
      }
      this.emit('incident', {
        reason: 'no_answer',
        detail: `Transmission not answered: ${detail}`,
      });
      return { confirmed: false, reason: 'no_answer', returnCode: undefined, detail };
    }
    if (response.returnCode === ReturnCode.OK) {
      return { confirmed: true, returnCode: response.returnCode };
    }
    const detail = `Transmission rejected: ${returnCodeName(response.returnCode)}`;
    this.emit('incident', { reason: 'transmission_not_confirmed', detail });
    return { confirmed: false, reason: 'rejected', returnCode: response.returnCode, detail };
  }

  #detach(): void {
    this.transport.off('data', this.#onData);
    this.transport.off('close', this.#onClose);
  }

  #pump(): void {
    if (this.#current !== undefined || !this.#open) return;
    const next = this.#queue.shift();
    if (next === undefined) return;
    this.#current = next;
    this.#transmit(next);
  }

  #transmit(request: PendingRequest): void {
    request.timer = this.#timers.setTimeout(() => {
      this.#onTimeout(request);
    }, this.#timeoutMs);
    this.#logger.debug(`TX ${toHex(request.bytes)} (${request.label})`);
    this.transport.write(request.bytes).catch((error: unknown) => {
      if (this.#current !== request) return;
      this.#settle(request, error instanceof Error ? error : new Error(String(error)));
    });
  }

  #onTimeout(request: PendingRequest): void {
    if (this.#current !== request) return;
    if (request.retriesLeft > 0) {
      request.retriesLeft -= 1;
      this.#logger.debug(`No answer to ${request.label}, sending it again`);
      this.#transmit(request);
      return;
    }
    this.#settle(request, new StickTimeoutError(`No answer to ${request.label}`));
  }

  #settle(request: PendingRequest, outcome: Esp3Response | Error): void {
    if (request.timer !== undefined) this.#timers.clearTimeout(request.timer);
    request.timer = undefined;
    if (this.#current === request) this.#current = undefined;
    if (outcome instanceof Error) request.reject(outcome);
    else request.resolve(outcome);
    this.#pump();
  }

  #failAll(error: Error): void {
    const pending =
      this.#current === undefined ? [...this.#queue] : [this.#current, ...this.#queue];
    this.#queue.length = 0;
    this.#current = undefined;
    for (const request of pending) {
      if (request.timer !== undefined) this.#timers.clearTimeout(request.timer);
      request.reject(error);
    }
  }

  #receive(chunk: Uint8Array): void {
    for (const packet of this.#decoder.push(chunk)) {
      this.#logger.debug(`RX ${toHex(encodePacket(packet))}`);
      try {
        this.#handle(packet);
      } catch (error) {
        this.#logger.debug(
          `Ignored packet: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  #handle(packet: Esp3Packet): void {
    switch (packet.type) {
      case PacketType.RESPONSE: {
        const response = parseResponse(packet);
        const current = this.#current;
        if (current === undefined) {
          this.#logger.debug(`Unexpected RESPONSE ${returnCodeName(response.returnCode)}`);
          return;
        }
        this.#settle(current, response);
        return;
      }
      case PacketType.RADIO_ERP1: {
        const telegram = parseErp1Packet(packet);
        if (telegram.rorg === Rorg.CHAINED) {
          const message = this.#reassembler.push(telegram);
          if (message !== undefined) this.emit('telegram', message);
          return;
        }
        this.emit('telegram', telegram);
        return;
      }
      case PacketType.EVENT: {
        const event = parseEvent(packet);
        this.#logger.info(`Stick event ${event.name}`);
        this.emit('event', event);
        return;
      }
      default:
        this.#logger.debug(`Ignored packet type ${packet.type}`);
    }
  }
}
