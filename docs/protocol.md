# Ventilairsec radio protocol (EnOcean MSC D1-079)

This document collects **the known facts** about the protocol: frame layout, fields, values,
sequences. It contains no code. Every fact carries a source tag (**[E]**, **[T]**, **[P]**,
**[C]**) defined in [sources.md](sources.md). Where sources disagree, the disagreement is noted;
observations **[C]** settle it when they exist. Open questions are listed at the end.

Conventions: bytes in hexadecimal; bit *offsets* count from the most significant bit of the first
byte of the MSC payload (see § 3), as in EEP profiles.

## 1. ESP3 serial link [E]

- 57,600 baud, 8N1, no flow control. The stick can also be reached through a TCP bridge (ser2net):
  same byte stream, no negotiation [C].
- Packet: `55` | 4-byte header (data length on 2 bytes big-endian, optional length on 1 byte,
  packet type) | header CRC8 | data | optional data | CRC8 of data + optional data.
- CRC8: polynomial `0x07`, initial value `0`, no reflection, no final XOR.
- Resynchronisation: on a bad header CRC, drop the `55` byte and look for the next one.
- Useful packet types: `01` RADIO_ERP1, `02` RESPONSE, `04` EVENT, `05` COMMON_COMMAND.
- Common commands:
  - `08` CO_RD_IDBASE → response: return code (`00` = OK), Base ID (4 bytes); optional data:
    number of Base ID writes left.
  - `07` CO_WR_IDBASE + 4 bytes: writes the Base ID (range `FF800000`–`FFFFFF80`, multiple of
    `0x80`, **at most 10 writes over the stick's lifetime**). Followed by `02` CO_WR_RESET.
- The first command sent right after opening a ser2net connection may get no response: repeat it
  once [T][C].
- A TCP connection cut without a close raises no error: a long silence (the unit transmits at least
  every 10 min) must trigger a reconnection [T][C].

### ERP1 radio telegram [E]

- Data: RORG (1 byte) | payload | sender ID (4 bytes) | status (1 byte).
- Optional data on receive: sub-telegram count | destination (4 bytes, `FFFFFFFF` = broadcast) |
  received level (1 byte, positive value meaning −dBm) | security level.
- Optional data on transmit: `03` | destination | `FF` | `00`.

## 2. Chained messages (RORG `40`)

The unit's full status messages exceed one telegram and arrive in pieces.

- Byte 1: `SEQ` (bits 7-6, message counter) and `IDX` (bits 5-0, piece index) [E][T].
  **Disagreement [P]**: 4 bits / 4 bits. Both readings agree for observed values (`IDX` < 4,
  `SEQ` < 4); follow [E].
- Piece `IDX = 0`: bytes 2-3 = total length of the reassembled message [E][T][P], counted from its
  own RORG and without the sender and status [P]: 12 for a `CMD 0` with 11 payload bytes (firmware
  3.7); the published example below announces 17, a longer `CMD 0`. Then the start of the
  message. **Disagreement [P]**: length read as two concatenated decimal numbers (`00 11` →
  "0" + "17"). Same result while the high byte is 0; follow [E] (16-bit integer).
- Following pieces: the message continues from byte 2 [T][P].
- Every piece ends with the sender (4 bytes) and the status, like any telegram.
- The reassembled message is a full telegram starting with its own RORG (`D1`); append the sender
  and status of the last piece [T][P].
- Reassembly key: sender + destination + `SEQ`. The unit also talks to the Assistant with the same
  sequence numbers: without the destination in the key, a lost piece makes two different messages
  glue together [T].
- Robustness on a busy radio [C]: drop an incomplete message after a few seconds (5 s is enough:
  pieces arrive together), cap the number of messages in progress (16), discard pieces from unknown
  senders before reassembly.
- Published example [P] (17 bytes): `40 40 00 11 D1 07 90 01 02 00 …`,
  `40 41 04 20 1C 1C 00 01 00 00 …`, `40 42 00 00 00 00 …`.

## 3. MSC envelope (RORG `D1`)

- Payload: 12-bit manufacturer ID (`079` = Ventilairsec) then a 4-bit command number `CMD`, so the
  first two bytes are `07 9x` with `x = CMD` [T][P][C].
- Field offsets below: bit 0 = most significant bit of the `07` byte; `CMD` uses bits 12 to 15;
  data starts at bit 16.
- A field whose offset lies beyond the received length is absent: short frames exist [T][C].
- Profiles: `D1-079-00` = Assistant (wall sensor), `D1-079-01` = ventilation unit [T][P][C].
- Every frame from the unit and the Assistant is addressed (destination set) [C].

## 4. Assistant (`D1-079-00`)

Known commands [P]: `1` cyclic, `2` action, `3` wake-up, `4` clock, `7` test.
Observed [C]: `1` every ~10 min, `3` and `4` together about every hour, all addressed to the unit.

Fields of commands `1` and `3` [T][P][C]:

| Offset | Size | Field | Value |
|---|---|---|---|
| 16 | 8 | Battery | `0`–`6`. **Disagreement**: [T] (n − 1) × 20 % for 1–6; [P] n × 100 / 6 %. Both give 100 % for 6. Raw values 6 and 4 observed [C]; which formula is right is still open. |
| 24 | 16 | Temperature | raw / 100 − 40 °C (raw 0–16,500 → −40 to 125 °C) |
| 40 | 8 | Relative humidity | % |

Example [C]: `D1 07 91 06 17 D8 27` → battery 6, 21.04 °C, 39 %.
Command `4`: content unknown (examples [C]: `07 94 06 34 71 CD`, `07 94 10 B3 06 7C`).

## 5. Unit status frames (`D1-079-01`)

The unit sends commands `0` to `8` to the paired sender (addressed to its ID), at least every
10 min and after each order received [T][C]. The nine frames of a full status arrive within about
10 s, every 10 min [C]. It also sends short frames to the Assistant (§ 5.9).

### 5.1 `CMD 0` — current data

| Offset | Size | Field | Values |
|---|---|---|---|
| 16 | 8 | Mode | `0` Standby, `1` Eco, `2` Standard, `3` Comfort [T][P] |
| 24 | 8 | Function byte (details below) | |
| 26 | 1 | Bypass | `0` roof, `1` other source [T][P] |
| 27 | 1 | Time schedule | 0/1 [T][P] |
| 28 | 1 | Fixed airflow | 0/1 [T][P] |
| 30 | 1 | Over-ventilation | 0/1 [T][P] |
| 31 | 1 | Holiday | 0/1. The number of days left is **not** sent: identical frames for 1 and 3 days [C]. |
| 32 | 8 | Boost | [P] `0` off, `1` or `255` on with unknown time left, `2`–`200` minutes left. **Firmware 3.7 [C]**: stays `1` during the whole boost (flag only). |
| 40 | 8 | Electric preheating setpoint | °C. [P] `4` = disabled, range 12–18. A unit whose preheating power always stays at 0 reports `4` [C]. |
| 48 | 8 | Maximum supply temperature | °C, 20–45 [T][P] |
| 56 | 8 | Hydro'R setpoint | °C. [P] `6` = disabled, range 8–28. `0` when the option is absent [C]. |
| 64 | 8 | SolarR setpoint | °C. [P] `0` = disabled, range 18–30. `0` when the option is absent [C]. |
| 76 | 1 | Firmware update in progress | 0/1 [T][P] |
| 77 | 1 | Pairing mode | 0/1 [T][P] |
| 78 | 1 | Test | 0/1 [T][P] |
| 79 | 1 | Localisation | 0/1 [P] (meaning unknown) |
| 80 | 8 | Season | `0` summer, `1` winter, `2` mid-season [T][P] |
| 88 | 8 | Event type | `0` periodic storage, `1` event-driven [P] |

Bits 24, 25 and 29 of the function byte: meaning unknown. Bits 72 to 75: always 0 so far.

Firmware 3.7 sends 11 payload bytes: the event type (offset 88) is absent [C].

Example [C]: `D1 07 90 02 32 00 04 1E 00 00 00 01` → Standard; function byte `32`: bypass other
source, time schedule on, fixed airflow off, over-ventilation on, holiday off; boost off;
preheating `4` (disabled); max supply 30 °C; Hydro'R and SolarR `0`; season winter.

### 5.2 `CMD 1` — complement 1

| Offset | Size | Field | Values |
|---|---|---|---|
| 16 | 16 | Airflow | m³/h, 0–350 [T][P]. Discrete values observed [C]: 50, 60, 87, 108, 133, 139, 157; 108 in Standard, 157 in boost. |
| 32 | 8 | Preheating power | %, 0–100 [T][P] |
| 40 | 8 | System state | `0` boost, `1` holiday, `2` standby, `3` fixed airflow, `4` normal [T][P] |
| 48 | 8 | Motor speed setpoint | 0–5 [P]. **Read-only**: no order sets it directly (§ 6). Observed [C]: 0 in standby, 1 in holiday, 3 (sometimes 4 or 5) in Standard, 5 in boost. |

### 5.3 `CMD 2` — complement 2

| Offset | Size | Field | Values |
|---|---|---|---|
| 16 | 8 | Outdoor temperature | °C, signed (two's complement) [T][P] |
| 24 | 16 | Differential pressure setpoint | raw 0–600 [P]; [T]: tenths of a pascal. This is the **target** of the fan control loop, not a measurement [C]: it follows the speed (raw/10 ≈ 3.6 at speed 0, 4.8 at 1, 13–22 at 3, 26 at 4, 29 at 5) and rises by steps of 0.8 every 10 min at constant speed. |
| 40 | 8 | Filter clogging | %, 0–100 [T][P]; +1 about every 4 days [C]. The maker's app shows 100 − value as "remaining life" [T]. |
| 48 | 8 | Water loop duty cycle | % [T][P] |
| 56 | 16 | Operating time | days: +1 every ~23 h 40 min [C] |

### 5.4 `CMD 3` — maintenance

| Offset | Size | Field | Values |
|---|---|---|---|
| 16 | 32 | Machine ID | never changes [T][C]: a frame carrying another one was badly reassembled |
| 51 | 1 | Air quality test | 1 OK, 0 failed [P] |
| 52 | 1 | Motor test | 1 OK, 0 failed [P] |
| 53 | 1 | Preheating test | 1 OK, 0 failed [P] |
| 54 | 1 | Probe test | 1 OK, 0 failed [P] |
| 55 | 1 | Overall test | 1 OK, 0 failed [T][P] |
| 56 | 8 | Error code 1 | `00` or `FF` = none; table § 5.10 |
| 64 | 8 | Error code 2 | same |
| 72 | 8 | Weeks since last maintenance | [T][P]; the maker's app derives the filter life from it (365 days − elapsed) [T] |
| 80 | 8 | Cumulated consumption | unit unknown [T][P]; absent from firmware 3.7 frames [C] |

### 5.5 `CMD 4` — configuration

| Offset | Size | Field | Values |
|---|---|---|---|
| 16 | 8 | Unit type | `1` Purevent, `2` Urban, `3` ERP [T][P] |
| 29 | 1 | Upstream bypass present | 0/1 [T][P] |
| 30 | 1 | SolarR present | 0/1 [T][P] |
| 31 | 1 | Hydro'R present | 0/1 [T][P] |
| 32 | 16 | Volume to ventilate | m³, 20–2000 [T][P]. Set at installation, **read-only** over the radio (§ 6). |
| 48 | 8 | Installation year | + 2000 [T][P] |
| 56 | 8 | Installation month | [T][P] |
| 64 | 8 | Installation day | [T][P] |
| 72 | 8 | Firmware version | high nibble . low nibble (`37` → 3.7) [T][C] |
| 80 | 8 | Hardware version | same encoding [T]; absent from firmware 3.7 frames [C] |

Made-up example: `D1 07 94 01 04 01 2C 13 06 0F 37` → Purevent, upstream bypass present, 300 m³,
installed on 2019-06-15, firmware 3.7.

### 5.6 `CMD 5` and `CMD 6` — internal probes

`CMD 5` carries probes 0 to 2 (offsets 16, 40, 64), `CMD 6` probes 3 and 4 (offsets 16, 40).
Each probe takes 24 bits [T][P]:

| Shift | Size | Field |
|---|---|---|
| +0 | 8 | Position: `0` heater outlet (supply air), `1` air intake, `2` water loop outlet, `3` after the solar panel, `4` bypass, `255` no probe |
| +8 | 8 | Temperature, °C, signed |
| +16 | 8 | Relative humidity, % |

Without Hydro'R or SolarR [C]: positions 0 and 1 present. The third slot of `CMD 5` is cut short
to `FF 00` (no humidity byte) and both `CMD 6` slots read `FF 00 00`. Humidity can exceed 100 %:
103 % observed at the air intake [C].

Example [C]: `D1 07 95 00 0C 5C 01 0B 64 FF 00` → heater outlet 12 °C 92 %, air intake 11 °C
100 %, third probe absent.

### 5.7 `CMD 7` — options

| Offset | Size | Field | Values |
|---|---|---|---|
| 16 | 8 | Bypass 1 opening | %, `255` = not applicable [T][P] |
| 24 | 8 | Bypass 1 position | `0` inactive, `1` other heat source, `2` solar heat source, `3` earth tube, `4` manual, `255` unknown [T][P] |
| 32 / 40 | 8 / 8 | Bypass 2 opening / position | same encoding [P] |
| 48 / 56 | 8 / 8 | Bypass 3 opening / position | same encoding [P] |
| 64 | 8 | Hydro'R valve opening | % [T][P] |

Unused bypass slots report opening `00` and position `FF` [C]: an opening of `255` does not mark
an absent bypass. Example [C]: `D1 07 97 00 FF 00 FF 00 FF 00`.

### 5.8 `CMD 8` — paired sensors

One frame per sensor [T][P]:

| Offset | Size | Field | Values |
|---|---|---|---|
| 16 | 32 | Sensor EnOcean ID | |
| 48 | 8 | Room | `0` unknown, `1` living room, `2` kitchen, `3` bathroom 1, `4` bathroom 2, `5`–`8` bedrooms 1 to 4, `9` utility room, `10` neutral zone |
| 56 | 8 | Profile | `1` Ventilairsec Assistant, `2` A5-04-01, `3` A5-09-04, `4` D2-04-08 |
| 64 | 8 | Sensor index | |

The Assistant shipped with the unit is listed [C].

### 5.9 Unit → Assistant frames

Short `CMD 0` frames (4 data bytes), addressed to the Assistant [C]: `D1 07 90 12 0F 01 1F`,
`D1 07 90 13 00 01 1F`. Meaning unknown; they do not describe the unit's state and must not be
decoded with § 5.1 [T][C].

### 5.10 Error codes [T]

| Code | Meaning |
|---|---|
| `01` | Heater failure |
| `02` | Too cold to heat |
| `10` | Motor failure |
| `20` | Filter to replace |
| `30` | Air quality sensor failure |
| `31`–`39` | Air quality sensor no. 1 to 9 failure |
| `3A` | Several air quality sensors failed |
| `3B` | Air quality sensor pairing problem |
| `40` | Unknown Assistant problem |
| `41` | Assistant temperature error |
| `42` | Communication lost with the Assistant |
| `43` | Assistant batteries low |
| `44` | Several Assistant failures |
| `51` | Heater outlet probe failure |
| `52` | Unit intake probe failure |
| `53` | Hydro'R outlet probe failure |
| `55` | Bypass outlet probe failure |
| `56` | Bypass outdoor air probe failure |
| `57` | Bypass attic probe failure |
| `5F` | Several probes failed |
| `61` | Bypass error |
| `65` | Firmware download error |
| `70` | Multiple errors |
| `81`, `82` | Bypass communication problem |
| `83` | Bypass flap stuck |

## 6. Orders sent to the unit

Transmission [T][P][C]: RORG `D1`, sender = paired ID (§ 7), status `80`, destination
**`FFFFFFFF` (broadcast)**. The unit answers with its status frames (§ 5), which act as an
acknowledgement.

No known order sets the motor speed, the airflow, the pressure setpoint or the volume to
ventilate: ventilation is driven through the mode, boost, holiday, fixed airflow and
over-ventilation [T][P].

### 6.1 `CMD 0` — settings

Payload `07 90` then 9 bytes in this order [T][P]; **`FF` = leave unchanged**:

| Rank | Field | Values |
|---|---|---|
| 1 | Mode | `0`–`3` as in § 5.1 |
| 2 | Function byte | bit 5 bypass (1 = other source), bit 4 time schedule, bit 3 fixed airflow, bit 1 over-ventilation, bit 0 holiday |
| 3 | Holiday | number of days, `0` = stop |
| 4 | Boost | duration in minutes, `0` = stop |
| 5 | Electric preheating setpoint | °C |
| 6 | Maximum supply temperature | °C |
| 7 | Hydro'R setpoint | °C |
| 8 | SolarR setpoint | °C |
| 9 | One-shot command | `1` = request a data refresh [P]; `4` = filter reset [T] |

- The function byte is sent whole: start from the last value received (§ 5.1, offset 24), change
  one bit, send it back. The holiday bit (0) is cleared in that byte, holidays going through
  rank 3 [T].
- Sending `1` at rank 9 along with a setting change asks for the state back [P]; without it, the
  state comes back anyway [C].
- Mode changes (Eco, Standard) verified on firmware 3.7 [C].

### 6.2 `CMD 1` — clock

Payload `07 91` then year (last 2 digits), month, day, hour, minute, second, one binary byte each
[T]. Used by the time schedule. The unit answers with its `CMD 4` frame within a second [C].

### 6.3 `CMD 2` — schedule

Exists [P] (time schedule), format unknown.

## 7. Pairing (UTE, RORG `D4`)

The unit only obeys paired senders. Sending orders while it is in pairing mode is not enough [C].

- After power-on, the unit broadcasts a UTE teach-in query every minute for about **6 hours**,
  while still obeying already paired senders [C].
- Observed query [C]: `D4 80 FF 79 00 00 01 D1`, i.e. per UTE [E]: `80` = bidirectional, response
  expected, teach-in request, "query" command; `FF` = channels; `79 00` = manufacturer `079`;
  `00` = TYPE, `01` = FUNC, `D1` = RORG. Only request type `00` (teach-in) has been seen; type
  `10` (teach-in or deletion) is not handled.
- Pairing response [E][C]: `D4 91` then the next 6 bytes of the query copied
  (`FF 79 00 00 01 D1`), sent from the ID to pair, **addressed to the unit**, status `00`.
  `91` = bidirectional, "teach-in accepted", "response" command.
- The unit then sends its full status (§ 5) addressed to that ID: proof of pairing [C].
- Sender ID: the stick's Base ID works [C]. Other controllers used their stick's Base
  ID (or Base ID + 1, + 2…) [T].
- Caution [C]: answer at most once every 10 min, and only if the unit has addressed nothing to our
  ID for 15 min (once paired, it keeps asking for 6 h). Make the response switchable off once
  paired.

## 8. Timing and radio [C]

| Sender | Frame | Rate |
|---|---|---|
| Unit → paired sender | full status `CMD 0`–`8` | at least every 10 min, and after each order |
| Unit → Assistant | short `CMD 0` | with each Assistant exchange |
| Assistant → unit | `CMD 1` | ~10 min |
| Assistant → unit | `CMD 3` + `CMD 4` | ~1 h |
| Unit (after power-on) | UTE `D4` | 1 / min for ~6 h |

A USB 300 stick without an antenna hears the unit poorly (−91 to −95 dBm) and the Assistant not at
all; with an 868 MHz antenna, about −67 dBm for the unit and −55 to −74 dBm for the Assistant
within the same floor.

## 9. Open questions

- [ ] Assistant battery encoding (two formulas, § 4): record a value below 6.
- [ ] Unit of the pressure setpoint (§ 5.3) and what makes it rise at constant speed.
- [ ] Link between airflow, speed and volume to ventilate (§ 5.2, § 5.5).
- [ ] Unit of cumulated consumption (§ 5.4).
- [ ] Meaning of bits 24, 25, 29 of the function byte and of the "localisation" bit (79).
- [ ] Content of the Assistant's `CMD 4` and of the short unit → Assistant frames.
- [ ] Schedule format (`CMD 2` sent).
- [ ] Actual effect of `COMMAND = 1` (refresh request) on firmware 3.7.
- [ ] Whether the unit accepts the "disabled" values (preheating `4`, Hydro'R `6`, SolarR `0`) as
  orders, to switch a setpoint off.
- [ ] Size of the chained pieces sent by the unit (only reassembled messages recorded so far).
- [ ] Raw chained pieces (RORG `40`) to capture: the corpus holds reassembled messages only.
