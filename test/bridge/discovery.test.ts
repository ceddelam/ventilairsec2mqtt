/**
 * Discovery payloads: device-based structure, unique IDs, availability, templates, optional
 * components and their removal, entity names.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assistantDiscovery,
  attributesTemplate,
  bridgeDiscovery,
  discoveryTopic,
  unitDiscovery,
  valueTemplate,
  type DiscoveryContext,
  type UnitCard,
} from '../../src/bridge/discovery.ts';
import {
  ASSISTANT_ENTITIES,
  BRIDGE_ENTITIES,
  UNIT_ENTITIES,
  type EntityDef,
  type Feature,
} from '../../src/bridge/entities.ts';
import { entityName, namedKeys } from '../../src/bridge/i18n.ts';

const CTX: DiscoveryContext = {
  topicPrefix: 'ventilairsec2mqtt',
  discoveryPrefix: 'homeassistant',
  language: 'en',
  app: { name: 'ventilairsec2mqtt', version: '1.2.3', supportUrl: 'https://example.invalid/x' },
  vmiId: '0400AA01',
};
const CARD: UnitCard = {
  unitType: 'purevent',
  firmwareVersion: '3.7',
  hardwareVersion: undefined,
  machineId: '0A0B0C0D',
};
const AVAILABILITY = [
  { topic: 'ventilairsec2mqtt/bridge/state' },
  { topic: 'ventilairsec2mqtt/0400AA01/availability' },
];

/** Unit keys present without any optional equipment, in catalog order. */
const BASE_UNIT_KEYS = [
  'mode',
  'boost',
  'boost_duration',
  'holiday',
  'holiday_duration',
  'fixed_airflow',
  'over_ventilation',
  'time_schedule',
  'bypass_source',
  'preheat_setpoint',
  'max_supply_temperature',
  'refresh',
  'filter_reset',
  'sync_clock',
  'system_state',
  'airflow',
  'motor_speed',
  'preheat_power',
  'outdoor_temperature',
  'supply_temperature',
  'supply_humidity',
  'intake_temperature',
  'intake_humidity',
  'season',
  'filter_clogging',
  'filter_days_left',
  'pressure_setpoint',
  'ventilated_volume',
  'bypass_opening',
  'operating_time',
  'weeks_since_maintenance',
  'installation_date',
  'problem',
  'self_test',
  'firmware_update',
  'pairing_mode',
  'paired_sensors',
  'signal_strength',
  'last_seen',
];

function cmps(payload: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return payload.cmps as Record<string, Record<string, unknown>>;
}

function def(key: string, list: readonly EntityDef[] = UNIT_ENTITIES): EntityDef {
  const found = list.find((d) => d.key === key);
  assert.ok(found, key);
  return found;
}

describe('unit discovery', () => {
  const message = unitDiscovery(CTX, CARD, new Set());
  const components = cmps(message.payload);

  it('is one retained device message with dev, o, availability and shared state topic', () => {
    assert.equal(message.topic, 'homeassistant/device/ventilairsec2mqtt_0400AA01/config');
    const rest = Object.fromEntries(Object.entries(message.payload).filter(([k]) => k !== 'cmps'));
    assert.deepEqual(rest, {
      dev: {
        identifiers: ['ventilairsec2mqtt_0400AA01'],
        name: 'Ventilairsec Purevent',
        manufacturer: 'Ventilairsec',
        model: 'Purevent',
        sw_version: '3.7',
        serial_number: '0A0B0C0D',
        via_device: 'ventilairsec2mqtt_bridge_0400AA01',
      },
      o: {
        name: 'ventilairsec2mqtt',
        sw_version: '1.2.3',
        support_url: 'https://example.invalid/x',
      },
      state_topic: 'ventilairsec2mqtt/0400AA01',
      availability: AVAILABILITY,
      availability_mode: 'all',
      qos: 1,
    });
  });

  it('holds the entities of a unit without options', () => {
    assert.deepEqual(Object.keys(components), BASE_UNIT_KEYS);
    assert.deepEqual([...message.components.keys()], BASE_UNIT_KEYS);
    for (const [key, c] of Object.entries(components)) {
      assert.equal(c.unique_id, `ventilairsec2mqtt_0400AA01_${key}`);
      assert.equal(typeof c.name, 'string');
      assert.equal(c.p, message.components.get(key));
    }
  });

  it('describes controls with their command topic and options', () => {
    assert.deepEqual(components.mode, {
      p: 'select',
      name: 'Mode',
      unique_id: 'ventilairsec2mqtt_0400AA01_mode',
      options: ['standby', 'eco', 'standard', 'comfort'],
      icon: 'mdi:fan',
      value_template: "{{ value_json.get('mode') }}",
      command_topic: 'ventilairsec2mqtt/0400AA01/set/mode',
    });
    assert.deepEqual(components.boost, {
      p: 'switch',
      name: 'Boost',
      unique_id: 'ventilairsec2mqtt_0400AA01_boost',
      icon: 'mdi:fan-plus',
      value_template:
        "{% set v = value_json.get('boost') %}{{ 'None' if v is none else ('ON' if v else 'OFF') }}",
      json_attributes_topic: 'ventilairsec2mqtt/0400AA01',
      json_attributes_template: "{{ {'ends_at': value_json.get('boost_ends_at')} | tojson }}",
      command_topic: 'ventilairsec2mqtt/0400AA01/set/boost',
    });
    assert.deepEqual(components.boost_duration, {
      p: 'number',
      name: 'Boost duration',
      unique_id: 'ventilairsec2mqtt_0400AA01_boost_duration',
      entity_category: 'config',
      unit_of_measurement: 'min',
      min: 5,
      max: 200,
      step: 5,
      icon: 'mdi:timer-outline',
      value_template: "{{ value_json.get('boost_duration') }}",
      command_topic: 'ventilairsec2mqtt/0400AA01/set/boost_duration',
    });
    assert.deepEqual(components.preheat_setpoint?.options, [
      'off',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
    ]);
    assert.deepEqual(components.refresh, {
      p: 'button',
      name: 'Refresh',
      unique_id: 'ventilairsec2mqtt_0400AA01_refresh',
      entity_category: 'diagnostic',
      icon: 'mdi:refresh',
      command_topic: 'ventilairsec2mqtt/0400AA01/set/refresh',
    });
    assert.equal(components.filter_reset?.entity_category, 'config');
  });

  it('describes measurements with classes, units and categories', () => {
    assert.deepEqual(components.airflow, {
      p: 'sensor',
      name: 'Airflow',
      unique_id: 'ventilairsec2mqtt_0400AA01_airflow',
      device_class: 'volume_flow_rate',
      unit_of_measurement: 'm³/h',
      state_class: 'measurement',
      value_template: "{{ value_json.get('airflow') }}",
    });
    assert.deepEqual(components.system_state?.options, [
      'boost',
      'holiday',
      'standby',
      'fixed_airflow',
      'normal',
    ]);
    assert.equal(components.system_state.device_class, 'enum');
    assert.equal(components.operating_time?.state_class, 'total_increasing');
    assert.equal(components.operating_time.device_class, 'duration');
    assert.equal(components.pressure_setpoint?.entity_category, 'diagnostic');
    assert.equal(components.last_seen?.device_class, 'timestamp');
    assert.equal(components.installation_date?.device_class, 'date');
    assert.deepEqual(components.problem, {
      p: 'binary_sensor',
      name: 'Problem',
      unique_id: 'ventilairsec2mqtt_0400AA01_problem',
      device_class: 'problem',
      value_template:
        "{% set v = value_json.get('problem') %}{{ 'None' if v is none else ('ON' if v else 'OFF') }}",
      json_attributes_topic: 'ventilairsec2mqtt/0400AA01',
      json_attributes_template:
        "{{ {'codes': value_json.get('error_codes'), 'labels': value_json.get('error_labels')} | tojson }}",
    });
    assert.equal(
      components.self_test?.json_attributes_template,
      "{{ (value_json.get('self_test_results') or {}) | tojson }}",
    );
    assert.equal(
      components.paired_sensors?.value_template,
      "{% set v = value_json.get('paired_sensors') %}{{ 'None' if v is none else v | length }}",
    );
  });

  it('adds the components of reported optional equipment', () => {
    const all: Feature[] = [
      'hydror',
      'solarr',
      'probe_water_loop',
      'probe_solar',
      'probe_bypass',
      'bypass_2',
      'bypass_3',
    ];
    const full = unitDiscovery(CTX, CARD, new Set(all));
    assert.deepEqual(
      Object.keys(cmps(full.payload)),
      UNIT_ENTITIES.map((d) => d.key),
    );
    const hydror = unitDiscovery(CTX, CARD, new Set<Feature>(['hydror']));
    assert.deepEqual(
      Object.keys(cmps(hydror.payload)).filter((k) => !BASE_UNIT_KEYS.includes(k)),
      ['hydror_setpoint', 'hydror_valve_opening', 'water_loop_duty_cycle'],
    );
    assert.deepEqual(cmps(full.payload).hydror_setpoint?.options, [
      'off',
      ...Array.from({ length: 21 }, (_, i) => String(8 + i)),
    ]);
  });

  it('removes a component by sending its platform only', () => {
    const removal = unitDiscovery(CTX, CARD, new Set(), [
      { key: 'hydror_setpoint', platform: 'select' },
      { key: 'mode', platform: 'select' }, // still present: not stubbed
    ]);
    assert.deepEqual(cmps(removal.payload).hydror_setpoint, { p: 'select' });
    assert.equal(cmps(removal.payload).mode?.unique_id, 'ventilairsec2mqtt_0400AA01_mode');
    assert.equal(removal.components.has('hydror_setpoint'), false);
  });

  it('names the device without a type before CMD 4', () => {
    const bare = unitDiscovery(
      CTX,
      {
        unitType: undefined,
        firmwareVersion: undefined,
        hardwareVersion: undefined,
        machineId: undefined,
      },
      new Set(),
    );
    assert.deepEqual(bare.payload.dev, {
      identifiers: ['ventilairsec2mqtt_0400AA01'],
      name: 'Ventilairsec',
      manufacturer: 'Ventilairsec',
      via_device: 'ventilairsec2mqtt_bridge_0400AA01',
    });
  });

  it('uses French names with language fr', () => {
    const fr = cmps(unitDiscovery({ ...CTX, language: 'fr' }, CARD, new Set()).payload);
    assert.equal(fr.outdoor_temperature?.name, 'Température extérieure');
    assert.equal(fr.over_ventilation?.name, 'Surventilation');
    assert.equal(fr.mode?.unique_id, 'ventilairsec2mqtt_0400AA01_mode');
  });
});

describe('assistant and bridge discovery', () => {
  it('describes the Assistant', () => {
    const message = assistantDiscovery(CTX, '0400AA02');
    assert.equal(message.topic, 'homeassistant/device/ventilairsec2mqtt_0400AA02/config');
    const { cmps: components, ...rest } = message.payload;
    assert.deepEqual(rest, {
      dev: {
        identifiers: ['ventilairsec2mqtt_0400AA02'],
        name: 'Ventilairsec Assistant',
        manufacturer: 'Ventilairsec',
        model: 'Assistant',
        via_device: 'ventilairsec2mqtt_bridge_0400AA01',
      },
      o: {
        name: 'ventilairsec2mqtt',
        sw_version: '1.2.3',
        support_url: 'https://example.invalid/x',
      },
      state_topic: 'ventilairsec2mqtt/0400AA02',
      availability: [
        { topic: 'ventilairsec2mqtt/bridge/state' },
        { topic: 'ventilairsec2mqtt/0400AA02/availability' },
      ],
      availability_mode: 'all',
      qos: 1,
    });
    assert.deepEqual(Object.keys(components as object), [
      'temperature',
      'humidity',
      'battery',
      'signal_strength',
      'last_seen',
    ]);
    assert.deepEqual((components as Record<string, unknown>).battery, {
      p: 'sensor',
      name: 'Battery',
      unique_id: 'ventilairsec2mqtt_0400AA02_battery',
      entity_category: 'diagnostic',
      device_class: 'battery',
      unit_of_measurement: '%',
      state_class: 'measurement',
      value_template: "{{ value_json.get('battery') }}",
      json_attributes_topic: 'ventilairsec2mqtt/0400AA02',
      json_attributes_template: "{{ {'raw': value_json.get('battery_raw')} | tojson }}",
    });
  });

  it('describes the bridge', () => {
    const message = bridgeDiscovery(CTX);
    assert.equal(message.topic, 'homeassistant/device/ventilairsec2mqtt_bridge_0400AA01/config');
    assert.deepEqual(message.payload.dev, {
      identifiers: ['ventilairsec2mqtt_bridge_0400AA01'],
      name: 'ventilairsec2mqtt',
      manufacturer: 'ventilairsec2mqtt',
      model: 'EnOcean MQTT bridge',
      sw_version: '1.2.3',
    });
    assert.equal(message.payload.state_topic, 'ventilairsec2mqtt/bridge');
    assert.deepEqual(message.payload.availability, [{ topic: 'ventilairsec2mqtt/bridge/state' }]);
    const components = cmps(message.payload);
    assert.deepEqual(Object.keys(components), [
      'connection',
      'stick_problem',
      'active_port',
      'sender_id',
    ]);
    assert.equal(components.connection?.unique_id, 'ventilairsec2mqtt_bridge_0400AA01_connection');
    assert.equal(components.connection.device_class, 'connectivity');
    assert.equal(
      components.stick_problem?.json_attributes_template,
      "{{ {'reason': value_json.get('stick_problem_reason')} | tojson }}",
    );
  });

  it('turns a multi-level topic prefix into a valid node ID', () => {
    assert.equal(
      discoveryTopic({ topicPrefix: 'house/vmi', discoveryPrefix: 'ha' }, '0400AA01'),
      'ha/device/house_vmi_0400AA01/config',
    );
    const message = unitDiscovery({ ...CTX, topicPrefix: 'house/vmi' }, CARD, new Set());
    assert.equal(message.payload.state_topic, 'house/vmi/0400AA01');
    assert.equal(cmps(message.payload).mode?.command_topic, 'house/vmi/0400AA01/set/mode');
  });
});

describe('templates and names', () => {
  it('reads disabled setpoints as off', () => {
    assert.equal(
      valueTemplate(def('preheat_setpoint')),
      "{% if 'preheat_setpoint' not in value_json %}None{% elif value_json['preheat_setpoint'] is none %}off{% else %}{{ value_json['preheat_setpoint'] }}{% endif %}",
    );
    assert.equal(attributesTemplate(def('airflow')), undefined);
  });

  it('has an English and a French name for every entity', () => {
    const keys = new Set(
      [...UNIT_ENTITIES, ...ASSISTANT_ENTITIES, ...BRIDGE_ENTITIES].map((d) => d.key),
    );
    assert.deepEqual([...keys].sort(), [...namedKeys()].sort());
    for (const key of keys) {
      assert.notEqual(entityName(key, 'en'), '');
      assert.notEqual(entityName(key, 'fr'), '');
    }
  });

  it('declares consistent entities', () => {
    for (const d of [...UNIT_ENTITIES, ...ASSISTANT_ENTITIES, ...BRIDGE_ENTITIES]) {
      if (d.deviceClass === 'enum') {
        assert.ok(d.options !== undefined && d.stateClass === undefined && d.unit === undefined);
      }
      if (d.platform === 'select') assert.ok(d.options !== undefined && d.options.length > 0);
      if (d.platform === 'number') assert.ok(d.min !== undefined && d.max !== undefined);
    }
  });
});
