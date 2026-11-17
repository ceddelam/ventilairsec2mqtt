import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyTelegram } from '../src/classify.ts';
import { parseErp1, type Erp1Telegram } from '../src/erp1.ts';
import { fromHex } from '../src/hex.ts';
import { MachineIdGuard } from '../src/machine-id.ts';

const UNIT = '0400AA01';
const ASSISTANT = '0400AA02';
const STICK = 'FFAA0000';

function telegram(dataHex: string, destinationId: string | undefined): Erp1Telegram {
  return { ...parseErp1(fromHex(dataHex)), destinationId };
}

// Short unit -> Assistant frame (protocol.md § 5.9) and a full CMD 0 status.
const SHORT = `D107901300011F${UNIT}00`;
const STATUS = `D10790023200041E00000001${UNIT}00`;
const ASSISTANT_CMD1 = `D107910417A13C${ASSISTANT}00`;

describe('classifyTelegram', () => {
  it('recognises the short unit -> Assistant frame by its destination', () => {
    const c = classifyTelegram(telegram(SHORT, ASSISTANT), {
      unitId: UNIT,
      assistantId: ASSISTANT,
    });
    assert.equal(c.kind, 'unit_to_assistant');
    assert.deepEqual([c.command, [...c.data]], [0, [0x13, 0x00, 0x01, 0x1f]]);
  });

  it('decodes unit frames addressed to us as status', () => {
    const c = classifyTelegram(telegram(STATUS, STICK), {
      unitId: UNIT,
      assistantId: ASSISTANT,
      receiverIds: [STICK],
    });
    assert.ok(c.kind === 'unit_status' && c.status.command === 0);
    assert.equal(c.status.mode, 'standard');
  });

  it('does not decode unit frames addressed to another controller when receivers are known', () => {
    const c = classifyTelegram(telegram(STATUS, 'FFBB0080'), {
      unitId: UNIT,
      receiverIds: [STICK],
    });
    assert.equal(c.kind, 'unit_to_other');
  });

  it('without receivers, decodes any unit frame not addressed to the Assistant', () => {
    const c = classifyTelegram(telegram(STATUS, 'FFBB0080'), {
      unitId: UNIT,
      assistantId: ASSISTANT,
    });
    assert.equal(c.kind, 'unit_status');
  });

  it('recognises Assistant frames by sender, or by destination when its ID is unknown', () => {
    const known = classifyTelegram(telegram(ASSISTANT_CMD1, UNIT), {
      unitId: UNIT,
      assistantId: ASSISTANT,
    });
    assert.ok(known.kind === 'assistant' && known.frame.kind === 'measurement');
    assert.equal(known.frame.humidity, 60);
    const inferred = classifyTelegram(telegram(ASSISTANT_CMD1, UNIT), { unitId: UNIT });
    assert.equal(inferred.kind, 'assistant');
    const stranger = classifyTelegram(telegram(ASSISTANT_CMD1, UNIT), {
      unitId: UNIT,
      assistantId: '0400AA07',
    });
    assert.equal(stranger.kind, 'ignored');
  });

  it('recognises teach-in queries from the unit only', () => {
    const query = `D480FF79000001D1`;
    const fromUnit = classifyTelegram(telegram(`${query}${UNIT}00`, 'FFFFFFFF'), { unitId: UNIT });
    assert.equal(fromUnit.kind, 'teach_in_query');
    const fromOther = classifyTelegram(telegram(`${query}0400AA09 00`, 'FFFFFFFF'), {
      unitId: UNIT,
    });
    assert.equal(fromOther.kind, 'ignored');
    const notExpecting = classifyTelegram(telegram(`D4C0FF79000001D1${UNIT}00`, 'FFFFFFFF'), {
      unitId: UNIT,
    });
    assert.equal(notExpecting.kind, 'ignored');
  });

  it('ignores other RORGs, manufacturers and truncated MSC payloads', () => {
    const ids = { unitId: UNIT, assistantId: ASSISTANT };
    assert.equal(classifyTelegram(telegram(`A5000000080400AA0100`, STICK), ids).kind, 'ignored');
    assert.equal(classifyTelegram(telegram(`D100110400AA0100`, STICK), ids).kind, 'ignored');
    assert.equal(classifyTelegram(telegram(`D1070400AA0100`, STICK), ids).kind, 'ignored');
  });
});

describe('MachineIdGuard', () => {
  it('keeps the first ID and flags another one', () => {
    const guard = new MachineIdGuard();
    assert.deepEqual(guard.check('0A0B0C0D'), { result: 'first', machineId: '0A0B0C0D' });
    assert.deepEqual(guard.check('0A0B0C0D'), { result: 'same', machineId: '0A0B0C0D' });
    assert.deepEqual(guard.check('0A0B0C0E'), {
      result: 'mismatch',
      machineId: '0A0B0C0E',
      expected: '0A0B0C0D',
    });
    assert.equal(guard.expected, '0A0B0C0D');
  });

  it('accepts a known reference', () => {
    assert.equal(new MachineIdGuard('0A0B0C0D').check('01020304').result, 'mismatch');
  });
});
