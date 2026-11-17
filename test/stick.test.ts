import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import type { Esp3Event } from '../src/esp3/commands.ts';
import { Esp3Decoder, encodePacket, PacketType, type Esp3Packet } from '../src/esp3/packet.ts';
import { erp1Data, type Erp1Telegram } from '../src/erp1.ts';
import { fromHex, toHex } from '../src/hex.ts';
import type { Logger } from '../src/logger.ts';
import { buildSettingsTelegram } from '../src/orders.ts';
import { Stick, StickClosedError, StickTimeoutError, type Incident } from '../src/stick.ts';
import type { Transport, TransportEvents } from '../src/transport/types.ts';
import {
  FakeTransport,
  receivedRadio,
  response,
  StickEmulator,
  waitFor,
} from './helpers/fake-stick.ts';

const UNIT = '0400AA01';
const SENDER = 'FFAA0000';

/** A transport that records writes and answers only when told to. */
class ManualTransport extends EventEmitter<TransportEvents> implements Transport {
  readonly kind = 'tcp' as const;
  readonly description = 'manual';
  readonly writes: Esp3Packet[] = [];
  isOpen = false;
  readonly #decoder = new Esp3Decoder();

  open(): Promise<void> {
    this.isOpen = true;
    return Promise.resolve();
  }

  write(bytes: Uint8Array): Promise<void> {
    this.writes.push(...this.#decoder.push(bytes));
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.isOpen = false;
    return Promise.resolve();
  }

  answer(packet: Esp3Packet): void {
    this.emit('data', encodePacket(packet));
  }
}

function setup(timeoutMs = 30): {
  emulator: StickEmulator;
  transport: FakeTransport;
  stick: Stick;
} {
  const emulator = new StickEmulator();
  const transport = new FakeTransport(emulator);
  const stick = new Stick(transport, { responseTimeoutMs: timeoutMs });
  return { emulator, transport, stick };
}

describe('Stick commands', () => {
  it('reads the Base ID', async () => {
    const { stick, emulator } = setup();
    await stick.open();
    assert.deepEqual(await stick.readBaseId(), { baseId: 'FFAA0000', remainingWrites: 10 });
    assert.deepEqual(emulator.commands(), [0x08]);
    await stick.close();
  });

  it('keeps one request outstanding at a time', async () => {
    const transport = new ManualTransport();
    const stick = new Stick(transport, { responseTimeoutMs: 1000 });
    await stick.open();
    const first = stick.readBaseId();
    const second = stick.readBaseId();
    assert.equal(transport.writes.length, 1);
    transport.answer(response(0, [0xff, 0xaa, 0x00, 0x00]));
    assert.equal((await first).baseId, 'FFAA0000');
    assert.equal(transport.writes.length, 2);
    transport.answer(response(0, [0xff, 0xaa, 0x00, 0x80]));
    assert.equal((await second).baseId, 'FFAA0080');
    await stick.close();
  });

  it('repeats the first command once when it gets no answer (ser2net)', async () => {
    const { stick, emulator } = setup();
    emulator.swallow = 1;
    await stick.open();
    assert.equal((await stick.readBaseId()).baseId, 'FFAA0000');
    assert.deepEqual(emulator.commands(), [0x08, 0x08]);
    await stick.close();
  });

  it('times out: first command after two tries, later commands after one', async () => {
    const { stick, emulator } = setup(10);
    emulator.silent = true;
    await stick.open();
    await assert.rejects(stick.readBaseId(), StickTimeoutError);
    assert.equal(emulator.commands().length, 2);
    await assert.rejects(stick.readBaseId(), StickTimeoutError);
    assert.equal(emulator.commands().length, 3);
    await stick.close();
  });

  it('fails waiting commands when the link closes', async () => {
    const { stick, emulator, transport } = setup(1000);
    emulator.silent = true;
    await stick.open();
    const pending = stick.readBaseId();
    const queued = stick.readBaseId();
    transport.drop();
    await assert.rejects(pending, StickClosedError);
    await assert.rejects(queued, StickClosedError);
    assert.equal(stick.isOpen, false);
    await assert.rejects(stick.readBaseId(), StickClosedError);
  });

  it('writes the Base ID then resets the stick', async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (m) => warnings.push(m),
      error: () => undefined,
    };
    const emulator = new StickEmulator();
    const stick = new Stick(new FakeTransport(emulator), { logger, responseTimeoutMs: 30 });
    await stick.open();
    await stick.writeBaseId('ffaa0080');
    assert.deepEqual(emulator.commands(), [0x07, 0x02]);
    assert.equal(emulator.baseId, 'FFAA0080');
    assert.ok(warnings.some((m) => m.includes('FFAA0080')));
    await assert.rejects(stick.writeBaseId('FFAA0001'), RangeError);
    await stick.close();
  });

  it('logs raw TX and RX frames at debug level', async () => {
    const debug: string[] = [];
    const logger: Logger = {
      debug: (m) => debug.push(m),
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    const stick = new Stick(new FakeTransport(new StickEmulator()), { logger });
    await stick.open();
    await stick.readBaseId();
    assert.ok(debug.includes('TX 5500010005700838 (CO_RD_IDBASE)'));
    assert.ok(debug.some((m) => m.startsWith('RX 55000501')));
    await stick.close();
  });
});

describe('Stick radio transmission', () => {
  const order = buildSettingsTelegram({ mode: 'eco' }, SENDER);

  it('reports a confirmed transmission', async () => {
    const { stick, emulator } = setup();
    await stick.open();
    assert.deepEqual(await stick.send(order), { confirmed: true, returnCode: 0 });
    const [radio] = emulator.radio();
    assert.ok(radio);
    assert.equal(toHex(radio.data), 'D1079001FFFFFFFFFFFFFFFFFFAA000080');
    await stick.close();
  });

  it('raises an incident when the stick rejects the transmission', async () => {
    const { stick, emulator } = setup();
    emulator.radioReturnCode = 0x01;
    const incidents: Incident[] = [];
    stick.on('incident', (i) => incidents.push(i));
    await stick.open();
    const result = await stick.send(order);
    assert.equal(result.confirmed, false);
    assert.equal(result.reason, 'rejected');
    assert.equal(result.returnCode, 1);
    assert.deepEqual(
      incidents.map((i) => i.reason),
      ['transmission_not_confirmed'],
    );
    await stick.close();
  });

  it('raises an incident when the stick does not answer', async () => {
    const { stick, emulator } = setup(10);
    emulator.silent = true;
    const incidents: Incident[] = [];
    stick.on('incident', (i) => incidents.push(i));
    await stick.open();
    const result = await stick.send(order);
    assert.equal(result.confirmed ? null : result.reason, 'no_answer');
    assert.deepEqual(
      incidents.map((i) => i.reason),
      ['no_answer'],
    );
    await stick.close();
  });

  it('reports not_connected when closed', async () => {
    const { stick } = setup();
    const result = await stick.send(order);
    assert.equal(result.confirmed ? null : result.reason, 'not_connected');
  });
});

describe('Stick reception', () => {
  it('emits plain telegrams', async () => {
    const { stick, transport } = setup();
    await stick.open();
    const received = waitFor<[Erp1Telegram]>(stick, 'telegram');
    transport.inject(
      encodePacket(
        receivedRadio({
          rorg: 0xd1,
          payload: fromHex('0791006C000403'),
          senderId: UNIT,
          destinationId: SENDER,
        }),
      ),
    );
    const [telegram] = await received;
    assert.equal(telegram.senderId, UNIT);
    assert.equal(telegram.destinationId, SENDER);
    assert.equal(telegram.dbm, -67);
    await stick.close();
  });

  it('reassembles chained pieces before emitting them', async () => {
    const { stick, transport } = setup();
    await stick.open();
    const telegrams: Erp1Telegram[] = [];
    stick.on('telegram', (t) => telegrams.push(t));
    // Pieces of the real CMD 0 (see chain.test.ts), split across chunks with garbage in between.
    const p0 = encodePacket(
      receivedRadio({
        rorg: 0x40,
        payload: fromHex('80000CD10790023200'),
        senderId: UNIT,
        destinationId: SENDER,
      }),
    );
    const p1 = encodePacket(
      receivedRadio({
        rorg: 0x40,
        payload: fromHex('81041E00000001'),
        senderId: UNIT,
        destinationId: SENDER,
      }),
    );
    const stream = Uint8Array.from([0x00, ...p0, 0x55, 0x12, ...p1]);
    for (let i = 0; i < stream.length; i += 5) transport.inject(stream.subarray(i, i + 5));
    assert.equal(telegrams.length, 1);
    assert.equal(toHex(erp1Data(telegrams[0]!)), 'D10790023200041E000000010400AA0100');
    await stick.close();
  });

  it('honours the chained sender allow-list', async () => {
    const emulator = new StickEmulator();
    const transport = new FakeTransport(emulator);
    const stick = new Stick(transport, { chain: { allowedSenders: ['0400AA05'] } });
    await stick.open();
    const telegrams: Erp1Telegram[] = [];
    stick.on('telegram', (t) => telegrams.push(t));
    transport.inject(
      encodePacket(
        receivedRadio({ rorg: 0x40, payload: fromHex('80000CD10790023200'), senderId: UNIT }),
      ),
    );
    transport.inject(
      encodePacket(
        receivedRadio({ rorg: 0x40, payload: fromHex('81041E00000001'), senderId: UNIT }),
      ),
    );
    assert.equal(telegrams.length, 0);
    await stick.close();
  });

  it('emits EVENT packets and ignores unexpected responses', async () => {
    const { stick, transport } = setup();
    await stick.open();
    const events: Esp3Event[] = [];
    stick.on('event', (e) => events.push(e));
    transport.inject(
      encodePacket({ type: PacketType.EVENT, data: fromHex('04'), optional: new Uint8Array(0) }),
    );
    transport.inject(encodePacket(response(0)));
    transport.inject(
      encodePacket({
        type: PacketType.RADIO_ERP1,
        data: fromHex('D1'),
        optional: new Uint8Array(0),
      }),
    );
    assert.deepEqual(
      events.map((e) => e.name),
      ['CO_READY'],
    );
    await stick.close();
  });
});
