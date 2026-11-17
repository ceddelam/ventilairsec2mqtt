# MQTT and Home Assistant interface

What the app publishes and listens to on MQTT, and the entities it creates in Home Assistant
through MQTT discovery. Radio fields refer to [protocol.md](protocol.md).

> Design for v1. It may still change until the first release.

## 1. Principles

- One JSON state message per device instead of one topic per value: atomic updates, few retained
  topics, easy to read with `mosquitto_sub`.
- Device-based discovery (`<discovery_prefix>/device/<id>/config`): one retained message declares a
  device and all its entities.
- Entities only for what a user looks at or acts on; static facts go to the device card
  (model, firmware, serial number) or to attributes.
- Entities tied to an option (Hydro'R, SolarR, extra bypasses) exist only when the unit reports the
  option.
- English only: keys, entity names and fixed entity IDs (`default_entity_id`:
  `<platform>.ventilairsec_<key>` for the unit, `<platform>.ventilairsec_assistant_<key>` for the
  Assistant, `<platform>.ventilairsec2mqtt_<key>` for the bridge).
- Identifiers prefixed with `ventilairsec2mqtt` so they never collide with another integration.

## 2. Topics

`<prefix>` = `topic_prefix` option, `ventilairsec2mqtt` by default. `<discovery_prefix>` =
`discovery_prefix` option, `homeassistant` by default: these two topics belong to Home Assistant
(its MQTT discovery prefix and birth topic, both set in its MQTT integration), not to the app;
only the `<prefix>_<id>` part identifies our devices. `<id>` = EnOcean ID in upper
case.

| Topic | Direction | Retained | Content |
|---|---|---|---|
| `<prefix>/bridge/state` | out | yes | `online` / `offline` (MQTT last will) |
| `<prefix>/bridge` | out | yes | bridge JSON state (§ 5) |
| `<prefix>/<vmi_id>` | out | yes | unit JSON state (§ 3) |
| `<prefix>/<vmi_id>/availability` | out | yes | `online`, or `offline` after 30 min without a frame |
| `<prefix>/<assistant_id>` | out | yes | Assistant JSON state (§ 4) |
| `<prefix>/<assistant_id>/availability` | out | yes | same rule |
| `<prefix>/<vmi_id>/set` | in | no | JSON order, e.g. `{"mode": "eco"}` or `{"boost": true}` (§ 6) |
| `<prefix>/<vmi_id>/set/<key>` | in | no | same order, raw value (used by Home Assistant) |
| `<discovery_prefix>/status` | in | — | Home Assistant birth message; on `online`: republish discovery and states |
| `<discovery_prefix>/device/<prefix>_<id>/config` | out | yes | discovery (§ 7) |

Every entity is available only when both the bridge and its device are `online`.

JSON states hold only known values; a value missing from a frame keeps its last known value. Keys
with `null` are unknown (for example a disabled setpoint).

## 3. Ventilation unit

Category: D = diagnostic, C = configuration, — = main.

### Controls

| Key | Entity | Values | Radio | Cat. |
|---|---|---|---|---|
| `mode` | select | `standby`, `eco`, `standard`, `comfort` | § 5.1, § 6.1 rank 1 | — |
| `boost` | switch | on: boost for `boost_duration`; off: stop | § 5.1, rank 4 | — |
| `boost_duration` | number 5–200 min, step 5 | kept by the app, default 30 | — | C |
| `holiday` | switch | on: holiday for `holiday_duration`; off: stop | § 5.1, rank 3 | — |
| `holiday_duration` | number 1–254 days | kept by the app, default 7 | — | C |
| `fixed_airflow` | switch | | § 5.1 bit 28, function byte | — |
| `over_ventilation` | switch | | § 5.1 bit 30, function byte | — |
| `time_schedule` | switch | | § 5.1 bit 27, function byte | C |
| `bypass_source` | select | `roof`, `other` | § 5.1 bit 26, function byte | C |
| `preheat_setpoint` | select | `off`, `12`–`18` °C | § 5.1, rank 5 | C |
| `max_supply_temperature` | number 20–45 °C | | § 5.1, rank 6 | C |
| `hydror_setpoint` | select, Hydro'R only | `off`, `8`–`28` °C | § 5.1, rank 7 | C |
| `solarr_setpoint` | select, SolarR only | `off`, `18`–`30` °C | § 5.1, rank 8 | C |
| `refresh` | button | requests a full status | rank 9 = `1` | D |
| `filter_reset` | button | after a filter change | rank 9 = `4` | C |
| `sync_clock` | button | sends the time now | § 6.2 | D |

The remaining boost or holiday time is not reported by firmware 3.7; the app exposes the end time
it computed as an attribute of the switch (`ends_at`), cleared when the unit reports the end.

### Measurements and states

| Key | Entity | Unit / class | Radio | Cat. |
|---|---|---|---|---|
| `system_state` | sensor, enum | `boost`, `holiday`, `standby`, `fixed_airflow`, `normal` | § 5.2 | — |
| `airflow` | sensor | m³/h, volume_flow_rate | § 5.2 | — |
| `motor_speed` | sensor | 0–5 | § 5.2 | — |
| `preheat_power` | sensor | %, power_factor | § 5.2 | — |
| `outdoor_temperature` | sensor | °C | § 5.3 | — |
| `supply_temperature`, `supply_humidity` | sensor | °C / % | § 5.6 position 0 | — |
| `intake_temperature`, `intake_humidity` | sensor | °C / % | § 5.6 position 1 | — |
| `water_loop_temperature`, `water_loop_humidity` | sensor, if present | °C / % | § 5.6 position 2 | — |
| `solar_temperature`, `solar_humidity` | sensor, if present | °C / % | § 5.6 position 3 | — |
| `bypass_temperature`, `bypass_humidity` | sensor, if present | °C / % | § 5.6 position 4 | — |
| `season` | sensor, enum | `summer`, `winter`, `mid_season` | § 5.1 | — |
| `filter_clogging` | sensor | % | § 5.3 | — |
| `filter_days_left` | sensor | d; estimate: max(0, 365 − 7 × weeks − 3) | § 5.4 | — |
| `pressure_setpoint` | sensor | Pa (raw / 10, unit unconfirmed) | § 5.3 | D |
| `ventilated_volume` | sensor | m³, volume | § 5.5 | D |
| `bypass_opening` | sensor | % ; attribute `position` | § 5.7 bypass 1 | D |
| `bypass_2_opening`, `bypass_3_opening` | sensor, if present | % ; attribute `position` | § 5.7 | D |
| `hydror_valve_opening` | sensor, Hydro'R only | % | § 5.7 | D |
| `water_loop_duty_cycle` | sensor, Hydro'R only | % | § 5.3 | D |
| `operating_time` | sensor | d, duration, total_increasing | § 5.3 | D |
| `weeks_since_maintenance` | sensor | wk | § 5.4 | D |
| `installation_date` | sensor | date | § 5.5 | D |
| `problem` | binary_sensor | problem; attributes `codes`, `labels` (§ 5.10) | § 5.4 | — |
| `self_test` | binary_sensor | problem (on = a test failed); attributes per test | § 5.4 | D |
| `firmware_update` | binary_sensor | update in progress | § 5.1 bit 76 | D |
| `pairing_mode` | binary_sensor | | § 5.1 bit 77 | D |
| `paired_sensors` | sensor | count; attribute list (ID, room, profile, index) | § 5.8 | D |
| `signal_strength` | sensor | dBm | ERP1 optional data | D |
| `last_seen` | sensor | timestamp | | D |

### Device card

- Name: "Ventilairsec <unit type>" (from § 5.5), manufacturer Ventilairsec.
- Model: unit type (§ 5.5); firmware version: `sw_version`; hardware version: `hw_version`;
  serial number: machine ID (§ 5.4).
- Identifier: `ventilairsec2mqtt_<vmi_id>`; `via_device`: the bridge.
- Options present (upstream bypass, Hydro'R, SolarR): device attributes in the JSON state only.

## 4. Assistant

| Key | Entity | Unit / class | Cat. |
|---|---|---|---|
| `temperature` | sensor | °C | — |
| `humidity` | sensor | %, humidity | — |
| `battery` | sensor | %, battery; raw × 100 / 6, rounded (encoding still open, protocol.md § 4); attribute `raw` | D |
| `signal_strength` | sensor | dBm | D |
| `last_seen` | sensor | timestamp | D |

Device card: "Ventilairsec Assistant", identifier `ventilairsec2mqtt_<assistant_id>`,
`via_device`: the bridge. `assistant_id` is optional: when empty, the app learns it from the
unit's paired sensor list (`CMD 8`, profile Assistant) and from the sender of `D1-079-00` frames
addressed to the unit. Unit status is only decoded from frames addressed to our sender ID, so the
unit's short frames to the Assistant are never mistaken for status, known Assistant ID or not.

## 5. Bridge

| Key | Entity | Unit / class | Cat. |
|---|---|---|---|
| `connection` | binary_sensor | connectivity: stick answering | D |
| `stick_problem` | binary_sensor | problem; attribute `reason` | — |
| `active_port` | sensor | `primary` / `fallback` | D |
| `sender_id` | sensor | ID used to transmit | D |

Device card: "ventilairsec2mqtt", identifier `ventilairsec2mqtt_bridge_<vmi_id>`, software
version = app version.

`stick_problem` turns on when the stick does not confirm a transmission, does not answer, or when a
status frame carries another machine ID (a sign that another program reads the stick). It turns
off after 30 min without a new incident.

## 6. Orders

JSON on `<prefix>/<vmi_id>/set` or raw value on `<prefix>/<vmi_id>/set/<key>`:

| Key | Value | Effect (protocol.md § 6) |
|---|---|---|
| `mode` | `standby`, `eco`, `standard`, `comfort` | rank 1 |
| `boost` | `true`/`false`, `ON`/`OFF`, or a number of minutes | rank 4 |
| `holiday` | `true`/`false`, `ON`/`OFF`, or a number of days | rank 3 |
| `fixed_airflow`, `over_ventilation`, `time_schedule` | `true`/`false`, `ON`/`OFF` | function byte |
| `bypass_source` | `roof`, `other` | function byte, bit 5 |
| `preheat_setpoint`, `hydror_setpoint`, `solarr_setpoint` | `off` or °C | ranks 5, 7, 8 |
| `max_supply_temperature` | °C | rank 6 |
| `boost_duration`, `holiday_duration` | number | stored by the app only |
| `refresh`, `filter_reset`, `sync_clock` | any | rank 9 / § 6.2 |

- Out-of-range values are rejected and logged, never clamped silently.
- Several keys in one JSON order become one radio frame.
- An order on the function byte waits for the first `CMD 0` frame (it needs the current byte).
- Optimistic state: published as soon as the stick confirms the transmission, then corrected by the
  unit's next status frame.

## 7. Discovery

- One retained message per device on `<discovery_prefix>/device/<prefix>_<id>/config` with `dev`
  (device card), `o` (origin: app name, version, URL) and `cmps` (entities).
- `unique_id` of an entity: `ventilairsec2mqtt_<id>_<key>`.
- `state_topic` = device JSON topic, `value_template` extracts the key; `json_attributes_topic`
  for attributes.
- Removing an entity (option disappeared): republish the device without it; removing a device:
  empty retained message.

## 8. Behaviour

- Clock sync every hour (`sync_clock` option, on by default).
- After each stick connection, a refresh request (rank 9 = `1`) asks the unit for its full status,
  so entities appear without waiting for the next periodic status.
- Automatic answer to pairing requests (`accept_pairing` option, protocol.md § 7).
- Fallback port (`fallback_port`): switch after 3 failures, back to the primary port as soon as it
  answers (probe every 5 min).
- Sender ID: `sender_id` option, otherwise the stick's Base ID. `force_base_id` rewrites the Base
  ID (limited operation, logged as a warning).
- Values "kept by the app" (`boost_duration`, `holiday_duration`) and the learned Assistant ID are
  stored in a small JSON file (`/data/state.json` in the app, path configurable) and survive
  restarts.
- Supervisor broker: when `mqtt_host` is empty, read host, port, user, password and TLS flag from
  the Supervisor services API (`http://supervisor/services/mqtt`, `SUPERVISOR_TOKEN`).
- Options are read from `/data/options.json` in the app (path configurable for other uses).
- Options: `serial_port`, `fallback_port`, `vmi_id`, `assistant_id`, `sender_id`,
  `force_base_id`, `sync_clock`, `accept_pairing`, `topic_prefix`, `discovery_prefix`,
  `log_level`, `mqtt_host`, `mqtt_port`, `mqtt_user`, `mqtt_password`, `mqtt_tls`.
  Surrounding spaces are ignored. External broker when `mqtt_host` is set, otherwise the
  Supervisor's (`mqtt:want`).
