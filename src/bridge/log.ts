/**
 * Structured console logging: one timestamped line per message, filtered by level.
 */
import type { Logger } from '../logger.ts';

/** Log levels, from the most verbose. */
export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

/** Accepted log levels, in increasing severity. */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warning', 'error'];

/** Where log lines go (one call per line, without the trailing newline). */
export type LogSink = (line: string) => void;

const LABELS: Readonly<Record<LogLevel, string>> = {
  debug: 'DEBUG',
  info: 'INFO',
  warning: 'WARNING',
  error: 'ERROR',
};

/**
 * Creates a {@link Logger} writing `<ISO timestamp> <LEVEL> <message>` lines to `sink`
 * (stdout by default) for messages at `level` or above.
 */
export function createConsoleLogger(
  level: LogLevel,
  sink: LogSink = (line) => {
    process.stdout.write(`${line}\n`);
  },
  now: () => Date = () => new Date(),
): Logger {
  const threshold = LOG_LEVELS.indexOf(level);
  const write = (messageLevel: LogLevel, message: string): void => {
    if (LOG_LEVELS.indexOf(messageLevel) < threshold) return;
    sink(`${now().toISOString()} ${LABELS[messageLevel]} ${message}`);
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

/** Text of an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
