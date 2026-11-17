/**
 * Serial transport for a local USB stick: 57,600 baud, 8N1, no flow control
 * (protocol.md § 1).
 */
import { EventEmitter } from 'node:events';
import type { Transport, TransportEvents } from './types.ts';

/** ESP3 line speed. */
export const ESP3_BAUD_RATE = 57_600;

/** Options passed to a {@link SerialPortFactory}. */
export interface SerialPortOptions {
  readonly path: string;
  readonly baudRate: number;
  readonly dataBits: 8;
  readonly parity: 'none';
  readonly stopBits: 1;
  readonly rtscts: false;
  readonly autoOpen: false;
}

/** The subset of the `serialport` stream API this transport uses. */
export interface SerialPortLike {
  readonly isOpen: boolean;
  open(callback: (error: Error | null) => void): void;
  close(callback: (error: Error | null) => void): void;
  write(data: Uint8Array, callback: (error: Error | null | undefined) => void): boolean;
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (error?: Error | null) => void): this;
  removeAllListeners(): this;
}

/** Creates the serial port object. Injectable for tests (e.g. with `SerialPortMock`). */
export type SerialPortFactory = (
  options: SerialPortOptions,
) => SerialPortLike | Promise<SerialPortLike>;

/** Default factory: the `serialport` package, loaded on first use. */
export const defaultSerialPortFactory: SerialPortFactory = async (options) => {
  const { SerialPort } = await import('serialport');
  return new SerialPort({ ...options });
};

/** Options of {@link SerialTransport}. */
export interface SerialTransportOptions {
  readonly baudRate?: number;
  readonly portFactory?: SerialPortFactory;
}

/** A {@link Transport} over a serial port. */
export class SerialTransport extends EventEmitter<TransportEvents> implements Transport {
  readonly kind = 'serial' as const;
  readonly description: string;
  readonly path: string;
  readonly #baudRate: number;
  readonly #factory: SerialPortFactory;
  #port: SerialPortLike | undefined;

  constructor(path: string, options: SerialTransportOptions = {}) {
    super();
    this.path = path;
    this.description = path;
    this.#baudRate = options.baudRate ?? ESP3_BAUD_RATE;
    this.#factory = options.portFactory ?? defaultSerialPortFactory;
  }

  get isOpen(): boolean {
    return this.#port !== undefined;
  }

  async open(): Promise<void> {
    if (this.#port !== undefined) throw new Error('Transport already open');
    const port = await this.#factory({
      path: this.path,
      baudRate: this.#baudRate,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      rtscts: false,
      autoOpen: false,
    });
    await new Promise<void>((resolve, reject) => {
      port.open((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    this.#port = port;
    let lastError: Error | undefined;
    port.on('data', (chunk) => {
      this.emit('data', chunk);
    });
    port.on('error', (error) => {
      lastError = error;
    });
    port.on('close', (error) => {
      if (this.#port !== port) return;
      this.#port = undefined;
      port.removeAllListeners();
      this.emit('close', error ?? lastError);
    });
  }

  write(bytes: Uint8Array): Promise<void> {
    const port = this.#port;
    if (port === undefined) return Promise.reject(new Error('Transport not open'));
    return new Promise<void>((resolve, reject) => {
      port.write(bytes, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    const port = this.#port;
    if (port === undefined) return;
    this.#port = undefined;
    port.removeAllListeners();
    await new Promise<void>((resolve) => {
      if (!port.isOpen) {
        resolve();
        return;
      }
      port.close(() => {
        resolve();
      });
    });
    this.emit('close', undefined);
  }
}
