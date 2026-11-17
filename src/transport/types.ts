import type { EventEmitter } from 'node:events';

/** Events emitted by a {@link Transport}. */
export interface TransportEvents {
  /** Bytes received from the stick. */
  data: [chunk: Uint8Array];
  /** The link closed after a successful `open()` (error when it was not a clean close). */
  close: [error: Error | undefined];
}

/** Kind of link to the stick. */
export type TransportKind = 'tcp' | 'serial';

/**
 * A byte stream to the stick: serial port or TCP bridge. Implementations emit `data` and
 * `close`; `close` is emitted at most once per successful `open()`.
 */
export interface Transport extends EventEmitter<TransportEvents> {
  readonly kind: TransportKind;
  /** Human-readable target, e.g. `socket://host:3333` or `/dev/ttyUSB0`. */
  readonly description: string;
  readonly isOpen: boolean;
  open(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
