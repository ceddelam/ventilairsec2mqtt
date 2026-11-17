import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Esp3Decoder, encodePacket, PacketType } from '../src/esp3/packet.ts';
import { buildErp1Packet, erp1Data, parseErp1, parseErp1Packet, Rorg } from '../src/erp1.ts';
import { fromHex, toHex } from '../src/hex.ts';

describe('parseErp1', () => {
  it('parses a real Assistant frame with its optional data', () => {
    // fixtures/assistant-vmi.txt line 1:
    // 55 000C 07 01 96 | D1 07910617D827 0400AA02 00 | 00 0400AA01 4F 00 | 23
    const [packet] = new Esp3Decoder().push(
      fromHex('55000c070196d107910617d8270400aa0200000400aa014f0023'),
    );
    assert.ok(packet);
    const telegram = parseErp1Packet(packet);
    assert.equal(telegram.rorg, Rorg.MSC);
    assert.equal(toHex(telegram.payload), '07910617D827');
    assert.equal(telegram.senderId, '0400AA02');
    assert.equal(telegram.status, 0);
    assert.equal(telegram.subTelegrams, 0);
    assert.equal(telegram.destinationId, '0400AA01');
    assert.equal(telegram.dbm, -79); // 0x4F = 79 -> -79 dBm
    assert.equal(telegram.securityLevel, 0);
  });

  it('leaves optional fields undefined without optional data', () => {
    const telegram = parseErp1(fromHex('D10790130001 1F 0400AA01 00'));
    assert.equal(telegram.destinationId, undefined);
    assert.equal(telegram.dbm, undefined);
    assert.equal(telegram.subTelegrams, undefined);
    assert.equal(telegram.securityLevel, undefined);
  });

  it('rejects data shorter than RORG + sender + status', () => {
    assert.throws(() => parseErp1(fromHex('D10400AA01')), /too short/);
    assert.doesNotThrow(() => parseErp1(fromHex('D10400AA0100')));
  });

  it('rejects other packet types', () => {
    assert.throws(() =>
      parseErp1Packet({ type: 2, data: fromHex('00'), optional: new Uint8Array(0) }),
    );
  });
});

describe('buildErp1Packet', () => {
  it('builds a broadcast transmit packet by default', () => {
    const packet = buildErp1Packet({
      rorg: 0xd1,
      payload: fromHex('0790'),
      senderId: 'ffaa0000',
      status: 0x80,
    });
    assert.equal(packet.type, PacketType.RADIO_ERP1);
    assert.equal(toHex(packet.data), 'D10790FFAA000080');
    assert.equal(toHex(packet.optional), '03FFFFFFFFFF00');
  });

  it('addresses a destination', () => {
    const packet = buildErp1Packet({
      rorg: 0xd4,
      payload: fromHex('91'),
      senderId: 'FFAA0000',
      status: 0,
      destinationId: '0400AA01',
    });
    assert.equal(toHex(packet.optional), '030400AA01FF00');
    // Round trip through ESP3 framing.
    const [decoded] = new Esp3Decoder().push(encodePacket(packet));
    assert.ok(decoded);
    assert.equal(parseErp1Packet(decoded).destinationId, '0400AA01');
  });

  it('serialises telegram data', () => {
    const data = erp1Data({
      rorg: 0xd1,
      payload: fromHex('0791'),
      senderId: '0400AA02',
      status: 0,
    });
    assert.equal(toHex(data), 'D107910400AA0200');
  });
});
