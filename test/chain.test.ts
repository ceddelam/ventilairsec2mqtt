import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChainReassembler, splitSeqIdx, type ChainDropReason } from '../src/chain.ts';
import { erp1Data, parseErp1, type Erp1Telegram } from '../src/erp1.ts';
import { fromHex, toHex } from '../src/hex.ts';
import { decodeUnitStatus } from '../src/msc/unit.ts';

const UNIT = '0400AA01';
const STICK = 'FFAA0000';
const ASSISTANT = '0400AA02';

/** A RORG 40 piece: payload = SEQ/IDX byte + data, with sender, status and destination. */
function piece(
  payloadHex: string,
  options: { sender?: string; destination?: string; status?: number } = {},
): Erp1Telegram {
  return {
    ...parseErp1(
      erp1Data({
        rorg: 0x40,
        payload: fromHex(payloadHex),
        senderId: options.sender ?? UNIT,
        status: options.status ?? 0,
      }),
    ),
    destinationId: options.destination ?? STICK,
    dbm: -67,
    subTelegrams: 1,
    securityLevel: 0,
  };
}

// Real reassembled CMD 0 from fixtures/vmi-status.txt (line 3):
// D1 07 90 02 32 00 04 1E 00 00 00 01 | 0400AA01 | 00
// The message (without the appended sender/status) is 12 bytes = 0x000C.
// Pieces built by hand following protocol.md § 2, SEQ = 2 (byte = 0x80 | IDX):
//   IDX 0: 80 | 00 0C | D1 07 90 02 32 00
//   IDX 1: 81 | 04 1E 00 00 00 01
const CMD0_TELEGRAM = 'D10790023200041E000000010400AA0100';
const CMD0_PIECE_0 = '80 000C D10790023200';
const CMD0_PIECE_1 = '81 041E00000001';

describe('splitSeqIdx', () => {
  it('reads SEQ from bits 7-6 and IDX from bits 5-0', () => {
    assert.deepEqual(splitSeqIdx(0x40), { seq: 1, idx: 0 });
    assert.deepEqual(splitSeqIdx(0x42), { seq: 1, idx: 2 });
    assert.deepEqual(splitSeqIdx(0x81), { seq: 2, idx: 1 });
    assert.deepEqual(splitSeqIdx(0xff), { seq: 3, idx: 63 });
  });
});

describe('ChainReassembler', () => {
  it('reassembles the real CMD 0 telegram from two pieces', () => {
    const chain = new ChainReassembler();
    assert.equal(chain.push(piece(CMD0_PIECE_0)), undefined);
    assert.equal(chain.inProgress, 1);
    const message = chain.push(piece(CMD0_PIECE_1));
    assert.ok(message);
    assert.equal(toHex(erp1Data(message)), CMD0_TELEGRAM);
    assert.equal(message.destinationId, STICK);
    assert.equal(message.dbm, -67);
    assert.equal(chain.inProgress, 0);
  });

  it('accepts pieces out of order', () => {
    const chain = new ChainReassembler();
    assert.equal(chain.push(piece(CMD0_PIECE_1)), undefined);
    const message = chain.push(piece(CMD0_PIECE_0));
    assert.ok(message);
    assert.equal(toHex(erp1Data(message)), CMD0_TELEGRAM);
  });

  it('reassembles the published example (17 bytes, three pieces)', () => {
    // protocol.md § 2: 40 40 00 11 D1 07 90 01 02 00 …, 40 41 04 20 1C 1C 00 01 00 00 …,
    // 40 42 00 00 00 00 …  — completed here as 6 + 8 + 3 = 17 message bytes, sender UNIT,
    // status 00 (the "…" are read as the sender and status of each piece).
    const chain = new ChainReassembler();
    assert.equal(chain.push(piece('40 0011 D10790010200')), undefined);
    assert.equal(chain.push(piece('41 04201C1C00010000')), undefined);
    const message = chain.push(piece('42 000000'));
    assert.ok(message);
    assert.equal(message.rorg, 0xd1);
    assert.equal(toHex(message.payload), '0790010200' + '04201C1C00010000' + '000000');
    assert.equal(message.senderId, UNIT);
    // Decoded with § 5.1: Eco, function byte 02 (over-ventilation only), boost off,
    // preheating 4 (disabled), max supply 0x20 = 32 °C, Hydro'R 0x1C = 28, SolarR 28,
    // season 01 = winter, event type 00 = periodic.
    const status = decodeUnitStatus(message.payload);
    assert.ok(status?.command === 0);
    assert.equal(status.mode, 'eco');
    assert.equal(status.functions?.overVentilation, true);
    assert.equal(status.functions.fixedAirflow, false);
    assert.equal(status.boostActive, false);
    assert.equal(status.preheatSetpoint, null);
    assert.equal(status.maxSupplyTemperature, 32);
    assert.equal(status.hydroRSetpoint, 28);
    assert.equal(status.solarRSetpoint, 28);
    assert.equal(status.season, 'winter');
    assert.equal(status.eventTypeRaw, 0);
  });

  it('ignores padding beyond the announced length', () => {
    const chain = new ChainReassembler();
    chain.push(piece('40 0011 D10790010200'));
    chain.push(piece('41 04201C1C00010000'));
    const message = chain.push(piece('42 00000000')); // one byte too many
    assert.ok(message);
    assert.equal(message.payload.length, 16);
  });

  it('drops an incomplete message after the timeout', () => {
    let now = 0;
    const drops: ChainDropReason[] = [];
    const chain = new ChainReassembler({ now: () => now, onDrop: (reason) => drops.push(reason) });
    chain.push(piece(CMD0_PIECE_0));
    now = 5000; // default timeout 5 s
    assert.equal(chain.push(piece(CMD0_PIECE_1)), undefined);
    assert.ok(drops.includes('timeout'));
  });

  it('completes just before the timeout', () => {
    let now = 0;
    const chain = new ChainReassembler({ now: () => now, timeoutMs: 1000 });
    chain.push(piece(CMD0_PIECE_0));
    now = 999;
    assert.ok(chain.push(piece(CMD0_PIECE_1)));
  });

  it('expire() drops stale messages without a new piece', () => {
    let now = 0;
    const chain = new ChainReassembler({ now: () => now });
    chain.push(piece(CMD0_PIECE_0));
    now = 6000;
    chain.expire();
    assert.equal(chain.inProgress, 0);
  });

  it('caps the number of messages in progress, dropping the oldest', () => {
    const drops: ChainDropReason[] = [];
    const chain = new ChainReassembler({
      maxInProgress: 2,
      onDrop: (reason) => drops.push(reason),
    });
    chain.push(piece('00 000C D10790023200')); // SEQ 0
    chain.push(piece('40 000C D10790023200')); // SEQ 1
    chain.push(piece('80 000C D10790023200')); // SEQ 2 -> SEQ 0 dropped
    assert.equal(chain.inProgress, 2);
    assert.deepEqual(drops, ['overflow']);
    assert.ok(chain.push(piece('41 041E00000001'))); // SEQ 1 still completes
    assert.equal(chain.push(piece('01 041E00000001')), undefined); // SEQ 0 is gone
  });

  it('defaults to 16 messages in progress', () => {
    const chain = new ChainReassembler();
    for (let i = 0; i < 20; i += 1) {
      chain.push(
        piece('80 000C D10790023200', { sender: `0400AB${i.toString(16).padStart(2, '0')}` }),
      );
    }
    assert.equal(chain.inProgress, 16);
  });

  it('discards pieces from senders outside the allow-list', () => {
    const drops: ChainDropReason[] = [];
    const chain = new ChainReassembler({
      allowedSenders: ['0400aa01'],
      onDrop: (reason) => drops.push(reason),
    });
    assert.equal(chain.push(piece(CMD0_PIECE_0, { sender: '0400AA09' })), undefined);
    assert.equal(chain.inProgress, 0);
    assert.deepEqual(drops, ['foreign_sender']);
    chain.push(piece(CMD0_PIECE_0));
    assert.ok(chain.push(piece(CMD0_PIECE_1)));
  });

  it('keeps two messages with the same SEQ apart when their destinations differ', () => {
    // The unit uses the same SEQ towards the Assistant and towards the stick.
    const chain = new ChainReassembler();
    chain.push(piece('80 000C D10790023200', { destination: STICK }));
    // Short unit -> Assistant frame D1 07 90 13 00 01 1F (7 bytes): 4 + 3 bytes, same SEQ 2.
    chain.push(piece('80 0007 D1079013', { destination: ASSISTANT }));
    assert.equal(chain.inProgress, 2);
    const toAssistant = chain.push(piece('81 00011F', { destination: ASSISTANT }));
    assert.ok(toAssistant);
    assert.equal(toHex(toAssistant.payload), '07901300011F');
    const toStick = chain.push(piece(CMD0_PIECE_1, { destination: STICK }));
    assert.ok(toStick);
    assert.equal(toHex(erp1Data(toStick)), CMD0_TELEGRAM);
  });

  it('restarts a message when a new IDX 0 reuses its key', () => {
    const drops: ChainDropReason[] = [];
    const chain = new ChainReassembler({ onDrop: (reason) => drops.push(reason) });
    chain.push(piece('80 000C D107900000FF'));
    chain.push(piece(CMD0_PIECE_0));
    assert.deepEqual(drops, ['restarted']);
    const message = chain.push(piece(CMD0_PIECE_1));
    assert.ok(message);
    assert.equal(toHex(erp1Data(message)), CMD0_TELEGRAM);
  });

  it('rejects malformed and non-chained telegrams', () => {
    const drops: ChainDropReason[] = [];
    const chain = new ChainReassembler({ onDrop: (reason) => drops.push(reason) });
    assert.equal(chain.push(parseErp1(fromHex('D107900400AA0100'))), undefined);
    assert.equal(chain.push(piece('')), undefined);
    assert.equal(chain.push(piece('80 00')), undefined);
    assert.equal(chain.push(piece('80 0000 D1')), undefined);
    assert.deepEqual(drops, ['not_chained', 'malformed', 'malformed', 'malformed']);
    assert.equal(chain.inProgress, 0);
  });
});
