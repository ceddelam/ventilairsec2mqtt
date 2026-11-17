# Sources and provenance

ventilairsec2mqtt is written from scratch. Its code neither copies nor translates the code of the
projects below; it relies on the **facts** they document (frame layout, values, sequences),
collected in [protocol.md](protocol.md) with their source. Facts, data formats and interfaces are
not protected by copyright (EU Directive 2009/24/EC, art. 1(2); CJEU, *SAS Institute*, C-406/10).

| Project | Licence | What we take from it |
|---|---|---|
| Jeedom `openenocean` and `ventilairsec` plugins (Jeedom SAS) | not published, licence not verified | Origin of the MSC D1-079 knowledge, through Tux61's project |
| [Tux61/ha-ventilairsec-enocean](https://github.com/Tux61/ha-ventilairsec-enocean), `main` branch | GPL-3.0 | D1-079 fields and values, orders, error codes |
| [pledou/enocean](https://github.com/pledou/enocean) (`enocean-extended`) | MIT | D1079 definition in `EEP.xml` (extra fields, "disabled" values), `COMMAND = 1` order, chained message example |
| EnOcean specifications (ESP3, ERP1, EEP / UTE) | public | Serial link, telegrams, chaining, UTE pairing |
| Tests and captures on a PureVent unit, firmware 3.7 | — | Pairing through a UTE response, 6-hour window, boost and holiday as flags only, timing, control loop (speed, pressure, airflow), radio levels |

## Source tags used in protocol.md

| Tag | Source | Kind |
|---|---|---|
| **[E]** | Public EnOcean specifications (ESP3, ERP1, EEP 2.6 / UTE) | Standard |
| **[T]** | ha-ventilairsec-enocean by Tux61, `main` branch (decoding taken from the Jeedom plugins) | Facts read from it |
| **[P]** | enocean-extended by pledou, `EEP.xml` and `packet.py` | Facts read from it |
| **[C]** | Observations on a PureVent unit, firmware 3.7, with a USB 300 stick (TCM310) | Tests and captures |

Ventilairsec and PureVent are trademarks of their owners. Independent project, not affiliated with
Ventilairsec or Jeedom SAS.
