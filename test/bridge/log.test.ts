/**
 * Console logger: level filter and line format.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createConsoleLogger,
  errorMessage,
  formatLogLine,
  isJournalStream,
} from '../../src/bridge/log.ts';

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

  it('writes lines without timestamp, or with the journal priority prefix', () => {
    const lines: string[] = [];
    const plain = createConsoleLogger('debug', (line) => lines.push(line), undefined, 'plain');
    plain.info('started');
    const journal = createConsoleLogger('debug', (line) => lines.push(line), undefined, 'journal');
    journal.debug('raw');
    journal.info('started');
    journal.warn('careful');
    journal.error('broken');
    assert.deepEqual(lines, [
      'INFO started',
      '<7>DEBUG raw',
      '<6>INFO started',
      '<4>WARNING careful',
      '<3>ERROR broken',
    ]);
    assert.equal(formatLogLine('journal', 'error', 'x'), '<3>ERROR x');
  });
});

describe('isJournalStream', () => {
  const stat = () => ({ dev: 25, ino: 4242 });

  it('is true only when JOURNAL_STREAM matches the descriptor', () => {
    assert.equal(isJournalStream({ JOURNAL_STREAM: '25:4242' }, stat), true);
    assert.equal(isJournalStream({ JOURNAL_STREAM: '25:4243' }, stat), false);
    assert.equal(isJournalStream({}, stat), false);
    assert.equal(isJournalStream({ JOURNAL_STREAM: 'garbage' }, stat), false);
    assert.equal(
      isJournalStream({ JOURNAL_STREAM: '1:2' }, () => ({ dev: 1n, ino: 2n })),
      true,
    );
    const failing = (): never => {
      throw new Error('EBADF');
    };
    assert.equal(isJournalStream({ JOURNAL_STREAM: '25:4242' }, failing), false);
  });
});

describe('errorMessage', () => {
  it('falls back on inner errors or the code when the message is empty', () => {
    assert.equal(errorMessage(new Error('boom')), 'boom');
    assert.equal(errorMessage('text'), 'text');
    const refused = (address: string) =>
      Object.assign(new Error(`connect ECONNREFUSED ${address}:1883`), { code: 'ECONNREFUSED' });
    assert.equal(
      errorMessage(new AggregateError([refused('::1'), refused('127.0.0.1')], '')),
      'connect ECONNREFUSED ::1:1883; connect ECONNREFUSED 127.0.0.1:1883',
    );
    assert.equal(errorMessage(Object.assign(new Error(''), { code: 'ECONNRESET' })), 'ECONNRESET');
    assert.equal(errorMessage(new TypeError('')), 'TypeError');
  });
});
