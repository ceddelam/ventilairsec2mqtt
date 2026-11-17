# Architecture

Phase 1 is the protocol core: framing, decoding, orders and the link to the EnOcean stick. It
has no MQTT and no Home Assistant code; the bridge of phase 2 builds on the API below. Radio
facts refer to [protocol.md](protocol.md).

## Layers

```text
StickConnection   supervision: reconnect, silence, fallback port, Base ID       connection.ts
  └─ Stick        ESP3 session: request/response queue, RX dispatch            stick.ts
       ├─ Transport          TCP (socket://host:port) or serial (57600 8N1)    transport/
       ├─ Esp3Decoder        framing, CRC8, resynchronisation                  esp3/
       └─ ChainReassembler   RORG 40 pieces → one telegram                     chain.ts
classifyTelegram  who sent what to whom → decoded frame                        classify.ts
  ├─ decodeUnitStatus        unit CMD 0–8 (D1-079-01)                          msc/unit.ts
  └─ decodeAssistant         Assistant CMD 1/3 (D1-079-00)                     msc/assistant.ts
orders / pairing  telegrams to transmit, teach-in policy                       orders.ts, pairing.ts
```

Everything below `Stick` is pure (bytes in, values out) and tested without I/O. Side effects
(sockets, serial ports, timers) are confined to `transport/`, `stick.ts` and `connection.ts`;
timers and the clock are injected through the `Timers` interface, the logger through `Logger`
(no-op by default; raw RX/TX frames are logged at debug level).

## Modules

| Module | Role |
|---|---|
| `hex.ts` | Hex conversion; EnOcean IDs as 8-character upper-case strings (`EnOceanId`). |
| `esp3/crc8.ts`, `esp3/packet.ts` | CRC8 (poly `07`); `encodePacket`; `Esp3Decoder` fed with arbitrary chunks: drops garbage, resynchronises on a bad header CRC, skips a bad data CRC, bounds the announced length. |
| `esp3/commands.ts` | `CO_RD_IDBASE` (with remaining writes), `CO_WR_IDBASE` (range and alignment checked), `CO_WR_RESET`; RESPONSE return codes and EVENT codes. |
| `erp1.ts` | `parseErp1` (sub-telegrams, destination, dBm as a negative number, security level); `buildErp1Packet` (optional `03 | destination | FF | 00`). |
| `chain.ts` | `ChainReassembler`: key sender + destination + SEQ, SEQ bits 7-6 / IDX 5-0, 16-bit length, timeout (5 s), cap (16), sender allow-list, pieces in any order. |
| `msc/bits.ts`, `msc/envelope.ts` | Bit fields counted from the MSB of the MSC payload; a field beyond the payload is `undefined`, never 0. |
| `msc/assistant.ts` | Assistant commands 1 and 3 (raw battery 0–6, temperature, humidity); other commands kept raw. |
| `msc/unit.ts`, `msc/function-byte.ts`, `msc/errors.ts` | Unit commands 0–8, function byte bits, error code labels. |
| `classify.ts` | Tells unit status, unit → Assistant frames, Assistant frames and teach-in queries apart. |
| `machine-id.ts` | `MachineIdGuard`: flags a status frame carrying another machine ID. |
| `orders.ts` | `CMD 0` settings (ranks, `FF` = unchanged, validation), `CMD 1` clock, transmit telegram (status `80`, broadcast). |
| `pairing.ts` | UTE query detection, response telegram, `shouldAnswerTeachIn` policy. |
| `transport/` | `parseConnectionUrl`, `createTransport`, `TcpTransport`, `SerialTransport` (injectable port factory). |
| `stick.ts` | `Stick`: one command at a time, first command repeated once without answer, Base ID read/write, `send` with confirmation, `telegram` / `event` / `incident` events. |
| `connection.ts` | `StickConnection`: the object phase 2 holds. |

## Decoded values

- `undefined`: the field is absent from the frame (short frame) or its raw value is unknown;
  the matching `…Raw` field keeps the byte.
- `null`: the frame explicitly says disabled / no probe / not applicable (preheating `4`,
  Hydro'R `6` or `0`, SolarR `0`, probe position `255`, bypass opening or position `255`).
- Enumerations are lower-case strings: modes `standby|eco|standard|comfort`, seasons
  `summer|winter|mid_season`, system states `boost|holiday|standby|fixed_airflow|normal`, probe
  positions `supply|intake|water_loop|solar|bypass`, bypass positions, rooms, sensor profiles.
- Values whose meaning is uncertain stay raw: Assistant battery, pressure setpoint,
  consumption, operating time (days), localisation bit, event type.

## API for phase 2

```ts
import {
  StickConnection, classifyTelegram, MachineIdGuard, buildSettingsTelegram,
  updateFunctionByte, buildClockTelegram, buildTeachInResponse, shouldAnswerTeachIn,
} from './index.ts';

const link = new StickConnection({ primary: 'socket://bridge.example:3333', fallback: '/dev/ttyUSB0', logger });
link.on('connected', ({ port, baseId }) => { /* sender ID = option or baseId */ });
link.on('disconnected', ({ reason }) => { /* closed | silence | switching | stopped */ });
link.on('portSwitched', ({ from, to, reason }) => { /* primary_failures | primary_available */ });
link.on('incident', ({ reason }) => { /* transmission_not_confirmed | no_answer */ });
link.on('telegram', (telegram) => {
  const c = classifyTelegram(telegram, { unitId, assistantId, receiverIds: [senderId] });
  // c.kind: unit_status | unit_to_assistant | unit_to_other | assistant | teach_in_query | ignored
});
link.start();

const fn = updateFunctionByte(lastCmd0.functionByte, { fixedAirflow: true });
const result = await link.send(buildSettingsTelegram({ functionByte: fn, oneShot: 'refresh' }, senderId));
// result.confirmed, or result.reason: rejected | no_answer | not_connected
```

- **Orders**: one `SettingsOrder` per frame (`mergeSettings` combines several keys); invalid
  values throw `OrderError` with the field name. `updateFunctionByte` needs the last `CMD 0`
  function byte received.
- **Pairing**: on `teach_in_query`, call `shouldAnswerTeachIn(now, { lastAnswerAt,
  lastAddressedToUsAt }, { enabled })`, then send `buildTeachInResponse(telegram, senderId)`.
  The bridge records both timestamps.
- **Machine ID**: feed `CMD 3` machine IDs to a `MachineIdGuard`; on `mismatch`, raise a
  `machine_id_mismatch` incident.
- **Assistant ID**: when not configured, it can be learnt from the unit's `CMD 8` frames
  (profile `assistant`) or from the sender of frames addressed to the unit.
- **Base ID**: `forceBaseId` is an explicit opt-in; the write is attempted at most once per
  `StickConnection` and logged as a warning.

## Tests

`npm test` runs `node:test` directly on the TypeScript sources. Expected values are worked out
by hand from protocol.md on the frames of `fixtures/`; the whole corpus goes through framing,
parsing, classification and decoding. Transports are tested against an emulated stick: a local
TCP server (ser2net-like) and the `serialport` mock binding. Supervision tests use in-memory
transports and durations of a few milliseconds.
