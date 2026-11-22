# Standalone service (Raspberry Pi and other Linux computers)

ventilairsec2mqtt can run as a systemd service on the computer the EnOcean stick is plugged into,
for example a Raspberry Pi near the ventilation unit. Only MQTT then crosses the network: Home
Assistant (MQTT integration) and any other MQTT client use the broker. The MQTT interface is the
same as with the Home Assistant app ([mqtt-interface.md](mqtt-interface.md)).

Requirements:

- Debian 12 or 13, Raspberry Pi OS (Lite is enough) or another Linux with systemd;
- Node.js 20 or later at `/usr/bin/node` (Debian's `nodejs` package is fine, including on ARMv6
  boards such as the Raspberry Pi Zero W, where it is Node 20);
- an EnOcean USB 300 stick (TCM310), ideally with an 868 MHz antenna;
- an MQTT broker reachable from this computer (it can run on the same computer).

No npm, compiler or Internet access at run time: the release archive holds the program, its
dependencies and the serialport binding prebuilt for the usual Linux platforms (x64, ARMv6,
ARMv7, ARM64), so the same archive fits every computer. The unit file caps the service's memory
at 256 MB.

## Install

On the Raspberry Pi (Raspberry Pi OS Lite, any user with sudo):

```sh
sudo apt update
sudo apt install nodejs curl
node --version                       # v20 or later

VERSION=0.1.0
curl -fLO https://github.com/ceddelam/ventilairsec2mqtt/releases/download/v$VERSION/ventilairsec2mqtt-$VERSION.tar.gz
curl -fLO https://github.com/ceddelam/ventilairsec2mqtt/releases/download/v$VERSION/ventilairsec2mqtt-$VERSION.tar.gz.sha256
sha256sum -c ventilairsec2mqtt-$VERSION.tar.gz.sha256
tar -xzf ventilairsec2mqtt-$VERSION.tar.gz
sudo ./ventilairsec2mqtt-$VERSION/install.sh
```

The installer:

- creates the system user `ventilairsec2mqtt` (no login, no home);
- installs the program into `/opt/ventilairsec2mqtt/<version>/` and points
  `/opt/ventilairsec2mqtt/current` at it;
- creates `/etc/ventilairsec2mqtt/options.json` from the example **only if it does not exist**
  (owner `root`, group `ventilairsec2mqtt`, mode 640: readable by the service, not by other users,
  since it may hold the broker password);
- installs `/etc/systemd/system/ventilairsec2mqtt.service` and enables it;
- does not start the service the first time, until the options are edited.

It needs root, and Node.js 20 or later at `/usr/bin/node`. `install.sh --help` lists every option.

## Configure

Edit the options, then start the service:

```sh
sudo nano /etc/ventilairsec2mqtt/options.json
sudo systemctl restart ventilairsec2mqtt
systemctl status ventilairsec2mqtt
journalctl -u ventilairsec2mqtt -f
```

```json
{
  "serial_port": "/dev/serial/by-id/usb-EnOcean_GmbH_EnOcean_USB_300_…-if00-port0",
  "vmi_id": "",
  "accept_pairing": true,
  "sync_clock": true,
  "mqtt_host": "localhost",
  "mqtt_port": 1883,
  "mqtt_user": "ventilairsec2mqtt",
  "mqtt_password": "…",
  "mqtt_tls": false,
  "topic_prefix": "ventilairsec2mqtt",
  "discovery_prefix": "homeassistant",
  "log_level": "info"
}
```

The options are the same as in the Home Assistant app; see the app documentation
([ventilairsec2mqtt/DOCS.md](../ventilairsec2mqtt/DOCS.md)) for each of them, for finding the IDs
(scan mode: leave `vmi_id` empty and watch the journal) and for pairing. Differences:

- **Broker**: `mqtt_host` is required, since there is no Supervisor to ask. Use the broker Home
  Assistant's MQTT integration is connected to, so that discovery works. `mqtt_port` defaults to
  1883, or 8883 with `"mqtt_tls": true`; TLS checks the broker's certificate against the system
  certificates (`ca-certificates` package). Give the service its own broker account.
- **Serial port**: prefer the stable name under `/dev/serial/by-id/` (`ls -l /dev/serial/by-id/`)
  to `/dev/ttyUSB0`, which may change when another USB serial device is plugged in. The service
  user gets the `dialout` group, which owns the serial devices. The service is only allowed USB
  serial devices (`ttyUSB*`, `ttyACM*`): for a stick on another kind of device (e.g. an EnOcean
  module on the Pi's UART, `/dev/ttyAMA0`), add `DeviceAllow=/dev/ttyAMA0 rw` with
  `sudo systemctl edit ventilairsec2mqtt`.
- **Time zone**: `sync_clock` sets the unit's clock in the computer's time zone
  (`sudo timedatectl set-timezone Europe/…`, check with `timedatectl`).
- **State file**: `/var/lib/ventilairsec2mqtt/state.json` (boost and holiday durations, learnt
  Assistant ID).

The logs go to the journal: no timestamp prefix (the journal adds its own), and each line has the
journal priority of its level (`journalctl -u ventilairsec2mqtt -p warning` shows warnings and
errors only).

The service is sandboxed (read-only system, no access to home folders, no privileges, only serial
devices): `systemd-analyze security ventilairsec2mqtt` shows the details. Local changes to the
unit go in a drop-in (`sudo systemctl edit ventilairsec2mqtt`), which updates keep.

On Raspberry Pi OS the kernel disables the cgroup memory controller (`cgroup_disable=memory` on
the kernel command line), so the unit's `MemoryHigh` / `MemoryMax` are not applied there; the
Node.js heap limit (`--max-old-space-size=96`) still is. The service uses about 60 MB of RAM on a
Raspberry Pi Zero W.

## Update

Download and run the installer of the new version, as for the install, or let the installer
download it:

```sh
sudo /opt/ventilairsec2mqtt/current/install.sh --version 0.2.0
# or: --url https://github.com/ceddelam/ventilairsec2mqtt/releases/download/v0.2.0/ventilairsec2mqtt-0.2.0.tar.gz
# or: --archive ventilairsec2mqtt-0.2.0.tar.gz      (add --sha256 <checksum> to check it)
```

The options and the state are kept. The new version is installed next to the current one, the
`current` link is switched in one step and the service is restarted. The previous version is
kept (older ones are removed).

## Roll back

```sh
sudo /opt/ventilairsec2mqtt/current/install.sh --rollback
```

switches back to the previous version and restarts the service (running it again switches
forward).

## Uninstall

```sh
sudo /opt/ventilairsec2mqtt/current/install.sh --uninstall           # keeps options and state
sudo /opt/ventilairsec2mqtt/current/install.sh --uninstall --purge   # also removes them and the user
```

The retained MQTT messages (discovery, states) stay on the broker. To remove the devices from
Home Assistant for good, clear their retained discovery messages, for example with
`mosquitto_pub` (package `mosquitto-clients`), once per device ID (the unit, the Assistant, and
`bridge_<unit ID>`):

```sh
mosquitto_pub -h <broker> -u <user> -P <password> -r -n -t homeassistant/device/ventilairsec2mqtt_0400AA01/config
```

## Run without the installer

The program only needs Node.js 20 or later and the extracted archive:

```sh
node ventilairsec2mqtt-0.1.0/dist/main.js options.json --state state.json
node ventilairsec2mqtt-0.1.0/dist/main.js --help
```
