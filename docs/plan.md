# Plan

Goal: a Home Assistant app (formerly add-on) in Node.js/TypeScript bridging Ventilairsec
ventilation units to MQTT over EnOcean, published on GitHub with images on ghcr.io.

## Choices

- [x] Name: `ventilairsec2mqtt`.
- [x] Licence: MIT, rewrite from facts (see [sources.md](sources.md)).
- [x] Language: strict TypeScript on Node LTS; dependencies `mqtt`, `serialport`.
- [x] Docs, code and Home Assistant texts in English only (no second language).
- [x] Two delivery modes, same program and MQTT interface: Home Assistant app, and standalone
  service on the computer the stick is plugged into (see [architecture.md](architecture.md)).
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

- [x] Options, Supervisor or external broker, optional TLS.
- [x] Device discovery, availability, republish on `homeassistant/status`.
- [x] Integration test against a Mosquitto container.

## Phase 3 — Packaging

Home Assistant app:

- [x] `config.yaml` (amd64/aarch64, `mqtt:want`, no port), Dockerfile on
  `ghcr.io/home-assistant/base` without `build.yaml`, English translations, README, DOCS,
  CHANGELOG, icon and logo.
- [x] Local image build and end-to-end test (broker, emulated stick, orders, clean stop).
- [x] Scan mode to find the IDs when `vmi_id` is empty.
- [ ] Install as a local app on a real Home Assistant (Supervisor schema, serial device mapping).
- [ ] AppArmor profile (draft in `packaging/apparmor.txt`): validate in complain mode, then move it
  into the app folder (security rating 7 → 8).

Standalone service:

- [x] Runs on Node.js 20 or later; the test suite also runs on Node 20.
- [x] Release archive (built code + production dependencies), systemd unit, install / update /
  rollback / uninstall script, tested in a Debian 13 container.
- [x] Documentation: [install-standalone.md](install-standalone.md).
- [x] Run under systemd on a real Raspberry Pi (sandbox rules, ARMv6 serial binding): Raspberry
  Pi Zero W, Node 20, about 60 MB of RAM.

## Phase 4 — GitHub CI/CD

- [x] CI on every push and pull request: typecheck, lint, unit tests on Node 24 and Node 20,
  integration test against Mosquitto, hadolint, shellcheck (one job to save minutes).
- [x] Packaging workflow when packaging inputs change: app image end-to-end test, standalone
  install test, release archive.
- [x] Release workflow on a `v*.*.*` tag: version check, pinned `home-assistant/builder` actions
  (amd64 and aarch64 native runners, multi-arch manifest on ghcr.io), GitHub release with the
  standalone archive. Cosign signing off while the repository is private.
- [x] Dependabot: grouped weekly npm updates, monthly actions and base image updates.
- [x] First green runs on GitHub, then a first release (`v0.1.0`): images for amd64 and
  aarch64 on ghcr.io (private for now), standalone archive attached to the release.
- [ ] When the repository goes public: make the ghcr.io package public, turn Cosign on.

## Phase 5 — Validation on a real installation

- [x] Standalone service on a real installation: entities, orders (mode changes confirmed by
  the unit), automations and dashboard switched to the new entities.
- [ ] Standalone service: 1 to 2 weeks without discrepancy.
- [ ] Home Assistant app on a real installation (as a local app while the image is private).

## Phase 6 — Release

- [ ] v1.0.0, "add repository" badge, announcement on the Home Assistant forum.
- [ ] Issue templates, `SECURITY.md`.
