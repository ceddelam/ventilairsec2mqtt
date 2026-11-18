/**
 * Emulated EnOcean stick for the app image end-to-end test (`npm run test:app`), run with
 * Node in a container next to the app:
 *
 * - port 3333: the stick, like ser2net (`socket://<container>:3333`), answering like a TCM310;
 * - port 4000: control, one text line per message: `inject <ESP3 hex>` is sent to the app as if
 *   received over the radio; `radio <data hex> <optional hex>` reports each radio packet the app
 *   transmits, `supervisor <authorization>` each Supervisor API call;
 * - port 80, with `--supervisor <broker host>`: a stand-in for the Supervisor services API
 *   (`GET /services/mqtt`, token `test-token`), reached as `http://supervisor` through a network
 *   alias.
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Socket } from 'node:net';
import { PacketType } from '../../src/esp3/packet.ts';
import { fromHex, toHex } from '../../src/hex.ts';
import { FakeStickServer } from '../helpers/fake-stick.ts';

const STICK_PORT = 3333;
const CONTROL_PORT = 4000;
const TOKEN = 'test-token';

const stick = new FakeStickServer();
const controls = new Set<Socket>();
const report = (line: string): void => {
  for (const socket of controls) socket.write(`${line}\n`);
};

// Report every radio packet the app transmits.
const handle = stick.emulator.handle.bind(stick.emulator);
stick.emulator.handle = (packet) => {
  if (packet.type === PacketType.RADIO_ERP1)
    report(`radio ${toHex(packet.data)} ${toHex(packet.optional)}`);
  return handle(packet);
};

createServer((socket) => {
  controls.add(socket);
  socket.on('close', () => controls.delete(socket));
  socket.on('error', () => undefined);
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const [command, argument] = buffer.slice(0, end).trim().split(/\s+/);
      buffer = buffer.slice(end + 1);
      if (command === 'inject' && argument !== undefined) stick.inject(fromHex(argument));
      if (command === 'clients') socket.write(`clients ${stick.sockets.size}\n`);
    }
  });
}).listen(CONTROL_PORT, '0.0.0.0');

const supervisorIndex = process.argv.indexOf('--supervisor');
const brokerHost = supervisorIndex < 0 ? undefined : process.argv[supervisorIndex + 1];
if (brokerHost !== undefined) {
  createHttpServer((request, response) => {
    const authorization = request.headers.authorization ?? '';
    report(`supervisor ${authorization.replace(/\s+/g, '_')}`);
    const ok = request.url === '/services/mqtt' && authorization === `Bearer ${TOKEN}`;
    response.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(
        ok
          ? { result: 'ok', data: { host: brokerHost, port: 1883, ssl: false, protocol: '3.1.1' } }
          : { result: 'error', message: 'Unauthorized' },
      ),
    );
  }).listen(80, '0.0.0.0');
}

await stick.listen(STICK_PORT, '0.0.0.0');
process.stdout.write(`fake stick on ${STICK_PORT}, control on ${CONTROL_PORT}\n`);
process.on('SIGTERM', () => {
  void stick.close().then(() => process.exit(0));
});
