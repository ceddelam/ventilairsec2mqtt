/** Loads the anonymised frame corpus from `fixtures/`. */
import { readFileSync } from 'node:fs';
import { fromHex } from '../../src/hex.ts';

const FIXTURES = new URL('../../fixtures/', import.meta.url);

/** One line of `assistant-vmi.txt`: a full ESP3 packet. */
export interface Esp3Line {
  readonly line: number;
  readonly seconds: number;
  readonly bytes: Uint8Array;
}

/** One line of `vmi-status.txt`: an ERP1 telegram with its destination and level. */
export interface TelegramLine {
  readonly line: number;
  readonly seconds: number;
  readonly destinationId: string;
  readonly dbm: number | undefined;
  /** RORG … status. */
  readonly data: Uint8Array;
}

function lines(name: string): { line: number; fields: string[] }[] {
  return readFileSync(new URL(name, FIXTURES), 'utf8')
    .split('\n')
    .map((text, index) => ({ line: index + 1, fields: text.trim().split(/\s+/) }))
    .filter(({ fields }) => fields.length > 1);
}

export function loadAssistantVmi(): Esp3Line[] {
  return lines('assistant-vmi.txt').map(({ line, fields }) => ({
    line,
    seconds: Number(fields[0]),
    bytes: fromHex(fields[1] ?? ''),
  }));
}

export function loadVmiStatus(): TelegramLine[] {
  return lines('vmi-status.txt').map(({ line, fields }) => ({
    line,
    seconds: Number(fields[0]),
    destinationId: fields[1] ?? '',
    dbm: fields[2] === '-' ? undefined : Number(fields[2]),
    data: fromHex(fields[3] ?? ''),
  }));
}
