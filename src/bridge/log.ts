/**
 * Structured console logging: one line per message, filtered by level.
 */
import { fstatSync } from 'node:fs';
import type { Logger } from '../logger.ts';

/** Log levels, from the most verbose. */
export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

/** Accepted log levels, in increasing severity. */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warning', 'error'];

/**
 * Line format:
 * - `timestamp`: `<ISO time> <LEVEL> <message>` (default, e.g. in the Home Assistant app);
 * - `plain`: `<LEVEL> <message>`, for a log collector that adds its own timestamps;
 * - `journal`: `<priority><LEVEL> <message>`: no timestamp, and the syslog priority prefix
 *   (`<7>` debug … `<3>` error) that the systemd journal turns into the entry's priority.
 */
export type LogFormat = 'timestamp' | 'plain' | 'journal';

/** Where log lines go (one call per line, without the trailing newline). */
export type LogSink = (line: string) => void;

const LABELS: Readonly<Record<LogLevel, string>> = {
  debug: 'DEBUG',
  info: 'INFO',
  warning: 'WARNING',
  error: 'ERROR',
};

/** Syslog priorities (sd-daemon(3) prefixes). */
const PRIORITIES: Readonly<Record<LogLevel, number>> = { debug: 7, info: 6, warning: 4, error: 3 };

/** Formats one log line. */
export function formatLogLine(
  format: LogFormat,
  level: LogLevel,
  message: string,
  now: () => Date = () => new Date(),
): string {
  switch (format) {
    case 'timestamp':
      return `${now().toISOString()} ${LABELS[level]} ${message}`;
    case 'plain':
      return `${LABELS[level]} ${message}`;
    case 'journal':
      return `<${PRIORITIES[level]}>${LABELS[level]} ${message}`;
  }
}

/**
 * Creates a {@link Logger} writing lines in `format` to `sink` (stdout by default) for messages
 * at `level` or above.
 */
export function createConsoleLogger(
  level: LogLevel,
  sink: LogSink = (line) => {
    process.stdout.write(`${line}\n`);
  },
  now: () => Date = () => new Date(),
  format: LogFormat = 'timestamp',
): Logger {
  const threshold = LOG_LEVELS.indexOf(level);
  const write = (messageLevel: LogLevel, message: string): void => {
    if (LOG_LEVELS.indexOf(messageLevel) < threshold) return;
    sink(formatLogLine(format, messageLevel, message, now));
  };
  return {
    debug: (message) => {
      write('debug', message);
    },
    info: (message) => {
      write('info', message);
    },
    warn: (message) => {
      write('warning', message);
    },
    error: (message) => {
      write('error', message);
    },
  };
}

/**
 * True when `fd` (stdout by default) is the systemd journal stream: systemd sets
 * `JOURNAL_STREAM=<device>:<inode>` for a service whose output goes to the journal, and the
 * descriptor must match it (systemd.exec(5)), so a child process with redirected output is not
 * fooled by an inherited variable.
 */
export function isJournalStream(
  env: Readonly<Record<string, string | undefined>>,
  stat: (fd: number) => { dev: number | bigint; ino: number | bigint } = fstatSync,
  fd = 1,
): boolean {
  const match = /^(\d+):(\d+)$/.exec(env.JOURNAL_STREAM?.trim() ?? '');
  if (match === null) return false;
  try {
    const { dev, ino } = stat(fd);
    return String(dev) === match[1] && String(ino) === match[2];
  } catch {
    return false;
  }
}

/**
 * Text of an unknown thrown value. An error without a message falls back on its inner errors
 * (an `AggregateError`, e.g. a connection to `localhost` refused on both IPv6 and IPv4) or its
 * `code`.
 */
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.message !== '') return error.message;
  if (error instanceof AggregateError && Array.isArray(error.errors) && error.errors.length > 0) {
    return [...new Set(error.errors.map((inner) => errorMessage(inner)))].join('; ');
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : error.name;
}
