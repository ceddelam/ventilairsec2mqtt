/**
 * Bridge behaviour with a fake link, a fake MQTT client and manual timers: publication of
 * discovery and states from corpus telegrams, orders and the exact radio telegrams produced,
 * optimistic state, availability, stick problems, teach-in, Assistant ID learning, republish
 * on the Home Assistant birth message.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bridge, type BridgeSettings } from '../../src/bridge/bridge.ts';
import type { Logger } from '../../src/logger.ts';
import {
  ASSISTANT,
  corpusTelegram,
  FakeLink,
  FakeMqtt,
  flush,
  MemoryStore,
  telegram,
  UNIT,
  vmiStatus,
} from '../helpers/fake-bridge.ts';
import { FakeTimers } from '../helpers/fake-timers.ts';

// Clock orders are encoded in local time: pin the zone.
process.env.TZ = 'UTC';

const SETTINGS: BridgeSettings = {
  vmiId: UNIT,
  assistantId: undefined,
  senderId: undefined,
  syncClock: false,
  acceptPairing: true,
  topicPrefix: 'ventilairsec2mqtt',
  discoveryPrefix: 'homeassistant',
};
const APP = { name: 'ventilairsec2mqtt', version: '1.2.3', supportUrl: undefined };
const MIN = 60_000;

const T = {
  bridgeAvailability: 'ventilairsec2mqtt/bridge/state',
  bridge: 'ventilairsec2mqtt/bridge',
  unit: 'ventilairsec2mqtt/0400AA01',
  unitAvailability: 'ventilairsec2mqtt/0400AA01/availability',
  assistant: 'ventilairsec2mqtt/0400AA02',
  assistantAvailability: 'ventilairsec2mqtt/0400AA02/availability',
  set: 'ventilairsec2mqtt/0400AA01/set',
  unitDiscovery: 'homeassistant/device/ventilairsec2mqtt_0400AA01/config',
  assistantDiscovery: 'homeassistant/device/ventilairsec2mqtt_0400AA02/config',
  bridgeDiscovery: 'homeassistant/device/ventilairsec2mqtt_bridge_0400AA01/config',
};

/** Settings frame (CMD 0) as transmitted: `D1 07 90 <9 ranks> FFAA0000 80`, broadcast. */
function settingsFrame(ranks: string): string {
  return `D10790${ranks}FFAA000080 > FFFFFFFF`;
}

function setup(
  settings: Partial<BridgeSettings> = {},
  store = new MemoryStore(),
  refreshOnConnect = false,
) {
  const timers = new FakeTimers();
  const link = new FakeLink();
  const mqtt = new FakeMqtt();
  const logs: string[] = [];
  const push = (level: string) => (message: string) => {
    logs.push(`${level} ${message}`);
  };
  const logger: Logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
  const bridge = new Bridge({
    settings: { ...SETTINGS, ...settings },
    app: APP,
    link,
    mqtt,
    store,
    timers,
    logger,
    refreshOnConnect,
  });
  bridge.start();
  bridge.onMqttConnected();
  /** Feeds the corpus lines with `first <= seconds <= last`. */
  const feed = (first: number, last: number): void => {
    for (const line of vmiStatus()) {
      if (line.seconds >= first && line.seconds <= last) {
        link.emit('telegram', corpusTelegram(line));
      }
    }
  };
  /** Sends an order and waits for it to be handled. */
  const order = async (topic: string, payload: string): Promise<void> => {
    bridge.handleMessage(topic, payload);
    await bridge.idle();
    await flush();
  };
  return { bridge, link, mqtt, timers, store, logs, feed, order };
}

describe('publication', () => {
  it('publishes the bridge on MQTT connection, then the stick state', () => {
    const { mqtt, link } = setup();
    assert.equal(mqtt.retained.get(T.bridgeAvailability), 'online');
    const discovery = JSON.parse(mqtt.retained.get(T.bridgeDiscovery) ?? '{}') as {
      cmps: object;
    };
    assert.deepEqual(Object.keys(discovery.cmps), [
      'connection',
      'stick_problem',
      'active_port',
      'sender_id',
    ]);
    assert.deepEqual(mqtt.json(T.bridge), {
      active_port: 'primary',
      connection: false,
      stick_problem: false,
      stick_problem_reason: null,
    });
    assert.equal(mqtt.retained.has(T.unitDiscovery), false);
    link.connect();
    assert.deepEqual(mqtt.json(T.bridge), {
      active_port: 'primary',
      base_id: 'FFAA0000',
      connection: true,
      sender_id: 'FFAA0000',
      stick_problem: false,
      stick_problem_reason: null,
    });
    link.emit('portSwitched', { from: 'primary', to: 'fallback', reason: 'primary_failures' });
    assert.equal(mqtt.json(T.bridge).active_port, 'fallback');
    link.emit('disconnected', { port: 'fallback', url: 'x', reason: 'closed', detail: 'gone' });
    assert.equal(mqtt.json(T.bridge).connection, false);
    assert.ok(mqtt.published.every((p) => p.retain));
  });

  it('publishes the unit and the learned Assistant from a corpus status set', () => {
    const { mqtt, link, store, feed, bridge } = setup();
    link.connect();
    feed(0, 521);
    // Discovery of the unit once CMD 4–7 are known (at 520), not again at 521 (unchanged).
    assert.equal(mqtt.on(T.unitDiscovery).length, 1);
    const discovery = mqtt.json(T.unitDiscovery) as {
      dev: { name: string; serial_number: string };
    };
    assert.equal(discovery.dev.name, 'Ventilairsec Purevent');
    assert.equal(discovery.dev.serial_number, '0A0B0C0D');
    const state = mqtt.json(T.unit);
    assert.equal(state.mode, 'standard');
    assert.equal(state.airflow, 108);
    assert.equal(state.boost_duration, 30);
    assert.equal(state.holiday_duration, 7);
    assert.equal(mqtt.retained.get(T.unitAvailability), 'online');
    // Assistant learned from its frame at 188, confirmed by the paired list at 521.
    assert.equal(bridge.assistantId, ASSISTANT);
    assert.equal(store.state.learnedAssistantId, ASSISTANT);
    assert.ok(mqtt.retained.has(T.assistantDiscovery));
    assert.deepEqual(mqtt.json(T.assistant), {
      battery: 67,
      battery_raw: 4,
      humidity: 60,
      last_seen: new Date(new FakeTimers().now()).toISOString(),
      signal_strength: -55,
      temperature: 20.45,
    });
    assert.equal(mqtt.retained.get(T.assistantAvailability), 'online');
  });

  it('never decodes unit frames to the Assistant as status, known Assistant or not', () => {
    for (const assistantId of [undefined, ASSISTANT]) {
      const { mqtt, link, feed } = setup({ assistantId });
      link.connect();
      feed(513, 521);
      const before = mqtt.last(T.unit);
      // 3224: unit → Assistant short CMD 0 `07 90 13 00 01 1F`.
      feed(3224, 3224);
      const after = JSON.parse(mqtt.last(T.unit) ?? '{}') as Record<string, unknown>;
      const expected = JSON.parse(before ?? '{}') as Record<string, unknown>;
      assert.equal(after.mode, 'standard');
      assert.equal(after.max_supply_temperature, expected.max_supply_temperature);
    }
  });

  it('republishes discovery and states on the Home Assistant birth message', () => {
    const { mqtt, link, feed, bridge } = setup();
    link.connect();
    feed(0, 521);
    mqtt.clear();
    bridge.handleMessage('homeassistant/status', 'offline');
    assert.equal(mqtt.published.length, 0);
    bridge.handleMessage('homeassistant/status', 'online');
    assert.deepEqual(
      mqtt.published.map((p) => p.topic),
      [
        T.bridgeAvailability,
        T.bridgeDiscovery,
        T.bridge,
        T.unitDiscovery,
        T.unit,
        T.unitAvailability,
        T.assistantDiscovery,
        T.assistant,
        T.assistantAvailability,
      ],
    );
  });

  it('keeps the retained unit state of the previous run until a status frame arrives', async () => {
    const { mqtt, link, order, feed } = setup();
    assert.equal(mqtt.on(T.unit).length, 0);
    link.connect();
    await order(`${T.set}/boost_duration`, '45');
    assert.equal(mqtt.on(T.unit).length, 0);
    feed(513, 513);
    assert.equal(mqtt.json(T.unit).boost_duration, 45);
  });

  it('publishes nothing while disconnected from the broker', () => {
    const { mqtt, link, feed } = setup();
    mqtt.connected = false;
    mqtt.clear();
    link.connect();
    feed(0, 521);
    assert.equal(mqtt.published.length, 0);
  });

  it('updates discovery when optional equipment appears and disappears', () => {
    const { mqtt, link, feed } = setup();
    link.connect();
    feed(513, 521);
    mqtt.clear();
    // CMD 4 with Hydro'R (bit 31).
    link.emit('telegram', telegram('D107940101012C13060F370400AA0100', 'FFAA0000'));
    let updates = mqtt.on(T.unitDiscovery).map((p) => JSON.parse(p.payload) as { cmps: object });
    assert.equal(updates.length, 1);
    assert.ok('hydror_setpoint' in updates[0]!.cmps);
    mqtt.clear();
    link.emit('telegram', telegram('D107940104012C13060F370400AA0100', 'FFAA0000'));
    updates = mqtt.on(T.unitDiscovery).map((p) => JSON.parse(p.payload) as { cmps: object });
    assert.equal(updates.length, 2);
    const [removal, final] = updates as [
      { cmps: Record<string, unknown> },
      { cmps: Record<string, unknown> },
    ];
    assert.deepEqual(removal.cmps.hydror_setpoint, { p: 'select' });
    assert.deepEqual(removal.cmps.hydror_valve_opening, { p: 'sensor' });
    assert.deepEqual(removal.cmps.water_loop_duty_cycle, { p: 'sensor' });
    assert.equal('hydror_setpoint' in final.cmps, false);
    assert.equal(mqtt.retained.get(T.unitDiscovery), JSON.stringify(final));
  });
});

describe('Assistant ID', () => {
  it('prefers the paired list over a frame sender and removes the old device', () => {
    const { mqtt, link, store, bridge } = setup();
    link.connect();
    // An Assistant-like frame from 0400AA09 to the unit.
    link.emit('telegram', telegram('D1079104179D3C0400AA0900', UNIT));
    assert.equal(bridge.assistantId, '0400AA09');
    assert.ok(mqtt.retained.has('homeassistant/device/ventilairsec2mqtt_0400AA09/config'));
    // CMD 8: the unit lists 0400AA02 as its Assistant.
    link.emit('telegram', telegram('D107980400AA020101090400AA0100', 'FFAA0000'));
    assert.equal(bridge.assistantId, ASSISTANT);
    assert.equal(store.state.learnedAssistantId, ASSISTANT);
    assert.equal(mqtt.last('homeassistant/device/ventilairsec2mqtt_0400AA09/config'), '');
    assert.equal(
      mqtt.retained.has('homeassistant/device/ventilairsec2mqtt_0400AA09/config'),
      false,
    );
    assert.ok(mqtt.retained.has(T.assistantDiscovery));
    // A frame from another sender no longer changes it.
    link.emit('telegram', telegram('D1079104179D3C0400AA0900', UNIT));
    assert.equal(bridge.assistantId, ASSISTANT);
  });

  it('starts from the state file', () => {
    const { bridge, mqtt } = setup({}, new MemoryStore({ learnedAssistantId: ASSISTANT }));
    assert.equal(bridge.assistantId, ASSISTANT);
    assert.ok(mqtt.retained.has(T.assistantDiscovery));
  });

  it('never learns when configured, and removes a previously learned device', () => {
    const store = new MemoryStore({ learnedAssistantId: '0400AA09' });
    const { bridge, mqtt, link } = setup({ assistantId: ASSISTANT }, store);
    assert.equal(mqtt.last('homeassistant/device/ventilairsec2mqtt_0400AA09/config'), '');
    link.connect();
    link.emit('telegram', telegram('D107980400AA030101090400AA0100', 'FFAA0000'));
    assert.equal(bridge.assistantId, ASSISTANT);
    assert.equal(store.updates, 0);
  });
});

describe('availability and stick problems', () => {
  it('goes offline after 30 min without a frame and back online on the next one', () => {
    const { mqtt, link, feed, timers } = setup();
    link.connect();
    feed(0, 521);
    assert.equal(mqtt.retained.get(T.unitAvailability), 'online');
    timers.advance(30 * MIN - 1);
    assert.equal(mqtt.retained.get(T.unitAvailability), 'online');
    timers.advance(1);
    assert.equal(mqtt.retained.get(T.unitAvailability), 'offline');
    assert.equal(mqtt.retained.get(T.assistantAvailability), 'offline');
    feed(513, 513);
    assert.equal(mqtt.retained.get(T.unitAvailability), 'online');
    assert.equal(mqtt.retained.get(T.assistantAvailability), 'offline');
  });

  it('marks a unit never heard offline 30 min after the start', () => {
    const { mqtt, timers } = setup();
    assert.equal(mqtt.retained.has(T.unitAvailability), false);
    timers.advance(30 * MIN);
    assert.equal(mqtt.retained.get(T.unitAvailability), 'offline');
  });

  it('raises stick_problem on incidents and clears it 30 min after the last one', () => {
    const { mqtt, link, timers } = setup();
    link.connect();
    link.emit('incident', { reason: 'no_answer', detail: 'x' });
    assert.equal(mqtt.json(T.bridge).stick_problem, true);
    assert.equal(mqtt.json(T.bridge).stick_problem_reason, 'no_answer');
    timers.advance(20 * MIN);
    link.emit('incident', { reason: 'transmission_not_confirmed', detail: 'y' });
    assert.equal(mqtt.json(T.bridge).stick_problem_reason, 'transmission_not_confirmed');
    timers.advance(30 * MIN - 1);
    assert.equal(mqtt.json(T.bridge).stick_problem, true);
    timers.advance(1);
    assert.equal(mqtt.json(T.bridge).stick_problem, false);
    assert.equal(mqtt.json(T.bridge).stick_problem_reason, null);
  });

  it('flags a status frame with another machine ID and ignores it', () => {
    const { mqtt, link, feed } = setup();
    link.connect();
    feed(513, 521);
    // CMD 3 with machine ID 0A0B0C0E and 9 weeks.
    link.emit('telegram', telegram('D107930A0B0C0E1FFFFF090400AA0100', 'FFAA0000'));
    assert.equal(mqtt.json(T.bridge).stick_problem_reason, 'machine_id_mismatch');
    assert.equal(mqtt.json(T.unit).weeks_since_maintenance, 4);
    assert.equal(mqtt.json(T.unit).machine_id, '0A0B0C0D');
  });
});

describe('orders', () => {
  it('sends a mode order and publishes the optimistic state once confirmed', async () => {
    const { link, mqtt, order, feed } = setup();
    link.connect();
    feed(513, 521);
    await order(`${T.set}/mode`, 'eco');
    assert.deepEqual(link.sentHex(), [settingsFrame('01FFFFFFFFFFFFFFFF')]);
    assert.equal(mqtt.json(T.unit).mode, 'eco');
    // Corrected by the next status frame.
    feed(1113, 1113);
    assert.equal(mqtt.json(T.unit).mode, 'standard');
  });

  it('turns several JSON keys into one frame', async () => {
    const { link, mqtt, order, timers, feed } = setup();
    link.connect();
    feed(513, 521);
    await order(
      T.set,
      '{"mode": "comfort", "boost": true, "preheat_setpoint": "off", "max_supply_temperature": 25}',
    );
    // Mode 3, function byte unchanged, holiday unchanged, boost 30 min (1E), preheating off (04),
    // max supply 25 °C (19), Hydro'R / SolarR / one-shot unchanged.
    assert.deepEqual(link.sentHex(), [settingsFrame('03FFFF1E0419FFFFFF')]);
    const state = mqtt.json(T.unit);
    assert.equal(state.mode, 'comfort');
    assert.equal(state.boost, true);
    assert.equal(state.boost_ends_at, new Date(timers.now() + 30 * MIN).toISOString());
    assert.equal(state.preheat_setpoint, null);
    assert.equal(state.max_supply_temperature, 25);
  });

  it('uses the stored durations and stores new ones without transmitting', async () => {
    const { link, mqtt, order, store, timers, feed } = setup();
    link.connect();
    feed(513, 521);
    await order(`${T.set}/boost_duration`, '60');
    await order(`${T.set}/holiday_duration`, '14');
    assert.deepEqual(link.sentHex(), []);
    assert.equal(store.state.boostDuration, 60);
    assert.equal(store.state.holidayDuration, 14);
    assert.equal(mqtt.json(T.unit).boost_duration, 60);
    assert.equal(mqtt.json(T.unit).holiday_duration, 14);
    await order(`${T.set}/boost`, 'ON');
    await order(`${T.set}/holiday`, 'ON');
    await order(`${T.set}/boost`, 'OFF');
    await order(T.set, '{"holiday": 3}');
    assert.deepEqual(link.sentHex(), [
      settingsFrame('FFFFFF3CFFFFFFFFFF'), // boost 60 min
      settingsFrame('FFFF0EFFFFFFFFFFFF'), // holiday 14 days
      settingsFrame('FFFFFF00FFFFFFFFFF'), // boost stop
      settingsFrame('FFFF03FFFFFFFFFFFF'), // holiday 3 days
    ]);
    const state = mqtt.json(T.unit);
    assert.equal(state.boost, false);
    assert.equal(state.boost_ends_at, null);
    assert.equal(state.holiday, true);
    assert.equal(state.holiday_ends_at, new Date(timers.now() + 3 * 24 * 60 * MIN).toISOString());
  });

  it('clears ends_at when the unit reports the end', async () => {
    const { link, mqtt, order, feed } = setup();
    link.connect();
    feed(513, 521);
    await order(`${T.set}/holiday`, 'ON');
    assert.equal(mqtt.json(T.unit).holiday, true);
    assert.notEqual(mqtt.json(T.unit).holiday_ends_at, null);
    feed(1113, 1113); // CMD 0: holiday bit clear
    assert.equal(mqtt.json(T.unit).holiday, false);
    assert.equal(mqtt.json(T.unit).holiday_ends_at, null);
  });

  it('changes one bit of the last function byte received', async () => {
    const { link, mqtt, order, feed } = setup();
    link.connect();
    feed(513, 521); // function byte 0x32
    await order(`${T.set}/over_ventilation`, 'OFF'); // 0x32 → 0x30
    await order(T.set, '{"fixed_airflow": true, "bypass_source": "roof"}'); // 0x32 → 0x1A
    await order(`${T.set}/time_schedule`, 'false'); // 0x32 → 0x22
    assert.deepEqual(link.sentHex(), [
      settingsFrame('FF30FFFFFFFFFFFFFF'),
      settingsFrame('FF1AFFFFFFFFFFFFFF'),
      settingsFrame('FF22FFFFFFFFFFFFFF'),
    ]);
    const state = mqtt.json(T.unit);
    assert.equal(state.time_schedule, false);
    assert.equal(state.fixed_airflow, true);
    assert.equal(state.bypass_source, 'roof');
  });

  it('queues a function-byte order until the first CMD 0 and asks for a refresh', async () => {
    const { link, mqtt, order, feed, bridge } = setup();
    link.connect();
    await order(`${T.set}/fixed_airflow`, 'ON');
    await order(`${T.set}/mode`, 'eco');
    await order(`${T.set}/over_ventilation`, 'OFF');
    assert.deepEqual(link.sentHex(), [
      settingsFrame('FFFFFFFFFFFFFFFF01'), // refresh request
      settingsFrame('01FFFFFFFFFFFFFFFF'), // the mode order is not delayed
    ]);
    feed(513, 513); // CMD 0, function byte 0x32
    await bridge.idle();
    await flush();
    // 0x32 | 0x08 (fixed airflow) & ~0x02 (over-ventilation) = 0x38, both waiting orders merged.
    assert.deepEqual(link.sentHex().slice(2), [settingsFrame('FF38FFFFFFFFFFFFFF')]);
    assert.equal(mqtt.json(T.unit).fixed_airflow, true);
    assert.equal(mqtt.json(T.unit).over_ventilation, false);
  });

  it('drops a waiting function-byte order after 15 min', async () => {
    const { link, order, feed, timers, logs, bridge } = setup();
    link.connect();
    await order(`${T.set}/fixed_airflow`, 'ON');
    timers.advance(15 * MIN);
    assert.ok(logs.includes('warn No CMD 0 frame received in time: waiting order dropped'));
    feed(513, 513);
    await bridge.idle();
    assert.equal(link.sent.length, 1); // the refresh request only
  });

  it('sends the clock and the one-shot buttons', async () => {
    const { link, order } = setup();
    link.connect();
    await order(`${T.set}/sync_clock`, 'PRESS');
    await order(`${T.set}/refresh`, 'PRESS');
    await order(`${T.set}/filter_reset`, 'PRESS');
    assert.deepEqual(link.sentHex(), [
      // 2026-01-15 10:20:30 → 1A 01 0F 0A 14 1E.
      'D107911A010F0A141EFFAA000080 > FFFFFFFF',
      settingsFrame('FFFFFFFFFFFFFFFF01'),
      settingsFrame('FFFFFFFFFFFFFFFF04'),
    ]);
  });

  it('rejects invalid orders and logs them', async () => {
    const { link, order, logs, mqtt } = setup();
    link.connect();
    mqtt.clear();
    await order(`${T.set}/boost`, '500');
    await order(T.set, '{"mode": "eco", "colour": "blue"}');
    assert.deepEqual(link.sent, []);
    assert.deepEqual(mqtt.published, []);
    assert.deepEqual(
      logs.filter((l) => l.startsWith('warn')),
      [
        `warn Rejected order on ${T.set}/boost: boost: expected true/false, ON/OFF or an integer in 0–200, got "500"`,
        `warn Rejected order on ${T.set}: colour: unknown key (expected one of mode, boost, holiday, ` +
          'fixed_airflow, over_ventilation, time_schedule, bypass_source, preheat_setpoint, ' +
          'max_supply_temperature, hydror_setpoint, solarr_setpoint, boost_duration, ' +
          'holiday_duration, refresh, filter_reset, sync_clock)',
      ],
    );
  });

  it('publishes no optimistic state when the stick does not confirm', async () => {
    const { link, order, mqtt, logs, feed } = setup();
    link.connect();
    feed(513, 521);
    link.result = {
      confirmed: false,
      reason: 'no_answer',
      returnCode: undefined,
      detail: 'No answer to RADIO_ERP1',
    };
    await order(`${T.set}/mode`, 'eco');
    assert.equal(link.sent.length, 1);
    assert.equal(mqtt.json(T.unit).mode, 'standard');
    assert.ok(logs.includes('warn Order not sent: No answer to RADIO_ERP1'));
  });

  it('keeps handling orders after a failed one', async () => {
    const { link, order, logs } = setup();
    link.connect();
    const send = link.send.bind(link);
    link.send = () => Promise.reject(new Error('serial port gone'));
    await order(`${T.set}/mode`, 'eco');
    link.send = send;
    await order(`${T.set}/mode`, 'standby');
    assert.ok(logs.includes('error Order failed: serial port gone'));
    assert.deepEqual(link.sentHex(), [settingsFrame('00FFFFFFFFFFFFFFFF')]);
  });

  it('sends nothing before the stick is connected', async () => {
    const { link, order, logs } = setup();
    await order(`${T.set}/mode`, 'eco');
    assert.deepEqual(link.sent, []);
    assert.ok(logs.includes('warn Order not sent: the stick is not connected'));
  });

  it('transmits with the sender_id option', async () => {
    const { link, order, logs, mqtt } = setup({ senderId: 'FFAA0001' });
    link.connect();
    await order(`${T.set}/mode`, 'eco');
    assert.deepEqual(link.sentHex(), ['D1079001FFFFFFFFFFFFFFFFFFAA000180 > FFFFFFFF']);
    assert.equal(mqtt.json(T.bridge).sender_id, 'FFAA0001');
    const other = setup({ senderId: '0400BB01' });
    other.link.connect();
    assert.ok(other.logs.some((l) => l.startsWith('warn sender_id 0400BB01 is outside')));
    assert.equal(logs.filter((l) => l.startsWith('warn')).length, 0);
  });
});

describe('clock sync', () => {
  it('sends the clock after each connection and every hour', async () => {
    const { link, timers } = setup({ syncClock: true });
    link.connect();
    await flush();
    assert.deepEqual(link.sentHex(), ['D107911A010F0A141EFFAA000080 > FFFFFFFF']);
    timers.advance(60 * MIN); // 11:20:30
    await flush();
    assert.equal(link.sentHex()[1], 'D107911A010F0B141EFFAA000080 > FFFFFFFF');
    link.emit('disconnected', { port: 'primary', url: 'x', reason: 'closed', detail: '' });
    timers.advance(60 * MIN);
    await flush();
    assert.equal(link.sent.length, 2); // not connected: skipped
    link.connect();
    await flush();
    assert.equal(link.sent.length, 3);
  });

  it('stays silent when disabled', async () => {
    const { link, timers } = setup({ syncClock: false });
    link.connect();
    timers.advance(3 * 60 * MIN);
    await flush();
    assert.deepEqual(link.sent, []);
  });

  it('asks the unit for a full status after each connection', async () => {
    const { bridge, link } = setup({ syncClock: false }, new MemoryStore(), true);
    link.connect();
    await bridge.idle();
    await flush();
    // CMD 0, ranks 1-8 unchanged (FF), rank 9 = 1 (refresh request), protocol.md § 6.1.
    assert.deepEqual(link.sentHex(), ['D10790FFFFFFFFFFFFFFFF01FFAA000080 > FFFFFFFF']);
  });
});

describe('teach-in', () => {
  // UTE query from the unit: D4 80 FF 79 00 00 01 D1, broadcast.
  const query = (): ReturnType<typeof telegram> =>
    telegram('D480FF79000001D10400AA0100', 'FFFFFFFF');

  it('answers a query, at most once every 10 min', async () => {
    const { link, timers } = setup();
    link.connect();
    link.emit('telegram', query());
    await flush();
    // D4 91 + the 6 next bytes of the query, from our ID, status 00, to the unit.
    assert.deepEqual(link.sentHex(), ['D491FF79000001D1FFAA000000 > 0400AA01']);
    timers.advance(9 * MIN);
    link.emit('telegram', query());
    await flush();
    assert.equal(link.sent.length, 1);
    timers.advance(MIN);
    link.emit('telegram', query());
    await flush();
    assert.equal(link.sent.length, 2);
  });

  it('does not answer while the unit addresses us', async () => {
    const { link, timers, feed } = setup();
    link.connect();
    feed(513, 513);
    timers.advance(14 * MIN);
    link.emit('telegram', query());
    await flush();
    assert.deepEqual(link.sent, []);
    timers.advance(MIN);
    link.emit('telegram', query());
    await flush();
    assert.equal(link.sent.length, 1);
  });

  it('never answers with accept_pairing off', async () => {
    const { link } = setup({ acceptPairing: false });
    link.connect();
    link.emit('telegram', query());
    await flush();
    assert.deepEqual(link.sent, []);
  });
});

describe('stop', () => {
  it('publishes offline and clears its timers', async () => {
    const { bridge, mqtt, timers, link, order } = setup({ syncClock: true });
    link.connect();
    await order(`${T.set}/fixed_airflow`, 'ON'); // waiting order timer
    link.emit('incident', { reason: 'no_answer', detail: 'x' });
    await bridge.stop();
    assert.equal(mqtt.retained.get(T.bridgeAvailability), 'offline');
    assert.equal(timers.pending, 0);
    mqtt.clear();
    link.emit('telegram', telegram('D107980400AA020101090400AA0100', 'FFAA0000'));
    assert.deepEqual(mqtt.published, []);
  });
});
