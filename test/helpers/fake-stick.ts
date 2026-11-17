/**
 * Stick emulators for tests: an in-memory transport and a TCP server (ser2net-like), both
 * answering like a TCM310 to the few commands the bridge sends.
 */
import { EventEmitter, once } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { CommonCommand } from '../../src/esp3/commands.ts';
import { Esp3Decoder, encodePacket, PacketType, type Esp3Packet } from '../../src/esp3/packet.ts';
import { erp1Data } from '../../src/erp1.ts';
import { idToBytes } from '../../src/hex.ts';
import type { Transport, TransportEvents, TransportKind } from '../../src/transport/types.ts';

/** Builds a RESPONSE packet. */
export function response(
  returnCode: number,
  data: number[] = [],
  optional: number[] = [],
): Esp3Packet {
  return {
    type: PacketType.RESPONSE,
    data: Uint8Array.of(returnCode, ...data),
    optional: Uint8Array.from(optional),
  };
}

/** Builds a received RADIO_ERP1 packet (optional: 1 sub-telegram, destination, level, 0). */
export function receivedRadio(options: {
  rorg: number;
  payload: Uint8Array | number[];
  senderId: string;
  status?: number;
  destinationId?: string;
  dbm?: number;
}): Esp3Packet {
  const optional = new Uint8Array(7);
  optional[0] = 1;
  optional.set(idToBytes(options.destinationId ?? 'FFFFFFFF'), 1);
  optional[5] = -(options.dbm ?? -67);
  optional[6] = 0;
  return {
    type: PacketType.RADIO_ERP1,
    data: erp1Data({
      rorg: options.rorg,
      payload: Uint8Array.from(options.payload),
      senderId: options.senderId,
      status: options.status ?? 0,
    }),
    optional,
  };
}

/** Behaviour of the emulated stick. */
export class StickEmulator {
  baseId = 'FFAA0000';
  remainingWrites: number | undefined = 10;
  /** Ignore every command. */
  silent = false;
  /** Ignore the next N commands. */
  swallow = 0;
  /** Return code for radio transmissions. */
  radioReturnCode = 0;
  /** Every packet received, in order. */
  readonly received: Esp3Packet[] = [];

  /** Returns the packets to send back for `packet`. */
  handle(packet: Esp3Packet): Esp3Packet[] {
    this.received.push(packet);
    if (this.silent) return [];
    if (this.swallow > 0) {
      this.swallow -= 1;
      return [];
    }
    if (packet.type === PacketType.COMMON_COMMAND) {
      switch (packet.data[0]) {
        case CommonCommand.CO_RD_IDBASE:
          return [
            response(
              0,
              [...idToBytes(this.baseId)],
              this.remainingWrites === undefined ? [] : [this.remainingWrites],
            ),
          ];
        case CommonCommand.CO_WR_IDBASE:
          this.baseId = Array.from(packet.data.subarray(1, 5), (b) =>
            b.toString(16).toUpperCase().padStart(2, '0'),
          ).join('');
          if (this.remainingWrites !== undefined) this.remainingWrites -= 1;
          return [response(0)];
        case CommonCommand.CO_WR_RESET:
          return [response(0)];
        default:
          return [response(2)]; // NOT_SUPPORTED
      }
    }
    if (packet.type === PacketType.RADIO_ERP1) return [response(this.radioReturnCode)];
    return [];
  }

  /** Common commands received (first data byte). */
  commands(): number[] {
    return this.received
      .filter((p) => p.type === PacketType.COMMON_COMMAND)
      .map((p) => p.data[0] ?? -1);
  }

  /** Radio packets received. */
  radio(): Esp3Packet[] {
    return this.received.filter((p) => p.type === PacketType.RADIO_ERP1);
  }
}

/** In-memory {@link Transport} wired to a {@link StickEmulator}. */
export class FakeTransport extends EventEmitter<TransportEvents> implements Transport {
  readonly kind: TransportKind;
  readonly description: string;
  readonly emulator: StickEmulator;
  /** When true, `open()` rejects. */
  failOpen = false;
  opens = 0;
  #open = false;
  readonly #decoder = new Esp3Decoder();

  constructor(emulator: StickEmulator, description = 'fake', kind: TransportKind = 'tcp') {
    super();
    this.emulator = emulator;
    this.description = description;
    this.kind = kind;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  open(): Promise<void> {
    this.opens += 1;
    if (this.failOpen) return Promise.reject(new Error(`cannot open ${this.description}`));
    this.#open = true;
    return Promise.resolve();
  }

  write(bytes: Uint8Array): Promise<void> {
    if (!this.#open) return Promise.reject(new Error('not open'));
    for (const packet of this.#decoder.push(bytes)) {
      for (const answer of this.emulator.handle(packet)) {
        setImmediate(() => {
          if (this.#open) this.emit('data', encodePacket(answer));
        });
      }
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.#open) {
      this.#open = false;
      this.emit('close', undefined);
    }
    return Promise.resolve();
  }

  /** Sends bytes as if received from the stick. */
  inject(bytes: Uint8Array): void {
    this.emit('data', bytes);
  }

  /** Simulates a link loss. */
  drop(error = new Error('link lost')): void {
    if (!this.#open) return;
    this.#open = false;
    this.emit('close', error);
  }
}

/** A TCP server emulating a stick behind ser2net. */
export class FakeStickServer {
  readonly emulator = new StickEmulator();
  readonly server: Server;
  readonly sockets = new Set<Socket>();
  connections = 0;

  constructor() {
    this.server = createServer((socket) => {
      this.connections += 1;
      this.sockets.add(socket);
      const decoder = new Esp3Decoder();
      socket.on('data', (chunk) => {
        for (const packet of decoder.push(chunk)) {
          for (const answer of this.emulator.handle(packet)) socket.write(encodePacket(answer));
        }
      });
      socket.on('error', () => undefined);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  /** Listens on `port` (0 = any free port) and returns the port. */
  async listen(port = 0): Promise<number> {
    this.server.listen(port, '127.0.0.1');
    await once(this.server, 'listening');
    return (this.server.address() as AddressInfo).port;
  }

  get url(): string {
    return `socket://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** Sends bytes to every connected client. */
  inject(bytes: Uint8Array): void {
    for (const socket of this.sockets) socket.write(bytes);
  }

  /** Cuts every connection. */
  dropAll(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}

/** Waits for an event, failing after `timeoutMs`. */
export async function waitFor<T extends unknown[]>(
  emitter: EventEmitter,
  event: string,
  timeoutMs = 2000,
): Promise<T> {
  return (await once(emitter, event, { signal: AbortSignal.timeout(timeoutMs) })) as T;
}

/** Polls `condition` until true, failing after `timeoutMs`. */
export async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
