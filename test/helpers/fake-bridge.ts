/**
 * Doubles for the bridge tests: a stick link recording what is transmitted, an MQTT client
 * recording what is published, an in-memory state store, and corpus telegrams.
 */
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp } from 'node:fs/promises';
import type { StickConnectionEvents } from '../../src/connection.ts';
import { erp1Data, parseErp1, type Erp1Telegram, type TransmitTelegram } from '../../src/erp1.ts';
import { fromHex, idToBytes, toHex } from '../../src/hex.ts';
import type { MqttPublisher } from '../../src/bridge/bridge.ts';
import {
  DEFAULT_STATE,
  type PersistentState,
  type StateStoreLike,
} from '../../src/bridge/state-store.ts';
import type { SendResult } from '../../src/stick.ts';
import { loadVmiStatus, type TelegramLine } from './fixtures.ts';

export const UNIT = '0400AA01';
export const ASSISTANT = '0400AA02';
export const BASE_ID = 'FFAA0000';

/** A stick connection double: emits what the test injects, records transmissions. */
export class FakeLink extends EventEmitter<StickConnectionEvents> {
  readonly sent: TransmitTelegram[] = [];
  /** Result of the next transmissions. */
  result: SendResult = { confirmed: true, returnCode: 0 };

  send(telegram: TransmitTelegram): Promise<SendResult> {
    this.sent.push(telegram);
    return Promise.resolve(this.result);
  }

  connect(baseId = BASE_ID): void {
    this.emit('connected', { port: 'primary', url: 'fake', baseId, remainingWrites: 10 });
  }

  /** Transmitted telegrams as `RORG…status hex → destination`. */
  sentHex(): string[] {
    return this.sent.map((t) => `${toHex(erp1Data(t))} > ${t.destinationId ?? 'FFFFFFFF'}`);
  }
}

/** One recorded publication. */
export interface Publication {
  readonly topic: string;
  readonly payload: string;
  readonly retain: boolean;
}

/** An MQTT client double. */
export class FakeMqtt implements MqttPublisher {
  connected = true;
  readonly published: Publication[] = [];
  readonly retained = new Map<string, string>();

  publish(topic: string, payload: string, options: { readonly retain: boolean }): Promise<void> {
    this.published.push({ topic, payload, retain: options.retain });
    if (options.retain) {
      if (payload === '') this.retained.delete(topic);
      else this.retained.set(topic, payload);
    }
    return Promise.resolve();
  }

  /** Last payload published on `topic`. */
  last(topic: string): string | undefined {
    return this.published.filter((p) => p.topic === topic).at(-1)?.payload;
  }

  /** Last payload on `topic`, parsed. */
  json(topic: string): Record<string, unknown> {
    const payload = this.last(topic);
    if (payload === undefined) throw new Error(`nothing published on ${topic}`);
    return JSON.parse(payload) as Record<string, unknown>;
  }

  /** Publications on `topic`. */
  on(topic: string): Publication[] {
    return this.published.filter((p) => p.topic === topic);
  }

  clear(): void {
    this.published.length = 0;
  }
}

/** In-memory state store. */
export class MemoryStore implements StateStoreLike {
  state: PersistentState;
  updates = 0;

  constructor(state: Partial<PersistentState> = {}) {
    this.state = { ...DEFAULT_STATE, ...state };
  }

  update(patch: Partial<PersistentState>): Promise<void> {
    this.state = { ...this.state, ...patch };
    this.updates += 1;
    return Promise.resolve();
  }
}

/** A received telegram from a corpus line. */
export function corpusTelegram(line: TelegramLine): Erp1Telegram {
  const optional = new Uint8Array(7);
  optional[0] = 1;
  optional.set(idToBytes(line.destinationId), 1);
  optional[5] = line.dbm === undefined ? 0 : -line.dbm;
  return parseErp1(line.data, optional);
}

/** A received telegram from hex (RORG … status), destination and level. */
export function telegram(hex: string, destinationId: string, dbm = -67): Erp1Telegram {
  return corpusTelegram({ line: 0, seconds: 0, destinationId, dbm, data: fromHex(hex) });
}

/** Corpus lines of `vmi-status.txt`. */
export function vmiStatus(): TelegramLine[] {
  return loadVmiStatus();
}

/** A fresh directory under the project's `.test-tmp/` (git-ignored). */
export async function tempDir(): Promise<string> {
  const root = new URL('../../.test-tmp/', import.meta.url);
  await mkdir(root, { recursive: true });
  return mkdtemp(new URL('run-', root).pathname);
}

/** Lets pending promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}
