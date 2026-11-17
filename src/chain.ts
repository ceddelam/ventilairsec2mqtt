/**
 * Reassembly of chained messages (RORG `40`, protocol.md § 2).
 *
 * Piece payload, byte 1 (first payload byte): `SEQ` (bits 7-6) and `IDX` (bits 5-0).
 * - `IDX = 0`: bytes 2-3 = total length of the reassembled message (16-bit big-endian), then the
 *   start of the message.
 * - Other pieces: the message continues from byte 2.
 * Every piece ends with the sender and the status. The reassembled message starts with its own
 * RORG; the sender and status of the last piece are appended.
 */
import { Rorg, type Erp1Telegram } from './erp1.ts';
import { normalizeId, type EnOceanId } from './hex.ts';
import { systemTimers } from './timers.ts';

/** Why the reassembler dropped a piece or a message in progress. */
export type ChainDropReason =
  'not_chained' | 'malformed' | 'foreign_sender' | 'timeout' | 'overflow' | 'restarted';

/** Options of {@link ChainReassembler}. */
export interface ChainReassemblerOptions {
  /** Drop a message still incomplete after this delay (ms). Default 5000. */
  readonly timeoutMs?: number;
  /** Maximum number of messages in progress; the oldest is dropped beyond. Default 16. */
  readonly maxInProgress?: number;
  /** When given, pieces from any other sender are discarded before reassembly. */
  readonly allowedSenders?: readonly EnOceanId[];
  /** Clock in milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /** Called for each dropped piece or message, e.g. for debug logging. */
  readonly onDrop?: (reason: ChainDropReason, detail: string) => void;
}

/** Splits the first payload byte of a piece into `SEQ` (bits 7-6) and `IDX` (bits 5-0). */
export function splitSeqIdx(byte: number): { seq: number; idx: number } {
  return { seq: (byte >> 6) & 0x03, idx: byte & 0x3f };
}

interface Pending {
  readonly startedAt: number;
  readonly totalLength: number;
  readonly pieces: Map<number, Uint8Array>;
}

/**
 * Reassembles chained messages. Feed every RORG `40` telegram to {@link ChainReassembler.push};
 * it returns the reassembled telegram once the last piece is in.
 *
 * Messages are keyed by sender + destination + `SEQ`: the unit uses the same sequence numbers
 * towards the Assistant and towards the paired controller.
 */
export class ChainReassembler {
  readonly #timeoutMs: number;
  readonly #maxInProgress: number;
  readonly #allowed: ReadonlySet<EnOceanId> | undefined;
  readonly #now: () => number;
  readonly #onDrop: ((reason: ChainDropReason, detail: string) => void) | undefined;
  readonly #pending = new Map<string, Pending>();

  constructor(options: ChainReassemblerOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#maxInProgress = options.maxInProgress ?? 16;
    this.#allowed =
      options.allowedSenders === undefined
        ? undefined
        : new Set(options.allowedSenders.map((id) => normalizeId(id)));
    this.#now = options.now ?? (() => systemTimers.now());
    this.#onDrop = options.onDrop;
  }

  /** Number of messages waiting for pieces. */
  get inProgress(): number {
    return this.#pending.size;
  }

  /** Drops every message in progress. */
  clear(): void {
    this.#pending.clear();
  }

  /** Drops the messages older than the timeout. Called by {@link push} as well. */
  expire(): void {
    const now = this.#now();
    for (const [key, pending] of this.#pending) {
      if (now - pending.startedAt >= this.#timeoutMs) {
        this.#pending.delete(key);
        this.#drop('timeout', key);
      }
    }
  }

  /**
   * Feeds a piece. Returns the reassembled telegram when complete, otherwise `undefined`.
   * The reassembled telegram takes its RORG and payload from the message, its sender, status
   * and optional data (destination, level…) from the last piece.
   */
  push(piece: Erp1Telegram): Erp1Telegram | undefined {
    this.expire();
    if (piece.rorg !== Rorg.CHAINED) {
      this.#drop('not_chained', `RORG ${piece.rorg.toString(16)}`);
      return undefined;
    }
    if (this.#allowed !== undefined && !this.#allowed.has(piece.senderId)) {
      this.#drop('foreign_sender', piece.senderId);
      return undefined;
    }
    const first = piece.payload[0];
    if (first === undefined) {
      this.#drop('malformed', `empty piece from ${piece.senderId}`);
      return undefined;
    }
    const { seq, idx } = splitSeqIdx(first);
    const key = `${piece.senderId}>${piece.destinationId ?? '?'}#${seq}`;

    let pending = this.#pending.get(key);
    if (idx === 0) {
      if (piece.payload.length < 3) {
        this.#drop('malformed', `short first piece from ${piece.senderId}`);
        return undefined;
      }
      const totalLength = ((piece.payload[1] ?? 0) << 8) | (piece.payload[2] ?? 0);
      if (totalLength === 0) {
        this.#drop('malformed', `zero length from ${piece.senderId}`);
        return undefined;
      }
      if (pending?.pieces.has(0) === true) {
        // A new message reuses the key: the previous one will never complete.
        this.#pending.delete(key);
        this.#drop('restarted', key);
        pending = undefined;
      }
      if (pending === undefined) {
        pending = this.#create(key, totalLength);
      } else {
        // Later pieces arrived first: keep them, fix the length.
        pending = { ...pending, totalLength };
        this.#pending.set(key, pending);
      }
      pending.pieces.set(0, piece.payload.slice(3));
    } else {
      pending ??= this.#create(key, 0);
      pending.pieces.set(idx, piece.payload.slice(1));
    }

    const message = this.#assemble(pending);
    if (message === undefined) return undefined;
    this.#pending.delete(key);
    return {
      rorg: message[0] ?? 0,
      payload: message.slice(1),
      senderId: piece.senderId,
      status: piece.status,
      subTelegrams: piece.subTelegrams,
      destinationId: piece.destinationId,
      dbm: piece.dbm,
      securityLevel: piece.securityLevel,
    };
  }

  #create(key: string, totalLength: number): Pending {
    while (this.#pending.size >= this.#maxInProgress) {
      const oldest = this.#pending.keys().next();
      if (oldest.done === true) break;
      this.#pending.delete(oldest.value);
      this.#drop('overflow', oldest.value);
    }
    const pending: Pending = { startedAt: this.#now(), totalLength, pieces: new Map() };
    this.#pending.set(key, pending);
    return pending;
  }

  /** Concatenates the contiguous pieces from IDX 0; returns the message once long enough. */
  #assemble(pending: Pending): Uint8Array | undefined {
    if (pending.totalLength === 0) return undefined; // IDX 0 not received yet
    const parts: Uint8Array[] = [];
    let length = 0;
    for (let idx = 0; length < pending.totalLength; idx += 1) {
      const part = pending.pieces.get(idx);
      if (part === undefined) return undefined;
      parts.push(part);
      length += part.length;
    }
    const message = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      message.set(part, offset);
      offset += part.length;
    }
    // Extra bytes beyond the announced length (padding) are ignored.
    return message.slice(0, pending.totalLength);
  }

  #drop(reason: ChainDropReason, detail: string): void {
    this.#onDrop?.(reason, detail);
  }
}
