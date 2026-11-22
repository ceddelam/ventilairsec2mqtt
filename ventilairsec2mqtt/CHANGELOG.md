# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Docs: Raspberry Pi OS ignores the unit's memory limits (cgroup memory controller disabled);
  observations from the first real installation added to the protocol spec.

## [0.1.0] - 2026-11-20

First version, for testing on real installations.

### Added

- GitHub Actions: CI (Node 24 and 20, integration, lint), packaging tests, release workflow
  (app images for amd64 and aarch64, standalone archive), Dependabot.
- Ventilairsec radio protocol spec (MSC D1-079), sourced facts: `docs/protocol.md`.
- MQTT / Home Assistant interface: `docs/mqtt-interface.md`.
- Provenance and credits: `docs/sources.md`; plan: `docs/plan.md`.
- Anonymised real frame corpus: `fixtures/assistant-vmi.txt`, `fixtures/vmi-status.txt`.
- ESP3 framing: CRC8, incremental decoder with resynchronisation, common commands
  (`CO_RD_IDBASE`, `CO_WR_IDBASE`, `CO_WR_RESET`), RESPONSE and EVENT packets.
- ERP1 telegram parsing and building; chained message (RORG `40`) reassembly.
- MSC D1-079 decoding: Assistant commands 1 and 3, unit commands 0 to 8, error codes,
  telegram classification and machine ID check.
- Orders: settings (`CMD 0`) with validation, function byte update, clock (`CMD 1`).
- UTE pairing: teach-in query detection, response, answer policy.
- Transports (TCP `socket://`, serial) and supervised stick connection: request/response,
  reconnection, silence detection, fallback port, optional Base ID write.
- Architecture notes: `docs/architecture.md`; tests on the frame corpus.
- MQTT bridge: options file and Supervisor or external broker, state file, unit / Assistant /
  bridge JSON states, availability, Home Assistant device discovery (fixed English entity IDs),
  orders with validation and optimistic state, clock sync, automatic pairing answer, Assistant ID
  learning; entry point `ventilairsec2mqtt [options.json]`.
- End-to-end test against a Mosquitto container: `npm run test:integration`.
- Home Assistant app (version 0.1.0): `repository.yaml`, app folder `ventilairsec2mqtt/`
  (amd64 / aarch64, Supervisor MQTT service, serial devices, English translations, README, DOCS,
  icon and logo drawn from `assets/*.svg`), multi-stage Dockerfile on the Home Assistant base
  image (program run as the s6-overlay main program), `npm run app:local` for a local app.
- Scan mode: with an empty `vmi_id`, the program publishes only the bridge device, transmits
  nothing and logs each Ventilairsec device heard (unit, Assistant, pairing requests, paired
  sensor list) with its destination and signal level, to find the IDs.
- Command line: `--version`, `--help`, `--no-timestamps`; under the systemd journal, log lines
  have no timestamp and carry the journal priority.
- Standalone service: release archive (`npm run pack`), systemd unit with hardening,
  `install.sh` (install, update, rollback, uninstall), guide `docs/install-standalone.md`.
- Tests on Node 20 (`npm run test:node20`, compiled tests in a `node:20-alpine` container), end
  to end test of the app image (`npm run test:app`), install tests in Debian 13
  (`npm run test:standalone`), checks of the app files against the program options.
- AppArmor profile draft for the app: `packaging/apparmor.txt` (not enabled yet).

### Changed

- `vmi_id` is optional (empty: scan mode).
- Errors without a message (e.g. a broker refused on both IPv6 and IPv4) are logged with their
  inner errors.
