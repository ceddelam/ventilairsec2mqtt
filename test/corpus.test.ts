/**
 * Every frame of the anonymised corpus (fixtures/) goes through the whole receive chain:
 * ESP3 framing, ERP1 parsing, classification and decoding.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyTelegram, type ClassifiedTelegram, type KnownIds } from '../src/classify.ts';
import { Esp3Decoder, PacketType } from '../src/esp3/packet.ts';
import { parseErp1, parseErp1Packet, type Erp1Telegram } from '../src/erp1.ts';
import { toHex } from '../src/hex.ts';
import { MachineIdGuard } from '../src/machine-id.ts';
import { loadAssistantVmi, loadVmiStatus } from './helpers/fixtures.ts';

const UNIT = '0400AA01';
const ASSISTANT = '0400AA02';
const BASE_ID = 'FFAA0000';
const IDS: KnownIds = { unitId: UNIT, assistantId: ASSISTANT, receiverIds: [BASE_ID] };

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

function label(c: ClassifiedTelegram): string {
  switch (c.kind) {
    case 'unit_status':
      return `unit ${c.status.command}`;
    case 'assistant':
      return `assistant ${c.frame.command}`;
    case 'unit_to_assistant':
      return `unit>assistant ${c.command}`;
    default:
      return c.kind;
  }
}

describe('corpus: assistant-vmi.txt (full ESP3 packets)', () => {
  const lines = loadAssistantVmi();

  it('holds the documented number of frames', () => {
    assert.equal(lines.length, 115); // 76 + 15 + 15 + 9 (fixtures/README.md)
  });

  const telegrams: Erp1Telegram[] = [];
  it('decodes every line as exactly one valid RADIO_ERP1 packet', () => {
    for (const { line, bytes } of lines) {
      const decoder = new Esp3Decoder();
      const packets = decoder.push(bytes);
      assert.equal(packets.length, 1, `line ${line}`);
      assert.equal(decoder.stats.badHeaderCrc + decoder.stats.badDataCrc, 0, `line ${line}`);
      const packet = packets[0]!;
      assert.equal(packet.type, PacketType.RADIO_ERP1);
      const telegram = parseErp1Packet(packet);
      assert.equal(telegram.rorg, 0xd1, `line ${line}`);
      assert.ok(telegram.destinationId !== undefined, `line ${line}: addressed`);
      assert.ok(telegram.dbm !== undefined && telegram.dbm < 0 && telegram.dbm > -100);
      telegrams.push(telegram);
    }
  });

  it('decodes the whole capture streamed as one byte stream', () => {
    const stream = Buffer.concat(lines.map((l) => l.bytes));
    const decoder = new Esp3Decoder();
    let count = 0;
    for (let i = 0; i < stream.length; i += 7)
      count += decoder.push(stream.subarray(i, i + 7)).length;
    assert.equal(count, lines.length);
  });

  it('classifies the frames as documented', () => {
    // Captured with an unpaired stick: our ID is not involved.
    const classified = telegrams.map((t) =>
      classifyTelegram(t, { unitId: UNIT, assistantId: ASSISTANT }),
    );
    assert.deepEqual(countBy(classified, label), {
      'assistant 1': 76,
      'assistant 3': 15,
      'assistant 4': 15,
      'unit>assistant 0': 9,
    });
  });

  it('decodes Assistant measurements within plausible ranges', () => {
    for (const telegram of telegrams) {
      const c = classifyTelegram(telegram, IDS);
      if (c.kind !== 'assistant' || c.frame.kind !== 'measurement') continue;
      const { batteryRaw, temperature, humidity } = c.frame;
      assert.ok(batteryRaw !== undefined && batteryRaw >= 0 && batteryRaw <= 6);
      assert.ok(temperature !== undefined && temperature > 10 && temperature < 30);
      assert.ok(humidity !== undefined && humidity > 20 && humidity < 80);
    }
  });

  it('matches hand-decoded frames', () => {
    // Line 1: D1 07 91 06 17D8 27 -> battery 6, 21.04 °C, 39 %, from the Assistant at −79 dBm.
    const first = classifyTelegram(telegrams[0]!, IDS);
    assert.equal(first.kind, 'assistant');
    assert.deepEqual(first.frame, {
      kind: 'measurement',
      command: 1,
      batteryRaw: 6,
      temperature: 21.04,
      humidity: 39,
    });
    assert.equal(first.telegram.dbm, -79);
    // Line 3: CMD 3, 0x17CD = 6093 -> 20.93 °C; level 0x56 -> −86 dBm.
    const wake = classifyTelegram(telegrams[2]!, IDS);
    assert.deepEqual(wake.kind === 'assistant' ? wake.frame : null, {
      kind: 'measurement',
      command: 3,
      batteryRaw: 6,
      temperature: 20.93,
      humidity: 39,
    });
    assert.equal(wake.telegram.dbm, -86);
    // Line 4: short unit -> Assistant frame 07 90 12 0F 01 1F, not decoded as status.
    const short = classifyTelegram(telegrams[3]!, IDS);
    assert.equal(short.kind, 'unit_to_assistant');
    assert.equal(toHex(short.data), '120F011F');
    assert.equal(short.telegram.dbm, -91); // 0x5B
    // Line 5: Assistant CMD 4, raw 06 34 71 CD.
    const clock = classifyTelegram(telegrams[4]!, IDS);
    assert.ok(clock.kind === 'assistant' && clock.frame.kind === 'other');
    assert.equal(toHex(clock.frame.data), '063471CD');
  });
});

describe('corpus: vmi-status.txt (reassembled telegrams)', () => {
  const lines = loadVmiStatus();
  const telegrams = lines.map(({ data, destinationId, dbm }) => ({
    ...parseErp1(data),
    destinationId,
    dbm,
  }));
  const classified = telegrams.map((t) => classifyTelegram(t, IDS));

  it('classifies every telegram as documented', () => {
    assert.deepEqual(countBy(classified, label), {
      'unit 0': 10,
      'unit 1': 10,
      'unit 2': 10,
      'unit 3': 10,
      'unit 4': 12,
      'unit 5': 10,
      'unit 6': 10,
      'unit 7': 10,
      'unit 8': 10,
      'assistant 1': 10,
      'assistant 3': 1,
      'assistant 4': 1,
      'unit>assistant 0': 1,
    });
  });

  it('decodes every unit status with plausible values', () => {
    const guard = new MachineIdGuard();
    for (const c of classified) {
      if (c.kind !== 'unit_status') continue;
      assert.equal(c.telegram.destinationId, BASE_ID);
      const s = c.status;
      switch (s.command) {
        case 0:
          assert.ok(s.mode !== undefined && s.season !== undefined && s.functions !== undefined);
          assert.equal(s.eventTypeRaw, undefined); // firmware 3.7: 11 payload bytes
          break;
        case 1:
          assert.ok(s.airflow !== undefined && s.airflow > 0 && s.airflow <= 350);
          assert.ok(s.systemState !== undefined);
          assert.ok(s.motorSpeed !== undefined && s.motorSpeed <= 5);
          break;
        case 2:
          assert.ok(s.outdoorTemperature !== undefined);
          assert.ok(s.outdoorTemperature > -30 && s.outdoorTemperature < 45);
          assert.ok(s.filterClogging !== undefined && s.filterClogging <= 100);
          break;
        case 3:
          assert.ok(s.machineId !== undefined);
          assert.notEqual(guard.check(s.machineId).result, 'mismatch');
          assert.deepEqual(s.errors, []);
          assert.equal(s.consumptionRaw, undefined); // absent on firmware 3.7
          break;
        case 4:
          assert.equal(s.firmwareVersion, '3.7');
          assert.equal(s.hardwareVersion, undefined);
          break;
        case 5:
        case 6:
          for (const probe of s.probes) {
            if (probe.position === null) continue;
            assert.ok(
              probe.temperature !== undefined && probe.temperature > -30 && probe.temperature < 45,
            );
            assert.ok(probe.humidity !== undefined && probe.humidity <= 110);
          }
          break;
        case 7:
          assert.equal(s.bypasses.length, 3);
          break;
        case 8:
          assert.equal(s.sensorId, ASSISTANT);
          break;
        default:
          assert.fail(`unexpected command ${s.command}`);
      }
    }
    assert.equal(guard.expected, '0A0B0C0D');
  });

  it('matches hand-decoded frames of the first full status set', () => {
    const at = (line: number): ClassifiedTelegram =>
      classified[lines.findIndex((l) => l.line === line)]!;
    // Line 3: CMD 0 -> Standard, winter, max supply 30 °C, at −67 dBm.
    const cmd0 = at(3);
    assert.ok(cmd0.kind === 'unit_status' && cmd0.status.command === 0);
    assert.equal(cmd0.status.mode, 'standard');
    assert.equal(cmd0.status.season, 'winter');
    assert.equal(cmd0.status.maxSupplyTemperature, 30);
    assert.equal(cmd0.telegram.dbm, -67);
    // Line 4: CMD 1 -> 108 m³/h, normal, speed 3.
    const cmd1 = at(4);
    assert.ok(cmd1.kind === 'unit_status' && cmd1.status.command === 1);
    assert.equal(cmd1.status.airflow, 108);
    assert.equal(cmd1.status.systemState, 'normal');
    // Line 5: CMD 2 -> 12 °C outside, 2117 days.
    const cmd2 = at(5);
    assert.ok(cmd2.kind === 'unit_status' && cmd2.status.command === 2);
    assert.equal(cmd2.status.outdoorTemperature, 12);
    assert.equal(cmd2.status.operatingTimeDays, 2117);
    // Line 88: CMD 2 at 5316 s -> 0x0B = 11 °C outside.
    const later = at(88);
    assert.ok(later.kind === 'unit_status' && later.status.command === 2);
    assert.equal(later.status.outdoorTemperature, 11);
    // Line 6: CMD 3 -> machine ID 0A0B0C0D, 4 weeks.
    const cmd3 = at(6);
    assert.ok(cmd3.kind === 'unit_status' && cmd3.status.command === 3);
    assert.equal(cmd3.status.machineId, '0A0B0C0D');
    assert.equal(cmd3.status.weeksSinceMaintenance, 4);
    // Line 7: CMD 4 -> Purevent, 300 m³, 2019-06-15, firmware 3.7.
    const cmd4 = at(7);
    assert.ok(cmd4.kind === 'unit_status' && cmd4.status.command === 4);
    assert.equal(cmd4.status.ventilatedVolume, 300);
    assert.equal(cmd4.status.installationYear, 2019);
    // Line 8: CMD 5 -> supply 12 °C 92 %, intake 11 °C 100 %.
    const cmd5 = at(8);
    assert.ok(cmd5.kind === 'unit_status' && cmd5.status.command === 5);
    assert.equal(cmd5.status.probes[0]?.humidity, 92);
    assert.equal(cmd5.status.probes[1]?.temperature, 11);
    // Line 9: CMD 6 -> no probe; line 10: CMD 7 -> unused bypass slots; line 11: CMD 8.
    const cmd6 = at(9);
    assert.ok(cmd6.kind === 'unit_status' && cmd6.status.command === 6);
    assert.ok(cmd6.status.probes.every((p) => p.position === null));
    const cmd8 = at(11);
    assert.ok(cmd8.kind === 'unit_status' && cmd8.status.command === 8);
    assert.equal(cmd8.status.room, 'living_room');
    // Line 2: Assistant CMD 1 -> battery 4, 20.45 °C, 60 %, at −55 dBm.
    const assistant = at(2);
    assert.ok(assistant.kind === 'assistant' && assistant.frame.kind === 'measurement');
    assert.equal(assistant.frame.temperature, 20.45);
    assert.equal(assistant.telegram.dbm, -55);
    // Line 53: short unit -> Assistant frame, level unknown.
    const short = at(53);
    assert.equal(short.kind, 'unit_to_assistant');
    assert.equal(short.telegram.dbm, undefined);
  });
});
