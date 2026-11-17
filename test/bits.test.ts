import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fromHex } from '../src/hex.ts';
import { readBits, readFlag, readSigned, toSigned } from '../src/msc/bits.ts';
import { mscHeaderBytes, parseMscHeader } from '../src/msc/envelope.ts';

describe('readBits', () => {
  const payload = fromHex('07 90 02 32 00 04');

  it('reads fields from the MSB of the first byte', () => {
    assert.equal(readBits(payload, 0, 12), 0x079);
    assert.equal(readBits(payload, 12, 4), 0);
    assert.equal(readBits(payload, 16, 8), 2);
    // 0x32 = 0011 0010: bit 26 = 1, bit 27 = 1, bit 28 = 0, bit 30 = 1, bit 31 = 0.
    assert.equal(readBits(payload, 26, 1), 1);
    assert.equal(readBits(payload, 28, 1), 0);
    assert.equal(readBits(payload, 30, 1), 1);
    assert.equal(readBits(payload, 24, 16), 0x3200);
  });

  it('reads 32-bit fields as unsigned', () => {
    assert.equal(readBits(fromHex('0798FFAA0000'), 16, 32), 0xffaa0000);
  });

  it('returns undefined for a field beyond the payload, never 0', () => {
    assert.equal(readBits(payload, 48, 8), undefined);
    assert.equal(readBits(payload, 44, 8), undefined); // straddles the end
    assert.equal(readBits(payload, 40, 8), 4);
    assert.equal(readBits(new Uint8Array(0), 0, 1), undefined);
  });

  it('rejects invalid sizes and offsets', () => {
    assert.throws(() => readBits(payload, 0, 0), RangeError);
    assert.throws(() => readBits(payload, 0, 33), RangeError);
    assert.throws(() => readBits(payload, -1, 8), RangeError);
  });
});

describe('signed values and flags', () => {
  it('interprets two complement', () => {
    assert.equal(toSigned(0x0c, 8), 12);
    assert.equal(toSigned(0x7f, 8), 127);
    assert.equal(toSigned(0x80, 8), -128);
    assert.equal(toSigned(0xfb, 8), -5);
    assert.equal(readSigned(fromHex('0792FE'), 16, 8), -2);
    assert.equal(readSigned(fromHex('0792'), 16, 8), undefined);
  });

  it('reads flags', () => {
    assert.equal(readFlag(fromHex('80'), 0), true);
    assert.equal(readFlag(fromHex('80'), 1), false);
    assert.equal(readFlag(fromHex('80'), 8), undefined);
  });
});

describe('MSC header', () => {
  it('splits manufacturer and command', () => {
    assert.deepEqual(parseMscHeader(fromHex('0794')), { manufacturer: 0x079, command: 4 });
    assert.equal(parseMscHeader(fromHex('07')), undefined);
  });

  it('builds 07 9x', () => {
    assert.deepEqual(mscHeaderBytes(0), [0x07, 0x90]);
    assert.deepEqual(mscHeaderBytes(1), [0x07, 0x91]);
    assert.throws(() => mscHeaderBytes(16), RangeError);
  });
});
