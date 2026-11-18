#!/usr/bin/env bash
# ventilairsec2mqtt standalone installer: installs, updates, rolls back or removes the
# ventilairsec2mqtt systemd service. Run as root. Documentation: docs/install-standalone.md.
#
#   install.sh                     install or update from the folder holding this script
#                                  (an extracted release archive)
#   install.sh --archive FILE      install or update from a release archive (.tar.gz)
#   install.sh --url URL           download the archive, e.g.
#       https://github.com/ceddelam/ventilairsec2mqtt/releases/download/v0.1.0/ventilairsec2mqtt-0.1.0.tar.gz
#   install.sh --version 0.1.0     same, for that release on GitHub
#   install.sh --rollback          go back to the previous installed version
#   install.sh --uninstall         remove the service and the program; keep options and state
#   install.sh --uninstall --purge also remove options, state and the system user
#
# Other options: --sha256 HEX (check the archive), --no-start (install without (re)starting).
#
# Layout: /opt/ventilairsec2mqtt/<version>/ (program, owned by root), `current` and `previous`
# symbolic links, /etc/ventilairsec2mqtt/options.json (root:ventilairsec2mqtt, mode 640, created
# from the example only when missing), /var/lib/ventilairsec2mqtt/ (state, created by systemd),
# /etc/systemd/system/ventilairsec2mqtt.service. Running it again is harmless (idempotent).
# Without a running systemd (e.g. in a container), systemctl commands are printed, not run.
set -euo pipefail

readonly NAME=ventilairsec2mqtt
readonly REPOSITORY=https://github.com/ceddelam/ventilairsec2mqtt
readonly PREFIX=/opt/${NAME}
readonly CONFIG_DIR=/etc/${NAME}
readonly OPTIONS=${CONFIG_DIR}/options.json
readonly STATE_DIR=/var/lib/${NAME}
readonly UNIT=/etc/systemd/system/${NAME}.service
readonly NODE=/usr/bin/node
readonly NODE_MIN_MAJOR=20
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR

action=install
archive=
url=
sha256=
start=yes
purge=no
new_options=no
release=
work=

log() { printf '%s\n' "$*"; }
die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}
usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}
cleanup() { if [[ -n ${work} ]]; then rm -rf -- "${work}"; fi; }
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case $1 in
    --archive) archive=${2:?--archive needs a file}; shift 2 ;;
    --url) url=${2:?--url needs a URL}; shift 2 ;;
    --version)
      wanted=${2:?--version needs a version}
      wanted=${wanted#v}
      url=${REPOSITORY}/releases/download/v${wanted}/${NAME}-${wanted}.tar.gz
      shift 2
      ;;
    --sha256) sha256=${2:?--sha256 needs a checksum}; shift 2 ;;
    --no-start) start=no; shift ;;
    --rollback) action=rollback; shift ;;
    --uninstall) action=uninstall; shift ;;
    --purge) purge=yes; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
done

[[ ${EUID} -eq 0 ]] || die 'run as root (sudo)'
[[ -n ${archive} && -n ${url} ]] && die '--archive and --url/--version exclude each other'
[[ ${purge} == yes && ${action} != uninstall ]] && die '--purge goes with --uninstall'

# systemctl, or only print the command when systemd is not running.
sysctl() {
  if [[ -d /run/systemd/system ]]; then
    systemctl "$@"
  else
    log "(systemd not running) would run: systemctl $*"
  fi
}

check_node() {
  [[ -x ${NODE} ]] || die "${NODE} not found: install Node.js ${NODE_MIN_MAJOR} or later (apt install nodejs)"
  local found
  found=$("${NODE}" -p 'process.versions.node')
  [[ ${found%%.*} -ge ${NODE_MIN_MAJOR} ]] ||
    die "Node.js ${found} is too old: ${NODE_MIN_MAJOR} or later is needed"
}

ensure_user() {
  if ! getent passwd "${NAME}" >/dev/null; then
    log "Creating the system user ${NAME}"
    useradd --system --user-group --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin --comment "${NAME} service" "${NAME}"
  fi
}

# Sets `release` to the folder holding the release to install (with dist/ and package.json).
fetch_release() {
  local source=${archive}
  work=$(mktemp -d)
  if [[ -n ${url} ]]; then
    log "Downloading ${url}"
    source=${work}/release.tar.gz
    if command -v curl >/dev/null; then
      curl --fail --location --silent --show-error --output "${source}" "${url}"
    elif command -v wget >/dev/null; then
      wget --quiet --output-document="${source}" "${url}"
    else
      die 'curl or wget is needed to download'
    fi
  fi
  if [[ -z ${source} ]]; then
    [[ -f ${SCRIPT_DIR}/package.json && -d ${SCRIPT_DIR}/dist ]] ||
      die "no release next to this script: use --archive FILE, --url URL or --version X"
    release=${SCRIPT_DIR}
    return
  fi
  [[ -f ${source} ]] || die "archive ${source} not found"
  if [[ -n ${sha256} ]]; then
    printf '%s  %s\n' "${sha256}" "${source}" | sha256sum --check --status ||
      die "checksum mismatch for ${source}"
  fi
  mkdir "${work}/extract"
  tar -xzf "${source}" -C "${work}/extract" --no-same-owner
  local folders=("${work}"/extract/*/)
  [[ ${#folders[@]} -eq 1 && -f ${folders[0]}package.json && -d ${folders[0]}dist ]] ||
    die "${source} is not a ${NAME} release archive"
  release=${folders[0]%/}
}

release_version() {
  "${NODE}" -p "require(process.argv[1]).version" "$1/package.json"
}

# Points ${PREFIX}/$1 at $2 atomically (rename over the old link).
set_link() {
  ln -sfn -- "$2" "${PREFIX}/.$1.new"
  mv -Tf -- "${PREFIX}/.$1.new" "${PREFIX}/$1"
}

link_target() {
  if [[ -L ${PREFIX}/$1 ]]; then readlink -- "${PREFIX}/$1"; fi
}

install_unit() {
  local source=$1
  if ! cmp -s "${source}" "${UNIT}" 2>/dev/null; then
    log "Installing ${UNIT}"
    install -m 0644 -o root -g root "${source}" "${UNIT}"
  fi
  sysctl daemon-reload
}

restart_if_wanted() {
  if [[ ${start} == no ]]; then
    log "Not started (--no-start): systemctl restart ${NAME}"
  elif [[ ${new_options} == yes ]]; then
    log "Edit ${OPTIONS} (at least serial_port and mqtt_host), then: systemctl restart ${NAME}"
  else
    sysctl restart "${NAME}"
    log "Started: systemctl status ${NAME}; logs: journalctl -u ${NAME} -f"
  fi
}

do_install() {
  check_node
  local version target current previous
  fetch_release
  version=$(release_version "${release}")
  [[ ${version} =~ ^[0-9A-Za-z.+-]+$ ]] || die "unexpected version \"${version}\""
  target=${PREFIX}/${version}
  current=$(link_target current)
  log "Installing ${NAME} ${version} into ${target}"

  ensure_user
  install -d -m 0755 -o root -g root "${PREFIX}"
  # Copy beside the target, then rename: a running service never sees a half-copied tree.
  rm -rf -- "${PREFIX}/.${version}.new" "${PREFIX}/.${version}.old"
  cp -R -- "${release}" "${PREFIX}/.${version}.new"
  chown -R root:root "${PREFIX}/.${version}.new"
  chmod -R u=rwX,go=rX "${PREFIX}/.${version}.new"
  if [[ -e ${target} ]]; then mv -T -- "${target}" "${PREFIX}/.${version}.old"; fi
  mv -T -- "${PREFIX}/.${version}.new" "${target}"
  rm -rf -- "${PREFIX}/.${version}.old"

  if [[ -n ${current} && ${current} != "${version}" ]]; then set_link previous "${current}"; fi
  set_link current "${version}"
  previous=$(link_target previous)
  # Keep only the current and the previous versions.
  local entry
  for entry in "${PREFIX}"/*/; do
    entry=$(basename -- "${entry}")
    [[ ${entry} == current || ${entry} == previous || ${entry} == "${version}" || ${entry} == "${previous}" ]] && continue
    log "Removing old version ${entry}"
    rm -rf -- "${PREFIX:?}/${entry}"
  done

  install -d -m 0750 -o root -g "${NAME}" "${CONFIG_DIR}"
  if [[ ! -e ${OPTIONS} ]]; then
    log "Creating ${OPTIONS} from the example"
    install -m 0640 -o root -g "${NAME}" "${target}/options.example.json" "${OPTIONS}"
    new_options=yes
  else
    # Keep the file as is; only make sure the service can read it.
    chgrp "${NAME}" "${OPTIONS}"
    chmod u+rw,g+r,g-w,o-rwx "${OPTIONS}"
  fi

  install_unit "${target}/${NAME}.service"
  sysctl enable "${NAME}"
  restart_if_wanted
  log "${NAME} ${version} installed${previous:+ (previous: ${previous}, use --rollback to go back)}"
}

do_rollback() {
  local current previous
  current=$(link_target current)
  previous=$(link_target previous)
  [[ -n ${previous} && -d ${PREFIX}/${previous} ]] || die 'no previous version to roll back to'
  log "Rolling back from ${current:-nothing} to ${previous}"
  set_link current "${previous}"
  if [[ -n ${current} ]]; then set_link previous "${current}"; fi
  install_unit "${PREFIX}/${previous}/${NAME}.service"
  restart_if_wanted
}

do_uninstall() {
  if [[ -e ${UNIT} ]]; then
    sysctl disable --now "${NAME}"
    rm -f -- "${UNIT}"
    sysctl daemon-reload
  fi
  log "Removing ${PREFIX}"
  rm -rf -- "${PREFIX}"
  if [[ ${purge} == yes ]]; then
    log "Removing ${CONFIG_DIR}, ${STATE_DIR} and the user ${NAME}"
    rm -rf -- "${CONFIG_DIR}" "${STATE_DIR}"
    if getent passwd "${NAME}" >/dev/null; then userdel "${NAME}"; fi
    if getent group "${NAME}" >/dev/null; then groupdel "${NAME}"; fi
  else
    log "Kept ${CONFIG_DIR} and ${STATE_DIR} (--purge removes them)"
  fi
}

case ${action} in
  install) do_install ;;
  rollback) do_rollback ;;
  uninstall) do_uninstall ;;
  *) die "unknown action ${action}" ;;
esac
