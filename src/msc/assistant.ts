/**
 * Assistant wall sensor frames (`D1-079-00`, protocol.md § 4).
 */
import { readBits } from './bits.ts';
import { parseMscHeader } from './envelope.ts';

/** Known Assistant command numbers. */
export const AssistantCommand = {
  CYCLIC: 1,
  ACTION: 2,
  WAKE_UP: 3,
  CLOCK: 4,
  TEST: 7,
} as const;

/** Measurements carried by Assistant commands 1 (cyclic) and 3 (wake-up). */
export interface AssistantMeasurement {
  readonly kind: 'measurement';
  readonly command: 1 | 3;
  /**
   * Raw battery level, `0`–`6`. Two percentage formulas exist and the right one is still open
   * (protocol.md § 4): the raw value is exposed, the caller converts.
   */
  readonly batteryRaw: number | undefined;
  /** °C: raw / 100 − 40. */
  readonly temperature: number | undefined;
  /** Relative humidity, %. */
  readonly humidity: number | undefined;
}

/** Any other Assistant command: content unknown, kept raw. */
export interface AssistantOtherFrame {
  readonly kind: 'other';
  readonly command: number;
  /** Payload bytes after the 2-byte MSC header. */
  readonly data: Uint8Array;
}

/** A decoded Assistant frame. */
export type AssistantFrame = AssistantMeasurement | AssistantOtherFrame;

/**
 * Decodes an Assistant MSC payload (starting with `07 9x`). Returns `undefined` when the payload
 * is too short to hold the MSC header.
 */
export function decodeAssistant(payload: Uint8Array): AssistantFrame | undefined {
  const header = parseMscHeader(payload);
  if (header === undefined) return undefined;
  const { command } = header;
  if (command === AssistantCommand.CYCLIC || command === AssistantCommand.WAKE_UP) {
    const rawTemperature = readBits(payload, 24, 16);
    return {
      kind: 'measurement',
      command,
      batteryRaw: readBits(payload, 16, 8),
      // (raw − 4000) / 100 rather than raw / 100 − 40: exact for 2-decimal values.
      temperature: rawTemperature === undefined ? undefined : (rawTemperature - 4000) / 100,
      humidity: readBits(payload, 40, 8),
    };
  }
  return { kind: 'other', command, data: payload.slice(2) };
}
