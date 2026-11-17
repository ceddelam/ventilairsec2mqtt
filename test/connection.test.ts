/**
 * Connection supervision: reconnection, silence detection, fallback port and probing, Base ID
 * write opt-in. Uses in-memory transports and short real durations (a few ms).
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  StickConnection,
  type ConnectedInfo,
  type ConnectFailedInfo,
  type DisconnectedInfo,
  type PortSwitchedInfo,
  type StickConnectionOptions,
} from '../src/connection.ts';
import { encodePacket } from '../src/esp3/packet.ts';
import type { Erp1Telegram } from '../src/erp1.ts';
import { fromHex } from '../src/hex.ts';
import { buildSettingsTelegram } from '../src/orders.ts';
import type { Incident } from '../src/stick.ts';
import type { TransportKind } from '../src/transport/types.ts';
import {
  FakeStickServer,
  FakeTransport,
  receivedRadio,
  StickEmulator,
  until,
  waitFor,
} from './helpers/fake-stick.ts';

const PRIMARY = 'socket://primary.invalid:3333';
const FALLBACK = '/dev/ttyFALLBACK';

/** A pretend network: one emulated stick per URL, transports created on demand. */
class Lab {
  readonly emulators = new Map<string, StickEmulator>();
  readonly failOpen = new Set<string>();
  readonly transports: FakeTransport[] = [];

  emulator(url: string): StickEmulator {
    let emulator = this.emulators.get(url);
    if (emulator === undefined) {
      emulator = new StickEmulator();
      this.emulators.set(url, emulator);
    }
    return emulator;
  }

  factory = (url: string): FakeTransport => {
    const kind: TransportKind = url.startsWith('socket://') ? 'tcp' : 'serial';
    const transport = new FakeTransport(this.emulator(url), url, kind);
    transport.failOpen = this.failOpen.has(url);
    this.transports.push(transport);
    return transport;
  };

  /** The last transport opened for `url`. */
  last(url: string): FakeTransport {
    const found = this.transports.filter((t) => t.description === url && t.isOpen).at(-1);
    assert.ok(found, `no open transport for ${url}`);
    return found;
  }
}

/** Collects every event of a connection in order. */
function record(connection: StickConnection): string[] {
  const log: string[] = [];
  connection.on('connected', (i: ConnectedInfo) => log.push(`connected ${i.port} ${i.baseId}`));
  connection.on('disconnected', (i: DisconnectedInfo) =>
    log.push(`disconnected ${i.port} ${i.reason}`),
  );
  connection.on('connectFailed', (i: ConnectFailedInfo) =>
    log.push(`failed ${i.port} ${i.failures}`),
  );
  connection.on('portSwitched', (i: PortSwitchedInfo) =>
    log.push(`switched ${i.from}>${i.to} ${i.reason}`),
  );
  connection.on('incident', (i: Incident) => log.push(`incident ${i.reason}`));
  return log;
}

const connections: StickConnection[] = [];
function connect(lab: Lab, options: Partial<StickConnectionOptions> = {}): StickConnection {
  const connection = new StickConnection({
    primary: PRIMARY,
    transportFactory: lab.factory,
    responseTimeoutMs: 15,
    backoff: { initialDelayMs: 2, maxDelayMs: 20, factor: 2 },
    ...options,
  });
  connections.push(connection);
  return connection;
}

afterEach(async () => {
  await Promise.all(connections.splice(0).map((c) => c.stop()));
});

describe('StickConnection', () => {
  it('connects, reads the Base ID and forwards telegrams', async () => {
    const lab = new Lab();
    const connection = connect(lab);
    const log = record(connection);
    connection.start();
    const [info] = await waitFor<[ConnectedInfo]>(connection, 'connected');
    assert.deepEqual(info, {
      port: 'primary',
      url: PRIMARY,
      baseId: 'FFAA0000',
      remainingWrites: 10,
    });
    assert.equal(connection.state, 'connected');
    assert.equal(connection.baseId, 'FFAA0000');
    assert.deepEqual(log, ['connected primary FFAA0000']);

    const received = waitFor<[Erp1Telegram]>(connection, 'telegram');
    lab
      .last(PRIMARY)
      .inject(
        encodePacket(
          receivedRadio({ rorg: 0xd1, payload: fromHex('0791006C000403'), senderId: '0400AA01' }),
        ),
      );
    assert.equal((await received)[0].senderId, '0400AA01');

    const result = await connection.send(buildSettingsTelegram({ mode: 'eco' }, 'FFAA0000'));
    assert.equal(result.confirmed, true);
  });

  it('reports not_connected before the stick answers', async () => {
    const lab = new Lab();
    const connection = connect(lab);
    const result = await connection.send(buildSettingsTelegram({ mode: 'eco' }, 'FFAA0000'));
    assert.equal(result.confirmed ? null : result.reason, 'not_connected');
  });

  it('reconnects after the link is lost', async () => {
    const lab = new Lab();
    const connection = connect(lab);
    const log = record(connection);
    connection.start();
    await waitFor(connection, 'connected');
    const reconnected = waitFor(connection, 'connected');
    lab.last(PRIMARY).drop(new Error('cable pulled'));
    await reconnected;
    assert.deepEqual(log, [
      'connected primary FFAA0000',
      'disconnected primary closed',
      'connected primary FFAA0000',
    ]);
  });

  it('reconnects a silent TCP link but not a silent serial one', async () => {
    const lab = new Lab();
    const tcp = connect(lab, { silenceTimeoutMs: 30 });
    const log = record(tcp);
    tcp.start();
    await waitFor(tcp, 'connected');
    await waitFor(tcp, 'disconnected');
    await waitFor(tcp, 'connected');
    assert.deepEqual(log.slice(0, 3), [
      'connected primary FFAA0000',
      'disconnected primary silence',
      'connected primary FFAA0000',
    ]);

    const serial = connect(lab, { primary: FALLBACK, silenceTimeoutMs: 30 });
    const serialLog = record(serial);
    serial.start();
    await waitFor(serial, 'connected');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(serialLog, ['connected primary FFAA0000']);
  });

  it('keeps a TCP link alive while data flows', async () => {
    const lab = new Lab();
    const connection = connect(lab, { silenceTimeoutMs: 40 });
    const log = record(connection);
    connection.start();
    await waitFor(connection, 'connected');
    const transport = lab.last(PRIMARY);
    const frame = encodePacket(
      receivedRadio({ rorg: 0xd1, payload: fromHex('0791'), senderId: '0400AA01' }),
    );
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      transport.inject(frame);
    }
    assert.deepEqual(log, ['connected primary FFAA0000']);
  });

  it('backs off between failed attempts', async () => {
    const lab = new Lab();
    lab.failOpen.add(PRIMARY);
    const connection = connect(lab);
    const delays: number[] = [];
    connection.on('connectFailed', (i) => delays.push(i.retryInMs));
    connection.start();
    await until(() => delays.length >= 6);
    assert.deepEqual(delays.slice(0, 6), [2, 4, 8, 16, 20, 20]);
    assert.equal(connection.activePort, 'primary'); // no fallback configured
  });

  it('raises no_answer when the stick does not answer at connection', async () => {
    const lab = new Lab();
    lab.emulator(PRIMARY).silent = true;
    const connection = connect(lab);
    const log = record(connection);
    connection.start();
    await until(() => log.length >= 2);
    assert.deepEqual(log.slice(0, 2), ['incident no_answer', 'failed primary 1']);
    // The first command after opening was sent twice (ser2net rule).
    assert.deepEqual(lab.emulator(PRIMARY).commands().slice(0, 2), [0x08, 0x08]);
  });

  it('switches to the fallback after 3 failures, then back when the primary answers', async () => {
    const lab = new Lab();
    lab.failOpen.add(PRIMARY);
    lab.emulator(FALLBACK).baseId = 'FFAA0080';
    const connection = connect(lab, { fallback: FALLBACK, primaryProbeIntervalMs: 25 });
    const log = record(connection);
    connection.start();
    await until(() => log.includes('connected fallback FFAA0080'));
    assert.deepEqual(log, [
      'failed primary 1',
      'failed primary 2',
      'failed primary 3',
      'switched primary>fallback primary_failures',
      'connected fallback FFAA0080',
    ]);
    assert.equal(connection.activePort, 'fallback');

    // Probes fail while the primary is down: still on the fallback.
    const opensBefore = lab.transports.filter((t) => t.description === PRIMARY).length;
    await until(
      () => lab.transports.filter((t) => t.description === PRIMARY).length >= opensBefore + 2,
    );
    assert.equal(connection.activePort, 'fallback');

    // The primary comes back: the next probe switches back.
    lab.failOpen.delete(PRIMARY);
    await until(() => log.includes('connected primary FFAA0000'));
    assert.deepEqual(log.slice(5), [
      'disconnected fallback switching',
      'switched fallback>primary primary_available',
      'connected primary FFAA0000',
    ]);
    // The probe itself opened the primary, read the Base ID and closed.
    const primaryCommands = lab.emulator(PRIMARY).commands();
    assert.deepEqual(primaryCommands, [0x08, 0x08]);
  });

  it('does not switch back when the primary opens but stays silent', async () => {
    const lab = new Lab();
    lab.failOpen.add(PRIMARY);
    const connection = connect(lab, { fallback: FALLBACK, primaryProbeIntervalMs: 10 });
    connection.start();
    await waitFor(connection, 'connected');
    lab.failOpen.delete(PRIMARY);
    lab.emulator(PRIMARY).silent = true;
    await until(() => lab.emulator(PRIMARY).commands().length >= 4);
    assert.equal(connection.activePort, 'fallback');
    assert.equal(connection.state, 'connected');
  });

  it('writes the Base ID once, on explicit opt-in', async () => {
    const lab = new Lab();
    const warnings: string[] = [];
    const connection = connect(lab, {
      forceBaseId: 'ffaa0080',
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (m) => warnings.push(m),
        error: () => undefined,
      },
    });
    connection.start();
    const [info] = await waitFor<[ConnectedInfo]>(connection, 'connected');
    assert.equal(info.baseId, 'FFAA0080');
    assert.equal(info.remainingWrites, 9);
    // Read, write, reset, read again.
    assert.deepEqual(lab.emulator(PRIMARY).commands(), [0x08, 0x07, 0x02, 0x08]);
    assert.ok(warnings.some((m) => m.includes('FFAA0080')));

    const reconnected = waitFor(connection, 'connected');
    lab.last(PRIMARY).drop();
    await reconnected;
    assert.deepEqual(lab.emulator(PRIMARY).commands().slice(4), [0x08]); // no second write
  });

  it('does not write the Base ID when the stick has no writes left', async () => {
    const lab = new Lab();
    lab.emulator(PRIMARY).remainingWrites = 0;
    const connection = connect(lab, { forceBaseId: 'FFAA0080' });
    connection.start();
    const [info] = await waitFor<[ConnectedInfo]>(connection, 'connected');
    assert.equal(info.baseId, 'FFAA0000');
    assert.deepEqual(lab.emulator(PRIMARY).commands(), [0x08]);
  });

  it('validates the forced Base ID', () => {
    assert.throws(
      () => new StickConnection({ primary: PRIMARY, forceBaseId: 'FFAA0001' }),
      RangeError,
    );
  });

  it('stops cleanly', async () => {
    const lab = new Lab();
    const connection = connect(lab);
    const log = record(connection);
    connection.start();
    await waitFor(connection, 'connected');
    await connection.stop();
    assert.equal(connection.state, 'stopped');
    assert.deepEqual(log, ['connected primary FFAA0000', 'disconnected primary stopped']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(lab.transports.filter((t) => t.isOpen).length, 0);
  });
});

describe('StickConnection over TCP (emulated ser2net)', () => {
  it('connects, survives a dropped connection and a silent stick', async () => {
    const server = new FakeStickServer();
    await server.listen();
    try {
      const connection = new StickConnection({
        primary: server.url,
        responseTimeoutMs: 50,
        silenceTimeoutMs: 150,
        backoff: { initialDelayMs: 5, maxDelayMs: 20 },
      });
      connections.push(connection);
      const log = record(connection);
      connection.start();
      await waitFor(connection, 'connected');

      // Telegram injected by the "stick".
      const received = waitFor<[Erp1Telegram]>(connection, 'telegram');
      server.inject(
        encodePacket(
          receivedRadio({ rorg: 0xd1, payload: fromHex('0790023200'), senderId: '0400AA01' }),
        ),
      );
      assert.equal((await received)[0].senderId, '0400AA01');

      // Connection cut by the bridge.
      const reconnected = waitFor(connection, 'connected');
      server.dropAll();
      await reconnected;

      // No byte for longer than the silence timeout: dead link, reconnect.
      await waitFor(connection, 'disconnected');
      await waitFor(connection, 'connected');
      assert.deepEqual(log.slice(0, 5), [
        'connected primary FFAA0000',
        'disconnected primary closed',
        'connected primary FFAA0000',
        'disconnected primary silence',
        'connected primary FFAA0000',
      ]);
      assert.ok(server.connections >= 3);
    } finally {
      await Promise.all(connections.splice(0).map((c) => c.stop()));
      await server.close();
    }
  });
});
