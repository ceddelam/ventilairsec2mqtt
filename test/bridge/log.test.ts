/**
 * Console logger: level filter and line format.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConsoleLogger } from '../../src/bridge/log.ts';

describe('createConsoleLogger', () => {
  it('writes timestamped lines at the level and above', () => {
    const lines: string[] = [];
    const logger = createConsoleLogger(
      'info',
      (line) => lines.push(line),
      () => new Date(Date.UTC(2026, 0, 15, 10, 20, 30)),
    );
    logger.debug('raw frame');
    logger.info('started');
    logger.warn('careful');
    logger.error('broken');
    assert.deepEqual(lines, [
      '2026-01-15T10:20:30.000Z INFO started',
      '2026-01-15T10:20:30.000Z WARNING careful',
      '2026-01-15T10:20:30.000Z ERROR broken',
    ]);
  });

  it('shows debug lines at debug level only', () => {
    const lines: string[] = [];
    createConsoleLogger('debug', (line) => lines.push(line)).debug('RX 55…');
    createConsoleLogger('error', (line) => lines.push(line)).warn('hidden');
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^\S+Z DEBUG RX 55…$/);
  });
});
