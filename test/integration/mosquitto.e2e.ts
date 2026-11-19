/**
 * End-to-end test against a real Mosquitto broker in Docker: the emulated stick over TCP, the
 * app composition used by `main.ts`, and an MQTT client watching the topics. Run with
 * `npm run test:integration`; skipped when Docker is not available, unless `REQUIRE_DOCKER=1`
 * (CI), where a missing Docker or image is an error.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { connectAsync, type MqttClient } from 'mqtt';
import { startApp, type RunningApp } from '../../src/bridge/app.ts';
import { loadOptions } from '../../src/bridge/config.ts';
import { createConsoleLogger } from '../../src/bridge/log.ts';
import { encodePacket, PacketType } from '../../src/esp3/packet.ts';
import { idToBytes, toHex } from '../../src/hex.ts';
import { tempDir } from '../helpers/fake-bridge.ts';
import { FakeStickServer, until } from '../helpers/fake-stick.ts';
import { loadVmiStatus, type TelegramLine } from '../helpers/fixtures.ts';

const IMAGE = 'eclipse-mosquitto:2.1.2-alpine';
const run = promisify(execFile);

async function dockerAvailable(): Promise<boolean> {
  try {
    await run('docker', ['image', 'inspect', IMAGE], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const available = await dockerAvailable();
if (!available) {
  if (process.env.REQUIRE_DOCKER === '1') {
    throw new Error(`REQUIRE_DOCKER=1 but Docker or the ${IMAGE} image is unavailable`);
  }
  process.stdout.write(`# Docker or the ${IMAGE} image is unavailable: end-to-end test skipped\n`);
}

/** The ESP3 packet the stick sends for a corpus line. */
function packet(line: TelegramLine): Uint8Array {
  const optional = new Uint8Array(7);
  optional[0] = 1;
  optional.set(idToBytes(line.destinationId), 1);
  optional[5] = line.dbm === undefined ? 0 : -line.dbm;
  return encodePacket({ type: PacketType.RADIO_ERP1, data: line.data, optional });
}

/** Collects every message received, last payload per topic. */
class Watcher {
  readonly last = new Map<string, string>();
  readonly retained = new Map<string, string>();
  readonly count = new Map<string, number>();

  constructor(client: MqttClient) {
    client.on('message', (topic, payload, packet) => {
      const text = payload.toString('utf8');
      this.last.set(topic, text);
      if (packet.retain) this.retained.set(topic, text);
      this.count.set(topic, (this.count.get(topic) ?? 0) + 1);
    });
  }

  json(topic: string): Record<string, unknown> {
    return JSON.parse(this.last.get(topic) ?? '{}') as Record<string, unknown>;
  }
}

describe('end to end with Mosquitto', { skip: !available }, () => {
  let container = '';
  let brokerPort = 0;
  let dir = '';
  const stick = new FakeStickServer();
  let app: RunningApp | undefined;
  let observer: MqttClient | undefined;
  let watcher: Watcher;
  const logs: string[] = [];

  before(async () => {
    const started = await run('docker', [
      'run',
      '--rm',
      '-d',
      '-p',
      '127.0.0.1::1883',
      IMAGE,
      'mosquitto',
      '-c',
      '/mosquitto-no-auth.conf',
    ]);
    container = started.stdout.trim();
    const port = await run('docker', ['port', container, '1883/tcp']);
    brokerPort = Number(/:(\d+)\s*$/m.exec(port.stdout)?.[1]);
    assert.ok(brokerPort > 0, `broker port from "${port.stdout}"`);

    await stick.listen();
    dir = await tempDir();
    const optionsPath = join(dir, 'options.json');
    await writeFile(
      optionsPath,
      JSON.stringify({
        serial_port: stick.url,
        vmi_id: '0400AA01',
        mqtt_host: '127.0.0.1',
        mqtt_port: brokerPort,
        log_level: 'debug',
      }),
    );

    // The broker may need a moment to accept connections.
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
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    watcher = new Watcher(observer);
    await observer.subscribeAsync(['ventilairsec2mqtt/#', 'homeassistant/#']);

    const { options } = await loadOptions(optionsPath);
    app = await startApp({
      options,
      stateFile: join(dir, 'state.json'),
      logger: createConsoleLogger('debug', (line) => logs.push(line)),
      mqttReconnectPeriodMs: 500,
    });
  });

  after(async () => {
    await app?.stop();
    await observer?.endAsync();
    await stick.close();
    if (container !== '')
      await run('docker', ['stop', '-t', '1', container]).catch(() => undefined);
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  it('publishes the bridge and its connection to the stick', async () => {
    await until(() => watcher.json('ventilairsec2mqtt/bridge').connection === true, 10_000);
    assert.equal(watcher.last.get('ventilairsec2mqtt/bridge/state'), 'online');
    assert.deepEqual(watcher.json('ventilairsec2mqtt/bridge'), {
      active_port: 'primary',
      base_id: 'FFAA0000',
      connection: true,
      sender_id: 'FFAA0000',
      stick_problem: false,
      stick_problem_reason: null,
    });
    assert.ok(watcher.last.has('homeassistant/device/ventilairsec2mqtt_bridge_0400AA01/config'));
  });

  it('turns corpus telegrams into retained discovery and JSON states', async () => {
    for (const line of loadVmiStatus()) if (line.seconds <= 521) stick.inject(packet(line));
    await until(
      () =>
        watcher.json('ventilairsec2mqtt/0400AA01').paired_sensors !== undefined &&
        watcher.last.has('ventilairsec2mqtt/0400AA02'),
      10_000,
    );
    const unit = watcher.json('ventilairsec2mqtt/0400AA01');
    assert.equal(unit.mode, 'standard');
    assert.equal(unit.airflow, 108);
    assert.equal(unit.outdoor_temperature, 12);
    assert.equal(unit.pressure_setpoint, 21.1);
    assert.equal(unit.filter_days_left, 334);
    assert.equal(unit.installation_date, '2019-06-15');
    assert.equal(unit.signal_strength, -68);
    const assistant = watcher.json('ventilairsec2mqtt/0400AA02');
    assert.equal(assistant.temperature, 20.45);
    assert.equal(assistant.battery, 67);

    // A new subscriber gets everything as retained messages.
    const late = await connectAsync({ host: '127.0.0.1', port: brokerPort, reconnectPeriod: 0 });
    const retained = new Watcher(late);
    await late.subscribeAsync(['ventilairsec2mqtt/#', 'homeassistant/#']);
    const expected = [
      'ventilairsec2mqtt/bridge/state',
      'ventilairsec2mqtt/bridge',
      'ventilairsec2mqtt/0400AA01',
      'ventilairsec2mqtt/0400AA01/availability',
      'ventilairsec2mqtt/0400AA02',
      'ventilairsec2mqtt/0400AA02/availability',
      'homeassistant/device/ventilairsec2mqtt_bridge_0400AA01/config',
      'homeassistant/device/ventilairsec2mqtt_0400AA01/config',
      'homeassistant/device/ventilairsec2mqtt_0400AA02/config',
    ];
    await until(() => expected.every((topic) => retained.retained.has(topic)), 5000);
    await late.endAsync();
    assert.equal(retained.retained.get('ventilairsec2mqtt/0400AA01/availability'), 'online');
    const discovery = JSON.parse(
      retained.retained.get('homeassistant/device/ventilairsec2mqtt_0400AA01/config') ?? '{}',
    ) as { dev: { name: string }; cmps: Record<string, { unique_id: string }> };
    assert.equal(discovery.dev.name, 'Ventilairsec Purevent');
    assert.equal(discovery.cmps.mode?.unique_id, 'ventilairsec2mqtt_0400AA01_mode');
    assert.equal(discovery.cmps.hydror_setpoint, undefined);
  });

  it('transmits an MQTT order as the exact radio telegram', async () => {
    assert.ok(observer);
    const before = stick.emulator.radio().length;
    // The clock was sent once after the connection (sync_clock defaults to on).
    assert.equal(toHex(stick.emulator.radio()[0]!.data).slice(0, 6), 'D10791');
    await observer.publishAsync(
      'ventilairsec2mqtt/0400AA01/set',
      '{"mode": "eco", "max_supply_temperature": 25}',
    );
    await until(() => stick.emulator.radio().length > before, 5000);
    const sent = stick.emulator.radio()[before]!;
    // RORG D1, 07 90, mode 01, ranks 2–5 unchanged, max supply 0x19, ranks 7–9 unchanged,
    // sender FFAA0000, status 80; optional data 03 | FFFFFFFF | FF | 00 (broadcast).
    assert.equal(toHex(sent.data), 'D1079001FFFFFFFF19FFFFFFFFAA000080');
    assert.equal(toHex(sent.optional), '03FFFFFFFFFF00');
    await until(() => watcher.json('ventilairsec2mqtt/0400AA01').mode === 'eco', 5000);
    assert.equal(watcher.json('ventilairsec2mqtt/0400AA01').max_supply_temperature, 25);
  });

  it('republishes discovery on the Home Assistant birth message', async () => {
    assert.ok(observer);
    const topic = 'homeassistant/device/ventilairsec2mqtt_0400AA01/config';
    const count = watcher.count.get(topic) ?? 0;
    await observer.publishAsync('homeassistant/status', 'online');
    await until(() => (watcher.count.get(topic) ?? 0) > count, 5000);
  });

  it('publishes offline on stop', async () => {
    await app?.stop();
    await until(() => watcher.last.get('ventilairsec2mqtt/bridge/state') === 'offline', 5000);
    assert.deepEqual(
      logs.filter((line) => line.includes(' ERROR ')),
      [],
    );
  });
});
