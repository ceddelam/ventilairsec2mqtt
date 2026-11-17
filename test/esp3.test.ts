import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildReadIdBase,
  buildReset,
  buildWriteIdBase,
  eventCodeName,
  parseBaseIdResponse,
  parseEvent,
  parseResponse,
  returnCodeName,
  validateBaseId,
} from '../src/esp3/commands.ts';
import { crc8 } from '../src/esp3/crc8.ts';
import { Esp3Decoder, encodePacket, PacketType, type DiscardReason } from '../src/esp3/packet.ts';
import { fromHex, toHex } from '../src/hex.ts';

// Reference ESP3 packet from the ESP3 specification: CO_RD_IDBASE.
// 55 | 00 01 00 05 | 70 | 08 | 38
const READ_IDBASE = '55000100057008' + '38';

// First line of fixtures/assistant-vmi.txt.
const ASSISTANT_FRAME = '55000c070196d107910617d8270400aa0200000400aa014f0023';

describe('crc8', () => {
  it('matches the CRC-8 (poly 0x07, init 0) check value of "123456789"', () => {
    assert.equal(crc8(new TextEncoder().encode('123456789')), 0xf4);
  });

  it('is 0 for empty input and table values for single bytes', () => {
    assert.equal(crc8(new Uint8Array(0)), 0);
    // One byte with init 0 = the byte shifted 8 times, XOR 0x07 whenever the MSB falls out:
    // 0x01: 7 shifts -> 0x80, 8th -> 0x07. 0x02: 6 shifts -> 0x80, then 0x07, 0x0E.
    // 0x08: 4 shifts -> 0x80, then 0x07, 0x0E, 0x1C, 0x38.
    assert.equal(crc8(Uint8Array.of(0x01)), 0x07);
    assert.equal(crc8(Uint8Array.of(0x02)), 0x0e);
    assert.equal(crc8(Uint8Array.of(0x08)), 0x38);
  });

  it('honours start and end', () => {
    // Header 00 01 00 05: 00 -> 00; 01 -> 07; 00 -> crc(07) = 15; 05 -> crc(15 ^ 05 = 10) = 70.
    const bytes = fromHex(READ_IDBASE);
    assert.equal(crc8(bytes, 1, 5), 0x70);
    assert.equal(crc8(bytes, 6, 7), 0x38);
  });
});

describe('encodePacket', () => {
  it('encodes CO_RD_IDBASE like the ESP3 reference', () => {
    assert.equal(toHex(encodePacket(buildReadIdBase())), READ_IDBASE.toUpperCase());
  });

  it('encodes CO_WR_RESET', () => {
    // data 02 -> data CRC = crc8(02) = 0x0E; header identical to CO_RD_IDBASE.
    assert.equal(toHex(encodePacket(buildReset())), '55000100057002' + '0E');
  });

  it('rejects an invalid type', () => {
    assert.throws(() =>
      encodePacket({ type: 256, data: new Uint8Array(0), optional: new Uint8Array(0) }),
    );
  });

  it('round-trips through the decoder', () => {
    const packet = { type: 0x01, data: fromHex('D10790'), optional: fromHex('03FFFFFFFFFF00') };
    const decoded = new Esp3Decoder().push(encodePacket(packet));
    assert.equal(decoded.length, 1);
    assert.deepEqual(decoded[0], packet);
  });
});

describe('Esp3Decoder', () => {
  const frame = fromHex(ASSISTANT_FRAME);

  it('decodes a real packet', () => {
    const [packet] = new Esp3Decoder().push(frame);
    assert.ok(packet);
    assert.equal(packet.type, PacketType.RADIO_ERP1);
    assert.equal(toHex(packet.data), 'D107910617D8270400AA0200');
    assert.equal(toHex(packet.optional), '000400AA014F00');
  });

  it('handles packets split byte by byte', () => {
    const decoder = new Esp3Decoder();
    const out = [];
    for (const byte of [...frame, ...frame]) out.push(...decoder.push(Uint8Array.of(byte)));
    assert.equal(out.length, 2);
    assert.equal(decoder.pendingBytes, 0);
  });

  it('skips garbage between packets, including stray 55 bytes', () => {
    const reasons: DiscardReason[] = [];
    const decoder = new Esp3Decoder({ onDiscard: (reason) => reasons.push(reason) });
    const stream = Uint8Array.from([
      0x00,
      0x13,
      ...frame,
      0x55,
      0x55,
      0x01,
      0x02,
      0x03,
      0x04,
      0x05,
      0x06,
      ...frame,
    ]);
    const packets = decoder.push(stream);
    assert.equal(packets.length, 2);
    assert.ok(reasons.includes('garbage'));
    assert.ok(reasons.includes('bad_header_crc'));
    assert.equal(decoder.stats.packets, 2);
  });

  it('resynchronises after a bad header CRC', () => {
    const broken = frame.slice();
    broken[5] = (broken[5] ?? 0) ^ 0xff; // corrupt the header CRC
    const decoder = new Esp3Decoder();
    const packets = decoder.push(Uint8Array.from([...broken, ...frame]));
    assert.equal(packets.length, 1);
    assert.equal(decoder.stats.badHeaderCrc, 1);
  });

  it('skips a packet with a bad data CRC and keeps the next one', () => {
    const broken = frame.slice();
    broken[broken.length - 1] = (broken[broken.length - 1] ?? 0) ^ 0x01;
    const decoder = new Esp3Decoder();
    const packets = decoder.push(Uint8Array.from([...broken, ...frame]));
    assert.equal(packets.length, 1);
    assert.equal(decoder.stats.badDataCrc, 1);
  });

  it('keeps every packet after one with a corrupted data byte', () => {
    const broken = frame.slice();
    broken[10] = (broken[10] ?? 0) ^ 0x10;
    const decoder = new Esp3Decoder();
    const packets = decoder.push(Uint8Array.from([...broken, ...frame, ...frame]));
    assert.equal(packets.length, 2);
  });

  it('treats an oversized length as a bad header', () => {
    // Header announcing 0x0400 data bytes, CRC computed so the header itself is valid.
    const header = Uint8Array.of(0x55, 0x04, 0x00, 0x00, 0x01, 0);
    header[5] = crc8(header, 1, 5);
    const decoder = new Esp3Decoder({ maxPayloadLength: 255 });
    const packets = decoder.push(Uint8Array.from([...header, ...frame]));
    assert.equal(packets.length, 1);
    assert.equal(decoder.stats.tooLong, 1);
  });

  it('waits for the rest of a packet and can be reset', () => {
    const decoder = new Esp3Decoder();
    assert.deepEqual(decoder.push(frame.subarray(0, 10)), []);
    assert.equal(decoder.pendingBytes, 10);
    decoder.reset();
    assert.equal(decoder.pendingBytes, 0);
    assert.deepEqual(decoder.push(frame.subarray(10)), []);
  });
});

describe('common commands', () => {
  it('builds CO_WR_IDBASE with validation', () => {
    assert.equal(toHex(buildWriteIdBase('ffaa0080').data), '07FFAA0080');
    assert.throws(() => buildWriteIdBase('FF7FFF80'), RangeError); // below FF800000
    assert.throws(() => buildWriteIdBase('FFFFFFFF'), RangeError); // above FFFFFF80
    assert.throws(() => buildWriteIdBase('FFAA0001'), RangeError); // not a multiple of 0x80
    assert.throws(() => buildWriteIdBase('nope'));
  });

  it('accepts both ends of the Base ID range', () => {
    validateBaseId('FF800000');
    validateBaseId('FFFFFF80');
  });

  it('parses a CO_RD_IDBASE response with and without the remaining-writes byte', () => {
    const withWrites = parseResponse({
      type: PacketType.RESPONSE,
      data: fromHex('00FFAA0000'),
      optional: fromHex('0A'),
    });
    assert.deepEqual(parseBaseIdResponse(withWrites), { baseId: 'FFAA0000', remainingWrites: 10 });
    const without = parseResponse({
      type: PacketType.RESPONSE,
      data: fromHex('00FFAA0000'),
      optional: new Uint8Array(0),
    });
    assert.deepEqual(parseBaseIdResponse(without), {
      baseId: 'FFAA0000',
      remainingWrites: undefined,
    });
  });

  it('rejects failed or short Base ID responses', () => {
    const failed = { returnCode: 2, data: new Uint8Array(0), optional: new Uint8Array(0) };
    assert.throws(() => parseBaseIdResponse(failed), /NOT_SUPPORTED/);
    const short = { returnCode: 0, data: fromHex('FFAA'), optional: new Uint8Array(0) };
    assert.throws(() => parseBaseIdResponse(short), /too short/);
  });

  it('parses RESPONSE and EVENT packets', () => {
    assert.throws(() =>
      parseResponse({ type: 1, data: fromHex('00'), optional: new Uint8Array(0) }),
    );
    assert.throws(() =>
      parseResponse({ type: 2, data: new Uint8Array(0), optional: new Uint8Array(0) }),
    );
    const event = parseEvent({
      type: PacketType.EVENT,
      data: fromHex('0401'),
      optional: new Uint8Array(0),
    });
    assert.equal(event.code, 4);
    assert.equal(event.name, 'CO_READY');
    assert.equal(toHex(event.data), '01');
    assert.throws(() => parseEvent({ type: 2, data: fromHex('04'), optional: new Uint8Array(0) }));
  });

  it('names return and event codes', () => {
    assert.equal(returnCodeName(0), 'OK');
    assert.equal(returnCodeName(0x91), 'BASEID_MAX_REACHED');
    assert.equal(returnCodeName(0x42), '0x42');
    assert.equal(eventCodeName(0x07), 'CO_TRANSMIT_FAILED');
    assert.equal(eventCodeName(0xee), '0xEE');
  });
});
