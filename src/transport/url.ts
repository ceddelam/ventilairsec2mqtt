/**
 * Connection URL parsing: `socket://host:port` → TCP, anything else → serial device path.
 */
import { SerialTransport, ESP3_BAUD_RATE, type SerialTransportOptions } from './serial.ts';
import { TcpTransport, type TcpTransportOptions } from './tcp.ts';
import type { Transport } from './types.ts';

/** Where the stick is. */
export type ConnectionTarget =
  | { readonly kind: 'tcp'; readonly host: string; readonly port: number }
  | { readonly kind: 'serial'; readonly path: string; readonly baudRate: number };

const SOCKET_URL = /^socket:\/\/(\[[^\]]+\]|[^:/[\]]+):(\d+)\/?$/i;

/**
 * Parses a connection URL. `socket://host:port` (IPv6 hosts in brackets) gives a TCP target;
 * anything else is a serial device path at 57,600 baud. Surrounding spaces are ignored.
 * Throws on an empty string or an invalid `socket://` URL.
 */
export function parseConnectionUrl(url: string): ConnectionTarget {
  const value = url.trim();
  if (value === '') throw new Error('Empty connection URL');
  if (/^socket:/i.test(value)) {
    const match = SOCKET_URL.exec(value);
    const host = match?.[1];
    const portText = match?.[2];
    if (host === undefined || portText === undefined) {
      throw new Error(`Invalid socket URL "${value}" (expected socket://host:port)`);
    }
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid TCP port in "${value}"`);
    }
    return { kind: 'tcp', host: host.replace(/^\[|\]$/g, ''), port };
  }
  return { kind: 'serial', path: value, baudRate: ESP3_BAUD_RATE };
}

/** Options for {@link createTransport}. */
export interface CreateTransportOptions {
  readonly tcp?: TcpTransportOptions;
  readonly serial?: SerialTransportOptions;
}

/** Creates the transport for a connection URL (not opened yet). */
export function createTransport(url: string, options: CreateTransportOptions = {}): Transport {
  const target = parseConnectionUrl(url);
  if (target.kind === 'tcp') return new TcpTransport(target.host, target.port, options.tcp);
  return new SerialTransport(target.path, { baudRate: target.baudRate, ...options.serial });
}
