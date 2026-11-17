import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { SerialPortMock } from 'serialport';

/** The mock binding port (`@serialport/binding-mock`) behind a SerialPortMock. */
type MockPortBinding = NonNullable<SerialPortMock['port']>;
import { Esp3Decoder, encodePacket } from '../src/esp3/packet.ts';
import { toHex } from '../src/hex.ts';
import { buildSettingsTelegram } from '../src/orders.ts';
import { Stick } from '../src/stick.ts';
import {
  SerialTransport,
  type SerialPortLike,
  type SerialPortOptions,
} from '../src/transport/serial.ts';
import { TcpTransport } from '../src/transport/tcp.ts';
import { createTransport, parseConnectionUrl } from '../src/transport/url.ts';
import { FakeStickServer, StickEmulator, until, waitFor } from './helpers/fake-stick.ts';

describe('parseConnectionUrl', () => {
  it('parses socket URLs as TCP', () => {
    assert.deepEqual(parseConnectionUrl('socket://stick.example:3333'), {
      kind: 'tcp',
      host: 'stick.example',
      port: 3333,
    });
    assert.deepEqual(parseConnectionUrl('  SOCKET://192.0.2.10:4000/ '), {
      kind: 'tcp',
      host: '192.0.2.10',
      port: 4000,
    });
    assert.deepEqual(parseConnectionUrl('socket://[::1]:3333'), {
      kind: 'tcp',
      host: '::1',
      port: 3333,
    });
  });

  it('treats anything else as a serial path at 57600 baud', () => {
    assert.deepEqual(parseConnectionUrl('/dev/serial/by-id/usb-EnOcean_GmbH-if00-port0'), {
      kind: 'serial',
      path: '/dev/serial/by-id/usb-EnOcean_GmbH-if00-port0',
      baudRate: 57600,
    });
    assert.deepEqual(parseConnectionUrl('COM3'), { kind: 'serial', path: 'COM3', baudRate: 57600 });
  });

  it('rejects invalid URLs', () => {
    assert.throws(() => parseConnectionUrl(''));
    assert.throws(() => parseConnectionUrl('socket://host'));
    assert.throws(() => parseConnectionUrl('socket://host:0'));
    assert.throws(() => parseConnectionUrl('socket://host:70000'));
    assert.throws(() => parseConnectionUrl('socket://:3333'));
  });

  it('creates the matching transport', () => {
    assert.ok(createTransport('socket://127.0.0.1:3333') instanceof TcpTransport);
    const serial = createTransport('/dev/ttyUSB0');
    assert.ok(serial instanceof SerialTransport);
    assert.equal(serial.description, '/dev/ttyUSB0');
  });
});

describe('TcpTransport', () => {
  const server = new FakeStickServer();
  before(async () => {
    await server.listen();
  });
  after(async () => {
    await server.close();
  });

  it('talks ESP3 with an emulated stick through a Stick', async () => {
    const transport = createTransport(server.url);
    assert.equal(transport.kind, 'tcp');
    const stick = new Stick(transport, { responseTimeoutMs: 500 });
    await stick.open();
    assert.equal((await stick.readBaseId()).baseId, 'FFAA0000');
    const result = await stick.send(buildSettingsTelegram({ oneShot: 'refresh' }, 'FFAA0000'));
    assert.equal(result.confirmed, true);
    await stick.close();
    assert.equal(transport.isOpen, false);
  });

  it('emits close with an error when the remote end drops the link', async () => {
    const transport = new TcpTransport('127.0.0.1', Number(server.url.split(':').at(-1)));
    await transport.open();
    await until(() => server.sockets.size > 0);
    const closed = waitFor<[Error | undefined]>(transport, 'close');
    server.dropAll();
    const [error] = await closed;
    assert.ok(error instanceof Error);
    assert.equal(transport.isOpen, false);
  });

  it('rejects open() when the port is closed', async () => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      probe.close(() => {
        resolve();
      });
    });
    await assert.rejects(new TcpTransport('127.0.0.1', port).open());
  });

  it('rejects writes when not open', async () => {
    await assert.rejects(new TcpTransport('127.0.0.1', 1).write(Uint8Array.of(0)));
  });
});

describe('SerialTransport (binding mock)', () => {
  const PATH = '/dev/ttyFAKE0';
  // The binding used by SerialPortMock (the package may load its own copy of the mock).
  const binding = SerialPortMock.binding;
  before(() => {
    binding.createPort(PATH, { echo: false, record: true });
  });
  after(() => {
    binding.reset();
  });

  it('opens at 57600 8N1 and runs a Stick over the port', async () => {
    const emulator = new StickEmulator();
    let options: SerialPortOptions | undefined;
    let port: SerialPortMock | undefined;
    const transport = new SerialTransport(PATH, {
      portFactory: (o): SerialPortLike => {
        options = o;
        port = new SerialPortMock({ ...o });
        return port;
      },
    });
    const stick = new Stick(transport, { responseTimeoutMs: 500 });
    await stick.open();
    assert.equal(transport.kind, 'serial');
    assert.deepEqual(options, {
      path: PATH,
      baudRate: 57600,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      rtscts: false,
      autoOpen: false,
    });
    // Answer like a stick: decode what is written, emit the response bytes.
    const mockPort: MockPortBinding = port!.port!;
    const decoder = new Esp3Decoder();
    const write = mockPort.write.bind(mockPort);
    mockPort.write = async (buffer: Buffer): Promise<void> => {
      await write(buffer);
      for (const packet of decoder.push(buffer)) {
        for (const answer of emulator.handle(packet))
          mockPort.emitData(Buffer.from(encodePacket(answer)));
      }
    };
    assert.deepEqual(await stick.readBaseId(), { baseId: 'FFAA0000', remainingWrites: 10 });
    assert.equal(toHex(mockPort.recording), '5500010005700838');
    await stick.close();
    assert.equal(transport.isOpen, false);
  });

  it('fails to open a missing port', async () => {
    const transport = new SerialTransport('/dev/ttyMISSING', {
      portFactory: (o) => new SerialPortMock({ ...o }),
    });
    await assert.rejects(transport.open());
    assert.equal(transport.isOpen, false);
  });

  it('emits close when the port goes away', async () => {
    let port: SerialPortMock | undefined;
    const transport = new SerialTransport(PATH, {
      portFactory: (o) => (port = new SerialPortMock({ ...o })),
    });
    await transport.open();
    const closed = waitFor(transport, 'close');
    port!.close();
    await closed;
    assert.equal(transport.isOpen, false);
  });
});
