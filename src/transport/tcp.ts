/**
 * TCP transport (ser2net-like bridge): the stick's byte stream over a plain TCP socket.
 */
import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import type { Transport, TransportEvents } from './types.ts';

/** Options of {@link TcpTransport}. */
export interface TcpTransportOptions {
  /** Give up connecting after this delay (ms). Default 10 s. */
  readonly connectTimeoutMs?: number;
  /** TCP keep-alive initial delay (ms), 0 to disable. Default 30 s. */
  readonly keepAliveMs?: number;
}

/** A {@link Transport} over TCP. */
export class TcpTransport extends EventEmitter<TransportEvents> implements Transport {
  readonly kind = 'tcp' as const;
  readonly description: string;
  readonly host: string;
  readonly port: number;
  readonly #connectTimeoutMs: number;
  readonly #keepAliveMs: number;
  #socket: Socket | undefined;

  constructor(host: string, port: number, options: TcpTransportOptions = {}) {
    super();
    this.host = host;
    this.port = port;
    this.description = `socket://${host.includes(':') ? `[${host}]` : host}:${port}`;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.#keepAliveMs = options.keepAliveMs ?? 30_000;
  }

  get isOpen(): boolean {
    return this.#socket !== undefined;
  }

  open(): Promise<void> {
    if (this.#socket !== undefined) return Promise.reject(new Error('Transport already open'));
    return new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection to ${this.description} timed out`));
      }, this.#connectTimeoutMs);
      const onError = (error: Error): void => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', onError);
        socket.setNoDelay(true);
        if (this.#keepAliveMs > 0) socket.setKeepAlive(true, this.#keepAliveMs);
        this.#attach(socket);
        resolve();
      });
    });
  }

  #attach(socket: Socket): void {
    this.#socket = socket;
    let lastError: Error | undefined;
    socket.on('data', (chunk: Buffer) => {
      this.emit('data', chunk);
    });
    socket.on('error', (error: Error) => {
      lastError = error;
    });
    socket.on('end', () => {
      lastError ??= new Error('Connection closed by the remote end');
      socket.destroy();
    });
    socket.once('close', () => {
      this.#socket = undefined;
      this.emit('close', lastError);
    });
  }

  write(bytes: Uint8Array): Promise<void> {
    const socket = this.#socket;
    if (socket === undefined) return Promise.reject(new Error('Transport not open'));
    return new Promise<void>((resolve, reject) => {
      socket.write(bytes, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  close(): Promise<void> {
    const socket = this.#socket;
    if (socket === undefined) return Promise.resolve();
    return new Promise<void>((resolve) => {
      socket.once('close', () => {
        resolve();
      });
      socket.destroy();
    });
  }
}
