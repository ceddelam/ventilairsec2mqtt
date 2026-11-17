# ventilairsec2mqtt

Home Assistant app bridging Ventilairsec ventilation units (PureVent) to MQTT over EnOcean.

> **Work in progress.** Not usable yet. See the [plan](docs/plan.md).

- Reads the state of the unit and of its "Assistant" wall sensor (MSC D1-079 radio profile)
  through an EnOcean USB stick (TCM310), plugged in locally or shared over the network (ser2net).
- Controls the unit: mode, boost, holiday, bypass, setpoints, clock.
- Creates the Home Assistant entities through MQTT discovery.

## Documentation

- [Radio protocol](docs/protocol.md): what is known about Ventilairsec frames, with sources.
- [MQTT interface](docs/mqtt-interface.md): topics, entities, orders.
- [Architecture](docs/architecture.md): code modules and public API.
- [Sources and credits](docs/sources.md).

## Thanks

Thanks to the projects that documented this protocol first and inspired this one:
ha-ventilairsec-enocean by Tux61, the Jeedom `openenocean` and `ventilairsec` plugins, and
enocean-extended by pledou (details in [sources](docs/sources.md)).

## Licence

MIT, see [LICENSE](LICENSE). Independent project, not affiliated with Ventilairsec.
Ventilairsec and PureVent are trademarks of their owners.
