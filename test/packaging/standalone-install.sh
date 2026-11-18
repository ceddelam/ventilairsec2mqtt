#!/usr/bin/env bash
# Test of packaging/standalone/install.sh in a debian:trixie-slim container (systemd not running),
# run by `npm run test:standalone` (scripts/test-standalone.mjs) with /archives holding
# ventilairsec2mqtt-0.1.0.tar.gz (the release) and two copies with versions 0.1.1-test and
# 0.1.2-test. Checks install, layout, permissions, idempotence, update, rollback, cleanup of old
# versions, install from an extracted archive and from a URL, the program on Debian's Node, the
# unit file (systemd-analyze), uninstall and purge.
set -euo pipefail

readonly V1=0.1.0 V2=0.1.1-test V3=0.1.2-test
readonly PREFIX=/opt/ventilairsec2mqtt
readonly OPTIONS=/etc/ventilairsec2mqtt/options.json
readonly UNIT=/etc/systemd/system/ventilairsec2mqtt.service
readonly OUT=/tmp/install.out
# Pipelines fail when the installer fails, not only when tee does.
step() { printf '\n=== %s\n' "$*"; }
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}
expect_eq() { [[ $1 == "$2" ]] || fail "$3: expected '$2', got '$1'"; }
expect_in() { grep -q -- "$1" "$2" || fail "'$1' not in $2: $(cat "$2")"; }
stat_of() { stat -c '%a %U:%G' "$1"; }

step "Debian packages: nodejs, curl, systemd (for systemd-analyze only)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends nodejs curl ca-certificates systemd >/dev/null
node --version
[[ ! -d /run/systemd/system ]] || fail 'systemd must not be running in this test'

step "The installer, from the release archive"
mkdir -p /tmp/release
tar -xzf "/archives/ventilairsec2mqtt-${V1}.tar.gz" -C /tmp/release
readonly INSTALLER=/tmp/release/ventilairsec2mqtt-${V1}/install.sh
installer() { bash "${INSTALLER}" "$@" | tee "${OUT}"; }

step "Refuses to run without root, and unknown arguments"
if setpriv --reuid=65534 --regid=65534 --clear-groups bash "${INSTALLER}" 2>/tmp/err; then
  fail 'ran as nobody'
fi
expect_in 'run as root' /tmp/err
if installer --bogus 2>/tmp/err; then fail 'accepted --bogus'; fi
expect_in 'unknown argument --bogus' /tmp/err

step "Install ${V1} from the archive"
installer --archive "/archives/ventilairsec2mqtt-${V1}.tar.gz"
expect_eq "$(readlink ${PREFIX}/current)" "${V1}" 'current'
[[ ! -e ${PREFIX}/previous ]] || fail 'no previous version expected'
expect_eq "$(stat_of ${PREFIX}/${V1})" '755 root:root' "${PREFIX}/${V1}"
expect_eq "$(stat_of ${PREFIX}/${V1}/dist/main.js)" '644 root:root' 'main.js'
expect_eq "$(stat_of /etc/ventilairsec2mqtt)" '750 root:ventilairsec2mqtt' '/etc/ventilairsec2mqtt'
expect_eq "$(stat_of ${OPTIONS})" '640 root:ventilairsec2mqtt' "${OPTIONS}"
expect_eq "$(stat_of ${UNIT})" '644 root:root' "${UNIT}"
cmp "${UNIT}" "${PREFIX}/current/ventilairsec2mqtt.service"
cmp "${OPTIONS}" "${PREFIX}/current/options.example.json"
getent passwd ventilairsec2mqtt | grep -q ':/nonexistent:/usr/sbin/nologin$' || fail 'system user'
expect_in 'would run: systemctl daemon-reload' "${OUT}"
expect_in 'would run: systemctl enable ventilairsec2mqtt' "${OUT}"
expect_in "Edit ${OPTIONS}" "${OUT}"
if grep -q 'systemctl restart' "${OUT}" && ! grep -q "Edit ${OPTIONS}" "${OUT}"; then
  fail 'must not start with the example options'
fi

step "The program on Debian's Node, as the service user"
expect_eq "$(node ${PREFIX}/current/dist/main.js --version)" "${V1}" '--version'
node ${PREFIX}/current/dist/main.js --help | grep -q '^Usage: ventilairsec2mqtt'
# Scan mode with the example options: starts, keeps retrying the missing stick and broker, and
# stops cleanly on SIGTERM. Logs: journal format when stdout is the JOURNAL_STREAM.
touch /tmp/run.log
chmod 666 /tmp/run.log
journal=$(stat -c '%d:%i' /tmp/run.log)
status=0
JOURNAL_STREAM=${journal} VENTILAIRSEC2MQTT_STATE=/tmp/state.json timeout --preserve-status -s TERM 4 \
  setpriv --reuid=ventilairsec2mqtt --regid=ventilairsec2mqtt --init-groups \
  node ${PREFIX}/current/dist/main.js ${OPTIONS} >>/tmp/run.log 2>&1 || status=$?
cat /tmp/run.log
expect_eq "${status}" 0 'exit status after SIGTERM'
expect_in '^<4>WARNING vmi_id is empty: scan mode' /tmp/run.log
expect_in '^<6>INFO SIGTERM received, stopping' /tmp/run.log
expect_in '^<6>INFO Stopped' /tmp/run.log
expect_in '^<3>ERROR MQTT: connect ECONNREFUSED' /tmp/run.log
status=0
node ${PREFIX}/current/dist/main.js --no-timestamps /nonexistent.json >/tmp/run2.log 2>&1 || status=$?
expect_eq "${status}" 1 'exit status of a configuration error'
expect_in '^ERROR Invalid options' /tmp/run2.log

step "The unit file (systemd-analyze)"
systemd-analyze verify "${UNIT}"
systemd-analyze security --offline=yes "${UNIT}" | tail -n 1

step "Install ${V1} again: idempotent, options kept"
printf '{"serial_port": "socket://stick:3333", "vmi_id": "0400AA01", "mqtt_host": "broker"}\n' >${OPTIONS}
chmod 600 ${OPTIONS}
installer --archive "/archives/ventilairsec2mqtt-${V1}.tar.gz"
expect_eq "$(readlink ${PREFIX}/current)" "${V1}" 'current'
[[ ! -e ${PREFIX}/previous ]] || fail 'reinstalling the same version must not set previous'
expect_in '0400AA01' ${OPTIONS}
expect_eq "$(stat_of ${OPTIONS})" '640 root:ventilairsec2mqtt' 'options readable by the service'
expect_in 'would run: systemctl restart ventilairsec2mqtt' "${OUT}"

step "Update to ${V2}"
installer --archive "/archives/ventilairsec2mqtt-${V2}.tar.gz"
expect_eq "$(readlink ${PREFIX}/current)" "${V2}" 'current'
expect_eq "$(readlink ${PREFIX}/previous)" "${V1}" 'previous'
expect_eq "$(node ${PREFIX}/current/dist/main.js --version)" "${V2}" '--version'
expect_in '0400AA01' ${OPTIONS}

step "Roll back to ${V1}"
installer --rollback
expect_eq "$(readlink ${PREFIX}/current)" "${V1}" 'current'
expect_eq "$(readlink ${PREFIX}/previous)" "${V2}" 'previous'
expect_eq "$(node ${PREFIX}/current/dist/main.js --version)" "${V1}" '--version'

step "Update to ${V3} from a URL with a checksum: only current and previous are kept"
(cd /archives && node -e '
  const http = require("node:http"), fs = require("node:fs");
  http.createServer((q, r) => fs.createReadStream("." + q.url).on("error", () => { r.statusCode = 404; r.end(); }).pipe(r)).listen(8080, "127.0.0.1");
' &)
sleep 1
sum=$(cut -d ' ' -f 1 "/archives/ventilairsec2mqtt-${V3}.tar.gz.sha256")
if installer --url "http://127.0.0.1:8080/ventilairsec2mqtt-${V3}.tar.gz" --sha256 "0000${sum:4}" 2>/tmp/err; then
  fail 'accepted a wrong checksum'
fi
expect_in 'checksum mismatch' /tmp/err
installer --url "http://127.0.0.1:8080/ventilairsec2mqtt-${V3}.tar.gz" --sha256 "${sum}"
expect_eq "$(readlink ${PREFIX}/current)" "${V3}" 'current'
expect_eq "$(readlink ${PREFIX}/previous)" "${V1}" 'previous'
expect_eq "$(cd ${PREFIX} && echo *)" "${V1} ${V3} current previous" 'installed versions'
expect_in "Removing old version ${V2}" "${OUT}"

step "Install from the extracted archive folder (no argument)"
installer --no-start
expect_eq "$(readlink ${PREFIX}/current)" "${V1}" 'current'
expect_eq "$(readlink ${PREFIX}/previous)" "${V3}" 'previous'
expect_in 'Not started (--no-start)' "${OUT}"

step "Uninstall keeps options and state; purge removes them"
mkdir -p /var/lib/ventilairsec2mqtt
installer --uninstall
[[ ! -e ${PREFIX} && ! -e ${UNIT} ]] || fail 'program or unit left'
[[ -f ${OPTIONS} && -d /var/lib/ventilairsec2mqtt ]] || fail 'options or state removed'
expect_in 'would run: systemctl disable --now ventilairsec2mqtt' "${OUT}"
installer --uninstall --purge
[[ ! -e /etc/ventilairsec2mqtt && ! -e /var/lib/ventilairsec2mqtt ]] || fail 'purge left files'
if getent passwd ventilairsec2mqtt >/dev/null; then fail 'user left'; fi
if installer --rollback 2>/tmp/err; then fail 'rollback without install'; fi
expect_in 'no previous version' /tmp/err

step "All standalone install checks passed"
