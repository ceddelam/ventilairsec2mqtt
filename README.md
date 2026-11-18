# ventilairsec2mqtt

Home Assistant app bridging Ventilairsec ventilation units (PureVent) to MQTT over EnOcean.

> **Work in progress.** Not released yet. See the [plan](docs/plan.md).

- Reads the state of the unit and of its "Assistant" wall sensor (MSC D1-079 radio profile)
  through an EnOcean USB stick (TCM310), plugged in locally or shared over the network (ser2net).
- Controls the unit: mode, boost, holiday, bypass, setpoints, clock.
- Creates the Home Assistant entities through MQTT discovery.

## Install

The same program ships in two ways; the MQTT topics and Home Assistant entities are the same.

### Home Assistant app

[![Open your Home Assistant instance and show the add app repository dialog with this repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fceddelam%2Fventilairsec2mqtt)

Add this repository to Home Assistant (**Settings > Apps > App store > ⋮ > Repositories**,
`https://github.com/ceddelam/ventilairsec2mqtt`), install **ventilairsec2mqtt**, set the stick
port and start it. The stick is plugged into the Home Assistant host, or into a computer near the
unit that shares it with ser2net. Documentation: [ventilairsec2mqtt/DOCS.md](ventilairsec2mqtt/DOCS.md)
(also in the app's **Documentation** tab).

### Standalone service

On the computer the stick is plugged into (for example a Raspberry Pi with Debian's Node.js 20),
as a systemd service: download the release archive, run its `install.sh`, edit
`/etc/ventilairsec2mqtt/options.json`. Only MQTT crosses the network. Guide:
[docs/install-standalone.md](docs/install-standalone.md).

## Development

```sh
npm ci
npm run check              # typecheck, lint, unit tests
npm run build              # dist/
npm run test:integration   # against a Mosquitto container (Docker)
npm run test:node20        # unit tests on Node 20 (Docker)
npm run test:app           # app image end to end (Docker)
npm run test:standalone    # release archive and installer in Debian 13 (Docker)
npm run app:local          # .local-app/ventilairsec2mqtt/, to copy into Home Assistant's local_apps
npm run pack               # release/ventilairsec2mqtt-<version>.tar.gz
```

## Documentation

- [Radio protocol](docs/protocol.md): what is known about Ventilairsec frames, with sources.
- [MQTT interface](docs/mqtt-interface.md): topics, entities, orders.
- [Architecture](docs/architecture.md): code modules, public API and packaging.
- [Standalone service](docs/install-standalone.md): install on a Raspberry Pi.
- [Sources and credits](docs/sources.md).

## Thanks

Thanks to the projects that documented this protocol first and inspired this one:
ha-ventilairsec-enocean by Tux61, the Jeedom `openenocean` and `ventilairsec` plugins, and
enocean-extended by pledou (details in [sources](docs/sources.md)).

## Licence

MIT, see [LICENSE](LICENSE). Independent project, not affiliated with Ventilairsec.
Ventilairsec and PureVent are trademarks of their owners.
