/**
 * Unit and Assistant JSON states on corpus telegrams (fixtures/vmi-status.txt). Expected values
 * are worked out by hand from docs/protocol.md:
 *
 * - CMD 0 `07 90 02 32 00 04 1E 00 00 00 01`: Standard; function byte 0x32 = bypass other
 *   source (0x20), time schedule (0x10), over-ventilation (0x02), fixed airflow and holiday off;
 *   boost 0; preheating 4 = disabled; max supply 0x1E = 30 °C; Hydro'R / SolarR 0 = disabled;
 *   bits 72–79 all 0; season 1 = winter.
 * - CMD 1 `07 91 00 6C 00 04 03`: airflow 0x006C = 108 m³/h, preheating 0 %, state 4 = normal,
 *   speed 3.
 * - CMD 2 `07 92 0C 00 D3 09 00 08 45`: outdoor 12 °C, pressure setpoint 0x00D3 = 211 → 21.1,
 *   clogging 9 %, water loop 0 %, operating time 0x0845 = 2117 days.
 * - CMD 3 `07 93 0A 0B 0C 0D 1F FF FF 04`: machine ID 0A0B0C0D; 0x1F → bits 51–55 all 1 (tests
 *   OK); error codes FF = none; 4 weeks → filter 365 − 28 − 3 = 334 days.
 * - CMD 4 `07 94 01 04 01 2C 13 06 0F 37`: Purevent; 0x04 → bit 29 upstream bypass, no SolarR
 *   or Hydro'R; 0x012C = 300 m³; 2019-06-15; firmware 3.7.
 * - CMD 5 `07 95 00 0C 5C 01 0B 64 FF 00`: supply 12 °C 92 %, intake 11 °C 100 %, no 3rd probe.
 * - CMD 6 `07 96 FF 00 00 FF 00 00`: no probe. CMD 7 `07 97 00 FF 00 FF 00 FF 00`: openings 0,
 *   positions FF (unknown), Hydro'R valve 0 %. CMD 8 `07 98 04 00 AA 02 01 01 09`: 0400AA02,
 *   living room, Assistant, index 9.
 * - Assistant CMD 1 `07 91 04 17 9D 3C`: battery 4 → 400 / 6 = 66.7 → 67 %; 0x179D = 6045 →
 *   20.45 °C; 0x3C = 60 %.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { batteryPercent, AssistantModel } from '../../src/bridge/assistant-model.ts';
import { filterDaysLeft, UnitModel } from '../../src/bridge/unit-model.ts';
import { classifyTelegram } from '../../src/classify.ts';
import { fromHex } from '../../src/hex.ts';
import { decodeAssistant } from '../../src/msc/assistant.ts';
import { decodeUnitStatus, type UnitStatusFrame } from '../../src/msc/unit.ts';
import { ASSISTANT, BASE_ID, corpusTelegram, UNIT, vmiStatus } from '../helpers/fake-bridge.ts';

const T0 = Date.UTC(2026, 0, 15, 10, 0, 0);

function frame(hex: string): UnitStatusFrame {
  const decoded = decodeUnitStatus(fromHex(hex));
  assert.ok(decoded);
  return decoded;
}

/** Feeds corpus lines with `first <= seconds <= last` to fresh models. */
function feed(first: number, last: number): { unit: UnitModel; assistant: AssistantModel } {
  const unit = new UnitModel();
  const assistant = new AssistantModel();
  for (const line of vmiStatus()) {
    if (line.seconds < first || line.seconds > last) continue;
    const telegram = corpusTelegram(line);
    const at = T0 + line.seconds * 1000;
    const c = classifyTelegram(telegram, {
      unitId: UNIT,
      assistantId: ASSISTANT,
      receiverIds: [BASE_ID],
    });
    if (c.kind === 'unit_status') unit.apply(c.status, at, telegram.dbm);
    if (c.kind === 'assistant') assistant.apply(c.frame, at, telegram.dbm);
  }
  return { unit, assistant };
}

const FIRST_SET = {
  airflow: 108,
  boost: false,
  boost_ends_at: null,
  bypass_2_opening: 0,
  bypass_2_position: null,
  bypass_3_opening: 0,
  bypass_3_position: null,
  bypass_opening: 0,
  bypass_position: null,
  bypass_source: 'other',
  error_codes: [],
  error_labels: [],
  filter_clogging: 9,
  filter_days_left: 334,
  firmware_update: false,
  firmware_version: '3.7',
  fixed_airflow: false,
  holiday: false,
  holiday_ends_at: null,
  hydror_present: false,
  hydror_setpoint: null,
  hydror_valve_opening: 0,
  installation_date: '2019-06-15',
  intake_humidity: 100,
  intake_temperature: 11,
  last_seen: new Date(T0 + 521_000).toISOString(),
  machine_id: '0A0B0C0D',
  max_supply_temperature: 30,
  mode: 'standard',
  motor_speed: 3,
  operating_time: 2117,
  outdoor_temperature: 12,
  over_ventilation: true,
  paired_sensors: [{ id: '0400AA02', room: 'living_room', profile: 'assistant', index: 9 }],
  pairing_mode: false,
  preheat_power: 0,
  preheat_setpoint: null,
  pressure_setpoint: 21.1,
  problem: false,
  season: 'winter',
  self_test: false,
  self_test_results: {
    air_quality: 'ok',
    motor: 'ok',
    preheating: 'ok',
    probe: 'ok',
    overall: 'ok',
  },
  signal_strength: -68,
  solarr_present: false,
  solarr_setpoint: null,
  supply_humidity: 92,
  supply_temperature: 12,
  system_state: 'normal',
  time_schedule: true,
  unit_type: 'purevent',
  upstream_bypass_present: true,
  ventilated_volume: 300,
  water_loop_duty_cycle: 0,
  weeks_since_maintenance: 4,
};

describe('UnitModel on the corpus', () => {
  it('builds the full JSON state from one status set', () => {
    const { unit } = feed(513, 521);
    assert.deepEqual(unit.state(), FIRST_SET);
    assert.deepEqual(Object.keys(unit.state()), Object.keys(FIRST_SET).sort());
    assert.equal(unit.functionByte, 0x32);
    assert.equal(unit.compositionKnown, true);
    assert.deepEqual([...unit.features], []);
    assert.deepEqual(unit.card, {
      unitType: 'purevent',
      firmwareVersion: '3.7',
      hardwareVersion: undefined,
      machineId: '0A0B0C0D',
    });
    assert.equal(unit.pairedAssistantId(), ASSISTANT);
  });

  it('follows later values (outdoor 11 °C, probes 11 °C 94 %, intake 10 °C 103 %)', () => {
    const { unit } = feed(0, 5322);
    const state = unit.state();
    // 5316: 07 92 0B … → 11 °C; 5319: 07 95 00 0B 5E 01 0A 67 → 11 °C 94 %, 10 °C 103 %.
    assert.equal(state.outdoor_temperature, 11);
    assert.equal(state.supply_temperature, 11);
    assert.equal(state.supply_humidity, 94);
    assert.equal(state.intake_temperature, 10);
    assert.equal(state.intake_humidity, 103);
    assert.equal(state.last_seen, new Date(T0 + 5322_000).toISOString());
    assert.deepEqual(state.paired_sensors, FIRST_SET.paired_sensors);
  });

  it('knows nothing before the first frames, and the composition only after CMD 4–7', () => {
    const unit = new UnitModel();
    assert.deepEqual(unit.state(), {});
    unit.apply(frame('07940104012C13060F37'), T0, -67);
    assert.equal(unit.compositionKnown, false);
    assert.deepEqual(unit.state(), {
      firmware_version: '3.7',
      hydror_present: false,
      installation_date: '2019-06-15',
      last_seen: new Date(T0).toISOString(),
      signal_strength: -67,
      solarr_present: false,
      unit_type: 'purevent',
      upstream_bypass_present: true,
      ventilated_volume: 300,
    });
  });

  it('keeps the last known value when a frame lacks a field', () => {
    const { unit } = feed(513, 521);
    unit.apply(frame('079001'), T0 + 600_000, undefined); // short CMD 0: mode only (eco)
    const state = unit.state();
    assert.equal(state.mode, 'eco');
    assert.equal(state.over_ventilation, true);
    assert.equal(state.max_supply_temperature, 30);
    assert.equal(state.signal_strength, -68); // no level: kept
    assert.equal(unit.functionByte, 0x32);
  });

  it('publishes null for a raw value outside the known table', () => {
    const unit = new UnitModel();
    unit.apply(frame('0790073200041200000005'), T0, -67);
    assert.equal(unit.state().mode, null);
    assert.equal(unit.state().season, null);
    unit.apply(frame('0791006C000903'), T0, -67);
    assert.equal(unit.state().system_state, null);
  });

  it('reports errors and failed self-tests', () => {
    const unit = new UnitModel();
    // 0x1E: bits 51–54 = 1 (OK), bit 55 = 0 (overall failed); errors 0x20 and 0x43.
    unit.apply(frame('07930A0B0C0D1E204304'), T0, -67);
    const state = unit.state();
    assert.equal(state.problem, true);
    assert.deepEqual(state.error_codes, ['20', '43']);
    assert.deepEqual(state.error_labels, ['Filter to replace', 'Assistant batteries low']);
    assert.equal(state.self_test, true);
    assert.deepEqual(state.self_test_results, {
      air_quality: 'ok',
      motor: 'ok',
      preheating: 'ok',
      probe: 'ok',
      overall: 'failed',
    });
    unit.apply(frame('07930A0B0C0D1F00FF04'), T0, -67);
    assert.equal(unit.state().problem, false);
    assert.deepEqual(unit.state().error_codes, []);
  });

  it('detects optional equipment', () => {
    const { unit } = feed(513, 521);
    // CMD 4 0x07: upstream bypass, SolarR, Hydro'R.
    unit.apply(frame('07940107012C13060F37'), T0, -67);
    // CMD 5: third probe at position 2 (water loop), 20 °C 50 %.
    unit.apply(frame('0795000C5C010B64021432'), T0, -67);
    // CMD 6: bypass probe (4) at −2 °C 70 %, fifth slot empty.
    unit.apply(frame('079604FE46FF0000'), T0, -67);
    // CMD 7: bypass 2 open 50 % from another heat source (1).
    unit.apply(frame('079700FF320100FF00'), T0, -67);
    assert.deepEqual([...unit.features].sort(), [
      'bypass_2',
      'hydror',
      'probe_bypass',
      'probe_water_loop',
      'solarr',
    ]);
    const state = unit.state();
    assert.equal(state.water_loop_temperature, 20);
    assert.equal(state.water_loop_humidity, 50);
    assert.equal(state.bypass_temperature, -2);
    assert.equal(state.bypass_humidity, 70);
    assert.equal(state.bypass_2_opening, 50);
    assert.equal(state.bypass_2_position, 'other_heat_source');
    // Equipment disappears with the next frames.
    unit.apply(frame('07940104012C13060F37'), T0, -67);
    unit.apply(frame('0795000C5C010B64FF00'), T0, -67);
    unit.apply(frame('0796FF0000FF0000'), T0, -67);
    unit.apply(frame('079700FF00FF00FF00'), T0, -67);
    assert.deepEqual([...unit.features], []);
  });

  it('rebuilds the paired sensor list from each series of CMD 8 frames', () => {
    const unit = new UnitModel();
    unit.apply(frame('07980400AA02010109'), T0, -67);
    unit.apply(frame('07980400AA03030201'), T0, -67);
    assert.deepEqual(unit.state().paired_sensors, [
      { id: '0400AA02', room: 'living_room', profile: 'assistant', index: 9 },
      { id: '0400AA03', room: 'bathroom_1', profile: 'A5-04-01', index: 1 },
    ]);
    unit.apply(frame('0791006C000403'), T0, -67);
    unit.apply(frame('07980400AA03030201'), T0, -67);
    assert.deepEqual(unit.state().paired_sensors, [
      { id: '0400AA03', room: 'bathroom_1', profile: 'A5-04-01', index: 1 },
    ]);
    assert.equal(unit.pairedAssistantId(), undefined);
  });

  it('computes boost_ends_at when the unit reports minutes left, clears it at the end', () => {
    const unit = new UnitModel();
    unit.set('boost_ends_at', '2026-01-15T10:30:00.000Z');
    unit.apply(frame('0790023201'), T0, -67); // boost 1: flag only, end time kept
    assert.equal(unit.state().boost_ends_at, '2026-01-15T10:30:00.000Z');
    unit.apply(frame('079002323C'), T0, -67); // 60 minutes left [P]
    assert.equal(unit.state().boost_ends_at, new Date(T0 + 3_600_000).toISOString());
    unit.apply(frame('0790023200'), T0, -67);
    assert.equal(unit.state().boost, false);
    assert.equal(unit.state().boost_ends_at, null);
  });

  it('estimates the filter days left', () => {
    assert.equal(filterDaysLeft(0), 362);
    assert.equal(filterDaysLeft(4), 334);
    assert.equal(filterDaysLeft(52), 0);
    assert.equal(filterDaysLeft(60), 0);
  });
});

describe('AssistantModel', () => {
  it('builds the state from the corpus', () => {
    const { assistant } = feed(0, 513);
    // Line 188: 07 91 04 17 9D 3C at −55 dBm.
    assert.deepEqual(assistant.state(), {
      battery: 67,
      battery_raw: 4,
      humidity: 60,
      last_seen: new Date(T0 + 188_000).toISOString(),
      signal_strength: -55,
      temperature: 20.45,
    });
  });

  it('only updates the time and level on other commands', () => {
    const assistant = new AssistantModel();
    const clock = decodeAssistant(fromHex('079410B3067C'));
    assert.ok(clock);
    assistant.apply(clock, T0, -60);
    assert.deepEqual(assistant.state(), {
      last_seen: new Date(T0).toISOString(),
      signal_strength: -60,
    });
  });

  it('converts the battery level', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(batteryPercent), [
      0,
      17,
      33,
      50,
      67,
      83,
      100,
      null,
    ]);
  });
});
