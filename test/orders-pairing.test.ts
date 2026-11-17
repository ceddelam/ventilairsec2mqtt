import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Esp3Decoder, encodePacket } from '../src/esp3/packet.ts';
import {
  buildErp1Packet,
  erp1Data,
  parseErp1,
  parseErp1Packet,
  type Erp1Telegram,
} from '../src/erp1.ts';
import { fromHex, toHex } from '../src/hex.ts';
import { updateFunctionByte } from '../src/msc/function-byte.ts';
import {
  buildClockTelegram,
  buildSettingsTelegram,
  encodeClock,
  encodeSettings,
  mergeSettings,
  OrderError,
  type SettingsOrder,
} from '../src/orders.ts';
import {
  buildTeachInResponse,
  isTeachInQuery,
  parseUte,
  shouldAnswerTeachIn,
} from '../src/pairing.ts';

const SENDER = 'FFAA0000';
const UNIT = '0400AA01';

function hex(order: SettingsOrder): string {
  return toHex(encodeSettings(order), ' ');
}

describe('settings order (CMD 0)', () => {
  it('sends FF for every field left unchanged', () => {
    assert.equal(hex({ mode: 'eco' }), '07 90 01 FF FF FF FF FF FF FF FF');
    assert.equal(hex({ mode: 'standby' }), '07 90 00 FF FF FF FF FF FF FF FF');
    assert.equal(hex({ mode: 'comfort' }), '07 90 03 FF FF FF FF FF FF FF FF');
  });

  it('places each field at its rank', () => {
    assert.equal(hex({ functionByte: 0x3a }), '07 90 FF 3A FF FF FF FF FF FF FF');
    assert.equal(hex({ holidayDays: 7 }), '07 90 FF FF 07 FF FF FF FF FF FF');
    assert.equal(hex({ holidayDays: 0 }), '07 90 FF FF 00 FF FF FF FF FF FF');
    assert.equal(hex({ boostMinutes: 30 }), '07 90 FF FF FF 1E FF FF FF FF FF');
    assert.equal(hex({ boostMinutes: 0 }), '07 90 FF FF FF 00 FF FF FF FF FF');
    assert.equal(hex({ preheatSetpoint: 15 }), '07 90 FF FF FF FF 0F FF FF FF FF');
    assert.equal(hex({ maxSupplyTemperature: 30 }), '07 90 FF FF FF FF FF 1E FF FF FF');
    assert.equal(hex({ hydroRSetpoint: 20 }), '07 90 FF FF FF FF FF FF 14 FF FF');
    assert.equal(hex({ solarRSetpoint: 25 }), '07 90 FF FF FF FF FF FF FF 19 FF');
    assert.equal(hex({ oneShot: 'refresh' }), '07 90 FF FF FF FF FF FF FF FF 01');
    assert.equal(hex({ oneShot: 'filter_reset' }), '07 90 FF FF FF FF FF FF FF FF 04');
  });

  it('encodes "off" setpoints with the disabled values', () => {
    assert.equal(
      hex({ preheatSetpoint: 'off', hydroRSetpoint: 'off', solarRSetpoint: 'off' }),
      '07 90 FF FF FF FF 04 FF 06 00 FF',
    );
  });

  it('merges several fields in one frame', () => {
    const order = mergeSettings(
      { mode: 'standard' },
      { boostMinutes: 30, oneShot: 'refresh' },
      { mode: 'eco' }, // later wins
    );
    assert.equal(hex(order), '07 90 01 FF FF 1E FF FF FF FF 01');
  });

  it('accepts the range ends', () => {
    assert.doesNotThrow(() =>
      encodeSettings({
        holidayDays: 254,
        boostMinutes: 200,
        preheatSetpoint: 12,
        maxSupplyTemperature: 45,
        hydroRSetpoint: 8,
        solarRSetpoint: 30,
      }),
    );
    assert.doesNotThrow(() =>
      encodeSettings({
        preheatSetpoint: 18,
        maxSupplyTemperature: 20,
        hydroRSetpoint: 28,
        solarRSetpoint: 18,
      }),
    );
  });

  it('rejects out-of-range values instead of clamping', () => {
    const invalid: [SettingsOrder, string][] = [
      [{ mode: 'turbo' as never }, 'mode'],
      [{ functionByte: 0x33 }, 'functionByte'], // holiday bit set
      [{ functionByte: 0xff }, 'functionByte'],
      [{ functionByte: -1 }, 'functionByte'],
      [{ holidayDays: 255 }, 'holidayDays'],
      [{ holidayDays: -1 }, 'holidayDays'],
      [{ boostMinutes: 201 }, 'boostMinutes'],
      [{ boostMinutes: 1.5 }, 'boostMinutes'],
      [{ preheatSetpoint: 11 }, 'preheatSetpoint'],
      [{ preheatSetpoint: 19 }, 'preheatSetpoint'],
      [{ maxSupplyTemperature: 19 }, 'maxSupplyTemperature'],
      [{ maxSupplyTemperature: 46 }, 'maxSupplyTemperature'],
      [{ hydroRSetpoint: 7 }, 'hydroRSetpoint'],
      [{ hydroRSetpoint: 29 }, 'hydroRSetpoint'],
      [{ solarRSetpoint: 17 }, 'solarRSetpoint'],
      [{ solarRSetpoint: 31 }, 'solarRSetpoint'],
      [{ solarRSetpoint: Number.NaN }, 'solarRSetpoint'],
      [{ oneShot: 'reboot' as never }, 'oneShot'],
      [{}, 'order'],
    ];
    for (const [order, field] of invalid) {
      assert.throws(
        () => encodeSettings(order),
        (error: unknown) => error instanceof OrderError && error.field === field,
        JSON.stringify(order),
      );
    }
  });

  it('builds the full transmit packet (RORG D1, status 80, broadcast)', () => {
    const fn = updateFunctionByte(0x32, { fixedAirflow: true }); // 0x3A
    const telegram = buildSettingsTelegram({ functionByte: fn }, SENDER);
    assert.equal(telegram.status, 0x80);
    assert.equal(telegram.destinationId, 'FFFFFFFF');
    const packet = buildErp1Packet(telegram);
    assert.equal(toHex(packet.data), 'D10790FF3AFFFFFFFFFFFFFF' + 'FFAA0000' + '80');
    assert.equal(toHex(packet.optional), '03FFFFFFFFFF00');
    // Header: data length 0x0011 = 17, optional length 7, type 01.
    const bytes = encodePacket(packet);
    assert.equal(toHex(bytes.subarray(0, 5)), '5500110701');
    const [decoded] = new Esp3Decoder().push(bytes);
    assert.ok(decoded);
    assert.equal(parseErp1Packet(decoded).senderId, SENDER);
  });
});

describe('clock order (CMD 1)', () => {
  it('encodes the local date and time', () => {
    // 2026-11-17 09:05:07 local: 26 = 0x1A, 11 = 0x0B, 17 = 0x11.
    const payload = encodeClock(new Date(2026, 10, 17, 9, 5, 7));
    assert.equal(toHex(payload, ' '), '07 91 1A 0B 11 09 05 07');
    const late = encodeClock(new Date(2009, 11, 31, 23, 59, 59));
    assert.equal(toHex(late, ' '), '07 91 09 0C 1F 17 3B 3B');
  });

  it('builds the telegram and rejects invalid dates', () => {
    const telegram = buildClockTelegram(new Date(2026, 0, 1, 0, 0, 0), SENDER);
    assert.equal(toHex(erp1Data(telegram)), 'D107911A01010000' + '00' + 'FFAA0000' + '80');
    assert.throws(() => encodeClock(new Date(Number.NaN)), OrderError);
  });
});

describe('UTE pairing', () => {
  // protocol.md § 7: D4 80 FF 79 00 00 01 D1 from the unit.
  const query: Erp1Telegram = {
    ...parseErp1(fromHex('D480FF79000001D1' + '0400AA01' + '00')),
    destinationId: 'FFFFFFFF',
  };

  it('recognises the unit query', () => {
    assert.equal(isTeachInQuery(query), true);
    assert.deepEqual(parseUte(query), {
      commandByte: 0x80,
      channels: 0xff,
      manufacturer: 0x079,
      type: 0x00,
      func: 0x01,
      rorg: 0xd1,
    });
  });

  it('rejects other UTE telegrams', () => {
    const withCommand = (byte: string): Erp1Telegram =>
      parseErp1(fromHex(`D4${byte}FF79000001D1` + '0400AA01' + '00'));
    assert.equal(isTeachInQuery(withCommand('00')), false); // unidirectional
    assert.equal(isTeachInQuery(withCommand('C0')), false); // no response expected
    assert.equal(isTeachInQuery(withCommand('90')), false); // deletion request
    assert.equal(isTeachInQuery(withCommand('81')), false); // response command
    assert.equal(isTeachInQuery(parseErp1(fromHex('D480FF79' + '0400AA01' + '00'))), false);
    assert.equal(isTeachInQuery(parseErp1(fromHex('D180FF79000001D1' + '0400AA01' + '00'))), false);
  });

  it('builds the response: D4 91 + next 6 bytes, to the unit, status 00', () => {
    const response = buildTeachInResponse(query, SENDER);
    const packet = buildErp1Packet(response);
    assert.equal(toHex(packet.data), 'D491FF79000001D1' + 'FFAA0000' + '00');
    assert.equal(toHex(packet.optional), '03' + '0400AA01' + 'FF00');
    assert.throws(() => buildTeachInResponse(parseErp1(fromHex('D10790' + UNIT + '00')), SENDER));
  });

  it('answers at most every 10 min and only after 15 min of silence towards us', () => {
    const min = 60_000;
    const on = { enabled: true };
    const t = 100 * min;
    const none = { lastAnswerAt: undefined, lastAddressedToUsAt: undefined };
    assert.equal(shouldAnswerTeachIn(t, none, on), true);
    assert.equal(shouldAnswerTeachIn(t, none, { enabled: false }), false);
    assert.equal(shouldAnswerTeachIn(t, { ...none, lastAnswerAt: t - 9 * min }, on), false);
    assert.equal(shouldAnswerTeachIn(t, { ...none, lastAnswerAt: t - 10 * min }, on), true);
    assert.equal(shouldAnswerTeachIn(t, { ...none, lastAddressedToUsAt: t - 14 * min }, on), false);
    assert.equal(shouldAnswerTeachIn(t, { ...none, lastAddressedToUsAt: t - 15 * min }, on), true);
  });

  it('takes configurable durations', () => {
    const options = { enabled: true, minIntervalMs: 1000, quietPeriodMs: 2000 };
    assert.equal(
      shouldAnswerTeachIn(5000, { lastAnswerAt: 4500, lastAddressedToUsAt: undefined }, options),
      false,
    );
    assert.equal(
      shouldAnswerTeachIn(5000, { lastAnswerAt: 4000, lastAddressedToUsAt: 3500 }, options),
      false,
    );
    assert.equal(
      shouldAnswerTeachIn(5000, { lastAnswerAt: 4000, lastAddressedToUsAt: 3000 }, options),
      true,
    );
  });
});
