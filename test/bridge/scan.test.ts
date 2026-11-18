/**
 * Scan mode (empty vmi_id): device guesses on the corpus, logging, bridge device only, no
 * transmission.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConsoleLogger } from '../../src/bridge/log.ts';
import { DeviceScanner, ScanBridge } from '../../src/bridge/scan.ts';
import {
  ASSISTANT,
  BASE_ID,
  corpusTelegram,
  FakeLink,
  FakeMqtt,
  flush,
  telegram,
  UNIT,
  vmiStatus,
} from '../helpers/fake-bridge.ts';
import { FakeTimers } from '../helpers/fake-timers.ts';

const APP = { name: 'ventilairsec2mqtt', version: '1.2.3', supportUrl: undefined };
const SETTINGS = {
  senderId: undefined,
  topicPrefix: 'ventilairsec2mqtt',
  discoveryPrefix: 'homeassistant',
};
const DISCOVERY = 'homeassistant/device/ventilairsec2mqtt_bridge_scan/config';
/** UTE teach-in query from the unit (protocol.md § 7), broadcast. */
const TEACH_IN = 'D480FF79000001D1' + UNIT + '00';

function scanCorpus(baseId: string) {
  const scanner = new DeviceScanner();
  return {
    scanner,
    findings: vmiStatus().flatMap((line) => scanner.observe(corpusTelegram(line), { baseId })),
  };
}

describe('DeviceScanner', () => {
  it('finds the unit paired with the stick, its Assistant and its paired sensor list', () => {
    const { scanner, findings } = scanCorpus(BASE_ID);
    assert.deepEqual(
      findings.map((f) => [f.senderId, f.guess, f.destinationId]),
      [
        [UNIT, 'unit_to_us', BASE_ID],
        [ASSISTANT, 'assistant', UNIT],
        [ASSISTANT, 'assistant', undefined],
        [UNIT, 'unit_to_assistant', ASSISTANT],
      ],
    );
    assert.equal(
      findings[0]!.message,
      `Heard ${UNIT} → ${BASE_ID} (-67 dBm): ventilation unit (D1-079-01), status CMD 4 ` +
        `addressed to this stick (paired with it) → set vmi_id to ${UNIT}`,
    );
    assert.match(findings[1]!.message, /-55 dBm\): Assistant \(D1-079-00\), CMD 1 .* assistant_id/);
    assert.equal(
      findings[2]!.message,
      `Unit ${UNIT} lists paired sensor ${ASSISTANT} (profile assistant, room living_room) ` +
        '→ candidate for assistant_id',
    );
    assert.deepEqual(scanner.units, [UNIT]);
    assert.deepEqual(scanner.assistants, [ASSISTANT]);
  });

  it('guesses roles from the frames when the unit reports to another stick', () => {
    const { findings } = scanCorpus('FFBB0000');
    assert.deepEqual(
      findings.map((f) => [f.senderId, f.guess, f.destinationId]),
      [
        [UNIT, 'unknown', BASE_ID],
        [ASSISTANT, 'probable_assistant', UNIT],
        [UNIT, 'probable_unit', BASE_ID],
        [UNIT, 'probable_unit', ASSISTANT],
      ],
    );
    assert.match(findings[1]!.message, /probably an Assistant \(CMD 1; 20\.45 °C, 60 %\)/);
    assert.match(findings[2]!.message, /probably a ventilation unit .* candidate for vmi_id$/);
  });

  it('treats any ID of the Base ID range and the sender_id option as ours', () => {
    const status = 'D10791006C000403' + UNIT + '00';
    for (const destination of ['FFAA0000', 'FFAA007F']) {
      const [finding] = new DeviceScanner().observe(telegram(status, destination), {
        baseId: BASE_ID,
      });
      assert.equal(finding?.guess, 'unit_to_us', destination);
    }
    const outside = new DeviceScanner().observe(telegram(status, 'FFAA0080'), { baseId: BASE_ID });
    assert.notEqual(outside[0]?.guess, 'unit_to_us');
    const option = new DeviceScanner().observe(telegram(status, '0400BB00'), {
      baseId: BASE_ID,
      senderId: '0400BB00',
    });
    assert.equal(option[0]?.guess, 'unit_to_us');
  });

  it('reports teach-in queries, then knows the sender is a unit', () => {
    const scanner = new DeviceScanner();
    const [query] = scanner.observe(telegram(TEACH_IN, 'FFFFFFFF', -80), { baseId: BASE_ID });
    assert.equal(query?.guess, 'teach_in');
    assert.equal(
      query.message,
      `Heard ${UNIT} → FFFFFFFF (-80 dBm): ventilation unit asking to pair (UTE teach-in ` +
        'query, sent for about 6 h after power-on) → candidate for vmi_id',
    );
    assert.deepEqual(scanner.units, [UNIT]);
    // Same query again: nothing new.
    assert.deepEqual(scanner.observe(telegram(TEACH_IN, 'FFFFFFFF'), { baseId: BASE_ID }), []);
    // Another manufacturer's query is reported as such.
    const other = scanner.observe(telegram('D480FF46000001D1' + '0400CC01' + '00', 'FFFFFFFF'), {
      baseId: BASE_ID,
    });
    assert.match(other[0]?.message ?? '', /another manufacturer \(0x046\), ignored/);
  });

  it('ignores other radio profiles and manufacturers', () => {
    const scanner = new DeviceScanner();
    const own = { baseId: BASE_ID };
    assert.deepEqual(scanner.observe(telegram('F630' + '0400CC02' + '30', 'FFFFFFFF'), own), []);
    assert.deepEqual(scanner.observe(telegram('D10460' + '0400CC03' + '00', BASE_ID), own), []);
  });
});

describe('ScanBridge', () => {
  function setup() {
    const link = new FakeLink();
    const mqtt = new FakeMqtt();
    const lines: string[] = [];
    const timers = new FakeTimers();
    const bridge = new ScanBridge({
      settings: SETTINGS,
      app: APP,
      link,
      mqtt,
      timers,
      logger: createConsoleLogger('info', (line) => lines.push(line), undefined, 'plain'),
    });
    bridge.start();
    return { link, mqtt, lines, bridge, timers };
  }

  it('publishes only the bridge device and its state', () => {
    const { link, mqtt, bridge } = setup();
    bridge.onMqttConnected();
    link.connect();
    assert.deepEqual(bridge.subscriptions(), ['homeassistant/status']);
    const topics = [...new Set(mqtt.published.map((p) => p.topic))].sort();
    assert.deepEqual(topics, [
      DISCOVERY,
      'ventilairsec2mqtt/bridge',
      'ventilairsec2mqtt/bridge/state',
    ]);
    const discovery = mqtt.json(DISCOVERY) as { dev: { identifiers: string[] } };
    assert.deepEqual(discovery.dev.identifiers, ['ventilairsec2mqtt_bridge_scan']);
    assert.deepEqual(mqtt.json('ventilairsec2mqtt/bridge'), {
      active_port: 'primary',
      base_id: BASE_ID,
      connection: true,
      sender_id: BASE_ID,
      stick_problem: false,
      stick_problem_reason: null,
    });
    mqtt.clear();
    bridge.handleMessage('homeassistant/status', 'online');
    assert.ok(mqtt.last(DISCOVERY) !== undefined);
  });

  it('logs each finding once and never transmits', () => {
    const { link, lines } = setup();
    link.connect();
    for (const line of vmiStatus()) link.emit('telegram', corpusTelegram(line));
    link.emit('telegram', telegram(TEACH_IN, 'FFFFFFFF'));
    const findings = lines.filter(
      (line) => line.startsWith('INFO Heard') || line.includes('lists'),
    );
    assert.equal(findings.length, 5);
    assert.ok(lines[0]?.startsWith('WARNING vmi_id is empty: scan mode'));
    assert.deepEqual(link.sent, []);
  });

  it('raises and clears the stick problem', () => {
    const { link, mqtt, bridge, timers } = setup();
    bridge.onMqttConnected();
    link.connect();
    link.emit('incident', { reason: 'no_answer', detail: 'no answer' });
    assert.equal(mqtt.json('ventilairsec2mqtt/bridge').stick_problem_reason, 'no_answer');
    timers.advance(30 * 60_000);
    assert.equal(mqtt.json('ventilairsec2mqtt/bridge').stick_problem, false);
  });

  it('removes its device and publishes offline on stop', async () => {
    const { mqtt, bridge } = setup();
    bridge.onMqttConnected();
    await bridge.stop();
    await flush();
    assert.equal(mqtt.retained.has(DISCOVERY), false);
    assert.equal(mqtt.last(DISCOVERY), '');
    assert.equal(mqtt.last('ventilairsec2mqtt/bridge/state'), 'offline');
  });
});
