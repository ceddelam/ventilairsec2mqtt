# ventilairsec2mqtt

This app connects a Ventilairsec ventilation unit (PureVent range) and its "Assistant" wall
sensor to Home Assistant over EnOcean radio (868 MHz, profile MSC D1-079), through MQTT:

- it reads the unit's status (mode, airflow, temperatures and humidity of its probes, filter,
  bypass, errors…) and the Assistant's temperature, humidity and battery;
- it controls the unit: mode, boost, holiday, fixed airflow, over-ventilation, bypass source,
  setpoints, clock, filter reset;
- it creates the Home Assistant devices and entities itself (MQTT discovery).

Independent project, not affiliated with Ventilairsec. Ventilairsec and PureVent are trademarks
of their owners.

## Requirements

- An **EnOcean USB stick** based on the TCM310 module (EnOcean USB 300 or equivalent), plugged
  into the Home Assistant host, or into another computer near the unit (see
  [The stick on another computer](#the-stick-on-another-computer)). An **868 MHz antenna** on the
  stick makes a big difference: without one, a USB 300 hears the unit poorly and often not the
  Assistant at all.
- An **MQTT broker**: the Mosquitto broker app is the simplest; any other broker works.
- The Home Assistant **MQTT integration**, connected to that broker.

The stick is used by this app only: stop any other program that reads it (another app, an
EnOcean integration).

## Installation

1. Add the repository to Home Assistant:

   [![Open your Home Assistant instance and show the add app repository dialog with this repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fceddelam%2Fventilairsec2mqtt)

   or, in **Settings > Apps > App store**, menu **⋮ > Repositories**, add
   `https://github.com/ceddelam/ventilairsec2mqtt`.
2. Install **ventilairsec2mqtt** from the store.
3. In the **Configuration** tab, set **Stick port** (see below) and save. Leave **Ventilation
   unit ID** empty for now.
4. Start the app and open the **Log** tab: the app runs in scan mode and lists the Ventilairsec
   devices it hears (see [Finding the IDs](#finding-the-ids)).
5. Set **Ventilation unit ID**, restart the app. The devices appear in **Settings > Devices &
   services > MQTT** once the unit has sent its status (within a few seconds if the unit is
   paired with the stick, see [Pairing](#pairing) otherwise).

## Configuration

| Option | Default | Description |
|---|---|---|
| `serial_port` | `/dev/ttyUSB0` | The stick: a serial device, preferably its stable name `/dev/serial/by-id/usb-EnOcean…` (listed in **Settings > System > Hardware > All hardware**), or `socket://host:port` for a stick shared with ser2net. |
| `fallback_port` | — | Optional second port (same forms). The app switches to it after 3 failures of `serial_port` and comes back as soon as `serial_port` answers again. |
| `vmi_id` | empty | EnOcean ID of the ventilation unit, 8 hexadecimal digits (e.g. `0400AA01`). Empty: scan mode. |
| `assistant_id` | — | EnOcean ID of the Assistant. Optional: learnt from the unit's list of paired sensors, or from the frames the Assistant sends to the unit. |
| `sender_id` | — | ID the app transmits with. Empty: the stick's Base ID (shown by the bridge's **Sender ID** sensor). It must lie between the Base ID and Base ID + 127. |
| `force_base_id` | — | Rewrites the stick's Base ID (`FF800000` to `FFFFFF80`, multiple of `80`). The stick accepts only about 10 rewrites in its lifetime: leave empty unless you must reuse a known ID. |
| `accept_pairing` | on | Answer the unit's pairing requests (see [Pairing](#pairing)). |
| `sync_clock` | on | Set the unit's clock at each connection and every hour, in Home Assistant's time zone. |
| `topic_prefix` | `ventilairsec2mqtt` | Prefix of the app's MQTT topics. |
| `discovery_prefix` | `homeassistant` | Home Assistant's MQTT discovery prefix, as set in the MQTT integration. |
| `log_level` | `info` | `debug`, `info`, `warning` or `error`. `debug` also logs every radio frame. |
| `mqtt_host` | — | Empty: the broker of the Mosquitto broker app (given by the Supervisor). Set it to use another broker. |
| `mqtt_port` | 1883 | 8883 by default with TLS. |
| `mqtt_user`, `mqtt_password` | — | Credentials for `mqtt_host`. |
| `mqtt_tls` | off | Connect to `mqtt_host` with TLS. |

Optional options are shown with **Show unused optional configuration options**.

## Finding the IDs

With an empty **Ventilation unit ID** the app runs in **scan mode**: it connects to the stick and
the broker, publishes only its own device (the bridge), transmits nothing, and logs each
Ventilairsec device it hears, once, with a guess of what it is, the device it talks to and the
signal level:

```text
INFO Heard 0400AA01 → FFAA0000 (-67 dBm): ventilation unit (D1-079-01), status CMD 4 addressed to this stick (paired with it) → set vmi_id to 0400AA01
INFO Heard 0400AA02 → 0400AA01 (-55 dBm): Assistant (D1-079-00), CMD 1 addressed to the unit → candidate for assistant_id (optional, learnt automatically)
INFO Unit 0400AA01 lists paired sensor 0400AA02 (profile assistant, room living_room) → candidate for assistant_id
```

- A unit **paired with the stick** addresses its status to the stick's ID: it is found within
  10 minutes (the unit sends its status at least every 10 minutes).
- A unit **not paired** with the stick talks only to its Assistant (and to another controller if
  it has one): the app then guesses from the frames ("probably a ventilation unit", "probably an
  Assistant"). The Assistant talks to the unit every 10 minutes.
- A unit that was just **powered on** asks to pair every minute ("ventilation unit asking to
  pair"): this is the most direct way to find its ID.

Then set **Ventilation unit ID** (and, if you like, **Assistant ID**) and restart the app. The
scan device disappears from Home Assistant when the app stops.

## Pairing

The unit only obeys the transmitters it is paired with. If the unit's entities stay unavailable
after setting its ID, or orders have no effect, pair it with the stick:

1. Check that **Accept pairing** is on and **Ventilation unit ID** is set, and (re)start the app.
2. Power-cycle the unit (switch it off and on at its circuit breaker). For about 6 hours after
   power-on, it sends a pairing request every minute.
3. The app answers the first request it hears. The log shows `Answering the unit's teach-in query
   as FFAA0000` then `Teach-in response sent`. The app only answers when the unit has sent
   nothing to the stick for 15 minutes, and at most every 10 minutes.
4. It worked when the unit sends its full status to the stick, within a minute: the
   **Ventilairsec <type>** device appears in Home Assistant (or its entities get values). With
   **Log level** `debug`, the log shows `Unit status CMD 0 (-67 dBm)` lines.
5. Turn **Accept pairing** off and restart the app, so that it never answers again.

Pairing with the stick does not unpair the Assistant or any other controller.

## The stick on another computer

When the unit is too far from the Home Assistant host for the radio, plug the stick into a small
computer near the unit (for example a Raspberry Pi) and share it over the network with
[ser2net](https://github.com/cminyard/ser2net). ser2net 4 configuration
(`/etc/ser2net.yaml`):

```yaml
connection: &enocean
  accepter: tcp,3333
  enable: on
  connector: serialdev,/dev/serial/by-id/usb-EnOcean_GmbH_EnOcean_USB_300_…-if00-port0,57600n81,local
  options:
    kickolduser: true
```

Then set **Stick port** to `socket://<computer>:3333`.

ser2net has no authentication: anyone who can reach the port can read the radio and control the
unit. **Keep the port firewalled**, open only to the Home Assistant host.

Another way: run ventilairsec2mqtt itself on that computer as a standalone service; then only
MQTT crosses the network. See
[docs/install-standalone.md](https://github.com/ceddelam/ventilairsec2mqtt/blob/main/docs/install-standalone.md).

## Entities

The app creates three devices:

- **Ventilairsec <type>** (the unit): mode, boost and holiday (with their durations), fixed
  airflow, over-ventilation, time schedule, bypass source and setpoints; airflow, motor speed,
  system state, season, temperatures and humidity of the internal probes, outdoor temperature,
  preheating power, filter clogging and days left, problem and self-test, bypass openings,
  diagnostic values (pressure setpoint, operating time, installation date, paired sensors, signal
  strength…). Entities for optional equipment (Hydro'R, SolarR, extra bypasses and probes) only
  appear when the unit reports it.
- **Ventilairsec Assistant**: temperature, humidity, battery, signal strength.
- **ventilairsec2mqtt** (the bridge): stick connection, stick problem, active port, sender ID.

Entity IDs are fixed and in English (`select.ventilairsec_mode`,
`sensor.ventilairsec_assistant_temperature`…). Every value is also available as one JSON
message per device on MQTT (`ventilairsec2mqtt/<id>`). The complete list of entities, topics and
orders is in
[docs/mqtt-interface.md](https://github.com/ceddelam/ventilairsec2mqtt/blob/main/docs/mqtt-interface.md).

An entity is unavailable when the app is stopped, or when its device has sent nothing for
30 minutes.

## Troubleshooting

- **`Stick connection failed on …`** (`No such file or directory`, `Cannot lock port`, `Resource
  temporarily unavailable`): wrong port, or another program holds the stick. Check the port in **Settings > System > Hardware**, prefer the
  `/dev/serial/by-id/…` name, and stop any other app or integration using the stick.
- **No frame at all** (scan mode lists nothing, or entities stay unavailable): check the
  distance and the antenna. The unit sends its status at least every 10 minutes and the
  Assistant talks to it every 10 minutes: wait that long before concluding. Set **Log level** to
  `debug` to see every packet received (`RX …`) and, for the unit and the Assistant, the signal
  level (`Unit status CMD 1 (-67 dBm)`, also in the **Signal strength** sensors); below about
  −90 dBm, reception is unreliable.
- **The unit is heard but its entities stay unavailable**, or orders have no effect: the unit is
  not paired with the stick (or not with the configured **Sender ID**): see
  [Pairing](#pairing).
- **Stick problem** turns on: the stick did not confirm a transmission, did not answer, or a
  status frame carried another machine ID (often a sign that another program reads the same
  stick). The **reason** attribute and the log tell which.
- **No MQTT service from the Supervisor**: install and start the Mosquitto broker app, or set
  **MQTT broker host**.
- **Debug logs**: set **Log level** to `debug`, restart, and attach the log to an issue on
  [GitHub](https://github.com/ceddelam/ventilairsec2mqtt/issues). The log holds your devices'
  EnOcean IDs; nothing else personal.
