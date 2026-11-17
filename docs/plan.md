# Plan

Goal: a Home Assistant app (formerly add-on) in Node.js/TypeScript bridging Ventilairsec
ventilation units to MQTT over EnOcean, published on GitHub with images on ghcr.io.

## Choices

- [x] Name: `ventilairsec2mqtt`.
- [x] Licence: MIT, rewrite from facts (see [sources.md](sources.md)).
- [x] Language: strict TypeScript on Node LTS; dependencies `mqtt`, `serialport`.
- [x] Docs and code in English.
- [x] New, cleaner MQTT interface and entities: [mqtt-interface.md](mqtt-interface.md).

## Phase 0 — Groundwork

- [x] Repository, licence, README.
- [x] Protocol spec, facts only and sourced: [protocol.md](protocol.md).
- [x] MQTT / Home Assistant interface: [mqtt-interface.md](mqtt-interface.md).
- [x] Provenance and credits: [sources.md](sources.md).
- [x] Anonymised corpus: Assistant ↔ unit frames (`fixtures/assistant-vmi.txt`).
- [x] Anonymised corpus of the unit's full status frames (`fixtures/vmi-status.txt`).

## Phase 1 — Protocol core (no Home Assistant)

- [x] ESP3: framing, CRC8, resynchronisation; TCP (`socket://`) and serial transports;
  reconnection, silence detection, fallback port.
- [x] Chained messages, Assistant and unit decoding (`CMD 0`–`8`), order encoding, clock, Base ID,
  UTE response.
- [x] Tests on the corpus, expected values worked out from the spec (156 tests).
- [ ] Real hardware check of the serial transport (only tested against a mock port).

## Phase 2 — MQTT bridge

- [ ] Options, Supervisor or external broker, optional TLS.
- [ ] Device discovery, availability, republish on `homeassistant/status`.
- [ ] Integration test against a Mosquitto container.

## Phase 3 — Home Assistant app packaging

- [ ] `config.yaml` (amd64/aarch64, `mqtt:want`, no port), Dockerfile on
  `ghcr.io/home-assistant/base` without `build.yaml`, `apparmor.txt`, en/fr translations, README,
  DOCS, CHANGELOG, icon and logo.
- [ ] Security rating 8; starts as a local app.

## Phase 4 — GitHub CI/CD

- [ ] Pull requests: lint, typecheck, tests, hadolint.
- [ ] Releases: pinned `home-assistant/builder` actions, amd64/aarch64 matrix, cosign, public ghcr
  images.
- [ ] Renovate or Dependabot.

## Phase 5 — Validation on a real installation

- [ ] Run on a real installation, check entities, orders and automations, 1 to 2 weeks
  without discrepancy.

## Phase 6 — Release

- [ ] v1.0.0, "add repository" badge, announcement on the Home Assistant forum.
- [ ] Issue templates, `SECURITY.md`.
