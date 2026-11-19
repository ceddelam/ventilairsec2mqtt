/**
 * End-to-end test of the Home Assistant app image (`npm run test:app`), with Docker only:
 * builds the image as the CI does (repository root context) and as the Supervisor does (the
 * folder made by `npm run app:local`), then starts on a dedicated Docker network a Mosquitto
 * broker, an emulated stick served over TCP with a stand-in Supervisor API
 * (`fake-stick-server.ts`), and the app with a mounted `/data/options.json`. Checks discovery,
 * states, an order reaching the stick, scan mode, and a clean `docker stop`. Everything it starts
 * is removed afterwards. Skipped when Docker or the base images are missing, unless
 * `REQUIRE_DOCKER=1` (CI), where that is an error.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { connectAsync, type MqttClient } from 'mqtt';
import { encodePacket, PacketType } from '../../src/esp3/packet.ts';
import { idToBytes, toHex } from '../../src/hex.ts';
import { tempDir } from '../helpers/fake-bridge.ts';
import { until } from '../helpers/fake-stick.ts';
import { loadVmiStatus, type TelegramLine } from '../helpers/fixtures.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const MOSQUITTO = 'eclipse-mosquitto:2.1.2-alpine';
const NODE = 'node:24-alpine';
const BASE = 'ghcr.io/home-assistant/base:3.24-2026.11.0';
const IMAGE = 'ventilairsec2mqtt:e2e';
const LOCAL_IMAGE = 'ventilairsec2mqtt:e2e-local';
const TZ = 'Pacific/Kiritimati';
const run = promisify(execFile);
const docker = async (args: string[], timeout = 60_000): Promise<string> =>
  (await run('docker', args, { timeout, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();

async function dockerReady(): Promise<boolean> {
  try {
    await docker(['image', 'inspect', MOSQUITTO, NODE, BASE], 15_000);
    return true;
  } catch {
    return false;
  }
}

const available = await dockerReady();
if (!available) {
  if (process.env.REQUIRE_DOCKER === '1') {
    throw new Error(
      `REQUIRE_DOCKER=1 but Docker or one of ${MOSQUITTO}, ${NODE}, ${BASE} is missing`,
    );
  }
  process.stdout.write(`# Docker or one of ${MOSQUITTO}, ${NODE}, ${BASE} missing: skipped\n`);
}

/** The ESP3 packet the stick sends for a corpus line. */
function packet(line: TelegramLine): Uint8Array {
  const optional = new Uint8Array(7);
  optional[0] = 1;
  optional.set(idToBytes(line.destinationId), 1);
  optional[5] = line.dbm === undefined ? 0 : -line.dbm;
  return encodePacket({ type: PacketType.RADIO_ERP1, data: line.data, optional });
}

/** Line-based client of the fake stick's control port. */
class Control {
  readonly lines: string[] = [];
  readonly #socket: Socket;

  private constructor(socket: Socket) {
    this.#socket = socket;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        this.lines.push(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    });
  }

  static async open(port: number): Promise<Control> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const socket = await new Promise<Socket>((resolve, reject) => {
          const s = connect(port, '127.0.0.1', () => {
            resolve(s);
          });
          s.once('error', reject);
        });
        const control = new Control(socket);
        // A published port accepts connections before the process listens: ask for an answer.
        socket.write('clients\n');
        await until(() => control.lines.some((l) => l.startsWith('clients')), 1000);
        return control;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }

  inject(bytes: Uint8Array): void {
    this.#socket.write(`inject ${toHex(bytes)}\n`);
  }

  radio(): { data: string; optional: string }[] {
    return this.lines
      .filter((line) => line.startsWith('radio '))
      .map((line) => {
        const [, data = '', optional = ''] = line.split(' ');
        return { data, optional };
      });
  }

  close(): void {
    this.#socket.destroy();
  }
}

/** Collects every message received, last payload per topic. */
class Watcher {
  readonly last = new Map<string, string>();
  readonly retained = new Map<string, string>();

  constructor(client: MqttClient) {
    client.on('message', (topic, payload, message) => {
      const text = payload.toString('utf8');
      this.last.set(topic, text);
      if (message.retain) this.retained.set(topic, text);
    });
  }

  json(topic: string): Record<string, unknown> {
    const text = this.last.get(topic);
    return text === undefined || text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  }
}

function hourIn(timeZone: string, date: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(date),
  );
}

describe('Home Assistant app image', { skip: !available, timeout: 15 * 60_000 }, () => {
  const id = randomBytes(3).toString('hex');
  const network = `v2m-e2e-${id}`;
  const names = {
    broker: `v2m-e2e-${id}-mqtt`,
    stick: `v2m-e2e-${id}-stick`,
    app: `v2m-e2e-${id}-app`,
    scan: `v2m-e2e-${id}-scan`,
  };
  const started: string[] = [];
  let dir = '';
  let observer: MqttClient | undefined;
  let watcher: Watcher;
  let control: Control | undefined;
  let brokerPort = 0;

  const publishedPort = async (container: string, port: string): Promise<number> => {
    const text = await docker(['port', container, port]);
    const value = Number(/:(\d+)\s*$/m.exec(text)?.[1]);
    assert.ok(value > 0, `published port of ${container} from "${text}"`);
    return value;
  };

  const startApp = async (name: string, options: object, env: string[] = []): Promise<void> => {
    const data = join(dir, name);
    await mkdir(data, { recursive: true });
    await writeFile(join(data, 'options.json'), JSON.stringify(options));
    started.push(name);
    await docker([
      'run',
      '-d',
      '--name',
      name,
      '--network',
      network,
      '-e',
      `TZ=${TZ}`,
      ...env.flatMap((e) => ['-e', e]),
      '-v',
      `${data}:/data`,
      IMAGE,
    ]);
  };

  /** Polls the container's logs until `pattern` appears; returns the logs. */
  const waitForLog = async (name: string, pattern: RegExp, timeoutMs = 30_000): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { stdout, stderr } = await run('docker', ['logs', name], { maxBuffer: 1 << 26 });
      const logs = stdout + stderr;
      if (pattern.test(logs)) return logs;
      if (Date.now() > deadline) assert.fail(`${pattern} not in the logs of ${name}:\n${logs}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  /** `docker stop`, then the exit code and the time it took. */
  const stop = async (name: string): Promise<{ exitCode: number; seconds: number }> => {
    const begin = Date.now();
    await docker(['stop', '-t', '10', name], 30_000);
    const seconds = (Date.now() - begin) / 1000;
    const exitCode = Number(await docker(['inspect', '-f', '{{.State.ExitCode}}', name]));
    return { exitCode, seconds };
  };

  /** Dangling images (build stages left by the legacy builder) present before the builds. */
  let danglingBefore = new Set<string>();
  const dangling = async (): Promise<Set<string>> =>
    new Set((await docker(['images', '-q', '-f', 'dangling=true'])).split('\n').filter(Boolean));

  before(async () => {
    dir = await tempDir();
    danglingBefore = await dangling();
    await docker(['build', '-q', '-f', 'ventilairsec2mqtt/Dockerfile', '-t', IMAGE, ROOT], 900_000);
    await docker(['network', 'create', network]);
    started.push(names.broker);
    await docker([
      'run',
      '-d',
      '--name',
      names.broker,
      '--network',
      network,
      '-p',
      '127.0.0.1::1883',
      MOSQUITTO,
      'mosquitto',
      '-c',
      '/mosquitto-no-auth.conf',
    ]);
    started.push(names.stick);
    await docker([
      'run',
      '-d',
      '--name',
      names.stick,
      '--network',
      network,
      '--network-alias',
      'supervisor',
      '-p',
      '127.0.0.1::4000',
      '-v',
      `${ROOT}:/work:ro`,
      '-w',
      '/work',
      NODE,
      'node',
      'test/packaging/fake-stick-server.ts',
      '--supervisor',
      names.broker,
    ]);
    control = await Control.open(await publishedPort(names.stick, '4000/tcp'));

    brokerPort = await publishedPort(names.broker, '1883/tcp');
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        observer = await connectAsync({
          host: '127.0.0.1',
          port: brokerPort,
          reconnectPeriod: 0,
          connectTimeout: 2000,
        });
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    watcher = new Watcher(observer);
    await observer.subscribeAsync(['ventilairsec2mqtt/#', 'homeassistant/#']);
  });

  after(async () => {
    control?.close();
    await observer?.endAsync().catch(() => undefined);
    if (started.length > 0) await docker(['rm', '-f', ...started]).catch(() => undefined);
    await docker(['network', 'rm', network]).catch(() => undefined);
    await docker(['rmi', IMAGE, LOCAL_IMAGE]).catch(() => undefined);
    const leftovers = [...(await dangling())].filter((image) => !danglingBefore.has(image));
    if (leftovers.length > 0) await docker(['rmi', ...leftovers]).catch(() => undefined);
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  it('ships only the runtime: labels, no sources, no dev dependencies, native binding', async () => {
    const labels = JSON.parse(
      await docker(['image', 'inspect', '-f', '{{json .Config.Labels}}', IMAGE]),
    ) as Record<string, string>;
    assert.equal(labels['io.hass.type'], 'app');
    assert.equal(labels['io.hass.name'], 'ventilairsec2mqtt');
    assert.equal(labels['org.opencontainers.image.licenses'], 'MIT');
    const size = Number(await docker(['image', 'inspect', '-f', '{{.Size}}', IMAGE]));
    process.stdout.write(`# image size: ${(size / 1e6).toFixed(1)} MB\n`);
    const check = await docker([
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      IMAGE,
      '-c',
      'cd /app && ls && ls node_modules/typescript node_modules/eslint src 2>&1; ' +
        'find node_modules/@serialport/bindings-cpp/prebuilds -name "*.node"; ' +
        'node dist/main.js --version; ' +
        "node --input-type=module -e \"import { autoDetect } from '@serialport/bindings-cpp'; " +
        "autoDetect().open({ path: '/dev/ttyUSB-missing', baudRate: 57600 })" +
        ".catch((e) => console.log('binding:', e.message));\"",
    ]);
    assert.match(check, /^dist\nnode_modules\npackage\.json\n/);
    assert.match(check, /node_modules\/typescript: No such file or directory/);
    assert.match(check, /node_modules\/eslint: No such file or directory/);
    assert.match(check, /linux-x64\/@serialport\+bindings-cpp\.musl\.node/);
    assert.match(check, /linux-arm64\/@serialport\+bindings-cpp\.armv8\.musl\.node/);
    assert.doesNotMatch(check, /glibc|darwin|win32/);
    assert.match(check, /\n0\.1\.0\n/);
    assert.match(check, /binding: Error: No such file or directory, cannot open/);
  });

  it('connects to the stick and to the Supervisor broker, publishes the bridge', async () => {
    await startApp(
      names.app,
      { serial_port: `socket://${names.stick}:3333`, vmi_id: '0400AA01', log_level: 'debug' },
      ['SUPERVISOR_TOKEN=test-token'],
    );
    await until(() => watcher.json('ventilairsec2mqtt/bridge').connection === true, 60_000);
    assert.ok(control?.lines.includes('supervisor Bearer_test-token'));
    assert.equal(watcher.last.get('ventilairsec2mqtt/bridge/state'), 'online');
    assert.ok(watcher.last.has('homeassistant/device/ventilairsec2mqtt_bridge_0400AA01/config'));
    assert.equal(watcher.json('ventilairsec2mqtt/bridge').sender_id, 'FFAA0000');
  });

  it('sends the clock in the time zone of the container', async () => {
    await until(() => (control?.radio().length ?? 0) > 0, 10_000);
    const clock = control?.radio()[0]?.data ?? '';
    assert.equal(clock.slice(0, 6), 'D10791');
    const hour = Number.parseInt(clock.slice(12, 14), 16);
    const now = new Date();
    const expected = [hourIn(TZ, new Date(now.getTime() - 60_000)), hourIn(TZ, now)];
    assert.ok(
      expected.includes(hour),
      `clock hour ${hour}, expected one of ${expected.join(', ')}`,
    );
  });

  it('turns corpus telegrams into discovery and JSON states', async () => {
    for (const line of loadVmiStatus()) if (line.seconds <= 521) control?.inject(packet(line));
    await until(
      () =>
        watcher.json('ventilairsec2mqtt/0400AA01').paired_sensors !== undefined &&
        watcher.last.has('homeassistant/device/ventilairsec2mqtt_0400AA01/config'),
      20_000,
    );
    const unit = watcher.json('ventilairsec2mqtt/0400AA01');
    assert.equal(unit.mode, 'standard');
    assert.equal(unit.airflow, 108);
    assert.equal(unit.filter_days_left, 334);
    assert.equal(watcher.last.get('ventilairsec2mqtt/0400AA01/availability'), 'online');

    // A new subscriber (Home Assistant after a restart) gets everything as retained messages.
    const late = await connectAsync({ host: '127.0.0.1', port: brokerPort, reconnectPeriod: 0 });
    const retained = new Watcher(late);
    await late.subscribeAsync(['ventilairsec2mqtt/#', 'homeassistant/#']);
    const expected = [
      'ventilairsec2mqtt/bridge/state',
      'ventilairsec2mqtt/bridge',
      'ventilairsec2mqtt/0400AA01',
      'ventilairsec2mqtt/0400AA02',
      'homeassistant/device/ventilairsec2mqtt_bridge_0400AA01/config',
      'homeassistant/device/ventilairsec2mqtt_0400AA01/config',
      'homeassistant/device/ventilairsec2mqtt_0400AA02/config',
    ];
    await until(() => expected.every((topic) => retained.retained.has(topic)), 5000).finally(() =>
      late.endAsync(),
    );
  });

  it('transmits an MQTT order to the stick', async () => {
    assert.ok(observer && control);
    const count = control.radio().length;
    await observer.publishAsync('ventilairsec2mqtt/0400AA01/set', '{"mode": "eco"}');
    await until(() => control!.radio().length > count, 10_000);
    const sent = control.radio()[count]!;
    assert.equal(sent.data, 'D1079001FFFFFFFFFFFFFFFFFFAA000080');
    assert.equal(sent.optional, '03FFFFFFFFFF00');
    await until(() => watcher.json('ventilairsec2mqtt/0400AA01').mode === 'eco', 10_000);
  });

  it('publishes offline and exits 0 on docker stop', async () => {
    const { exitCode, seconds } = await stop(names.app);
    process.stdout.write(`# docker stop took ${seconds.toFixed(1)} s\n`);
    assert.equal(exitCode, 0);
    assert.ok(seconds < 10, `stopped in ${seconds} s`);
    await until(() => watcher.last.get('ventilairsec2mqtt/bridge/state') === 'offline', 5000);
    const logs = await waitForLog(names.app, /INFO Stopped/);
    assert.match(logs, /SIGTERM received, stopping/);
    assert.match(logs, /INFO Stopped/);
    assert.doesNotMatch(logs, / ERROR /);
  });

  it('runs in scan mode with an empty vmi_id and an external broker', async () => {
    assert.ok(control);
    await startApp(names.scan, {
      serial_port: `socket://${names.stick}:3333`,
      vmi_id: '',
      mqtt_host: names.broker,
    });
    const discovery = 'homeassistant/device/ventilairsec2mqtt_bridge_scan/config';
    await until(() => watcher.last.has(discovery), 60_000);
    await waitForLog(names.scan, /Scan mode: listening \(stick Base ID FFAA0000\)/);
    const radioBefore = control.radio().length;
    for (const line of loadVmiStatus()) if (line.seconds <= 521) control.inject(packet(line));
    const logs = await waitForLog(names.scan, /lists paired sensor 0400AA02/);
    assert.match(logs, /WARNING vmi_id is empty: scan mode/);
    assert.match(logs, /INFO Heard 0400AA01 → FFAA0000 .* set vmi_id to 0400AA01/);
    assert.match(logs, /INFO Heard 0400AA02 → 0400AA01 .* Assistant/);
    assert.equal(control.radio().length, radioBefore, 'scan mode transmits nothing');
    const { exitCode } = await stop(names.scan);
    assert.equal(exitCode, 0);
    await until(() => watcher.last.get(discovery) === '', 5000);
  });

  it('builds from the self-contained local app folder, as the Supervisor does', async () => {
    await run('node', [join(ROOT, 'scripts/app-local.mjs')], { cwd: ROOT, timeout: 60_000 });
    await docker(
      ['build', '-q', '-t', LOCAL_IMAGE, join(ROOT, '.local-app/ventilairsec2mqtt')],
      900_000,
    );
    const version = await docker([
      'run',
      '--rm',
      LOCAL_IMAGE,
      '/command/with-contenv',
      'node',
      '/app/dist/main.js',
      '--version',
    ]);
    assert.match(version, /^0\.1\.0$/m);
  });
});
