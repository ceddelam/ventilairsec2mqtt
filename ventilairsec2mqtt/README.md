# ventilairsec2mqtt

Connects a Ventilairsec ventilation unit (PureVent range) and its Assistant wall sensor to Home
Assistant over EnOcean radio and MQTT: status, temperatures, humidity, airflow, filter, errors,
and control of the mode, boost, holiday, bypass and setpoints. The devices and entities are
created automatically through MQTT discovery.

Needs an EnOcean USB 300 stick (TCM310, ideally with an 868 MHz antenna), plugged in here or
shared over the network with ser2net, and an MQTT broker (the Mosquitto broker app).

See the **Documentation** tab once installed, and the
[project page](https://github.com/ceddelam/ventilairsec2mqtt).

Independent project, not affiliated with Ventilairsec.
