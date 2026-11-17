/**
 * State file: defaults, tolerance to missing or corrupt files, atomic writes.
 */
import assert from 'node:assert/strict';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { Logger } from '../../src/logger.ts';
import { DEFAULT_STATE, parseState, StateStore } from '../../src/bridge/state-store.ts';
import { tempDir } from '../helpers/fake-bridge.ts';

function recorder(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (message: string) => {
    lines.push(`${level} ${message}`);
  };
  return {
    lines,
    logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') },
  };
}

describe('StateStore', () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });
  async function dir(): Promise<string> {
    const path = await tempDir();
    dirs.push(path);
    return path;
  }

  it('uses the defaults when the file is missing, without a warning', async () => {
    const { logger, lines } = recorder();
    const store = new StateStore(join(await dir(), 'state.json'), logger);
    assert.deepEqual(await store.load(), {
      boostDuration: 30,
      holidayDuration: 7,
      learnedAssistantId: undefined,
    });
    assert.deepEqual(lines, []);
  });

  it('uses the defaults when the file is corrupt', async () => {
    const { logger, lines } = recorder();
    const path = join(await dir(), 'state.json');
    await writeFile(path, '{"boost_duration": 4');
    const store = new StateStore(path, logger);
    assert.deepEqual(await store.load(), DEFAULT_STATE);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^warn .*state\.json is corrupt, using defaults/);
  });

  it('keeps the valid fields of a partly invalid file', () => {
    assert.deepEqual(
      parseState({ boost_duration: 45, holiday_duration: 300, assistant_id: 'zz' }),
      {
        state: { boostDuration: 45, holidayDuration: 7, learnedAssistantId: undefined },
        problems: ['invalid assistant_id "zz"', 'invalid holiday_duration 300'],
      },
    );
    assert.deepEqual(parseState({ boost_duration: 2.5 }).problems, ['invalid boost_duration 2.5']);
  });

  it('writes atomically and reads back', async () => {
    const folder = await dir();
    const path = join(folder, 'state.json');
    const store = new StateStore(path);
    await store.load();
    const first = store.update({ boostDuration: 60 });
    const second = store.update({ learnedAssistantId: '0400AA02' });
    await Promise.all([first, second]);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      boost_duration: 60,
      holiday_duration: 7,
      assistant_id: '0400AA02',
    });
    assert.deepEqual(await readdir(folder), ['state.json']);
    const again = new StateStore(path);
    assert.deepEqual(await again.load(), {
      boostDuration: 60,
      holidayDuration: 7,
      learnedAssistantId: '0400AA02',
    });
  });

  it('logs a write failure without throwing', async () => {
    const { logger, lines } = recorder();
    const store = new StateStore(join(await dir(), 'missing-dir', 'state.json'), logger);
    await store.update({ holidayDuration: 3 });
    assert.equal(store.state.holidayDuration, 3);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^error Cannot write .*state\.json/);
  });
});
