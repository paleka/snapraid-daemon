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
# On a machine where SnapRAID is already in use from the command line, the
# array, its configuration, /etc/fstab and the scheduled jobs are left as
# they are, and the daemon starts without a maintenance schedule and without
# spinning down the disks: it only watches, until told otherwise in its
# Settings page. See "An array already in use" in the README file.
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
#   SNAPRAIDD_SHARES=1      Install the servers the Sharing page works with,
#                           Samba and NFS. This is the default on a machine
#                           new to SnapRAID; 0 leaves them out. Nothing is
#                           shared until a share is added in the web UI.
#   SNAPRAIDD_AUTO=1        With an array already in use, let the daemon take the
#                           maintenance over right away: sync and scrub every
#                           night at 02:00, idle disks spun down.
#   SNAPRAID_SYNC=1         With a content file written by SnapRAID 13 or older
#                           and changes not synced yet, run the sync needed to
#                           convert it instead of stopping.
#   SNAPRAID_MIGRATE_DEB=file  Use this SnapRAID 14.10 package for that
#                           conversion instead of downloading it.
#
# Running it again upgrades the packages and keeps the configuration.

set -eu

DAEMON_REPO="paleka/snapraid-daemon"
ENGINE_REPO="amadvance/snapraid"
CONF="/etc/snapraidd.conf"
ENGINE_CONF="/etc/snapraid.conf"
PORT="7627"

# The last SnapRAID able to read the content files of SnapRAID 13 and older,
# and the one that converts them for SnapRAID 15
MIGRATE_VERSION="14.10"

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

# Print the first content file of the SnapRAID configuration that exists:
# an array synced at least once has one
content_file() {
	[ -f "$ENGINE_CONF" ] || return 0
	tr -d '\r' < "$ENGINE_CONF" \
		| sed -n 's/^[[:space:]]*content[[:space:]][[:space:]]*//p' \
		| sed 's/[[:space:]]*$//' \
		| while IFS= read -r _f; do
			if [ -f "$_f" ]; then
				printf '%s\n' "$_f"
				break
			fi
		done
}

# Tell if a content file is in the format written by SnapRAID 13 and older,
# that SnapRAID 15 refuses to read
content_is_legacy() {
	case "$(head -c 8 "$1" 2>/dev/null | tr -d '\000')" in
	SNAPCNT1|SNAPCNT2) return 0 ;;
	esac
	return 1
}

# Convert a content file of SnapRAID 13 or older, with a sync made by the
# last SnapRAID able to read it. The program is run from the temporary
# directory, it's not installed.
#
# With nothing to sync, the sync writes only the content files and leaves the
# parity as it is. With changes pending it would be a real sync: when to run
# one is the choice of who owns the array, so it's done only if asked.
migrate_content() {
	_content="$1"

	say "The content file $_content was written by SnapRAID 13 or older."
	say "SnapRAID 15 cannot read it: it has to be converted by SnapRAID $MIGRATE_VERSION first."

	_deb="$TMP/snapraid_$MIGRATE_VERSION-1_amd64.deb"
	if [ -n "${SNAPRAID_MIGRATE_DEB:-}" ]; then
		[ -f "$SNAPRAID_MIGRATE_DEB" ] || die "$SNAPRAID_MIGRATE_DEB not found"
		cp "$SNAPRAID_MIGRATE_DEB" "$_deb"
	else
		say "Downloading SnapRAID $MIGRATE_VERSION"
		curl -fsSL -o "$_deb" "https://github.com/$ENGINE_REPO/releases/download/v$MIGRATE_VERSION/snapraid_$MIGRATE_VERSION-1_amd64.deb"
		curl -fsSL -o "$TMP/migrate.sums" "https://raw.githubusercontent.com/$ENGINE_REPO/master/CHECKSUMS"
		verify "$_deb" "$TMP/migrate.sums"
	fi
	mkdir "$TMP/migrate"
	dpkg-deb -x "$_deb" "$TMP/migrate"
	_old="$TMP/migrate/usr/bin/snapraid"
	[ -x "$_old" ] || die "cannot unpack SnapRAID $MIGRATE_VERSION"

	say "Checking the array for changes not synced yet"
	_rc=0
	"$_old" -c "$ENGINE_CONF" diff > "$TMP/diff.log" 2>&1 || _rc=$?
	if [ "$_rc" = "2" ] && [ "${SNAPRAID_SYNC:-0}" != "1" ]; then
		say ""
		tail -n 10 "$TMP/diff.log"
		say ""
		say "The array has changes not synced yet, and the conversion takes a sync."
		say "Nothing was installed and nothing was changed. Choose one:"
		say ""
		say "  - check the changes above, then run the installer again with SNAPRAID_SYNC=1"
		say "    to let it sync, like 'snapraid sync' does:"
		say "      curl -fsSL https://raw.githubusercontent.com/$DAEMON_REPO/storage/installer.sh | sudo SNAPRAID_SYNC=1 sh"
		say "  - or install SnapRAID $MIGRATE_VERSION yourself, run 'snapraid sync' with it, and run the"
		say "    installer again:"
		say "      https://github.com/$ENGINE_REPO/releases/tag/v$MIGRATE_VERSION"
		exit 1
	elif [ "$_rc" != "0" ] && [ "$_rc" != "2" ]; then
		say ""
		tail -n 10 "$TMP/diff.log"
		say ""
		die "SnapRAID $MIGRATE_VERSION cannot read the array (see above). Nothing was installed and nothing was changed. Make 'snapraid diff' work, then run the installer again"
	fi

	if [ "$_rc" = "0" ]; then
		say "Nothing to sync: converting the content files, the parity is not touched"
		"$_old" -c "$ENGINE_CONF" sync > "$TMP/sync.log" 2>&1 || {
			tail -n 10 "$TMP/sync.log"
			die "the conversion failed (see above). Nothing was installed"
		}
	else
		say "Syncing the array with SnapRAID $MIGRATE_VERSION, as asked with SNAPRAID_SYNC=1"
		"$_old" -c "$ENGINE_CONF" sync || die "the sync failed. Nothing was installed"
	fi

	if content_is_legacy "$_content"; then
		die "$_content is still in the old format. Nothing was installed"
	fi
	say "Content files converted"
}

# Everything runs from a function, so that a download cut short runs nothing
main() {

[ "$(id -u)" = "0" ] || die "run it as root, for example with sudo"
command -v apt-get >/dev/null 2>&1 || die "this installer needs apt (Debian, Ubuntu, Proxmox). On other systems see the INSTALL file"
[ "$(dpkg --print-architecture)" = "amd64" ] || die "packages are built for x86-64 only. On other systems see the INSTALL file"

# A SnapRAID built from the sources lives in /usr/local, and reads
# /usr/local/etc/snapraid.conf. The engine of the package would be a second
# one, with another configuration file: the shell would run one and the
# daemon the other, on the same array.
for OTHER in /usr/local/bin/snapraid /usr/local/sbin/snapraid; do
	if [ -e "$OTHER" ] && ! dpkg -S "$OTHER" >/dev/null 2>&1; then
		say "installer.sh: another SnapRAID is installed as $OTHER, not from a package."
		say ""
		say "The packages install the engine as /usr/bin/snapraid, reading $ENGINE_CONF."
		say "The two would be used on the same array: the old one from your shell, the new"
		say "one by the daemon. Nothing was installed and nothing was changed. To go on:"
		say ""
		say "  1. remove the old program:  rm $OTHER"
		say "     (or 'make uninstall' in the directory it was built in)"
		if [ ! -e "$ENGINE_CONF" ] && [ -e /usr/local/etc/snapraid.conf ]; then
			say "  2. move its configuration:  mv /usr/local/etc/snapraid.conf $ENGINE_CONF"
			say "  3. run this installer again"
		else
			say "  2. run this installer again"
		fi
		exit 1
	fi
done

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

# An array already in use: its content file is there
CONTENT=$(content_file)
if [ -n "$CONTENT" ] && content_is_legacy "$CONTENT"; then
	migrate_content "$CONTENT"
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

# The servers behind the Sharing page. They listen on the network as soon
# as installed, so they are added by default only to a machine that is new
# to SnapRAID and to this daemon: an existing setup is left as it is, unless
# asked. Not having them is not an error: the Sharing page says what to do.
SHARES="${SNAPRAIDD_SHARES:-}"
if [ -z "$SHARES" ]; then
	if [ "$NEW" = "1" ] && [ -z "$CONTENT" ]; then SHARES=1; else SHARES=0; fi
fi
SHARES_DONE=0
if [ "$SHARES" = "1" ]; then
	if command -v smbd >/dev/null 2>&1 && command -v exportfs >/dev/null 2>&1; then
		SHARES_DONE=2
	else
		say "Installing Samba and NFS, for the Sharing page"
		if apt-get install -y -q -o Dpkg::Options::=--force-confold samba nfs-kernel-server; then
			SHARES_DONE=1
		else
			say "warning: Samba and NFS could not be installed. Everything else works; to try again:"
			say "  apt-get install samba nfs-kernel-server"
		fi
	fi
fi

USER_NAME="${SNAPRAIDD_USER:-admin}"
PASSWORD=""
OPENED=0
WATCHING=0
CRED=""
if [ "$NEW" = "1" ] && [ "${SNAPRAIDD_LOCAL:-0}" != "1" ]; then
	PASSWORD="${SNAPRAIDD_PASSWORD:-}"
	if [ -z "$PASSWORD" ]; then
		PASSWORD=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
	fi
	CRED=$(snapraidd -g "$USER_NAME:$PASSWORD" | sed -n 's/^net_auth_credential = //p')
	[ -n "$CRED" ] || die "cannot generate the credential of the web UI"
	OPENED=1
fi
# An array already in use has its own routine, by hand or with scheduled
# jobs: the daemon must not add a nightly sync and scrub to it, nor start
# spinning down its disks, until asked to
if [ "$NEW" = "1" ] && [ -n "$CONTENT" ] && [ "${SNAPRAIDD_AUTO:-0}" != "1" ]; then
	WATCHING=1
fi

if [ "$OPENED" = "1" ] || [ "$WATCHING" = "1" ]; then
	# Listen on all the interfaces, require the password, enable the Storage page;
	# no schedule and no spin down for an array already in use
	CRED="$CRED" PORT="$PORT" OPENED="$OPENED" WATCHING="$WATCHING" awk '
		BEGIN { opened = ENVIRON["OPENED"] == "1"; watching = ENVIRON["WATCHING"] == "1" }
		opened && /^#?[[:space:]]*net_port[[:space:]]*=/ && !port { print "net_port = " ENVIRON["PORT"]; port = 1; next }
		opened && /^#?[[:space:]]*net_auth_credential[[:space:]]*=/ && !cred { print "net_auth_credential = " ENVIRON["CRED"]; cred = 1; next }
		opened && /^#?[[:space:]]*net_storage_admin[[:space:]]*=/ && !adm { print "net_storage_admin = 1"; adm = 1; next }
		watching && /^#?[[:space:]]*maintenance_schedule[[:space:]]*=/ && !sched { print "maintenance_schedule ="; sched = 1; next }
		watching && /^#?[[:space:]]*spindown_idle_minutes[[:space:]]*=/ && !spin { print "spindown_idle_minutes = 0"; spin = 1; next }
		{ print }
		END {
			if (opened && !port) print "net_port = " ENVIRON["PORT"]
			if (opened && !cred) print "net_auth_credential = " ENVIRON["CRED"]
			if (opened && !adm) print "net_storage_admin = 1"
			if (watching && !sched) print "maintenance_schedule ="
			if (watching && !spin) print "spindown_idle_minutes = 0"
		}
	' "$CONF" > "$TMP/snapraidd.conf"
	cat "$TMP/snapraidd.conf" > "$CONF"
	chmod 600 "$CONF"
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
ENGINE_NOW=$(dpkg-query -W -f='${Version}' snapraid 2>/dev/null || true)
if [ -n "$ENGINE_HAVE" ] && [ "$ENGINE_HAVE" != "$ENGINE_NOW" ]; then
	say "The SnapRAID engine was upgraded from $ENGINE_HAVE to $ENGINE_NOW: 'snapraid' in your shell is the new one."
fi
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

if [ "$SHARES_DONE" = "1" ]; then
	say ""
	say "Samba and NFS were installed for the Sharing page. No folder is shared and no"
	say "user can log in until you add a share and a user in the web UI."
elif [ "$SHARES_DONE" = "0" ] && ! command -v smbd >/dev/null 2>&1; then
	say ""
	say "Samba is not installed, so the Sharing page cannot share folders yet. To add it:"
	say "  apt-get install samba nfs-kernel-server"
fi

if [ "$NEW" = "1" ] && [ -n "$CONTENT" ]; then
	say ""
	say "The array of $ENGINE_CONF is already in use: it was left as it is, with its"
	say "configuration, /etc/fstab and scheduled jobs. 'snapraid' works from the shell as before."
fi
if [ "$WATCHING" = "1" ]; then
	say "The daemon only watches the array: it runs no sync or scrub of its own and doesn't"
	say "spin down the disks. To hand the maintenance over to it, set a schedule in the"
	say "Settings page of the web UI, and remove your own scheduled jobs."
	# shellcheck disable=SC2046
	JOBS=$(grep -ls snapraid /etc/crontab /etc/cron.d/* /etc/cron.hourly/* /etc/cron.daily/* \
		/etc/cron.weekly/* /etc/cron.monthly/* /var/spool/cron/crontabs/* /var/spool/cron/* \
		/etc/systemd/system/*.timer /etc/systemd/system/*.service 2>/dev/null | grep -v snapraidd || true)
	if [ -n "$JOBS" ]; then
		say "Scheduled jobs found that use SnapRAID, left untouched:"
		printf '%s\n' "$JOBS" | sed 's/^/  /'
	fi
fi

}

main "$@" </dev/null
