import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fromHex,
  idToBytes,
  idToNumber,
  isEnOceanId,
  normalizeId,
  numberToId,
  readId,
  toHex,
} from '../src/hex.ts';

describe('hex helpers', () => {
  it('converts bytes to and from hexadecimal', () => {
    assert.equal(toHex(Uint8Array.of(0x55, 0x0a, 0xff)), '550AFF');
    assert.equal(toHex(Uint8Array.of(0x07, 0x90), ' '), '07 90');
    assert.deepEqual([...fromHex('55 0a\nFF')], [0x55, 0x0a, 0xff]);
    assert.throws(() => fromHex('5'));
    assert.throws(() => fromHex('zz'));
  });

  it('normalises and validates IDs', () => {
    assert.equal(normalizeId(' 0400aa01 '), '0400AA01');
    assert.equal(isEnOceanId('ffaa0000'), true);
    assert.equal(isEnOceanId('FFAA000'), false);
    assert.throws(() => normalizeId('0400AA0G'));
  });

  it('converts IDs to bytes and numbers', () => {
    assert.deepEqual([...idToBytes('FFAA0080')], [0xff, 0xaa, 0x00, 0x80]);
    assert.equal(idToNumber('FFAA0080'), 0xffaa0080);
    assert.equal(numberToId(0xffaa0080), 'FFAA0080');
    assert.equal(numberToId(0x0a0b0c0d), '0A0B0C0D');
    assert.throws(() => numberToId(-1), RangeError);
    assert.throws(() => numberToId(2 ** 32), RangeError);
    assert.equal(readId(fromHex('D10400AA0100'), 1), '0400AA01');
  });
});
