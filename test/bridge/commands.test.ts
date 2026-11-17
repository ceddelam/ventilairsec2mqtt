/**
 * Order parsing: accepted values per key, rejection of invalid values (never clamped).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  changesFunctionByte,
  InvalidOrderError,
  parseJsonOrder,
  parseKeyOrder,
  type ParsedOrder,
} from '../../src/bridge/commands.ts';

function rejected(run: () => ParsedOrder, message: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof InvalidOrderError);
    assert.match(error.message, message);
    return true;
  });
}

describe('order parsing', () => {
  it('parses a JSON order with several keys', () => {
    assert.deepEqual(
      parseJsonOrder(
        '{"mode": "Eco", "boost": true, "holiday": 3, "fixed_airflow": "ON", ' +
          '"bypass_source": "roof", "preheat_setpoint": "off", "max_supply_temperature": 30, ' +
          '"hydror_setpoint": 12, "solarr_setpoint": "20", "boost_duration": 45, ' +
          '"holiday_duration": 10, "refresh": null, "sync_clock": "PRESS"}',
      ),
      {
        mode: 'eco',
        boost: 'on',
        holiday: 3,
        functionChange: { fixedAirflow: true, bypassSource: 'roof' },
        preheatSetpoint: 'off',
        maxSupplyTemperature: 30,
        hydroRSetpoint: 12,
        solarRSetpoint: 20,
        boostDuration: 45,
        holidayDuration: 10,
        oneShot: 'refresh',
        syncClock: true,
      },
    );
  });

  it('parses raw values from Home Assistant', () => {
    assert.deepEqual(parseKeyOrder('boost', 'OFF'), {
      functionChange: {},
      syncClock: false,
      boost: 'off',
    });
    assert.equal(parseKeyOrder('boost', '30').boost, 30);
    assert.equal(parseKeyOrder('boost', '0').boost, 0);
    assert.equal(parseKeyOrder('holiday', 'on').holiday, 'on');
    assert.equal(parseKeyOrder('max_supply_temperature', '25.0').maxSupplyTemperature, 25);
    assert.equal(parseKeyOrder('preheat_setpoint', '18').preheatSetpoint, 18);
    assert.deepEqual(parseKeyOrder('over_ventilation', 'false').functionChange, {
      overVentilation: false,
    });
    assert.deepEqual(parseKeyOrder('time_schedule', 'ON').functionChange, { timeSchedule: true });
    assert.equal(parseKeyOrder('filter_reset', 'PRESS').oneShot, 'filter_reset');
    assert.equal(parseKeyOrder('sync_clock', 'PRESS').syncClock, true);
    assert.equal(parseKeyOrder('mode', ' standby ').mode, 'standby');
  });

  it('rejects out-of-range values without clamping', () => {
    rejected(
      () => parseKeyOrder('boost', '201'),
      /^boost: expected .* integer in 0–200, got "201"/,
    );
    rejected(() => parseKeyOrder('boost', '-1'), /^boost:/);
    rejected(() => parseKeyOrder('holiday', '255'), /^holiday:/);
    rejected(
      () => parseKeyOrder('boost_duration', '4'),
      /^boost_duration: expected an integer in 5–200/,
    );
    rejected(() => parseKeyOrder('boost_duration', '201'), /^boost_duration:/);
    rejected(() => parseKeyOrder('holiday_duration', '0'), /^holiday_duration: .* 1–254/);
    rejected(
      () => parseKeyOrder('preheat_setpoint', '11'),
      /^preheat_setpoint: expected off or an integer in 12–18/,
    );
    rejected(() => parseKeyOrder('hydror_setpoint', '29'), /^hydror_setpoint: .* 8–28/);
    rejected(() => parseKeyOrder('solarr_setpoint', '17'), /^solarr_setpoint: .* 18–30/);
    rejected(
      () => parseKeyOrder('max_supply_temperature', '45.5'),
      /^max_supply_temperature: .* 20–45/,
    );
    rejected(() => parseKeyOrder('max_supply_temperature', '46'), /^max_supply_temperature:/);
  });

  it('rejects wrong types and unknown values', () => {
    rejected(
      () => parseKeyOrder('mode', 'turbo'),
      /^mode: expected one of standby, eco, standard, comfort, got "turbo"/,
    );
    rejected(() => parseKeyOrder('bypass_source', 'attic'), /^bypass_source:/);
    rejected(
      () => parseKeyOrder('fixed_airflow', '1'),
      /^fixed_airflow: expected true\/false or ON\/OFF/,
    );
    rejected(() => parseJsonOrder('{"boost": "maybe"}'), /^boost:/);
    rejected(() => parseJsonOrder('{"mode": 1}'), /^mode:/);
    rejected(() => parseKeyOrder('motor_speed', '5'), /^motor_speed: unknown key/);
  });

  it('rejects malformed JSON orders', () => {
    rejected(() => parseJsonOrder('{"mode": '), /^order: not valid JSON/);
    rejected(() => parseJsonOrder('["eco"]'), /^order: expected a JSON object/);
    rejected(() => parseJsonOrder('{}'), /^order: empty order/);
    rejected(
      () => parseJsonOrder('{"refresh": 1, "filter_reset": 1}'),
      /^filter_reset: refresh and filter_reset cannot share one order/,
    );
  });

  it('tells function-byte orders apart', () => {
    assert.equal(changesFunctionByte(parseKeyOrder('bypass_source', 'other')), true);
    assert.equal(changesFunctionByte(parseKeyOrder('mode', 'eco')), false);
  });
});
