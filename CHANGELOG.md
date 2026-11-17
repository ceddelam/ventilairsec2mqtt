# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
  bridge JSON states, availability, Home Assistant device discovery (English or French names),
  orders with validation and optimistic state, clock sync, automatic pairing answer, Assistant ID
  learning; entry point `ventilairsec2mqtt [options.json]`.
- End-to-end test against a Mosquitto container: `npm run test:integration`.
