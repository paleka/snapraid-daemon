#!/bin/sh
#
# Installer of SnapRAID Daemon with the Storage page (unofficial fork).
#
# Copyright (C) 2026 Robert Paleka
# SPDX-License-Identifier: GPL-3.0-or-later
#
# For Debian, Ubuntu, Proxmox and other systems using apt, on x86-64.
#
#   curl -fsSL https://raw.githubusercontent.com/paleka/snapraid-daemon/storage/installer.sh | sudo sh
#
# It installs the SnapRAID engine from the releases of its author if it is
# missing or older than 15.0, then the daemon from the releases of this fork,
# with the tools used by the Storage page. On a new installation it opens
# the web UI to the network, protects it with a password, and enables the
# Storage page.
#
# Options, as environment variables:
#
#   SNAPRAIDD_LOCAL=1       Keep the default configuration: web UI reachable
#                           only from the machine itself, Storage page read-only.
#   SNAPRAIDD_USER=name     User of the web UI (default: admin).
#   SNAPRAIDD_PASSWORD=pw   Password of the web UI (default: generated).
#   SNAPRAIDD_VERSION=2.2.s1  Install this release of the daemon instead of
#                           the latest.
#   SNAPRAID_VERSION=15.2   Install this release of the engine instead of
#                           the latest.
#   SNAPRAIDD_DEB=file      Install this daemon package instead of downloading it.
#   SNAPRAID_DEB=file       Install this engine package instead of downloading it.
#
# Running it again upgrades the packages and keeps the configuration.

set -eu

DAEMON_REPO="paleka/snapraid-daemon"
ENGINE_REPO="amadvance/snapraid"
CONF="/etc/snapraidd.conf"
PORT="7627"

say() {
	printf '%s\n' "$*"
}

die() {
	printf 'installer.sh: %s\n' "$*" >&2
	exit 1
}

# Print the version of the latest release of a repository, from the address
# its "latest" page redirects to
latest_version() {
	curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$1/releases/latest" \
		| sed -n 's|.*/releases/tag/v\(.*\)$|\1|p'
}

# Check a downloaded file against a list of SHA256 checksums
verify() {
	_file="$1"
	_sums="$2"
	_name=$(basename "$_file")
	_want=$(awk -v n="$_name" '$2 == n || $2 == "*" n { print $1; exit }' "$_sums")
	[ -n "$_want" ] || die "no checksum published for $_name"
	_have=$(sha256sum "$_file" | awk '{ print $1 }')
	[ "$_want" = "$_have" ] || die "checksum mismatch for $_name"
}

# Everything runs from a function, so that a download cut short runs nothing
main() {

[ "$(id -u)" = "0" ] || die "run it as root, for example with sudo"
command -v apt-get >/dev/null 2>&1 || die "this installer needs apt (Debian, Ubuntu, Proxmox). On other systems see the INSTALL file"
[ "$(dpkg --print-architecture)" = "amd64" ] || die "packages are built for x86-64 only. On other systems see the INSTALL file"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# apt reads the packages as the unprivileged _apt user
chmod 755 "$TMP"

export DEBIAN_FRONTEND=noninteractive

if ! command -v curl >/dev/null 2>&1; then
	say "Installing curl"
	apt-get update -q
	apt-get install -y -q curl ca-certificates
fi

# The engine: needed if missing or older than 15.0
ENGINE=""
ENGINE_HAVE=$(dpkg-query -W -f='${Version}' snapraid 2>/dev/null || true)
if [ -n "${SNAPRAID_DEB:-}" ]; then
	[ -f "$SNAPRAID_DEB" ] || die "$SNAPRAID_DEB not found"
	cp "$SNAPRAID_DEB" "$TMP/"
	ENGINE="$TMP/$(basename "$SNAPRAID_DEB")"
elif [ -z "$ENGINE_HAVE" ] || dpkg --compare-versions "$ENGINE_HAVE" lt 15.0; then
	say "Downloading the SnapRAID engine"
	VER="${SNAPRAID_VERSION:-$(latest_version "$ENGINE_REPO")}"
	[ -n "$VER" ] || die "cannot find the latest version of the SnapRAID engine"
	ENGINE="$TMP/snapraid_$VER-1_amd64.deb"
	curl -fsSL -o "$ENGINE" "https://github.com/$ENGINE_REPO/releases/download/v$VER/snapraid_$VER-1_amd64.deb"
	curl -fsSL -o "$TMP/engine.sums" "https://raw.githubusercontent.com/$ENGINE_REPO/master/CHECKSUMS"
	verify "$ENGINE" "$TMP/engine.sums"
fi

# The daemon
if [ -n "${SNAPRAIDD_DEB:-}" ]; then
	[ -f "$SNAPRAIDD_DEB" ] || die "$SNAPRAIDD_DEB not found"
	cp "$SNAPRAIDD_DEB" "$TMP/"
	DAEMON="$TMP/$(basename "$SNAPRAIDD_DEB")"
else
	say "Downloading SnapRAID Daemon with the Storage page"
	VER="${SNAPRAIDD_VERSION:-$(latest_version "$DAEMON_REPO")}"
	[ -n "$VER" ] || die "cannot find the latest version of the daemon"
	DAEMON="$TMP/snapraid-daemon-storage_$VER-1_amd64.deb"
	curl -fsSL -o "$DAEMON" "https://github.com/$DAEMON_REPO/releases/download/v$VER/snapraid-daemon-storage_$VER-1_amd64.deb"
	curl -fsSL -o "$TMP/daemon.sums" "https://github.com/$DAEMON_REPO/releases/download/v$VER/SHA256SUMS"
	verify "$DAEMON" "$TMP/daemon.sums"
fi

# A configuration is new if no package owned it before
NEW=1
if dpkg-query -W -f='${Status}' snapraid-daemon-storage 2>/dev/null | grep -q "ok installed"; then
	NEW=0
elif dpkg-query -W -f='${Status}' snapraid-daemon 2>/dev/null | grep -q "ok installed"; then
	NEW=0
elif [ -e "$CONF" ]; then
	NEW=0
fi

say "Installing the packages"
apt-get update -q
# shellcheck disable=SC2086
apt-get install -y -q -o Dpkg::Options::=--force-confold $ENGINE "$DAEMON"

USER_NAME="${SNAPRAIDD_USER:-admin}"
PASSWORD=""
OPENED=0
if [ "$NEW" = "1" ] && [ "${SNAPRAIDD_LOCAL:-0}" != "1" ]; then
	PASSWORD="${SNAPRAIDD_PASSWORD:-}"
	if [ -z "$PASSWORD" ]; then
		PASSWORD=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
	fi
	CRED=$(snapraidd -g "$USER_NAME:$PASSWORD" | sed -n 's/^net_auth_credential = //p')
	[ -n "$CRED" ] || die "cannot generate the credential of the web UI"

	# Listen on all the interfaces, require the password, enable the Storage page
	CRED="$CRED" PORT="$PORT" awk '
		/^#?[[:space:]]*net_port[[:space:]]*=/ && !port { print "net_port = " ENVIRON["PORT"]; port = 1; next }
		/^#?[[:space:]]*net_auth_credential[[:space:]]*=/ && !cred { print "net_auth_credential = " ENVIRON["CRED"]; cred = 1; next }
		/^#?[[:space:]]*net_storage_admin[[:space:]]*=/ && !adm { print "net_storage_admin = 1"; adm = 1; next }
		{ print }
		END {
			if (!port) print "net_port = " ENVIRON["PORT"]
			if (!cred) print "net_auth_credential = " ENVIRON["CRED"]
			if (!adm) print "net_storage_admin = 1"
		}
	' "$CONF" > "$TMP/snapraidd.conf"
	cat "$TMP/snapraidd.conf" > "$CONF"
	chmod 600 "$CONF"
	OPENED=1
fi

if [ -d /run/systemd/system ]; then
	systemctl enable snapraidd.service >/dev/null 2>&1 || true
	systemctl restart snapraidd.service
	STARTED=1
else
	STARTED=0
fi

ADDR=$(hostname -I 2>/dev/null | awk '{ print $1 }')
[ -n "$ADDR" ] || ADDR="<address of this machine>"

say ""
say "SnapRAID Daemon $(dpkg-query -W -f='${Version}' snapraid-daemon-storage) is installed."
if [ "$STARTED" = "0" ]; then
	say "systemd is not running here: start the daemon with 'snapraidd'."
fi
if [ "$OPENED" = "1" ]; then
	say ""
	say "  Web UI:    http://$ADDR:$PORT"
	say "  User:      $USER_NAME"
	say "  Password:  $PASSWORD"
	say ""
	say "The password is not stored in clear anywhere: note it now."
	say "To change it: snapraidd -g $USER_NAME:NEW_PASSWORD, put the line in $CONF,"
	say "then: systemctl restart snapraidd"
	say ""
	say "The web UI uses plain HTTP: use it on a trusted network or a VPN only."
elif [ "$NEW" = "1" ]; then
	say ""
	say "  Web UI:    http://127.0.0.1:$PORT (from this machine only)"
	say ""
	say "To open it to the network and enable the Storage page, see net_port,"
	say "net_auth_credential and net_storage_admin in $CONF."
else
	say "The existing configuration in $CONF was kept."
fi

}

main "$@" </dev/null
