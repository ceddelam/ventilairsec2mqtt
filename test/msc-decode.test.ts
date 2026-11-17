/**
 * Assistant and unit decoders, with values worked out by hand from docs/protocol.md on real
 * frames of fixtures/vmi-status.txt (payload = bytes after the RORG, before the sender).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fromHex } from '../src/hex.ts';
import { decodeAssistant } from '../src/msc/assistant.ts';
import { errorLabel, isNoError } from '../src/msc/errors.ts';
import { decodeFunctionByte, updateFunctionByte } from '../src/msc/function-byte.ts';
import { decodeUnitStatus, type UnitStatusFrame } from '../src/msc/unit.ts';

/** The frame type(s) whose `command` can be `C`. */
type FrameOf<C extends number> = UnitStatusFrame extends infer F
  ? F extends { command: infer K }
    ? C extends K
      ? F
      : never
    : never
  : never;

function unit<C extends UnitStatusFrame['command']>(hex: string, command: C): FrameOf<C> {
  const frame = decodeUnitStatus(fromHex(hex));
  assert.ok(frame, 'frame decoded');
  assert.equal(frame.command, command);
  return frame as FrameOf<C>;
}

describe('Assistant (D1-079-00)', () => {
  it('decodes the protocol.md example (CMD 1)', () => {
    // D1 07 91 06 17 D8 27: battery 6, 0x17D8 = 6104 -> 61.04 − 40 = 21.04 °C, 0x27 = 39 %.
    const frame = decodeAssistant(fromHex('07910617D827'));
    assert.deepEqual(frame, {
      kind: 'measurement',
      command: 1,
      batteryRaw: 6,
      temperature: 21.04,
      humidity: 39,
    });
  });

  it('decodes a CMD 1 from the corpus', () => {
    // vmi-status line 2: D1 07 91 04 17 9D 3C -> battery 4, 0x179D = 6045 -> 20.45 °C, 60 %.
    assert.deepEqual(decodeAssistant(fromHex('079104179D3C')), {
      kind: 'measurement',
      command: 1,
      batteryRaw: 4,
      temperature: 20.45,
      humidity: 60,
    });
  });

  it('decodes a CMD 3 from the corpus', () => {
    // vmi-status line 52: D1 07 93 04 17 BB 3C -> battery 4, 0x17BB = 6075 -> 20.75 °C, 60 %.
    assert.deepEqual(decodeAssistant(fromHex('079304 17BB 3C')), {
      kind: 'measurement',
      command: 3,
      batteryRaw: 4,
      temperature: 20.75,
      humidity: 60,
    });
  });

  it('keeps CMD 4 raw', () => {
    const frame = decodeAssistant(fromHex('079410B3067C'));
    assert.equal(frame?.kind, 'other');
    assert.equal(frame.command, 4);
    assert.deepEqual([...frame.data], [0x10, 0xb3, 0x06, 0x7c]);
  });

  it('leaves absent fields undefined on a short frame', () => {
    const frame = decodeAssistant(fromHex('079106'));
    assert.deepEqual(frame, {
      kind: 'measurement',
      command: 1,
      batteryRaw: 6,
      temperature: undefined,
      humidity: undefined,
    });
    assert.equal(decodeAssistant(fromHex('07')), undefined);
  });

  it('decodes the temperature range ends', () => {
    // raw 0 -> −40 °C; raw 16500 = 0x4074 -> 125 °C.
    const low = decodeAssistant(fromHex('079106000000'));
    const high = decodeAssistant(fromHex('079106407400'));
    assert.equal(low?.kind === 'measurement' ? low.temperature : null, -40);
    assert.equal(high?.kind === 'measurement' ? high.temperature : null, 125);
  });
});

describe('unit CMD 0 — current data', () => {
  it('decodes the corpus frame (firmware 3.7, 11 payload bytes)', () => {
    // D1 07 90 02 32 00 04 1E 00 00 00 01 (protocol.md § 5.1 example).
    const f = unit('0790023200041E00000001', 0);
    assert.equal(f.mode, 'standard'); // 02
    assert.equal(f.modeRaw, 2);
    assert.equal(f.functionByte, 0x32);
    // 0x32 = 0011 0010: bit 5 bypass other, bit 4 schedule, bit 3 fixed airflow off,
    // bit 1 over-ventilation on, bit 0 holiday off.
    assert.deepEqual(f.functions, {
      bypassSource: 'other',
      timeSchedule: true,
      fixedAirflow: false,
      overVentilation: true,
      holiday: false,
    });
    assert.equal(f.boostRaw, 0);
    assert.equal(f.boostActive, false);
    assert.equal(f.boostMinutesLeft, undefined);
    assert.equal(f.preheatSetpointRaw, 4);
    assert.equal(f.preheatSetpoint, null); // 4 = disabled
    assert.equal(f.maxSupplyTemperature, 30); // 0x1E
    assert.equal(f.hydroRSetpointRaw, 0);
    assert.equal(f.hydroRSetpoint, null); // 0 = option absent
    assert.equal(f.solarRSetpoint, null); // 0 = disabled
    assert.equal(f.firmwareUpdate, false);
    assert.equal(f.pairingMode, false);
    assert.equal(f.test, false);
    assert.equal(f.localisationRaw, 0);
    assert.equal(f.season, 'winter'); // 01
    assert.equal(f.eventTypeRaw, undefined); // offset 88 beyond 11 bytes
  });

  it('decodes boost, enabled setpoints, flags and event type', () => {
    // mode 03 comfort, function 09 (fixed airflow + holiday), boost 0x2D = 45 min,
    // preheat 0x0E = 14, max supply 0x2D = 45, Hydro'R 0x14 = 20, SolarR 0x16 = 22,
    // byte 9 = 0x0F -> bits 76-79 all set, season 02 mid-season, event type 01.
    const f = unit('0790 03 09 2D 0E 2D 14 16 0F 02 01', 0);
    assert.equal(f.mode, 'comfort');
    assert.equal(f.functions?.fixedAirflow, true);
    assert.equal(f.functions.holiday, true);
    assert.equal(f.functions.bypassSource, 'roof');
    assert.equal(f.boostActive, true);
    assert.equal(f.boostMinutesLeft, 45);
    assert.equal(f.preheatSetpoint, 14);
    assert.equal(f.maxSupplyTemperature, 45);
    assert.equal(f.hydroRSetpoint, 20);
    assert.equal(f.solarRSetpoint, 22);
    assert.equal(f.firmwareUpdate, true);
    assert.equal(f.pairingMode, true);
    assert.equal(f.test, true);
    assert.equal(f.localisationRaw, 1);
    assert.equal(f.season, 'mid_season');
    assert.equal(f.eventTypeRaw, 1);
  });

  it('reads boost 1 and 255 as on with unknown time, Hydro’R 6 as disabled', () => {
    const one = unit('0790 02 00 01 04 1E 06 00 00 01', 0);
    assert.equal(one.boostActive, true);
    assert.equal(one.boostMinutesLeft, undefined);
    assert.equal(one.hydroRSetpoint, null);
    assert.equal(one.hydroRSetpointRaw, 6);
    const ff = unit('0790 02 00 FF', 0);
    assert.equal(ff.boostActive, true);
    assert.equal(ff.boostMinutesLeft, undefined);
  });

  it('keeps unknown enum values raw', () => {
    const f = unit('0790 07 00 00 04 1E 00 00 00 05', 0);
    assert.equal(f.mode, undefined);
    assert.equal(f.modeRaw, 7);
    assert.equal(f.season, undefined);
    assert.equal(f.seasonRaw, 5);
  });

  it('leaves every field after the end undefined', () => {
    const f = unit('0790 02', 0);
    assert.equal(f.mode, 'standard');
    assert.equal(f.functionByte, undefined);
    assert.equal(f.functions, undefined);
    assert.equal(f.boostActive, undefined);
    assert.equal(f.preheatSetpoint, undefined);
    assert.equal(f.season, undefined);
    assert.equal(f.firmwareUpdate, undefined);
  });
});

describe('unit CMD 1 — complement 1', () => {
  it('decodes the corpus frame', () => {
    // 07 91 00 6C 00 04 03: airflow 0x006C = 108 m³/h, preheat power 0 %, state 4 = normal,
    // motor speed 3.
    const f = unit('0791006C000403', 1);
    assert.deepEqual(f, {
      command: 1,
      airflow: 108,
      preheatPower: 0,
      systemState: 'normal',
      systemStateRaw: 4,
      motorSpeed: 3,
    });
  });

  it('maps every system state', () => {
    const states = [0, 1, 2, 3, 4].map((s) => unit(`0791 009D 00 0${s} 05`, 1).systemState);
    assert.deepEqual(states, ['boost', 'holiday', 'standby', 'fixed_airflow', 'normal']);
  });
});

describe('unit CMD 2 — complement 2', () => {
  it('decodes the corpus frame', () => {
    // 07 92 0C 00D3 09 00 0845: outdoor 12 °C, pressure setpoint raw 0x00D3 = 211,
    // filter clogging 9 %, water loop 0 %, operating time 0x0845 = 2117 days.
    assert.deepEqual(unit('07920C00D309000845', 2), {
      command: 2,
      outdoorTemperature: 12,
      pressureSetpointRaw: 211,
      filterClogging: 9,
      waterLoopDutyCycle: 0,
      operatingTimeDays: 2117,
    });
  });

  it('decodes a negative outdoor temperature', () => {
    assert.equal(unit('0792F6', 2).outdoorTemperature, -10); // 0xF6 = 246 - 256
  });
});

describe('unit CMD 3 — maintenance', () => {
  it('decodes the corpus frame', () => {
    // 07 93 0A0B0C0D 1F FF FF 04: machine ID 0A0B0C0D; 0x1F = 0001 1111 -> bits 51-55 = 1
    // (all tests OK); error codes FF = none; 4 weeks; consumption absent (offset 80).
    assert.deepEqual(unit('07930A0B0C0D1FFFFF04', 3), {
      command: 3,
      machineId: '0A0B0C0D',
      selfTest: { airQuality: true, motor: true, preheating: true, probe: true, overall: true },
      errorCode1Raw: 0xff,
      errorCode2Raw: 0xff,
      errors: [],
      weeksSinceMaintenance: 4,
      consumptionRaw: undefined,
    });
  });

  it('reports failed tests, errors and consumption', () => {
    // 0x16 = 0001 0110 -> bit 51 = 1, 52 = 0, 53 = 1, 54 = 1, 55 = 0.
    const f = unit('0793 0A0B0C0D 16 20 43 34 07', 3);
    assert.deepEqual(f.selfTest, {
      airQuality: true,
      motor: false,
      preheating: true,
      probe: true,
      overall: false,
    });
    assert.deepEqual(f.errors, [
      { code: 0x20, label: 'Filter to replace' },
      { code: 0x43, label: 'Assistant batteries low' },
    ]);
    assert.equal(f.weeksSinceMaintenance, 0x34);
    assert.equal(f.consumptionRaw, 7);
  });

  it('labels error codes', () => {
    assert.equal(isNoError(0), true);
    assert.equal(isNoError(0xff), true);
    assert.equal(errorLabel(0), undefined);
    assert.equal(errorLabel(0x35), 'Air quality sensor no. 5 failure');
    assert.equal(errorLabel(0x83), 'Bypass flap stuck');
    assert.equal(errorLabel(0x99), 'Unknown error 0x99');
  });
});

describe('unit CMD 4 — configuration', () => {
  it('decodes the corpus frame', () => {
    // 07 94 01 04 012C 13 06 0F 37: Purevent; 0x04 = 0000 0100 -> bit 29 = 1 (upstream bypass),
    // bits 30, 31 = 0; 0x012C = 300 m³; 2000 + 0x13 = 2019, month 6, day 15; firmware 3.7;
    // hardware version absent.
    assert.deepEqual(unit('079401 04 012C 13 06 0F 37', 4), {
      command: 4,
      unitType: 'purevent',
      unitTypeRaw: 1,
      upstreamBypassPresent: true,
      solarRPresent: false,
      hydroRPresent: false,
      ventilatedVolume: 300,
      installationYear: 2019,
      installationMonth: 6,
      installationDay: 15,
      firmwareVersion: '3.7',
      firmwareVersionRaw: 0x37,
      hardwareVersion: undefined,
      hardwareVersionRaw: undefined,
    });
  });

  it('decodes options and the hardware version', () => {
    const f = unit('079403 03 07D0 18 01 1F 41 12', 4);
    assert.equal(f.unitType, 'erp');
    assert.equal(f.solarRPresent, true);
    assert.equal(f.hydroRPresent, true);
    assert.equal(f.upstreamBypassPresent, false);
    assert.equal(f.ventilatedVolume, 2000);
    assert.equal(f.firmwareVersion, '4.1');
    assert.equal(f.hardwareVersion, '1.2');
  });
});

describe('unit CMD 5 / CMD 6 — probes', () => {
  it('decodes the protocol.md example (third slot cut short)', () => {
    // 07 95 | 00 0C 5C | 01 0B 64 | FF 00: supply 12 °C 92 %, intake 11 °C 100 %, no third probe.
    assert.deepEqual(unit('0795000C5C010B64FF00', 5), {
      command: 5,
      probes: [
        { slot: 0, positionRaw: 0, position: 'supply', temperature: 12, humidity: 92 },
        { slot: 1, positionRaw: 1, position: 'intake', temperature: 11, humidity: 100 },
        { slot: 2, positionRaw: 255, position: null, temperature: undefined, humidity: undefined },
      ],
    });
  });

  it('keeps humidity above 100 %', () => {
    // vmi-status line 71: 01 0A 68 -> intake 10 °C, 0x68 = 104 %.
    const f = unit('0795000C5F010A68FF00', 5);
    assert.equal(f.probes[1]?.humidity, 104);
  });

  it('decodes CMD 6 without probes', () => {
    assert.deepEqual(unit('0796FF0000FF0000', 6), {
      command: 6,
      probes: [
        { slot: 3, positionRaw: 255, position: null, temperature: undefined, humidity: undefined },
        { slot: 4, positionRaw: 255, position: null, temperature: undefined, humidity: undefined },
      ],
    });
  });

  it('decodes every position and negative temperatures', () => {
    const f = unit('0795 02FE50 03F032 04 05', 5);
    assert.deepEqual(
      f.probes.map((p) => [p.position, p.temperature, p.humidity]),
      [
        ['water_loop', -2, 80],
        ['solar', -16, 50],
        ['bypass', 5, undefined],
      ],
    );
    assert.equal(unit('0796 0414 46', 6).probes[0]?.position, 'bypass');
    assert.equal(unit('0796 0714 46', 6).probes[0]?.position, undefined);
  });
});

describe('unit CMD 7 — options', () => {
  it('decodes the corpus frame (unused slots)', () => {
    // 07 97 00 FF 00 FF 00 FF 00: three slots opening 0, position FF (unknown); valve 0 %.
    const f = unit('079700FF00FF00FF00', 7);
    assert.equal(f.bypasses.length, 3);
    for (const slot of f.bypasses) {
      assert.equal(slot.opening, 0);
      assert.equal(slot.position, null);
      assert.equal(slot.positionRaw, 255);
    }
    assert.equal(f.hydroRValveOpening, 0);
  });

  it('decodes active bypasses', () => {
    const f = unit('0797 64 01 FF 03 00 04 32', 7);
    assert.deepEqual(
      f.bypasses.map((b) => [b.slot, b.opening, b.position]),
      [
        [1, 100, 'other_heat_source'],
        [2, null, 'earth_tube'],
        [3, 0, 'manual'],
      ],
    );
    assert.equal(f.hydroRValveOpening, 50);
    assert.equal(unit('0797 00 02', 7).bypasses[0]?.position, 'solar_heat_source');
    assert.equal(unit('0797 00 00', 7).bypasses[0]?.position, 'inactive');
  });
});

describe('unit CMD 8 — paired sensor', () => {
  it('decodes the corpus frame', () => {
    // 07 98 0400AA02 01 01 09: the Assistant, living room, profile 1, index 9.
    assert.deepEqual(unit('07980400AA02010109', 8), {
      command: 8,
      sensorId: '0400AA02',
      room: 'living_room',
      roomRaw: 1,
      profile: 'assistant',
      profileRaw: 1,
      sensorIndex: 9,
    });
  });

  it('maps rooms and profiles', () => {
    assert.equal(unit('0798 0400AA03 0A 04 01', 8).room, 'neutral_zone');
    assert.equal(unit('0798 0400AA03 0A 04 01', 8).profile, 'D2-04-08');
    assert.equal(unit('0798 0400AA03 08 02 01', 8).room, 'bedroom_4');
    assert.equal(unit('0798 0400AA03 0B 05 01', 8).room, undefined);
  });
});

describe('unit other commands', () => {
  it('keeps commands 9–15 raw', () => {
    const f = decodeUnitStatus(fromHex('079A0102'));
    assert.deepEqual(f && 'data' in f ? [f.command, [...f.data]] : null, [10, [1, 2]]);
    assert.equal(decodeUnitStatus(fromHex('07')), undefined);
  });
});

describe('function byte', () => {
  it('decodes known bits', () => {
    assert.deepEqual(decodeFunctionByte(0x00), {
      bypassSource: 'roof',
      timeSchedule: false,
      fixedAirflow: false,
      overVentilation: false,
      holiday: false,
    });
  });

  it('sets and clears one bit from the last byte, clearing holiday', () => {
    assert.equal(updateFunctionByte(0x32, { fixedAirflow: true }), 0x3a);
    assert.equal(updateFunctionByte(0x32, { overVentilation: false }), 0x30);
    assert.equal(updateFunctionByte(0x32, { bypassSource: 'roof' }), 0x12);
    assert.equal(updateFunctionByte(0x02, { bypassSource: 'other', timeSchedule: true }), 0x32);
    // 0x33 has the holiday bit: it is cleared whatever the change.
    assert.equal(updateFunctionByte(0x33, { overVentilation: true }), 0x32);
    // Unknown bits (7, 6, 2) are kept.
    assert.equal(updateFunctionByte(0xc4, {}), 0xc4);
    assert.throws(() => updateFunctionByte(256, {}), RangeError);
  });
});
