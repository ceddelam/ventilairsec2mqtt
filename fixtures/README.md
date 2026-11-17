# Real frame corpus

Raw ESP3 frames received from a PureVent unit and its Assistant, for decoding tests. EnOcean IDs
are replaced (CRCs recomputed) and dates removed.

| Device | ID in the corpus |
|---|---|
| Unit | `0400AA01` |
| Assistant | `0400AA02` |
| Stick Base ID | `FFAA0000` |

## `assistant-vmi.txt`

One frame per line: seconds since the first frame, a space, the full ESP3 packet in hexadecimal
(from `55` to the final CRC). Captured with an unpaired stick: only Assistant ↔ unit exchanges.

| Count | Sender → destination | Frame (protocol.md) |
|---|---|---|
| 76 | Assistant → unit | `CMD 1` cyclic (§ 4) |
| 15 | Assistant → unit | `CMD 3` wake-up (§ 4) |
| 15 | Assistant → unit | `CMD 4` clock, content unknown (§ 4) |
| 9 | Unit → Assistant | short `CMD 0`, content unknown (§ 5.9) |

## `vmi-status.txt`

Telegrams received by a paired stick over about 100 minutes: ten full status sets of the unit
(`CMD 0`–`8`, addressed to the stick's Base ID), the Assistant's frames to the unit and one short
unit → Assistant frame. The stick's Base ID is replaced by `FFAA0000`; the machine ID
(`0A0B0C0D`), the installation date and the volume are replaced too.

One telegram per line: seconds since the first telegram, destination ID, received level in dBm
(`-` when unknown), then the ERP1 telegram in hexadecimal from the RORG to the status byte. Chained
messages are already reassembled: the RORG `40` pieces were not recorded.

| Count | Sender → destination | Frame (protocol.md) |
|---|---|---|
| 10 per command, 12 for `CMD 4` | Unit → stick | `CMD 0`–`8` (§ 5); two extra `CMD 4` answer clock frames (§ 6.2) |
| 10 | Assistant → unit | `CMD 1` (§ 4) |
| 1 | Assistant → unit | `CMD 3` (§ 4) |
| 1 | Assistant → unit | `CMD 4` (§ 4) |
| 1 | Unit → Assistant | short `CMD 0` (§ 5.9) |

## To come

Raw chained pieces (RORG `40`) as sent over the air.
