// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Paleka

#include "os/portable.h"

#include "app.h"
#include "state.h"
#include "support.h"
#include "log.h"
#include "storage.h"
#include "storage_int.h"
#include "arrays.h"
#include "runner.h"
#include "scheduler.h"
#include "memory.h"
#include "host.h"

const char* host_arg(const struct host_args* args, const char* key)
{
	for (unsigned i = 0; i < args->count; ++i) {
		if (strcmp(args->key[i], key) == 0)
			return args->val[i];
	}

	return 0;
}

#ifdef __linux__

#include <dirent.h>
#include <poll.h>
#include <grp.h>
#include <linux/fs.h>
#include <pwd.h>
#include <sys/ioctl.h>
#include <sys/statvfs.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <sys/sysmacros.h>

#define HOST_CONF_NAME "snapraidd-host.conf"
#define HOST_VALUE_MAX 16384 /**< Max length of a value: a document of the UI is the biggest */
#define HOST_KEYS_MAX 512
#define SMB_SHARES_CONF "/etc/samba/snapraidd-shares.conf"
#define SMB_CONF "/etc/samba/smb.conf"
#define NFS_EXPORTS "/etc/exports.d/snapraidd.exports"
#define RECYCLE_DIR ".recycle"
#define HISTORY_SAMPLES 288 /**< One day of samples, one every 5 minutes */
#define HISTORY_DEVICES 64
#define DIRCACHE_ENTRIES_MAX 4000000

static int hfail(char* msg, size_t msg_size, int status, const char* fmt, ...) __attribute__((format(printf, 4, 5)));
static int hfail(char* msg, size_t msg_size, int status, const char* fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	vsnprintf(msg, msg_size, fmt, ap);
	va_end(ap);

	log_msg(LVL_WARNING, "host: %s", msg);

	return status;
}

/** Remove an empty folder made for a mount. */
static void dir_remove(const char* path)
{
	priv_enter();
	rmdir(path);
	priv_leave();
}

/****************************************************************************/
/* settings */

struct host_kv {
	char* key;
	char* val;
};

static pthread_mutex_t host_mutex = PTHREAD_MUTEX_INITIALIZER;
static struct host_kv kv_list[HOST_KEYS_MAX];
static unsigned kv_count;
static char host_conf_path[PATH_MAX];
static int host_dryrun; /**< Power actions are only logged. Set by SNAPRAIDD_HOST_DRYRUN=1, used by the lab */

/** Path of the settings, next to the main configuration of the daemon. */
static void host_conf_locate(void)
{
	char dir[PATH_MAX - 32];

	state_lock();
	sncpy(dir, sizeof(dir), state_ptr()->config.conf);
	state_unlock();

	char* slash = strrchr(dir, '/');
	if (slash)
		*slash = 0;
	else
		sncpy(dir, sizeof(dir), ".");

	snprintf(host_conf_path, sizeof(host_conf_path), "%s/%s", dir, HOST_CONF_NAME);
}

/** Get a setting, the default if missing. Call with host_mutex. */
static const char* kv_get_locked(const char* key, const char* def)
{
	for (unsigned i = 0; i < kv_count; ++i) {
		if (strcmp(kv_list[i].key, key) == 0)
			return kv_list[i].val;
	}

	return def;
}

static void kv_get(const char* key, const char* def, char* out, size_t out_size)
{
	pthread_mutex_lock(&host_mutex);
	sncpy(out, out_size, kv_get_locked(key, def));
	pthread_mutex_unlock(&host_mutex);
}

static int kv_int(const char* key, int def)
{
	char buf[32];
	char d[32];

	snprintf(d, sizeof(d), "%d", def);
	kv_get(key, d, buf, sizeof(buf));

	return atoi(buf);
}

/** Set or remove (empty value) a setting. Call with host_mutex. */
static int kv_set_locked(const char* key, const char* val)
{
	for (unsigned i = 0; i < kv_count; ++i) {
		if (strcmp(kv_list[i].key, key) == 0) {
			free(kv_list[i].val);
			if (val[0] == 0) {
				free(kv_list[i].key);
				kv_list[i] = kv_list[--kv_count];
				return 0;
			}
			kv_list[i].val = strdup_nofail(val);
			return 0;
		}
	}

	if (val[0] == 0)
		return 0;
	if (kv_count == HOST_KEYS_MAX)
		return -1;

	kv_list[kv_count].key = strdup_nofail(key);
	kv_list[kv_count].val = strdup_nofail(val);
	++kv_count;

	return 0;
}

static int kv_compare(const void* a, const void* b)
{
	return strcmp(((const struct host_kv*)a)->key, ((const struct host_kv*)b)->key);
}

/** Write all the settings. Call with host_mutex. */
static int kv_save_locked(void)
{
	ss_t s;

	qsort(kv_list, kv_count, sizeof(kv_list[0]), kv_compare);

	ss_init(&s, 4096);
	ss_prints(&s, "# Settings of the machine for the SnapRAID Daemon: schedules, power, shares, backups.\n");
	ss_prints(&s, "# Written by the daemon from its web interface. A manual edit is read at the next start.\n\n");
	for (unsigned i = 0; i < kv_count; ++i)
		ss_printf(&s, "%s = %s\n", kv_list[i].key, kv_list[i].val);
	ss_write(&s, "", 1);

	int ret = file_replace(host_conf_path, ss_ptr(&s), 0, 0644);
	ss_done(&s);

	if (ret != 0)
		log_msg(LVL_ERROR, "host: cannot write %s, errno=%s(%d)", host_conf_path, strerror(errno), errno);

	return ret;
}

static void kv_load(void)
{
	ss_t s;

	ss_init(&s, 4096);
	if (file_read(host_conf_path, &s) != 0) {
		ss_done(&s);
		return;
	}

	pthread_mutex_lock(&host_mutex);
	char* text = ss_ptr(&s);
	char* save = 0;
	for (char* line = strtok_r(text, "\n", &save); line; line = strtok_r(0, "\n", &save)) {
		while (isspace((unsigned char)*line))
			++line;
		if (*line == '#' || *line == 0)
			continue;
		char* eq = strchr(line, '=');
		if (!eq)
			continue;
		*eq = 0;
		char* key = line;
		char* val = eq + 1;
		strtrim(key);
		strtrim(val);
		if (key[0] != 0)
			kv_set_locked(key, val);
	}
	pthread_mutex_unlock(&host_mutex);

	ss_done(&s);
}

/****************************************************************************/
/* schedules */

static const char* DAY_NAMES[] = { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" };

/**
 * One entry of a schedule: "HH:MM" every day, "Day HH:MM" every week,
 * "Day#N HH:MM" the N-th of that day in the month (1 to 4).
 */
struct sched {
	int day; /**< 0-6, -1 every day */
	int nth; /**< 1-4, 0 every week */
	int hour;
	int minute;
};

static int sched_parse_one(const char* text, struct sched* out)
{
	char buf[64];
	char* p = buf;

	sncpy(buf, sizeof(buf), text);
	strtrim(buf);

	out->day = -1;
	out->nth = 0;

	if (isalpha((unsigned char)p[0])) {
		int found = -1;
		for (int d = 0; d < 7; ++d) {
			if (strncasecmp(p, DAY_NAMES[d], 3) == 0)
				found = d;
		}
		if (found < 0)
			return -1;
		out->day = found;
		p += 3;
		if (*p == '#') {
			if (p[1] < '1' || p[1] > '4')
				return -1;
			out->nth = p[1] - '0';
			p += 2;
		}
		if (*p != ' ')
			return -1;
		while (*p == ' ')
			++p;
	}

	if (!isdigit((unsigned char)p[0]) || !isdigit((unsigned char)p[1]) || p[2] != ':'
		|| !isdigit((unsigned char)p[3]) || !isdigit((unsigned char)p[4]) || p[5] != 0)
		return -1;

	out->hour = (p[0] - '0') * 10 + (p[1] - '0');
	out->minute = (p[3] - '0') * 10 + (p[4] - '0');
	if (out->hour > 23 || out->minute > 59)
		return -1;

	return 0;
}

/** Check a comma separated schedule. Empty is valid: never. */
static int sched_valid(const char* list)
{
	char buf[512];
	char* save = 0;

	if (strlen(list) >= sizeof(buf))
		return 0;
	sncpy(buf, sizeof(buf), list);
	for (char* tok = strtok_r(buf, ",", &save); tok; tok = strtok_r(0, ",", &save)) {
		struct sched one;
		if (sched_parse_one(tok, &one) != 0)
			return 0;
	}

	return 1;
}

static int sched_match(const char* list, const struct tm* tm)
{
	char buf[512];
	char* save = 0;

	sncpy(buf, sizeof(buf), list);
	for (char* tok = strtok_r(buf, ",", &save); tok; tok = strtok_r(0, ",", &save)) {
		struct sched one;
		if (sched_parse_one(tok, &one) != 0)
			continue;
		if (one.hour != tm->tm_hour || one.minute != tm->tm_min)
			continue;
		if (one.day >= 0 && one.day != tm->tm_wday)
			continue;
		if (one.nth != 0 && (tm->tm_mday - 1) / 7 + 1 != one.nth)
			continue;
		return 1;
	}

	return 0;
}

/****************************************************************************/
/* validation of the settings */

static int valid_bool(const char* v)
{
	return strcmp(v, "0") == 0 || strcmp(v, "1") == 0;
}

static int valid_int(const char* v, int low, int high)
{
	char* end;

	if (v[0] == 0)
		return 0;
	long n = strtol(v, &end, 10);
	return *end == 0 && n >= low && n <= high;
}

/** A name of a share, a backup, a document or a user. */
static int valid_name(const char* v)
{
	return valid_chars(v, "_-", 33);
}

/** Text in a single line, without the characters that break the files written from it. */
static int valid_line(const char* v, size_t max)
{
	size_t len = strlen(v);

	if (len >= max)
		return 0;
	for (const char* p = v; *p; ++p) {
		if ((unsigned char)*p < 32)
			return 0;
	}

	return 1;
}

/** A directory of files: absolute, no climbing, no control characters, quotes or backslashes. */
static int valid_user_path(const char* path)
{
	if (!valid_browse_path(path) || path[1] == 0 || !valid_line(path, PATH_MAX / 2))
		return 0;
	if (strpbrk(path, "\"\\'`$") != 0)
		return 0;
	if (strlen(path) >= 3 && strcmp(path + strlen(path) - 3, "/..") == 0)
		return 0;
	if (strstr(path, "/./") != 0)
		return 0;
	return 1;
}

/**
 * Space separated list of name=value options, checked against the allowed ones.
 * \param allowed list of "name:type" with type b (0/1), i (integer), n (name), U (UUID), p (path), s (schedule), u (users), h (hosts), t (text)
 */
/** List of paths separated by ':', or nothing. */
static int valid_path_list(const char* list)
{
	char buf[1024];
	char* save = 0;

	if (strlen(list) >= sizeof(buf))
		return 0;
	sncpy(buf, sizeof(buf), list);
	if (list[0] == ':' || strstr(list, "::") != 0 || (list[0] && list[strlen(list) - 1] == ':'))
		return 0;
	for (char* tok = strtok_r(buf, ":", &save); tok; tok = strtok_r(0, ":", &save)) {
		if (!valid_user_path(tok) || tok[strlen(tok) - 1] == '/')
			return 0;
	}

	return 1;
}

/** An address safe inside single quotes of a shell, and that curl takes as it is. */
static int valid_web_url(const char* v)
{
	if (strncmp(v, "https://", 8) != 0 && strncmp(v, "http://", 7) != 0)
		return 0;
	return strlen(v) > 10 && valid_chars(v, "._~:/?#@!&=+%,;-", 1024);
}

static int valid_options_line(const char* line, const char* const* allowed, char* msg, size_t msg_size)
{
	char buf[2048];
	char* save = 0;

	if (strlen(line) >= sizeof(buf))
		return hfail(msg, msg_size, 400, "Too long");
	for (const char* p = line; *p; ++p) {
		if ((unsigned char)*p < 32 && *p != '\t')
			return hfail(msg, msg_size, 400, "Invalid characters");
	}
	sncpy(buf, sizeof(buf), line);

	for (char* tok = strtok_r(buf, "\t", &save); tok; tok = strtok_r(0, "\t", &save)) {
		char* eq = strchr(tok, '=');
		if (!eq)
			return hfail(msg, msg_size, 400, "Missing value in '%s'", tok);
		*eq = 0;
		const char* name = tok;
		const char* val = eq + 1;
		char type = 0;
		for (unsigned i = 0; allowed[i]; ++i) {
			size_t len = strlen(name);
			if (strncmp(allowed[i], name, len) == 0 && allowed[i][len] == ':')
				type = allowed[i][len + 1];
		}
		int ok;
		switch (type) {
		case 'b' : ok = valid_bool(val); break;
		case 'i' : ok = valid_int(val, 0, 100000); break;
		case 'n' : ok = val[0] == 0 || valid_name(val); break;
		case 'U' : ok = valid_chars(val, "-", 64); break;
		case 'p' : ok = valid_user_path(val); break;
		case 'l' : ok = valid_path_list(val); break;
		case 's' : ok = sched_valid(val); break;
		case 'u' : ok = val[0] == 0 || valid_chars(val, "_-,", 512); break;
		case 'h' : ok = val[0] == 0 || valid_chars(val, ".:/,*-", 512); break;
		case 't' : ok = valid_line(val, 256) && strpbrk(val, "\"\\") == 0; break;
		case 'w' : ok = valid_web_url(val); break;
		case 'k' : ok = val[0] != '-' ? valid_chars(val, ":_-.@+", 256) : valid_chars(val + 1, "0123456789", 32); break;
		case 'H' : ok = val[0] != '-' && valid_chars(val, ".-_:", 255); break;
		default : return hfail(msg, msg_size, 400, "Unknown option '%s'", name);
		}
		if (!ok)
			return hfail(msg, msg_size, 400, "Invalid value for '%s'", name);
	}

	return 0;
}

/** Get an option of a "name=value<TAB>name=value" line. */
static int opt_get(const char* line, const char* name, char* out, size_t out_size)
{
	size_t len = strlen(name);
	const char* p = line;

	out[0] = 0;
	while (*p) {
		size_t tok = strcspn(p, "\t");
		if (tok > len && strncmp(p, name, len) == 0 && p[len] == '=') {
			size_t vl = tok - len - 1;
			if (vl >= out_size)
				vl = out_size - 1;
			memcpy(out, p + len + 1, vl);
			out[vl] = 0;
			return 0;
		}
		p += tok;
		if (*p == '\t')
			++p;
	}

	return -1;
}

static int opt_bool(const char* line, const char* name, int def)
{
	char buf[8];

	if (opt_get(line, name, buf, sizeof(buf)) != 0)
		return def;
	return atoi(buf) != 0;
}

static const char* const SHARE_OPTIONS[] = {
	"path:p", "smb:b", "nfs:b", "writable:b", "guest:b", "users:u", "recycle:b", "recycle_days:i",
	"nfs_hosts:h", "comment:t", "hidden:b", 0
};

static const char* const BACKUP_OPTIONS[] = {
	"source:p", "dest_uuid:U", "dest_dir:t", "dest_path:p", "when:s", "plug:b", "mirror:b", "enabled:b", 0
};

static const char* const CACHE_OPTIONS[] = {
	"pool:p", "branch:p", "age_hours:i", "fill:i", "when:s", "sync:b", "enabled:b", "policy:n", "stay:l", 0
};

static const char* const KEEP_OPTIONS[] = {
	"pool:p", "path:p", "disks:l", "when:s", "enabled:b", 0
};

static const char* const REMOTE_OPTIONS[] = {
	"kind:n", "host:H", "share:t", "user:t", "domain:n", "vers:k", 0
};

static int valid_ups(const char* v)
{
	if (strcmp(v, "apc") == 0)
		return 1;
	return strncmp(v, "nut:", 4) == 0 && v[4] != 0 && v[4] != '-' && valid_chars(v + 4, "@.-_:", 128);
}

static const char* const POWER_OPTIONS[] = {
	"apm:i", "aam:i", "wcache:b", 0
};

/**
 * Check a setting before it's stored.
 * \return 0 if fine, otherwise the HTTP status with the reason.
 */
static int setting_check(const char* key, const char* val, char* msg, size_t msg_size)
{
	if (val[0] == 0)
		return 0; /* removal */

	if (strcmp(key, "maintenance_stop_at") == 0) {
		struct sched one;
		if (sched_parse_one(val, &one) != 0 || one.day != -1)
			return hfail(msg, msg_size, 400, "The end of the time window is a time like 07:00");
		return 0;
	}
	if (strcmp(key, "smart_short") == 0 || strcmp(key, "smart_long") == 0) {
		if (!sched_valid(val))
			return hfail(msg, msg_size, 400, "Invalid schedule. Use for example 'Sun 03:00' or 'Sun#1 04:00'");
		return 0;
	}
	if (strcmp(key, "dircache") == 0 || strcmp(key, "wol") == 0 || strcmp(key, "idle_check_network") == 0) {
		if (!valid_bool(val))
			return hfail(msg, msg_size, 400, "%s is 0 or 1", key);
		return 0;
	}
	if (strcmp(key, "dircache_minutes") == 0) {
		if (!valid_int(val, 1, 1440))
			return hfail(msg, msg_size, 400, "dircache_minutes is from 1 to 1440");
		return 0;
	}
	if (strcmp(key, "idle_minutes") == 0) {
		if (!valid_int(val, 10, 1440))
			return hfail(msg, msg_size, 400, "idle_minutes is from 10 to 1440");
		return 0;
	}
	if (strcmp(key, "idle_action") == 0) {
		if (strcmp(val, "none") != 0 && strcmp(val, "suspend") != 0 && strcmp(val, "shutdown") != 0)
			return hfail(msg, msg_size, 400, "idle_action is none, suspend or shutdown");
		return 0;
	}
	if (strncmp(key, "share.", 6) == 0) {
		char path[PATH_MAX];
		if (!valid_name(key + 6))
			return hfail(msg, msg_size, 400, "A share name has only letters, digits, - and _ (up to 32)");
		int ret = valid_options_line(val, SHARE_OPTIONS, msg, msg_size);
		if (ret != 0)
			return ret;
		if (opt_get(val, "path", path, sizeof(path)) != 0)
			return hfail(msg, msg_size, 400, "A share needs a folder");
		if (system_path(path) && strncmp(path, "/mnt/", 5) != 0 && strncmp(path, "/srv/", 5) != 0 && strncmp(path, "/media/", 7) != 0)
			return hfail(msg, msg_size, 400, "The folder %s is a system folder and cannot be shared", path);
		return 0;
	}
	if (strncmp(key, "backup.", 7) == 0) {
		char src[PATH_MAX];
		if (!valid_name(key + 7))
			return hfail(msg, msg_size, 400, "A backup name has only letters, digits, - and _ (up to 32)");
		int ret = valid_options_line(val, BACKUP_OPTIONS, msg, msg_size);
		if (ret != 0)
			return ret;
		if (opt_get(val, "source", src, sizeof(src)) != 0)
			return hfail(msg, msg_size, 400, "A backup needs a folder to copy");
		char uuid[64];
		char dpath[PATH_MAX];
		if (opt_get(val, "dest_uuid", uuid, sizeof(uuid)) != 0 && opt_get(val, "dest_path", dpath, sizeof(dpath)) != 0)
			return hfail(msg, msg_size, 400, "A backup needs a destination: a disk or a folder");
		return 0;
	}
	if (strcmp(key, "sync_changes") == 0) {
		if (!valid_int(val, 0, 1000000))
			return hfail(msg, msg_size, 400, "sync_changes is from 0 to 1000000");
		return 0;
	}
	if (strcmp(key, "sync_changes_minutes") == 0) {
		if (!valid_int(val, 1, 1440))
			return hfail(msg, msg_size, 400, "sync_changes_minutes is from 1 to 1440");
		return 0;
	}
	if (strcmp(key, "ups") == 0) {
		if (!valid_ups(val))
			return hfail(msg, msg_size, 400, "ups is apc, or nut: followed by the name of the UPS, like nut:myups or nut:myups@otherhost");
		return 0;
	}
	if (strcmp(key, "ups_shutdown") == 0) {
		if (!valid_bool(val))
			return hfail(msg, msg_size, 400, "ups_shutdown is 0 or 1");
		return 0;
	}
	if (strcmp(key, "ups_percent") == 0) {
		if (!valid_int(val, 5, 95))
			return hfail(msg, msg_size, 400, "ups_percent is from 5 to 95");
		return 0;
	}
	if (strcmp(key, "ups_minutes") == 0) {
		if (!valid_int(val, 1, 120))
			return hfail(msg, msg_size, 400, "ups_minutes is from 1 to 120");
		return 0;
	}
	if (strncmp(key, "remote.", 7) == 0) {
		if (!valid_name(key + 7))
			return hfail(msg, msg_size, 400, "A name has only letters, digits, - and _ (up to 32)");
		return valid_options_line(val, REMOTE_OPTIONS, msg, msg_size);
	}
	if (strcmp(key, "sync_ratio") == 0) {
		if (!valid_int(val, 0, 1000))
			return hfail(msg, msg_size, 400, "sync_ratio is from 0 to 1000");
		return 0;
	}
	if (strncmp(key, "cache.", 6) == 0) {
		char path[PATH_MAX];
		if (!valid_name(key + 6))
			return hfail(msg, msg_size, 400, "A name has only letters, digits, - and _ (up to 32)");
		int ret = valid_options_line(val, CACHE_OPTIONS, msg, msg_size);
		if (ret != 0)
			return ret;
		if (opt_get(val, "pool", path, sizeof(path)) != 0 || opt_get(val, "branch", path, sizeof(path)) != 0)
			return hfail(msg, msg_size, 400, "A fast disk needs its pool and its folder");
		char fill[16];
		if (opt_get(val, "fill", fill, sizeof(fill)) == 0 && !valid_int(fill, 0, 99))
			return hfail(msg, msg_size, 400, "The fill level is from 0 to 99");
		return 0;
	}
	if (strncmp(key, "keep.", 5) == 0) {
		char v[PATH_MAX];
		if (!valid_name(key + 5))
			return hfail(msg, msg_size, 400, "A name has only letters, digits, - and _ (up to 32)");
		int ret = valid_options_line(val, KEEP_OPTIONS, msg, msg_size);
		if (ret != 0)
			return ret;
		if (opt_get(val, "pool", v, sizeof(v)) != 0 || opt_get(val, "path", v, sizeof(v)) != 0 || v[strlen(v) - 1] == '/'
			|| opt_get(val, "disks", v, sizeof(v)) != 0 || v[0] == 0)
			return hfail(msg, msg_size, 400, "A folder to keep needs its pool, its path inside the pool and the disks chosen for it");
		return 0;
	}
	if (strncmp(key, "power.", 6) == 0) {
		if (!valid_chars(key + 6, "_-.:", 128))
			return hfail(msg, msg_size, 400, "Invalid disk identifier");
		return valid_options_line(val, POWER_OPTIONS, msg, msg_size);
	}
	if (strncmp(key, "doc.", 4) == 0) {
		if (!valid_name(key + 4))
			return hfail(msg, msg_size, 400, "Invalid document name");
		if (!valid_line(val, HOST_VALUE_MAX) || (val[0] != '{' && val[0] != '['))
			return hfail(msg, msg_size, 400, "A document is JSON in one line, up to %u characters", HOST_VALUE_MAX);
		return 0;
	}

	return hfail(msg, msg_size, 400, "Unknown setting '%s'", key);
}

/****************************************************************************/
/* disks of the arrays */

struct host_disk {
	char array[ARRAY_NAME_MAX];
	char name[KEYWORD_MAX];
	int parity;
	char mount[PATH_MAX]; /**< Mount dir of a data disk, empty for parity */
	char device[PATH_MAX]; /**< /dev/... */
	char serial[SMART_MAX];
	char model[SMART_MAX];
	int standby;
};

#define HOST_DISKS_MAX 256

/** Copy the disks of all the arrays, so the state lock is not held while working on them. */
static unsigned host_disks(struct host_disk* out, unsigned max)
{
	unsigned count = 0;

	state_lock();
	struct snapraid_host* host = host_ptr();
	for (tommy_node* i = tommy_list_head(&host->state_list); i; i = i->next) {
		struct snapraid_state* state = i->data;
		for (tommy_node* j = tommy_list_head(&state->array.disk_list); j; j = j->next) {
			struct snapraid_disk* disk = j->data;
			if (disk->kind != DISK_DATA && disk->kind != DISK_PARITY)
				continue;
			int parity = disk->kind == DISK_PARITY;
			tommy_node* split = tommy_list_head(&disk->split_list);
			tommy_node* dp = tommy_list_head(&disk->device_pointer_list);
			/* one entry for every device of the disk, a split parity can have more */
			do {
				if (count == max)
					goto done;
				struct host_disk* d = &out[count];
				memset(d, 0, sizeof(*d));
				sncpy(d->array, sizeof(d->array), state->name);
				sncpy(d->name, sizeof(d->name), disk->name);
				d->parity = parity;
				if (!parity && split)
					sncpy(d->mount, sizeof(d->mount), ((struct snapraid_split*)split->data)->path);
				if (dp) {
					struct snapraid_device* dev = ((struct snapraid_device_pointer*)dp->data)->device;
					sncpy(d->device, sizeof(d->device), dev->file);
					sncpy(d->serial, sizeof(d->serial), dev->serial);
					sncpy(d->model, sizeof(d->model), dev->model);
					d->standby = dev->power == POWER_STANDBY;
					dp = dp->next;
				}
				++count;
			} while (dp);
		}
	}
done:
	state_unlock();

	/* strip the final slash of the mount dirs */
	for (unsigned i = 0; i < count; ++i) {
		size_t l = strlen(out[i].mount);
		if (l > 1 && out[i].mount[l - 1] == '/')
			out[i].mount[l - 1] = 0;
	}

	return count;
}

/** Whole disk name (sda, nvme0n1) of a device node, following links. */
static int device_base(const char* device, char* name, size_t name_size)
{
	char real[PATH_MAX];

	if (realpath(device, real) == 0)
		return -1;
	if (strncmp(real, "/dev/", 5) != 0)
		return -1;
	sncpy(name, name_size, real + 5);
	if (strchr(name, '/') != 0)
		return -1;

	return 0;
}

/** Check a device given by the user: a whole disk known to the kernel. */
static int valid_disk_device(const char* device, char* name, size_t name_size)
{
	char path[PATH_MAX];

	if (strncmp(device, "/dev/", 5) != 0 || !valid_path(device))
		return 0;
	if (device_base(device, name, name_size) != 0)
		return 0;
	snprintf(path, sizeof(path), "/sys/class/block/%s/partition", name);
	if (access(path, F_OK) == 0)
		return 0; /* a partition, not a disk */
	snprintf(path, sizeof(path), "/sys/class/block/%s", name);
	return access(path, F_OK) == 0;
}

/****************************************************************************/
/* power settings of the disks */

/** Find the device of a disk by serial number, or by its node name. */
static int power_device(const char* id, char* device, size_t device_size)
{
	struct host_disk* disks = malloc_nofail(sizeof(struct host_disk) * HOST_DISKS_MAX);
	unsigned count = host_disks(disks, HOST_DISKS_MAX);
	int ret = -1;

	for (unsigned i = 0; i < count; ++i) {
		const char* base = strrchr(disks[i].device, '/');
		if ((disks[i].serial[0] && strcmp(disks[i].serial, id) == 0)
			|| (base && strcmp(base + 1, id) == 0)) {
			sncpy(device, device_size, disks[i].device);
			ret = 0;
			break;
		}
	}

	free(disks);
	return ret;
}

/** Apply the power settings of one disk with hdparm. */
static int power_apply_one(const char* id, const char* line, char* msg, size_t msg_size)
{
	char device[PATH_MAX];
	char buf[16];
	const char* args[8];
	unsigned n = 0;
	char apm[16], aam[16];

	if (power_device(id, device, sizeof(device)) != 0)
		return hfail(msg, msg_size, 404, "The disk %s is not in any array right now", id);

	if (opt_get(line, "apm", buf, sizeof(buf)) == 0) {
		snprintf(apm, sizeof(apm), "-B%d", atoi(buf));
		args[n++] = apm;
	}
	if (opt_get(line, "aam", buf, sizeof(buf)) == 0) {
		snprintf(aam, sizeof(aam), "-M%d", atoi(buf));
		args[n++] = aam;
	}
	if (opt_get(line, "wcache", buf, sizeof(buf)) == 0)
		args[n++] = atoi(buf) ? "-W1" : "-W0";
	if (n == 0)
		return 0;
	args[n++] = device;
	args[n] = 0;

	return tool_check("hdparm", args, 0, 60, msg, msg_size) != 0 ? 500 : 0;
}

/** Apply the power settings of all the disks, at the start and after a change. */
static void power_apply_all(void)
{
	char keys[64][160];
	char vals[64][256];
	unsigned n = 0;

	pthread_mutex_lock(&host_mutex);
	for (unsigned i = 0; i < kv_count && n < 64; ++i) {
		if (strncmp(kv_list[i].key, "power.", 6) == 0) {
			sncpy(keys[n], sizeof(keys[n]), kv_list[i].key + 6);
			sncpy(vals[n], sizeof(vals[n]), kv_list[i].val);
			++n;
		}
	}
	pthread_mutex_unlock(&host_mutex);

	for (unsigned i = 0; i < n; ++i) {
		char msg[MSG_MAX];
		if (power_apply_one(keys[i], vals[i], msg, sizeof(msg)) == 0)
			log_msg(LVL_INFO, "host: power settings of %s applied: %s", keys[i], vals[i]);
	}
}

/****************************************************************************/
/* streaming tools, for the long jobs */

typedef void line_func(const char* line, void* arg);

/**
 * Run a tool as root, without shell, until it ends or the job is stopped.
 * Every line of its output goes to the callback; \r also ends a line, for progress lines.
 * \return The exit code, -1 on failure or stop, -2 if the tool is missing.
 */
static int tool_stream(const char* name, const char** args, line_func* func, void* arg)
{
	char path[PATH_MAX];
	const char* argv[64];
	unsigned argc = 0;
	int fds[2];
	static char* envp[] = { "PATH=/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin", "LC_ALL=C", 0 };

	if (tool_find(name, path, sizeof(path)) != 0)
		return -2;

	argv[argc++] = path;
	while (*args && argc < 63)
		argv[argc++] = *args++;
	argv[argc] = 0;

	if (pipe2(fds, O_CLOEXEC) != 0)
		return -1;

	priv_enter();
	pid_t pid = fork();
	if (pid == 0) {
		os_signal_restore_after_fork();
		setpgid(0, 0);
		int devnull = open("/dev/null", O_RDONLY);
		if (devnull >= 0)
			dup2(devnull, 0);
		dup2(fds[1], 1);
		dup2(fds[1], 2);
		execve(path, (char**)argv, envp);
		_exit(127);
	}
	priv_leave();

	close(fds[1]);
	if (pid < 0) {
		close(fds[0]);
		return -1;
	}

	char line[4096];
	size_t len = 0;
	int stopped = 0;
	while (1) {
		char buf[4096];
		struct pollfd pfd = { fds[0], POLLIN, 0 };

		if (job_stopping()) {
			stopped = 1;
			break;
		}

		int r = poll(&pfd, 1, 500);
		if (r < 0 && errno != EINTR)
			break;
		if (r <= 0)
			continue;

		ssize_t n = read(fds[0], buf, sizeof(buf));
		if (n < 0 && errno == EINTR)
			continue;
		if (n <= 0)
			break;
		for (ssize_t i = 0; i < n; ++i) {
			if (buf[i] == '\n' || buf[i] == '\r') {
				line[len] = 0;
				if (len > 0 && func)
					func(line, arg);
				len = 0;
			} else if (len < sizeof(line) - 1) {
				line[len++] = buf[i];
			}
		}
	}
	close(fds[0]);

	if (stopped) {
		priv_enter();
		kill(-pid, SIGTERM);
		priv_leave();
	}

	int status;
	while (waitpid(pid, &status, 0) < 0) {
		if (errno != EINTR)
			return -1;
	}

	if (stopped || !WIFEXITED(status))
		return -1;

	return WEXITSTATUS(status);
}

/****************************************************************************/
/* jobs: wipe, copy of a tree, permissions */

static struct {
	char a[PATH_MAX];
	char b[PATH_MAX];
	char c[64];
	int flag;
	char last_error[512];
	char backup_name[64]; /**< Set when the copy is a backup */
} hjob;

#define WIPE_CHUNK (4 * 1024 * 1024)

static void* wipe_thread(void* arg)
{
	(void)arg;
	char msg[MSG_MAX];
	const char* device = hjob.a;
	int random = strcmp(hjob.c, "random") == 0;

	priv_enter();
	int f = open(device, O_WRONLY | O_CLOEXEC | O_EXCL);
	priv_leave();
	if (f < 0) {
		snprintf(msg, sizeof(msg), "Cannot open %.100s: %.100s", device, strerror(errno));
		job_finish(500, msg);
		return 0;
	}

	uint64_t size = 0;
	if (ioctl(f, BLKGETSIZE64, &size) != 0 || size == 0) {
		close(f);
		job_finish(500, "Cannot read the size of the disk");
		return 0;
	}

	unsigned char* buf = malloc_nofail(WIPE_CHUNK);
	memset(buf, 0, WIPE_CHUNK);
	uint64_t done = 0;
	uint64_t seed = (uint64_t)time(0) ^ ((uint64_t)getpid() << 32);
	int failed = 0;

	job_current(device);
	while (done < size) {
		if (job_stopping())
			break;
		size_t chunk = size - done < WIPE_CHUNK ? (size_t)(size - done) : WIPE_CHUNK;
		if (random) {
			/* xorshift: not secret, but leaves nothing readable */
			uint64_t* w = (uint64_t*)buf;
			for (size_t i = 0; i < chunk / 8; ++i) {
				seed ^= seed << 13;
				seed ^= seed >> 7;
				seed ^= seed << 17;
				w[i] = seed;
			}
		}
		ssize_t n = pwrite(f, buf, chunk, (off_t)done);
		if (n < 0 && errno == EINTR)
			continue;
		if (n <= 0) {
			failed = errno ? errno : EIO;
			break;
		}
		done += n;
		job_progress(0, n);
	}
	fsync(f);
	close(f);
	free(buf);

	if (failed) {
		snprintf(msg, sizeof(msg), "Write error after %" PRIu64 " bytes: %s. The disk may be failing.", done, strerror(failed));
		job_finish(500, msg);
	} else if (done < size) {
		snprintf(msg, sizeof(msg), "Stopped after %" PRIu64 " of %" PRIu64 " bytes. What was not overwritten is still readable.", done, size);
		job_finish(499, msg);
	} else {
		/* tell the kernel the partitions are gone */
		const char* rr[] = { "--rereadpt", device, 0 };
		tool_run("blockdev", rr, 0, 0, 30);
		snprintf(msg, sizeof(msg), "The whole disk %.100s was overwritten (%" PRIu64 " bytes). It's blank now.", device, size);
		job_finish(0, msg);
	}

	return 0;
}

/****************************************************************************/
/* write test of a disk before trusting it with files */

#define BURNIN_BAD_MAX 20 /**< Areas listed one by one in the result */

/** Fill a buffer with the pattern following the seed. Any two disks get different data. */
static void burnin_pattern(unsigned char* buf, size_t size, uint64_t* seed)
{
	uint64_t x = *seed;
	size_t i = 0;

	for (; i + 8 <= size; i += 8) {
		x ^= x << 13;
		x ^= x >> 7;
		x ^= x << 17;
		memcpy(buf + i, &x, 8);
	}
	for (; i < size; ++i)
		buf[i] = (unsigned char)(x >> (8 * (i & 7)));
	*seed = x;
}

/**
 * Write the pattern over the whole size, or read it back and compare.
 * \param bad Areas that differ or cannot be read, counted when reading back.
 * \return 0 if it ran to the end, 1 if stopped, -1 on a write error with errno set.
 */
static int burnin_pass(int f, uint64_t size, uint64_t seed, int verify, unsigned char* buf, unsigned char* want, uint64_t* done_out, unsigned* bad)
{
	uint64_t done = 0;
	int ret = 0;

	while (done < size) {
		if (job_stopping()) {
			ret = 1;
			break;
		}
		size_t chunk = size - done < WIPE_CHUNK ? (size_t)(size - done) : WIPE_CHUNK;
		if (!verify) {
			burnin_pattern(buf, chunk, &seed);
			size_t off = 0;
			while (off < chunk) {
				ssize_t n = pwrite(f, buf + off, chunk - off, (off_t)(done + off));
				if (n < 0 && errno == EINTR)
					continue;
				if (n <= 0) {
					if (n == 0)
						errno = EIO;
					*done_out = done + off;
					return -1;
				}
				off += n;
			}
		} else {
			burnin_pattern(want, chunk, &seed);
			size_t off = 0;
			int unreadable = 0;
			while (off < chunk) {
				ssize_t n = pread(f, buf + off, chunk - off, (off_t)(done + off));
				if (n < 0 && errno == EINTR)
					continue;
				if (n <= 0) {
					unreadable = 1;
					break;
				}
				off += n;
			}
			if (unreadable || memcmp(buf, want, chunk) != 0) {
				if (*bad < BURNIN_BAD_MAX) {
					char where[64];
					snprintf(where, sizeof(where), "%" PRIu64, done);
					job_result_line(where, unreadable ? "cannot be read" : "reads back different from what was written");
				}
				++*bad;
			}
			posix_fadvise(f, (off_t)done, chunk, POSIX_FADV_DONTNEED);
		}
		done += chunk;
		job_progress(0, chunk);
	}

	*done_out = done;
	return ret;
}

static void* burnin_thread(void* arg)
{
	(void)arg;
	char msg[MSG_MAX];
	const char* device = hjob.a;
	int direct = 1;

	/* straight to the disk: what is read back comes from the disk and not from the memory */
	priv_enter();
	int f = open(device, O_RDWR | O_CLOEXEC | O_EXCL | O_DIRECT);
	if (f < 0) {
		direct = 0;
		f = open(device, O_RDWR | O_CLOEXEC | O_EXCL);
	}
	priv_leave();
	if (f < 0) {
		snprintf(msg, sizeof(msg), "Cannot open %.100s: %.100s", device, strerror(errno));
		job_finish(500, msg);
		return 0;
	}

	uint64_t size = 0;
	if (ioctl(f, BLKGETSIZE64, &size) != 0 || size == 0) {
		close(f);
		job_finish(500, "Cannot read the size of the disk");
		return 0;
	}

	unsigned char* buf = 0;
	unsigned char* want = 0;
	if (posix_memalign((void**)&buf, 4096, WIPE_CHUNK) != 0 || posix_memalign((void**)&want, 4096, WIPE_CHUNK) != 0) {
		close(f);
		free(buf);
		job_finish(500, "Not enough memory for the test");
		return 0;
	}

	uint64_t seed = ((uint64_t)time(0) << 20) ^ ((uint64_t)getpid() << 40) ^ size ^ 0x9E3779B97F4A7C15ULL;
	uint64_t done = 0;
	unsigned bad = 0;

	job_current("Writing to every block");
	int ret = burnin_pass(f, size, seed, 0, buf, want, &done, &bad);
	int failed = ret < 0 ? errno : 0;
	int written_all = ret == 0;
	uint64_t checked = 0;
	if (ret == 0) {
		fsync(f);
		if (!direct)
			posix_fadvise(f, 0, 0, POSIX_FADV_DONTNEED);
		job_current("Reading every block back");
		ret = burnin_pass(f, size, seed, 1, buf, want, &checked, &bad);
	}

	/* leave it blank where a filesystem would be looked for */
	if (failed == 0) {
		memset(buf, 0, WIPE_CHUNK);
		uint64_t head = size < 4 * (uint64_t)WIPE_CHUNK ? size : 4 * (uint64_t)WIPE_CHUNK;
		for (uint64_t o = 0; o < head; o += WIPE_CHUNK) {
			size_t chunk = head - o < WIPE_CHUNK ? (size_t)(head - o) : WIPE_CHUNK;
			if (pwrite(f, buf, chunk, (off_t)o) < 0)
				break;
		}
		if (size > WIPE_CHUNK)
			(void)!pwrite(f, buf, WIPE_CHUNK, (off_t)((size - WIPE_CHUNK) & ~(uint64_t)4095));
		fsync(f);
	}
	close(f);
	free(buf);
	free(want);

	if (failed) {
		snprintf(msg, sizeof(msg), "Write error after %" PRIu64 " bytes: %s. This disk is failing: do not trust it with files.", done, strerror(failed));
		job_finish(500, msg);
	} else if (bad) {
		snprintf(msg, sizeof(msg), "%u areas of %.100s did not give back what was written. This disk is failing: do not trust it with files.", bad, device);
		job_finish(500, msg);
	} else if (!written_all || ret != 0) {
		snprintf(msg, sizeof(msg), "Stopped before the end: %" PRIu64 " of %" PRIu64 " bytes written, %" PRIu64 " read back, no error so far. The test tells nothing sure until it runs to the end.", done, size, checked);
		job_finish(499, msg);
	} else {
		const char* rr[] = { "--rereadpt", device, 0 };
		tool_run("blockdev", rr, 0, 0, 30);
		snprintf(msg, sizeof(msg), "Every block of %.100s was written and read back without a single error (%" PRIu64 " bytes). The disk is blank and ready to use.", device, size);
		job_finish(0, msg);
	}

	return 0;
}

static int wipe_start(const char* device, const char* method, char* msg, size_t msg_size)
{
	char name[64];

	if (!valid_disk_device(device, name, sizeof(name)))
		return hfail(msg, msg_size, 400, "%s is not a whole disk", device);
	int test = strcmp(method, "test") == 0;
	if (!test && strcmp(method, "zero") != 0 && strcmp(method, "random") != 0)
		return hfail(msg, msg_size, 400, "The method is zero, random or test");

	/* never a disk of an array, even if it's not mounted now */
	struct host_disk* disks = malloc_nofail(sizeof(struct host_disk) * HOST_DISKS_MAX);
	unsigned count = host_disks(disks, HOST_DISKS_MAX);
	for (unsigned i = 0; i < count; ++i) {
		char other[64];
		if (disks[i].device[0] && device_base(disks[i].device, other, sizeof(other)) == 0 && strcmp(other, name) == 0) {
			int ret = hfail(msg, msg_size, 409, "%s is the disk %s of the array %s. Remove it from the array first.", device, disks[i].name, disks[i].array);
			free(disks);
			return ret;
		}
	}
	free(disks);

	int ret = disk_in_use(name, msg, msg_size);
	if (ret != 0)
		return ret;

	ret = job_begin(test ? "burnin" : "wipe", device, msg, msg_size);
	if (ret != 0)
		return ret;
	sncpy(hjob.a, sizeof(hjob.a), device);
	sncpy(hjob.c, sizeof(hjob.c), method);
	log_msg(LVL_WARNING, "host: wipe of %s with %s started", device, method);

	return job_launch(test ? burnin_thread : wipe_thread, msg, msg_size);
}

/** Progress of rsync with --info=progress2: "  1,234,567  12%  1.2MB/s  0:00:12 (xfr#3, to-chk=1/9)" */
static void rsync_line(const char* line, void* arg)
{
	(void)arg;
	const char* p = line;
	while (*p == ' ')
		++p;

	if (isdigit((unsigned char)*p)) {
		uint64_t bytes = 0;
		for (; *p && *p != ' '; ++p) {
			if (isdigit((unsigned char)*p))
				bytes = bytes * 10 + (*p - '0');
		}
		const char* xfr = strstr(line, "xfr#");
		uint64_t files = xfr ? strtoull(xfr + 4, 0, 10) : 0;
		/* the counters are totals: report the difference */
		static uint64_t last_bytes, last_files;
		if (bytes < last_bytes || files < last_files)
			last_bytes = last_files = 0;
		job_progress(files - last_files, bytes - last_bytes);
		last_bytes = bytes;
		last_files = files;
		job_current(line);
		return;
	}

	if (strncmp(line, "rsync:", 6) == 0 || strncmp(line, "rsync error", 11) == 0) {
		sncpy(hjob.last_error, sizeof(hjob.last_error), line);
		job_result_line("error", line);
	}
}

static void backup_record(const char* name, int status, const char* message);

static void* copy_thread(void* arg)
{
	(void)arg;
	char msg[MSG_MAX];
	char src[PATH_MAX + 2];
	const char* args[16];
	unsigned n = 0;

	/* the final slash copies the content of the folder, not the folder; a file goes as it is */
	snprintf(src, sizeof(src), "%s%s", hjob.a, strcmp(hjob.c, "file") == 0 ? "" : "/");
	hjob.last_error[0] = 0;

	args[n++] = "-aHAX";
	args[n++] = "--info=progress2";
	args[n++] = "--no-inc-recursive";
	if (hjob.flag)
		args[n++] = "--delete";
	args[n++] = "--exclude=/" RECYCLE_DIR;
	args[n++] = "--exclude=/lost+found";
	args[n++] = "--exclude=/snapraid.content*";
	args[n++] = "--exclude=/.snapraid*";
	args[n++] = src;
	args[n++] = hjob.b;
	args[n] = 0;

	make_dirs(hjob.b);
	int ret = tool_stream("rsync", args, rsync_line, 0);

	int status;
	if (ret == -2) {
		status = 501;
		snprintf(msg, sizeof(msg), "rsync is not installed");
	} else if (ret == -1 && job_stopping()) {
		status = 499;
		snprintf(msg, sizeof(msg), "Stopped. What was copied stays in %.100s; running it again continues from there.", hjob.b);
	} else if (ret == 0) {
		status = 0;
		snprintf(msg, sizeof(msg), "Copied %.100s to %.100s", hjob.a, hjob.b);
	} else if (ret == 23 || ret == 24) {
		status = 207;
		snprintf(msg, sizeof(msg), "Copied, but some files could not be read or vanished during the copy. %.150s", hjob.last_error);
	} else {
		status = 500;
		snprintf(msg, sizeof(msg), "The copy failed (rsync exit code %d). %.200s", ret, hjob.last_error);
	}

	if (hjob.backup_name[0]) {
		backup_record(hjob.backup_name, status, msg);
		host_event(status == 0 ? "ok" : status == 499 || status == 207 ? "warn" : "bad", "backup", hjob.backup_name, msg);
	}
	job_finish(status == 207 ? 0 : status, msg);

	return 0;
}

static int data_area(const char* path)
{
	return strncmp(path, "/mnt/", 5) == 0 || strncmp(path, "/srv/", 5) == 0 || strncmp(path, "/media/", 7) == 0;
}

/**
 * The folder holding a path, with every link resolved, must still be in the data area:
 * a link inside a pool pointing to /etc does not make /etc reachable.
 * The last component is not resolved: a link is renamed or deleted as a link.
 */
static int real_inside(const char* path)
{
	char parent[PATH_MAX];
	char real[PATH_MAX];

	sncpy(parent, sizeof(parent), path);
	char* slash = strrchr(parent, '/');
	if (!slash)
		return 0;
	if (slash == parent)
		slash[1] = 0;
	else
		*slash = 0;

	priv_enter();
	char* r = realpath(parent, real);
	priv_leave();
	if (!r)
		return errno == ENOENT; /* a folder to be created: its string was checked */

	return data_area(real) && !system_path(real);
}

/** A tree that can be read or written by the jobs: a mount of a disk or a pool, or a folder inside one. */
static int valid_tree(const char* path, char* msg, size_t msg_size)
{
	if (!valid_user_path(path))
		return hfail(msg, msg_size, 400, "Invalid folder '%s'", path);
	if (path[strlen(path) - 1] == '/')
		return hfail(msg, msg_size, 400, "Invalid folder '%s': no final slash", path);
	if (system_path(path) || path_inside(path, "/etc") || path_inside(path, "/boot"))
		return hfail(msg, msg_size, 400, "%s is a system folder", path);
	if (!data_area(path))
		return hfail(msg, msg_size, 400, "Only folders under /mnt, /srv and /media are handled");
	if (!real_inside(path))
		return hfail(msg, msg_size, 400, "%s goes through a link leading out of /mnt, /srv and /media", path);
	return 0;
}

static int copy_start(const char* kind, const char* source, const char* target, int mirror, const char* backup_name, char* msg, size_t msg_size)
{
	struct stat st;
	int ret;

	if ((ret = valid_tree(source, msg, msg_size)) != 0)
		return ret;
	if ((ret = valid_tree(target, msg, msg_size)) != 0)
		return ret;
	if (path_inside(target, source) || path_inside(source, target))
		return hfail(msg, msg_size, 400, "The source and the destination are one inside the other");
	priv_enter();
	int have = lstat(source, &st) == 0 && (S_ISDIR(st.st_mode) || S_ISREG(st.st_mode));
	priv_leave();
	if (!have)
		return hfail(msg, msg_size, 404, "%s does not exist", source);
	if (S_ISREG(st.st_mode) && mirror)
		return hfail(msg, msg_size, 400, "Only a folder can be mirrored");

	ret = job_begin(kind, source, msg, msg_size);
	if (ret != 0)
		return ret;
	sncpy(hjob.c, sizeof(hjob.c), S_ISREG(st.st_mode) ? "file" : "");
	sncpy(hjob.a, sizeof(hjob.a), source);
	sncpy(hjob.b, sizeof(hjob.b), target);
	sncpy(hjob.backup_name, sizeof(hjob.backup_name), backup_name ? backup_name : "");
	hjob.flag = mirror;
	log_msg(LVL_INFO, "host: %s of %s to %s started%s", kind, source, target, mirror ? ", mirror" : "");

	return job_launch(copy_thread, msg, msg_size);
}

/** Owner and permissions of a shared tree: everybody of the group "users" reads and writes. */
static void* perms_thread(void* arg)
{
	(void)arg;
	char msg[MSG_MAX];

	job_current(hjob.a);
	const char* own[] = { "-R", "nobody:users", hjob.a, 0 };
	int r1 = tool_stream("chown", own, 0, 0);
	const char* mod[] = { "-R", "u=rwX,g=rwX,o=rX", hjob.a, 0 };
	int r2 = r1 == 0 ? tool_stream("chmod", mod, 0, 0) : -1;

	if (r1 == 0 && r2 == 0) {
		snprintf(msg, sizeof(msg), "Every file in %.120s now belongs to the share users, who can read and write it", hjob.a);
		job_finish(0, msg);
	} else if (job_stopping()) {
		job_finish(499, "Stopped: some files still have their old permissions");
	} else {
		snprintf(msg, sizeof(msg), "Changing the permissions failed (%d, %d)", r1, r2);
		job_finish(500, msg);
	}

	return 0;
}

static void group_users_ensure(void)
{
	if (getgrnam("users") == 0) {
		const char* args[] = { "--system", "users", 0 };
		tool_run("groupadd", args, 0, 0, 30);
	}
}

static int perms_start(const char* path, char* msg, size_t msg_size)
{
	int ret = valid_tree(path, msg, msg_size);
	if (ret != 0)
		return ret;

	group_users_ensure();

	ret = job_begin("permissions", path, msg, msg_size);
	if (ret != 0)
		return ret;
	sncpy(hjob.a, sizeof(hjob.a), path);

	return job_launch(perms_thread, msg, msg_size);
}

/****************************************************************************/
/* jobs: where a folder is stored, reading test of a disk */

struct usage_sum {
	uint64_t bytes;
	uint64_t files;
};

static int usage_add(const char* rel, const struct stat* st, void* arg)
{
	struct usage_sum* sum = arg;

	(void)rel;
	sum->bytes += (uint64_t)st->st_blocks * 512;
	++sum->files;
	job_progress(1, (uint64_t)st->st_blocks * 512);

	return 0;
}

/** Size of a folder, and how much of it is on every disk of its pool. */
static void* usage_thread(void* arg)
{
	(void)arg;
	char msg[MSG_MAX];
	char pool[PATH_MAX] = "";
	struct mount_entry entry;
	struct pool_branch* branches = malloc_nofail(sizeof(struct pool_branch) * BRANCH_MAX);
	unsigned count = 0;
	ss_t mounts;
	int r;
	uint64_t total = 0;
	uint64_t files = 0;

	/* the pool holding the folder, if any */
	ss_init(&mounts, 4096);
	file_read("/proc/self/mounts", &mounts);
	ss_write(&mounts, "", 1);
	const char* cursor = ss_ptr(&mounts);
	while ((r = mount_next(&cursor, &entry, 0, 0)) >= 0) {
		if (r == 1 && is_mergerfs(entry.fstype) && path_inside(hjob.a, entry.target) && strlen(entry.target) > strlen(pool))
			sncpy(pool, sizeof(pool), entry.target);
	}
	ss_done(&mounts);

	priv_enter();
	if (pool[0] && pool_branches(pool, branches, &count, msg, sizeof(msg)) == 0) {
		const char* sub = hjob.a + strlen(pool);
		for (unsigned i = 0; i < count && !job_stopping(); ++i) {
			char root[PATH_MAX * 2];
			char value[64];
			struct usage_sum sum = { 0, 0 };
			snprintf(root, sizeof(root), "%s%s", branches[i].path, sub);
			job_current(branches[i].path);
			walk_tree(root, "", 0, usage_add, &sum);
			if (sum.files == 0)
				continue;
			snprintf(value, sizeof(value), "%" PRIu64 " %" PRIu64, sum.bytes, sum.files);
			job_result_line(branches[i].path, value);
			total += sum.bytes;
			files += sum.files;
		}
	} else {
		char value[64];
		struct usage_sum sum = { 0, 0 };
		job_current(hjob.a);
		walk_tree(hjob.a, "", 0, usage_add, &sum);
		snprintf(value, sizeof(value), "%" PRIu64 " %" PRIu64, sum.bytes, sum.files);
		job_result_line(hjob.a, value);
		total = sum.bytes;
		files = sum.files;
	}
	priv_leave();
	free(branches);

	if (job_stopping()) {
		job_finish(499, "Stopped before every file was counted");
	} else {
		snprintf(msg, sizeof(msg), "%" PRIu64 " files, %" PRIu64 " bytes", files, total);
		job_finish(0, msg);
	}

	return 0;
}

static int usage_start(const char* path, char* msg, size_t msg_size)
{
	struct stat st;
	int ret = valid_tree(path, msg, msg_size);
	if (ret != 0)
		return ret;
	/* not through a link: it could lead anywhere */
	priv_enter();
	int have = lstat(path, &st) == 0 && S_ISDIR(st.st_mode);
	priv_leave();
	if (!have)
		return hfail(msg, msg_size, 404, "The folder %s does not exist", path);

	ret = job_begin("usage", path, msg, msg_size);
	if (ret != 0)
		return ret;
	sncpy(hjob.a, sizeof(hjob.a), path);

	return job_launch(usage_thread, msg, msg_size);
}

#define SURFACE_ERRORS_MAX 100

/**
 * Read a whole disk, from the first to the last block. Nothing is written:
 * it's safe on a disk in use, and it tells if a new disk can be trusted.
 */
static void* surface_thread(void* arg)
{
	(void)arg;
	char msg[MSG_MAX];
	const char* device = hjob.a;

	priv_enter();
	int f = open(device, O_RDONLY | O_CLOEXEC);
	priv_leave();
	if (f < 0) {
		snprintf(msg, sizeof(msg), "Cannot open %.100s: %.100s", device, strerror(errno));
		job_finish(500, msg);
		return 0;
	}

	uint64_t size = 0;
	if (ioctl(f, BLKGETSIZE64, &size) != 0 || size == 0) {
		close(f);
		job_finish(500, "Cannot read the size of the disk");
		return 0;
	}

	unsigned char* buf = malloc_nofail(WIPE_CHUNK);
	uint64_t done = 0;
	unsigned errors = 0;

	job_current(device);
	while (done < size && errors < SURFACE_ERRORS_MAX) {
		if (job_stopping())
			break;
		size_t chunk = size - done < WIPE_CHUNK ? (size_t)(size - done) : WIPE_CHUNK;
		ssize_t n = pread(f, buf, chunk, (off_t)done);
		if (n < 0 && errno == EINTR)
			continue;
		if (n <= 0) {
			/* an area that cannot be read: note it and go on after it */
			char where[64];
			snprintf(where, sizeof(where), "%" PRIu64, done);
			job_result_line(where, n < 0 ? strerror(errno) : "short read");
			++errors;
			n = chunk;
		} else {
			/* don't push the files in use out of the memory */
			posix_fadvise(f, (off_t)done, n, POSIX_FADV_DONTNEED);
		}
		done += n;
		job_progress(0, n);
	}
	close(f);
	free(buf);

	if (errors >= SURFACE_ERRORS_MAX) {
		snprintf(msg, sizeof(msg), "Stopped after %u areas that cannot be read. This disk is failing: do not trust it with files.", errors);
		job_finish(500, msg);
	} else if (done < size) {
		snprintf(msg, sizeof(msg), "Stopped after %" PRIu64 " of %" PRIu64 " bytes, with %u areas that cannot be read", done, size, errors);
		job_finish(499, msg);
	} else if (errors) {
		snprintf(msg, sizeof(msg), "%u areas of %.100s cannot be read. This disk is failing: do not trust it with files.", errors, device);
		job_finish(500, msg);
	} else {
		snprintf(msg, sizeof(msg), "Every block of %.100s was read without errors (%" PRIu64 " bytes)", device, size);
		job_finish(0, msg);
	}

	return 0;
}

static int surface_start(const char* device, char* msg, size_t msg_size)
{
	char name[64];

	if (!valid_disk_device(device, name, sizeof(name)))
		return hfail(msg, msg_size, 400, "%s is not a whole disk", device);

	int ret = job_begin("surface", device, msg, msg_size);
	if (ret != 0)
		return ret;
	sncpy(hjob.a, sizeof(hjob.a), device);

	return job_launch(surface_thread, msg, msg_size);
}

/****************************************************************************/
/* files */

/** Delete a file or a folder of a disk or of a pool. Never a mount point. */
static int file_delete(const char* path, char* msg, size_t msg_size)
{
	struct mount_entry entry;
	int ret = valid_tree(path, msg, msg_size);
	if (ret != 0)
		return ret;
	if (mount_find(path, &entry) == 0)
		return hfail(msg, msg_size, 400, "%s is where a disk or a pool is mounted, it cannot be deleted", path);

	struct stat st;
	if (lstat(path, &st) != 0)
		return hfail(msg, msg_size, 404, "%s does not exist", path);

	const char* args[] = { "-rf", "--one-file-system", "--", path, 0 };
	if (tool_check("rm", args, 0, 600, msg, msg_size) != 0)
		return 500;

	log_msg(LVL_INFO, "host: deleted %s", path);
	return 0;
}

/** Rename a file or a folder, in the same folder. */
static int file_rename(const char* path, const char* name, char* msg, size_t msg_size)
{
	char target[PATH_MAX];
	struct mount_entry entry;

	int ret = valid_tree(path, msg, msg_size);
	if (ret != 0)
		return ret;
	if (name[0] == 0 || strchr(name, '/') || strcmp(name, ".") == 0 || strcmp(name, "..") == 0 || !valid_line(name, 256) || strpbrk(name, "\"\\'`$"))
		return hfail(msg, msg_size, 400, "Invalid new name");
	if (mount_find(path, &entry) == 0)
		return hfail(msg, msg_size, 400, "%s is a mount point", path);

	sncpy(target, sizeof(target), path);
	char* slash = strrchr(target, '/');
	slash[1] = 0;
	if (strlen(target) + strlen(name) >= sizeof(target))
		return hfail(msg, msg_size, 400, "The name is too long");
	sncat(target, sizeof(target), name);

	priv_enter();
	if (access(target, F_OK) == 0) {
		priv_leave();
		return hfail(msg, msg_size, 409, "%s already exists", target);
	}
	int r = rename(path, target);
	int e = errno;
	priv_leave();
	if (r != 0)
		return hfail(msg, msg_size, 500, "Cannot rename: %s", strerror(e));

	log_msg(LVL_INFO, "host: renamed %s to %s", path, target);
	return 0;
}

/****************************************************************************/
/* open files */

/**
 * List the processes using a mount point: open files, current dir, executable.
 * It's what keeps a disk busy and an unmount failing.
 */
static void open_files_json(const char* mount, ss_t* s, int level)
{
	DIR* d = opendir("/proc");
	unsigned listed = 0;

	ss_json_str(s, level, "path", mount);
	ss_json_array_open(s, &level, "processes");

	priv_enter();
	struct dirent* dd;
	while (d && (dd = readdir(d)) != 0 && listed < 100) {
		char base[64];
		char link[PATH_MAX];
		char target[PATH_MAX];
		char first[PATH_MAX] = "";
		unsigned files = 0;
		int cwd = 0;

		if (!isdigit((unsigned char)dd->d_name[0]))
			continue;
		int pid = atoi(dd->d_name);
		if (pid == getpid())
			continue;

		snprintf(base, sizeof(base), "/proc/%d", pid);

		snprintf(link, sizeof(link), "%s/cwd", base);
		ssize_t n = readlink(link, target, sizeof(target) - 1);
		if (n > 0) {
			target[n] = 0;
			if (path_inside(target, mount))
				cwd = 1;
		}

		snprintf(link, sizeof(link), "%s/fd", base);
		DIR* fd = opendir(link);
		struct dirent* fe;
		while (fd && (fe = readdir(fd)) != 0) {
			char one[PATH_MAX];
			if (fe->d_name[0] == '.')
				continue;
			snprintf(one, sizeof(one), "%s/fd/%s", base, fe->d_name);
			n = readlink(one, target, sizeof(target) - 1);
			if (n <= 0)
				continue;
			target[n] = 0;
			if (path_inside(target, mount)) {
				if (files == 0)
					sncpy(first, sizeof(first), target);
				++files;
			}
		}
		if (fd)
			closedir(fd);

		if (files == 0 && !cwd)
			continue;

		char comm[64] = "";
		char comm_path[128];
		snprintf(comm_path, sizeof(comm_path), "%s/comm", base);
		FILE* cf = fopen(comm_path, "r");
		if (cf) {
			if (fgets(comm, sizeof(comm), cf) == 0)
				comm[0] = 0;
			fclose(cf);
			strtrim(comm);
		}
		struct stat st;
		char user[64] = "?";
		if (stat(base, &st) == 0) {
			struct passwd* pw = getpwuid(st.st_uid);
			if (pw)
				sncpy(user, sizeof(user), pw->pw_name);
			else
				snprintf(user, sizeof(user), "%u", (unsigned)st.st_uid);
		}

		ss_json_open(s, &level);
		ss_json_int(s, level, "pid", pid);
		ss_json_str(s, level, "name", comm);
		ss_json_str(s, level, "user", user);
		ss_json_uint(s, level, "files", files);
		ss_json_bool(s, level, "cwd", cwd);
		if (first[0])
			ss_json_str(s, level, "example", first);
		ss_json_close(s, &level);
		++listed;
	}
	priv_leave();
	if (d)
		closedir(d);

	ss_json_array_close(s, &level);
}

/****************************************************************************/
/* shares */

/** Write the share sections of Samba and the exports of NFS from the settings, and reload both. */
static int shares_apply(char* msg, size_t msg_size)
{
	ss_t smb;
	ss_t nfs;
	int smb_count = 0;
	int nfs_count = 0;
	int fsid = 7600;
	struct group* gr = getgrnam("users");
	unsigned users_gid = gr ? (unsigned)gr->gr_gid : 100;

	ss_init(&smb, 4096);
	ss_init(&nfs, 1024);
	ss_prints(&smb, "# Shares of the SnapRAID Daemon, written from its web interface. Do not edit:\n");
	ss_prints(&smb, "# the file is written again at every change of the shares.\n");
	ss_prints(&nfs, "# Shares of the SnapRAID Daemon, written from its web interface. Do not edit.\n");

	pthread_mutex_lock(&host_mutex);
	for (unsigned i = 0; i < kv_count; ++i) {
		if (strncmp(kv_list[i].key, "share.", 6) != 0)
			continue;
		const char* name = kv_list[i].key + 6;
		const char* line = kv_list[i].val;
		char path[PATH_MAX];
		char users[512];
		char comment[256];
		char hosts[512];
		opt_get(line, "path", path, sizeof(path));
		opt_get(line, "users", users, sizeof(users));
		opt_get(line, "comment", comment, sizeof(comment));
		opt_get(line, "nfs_hosts", hosts, sizeof(hosts));
		int writable = opt_bool(line, "writable", 1);

		if (opt_bool(line, "smb", 1)) {
			++smb_count;
			ss_printf(&smb, "\n[%s]\n", name);
			ss_printf(&smb, "\tpath = %s\n", path);
			if (comment[0])
				ss_printf(&smb, "\tcomment = %s\n", comment);
			ss_printf(&smb, "\tbrowseable = %s\n", opt_bool(line, "hidden", 0) ? "no" : "yes");
			ss_printf(&smb, "\tread only = %s\n", writable ? "no" : "yes");
			if (opt_bool(line, "guest", 0)) {
				ss_prints(&smb, "\tguest ok = yes\n");
			} else {
				ss_prints(&smb, "\tguest ok = no\n");
				if (users[0]) {
					for (char* c = users; *c; ++c)
						if (*c == ',')
							*c = ' ';
					ss_printf(&smb, "\tvalid users = %s\n", users);
				}
			}
			/* new files belong to the share users, see the permission reset */
			ss_prints(&smb, "\tforce user = nobody\n");
			ss_prints(&smb, "\tforce group = users\n");
			ss_prints(&smb, "\tcreate mask = 0664\n");
			ss_prints(&smb, "\tdirectory mask = 0775\n");
			if (opt_bool(line, "recycle", 0)) {
				ss_prints(&smb, "\tvfs objects = recycle\n");
				ss_prints(&smb, "\trecycle:repository = " RECYCLE_DIR "\n");
				ss_prints(&smb, "\trecycle:keeptree = yes\n");
				ss_prints(&smb, "\trecycle:versions = yes\n");
				ss_prints(&smb, "\trecycle:touch_mtime = yes\n");
				ss_prints(&smb, "\trecycle:directory_mode = 0775\n");
				ss_prints(&smb, "\tveto files = /" RECYCLE_DIR "/\n");
			}
		}
		if (opt_bool(line, "nfs", 0)) {
			++nfs_count;
			if (hosts[0] == 0)
				sncpy(hosts, sizeof(hosts), "*");
			ss_printf(&nfs, "\"%s\"", path);
			char* save = 0;
			for (char* h = strtok_r(hosts, ",", &save); h; h = strtok_r(0, ",", &save)) {
				/* fsid is needed by FUSE filesystems like the pools */
				ss_printf(&nfs, " %s(%s,sync,no_subtree_check,all_squash,anonuid=65534,anongid=%u,fsid=%d)", h, writable ? "rw" : "ro", users_gid, fsid);
			}
			ss_prints(&nfs, "\n");
			++fsid;
		}
	}
	pthread_mutex_unlock(&host_mutex);
	ss_write(&smb, "", 1);
	ss_write(&nfs, "", 1);

	int ret = 0;
	msg[0] = 0;

	/* Samba: our file, and one include line at the end of smb.conf. Our file starts with a section */
	if (access("/etc/samba", F_OK) == 0) {
		if (file_replace(SMB_SHARES_CONF, ss_ptr(&smb), 0, 0644) != 0) {
			ret = hfail(msg, msg_size, 500, "Cannot write %s", SMB_SHARES_CONF);
		} else {
			ss_t conf;
			ss_init(&conf, 4096);
			if (file_read(SMB_CONF, &conf) == 0 && strstr(ss_ptr(&conf), "include = " SMB_SHARES_CONF) == 0) {
				const char* text = ss_ptr(&conf);
				ss_t out;
				ss_init(&out, ss_len(&conf) + 256);
				ss_prints(&out, text);
				if (ss_len(&conf) > 0 && text[ss_len(&conf) - 1] != '\n')
					ss_prints(&out, "\n");
				ss_prints(&out, "\n# Shares of the SnapRAID Daemon. Keep this line last.\ninclude = " SMB_SHARES_CONF "\n");
				ss_write(&out, "", 1);
				if (file_replace(SMB_CONF, ss_ptr(&out), ".snapraidd.bak", 0644) != 0)
					ret = hfail(msg, msg_size, 500, "Cannot add the shares to %s", SMB_CONF);
				ss_done(&out);
			}
			ss_done(&conf);
		}
		if (ret == 0 && tool_exists("testparm")) {
			const char* args[] = { "-s", SMB_CONF, 0 };
			ss_t out;
			ss_init(&out, 4096);
			int r = tool_run("testparm", args, 0, &out, 30);
			ss_done(&out);
			if (r != 0)
				ret = hfail(msg, msg_size, 500, "Samba refuses the configuration (testparm exit code %d)", r);
		}
		if (ret == 0 && tool_exists("smbcontrol")) {
			const char* args[] = { "smbd", "reload-config", 0 };
			tool_run("smbcontrol", args, 0, 0, 30);
		}
	} else if (smb_count > 0) {
		ret = hfail(msg, msg_size, 501, "Samba is not installed: the shares are saved, and will work once it is (package samba)");
	}

	/* NFS */
	if (access("/etc/exports.d", F_OK) == 0 || nfs_count > 0) {
		make_dirs("/etc/exports.d");
		if (file_replace(NFS_EXPORTS, ss_ptr(&nfs), 0, 0644) != 0 && ret == 0)
			ret = hfail(msg, msg_size, 500, "Cannot write %s", NFS_EXPORTS);
		if (tool_exists("exportfs")) {
			const char* args[] = { "-ra", 0 };
			ss_t out;
			ss_init(&out, 1024);
			int r = tool_run("exportfs", args, 0, &out, 60);
			if (r != 0 && ret == 0 && nfs_count > 0)
				ret = hfail(msg, msg_size, 500, "NFS refuses the exports (exportfs exit code %d)", r);
			ss_done(&out);
		} else if (nfs_count > 0 && ret == 0) {
			ret = hfail(msg, msg_size, 501, "The NFS server is not installed: the shares are saved, and will work once it is (package nfs-kernel-server)");
		}
	}

	ss_done(&smb);
	ss_done(&nfs);
	return ret;
}

/** Users of the SMB shares: a system user without login, and its Samba password. */
static int smb_user_set(const char* user, const char* password, char* msg, size_t msg_size)
{
	if (!valid_name(user) || isdigit((unsigned char)user[0]))
		return hfail(msg, msg_size, 400, "A user name has only letters, digits, - and _ and starts with a letter");
	if (strlen(password) < 4 || strlen(password) > 128 || strchr(password, '\n'))
		return hfail(msg, msg_size, 400, "The password has from 4 to 128 characters");
	if (!tool_exists("smbpasswd"))
		return hfail(msg, msg_size, 501, "Samba is not installed (package samba)");

	group_users_ensure();
	if (getpwnam(user) == 0) {
		const char* args[] = { "--system", "--no-create-home", "--shell", "/usr/sbin/nologin", "--gid", "users", user, 0 };
		if (tool_check("useradd", args, 0, 30, msg, msg_size) != 0)
			return 500;
	}

	char input[300];
	snprintf(input, sizeof(input), "%s\n%s\n", password, password);
	const char* args[] = { "-a", "-s", user, 0 };
	if (tool_check("smbpasswd", args, input, 30, msg, msg_size) != 0)
		return 500;
	const char* en[] = { "-e", user, 0 };
	tool_run("smbpasswd", en, 0, 0, 30);

	log_msg(LVL_INFO, "host: share user %s set", user);
	return 0;
}

static int smb_user_delete(const char* user, char* msg, size_t msg_size)
{
	if (!valid_name(user))
		return hfail(msg, msg_size, 400, "Invalid user name");
	const char* args[] = { "-x", user, 0 };
	if (tool_check("smbpasswd", args, 0, 30, msg, msg_size) != 0)
		return 500;
	log_msg(LVL_INFO, "host: share user %s removed", user);
	return 0;
}

static void smb_users_json(ss_t* s, int level)
{
	ss_t out;

	ss_json_array_open(s, &level, "share_users");
	ss_init(&out, 1024);
	const char* args[] = { "-L", 0 };
	if (tool_exists("pdbedit") && tool_run("pdbedit", args, 0, &out, 30) == 0) {
		ss_write(&out, "", 1);
		char* save = 0;
		for (char* line = strtok_r(ss_ptr(&out), "\n", &save); line; line = strtok_r(0, "\n", &save)) {
			char* colon = strchr(line, ':');
			if (!colon)
				continue;
			*colon = 0;
			if (valid_name(line))
				ss_json_elem(s, level, line);
		}
	}
	ss_done(&out);
	ss_json_array_close(s, &level);
}

/** Delete what is in the recycle bins of the shares since more than the set days. */
static void recycle_clean(void)
{
	char paths[64][PATH_MAX];
	int days[64];
	unsigned n = 0;

	pthread_mutex_lock(&host_mutex);
	for (unsigned i = 0; i < kv_count && n < 64; ++i) {
		if (strncmp(kv_list[i].key, "share.", 6) != 0 || !opt_bool(kv_list[i].val, "recycle", 0))
			continue;
		char buf[16];
		opt_get(kv_list[i].val, "path", paths[n], sizeof(paths[n]));
		days[n] = opt_get(kv_list[i].val, "recycle_days", buf, sizeof(buf)) == 0 ? atoi(buf) : 30;
		++n;
	}
	pthread_mutex_unlock(&host_mutex);

	for (unsigned i = 0; i < n; ++i) {
		char dir[PATH_MAX + 16];
		char age[32];
		if (days[i] <= 0)
			continue;
		snprintf(dir, sizeof(dir), "%s/" RECYCLE_DIR, paths[i]);
		if (access(dir, F_OK) != 0)
			continue;
		snprintf(age, sizeof(age), "+%d", days[i] - 1);
		const char* files[] = { dir, "-mindepth", "1", "-type", "f", "-mtime", age, "-delete", 0 };
		tool_run("find", files, 0, 0, 3600);
		const char* dirs[] = { dir, "-mindepth", "1", "-type", "d", "-empty", "-delete", 0 };
		tool_run("find", dirs, 0, 0, 3600);
	}
}

/****************************************************************************/
/* backups */

static int remote_of_path(const char* path, char* name, size_t name_size);
static int remote_mount(const char* name, char* msg, size_t msg_size);
static void remote_unmount(const char* name);

struct backup_seen {
	char name[64];
	int known; /**< The destination was looked at once at least */
	int present; /**< The destination disk was there at the latest look */
	int pending; /**< A run is due but the job slot was busy */
	char mounted_by_us[PATH_MAX]; /**< Mount made for the run, removed after it */
	char remote_by_us[64]; /**< Folder of another computer mounted for the run */
};

#define BACKUPS_MAX 64

static struct backup_seen backup_seen[BACKUPS_MAX];
static unsigned backup_seen_count;

static struct backup_seen* backup_slot(const char* name)
{
	for (unsigned i = 0; i < backup_seen_count; ++i) {
		if (strcmp(backup_seen[i].name, name) == 0)
			return &backup_seen[i];
	}
	if (backup_seen_count == BACKUPS_MAX)
		return 0;
	struct backup_seen* b = &backup_seen[backup_seen_count++];
	memset(b, 0, sizeof(*b));
	sncpy(b->name, sizeof(b->name), name);
	return b;
}

/** Where a filesystem is mounted, given its UUID. */
static int uuid_mount(const char* uuid, char* target, size_t target_size)
{
	char dev[PATH_MAX];
	char real[PATH_MAX];
	ss_t s;
	struct mount_entry entry;
	int r;
	int ret = -1;

	snprintf(dev, sizeof(dev), "/dev/disk/by-uuid/%s", uuid);
	if (realpath(dev, real) == 0)
		return -2; /* not plugged */

	ss_init(&s, 4096);
	if (file_read("/proc/self/mounts", &s) == 0) {
		const char* cursor = ss_ptr(&s);
		while ((r = mount_next(&cursor, &entry, 0, 0)) >= 0) {
			char src[PATH_MAX];
			if (r != 1 || strncmp(entry.source, "/dev/", 5) != 0)
				continue;
			if (realpath(entry.source, src) != 0 && strcmp(src, real) == 0) {
				sncpy(target, target_size, entry.target);
				ret = 0;
				break;
			}
		}
	}
	ss_done(&s);

	return ret;
}

static void backup_record(const char* name, int status, const char* message)
{
	char key[128];
	char val[MSG_MAX + 64];

	snprintf(key, sizeof(key), "last.backup.%s", name);
	snprintf(val, sizeof(val), "%" PRIi64 "\t%d\t%s", (int64_t)time(0), status, message);
	for (char* c = val; *c; ++c)
		if (*c == '\n')
			*c = ' ';

	pthread_mutex_lock(&host_mutex);
	kv_set_locked(key, val);
	kv_save_locked();
	pthread_mutex_unlock(&host_mutex);

	/* a disk mounted only for the run is unmounted, so it can be unplugged */
	struct backup_seen* b = backup_slot(name);
	if (b && b->mounted_by_us[0]) {
		sync();
		const char* args[] = { b->mounted_by_us, 0 };
		if (tool_run("umount", args, 0, 0, 120) == 0) {
			log_msg(LVL_INFO, "host: backup %s done, %s unmounted: the disk can be unplugged", name, b->mounted_by_us);
			dir_remove(b->mounted_by_us);
		}
		b->mounted_by_us[0] = 0;
	}

	if (b && b->remote_by_us[0]) {
		remote_unmount(b->remote_by_us);
		b->remote_by_us[0] = 0;
	}

	log_msg(status == 0 || status == 207 ? LVL_INFO : LVL_WARNING, "host: backup %s ended: %s", name, message);
}

/** Start a backup now. */
static int backup_run(const char* name, char* msg, size_t msg_size)
{
	char key[128];
	char line[2048];
	char src[PATH_MAX];
	char uuid[64];
	char dir[PATH_MAX];
	char dest[PATH_MAX * 2];
	char path[PATH_MAX];

	snprintf(key, sizeof(key), "backup.%s", name);
	kv_get(key, "", line, sizeof(line));
	if (line[0] == 0)
		return hfail(msg, msg_size, 404, "There is no backup named %s", name);

	opt_get(line, "source", src, sizeof(src));
	opt_get(line, "dest_dir", dir, sizeof(dir));
	struct backup_seen* b = backup_slot(name);

	/* files of another computer: reach it for the time of the run */
	char remote[64];
	int remote_new = 0;
	if (remote_of_path(src, remote, sizeof(remote)) == 0) {
		if (job_is_running())
			return hfail(msg, msg_size, 409, "Another storage operation is still running. Wait for it to finish, or stop it.");
		int r = remote_mount(remote, msg, msg_size);
		if (r != 0 && r != 1) {
			if (r >= 500) {
				char why[MSG_MAX];
				sncpy(why, sizeof(why), msg);
				backup_record(name, r, why);
			}
			return r;
		}
		remote_new = r == 0;
	}

	if (opt_get(line, "dest_path", path, sizeof(path)) == 0) {
		sncpy(dest, sizeof(dest), path);
	} else {
		char target[PATH_MAX];
		opt_get(line, "dest_uuid", uuid, sizeof(uuid));
		int r = uuid_mount(uuid, target, sizeof(target));
		if (r == -2) {
			if (remote_new)
				remote_unmount(remote);
			return hfail(msg, msg_size, 409, "The backup disk of %s is not plugged in", name);
		}
		if (r != 0) {
			/* plugged but not mounted: mount it for the run */
			char source[128];
			snprintf(target, sizeof(target), "/mnt/backup-%s", name);
			snprintf(source, sizeof(source), "UUID=%s", uuid);
			make_dirs(target);
			const char* args[] = { source, target, 0 };
			if (tool_check("mount", args, 0, 120, msg, msg_size) != 0) {
				if (remote_new)
					remote_unmount(remote);
				return 500;
			}
			if (b)
				sncpy(b->mounted_by_us, sizeof(b->mounted_by_us), target);
		}
		snprintf(dest, sizeof(dest), "%s%s%s", target, dir[0] && dir[0] != '/' ? "/" : "", dir);
	}

	int ret = copy_start("backup", src, dest, opt_bool(line, "mirror", 0), name, msg, msg_size);
	if (ret != 0 && b && b->mounted_by_us[0]) {
		const char* args[] = { b->mounted_by_us, 0 };
		tool_run("umount", args, 0, 0, 120);
		b->mounted_by_us[0] = 0;
	}
	if (remote_new) {
		if (ret != 0)
			remote_unmount(remote);
		else if (b)
			sncpy(b->remote_by_us, sizeof(b->remote_by_us), remote);
	}
	if (b)
		b->pending = ret == 409;

	return ret;
}

/** Once a minute: backups on a schedule, and the ones of a disk just plugged in. */
static void backups_tick(const struct tm* tm, int first)
{
	char names[BACKUPS_MAX][64];
	char lines[BACKUPS_MAX][1024];
	unsigned n = 0;

	pthread_mutex_lock(&host_mutex);
	for (unsigned i = 0; i < kv_count && n < BACKUPS_MAX; ++i) {
		if (strncmp(kv_list[i].key, "backup.", 7) != 0)
			continue;
		sncpy(names[n], sizeof(names[n]), kv_list[i].key + 7);
		sncpy(lines[n], sizeof(lines[n]), kv_list[i].val);
		++n;
	}
	pthread_mutex_unlock(&host_mutex);

	for (unsigned i = 0; i < n; ++i) {
		char when[256];
		char uuid[64];
		char msg[MSG_MAX];
		struct backup_seen* b = backup_slot(names[i]);
		if (!b || !opt_bool(lines[i], "enabled", 1))
			continue;

		int due = b->pending;
		if (opt_get(lines[i], "when", when, sizeof(when)) == 0 && when[0] && sched_match(when, tm))
			due = 1;

		if (opt_get(lines[i], "dest_uuid", uuid, sizeof(uuid)) == 0) {
			char dev[PATH_MAX];
			snprintf(dev, sizeof(dev), "/dev/disk/by-uuid/%s", uuid);
			int present = access(dev, F_OK) == 0;
			if (present && b->known && !b->present && !first && opt_bool(lines[i], "plug", 0)) {
				log_msg(LVL_INFO, "host: the disk of the backup %s was plugged in", names[i]);
				due = 1;
			}
			b->present = present;
			b->known = 1;
			if (!present)
				due = 0;
		}

		if (due && !job_is_running())
			backup_run(names[i], msg, sizeof(msg));
		else if (due)
			b->pending = 1;
	}
}

/****************************************************************************/
/* fast disks in front of a pool, and their mover */

struct cache_seen {
	char name[64];
	int pending; /**< A run is due but the job slot was busy */
	time_t last_fill_run; /**< Latest run started because the disk was filling up */
};

#define CACHES_MAX 16

static struct cache_seen cache_seen[CACHES_MAX];
static unsigned cache_seen_count;

static struct cache_seen* cache_slot(const char* name)
{
	for (unsigned i = 0; i < cache_seen_count; ++i) {
		if (strcmp(cache_seen[i].name, name) == 0)
			return &cache_seen[i];
	}
	if (cache_seen_count == CACHES_MAX)
		return 0;
	struct cache_seen* c = &cache_seen[cache_seen_count++];
	memset(c, 0, sizeof(*c));
	sncpy(c->name, sizeof(c->name), name);
	return c;
}

void host_move_done(const char* tag, int status, const char* message)
{
	char key[128];
	char val[MSG_MAX + 64];

	if (strncmp(tag, "cache.", 6) != 0 && strncmp(tag, "keep.", 5) != 0)
		return;

	snprintf(key, sizeof(key), "last.%s", tag);
	snprintf(val, sizeof(val), "%" PRIi64 "\t%d\t%s", (int64_t)time(0), status, message);

	pthread_mutex_lock(&host_mutex);
	kv_set_locked(key, val);
	kv_save_locked();
	pthread_mutex_unlock(&host_mutex);
}

#define CACHE_COUNT_MAX 2000 /**< Files of a fast disk counted for the status, not to walk a full disk at every request */

struct cache_count {
	unsigned files;
	uint64_t bytes;
};

/** Count the files waiting on a fast disk, up to CACHE_COUNT_MAX. */
static void cache_count_dir(const char* dir, unsigned depth, struct cache_count* count)
{
	if (depth > 32 || count->files >= CACHE_COUNT_MAX)
		return;

	DIR* d = opendir(dir);
	if (!d)
		return;

	struct dirent* dd;
	while (count->files < CACHE_COUNT_MAX && (dd = readdir(d)) != 0) {
		char path[PATH_MAX];
		struct stat st;

		/* the same files the mover leaves */
		if (walk_skip(dd->d_name, depth == 0))
			continue;
		if (snprintf(path, sizeof(path), "%s/%s", dir, dd->d_name) >= (int)sizeof(path))
			continue;
		if (lstat(path, &st) != 0)
			continue;
		if (S_ISDIR(st.st_mode)) {
			cache_count_dir(path, depth + 1, count);
		} else {
			++count->files;
			count->bytes += (uint64_t)st.st_blocks * 512;
		}
	}
	closedir(d);
}

/** How full a filesystem is, in percent. -1 if not known. */
static int fill_percent(const char* path)
{
	struct statvfs vfs;

	if (statvfs(path, &vfs) != 0 || vfs.f_blocks == 0)
		return -1;

	return (int)(100 - (uint64_t)vfs.f_bavail * 100 / vfs.f_blocks);
}

/**
 * Move the files of a fast disk to the other disks of its pool.
 * \param all Also the files newer than the age set, because the disk is filling up or it was asked now.
 */
static int cache_run(const char* name, int all, char* msg, size_t msg_size)
{
	char key[128];
	char line[2048];
	char pool[PATH_MAX];
	char branch[PATH_MAX];
	char age[16];

	snprintf(key, sizeof(key), "cache.%s", name);
	kv_get(key, "", line, sizeof(line));
	if (line[0] == 0)
		return hfail(msg, msg_size, 404, "There is no fast disk named %s", name);

	opt_get(line, "pool", pool, sizeof(pool));
	opt_get(line, "branch", branch, sizeof(branch));
	unsigned minutes = 5; /* a file being written is never taken */
	if (!all && opt_get(line, "age_hours", age, sizeof(age)) == 0 && atoi(age) > 0)
		minutes = atoi(age) * 60;

	int ret = storage_move_start("mover", pool, branch, "", "", minutes, opt_bool(line, "sync", 1), key, msg, msg_size);

	struct cache_seen* c = cache_slot(name);
	if (c)
		c->pending = ret == 409;

	return ret;
}

/** Once a minute: the movers on a schedule, and the ones of a fast disk filling up. */
static void caches_tick(const struct tm* tm)
{
	char names[CACHES_MAX][64];
	char lines[CACHES_MAX][1024];
	unsigned n = 0;

	pthread_mutex_lock(&host_mutex);
	for (unsigned i = 0; i < kv_count && n < CACHES_MAX; ++i) {
		if (strncmp(kv_list[i].key, "cache.", 6) != 0)
			continue;
		sncpy(names[n], sizeof(names[n]), kv_list[i].key + 6);
		sncpy(lines[n], sizeof(lines[n]), kv_list[i].val);
		++n;
	}
	pthread_mutex_unlock(&host_mutex);

	for (unsigned i = 0; i < n; ++i) {
		char when[256];
		char fill[16];
		char branch[PATH_MAX];
		char msg[MSG_MAX];
		struct cache_seen* c = cache_slot(names[i]);
		if (!c || !opt_bool(lines[i], "enabled", 1))
			continue;

		int due = c->pending;
		int all = 0;
		if (opt_get(lines[i], "when", when, sizeof(when)) == 0 && when[0] && sched_match(when, tm))
			due = 1;

		/* a fast disk that fills up sends the new files to the slow ones: empty it before */
		time_t now = time(0);
		if (opt_get(lines[i], "fill", fill, sizeof(fill)) == 0 && atoi(fill) > 0
			&& opt_get(lines[i], "branch", branch, sizeof(branch)) == 0
			&& fill_percent(branch) >= atoi(fill) && now - c->last_fill_run >= 30 * 60) {
			due = 1;
			all = 1;
		}

		if (!due)
			continue;
		if (job_is_running()) {
			c->pending = 1;
			continue;
		}
		if (all) {
			c->last_fill_run = now;
			log_msg(LVL_INFO, "host: the fast disk %s is %d%% full, moving its files now", names[i], fill_percent(branch));
		}
		cache_run(names[i], all, msg, sizeof(msg));
	}
}

/** Check a fast disk before it's saved: a branch of the pool that no array protects. */
static int cache_check(const char* pool, const char* branch, char* msg, size_t msg_size)
{
	struct pool_branch* branches = malloc_nofail(sizeof(struct pool_branch) * BRANCH_MAX);
	unsigned count = 0;
	int ret;

	priv_enter();
	ret = pool_branches(pool, branches, &count, msg, msg_size);
	priv_leave();
	if (ret == 0) {
		int found = 0;
		for (unsigned i = 0; i < count; ++i) {
			if (strcmp(branches[i].path, branch) == 0)
				found = 1;
		}
		if (!found)
			ret = hfail(msg, msg_size, 400, "%s is not a disk of the pool %s", branch, pool);
		else if (count < 2)
			ret = hfail(msg, msg_size, 400, "The pool %s has no other disk to move the files to", pool);
	}
	free(branches);
	if (ret != 0)
		return ret;

	struct host_disk* disks = malloc_nofail(sizeof(struct host_disk) * HOST_DISKS_MAX);
	unsigned n = host_disks(disks, HOST_DISKS_MAX);
	for (unsigned i = 0; i < n && ret == 0; ++i) {
		if (disks[i].mount[0] && (path_inside(branch, disks[i].mount) || path_inside(disks[i].mount, branch)))
			ret = hfail(msg, msg_size, 409, "%s is the disk %s of the array %s: its files are already where they have to be", branch, disks[i].name, disks[i].array);
	}
	free(disks);

	return ret;
}

/****************************************************************************/
/* folders kept on chosen disks of a pool */

/** If a path is a folder at or above a file: "/a/b" for "/a/b/c.txt". */
static int folder_holds(const char* folder, const char* rel)
{
	size_t len = strlen(folder);

	return strncmp(rel, folder, len) == 0 && rel[len] == '/';
}

int host_move_stays(const char* tag, const char* rel)
{
	char line[2048];
	char stay[1024];
	char* save = 0;

	if (strncmp(tag, "cache.", 6) != 0)
		return 0;
	kv_get(tag, "", line, sizeof(line));
	if (opt_get(line, "stay", stay, sizeof(stay)) != 0)
		return 0;
	for (char* tok = strtok_r(stay, ":", &save); tok; tok = strtok_r(0, ":", &save)) {
		if (folder_holds(tok, rel))
			return 1;
	}

	return 0;
}

int host_keep_disks(const char* pool, const char* rel, char* disks, size_t disks_size)
{
	size_t best = 0;

	disks[0] = 0;

	pthread_mutex_lock(&host_mutex);
	for (unsigned i = 0; i < kv_count; ++i) {
		char v[PATH_MAX];
		if (strncmp(kv_list[i].key, "keep.", 5) != 0 || !opt_bool(kv_list[i].val, "enabled", 1))
			continue;
		if (opt_get(kv_list[i].val, "pool", v, sizeof(v)) != 0 || strcmp(v, pool) != 0)
			continue;
		/* the deepest folder decides */
		if (opt_get(kv_list[i].val, "path", v, sizeof(v)) != 0 || !folder_holds(v, rel) || strlen(v) <= best)
			continue;
		best = strlen(v);
		opt_get(kv_list[i].val, "disks", disks, disks_size);
	}
	pthread_mutex_unlock(&host_mutex);

	return disks[0] != 0;
}

/**
 * The disks of the pool, not chosen for the folder, that hold a part of it.
 * \param from Their paths separated by ':'.
 * \return How many they are, or -1 if the pool or one of the chosen disks is not there.
 */
static int keep_strays(const char* line, char* from, size_t from_size, char* msg, size_t msg_size)
{
	char pool[PATH_MAX];
	char path[PATH_MAX];
	char disks[1024];
	char list[1024];
	char* save = 0;
	unsigned count = 0;
	int strays = 0;
	struct pool_branch* branches = malloc_nofail(sizeof(struct pool_branch) * BRANCH_MAX);

	from[0] = 0;
	opt_get(line, "pool", pool, sizeof(pool));
	opt_get(line, "path", path, sizeof(path));
	opt_get(line, "disks", disks, sizeof(disks));

	priv_enter();
	int ret = pool_branches(pool, branches, &count, msg, msg_size);
	priv_leave();
	if (ret != 0) {
		free(branches);
		return -1;
	}

	/* every chosen disk is still a writable disk of the pool */
	sncpy(list, sizeof(list), disks);
	for (char* tok = strtok_r(list, ":", &save); tok; tok = strtok_r(0, ":", &save)) {
		int found = 0;
		for (unsigned i = 0; i < count; ++i) {
			if (strcmp(branches[i].path, tok) == 0 && branches[i].writable)
				found = 1;
		}
		if (!found) {
			hfail(msg, msg_size, 400, "%s is not a disk of the pool %s that can be written", tok, pool);
			free(branches);
			return -1;
		}
	}

	char chosen[sizeof(disks) + 4];
	snprintf(chosen, sizeof(chosen), ":%s:", disks);
	for (unsigned i = 0; i < count; ++i) {
		char dir[PATH_MAX * 2];
		char key[PATH_MAX + 4];
		struct stat st;
		snprintf(key, sizeof(key), ":%s:", branches[i].path);
		if (strstr(chosen, key) != 0)
			continue;
		snprintf(dir, sizeof(dir), "%s%s", branches[i].path, path);
		priv_enter();
		int have = lstat(dir, &st) == 0 && S_ISDIR(st.st_mode);
		priv_leave();
		if (!have)
			continue;
		if (from[0])
			sncat(from, from_size, ":");
		sncat(from, from_size, branches[i].path);
		++strays;
	}
	free(branches);

	return strays;
}

/** Bring back to its disks what of a folder landed on the other ones. */
static int keep_run(const char* name, char* msg, size_t msg_size)
{
	char key[128];
	char line[2048];
	char pool[PATH_MAX];
	char path[PATH_MAX];
	char disks[1024];
	char from[PATH_MAX];

	snprintf(key, sizeof(key), "keep.%s", name);
	kv_get(key, "", line, sizeof(line));
	if (line[0] == 0)
		return hfail(msg, msg_size, 404, "There is no folder kept with the name %s", name);

	int strays = keep_strays(line, from, sizeof(from), msg, msg_size);
	if (strays < 0)
		return 400;
	if (strays == 0)
		return hfail(msg, msg_size, 409, "Everything of this folder is already on its disks");

	opt_get(line, "pool", pool, sizeof(pool));
	opt_get(line, "path", path, sizeof(path));
	opt_get(line, "disks", disks, sizeof(disks));

	int ret = storage_move_start("keep", pool, from, path, disks, 0, 0, key, msg, msg_size);

	char slot[64];
	snprintf(slot, sizeof(slot), "k/%s", name);
	struct cache_seen* c = cache_slot(slot);
	if (c)
		c->pending = ret == 409;

	return ret;
}

/** Once a minute: the folders to bring back to their disks at this time. */
static void keeps_tick(const struct tm* tm)
{
	char names[CACHES_MAX][40];
	char lines[CACHES_MAX][1024];
	unsigned n = 0;

	pthread_mutex_lock(&host_mutex);
	for (unsigned i = 0; i < kv_count && n < CACHES_MAX; ++i) {
		if (strncmp(kv_list[i].key, "keep.", 5) != 0)
			continue;
		sncpy(names[n], sizeof(names[n]), kv_list[i].key + 5);
		sncpy(lines[n], sizeof(lines[n]), kv_list[i].val);
		++n;
	}
	pthread_mutex_unlock(&host_mutex);

	for (unsigned i = 0; i < n; ++i) {
		char when[256];
		char slot[64];
		char msg[MSG_MAX];
		sncpy(slot, sizeof(slot), "k/");
		sncat(slot, sizeof(slot), names[i]);
		struct cache_seen* c = cache_slot(slot);
		if (!c || !opt_bool(lines[i], "enabled", 1))
			continue;

		int due = c->pending;
		if (opt_get(lines[i], "when", when, sizeof(when)) == 0 && when[0] && sched_match(when, tm))
			due = 1;
		if (!due)
			continue;
		if (job_is_running()) {
			c->pending = 1;
			continue;
		}
		c->pending = 0;
		keep_run(names[i], msg, sizeof(msg));
	}
}

/****************************************************************************/
/* a sync stopped by the limit of deleted files, when a lot more were added */

#define RATIO_SEEN_MAX 64

/**
 * A big tidy up deletes many files and adds many more. With the setting
 * 'sync_ratio', a maintenance sync stopped only by the limit of the deleted
 * files is run again without the limit, when the files added are at least
 * that many times the deleted ones.
 */
static void ratio_tick(void)
{
	static struct {
		struct snapraid_state* state;
		int number;
	} seen[RATIO_SEEN_MAX];
	static unsigned seen_count;
	struct snapraid_state* go[RATIO_SEEN_MAX];
	int64_t go_added[RATIO_SEEN_MAX];
	int64_t go_removed[RATIO_SEEN_MAX];
	unsigned n = 0;

	int ratio = kv_int("sync_ratio", 0);
	if (ratio <= 0)
		return;

	state_lock();
	for (tommy_node* i = tommy_list_head(&host_ptr()->state_list); i && n < RATIO_SEEN_MAX; i = i->next) {
		struct snapraid_state* state = i->data;
		struct snapraid_task* task = 0;

		/* only once the whole maintenance is over */
		if ((state->runner.latest && state->runner.latest->running) || !tommy_list_empty(&state->runner.waiting_list))
			continue;

		/* its sync is followed by other tasks: take the newest one of the history */
		for (tommy_node* j = tommy_list_head(&state->runner.history_list); j; j = j->next) {
			struct snapraid_task* t = j->data;
			if (t->cmd == CMD_SYNC && (task == 0 || t->number > task->number))
				task = t;
		}
		if (!task || task->high_cmd != CMD_MAINTENANCE || task->state != PROCESS_STATE_TERM || task->exit_code == 0)
			continue;

		/* every task is looked at once */
		unsigned k;
		for (k = 0; k < seen_count; ++k) {
			if (seen[k].state == state)
				break;
		}
		if (k == seen_count) {
			if (seen_count == RATIO_SEEN_MAX)
				continue;
			seen[seen_count++].state = state;
			seen[k].number = -1;
		}
		if (seen[k].number == task->number)
			continue;
		seen[k].number = task->number;

		int by_removes = 0;
		int by_updates = 0;
		for (tommy_node* j = tommy_list_head(&task->message_list); j; j = j->next) {
			struct snapraid_message* m = j->data;
			if (strstr(m->msg, "Too many files were removed") != 0)
				by_removes = 1;
			if (strstr(m->msg, "Too many files were updated") != 0)
				by_updates = 1;
		}
		if (!by_removes || by_updates)
			continue;
		if (task->diff_removed <= 0 || task->diff_added < task->diff_removed * ratio)
			continue;

		go[n] = state;
		go_added[n] = task->diff_added;
		go_removed[n] = task->diff_removed;
		++n;
	}
	state_unlock();

	for (unsigned k = 0; k < n; ++k) {
		char msg[MSG_MAX];
		int status;
		log_msg(LVL_WARNING, "host: the sync of the array %s stopped for %" PRIi64 " deleted files, but %" PRIi64 " were added, at least %d times as many: running it again without the limit", go[k]->name, go_removed[k], go_added[k], ratio);
		schedule_maintenance(go[k], 1, 0, msg, sizeof(msg), &status);
	}
}

/****************************************************************************/
/* folder listings in memory */

static unsigned long dircache_walk(int dir_fd, unsigned depth, unsigned long budget)
{
	unsigned long count = 0;
	DIR* d = fdopendir(dir_fd);
	if (!d) {
		close(dir_fd);
		return 0;
	}

	struct dirent* dd;
	while ((dd = readdir(d)) != 0 && count < budget) {
		struct stat st;
		if (strcmp(dd->d_name, ".") == 0 || strcmp(dd->d_name, "..") == 0)
			continue;
		++count;
		if (fstatat(dirfd(d), dd->d_name, &st, AT_SYMLINK_NOFOLLOW) != 0)
			continue;
		if (S_ISDIR(st.st_mode) && depth < 32) {
			int sub = openat(dirfd(d), dd->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
			if (sub >= 0)
				count += dircache_walk(sub, depth + 1, budget - count);
		}
	}
	closedir(d);

	return count;
}

static int dircache_pressure_set; /**< We changed vfs_cache_pressure */

static void dircache_pressure(int on)
{
	const char* value = on ? "10\n" : "100\n";

	if (!on && !dircache_pressure_set)
		return;

	priv_enter();
	int f = open("/proc/sys/vm/vfs_cache_pressure", O_WRONLY | O_CLOEXEC);
	if (f >= 0) {
		if (write(f, value, strlen(value)) > 0)
			dircache_pressure_set = on;
		close(f);
	}
	priv_leave();
}

static time_t dircache_last;
static unsigned long dircache_entries;

/** Read the folders of the data disks that are spinning, so their listings stay in memory. */
static void dircache_tick(void)
{
	if (!kv_int("dircache", 0)) {
		dircache_pressure(0);
		return;
	}

	time_t now = time(0);
	if (now - dircache_last < kv_int("dircache_minutes", 10) * 60)
		return;
	dircache_last = now;
	dircache_pressure(1);

	struct host_disk* disks = malloc_nofail(sizeof(struct host_disk) * HOST_DISKS_MAX);
	unsigned count = host_disks(disks, HOST_DISKS_MAX);
	unsigned long total = 0;

	priv_enter();
	for (unsigned i = 0; i < count; ++i) {
		/* a disk in standby is never woken: its listings were kept while it was spinning */
		if (disks[i].parity || disks[i].mount[0] == 0 || disks[i].standby)
			continue;
		int fd = open(disks[i].mount, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
		if (fd >= 0)
			total += dircache_walk(fd, 0, DIRCACHE_ENTRIES_MAX);
	}
	priv_leave();
	free(disks);

	dircache_entries = total;
}

/****************************************************************************/
/* read and write history of the disks */

struct io_history {
	char name[32]; /**< sda */
	uint64_t last_read; /**< sectors */
	uint64_t last_write;
	uint32_t read_kb[HISTORY_SAMPLES];
	uint32_t write_kb[HISTORY_SAMPLES];
};

static struct io_history io_list[HISTORY_DEVICES];
static unsigned io_count;
static time_t io_time[HISTORY_SAMPLES];
static unsigned io_pos; /**< Next sample to write */
static unsigned io_samples;
static time_t io_last;

/** Read the counters of /proc/diskstats for a device. */
static int diskstats_get(const char* text, const char* name, uint64_t* rd, uint64_t* wr)
{
	const char* p = text;

	while (*p) {
		unsigned major, minor;
		char dev[64];
		unsigned long long r_ios, r_merge, r_sect, r_ms, w_ios, w_merge, w_sect;
		if (sscanf(p, "%u %u %63s %llu %llu %llu %llu %llu %llu %llu", &major, &minor, dev, &r_ios, &r_merge, &r_sect, &r_ms, &w_ios, &w_merge, &w_sect) == 10
			&& strcmp(dev, name) == 0) {
			*rd = r_sect;
			*wr = w_sect;
			return 0;
		}
		p = strchr(p, '\n');
		if (!p)
			break;
		++p;
	}

	return -1;
}

static void history_tick(void)
{
	time_t now = time(0);
	if (io_last != 0 && now - io_last < 300)
		return;
	int first = io_last == 0;
	io_last = now;

	ss_t s;
	ss_init(&s, 8192);
	if (file_read("/proc/diskstats", &s) != 0) {
		ss_done(&s);
		return;
	}

	struct host_disk* disks = malloc_nofail(sizeof(struct host_disk) * HOST_DISKS_MAX);
	unsigned count = host_disks(disks, HOST_DISKS_MAX);

	pthread_mutex_lock(&host_mutex);
	for (unsigned i = 0; i < count; ++i) {
		char name[64];
		if (!disks[i].device[0] || device_base(disks[i].device, name, sizeof(name)) != 0)
			continue;
		struct io_history* h = 0;
		for (unsigned j = 0; j < io_count; ++j) {
			if (strcmp(io_list[j].name, name) == 0)
				h = &io_list[j];
		}
		if (!h) {
			if (io_count == HISTORY_DEVICES)
				continue;
			h = &io_list[io_count++];
			memset(h, 0, sizeof(*h));
			sncpy(h->name, sizeof(h->name), name);
			h->last_read = h->last_write = UINT64_MAX;
		}
		uint64_t rd, wr;
		if (diskstats_get(ss_ptr(&s), name, &rd, &wr) != 0)
			continue;
		if (!first && h->last_read != UINT64_MAX && rd >= h->last_read && wr >= h->last_write) {
			h->read_kb[io_pos] = (uint32_t)((rd - h->last_read) / 2);
			h->write_kb[io_pos] = (uint32_t)((wr - h->last_write) / 2);
		}
		h->last_read = rd;
		h->last_write = wr;
	}
	if (!first) {
		io_time[io_pos] = now;
		io_pos = (io_pos + 1) % HISTORY_SAMPLES;
		if (io_samples < HISTORY_SAMPLES)
			++io_samples;
		/* clear the slot for the next round, a device missing then stays at zero */
		for (unsigned j = 0; j < io_count; ++j)
			io_list[j].read_kb[io_pos] = io_list[j].write_kb[io_pos] = 0;
	}
	pthread_mutex_unlock(&host_mutex);

	free(disks);
	ss_done(&s);
}

static void history_json(ss_t* s, int level)
{
	pthread_mutex_lock(&host_mutex);
	ss_json_uint(s, level, "interval_seconds", 300);
	ss_json_array_open(s, &level, "times");
	for (unsigned k = 0; k < io_samples; ++k) {
		unsigned idx = (io_pos + HISTORY_SAMPLES - io_samples + k) % HISTORY_SAMPLES;
		ss_jsonf(s, level, "%" PRIi64 ",\n", (int64_t)io_time[idx]);
	}
	ss_json_array_close(s, &level);
	ss_json_array_open(s, &level, "devices");
	for (unsigned j = 0; j < io_count; ++j) {
		ss_json_open(s, &level);
		ss_json_str(s, level, "device", io_list[j].name);
		for (int w = 0; w < 2; ++w) {
			ss_json_array_open(s, &level, w ? "write_kb" : "read_kb");
			for (unsigned k = 0; k < io_samples; ++k) {
				unsigned idx = (io_pos + HISTORY_SAMPLES - io_samples + k) % HISTORY_SAMPLES;
				ss_jsonf(s, level, "%u,\n", w ? io_list[j].write_kb[idx] : io_list[j].read_kb[idx]);
			}
			ss_json_array_close(s, &level);
		}
		ss_json_close(s, &level);
	}
	ss_json_array_close(s, &level);
	pthread_mutex_unlock(&host_mutex);
}

/****************************************************************************/
/* idle machine: suspend or power off, Wake-on-LAN */

static time_t idle_since;
static char idle_busy[160] = "starting";
static uint64_t net_last_bytes;
static time_t net_last_time;
static ss_t idle_last_stats;
static int idle_stats_valid;

/** Count the established TCP connections on one of the ports. */
static unsigned tcp_established(const unsigned* ports)
{
	static const char* tables[] = { "/proc/net/tcp", "/proc/net/tcp6", 0 };
	unsigned count = 0;

	for (unsigned t = 0; tables[t]; ++t) {
		ss_t s;
		ss_init(&s, 4096);
		if (file_read(tables[t], &s) == 0) {
			char* save = 0;
			for (char* line = strtok_r(ss_ptr(&s), "\n", &save); line; line = strtok_r(0, "\n", &save)) {
				char local[128], remote[128];
				unsigned st;
				if (sscanf(line, " %*d: %127s %127s %x", local, remote, &st) != 3 || st != 1)
					continue;
				char* colon = strrchr(local, ':');
				if (!colon)
					continue;
				unsigned port = (unsigned)strtoul(colon + 1, 0, 16);
				for (unsigned i = 0; ports[i]; ++i) {
					if (port == ports[i])
						++count;
				}
			}
		}
		ss_done(&s);
	}

	return count;
}

static uint64_t net_bytes(void)
{
	ss_t s;
	uint64_t total = 0;

	ss_init(&s, 4096);
	if (file_read("/proc/net/dev", &s) == 0) {
		char* save = 0;
		for (char* line = strtok_r(ss_ptr(&s), "\n", &save); line; line = strtok_r(0, "\n", &save)) {
			char name[64];
			unsigned long long rx, tx, skip;
			char* colon = strchr(line, ':');
			if (!colon)
				continue;
			*colon = 0;
			sncpy(name, sizeof(name), line);
			strtrim(name);
			if (strcmp(name, "lo") == 0)
				continue;
			if (sscanf(colon + 1, "%llu %llu %llu %llu %llu %llu %llu %llu %llu", &rx, &skip, &skip, &skip, &skip, &skip, &skip, &skip, &tx) == 9)
				total += rx + tx;
		}
	}
	ss_done(&s);

	return total;
}

/** Minutes until the next scheduled maintenance of any array, or -1 if none. */
static int maintenance_minutes_away(const struct tm* tm)
{
	int best = -1;
	int now_min = tm->tm_wday * 1440 + tm->tm_hour * 60 + tm->tm_min;

	state_lock();
	struct snapraid_host* host = host_ptr();
	for (tommy_node* i = tommy_list_head(&host->state_list); i; i = i->next) {
		struct snapraid_state* state = i->data;
		for (tommy_node* j = tommy_list_head(&state->config.maintenance_list); j; j = j->next) {
			struct snapraid_run* run = j->data;
			for (int day = 0; day < 8; ++day) {
				int wday = (tm->tm_wday + day) % 7;
				if (run->day_of_week != -1 && run->day_of_week != wday)
					continue;
				int at = ((tm->tm_wday + day) * 1440 + run->hour * 60 + run->minute);
				int diff = at - now_min;
				if (diff < 0)
					continue;
				if (best < 0 || diff < best)
					best = diff;
				break;
			}
		}
	}
	state_unlock();

	return best;
}

/** Tell why the machine is not idle, empty if it is. */
static void idle_reason(const struct tm* tm, char* why, size_t why_size)
{
	why[0] = 0;

	state_lock();
	struct snapraid_host* host = host_ptr();
	for (tommy_node* i = tommy_list_head(&host->state_list); i && !why[0]; i = i->next) {
		struct snapraid_state* state = i->data;
		if ((state->runner.latest && state->runner.latest->running) || !tommy_list_empty(&state->runner.waiting_list))
			snprintf(why, why_size, "the array %s is working", state->name);
	}
	state_unlock();
	if (why[0])
		return;

	if (job_is_running()) {
		snprintf(why, why_size, "a storage operation is running");
		return;
	}

	static const unsigned share_ports[] = { 445, 139, 2049, 0 };
	static const unsigned ssh_ports[] = { 22, 0 };
	if (tcp_established(share_ports) > 0) {
		snprintf(why, why_size, "someone is connected to a share");
		return;
	}
	if (tcp_established(ssh_ports) > 0) {
		snprintf(why, why_size, "someone is logged in with SSH");
		return;
	}

	int away = maintenance_minutes_away(tm);
	if (away >= 0 && away <= 30) {
		snprintf(why, why_size, "the maintenance starts in %d minutes", away);
		return;
	}

	/* disk activity of the arrays */
	ss_t s;
	ss_init(&s, 8192);
	if (file_read("/proc/diskstats", &s) == 0) {
		struct host_disk* disks = malloc_nofail(sizeof(struct host_disk) * HOST_DISKS_MAX);
		unsigned count = host_disks(disks, HOST_DISKS_MAX);
		ss_t now;
		ss_init(&now, 1024);
		for (unsigned i = 0; i < count; ++i) {
			char name[64];
			uint64_t rd, wr;
			if (disks[i].device[0] && device_base(disks[i].device, name, sizeof(name)) == 0 && diskstats_get(ss_ptr(&s), name, &rd, &wr) == 0)
				ss_printf(&now, "%s %" PRIu64 " %" PRIu64 "\n", name, rd, wr);
		}
		ss_write(&now, "", 1);
		if (idle_stats_valid && strcmp(ss_ptr(&now), ss_ptr(&idle_last_stats)) != 0)
			snprintf(why, why_size, "the disks are being read or written");
		if (idle_stats_valid)
			ss_done(&idle_last_stats);
		idle_last_stats = now;
		idle_stats_valid = 1;
		free(disks);
	}
	ss_done(&s);
	if (why[0])
		return;

	if (kv_int("idle_check_network", 1)) {
		time_t t = time(0);
		uint64_t bytes = net_bytes();
		if (net_last_time != 0 && t > net_last_time) {
			uint64_t rate = (bytes - net_last_bytes) / (uint64_t)(t - net_last_time);
			if (rate > 100 * 1024)
				snprintf(why, why_size, "the network is in use (%" PRIu64 " KB/s)", rate / 1024);
		}
		net_last_bytes = bytes;
		net_last_time = t;
	}
}

static void idle_tick(const struct tm* tm)
{
	char action[16];
	char why[160];

	kv_get("idle_action", "none", action, sizeof(action));
	time_t now = time(0);

	/*
	 * Coming back from a suspend, or after a jump of the clock, the idle time
	 * starts again: a machine just woken up is not sent back to sleep at once.
	 */
	static time_t last_tick;
	if (last_tick != 0 && (now - last_tick > 5 * 60 || now < last_tick))
		idle_since = now;
	last_tick = now;

	if (strcmp(action, "none") == 0) {
		idle_since = now;
		sncpy(idle_busy, sizeof(idle_busy), "off");
		return;
	}

	idle_reason(tm, why, sizeof(why));
	if (why[0]) {
		idle_since = now;
		sncpy(idle_busy, sizeof(idle_busy), why);
		return;
	}
	idle_busy[0] = 0;

	/* never right after the start: give time to the user to change it */
	if (now - host_ptr()->daemon_start_time < 20 * 60)
		return;

	int minutes = kv_int("idle_minutes", 60);
	if (now - idle_since < minutes * 60)
		return;

	idle_since = now;
	if (host_dryrun) {
		log_msg(LVL_WARNING, "host: idle for %d minutes, would %s (dry run)", minutes, action);
		host_event("info", "idle", action, "Idle: would go to sleep (dry run)");
		return;
	}

	log_msg(LVL_WARNING, "host: idle for %d minutes, going to %s", minutes, action);
	host_event("info", "idle", action, strcmp(action, "suspend") == 0 ? "Nothing to do: went to sleep" : "Nothing to do: turned off");
	const char* args[] = { strcmp(action, "suspend") == 0 ? "suspend" : "poweroff", 0 };
	if (tool_run("systemctl", args, 0, 0, 60) != 0) {
		const char* sh[] = { "-h", "now", 0 };
		if (strcmp(action, "shutdown") == 0)
			tool_run("shutdown", sh, 0, 0, 60);
	}
}

/** Network interfaces with a hardware address, and their Wake-on-LAN state. */
static void wol_json(ss_t* s, int level)
{
	DIR* d = opendir("/sys/class/net");

	ss_json_array_open(s, &level, "interfaces");
	struct dirent* dd;
	while (d && (dd = readdir(d)) != 0) {
		char path[PATH_MAX];
		char mac[64] = "";
		if (dd->d_name[0] == '.' || strcmp(dd->d_name, "lo") == 0)
			continue;
		/* only physical interfaces have a device */
		snprintf(path, sizeof(path), "/sys/class/net/%s/device", dd->d_name);
		int physical = access(path, F_OK) == 0;
		snprintf(path, sizeof(path), "/sys/class/net/%s/address", dd->d_name);
		FILE* f = fopen(path, "r");
		if (f) {
			if (fgets(mac, sizeof(mac), f) == 0)
				mac[0] = 0;
			fclose(f);
			strtrim(mac);
		}

		char wol[16] = "";
		if (physical && tool_exists("ethtool")) {
			ss_t out;
			ss_init(&out, 2048);
			const char* args[] = { dd->d_name, 0 };
			if (tool_run("ethtool", args, 0, &out, 10) == 0) {
				ss_write(&out, "", 1);
				const char* w = strstr(ss_ptr(&out), "\tWake-on: ");
				if (w)
					sscanf(w + 10, "%15s", wol);
			}
			ss_done(&out);
		}

		ss_json_open(s, &level);
		ss_json_str(s, level, "name", dd->d_name);
		ss_json_str(s, level, "mac", mac);
		ss_json_bool(s, level, "physical", physical);
		ss_json_str(s, level, "wake_on", wol);
		ss_json_close(s, &level);
	}
	if (d)
		closedir(d);
	ss_json_array_close(s, &level);
}

static int wol_apply(char* msg, size_t msg_size)
{
	DIR* d = opendir("/sys/class/net");
	int done = 0;
	int ret = 0;

	if (!tool_exists("ethtool")) {
		if (d)
			closedir(d);
		return hfail(msg, msg_size, 501, "ethtool is not installed (package ethtool)");
	}

	struct dirent* dd;
	while (d && (dd = readdir(d)) != 0) {
		char path[PATH_MAX];
		if (dd->d_name[0] == '.')
			continue;
		snprintf(path, sizeof(path), "/sys/class/net/%s/device", dd->d_name);
		if (access(path, F_OK) != 0)
			continue;
		const char* args[] = { "-s", dd->d_name, "wol", "g", 0 };
		if (tool_check("ethtool", args, 0, 10, msg, msg_size) == 0)
			++done;
		else
			ret = 500;
	}
	if (d)
		closedir(d);

	if (done == 0 && ret == 0)
		return hfail(msg, msg_size, 404, "No network card that can wake the machine was found");

	return done > 0 ? 0 : ret;
}

/****************************************************************************/
/* time window of the maintenance */

static void window_tick(const struct tm* tm)
{
	char stop_at[16];

	kv_get("maintenance_stop_at", "", stop_at, sizeof(stop_at));
	if (stop_at[0] == 0 || !sched_match(stop_at, tm))
		return;

	struct snapraid_state* stop_list[64];
	int stop_cmd[64];
	unsigned n = 0;

	state_lock();
	struct snapraid_host* host = host_ptr();
	for (tommy_node* i = tommy_list_head(&host->state_list); i && n < 64; i = i->next) {
		struct snapraid_state* state = i->data;
		struct snapraid_task* task = state->runner.latest;
		if (task && task->running && task->high_cmd == CMD_MAINTENANCE && (task->cmd == CMD_SCRUB || task->cmd == CMD_SYNC)) {
			stop_list[n] = state;
			stop_cmd[n] = task->cmd;
			++n;
		}
	}
	state_unlock();

	/* the state of an array is never freed while the daemon runs */
	for (unsigned k = 0; k < n; ++k) {
		char msg[MSG_MAX];
		int status;
		uint64_t pid;
		int number;
		log_msg(LVL_WARNING, "host: the time window of the maintenance ends at %s: stopping the %s of the array %s, the next maintenance continues it", stop_at, stop_cmd[k] == CMD_SCRUB ? "scrub" : "sync", stop_list[k]->name);
		runner_stop(stop_list[k], msg, sizeof(msg), &status, &pid, &number);
	}
}

/****************************************************************************/
/* SMART self-tests */

static time_t smart_last_start;
static char smart_last_kind[16];

static int smart_test_start(const char* device, const char* kind, char* msg, size_t msg_size)
{
	char name[64];

	if (strcmp(kind, "short") != 0 && strcmp(kind, "long") != 0)
		return hfail(msg, msg_size, 400, "The test is short or long");
	if (!valid_disk_device(device, name, sizeof(name)))
		return hfail(msg, msg_size, 400, "%s is not a disk", device);

	const char* args[] = { "-t", kind, device, 0 };
	if (tool_check("smartctl", args, 0, 60, msg, msg_size) != 0)
		return 500;

	log_msg(LVL_INFO, "host: SMART %s self-test started on %s", kind, device);
	return 0;
}

/** Start the test on every disk of the arrays. */
static void smart_test_all(const char* kind)
{
	struct host_disk* disks = malloc_nofail(sizeof(struct host_disk) * HOST_DISKS_MAX);
	unsigned count = host_disks(disks, HOST_DISKS_MAX);
	char done[HOST_DISKS_MAX][64];
	unsigned done_count = 0;

	for (unsigned i = 0; i < count; ++i) {
		char name[64];
		char msg[MSG_MAX];
		int seen = 0;
		if (!disks[i].device[0] || device_base(disks[i].device, name, sizeof(name)) != 0)
			continue;
		for (unsigned j = 0; j < done_count; ++j)
			seen |= strcmp(done[j], name) == 0;
		if (seen)
			continue;
		sncpy(done[done_count++], sizeof(done[0]), name);
		smart_test_start(disks[i].device, kind, msg, sizeof(msg));
	}
	free(disks);

	smart_last_start = time(0);
	sncpy(smart_last_kind, sizeof(smart_last_kind), kind);
}

static void smart_tick(const struct tm* tm)
{
	char when[256];

	/* the long one wins when both are due */
	kv_get("smart_long", "", when, sizeof(when));
	if (when[0] && sched_match(when, tm)) {
		smart_test_all("long");
		return;
	}
	kv_get("smart_short", "", when, sizeof(when));
	if (when[0] && sched_match(when, tm))
		smart_test_all("short");
}

/** The self-test log of a disk, as smartctl prints it. */
static int smart_log_json(const char* device, ss_t* s, int level, char* msg, size_t msg_size)
{
	char name[64];
	ss_t out;

	if (!valid_disk_device(device, name, sizeof(name)))
		return hfail(msg, msg_size, 400, "%s is not a disk", device);

	ss_init(&out, 4096);
	const char* args[] = { "-l", "selftest", "-c", device, 0 };
	int r = tool_run("smartctl", args, 0, &out, 60);
	if (r == -2) {
		ss_done(&out);
		return hfail(msg, msg_size, 501, "smartctl is not installed (package smartmontools)");
	}
	ss_write(&out, "", 1);

	ss_json_str(s, level, "device", device);
	ss_json_int(s, level, "exit_code", r);
	ss_json_str(s, level, "text", ss_ptr(&out));
	ss_done(&out);

	return 0;
}

/****************************************************************************/
/* diagnostics */

/** Remove the secrets of a configuration: credentials and the commands of notifications and hooks. */
static void redact_conf(const char* text, ss_t* out)
{
	static const char* SECRET[] = { "net_auth_credential", "notify_", "hook_", "net_acl", 0 };
	const char* p = text;

	while (*p) {
		const char* end = strchr(p, '\n');
		size_t len = end ? (size_t)(end - p) : strlen(p);
		const char* q = p;
		while (q < p + len && (*q == ' ' || *q == '\t'))
			++q;
		int secret = 0;
		for (unsigned i = 0; SECRET[i]; ++i) {
			if (strncmp(q, SECRET[i], strlen(SECRET[i])) == 0 && memchr(q, '=', p + len - q))
				secret = 1;
		}
		if (secret) {
			const char* eq = memchr(q, '=', p + len - q);
			ss_write(out, p, eq - p + 1);
			ss_prints(out, " <removed>\n");
		} else {
			ss_write(out, p, len);
			ss_prints(out, "\n");
		}
		p += len;
		if (*p == '\n')
			++p;
	}
}

static void diag_file(ss_t* out, const char* title, const char* path, int redact)
{
	ss_t s;

	ss_printf(out, "\n===== %s: %s\n", title, path);
	ss_init(&s, 4096);
	if (file_read(path, &s) != 0) {
		ss_prints(out, "(not readable)\n");
	} else if (redact) {
		redact_conf(ss_ptr(&s), out);
	} else {
		ss_write(out, ss_ptr(&s), ss_len(&s));
		if (ss_len(&s) > 0 && ss_ptr(&s)[ss_len(&s) - 1] != '\n')
			ss_prints(out, "\n");
	}
	ss_done(&s);
}

static void diag_tool(ss_t* out, const char* title, const char* name, const char** args, unsigned max_lines)
{
	ss_t s;

	ss_printf(out, "\n===== %s\n", title);
	ss_init(&s, 8192);
	int r = tool_run(name, args, 0, &s, 60);
	ss_write(&s, "", 1);
	if (r == -2) {
		ss_printf(out, "(%s is not installed)\n", name);
	} else {
		/* only the last lines */
		const char* text = ss_ptr(&s);
		unsigned lines = 0;
		const char* start = text + strlen(text);
		while (start > text) {
			--start;
			if (*start == '\n' && ++lines > max_lines) {
				++start;
				break;
			}
		}
		ss_prints(out, start);
		if (r != 0)
			ss_printf(out, "(exit code %d)\n", r);
	}
	ss_done(&s);
}

/** Replace every occurrence of a word. */
static void replace_all(ss_t* s, const char* what, const char* with)
{
	if (what[0] == 0 || strlen(what) < 3)
		return;

	/* the text is not terminated while it's built */
	ss_write(s, "", 1);
	--s->len;

	ss_t out;
	ss_init(&out, ss_len(s) + 256);
	const char* p = ss_ptr(s);
	size_t wl = strlen(what);
	const char* hit;
	while ((hit = strstr(p, what)) != 0) {
		ss_write(&out, p, hit - p);
		ss_prints(&out, with);
		p = hit + wl;
	}
	ss_prints(&out, p);
	ss_write(&out, "", 1);
	--out.len;

	ss_done(s);
	*s = out;
}

static void diagnostics_build(ss_t* out)
{
	char hostname[256] = "";
	struct utsname un;
	time_t now = time(0);
	char when[64];

	gethostname(hostname, sizeof(hostname));
	strftime(when, sizeof(when), "%Y-%m-%d %H:%M:%S %z", localtime(&now));

	ss_prints(out, "SnapRAID Daemon diagnostics\n");
	ss_printf(out, "Made %s by the daemon %s. Serial numbers, the name of the machine, passwords,\n", when, PACKAGE_VERSION);
	ss_prints(out, "access lists and the commands of notifications and hooks are removed.\n");

	if (uname(&un) == 0)
		ss_printf(out, "\nKernel: %s %s %s\n", un.sysname, un.release, un.machine);
	diag_file(out, "System", "/etc/os-release", 0);
	diag_file(out, "Uptime", "/proc/uptime", 0);
	diag_file(out, "Memory", "/proc/meminfo", 0);

	const char* v[] = { "--version", 0 };
	const char* mv[] = { "-V", 0 };
	diag_tool(out, "SnapRAID", "snapraid", v, 3);
	diag_tool(out, "mergerfs", "mergerfs", mv, 3);
	diag_tool(out, "smartctl", "smartctl", mv, 2);
	diag_tool(out, "rsync", "rsync", v, 1);

	/* configurations */
	char main_conf[PATH_MAX];
	char dir[PATH_MAX];
	state_lock();
	sncpy(main_conf, sizeof(main_conf), state_ptr()->config.conf);
	state_unlock();
	diag_file(out, "Daemon configuration", main_conf, 1);

	arrays_dir(dir, sizeof(dir));
	DIR* d = opendir(dir);
	struct dirent* dd;
	while (d && (dd = readdir(d)) != 0) {
		char path[PATH_MAX * 2];
		size_t l = strlen(dd->d_name);
		if (l < 6 || strcmp(dd->d_name + l - 5, ".conf") != 0)
			continue;
		snprintf(path, sizeof(path), "%s/%s", dir, dd->d_name);
		diag_file(out, "Array configuration", path, 1);
	}
	if (d)
		closedir(d);

	state_lock();
	struct snapraid_host* host = host_ptr();
	sl_t engines;
	sl_init(&engines);
	for (tommy_node* i = tommy_list_head(&host->state_list); i; i = i->next) {
		char path[PATH_MAX];
		array_engine_conf_locked(i->data, path, sizeof(path));
		sl_insert_str(&engines, path);
	}
	state_unlock();
	for (tommy_node* i = tommy_list_head(&engines); i; i = i->next)
		diag_file(out, "SnapRAID configuration", ((sn_t*)i->data)->str, 0);
	sl_free(&engines);

	diag_file(out, "Machine settings", host_conf_path, 1);
	diag_file(out, "Mounts at boot", "/etc/fstab", 0);

	/* disks */
	struct host_disk* disks = malloc_nofail(sizeof(struct host_disk) * HOST_DISKS_MAX);
	unsigned count = host_disks(disks, HOST_DISKS_MAX);
	ss_prints(out, "\n===== Disks of the arrays\n");
	for (unsigned i = 0; i < count; ++i) {
		ss_printf(out, "%-10s %-12s %-7s %-14s %-30s %s%s\n", disks[i].array, disks[i].name, disks[i].parity ? "parity" : "data",
			disks[i].device, disks[i].model, disks[i].mount, disks[i].standby ? " (standby)" : "");
	}

	const char* lsblk[] = { "-o", "NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL,ROTA,TRAN", 0 };
	diag_tool(out, "Block devices", "lsblk", lsblk, 200);

	ss_prints(out, "\n===== Mounted filesystems\n");
	ss_t m;
	ss_init(&m, 4096);
	if (file_read("/proc/self/mounts", &m) == 0) {
		const char* cursor = ss_ptr(&m);
		struct mount_entry e;
		int r;
		while ((r = mount_next(&cursor, &e, 0, 0)) >= 0) {
			struct statvfs vfs;
			if (r != 1)
				continue;
			if (strncmp(e.source, "/dev/", 5) != 0 && !is_mergerfs(e.fstype) && strncmp(e.fstype, "nfs", 3) != 0 && strcmp(e.fstype, "cifs") != 0)
				continue;
			uint64_t total = 0, avail = 0;
			if (statvfs(e.target, &vfs) == 0) {
				total = (uint64_t)vfs.f_blocks * vfs.f_frsize;
				avail = (uint64_t)vfs.f_bavail * vfs.f_frsize;
			}
			ss_printf(out, "%-30s %-20s %-14s %8" PRIu64 " MB free of %8" PRIu64 " MB  %s\n", e.source, e.target, e.fstype, avail >> 20, total >> 20, e.options);
		}
	}
	ss_done(&m);

	const char* journal[] = { "-u", "snapraidd", "-n", "300", "--no-pager", "-o", "short-iso", 0 };
	diag_tool(out, "Daemon log (latest lines)", "journalctl", journal, 300);
	const char* dmesg[] = { "--level=err,warn", "-T", 0 };
	diag_tool(out, "Kernel errors and warnings (latest lines)", "dmesg", dmesg, 150);

	/* anonymize */
	for (unsigned i = 0; i < count; ++i) {
		char with[32];
		snprintf(with, sizeof(with), "serial-%u", i + 1);
		replace_all(out, disks[i].serial, with);
	}
	free(disks);
	if (strlen(hostname) >= 3 && strcmp(hostname, "localhost") != 0)
		replace_all(out, hostname, "server");
}

/****************************************************************************/
/* backup and restore of the settings */

/** The files that make the settings of the machine for the daemon. */
static void settings_files(sl_t* list)
{
	char path[PATH_MAX * 2];
	char dir[PATH_MAX];

	state_lock();
	sl_insert_str(list, state_ptr()->config.conf);
	struct snapraid_host* host = host_ptr();
	for (tommy_node* i = tommy_list_head(&host->state_list); i; i = i->next) {
		array_engine_conf_locked(i->data, path, sizeof(path));
		sl_insert_str(list, path);
	}
	state_unlock();

	arrays_dir(dir, sizeof(dir));
	DIR* d = opendir(dir);
	struct dirent* dd;
	while (d && (dd = readdir(d)) != 0) {
		size_t l = strlen(dd->d_name);
		if (l < 6 || strcmp(dd->d_name + l - 5, ".conf") != 0)
			continue;
		snprintf(path, sizeof(path), "%s/%s", dir, dd->d_name);
		sl_insert_str(list, path);
	}
	if (d)
		closedir(d);

	sl_insert_str(list, host_conf_path);
	sl_insert_str(list, "/etc/fstab");
}

static void settings_backup_json(ss_t* s, int level)
{
	sl_t list;
	time_t now = time(0);
	char when[64];

	strftime(when, sizeof(when), "%Y-%m-%dT%H:%M:%S", localtime(&now));
	ss_json_str(s, level, "kind", "snapraidd-settings");
	ss_json_str(s, level, "made", when);
	ss_json_str(s, level, "daemon_version", PACKAGE_VERSION);

	sl_init(&list);
	settings_files(&list);
	ss_json_array_open(s, &level, "files");
	for (tommy_node* i = tommy_list_head(&list); i; i = i->next) {
		const char* path = ((sn_t*)i->data)->str;
		ss_t text;
		ss_init(&text, 4096);
		if (file_read(path, &text) == 0) {
			ss_json_open(s, &level);
			ss_json_str(s, level, "path", path);
			ss_json_str(s, level, "text", ss_ptr(&text));
			ss_json_close(s, &level);
		}
		ss_done(&text);
	}
	ss_json_array_close(s, &level);
	sl_free(&list);
}

static void host_reload_settings(void);

static int settings_restore(const char* path, const char* text, char* msg, size_t msg_size)
{
	sl_t list;
	int known = 0;

	sl_init(&list);
	settings_files(&list);
	for (tommy_node* i = tommy_list_head(&list); i; i = i->next)
		known |= strcmp(((sn_t*)i->data)->str, path) == 0;
	sl_free(&list);

	if (!known)
		return hfail(msg, msg_size, 400, "%s is not one of the settings files of this machine", path);
	if (strlen(text) >= STORAGE_TEXT_MAX)
		return hfail(msg, msg_size, 400, "The file is too big");

	/* a SnapRAID configuration goes through its own checks */
	state_lock();
	struct snapraid_state* engine_of = 0;
	struct snapraid_host* host = host_ptr();
	for (tommy_node* i = tommy_list_head(&host->state_list); i; i = i->next) {
		char epath[PATH_MAX];
		array_engine_conf_locked(i->data, epath, sizeof(epath));
		if (strcmp(epath, path) == 0)
			engine_of = i->data;
	}
	state_unlock();
	if (engine_of)
		return storage_engine_conf_write(engine_of, text, msg, msg_size);

	if (file_replace(path, text, ".before-restore", 0644) != 0)
		return hfail(msg, msg_size, 500, "Cannot write %s", path);

	log_msg(LVL_WARNING, "host: %s restored from a backup of the settings", path);

	if (strcmp(path, host_conf_path) == 0) {
		host_reload_settings();
	} else if (strcmp(path, "/etc/fstab") != 0) {
		/* the configurations of the daemon are read again, a wrong one is refused and the old one kept */
		kill(getpid(), SIGHUP);
	}

	return 0;
}

/****************************************************************************/
/* status */

/** Write the options of a "name=value<TAB>..." line as fields of an object. */
static void options_json(ss_t* s, int level, const char* line, const char* const* allowed)
{
	for (unsigned i = 0; allowed[i]; ++i) {
		char name[32];
		char val[2048];
		const char* colon = strchr(allowed[i], ':');
		size_t nl = colon - allowed[i];
		memcpy(name, allowed[i], nl);
		name[nl] = 0;
		if (opt_get(line, name, val, sizeof(val)) != 0)
			continue;
		if (colon[1] == 'b')
			ss_json_bool(s, level, name, atoi(val) != 0);
		else if (colon[1] == 'i')
			ss_json_int(s, level, name, atoi(val));
		else
			ss_json_str(s, level, name, val);
	}
}

static int setting_store(const char* key, const char* val, char* msg, size_t msg_size);

static void host_wake(void);

/****************************************************************************/
/* files next to the settings */

/** Path of a file kept in the folder of the settings. */
static void host_side_path(const char* name, char* out, size_t out_size)
{
	char dir[PATH_MAX];

	sncpy(dir, sizeof(dir), host_conf_path);
	char* slash = strrchr(dir, '/');
	if (slash)
		*slash = 0;
	else
		sncpy(dir, sizeof(dir), ".");
	snprintf(out, out_size, "%.*s/%s", (int)(out_size > 80 ? out_size - 80 : 0), dir, name);
}

/****************************************************************************/
/* events of the machine: what happened beside the runs of the arrays */

#define EVENTS_NAME "snapraidd-events.log"
#define EVENTS_KEEP 400 /**< Lines kept when the log is trimmed */
#define EVENTS_MAX 500 /**< Lines over which the log is trimmed */

static pthread_mutex_t events_mutex = PTHREAD_MUTEX_INITIALIZER;
static int events_lines = -1; /**< Lines in the file, -1 until counted */

/** Copy a field of an event line: no tabs, no new lines, never empty. */
static void event_field(char* out, size_t out_size, const char* in)
{
	size_t n = 0;

	for (const char* p = in ? in : ""; *p && n + 1 < out_size; ++p)
		out[n++] = (*p == '\t' || *p == '\n' || *p == '\r') ? ' ' : *p;
	if (n == 0 && out_size > 1)
		out[n++] = '-';
	out[n] = 0;
}

void host_event(const char* level, const char* kind, const char* target, const char* text)
{
	char path[PATH_MAX];
	char f_level[16], f_kind[32], f_target[PATH_MAX], f_text[MSG_MAX];

	event_field(f_level, sizeof(f_level), level);
	event_field(f_kind, sizeof(f_kind), kind);
	event_field(f_target, sizeof(f_target), target);
	event_field(f_text, sizeof(f_text), text);

	host_side_path(EVENTS_NAME, path, sizeof(path));

	pthread_mutex_lock(&events_mutex);

	if (events_lines < 0) {
		ss_t s;
		ss_init(&s, 16384);
		events_lines = 0;
		if (file_read(path, &s) == 0) {
			for (ssize_t i = 0; i < ss_len(&s); ++i)
				events_lines += ss_ptr(&s)[i] == '\n';
		}
		ss_done(&s);
	}

	char line[MSG_MAX + PATH_MAX + 128];
	int len = snprintf(line, sizeof(line), "%" PRIi64 "\t%s\t%s\t%s\t%s\n", (int64_t)time(0), f_level, f_kind, f_target, f_text);
	if (len > (int)sizeof(line) - 1) {
		len = sizeof(line) - 1;
		line[len - 1] = '\n';
	}
	/* the folder of the settings is written with the privileges of the daemon */
	priv_enter();
	int f = open(path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0644);
	priv_leave();
	if (f >= 0) {
		if (write(f, line, len) == len)
			++events_lines;
		close(f);
	} else {
		log_msg(LVL_ERROR, "host: cannot write %s, errno=%s(%d)", path, strerror(errno), errno);
	}

	/* trimmed now and then, not at every line */
	if (events_lines > EVENTS_MAX) {
		ss_t s;
		ss_init(&s, 65536);
		if (file_read(path, &s) == 0) {
			ss_write(&s, "", 1);
			char* p = ss_ptr(&s);
			int skip = events_lines - EVENTS_KEEP;
			while (skip > 0 && *p) {
				char* nl = strchr(p, '\n');
				if (!nl)
					break;
				p = nl + 1;
				--skip;
			}
			if (file_replace(path, p, 0, 0644) == 0)
				events_lines = EVENTS_KEEP;
		}
		ss_done(&s);
	}

	pthread_mutex_unlock(&events_mutex);
}

/** The events for the pages, the newest first. */
static void events_json(ss_t* s, int level, int limit)
{
	char path[PATH_MAX];
	ss_t text;

	host_side_path(EVENTS_NAME, path, sizeof(path));
	ss_init(&text, 65536);
	pthread_mutex_lock(&events_mutex);
	int ok = file_read(path, &text) == 0;
	pthread_mutex_unlock(&events_mutex);

	ss_json_array_open(s, &level, "events");
	if (ok) {
		ss_write(&text, "", 1);
		char* base = ss_ptr(&text);
		/* walk the lines from the end */
		char* end = base + strlen(base);
		while (end > base && limit > 0) {
			char* stop = end;
			if (stop > base && stop[-1] == '\n')
				--stop;
			char* start = stop;
			while (start > base && start[-1] != '\n')
				--start;
			end = start;
			*stop = 0;
			char* f[5];
			unsigned n = 0;
			char* save = 0;
			for (char* tok = strtok_r(start, "\t", &save); tok && n < 5; tok = strtok_r(0, "\t", &save))
				f[n++] = tok;
			if (n != 5 || start[0] == '#')
				continue;
			int64_t at = strtoll(f[0], 0, 10);
			if (at <= 0)
				continue;
			ss_json_open(s, &level);
			ss_json_pair_iso8601(s, level, "at", (time_t)at);
			ss_json_str(s, level, "level", f[1]);
			ss_json_str(s, level, "kind", f[2]);
			ss_json_str(s, level, "target", strcmp(f[3], "-") == 0 ? "" : f[3]);
			ss_json_str(s, level, "text", strcmp(f[4], "-") == 0 ? "" : f[4]);
			ss_json_close(s, &level);
			--limit;
		}
	}
	ss_json_array_close(s, &level);
	ss_done(&text);
}

/****************************************************************************/
/* space used by every array, one sample a day, and when it gets full */

#define SPACE_NAME "snapraidd-space.log"
#define SPACE_DAYS_KEPT 400 /**< Samples older than this are dropped */
#define SPACE_DAYS_FIT 90 /**< Days looked at for the forecast */
#define SPACE_FIT_MIN 7 /**< Days of samples needed before a forecast */
#define SPACE_ARRAYS 64

struct space_sample {
	int64_t day; /**< Days since 1970, local time of the machine */
	char array[ARRAY_NAME_MAX];
	uint64_t used;
	uint64_t total;
};

static pthread_mutex_t space_mutex = PTHREAD_MUTEX_INITIALIZER;
static int64_t space_day = -1; /**< Day of space_done, -1 until read */
static char space_done[SPACE_ARRAYS][ARRAY_NAME_MAX]; /**< Arrays measured that day */
static unsigned space_done_count;

static int space_is_done(const char* array)
{
	for (unsigned i = 0; i < space_done_count; ++i) {
		if (strcmp(space_done[i], array) == 0)
			return 1;
	}
	return 0;
}

static int64_t space_today(time_t now)
{
	struct tm tm;
	localtime_r(&now, &tm);
	/* the local day, without the zone moving it at midnight */
	return (int64_t)(now + tm.tm_gmtoff) / SECONDS_IN_A_DAY;
}

/**
 * Growth in bytes a day: least squares line of the samples.
 * \return 0 with the slope, -1 if the samples are too few or too close in time.
 */
int space_fit(const int64_t* day, const double* used, unsigned n, double* slope)
{
	if (n < 2)
		return -1;
	int64_t first = day[0], last = day[0];
	double mx = 0, my = 0;
	for (unsigned i = 0; i < n; ++i) {
		if (day[i] < first)
			first = day[i];
		if (day[i] > last)
			last = day[i];
		mx += (double)day[i];
		my += used[i];
	}
	if (last - first + 1 < SPACE_FIT_MIN)
		return -1;
	mx /= n;
	my /= n;
	double sxy = 0, sxx = 0;
	for (unsigned i = 0; i < n; ++i) {
		sxy += ((double)day[i] - mx) * (used[i] - my);
		sxx += ((double)day[i] - mx) * ((double)day[i] - mx);
	}
	if (sxx <= 0)
		return -1;
	*slope = sxy / sxx;
	return 0;
}

static unsigned space_read(struct space_sample** out)
{
	char path[PATH_MAX];
	ss_t s;
	unsigned n = 0, cap = 256;
	struct space_sample* list = malloc_nofail(sizeof(*list) * cap);

	host_side_path(SPACE_NAME, path, sizeof(path));
	ss_init(&s, 65536);
	if (file_read(path, &s) == 0) {
		ss_write(&s, "", 1);
		char* save = 0;
		for (char* line = strtok_r(ss_ptr(&s), "\n", &save); line; line = strtok_r(0, "\n", &save)) {
			struct space_sample x;
			char name[ARRAY_NAME_MAX + 1];
			long long d;
			unsigned long long u, t;
			if (line[0] == '#' || sscanf(line, "%lld\t%64[^\t]\t%llu\t%llu", &d, name, &u, &t) != 4)
				continue;
			x.day = d;
			sncpy(x.array, sizeof(x.array), name);
			x.used = u;
			x.total = t;
			if (n == cap) {
				cap *= 2;
				list = realloc(list, sizeof(*list) * cap);
				if (!list)
					abort();
			}
			list[n++] = x;
		}
	}
	ss_done(&s);
	*out = list;
	return n;
}

/** Once a day: the used and total space of the data disks of every array. An array added during the day is measured as soon as it's there. */
static void space_tick(void)
{
	int64_t today = space_today(time(0));

	pthread_mutex_lock(&space_mutex);
	if (space_day != today) {
		/* the arrays already measured today, also by a daemon running before this one */
		struct space_sample* list;
		unsigned n = space_read(&list);
		space_done_count = 0;
		for (unsigned i = 0; i < n; ++i) {
			if (list[i].day == today && !space_is_done(list[i].array) && space_done_count < SPACE_ARRAYS)
				sncpy(space_done[space_done_count++], sizeof(space_done[0]), list[i].array);
		}
		space_day = today;
		free(list);
	}
	pthread_mutex_unlock(&space_mutex);

	/* the mount points are copied under the lock, measured without it */
	struct {
		char array[ARRAY_NAME_MAX];
		char dir[PATH_MAX];
	}* dirs = malloc_nofail(sizeof(*dirs) * 512);
	unsigned dir_count = 0;
	state_lock();
	pthread_mutex_lock(&space_mutex);
	for (tommy_node* i = tommy_list_head(&host_ptr()->state_list); i; i = i->next) {
		struct snapraid_state* state = i->data;
		if (space_is_done(state->name))
			continue;
		for (tommy_node* j = tommy_list_head(&state->array.disk_list); j && dir_count < 512; j = j->next) {
			struct snapraid_disk* disk = j->data;
			if (disk->kind != DISK_DATA)
				continue;
			tommy_node* k = tommy_list_head(&disk->split_list);
			if (!k)
				continue;
			struct snapraid_split* split = k->data;
			if (!split->path[0])
				continue;
			sncpy(dirs[dir_count].array, sizeof(dirs[dir_count].array), state->name);
			sncpy(dirs[dir_count].dir, sizeof(dirs[dir_count].dir), split->path);
			++dir_count;
		}
	}
	pthread_mutex_unlock(&space_mutex);
	state_unlock();
	if (dir_count == 0) {
		free(dirs);
		return;
	}

	struct space_sample fresh[SPACE_ARRAYS];
	unsigned fresh_count = 0;
	for (unsigned i = 0; i < dir_count; ++i) {
		struct statvfs vfs;
		/* the counters of the filesystem: no read of the disk, a sleeping disk stays asleep */
		if (statvfs(dirs[i].dir, &vfs) != 0 || vfs.f_blocks == 0)
			continue;
		uint64_t total = (uint64_t)vfs.f_blocks * vfs.f_frsize;
		uint64_t free_bytes = (uint64_t)vfs.f_bavail * vfs.f_frsize;
		struct space_sample* x = 0;
		for (unsigned k = 0; k < fresh_count; ++k) {
			if (strcmp(fresh[k].array, dirs[i].array) == 0)
				x = &fresh[k];
		}
		if (!x) {
			if (fresh_count == SPACE_ARRAYS)
				continue;
			x = &fresh[fresh_count++];
			memset(x, 0, sizeof(*x));
			x->day = today;
			sncpy(x->array, sizeof(x->array), dirs[i].array);
		}
		x->total += total;
		x->used += total > free_bytes ? total - free_bytes : 0;
	}
	free(dirs);
	if (fresh_count == 0)
		return;

	pthread_mutex_lock(&space_mutex);
	struct space_sample* list;
	unsigned n = space_read(&list);
	char path[PATH_MAX];
	ss_t s;
	ss_init(&s, 65536);
	ss_prints(&s, "# Space of the arrays of the SnapRAID Daemon, one line a day: day (days since 1970), array, used bytes, total bytes of the data disks.\n");
	for (unsigned i = 0; i < n; ++i) {
		if (list[i].day < today - SPACE_DAYS_KEPT || list[i].day > today)
			continue;
		int again = 0;
		for (unsigned k = 0; k < fresh_count; ++k)
			again |= list[i].day == today && strcmp(list[i].array, fresh[k].array) == 0;
		if (again)
			continue;
		ss_printf(&s, "%" PRIi64 "\t%s\t%" PRIu64 "\t%" PRIu64 "\n", list[i].day, list[i].array, list[i].used, list[i].total);
	}
	for (unsigned i = 0; i < fresh_count; ++i)
		ss_printf(&s, "%" PRIi64 "\t%s\t%" PRIu64 "\t%" PRIu64 "\n", fresh[i].day, fresh[i].array, fresh[i].used, fresh[i].total);
	ss_write(&s, "", 1);
	host_side_path(SPACE_NAME, path, sizeof(path));
	if (file_replace(path, ss_ptr(&s), 0, 0644) != 0)
		log_msg(LVL_ERROR, "host: cannot write %s, errno=%s(%d)", path, strerror(errno), errno);
	for (unsigned i = 0; i < fresh_count; ++i) {
		if (!space_is_done(fresh[i].array) && space_done_count < SPACE_ARRAYS)
			sncpy(space_done[space_done_count++], sizeof(space_done[0]), fresh[i].array);
	}
	ss_done(&s);
	free(list);
	pthread_mutex_unlock(&space_mutex);
}

static void space_forecast_json(ss_t* s, int level, double slope_sum, int have, uint64_t used, uint64_t total)
{
	if (!have) {
		ss_json_bool(s, level, "forecast", 0);
		return;
	}
	ss_json_bool(s, level, "forecast", 1);
	ss_json_double(s, level, "growth_bytes_per_day", slope_sum);
	if (slope_sum > 0 && total > used)
		ss_json_i64(s, level, "days_to_full", (int64_t)((double)(total - used) / slope_sum));
}

/** Samples of the last days and the forecast, by array and for all of them. */
static void space_json(ss_t* s, int level, int days)
{
	int64_t today = space_today(time(0));
	struct space_sample* list;

	pthread_mutex_lock(&space_mutex);
	unsigned n = space_read(&list);
	pthread_mutex_unlock(&space_mutex);

	char names[SPACE_ARRAYS][ARRAY_NAME_MAX];
	unsigned name_count = 0;
	for (unsigned i = 0; i < n; ++i) {
		unsigned k;
		for (k = 0; k < name_count && strcmp(names[k], list[i].array) != 0; ++k)
			;
		if (k == name_count && name_count < SPACE_ARRAYS)
			sncpy(names[name_count++], sizeof(names[0]), list[i].array);
	}

	int64_t* xd = malloc_nofail(sizeof(int64_t) * (n + 1));
	double* yu = malloc_nofail(sizeof(double) * (n + 1));
	double slope_sum = 0;
	int all_have = name_count > 0;
	uint64_t all_used = 0, all_total = 0;

	ss_json_i64(s, level, "fit_days", SPACE_DAYS_FIT);
	ss_json_array_open(s, &level, "arrays");
	for (unsigned k = 0; k < name_count; ++k) {
		unsigned m = 0;
		const struct space_sample* latest = 0;
		for (unsigned i = 0; i < n; ++i) {
			if (strcmp(list[i].array, names[k]) != 0)
				continue;
			if (!latest || list[i].day >= latest->day)
				latest = &list[i];
			if (list[i].day >= today - SPACE_DAYS_FIT) {
				xd[m] = list[i].day;
				yu[m] = (double)list[i].used;
				++m;
			}
		}
		/* an array not measured lately is gone */
		if (!latest || latest->day < today - 7)
			continue;
		double slope = 0;
		int have = space_fit(xd, yu, m, &slope) == 0;
		ss_json_open(s, &level);
		ss_json_str(s, level, "array", names[k]);
		ss_json_u64(s, level, "used_bytes", latest->used);
		ss_json_u64(s, level, "total_bytes", latest->total);
		space_forecast_json(s, level, slope, have, latest->used, latest->total);
		ss_json_array_open(s, &level, "days");
		for (unsigned i = 0; i < n; ++i) {
			if (strcmp(list[i].array, names[k]) != 0 || list[i].day < today - days)
				continue;
			ss_jsonf(s, level, "{ \"day\": %" PRIi64 ", \"used\": %" PRIu64 " },\n", list[i].day, list[i].used);
		}
		ss_json_array_close(s, &level);
		ss_json_close(s, &level);
		all_used += latest->used;
		all_total += latest->total;
		if (have)
			slope_sum += slope;
		else
			all_have = 0;
	}
	ss_json_array_close(s, &level);

	ss_json_object_open(s, &level, "all");
	ss_json_u64(s, level, "used_bytes", all_used);
	ss_json_u64(s, level, "total_bytes", all_total);
	space_forecast_json(s, level, slope_sum, all_have, all_used, all_total);
	ss_json_close(s, &level);

	free(xd);
	free(yu);
	free(list);
}

/****************************************************************************/
/* record of the runs: what every sync, scrub, check and fix found */

#define RUNS_NAME "snapraidd-runs.log"
#define RUNS_KEEP 2500 /**< Lines kept when the record is trimmed */
#define RUNS_MAX 3000 /**< Lines over which the record is trimmed */
#define RUNS_ARRAYS 64
#define RUNS_BATCH 64

struct run_last {
	char array[ARRAY_NAME_MAX];
	int64_t end; /**< End of the newest run recorded */
	unsigned cmds; /**< Bits of the commands recorded with that end, as more can end in the same second */
};

static struct run_last runs_last[RUNS_ARRAYS];
static unsigned runs_last_count;
static unsigned runs_lines;
static int runs_loaded;
static pthread_mutex_t runs_mutex = PTHREAD_MUTEX_INITIALIZER;

static struct run_last* runs_slot(const char* array)
{
	for (unsigned i = 0; i < runs_last_count; ++i) {
		if (strcmp(runs_last[i].array, array) == 0)
			return &runs_last[i];
	}
	if (runs_last_count == RUNS_ARRAYS)
		return 0;
	struct run_last* r = &runs_last[runs_last_count++];
	memset(r, 0, sizeof(*r));
	sncpy(r->array, sizeof(r->array), array);
	return r;
}

static int run_cmd_code(const char* name)
{
	if (strcmp(name, "sync") == 0)
		return CMD_SYNC;
	if (strcmp(name, "scrub") == 0)
		return CMD_SCRUB;
	if (strcmp(name, "fix") == 0)
		return CMD_FIX;
	if (strcmp(name, "check") == 0)
		return CMD_CHECK;
	return 0;
}

static const char* run_cmd_name(int cmd)
{
	switch (cmd) {
	case CMD_SYNC : return "sync";
	case CMD_SCRUB : return "scrub";
	case CMD_FIX : return "fix";
	case CMD_CHECK : return "check";
	}
	return 0;
}

/** One line of the record: 13 fields separated by tabs. */
struct run_line {
	int64_t end;
	char array[ARRAY_NAME_MAX];
	char command[16];
	char status[16]; /**< ok, error, stopped */
	int exit_code;
	int64_t seconds;
	uint64_t soft, io, data, recovered, unrecoverable;
	int64_t added, removed, updated;
};

static int run_parse(char* line, struct run_line* r)
{
	char* f[14];
	unsigned n = 0;
	char* save = 0;

	for (char* tok = strtok_r(line, "\t", &save); tok && n < 14; tok = strtok_r(0, "\t", &save))
		f[n++] = tok;
	if (n != 14)
		return -1;
	r->end = strtoll(f[0], 0, 10);
	sncpy(r->array, sizeof(r->array), f[1]);
	sncpy(r->command, sizeof(r->command), f[2]);
	sncpy(r->status, sizeof(r->status), f[3]);
	r->exit_code = atoi(f[4]);
	r->seconds = strtoll(f[5], 0, 10);
	r->soft = strtoull(f[6], 0, 10);
	r->io = strtoull(f[7], 0, 10);
	r->data = strtoull(f[8], 0, 10);
	r->recovered = strtoull(f[9], 0, 10);
	r->unrecoverable = strtoull(f[10], 0, 10);
	r->added = strtoll(f[11], 0, 10);
	r->removed = strtoll(f[12], 0, 10);
	r->updated = strtoll(f[13], 0, 10);
	if (r->end <= 0 || r->array[0] == 0 || run_cmd_code(r->command) == 0)
		return -1;
	return 0;
}

static void run_format(ss_t* s, const struct run_line* r)
{
	ss_printf(s, "%" PRIi64 "\t%s\t%s\t%s\t%d\t%" PRIi64 "\t%" PRIu64 "\t%" PRIu64 "\t%" PRIu64 "\t%" PRIu64 "\t%" PRIu64 "\t%" PRIi64 "\t%" PRIi64 "\t%" PRIi64 "\n",
		r->end, r->array, r->command, r->status, r->exit_code, r->seconds, r->soft, r->io, r->data, r->recovered, r->unrecoverable, r->added, r->removed, r->updated);
}

/** Read the record, the oldest first. The caller frees the lines. */
static unsigned runs_read(struct run_line** out)
{
	char path[PATH_MAX];
	ss_t s;
	unsigned n = 0;
	unsigned cap = 256;
	struct run_line* list = malloc_nofail(sizeof(struct run_line) * cap);

	host_side_path(RUNS_NAME, path, sizeof(path));
	ss_init(&s, 65536);
	if (file_read(path, &s) == 0) {
		ss_write(&s, "", 1);
		char* save = 0;
		for (char* line = strtok_r(ss_ptr(&s), "\n", &save); line; line = strtok_r(0, "\n", &save)) {
			struct run_line r;
			if (line[0] == '#' || run_parse(line, &r) != 0)
				continue;
			if (n == cap) {
				cap *= 2;
				list = realloc(list, sizeof(struct run_line) * cap);
				if (!list)
					abort();
			}
			list[n++] = r;
		}
	}
	ss_done(&s);

	*out = list;
	return n;
}

static void runs_write(const struct run_line* list, unsigned n)
{
	char path[PATH_MAX];
	ss_t s;

	host_side_path(RUNS_NAME, path, sizeof(path));
	ss_init(&s, 65536);
	ss_prints(&s, "# Runs of the SnapRAID Daemon: end, array, command, result, exit code, seconds, errors (soft, input/output, data), recovered, unrecoverable, files added, removed, updated.\n");
	for (unsigned i = 0; i < n; ++i)
		run_format(&s, &list[i]);
	ss_write(&s, "", 1);
	if (file_replace(path, ss_ptr(&s), 0, 0644) != 0)
		log_msg(LVL_ERROR, "host: cannot write %s, errno=%s(%d)", path, strerror(errno), errno);
	ss_done(&s);
}

/** Once a minute: the runs ended since the latest look are added to the record. */
static void runs_tick(void)
{
	struct run_line fresh[RUNS_BATCH];
	unsigned n = 0;

	pthread_mutex_lock(&runs_mutex);

	if (!runs_loaded) {
		struct run_line* list;
		unsigned count = runs_read(&list);
		for (unsigned i = 0; i < count; ++i) {
			struct run_last* r = runs_slot(list[i].array);
			unsigned bit = 1U << run_cmd_code(list[i].command);
			if (r && list[i].end > r->end) {
				r->end = list[i].end;
				r->cmds = bit;
			} else if (r && list[i].end == r->end) {
				r->cmds |= bit;
			}
		}
		runs_lines = count;
		runs_loaded = 1;
		free(list);
	}

	state_lock();
	for (tommy_node* i = tommy_list_head(&host_ptr()->state_list); i; i = i->next) {
		struct snapraid_state* state = i->data;
		struct run_last* last = runs_slot(state->name);
		if (!last)
			continue;
		int64_t newest = last->end;
		unsigned newest_cmds = last->cmds;
		for (tommy_node* j = tommy_list_head(&state->runner.history_list); j && n < RUNS_BATCH; j = j->next) {
			struct snapraid_task* t = j->data;
			const char* name = run_cmd_name(t->cmd);
			if (!name || t->running || t->unix_end_time <= 0)
				continue;
			if (t->state != PROCESS_STATE_TERM && t->state != PROCESS_STATE_SIGNAL)
				continue;
			unsigned bit = 1U << t->cmd;
			if (t->unix_end_time < last->end || (t->unix_end_time == last->end && (last->cmds & bit) != 0))
				continue;
			struct run_line* r = &fresh[n++];
			memset(r, 0, sizeof(*r));
			r->end = t->unix_end_time;
			sncpy(r->array, sizeof(r->array), state->name);
			sncpy(r->command, sizeof(r->command), name);
			int stopped = t->state == PROCESS_STATE_SIGNAL;
			for (tommy_node* k = tommy_list_head(&t->message_list); k && !stopped; k = k->next) {
				struct snapraid_message* m = k->data;
				if (strstr(m->msg, "Stop requested") != 0)
					stopped = 1;
			}
			r->exit_code = t->state == PROCESS_STATE_TERM ? t->exit_code : -1;
			sncpy(r->status, sizeof(r->status), stopped ? "stopped" : r->exit_code == 0 ? "ok" : "error");
			r->seconds = t->unix_start_time > 0 && t->unix_end_time >= t->unix_start_time ? t->unix_end_time - t->unix_start_time : 0;
			r->soft = t->error_soft;
			r->io = t->error_io;
			r->data = t->error_data;
			r->recovered = t->error_recovered;
			r->unrecoverable = t->error_unrecoverable;
			r->added = t->diff_added;
			r->removed = t->diff_removed;
			r->updated = t->diff_updated;
			if (t->unix_end_time > newest) {
				newest = t->unix_end_time;
				newest_cmds = bit;
			} else if (t->unix_end_time == newest) {
				newest_cmds |= bit;
			}
		}
		last->end = newest;
		last->cmds = newest_cmds;
	}
	state_unlock();

	if (n > 0) {
		struct run_line* list;
		unsigned count = runs_read(&list);
		list = realloc(list, sizeof(struct run_line) * (count + n));
		if (!list)
			abort();
		/* the tasks of one look are added by time */
		for (unsigned a = 0; a < n; ++a) {
			unsigned pos = count;
			while (pos > 0 && list[pos - 1].end > fresh[a].end) {
				list[pos] = list[pos - 1];
				--pos;
			}
			list[pos] = fresh[a];
			++count;
		}
		unsigned from = count > RUNS_MAX ? count - RUNS_KEEP : 0;
		runs_write(list + from, count - from);
		runs_lines = count - from;
		free(list);
	}

	pthread_mutex_unlock(&runs_mutex);
}

/** The record for the pages, the newest first. */
static void runs_json(ss_t* s, int level, const char* array, int limit)
{
	struct run_line* list;

	pthread_mutex_lock(&runs_mutex);
	unsigned count = runs_read(&list);
	pthread_mutex_unlock(&runs_mutex);

	uint64_t found = 0;
	uint64_t fixed = 0;
	uint64_t lost = 0;
	unsigned total = 0;
	int64_t first = 0;

	ss_json_array_open(s, &level, "runs");
	for (unsigned i = count; i > 0; --i) {
		const struct run_line* r = &list[i - 1];
		if (array && array[0] && strcmp(array, r->array) != 0)
			continue;
		++total;
		if (strcmp(r->command, "fix") != 0)
			found += r->io + r->data; /* a repair finds again what it repairs */
		fixed += r->recovered;
		lost += r->unrecoverable;
		first = r->end;
		if (limit-- <= 0)
			continue;
		ss_json_open(s, &level);
		ss_json_pair_iso8601(s, level, "finished_at", (time_t)r->end);
		ss_json_str(s, level, "array", r->array);
		ss_json_str(s, level, "command", r->command);
		ss_json_str(s, level, "result", r->status);
		ss_json_int(s, level, "exit_code", r->exit_code);
		ss_json_i64(s, level, "seconds", r->seconds);
		ss_json_u64(s, level, "errors_soft", r->soft);
		ss_json_u64(s, level, "errors_io", r->io);
		ss_json_u64(s, level, "errors_data", r->data);
		ss_json_u64(s, level, "recovered", r->recovered);
		ss_json_u64(s, level, "unrecoverable", r->unrecoverable);
		ss_json_i64(s, level, "added", r->added);
		ss_json_i64(s, level, "removed", r->removed);
		ss_json_i64(s, level, "updated", r->updated);
		ss_json_close(s, &level);
	}
	ss_json_array_close(s, &level);
	ss_json_uint(s, level, "total", total);
	ss_json_u64(s, level, "errors_found", found);
	ss_json_u64(s, level, "errors_fixed", fixed);
	ss_json_u64(s, level, "errors_lost", lost);
	if (first)
		ss_json_pair_iso8601(s, level, "since", (time_t)first);
	free(list);
}

/****************************************************************************/
/* an update of the protection as soon as enough files changed */

#define CHANGES_ARRAYS 64

/**
 * With the setting 'sync_changes', every 'sync_changes_minutes' the arrays
 * are looked at with a diff, and the maintenance is run when at least that
 * many files were added, changed or deleted. The safety limits apply as in
 * any automatic run.
 */
static void changes_tick(void)
{
	static struct {
		struct snapraid_state* state;
		time_t next;
		time_t asked; /**< When the diff was queued, 0 if none is awaited */
	} seen[CHANGES_ARRAYS];
	static unsigned seen_count;
	struct snapraid_state* look[CHANGES_ARRAYS];
	struct snapraid_state* go[CHANGES_ARRAYS];
	int64_t go_count[CHANGES_ARRAYS];
	unsigned look_n = 0;
	unsigned go_n = 0;

	int limit = kv_int("sync_changes", 0);
	if (limit <= 0) {
		seen_count = 0;
		return;
	}
	int minutes = kv_int("sync_changes_minutes", 60);
	if (minutes < 1)
		minutes = 1;
	time_t now = time(0);

	state_lock();
	for (tommy_node* i = tommy_list_head(&host_ptr()->state_list); i; i = i->next) {
		struct snapraid_state* state = i->data;
		unsigned k;
		for (k = 0; k < seen_count; ++k) {
			if (seen[k].state == state)
				break;
		}
		if (k == seen_count) {
			if (seen_count == CHANGES_ARRAYS)
				continue;
			seen[k].state = state;
			seen[k].next = now + minutes * 60;
			seen[k].asked = 0;
			++seen_count;
			continue;
		}

		int busy = (state->runner.latest && state->runner.latest->running) || !tommy_list_empty(&state->runner.waiting_list);

		if (seen[k].asked) {
			if (busy)
				continue;
			struct snapraid_task* diff = 0;
			for (tommy_node* j = tommy_list_head(&state->runner.history_list); j; j = j->next) {
				struct snapraid_task* t = j->data;
				if (t->cmd == CMD_DIFF && t->unix_end_time >= seen[k].asked && (diff == 0 || t->number > diff->number))
					diff = t;
			}
			if (!diff && now - seen[k].asked < 30 * 60)
				continue;
			seen[k].asked = 0;
			seen[k].next = now + minutes * 60;
			if (diff && diff->state == PROCESS_STATE_TERM) {
				int64_t changed = diff->diff_added + diff->diff_removed + diff->diff_updated;
				if (changed >= limit && go_n < CHANGES_ARRAYS) {
					go[go_n] = state;
					go_count[go_n] = changed;
					++go_n;
				}
			}
			continue;
		}

		if (now < seen[k].next)
			continue;
		if (busy || tommy_list_empty(&state->array.disk_list)) {
			seen[k].next = now + 60;
			continue;
		}
		seen[k].asked = now;
		if (look_n < CHANGES_ARRAYS)
			look[look_n++] = state;
	}
	state_unlock();

	for (unsigned k = 0; k < look_n; ++k) {
		char msg[MSG_MAX];
		int status = 0;
		if (storage_job_claims_array(look[k]->name))
			continue;
		runner(look[k], 0, CMD_DIFF, 0, 0, 0, msg, sizeof(msg), &status);
	}
	for (unsigned k = 0; k < go_n; ++k) {
		char msg[MSG_MAX];
		int status = 0;
		log_msg(LVL_INFO, "host: %" PRIi64 " files changed in the array %s, at least %d: updating the protection now", go_count[k], go[k]->name, limit);
		schedule_maintenance(go[k], -1, 1, msg, sizeof(msg), &status);
	}
}

/****************************************************************************/
/* battery backup (UPS): pause on battery, shut down before it's empty */

static struct {
	int configured;
	int known; /**< The latest read worked */
	int on_battery;
	int low; /**< The UPS itself says the battery is low */
	int charge; /**< Percent, -1 unknown */
	int runtime; /**< Seconds left, -1 unknown */
	time_t since; /**< Start of the time on battery */
	int low_reads; /**< Reads in a row asking for the shutdown */
	int shutdown_done;
	unsigned stopped; /**< Runs stopped in this time on battery */
	char text[128]; /**< Status as the UPS tells it */
	char error[160];
} ups;

static pthread_mutex_t ups_mutex = PTHREAD_MUTEX_INITIALIZER;

/** Value of "name: value" (NUT) or "NAME   : value" (apcupsd) in the output of the tool. */
static int ups_field(const char* text, const char* name, char* out, size_t out_size)
{
	size_t len = strlen(name);
	const char* p = text;

	out[0] = 0;
	while (p && *p) {
		if (strncmp(p, name, len) == 0) {
			const char* q = p + len;
			while (*q == ' ')
				++q;
			if (*q == ':') {
				++q;
				while (*q == ' ')
					++q;
				size_t l = strcspn(q, "\r\n");
				while (l > 0 && q[l - 1] == ' ')
					--l;
				if (l >= out_size)
					l = out_size - 1;
				memcpy(out, q, l);
				out[l] = 0;
				return 0;
			}
		}
		p = strchr(p, '\n');
		if (p)
			++p;
	}

	return -1;
}

/**
 * Read the state from the output of upsc or of apcaccess.
 * \return 0 if the output tells if it's on battery
 */
static int ups_parse(const char* text, int apc, int* on_battery, int* low, int* charge, int* runtime, char* status, size_t status_size)
{
	char v[128];

	*on_battery = 0;
	*low = 0;
	*charge = -1;
	*runtime = -1;

	if (apc) {
		if (ups_field(text, "STATUS", status, status_size) != 0)
			return -1;
		if (strstr(status, "COMMLOST") != 0)
			return -1;
		*on_battery = strstr(status, "ONBATT") != 0;
		*low = strstr(status, "LOWBATT") != 0;
		if (ups_field(text, "BCHARGE", v, sizeof(v)) == 0)
			*charge = atoi(v);
		if (ups_field(text, "TIMELEFT", v, sizeof(v)) == 0)
			*runtime = (int)(atof(v) * 60);
	} else {
		if (ups_field(text, "ups.status", status, status_size) != 0)
			return -1;
		/* flags separated by spaces: OL online, OB on battery, LB low battery */
		char buf[128];
		char* save = 0;
		int seen = 0;
		sncpy(buf, sizeof(buf), status);
		for (char* tok = strtok_r(buf, " ", &save); tok; tok = strtok_r(0, " ", &save)) {
			if (strcmp(tok, "OB") == 0) {
				*on_battery = 1;
				seen = 1;
			} else if (strcmp(tok, "OL") == 0) {
				seen = 1;
			} else if (strcmp(tok, "LB") == 0) {
				*low = 1;
			}
		}
		if (!seen)
			return -1;
		if (ups_field(text, "battery.charge", v, sizeof(v)) == 0)
			*charge = atoi(v);
		if (ups_field(text, "battery.runtime", v, sizeof(v)) == 0)
			*runtime = atoi(v);
	}

	return 0;
}

static int ups_read(const char* source, ss_t* out)
{
	if (strcmp(source, "apc") == 0) {
		const char* args[] = { "status", 0 };
		return tool_run("apcaccess", args, 0, out, 10);
	}
	const char* args[] = { source + 4, 0 };
	return tool_run("upsc", args, 0, out, 10);
}

/** Every look of the host thread, a few times a minute. */
static void ups_tick(void)
{
	char source[160];
	char status[128];
	ss_t out;
	int on_battery, low, charge, runtime;

	kv_get("ups", "", source, sizeof(source));
	if (source[0] == 0 || !valid_ups(source)) {
		pthread_mutex_lock(&ups_mutex);
		memset(&ups, 0, sizeof(ups));
		pthread_mutex_unlock(&ups_mutex);
		return;
	}

	ss_init(&out, 4096);
	int r = ups_read(source, &out);
	ss_write(&out, "", 1);
	int parsed = r == 0 ? ups_parse(ss_ptr(&out), strcmp(source, "apc") == 0, &on_battery, &low, &charge, &runtime, status, sizeof(status)) : -1;
	ss_done(&out);

	pthread_mutex_lock(&ups_mutex);
	ups.configured = 1;
	if (parsed != 0) {
		/* without news it's taken as it was: a lost cable is not a power cut */
		if (ups.known || ups.error[0] == 0)
			log_msg(LVL_WARNING, "host: the UPS %s does not answer", source);
		ups.known = 0;
		if (r == -2)
			snprintf(ups.error, sizeof(ups.error), "The tool %s is not installed", strcmp(source, "apc") == 0 ? "apcaccess" : "upsc");
		else
			snprintf(ups.error, sizeof(ups.error), "The UPS does not answer");
		pthread_mutex_unlock(&ups_mutex);
		return;
	}
	ups.known = 1;
	ups.error[0] = 0;
	ups.low = low;
	ups.charge = charge;
	ups.runtime = runtime;
	sncpy(ups.text, sizeof(ups.text), status);
	int was = ups.on_battery;
	ups.on_battery = on_battery;
	if (on_battery && !was) {
		ups.since = time(0);
		ups.stopped = 0;
		ups.low_reads = 0;
		ups.shutdown_done = 0;
		log_msg(LVL_WARNING, "host: power cut, the machine runs on the battery of the UPS (%d%%). The update of the protection and the check for damage wait for the power.", charge);
	}
	int back_minutes = !on_battery && was ? (int)((time(0) - ups.since) / 60) : -1;
	if (back_minutes >= 0)
		log_msg(LVL_WARNING, "host: the power is back after %d minutes on battery", back_minutes);
	pthread_mutex_unlock(&ups_mutex);

	if (on_battery && !was) {
		char text[128];
		snprintf(text, sizeof(text), "Running on the battery of the UPS, %d%% charged", charge);
		host_event("warn", "power_cut", source, text);
	}
	if (back_minutes >= 0) {
		char text[128];
		snprintf(text, sizeof(text), "Power back after %d minutes on battery", back_minutes);
		host_event("ok", "power_back", source, text);
	}

	if (!on_battery)
		return;

	/* on battery nothing heavy runs: a sync or a scrub goes on from where it stopped */
	struct snapraid_state* stop_list[64];
	unsigned n = 0;
	state_lock();
	for (tommy_node* i = tommy_list_head(&host_ptr()->state_list); i && n < 64; i = i->next) {
		struct snapraid_state* state = i->data;
		struct snapraid_task* task = state->runner.latest;
		if (task && task->running && (task->cmd == CMD_SCRUB || task->cmd == CMD_SYNC) && task->state != PROCESS_STATE_SIGNAL)
			stop_list[n++] = state;
	}
	state_unlock();
	for (unsigned k = 0; k < n; ++k) {
		char msg[MSG_MAX];
		int st;
		uint64_t pid;
		int number;
		log_msg(LVL_WARNING, "host: on battery, stopping the work on the array %s: the next run continues it", stop_list[k]->name);
		runner_stop(stop_list[k], msg, sizeof(msg), &st, &pid, &number);
	}
	if (n) {
		pthread_mutex_lock(&ups_mutex);
		ups.stopped += n;
		pthread_mutex_unlock(&ups_mutex);
	}

	if (!kv_int("ups_shutdown", 1))
		return;
	int percent = kv_int("ups_percent", 20);
	int minutes = kv_int("ups_minutes", 5);
	int due = low || (charge >= 0 && charge <= percent) || (runtime >= 0 && runtime <= minutes * 60);

	pthread_mutex_lock(&ups_mutex);
	ups.low_reads = due ? ups.low_reads + 1 : 0;
	/* two reads in a row: one odd value does not turn the machine off */
	int act = ups.low_reads >= 2 && !ups.shutdown_done;
	if (act)
		ups.shutdown_done = 1;
	pthread_mutex_unlock(&ups_mutex);
	if (!act)
		return;

	if (host_dryrun) {
		log_msg(LVL_WARNING, "host: the battery of the UPS is running out (%d%%, %d seconds left), would shut down (dry run)", charge, runtime);
		host_event("bad", "power_shutdown", source, "Battery running out: would shut down (dry run)");
		return;
	}
	log_msg(LVL_CRITICAL, "host: the battery of the UPS is running out (%d%%, %d seconds left): shutting down", charge, runtime);
	host_event("bad", "power_shutdown", source, "Battery running out: shutting down");
	sync();
	const char* args[] = { "poweroff", 0 };
	if (tool_run("systemctl", args, 0, 0, 60) != 0) {
		const char* sh[] = { "-h", "now", 0 };
		tool_run("shutdown", sh, 0, 0, 60);
	}
}

static void ups_json(ss_t* s, int level)
{
	pthread_mutex_lock(&ups_mutex);
	ss_json_object_open(s, &level, "ups");
	ss_json_bool(s, level, "configured", ups.configured);
	ss_json_str(s, level, "state", !ups.configured ? "off" : !ups.known ? "unknown" : !ups.on_battery ? "online" : ups.low ? "low" : "battery");
	if (ups.known) {
		ss_json_int(s, level, "charge", ups.charge);
		ss_json_int(s, level, "runtime_seconds", ups.runtime);
		ss_json_str(s, level, "status", ups.text);
		if (ups.on_battery) {
			ss_json_pair_iso8601(s, level, "since", ups.since);
			ss_json_uint(s, level, "stopped", ups.stopped);
			ss_json_bool(s, level, "shutdown", ups.shutdown_done);
		}
	}
	if (ups.error[0])
		ss_json_str(s, level, "error", ups.error);
	ss_json_close(s, &level);
	pthread_mutex_unlock(&ups_mutex);
}

/** The UPS units the tools on this machine know of. */
static void ups_detect_json(ss_t* s, int level)
{
	ss_t out;

	ss_json_bool(s, level, "upsc", tool_exists("upsc"));
	ss_json_bool(s, level, "apcaccess", tool_exists("apcaccess"));
	ss_json_array_open(s, &level, "found");
	ss_init(&out, 1024);
	const char* list[] = { "-l", 0 };
	if (tool_run("upsc", list, 0, &out, 10) == 0) {
		ss_write(&out, "", 1);
		char* save = 0;
		for (char* line = strtok_r(ss_ptr(&out), "\n", &save); line; line = strtok_r(0, "\n", &save)) {
			char id[160];
			strtrim(line);
			snprintf(id, sizeof(id), "nut:%.120s", line);
			if (line[0] && valid_ups(id))
				ss_json_elem(s, level, id);
		}
	}
	ss_done(&out);
	ss_init(&out, 1024);
	const char* st[] = { "status", 0 };
	if (tool_run("apcaccess", st, 0, &out, 10) == 0) {
		char v[64];
		ss_write(&out, "", 1);
		if (ups_field(ss_ptr(&out), "STATUS", v, sizeof(v)) == 0)
			ss_json_elem(s, level, "apc");
	}
	ss_done(&out);
	ss_json_array_close(s, &level);
}

/****************************************************************************/
/* alerts on more channels at once */

#define ALERTS_NAME "snapraidd-alerts.sh"
#define ALERTS_MAX 8

static const char* const ALERT_OPTIONS[] = {
	"kind:n", "url:w", "token:k", "chat:k", "to:k", 0
};

/**
 * Write the script that sends one report to every channel.
 * \param channels One channel for each line, as options "kind=ntfy<TAB>url=https://..."
 */
static int alerts_save(const char* channels, ss_t* s, int level, char* msg, size_t msg_size)
{
	char path[PATH_MAX];
	char buf[8192];
	ss_t sh;
	unsigned n = 0;
	char run_as[CONFIG_MAX];

	if (strlen(channels) >= sizeof(buf))
		return hfail(msg, msg_size, 400, "Too many channels");
	sncpy(buf, sizeof(buf), channels);
	host_side_path(ALERTS_NAME, path, sizeof(path));

	ss_init(&sh, 4096);
	ss_prints(&sh, "#!/bin/sh\n");
	ss_prints(&sh, "# Sends a report of the SnapRAID Daemon to every channel chosen in the Alerts page.\n");
	ss_prints(&sh, "# Written by the daemon: a change made by hand is lost at the next save.\n");
	ss_prints(&sh, "# Arguments: subject, priority, tag. The text of the report comes from the standard input.\n");

	ss_t body;
	ss_init(&body, 4096);
	char* save = 0;
	for (char* line = strtok_r(buf, "\n", &save); line; line = strtok_r(0, "\n", &save)) {
		char kind[32], url[1100], token[128], chat[64], to[256];
		if (line[0] == 0)
			continue;
		if (++n > ALERTS_MAX) {
			ss_done(&sh);
			ss_done(&body);
			return hfail(msg, msg_size, 400, "Up to %d channels", ALERTS_MAX);
		}
		int ret = valid_options_line(line, ALERT_OPTIONS, msg, msg_size);
		if (ret != 0) {
			ss_done(&sh);
			ss_done(&body);
			return ret;
		}
		opt_get(line, "kind", kind, sizeof(kind));
		opt_get(line, "url", url, sizeof(url));
		opt_get(line, "token", token, sizeof(token));
		opt_get(line, "chat", chat, sizeof(chat));
		opt_get(line, "to", to, sizeof(to));

		int ok = 1;
		if (strcmp(kind, "ntfy") == 0 && url[0]) {
			ss_printf(&body, "curl -fsS --max-time 30 --retry 3 -H \"Title: $1\" -H \"Priority: $2\" -H \"Tags: $3\" --data-binary @\"$t\" '%s' > /dev/null || r=1\n", url);
		} else if (strcmp(kind, "webhook") == 0 && url[0]) {
			ss_printf(&body, "curl -fsS --max-time 30 --retry 3 -H \"Title: $1\" --data-binary @\"$t\" '%s' > /dev/null || r=1\n", url);
		} else if (strcmp(kind, "discord") == 0 && url[0]) {
			ss_printf(&body, "curl -fsS --max-time 30 --retry 3 -H \"Content-Type: application/json\" -d \"{\\\"content\\\": \\\"$1\\\"}\" '%s' > /dev/null || r=1\n", url);
		} else if (strcmp(kind, "telegram") == 0 && token[0] && chat[0]) {
			ss_printf(&body, "curl -fsS --max-time 30 --retry 3 --data-urlencode 'chat_id=%s' --data-urlencode \"text=$1\" 'https://api.telegram.org/bot%s/sendMessage' > /dev/null || r=1\n", chat, token);
		} else if (strcmp(kind, "email") == 0 && to[0] && to[0] != '-') {
			ss_printf(&body, "mail -s \"$1\" '%s' < \"$t\" || r=1\n", to);
		} else {
			ok = 0;
		}
		if (!ok) {
			ss_done(&sh);
			ss_done(&body);
			return hfail(msg, msg_size, 400, "A channel is not complete");
		}
		ss_printf(&sh, "# channel\t%s\n", line);
	}

	if (n == 0) {
		ss_done(&sh);
		ss_done(&body);
		priv_enter();
		unlink(path);
		priv_leave();
		ss_json_str(s, level, "command", "");
		return 0;
	}

	ss_prints(&sh, "t=$(mktemp) || exit 1\ncat > \"$t\"\nr=0\n");
	ss_write(&body, "", 1);
	ss_prints(&sh, ss_ptr(&body));
	ss_prints(&sh, "rm -f \"$t\"\nexit $r\n");
	ss_write(&sh, "", 1);
	ss_done(&body);

	/* the addresses are secrets: only who sends the reports reads the script */
	int ret = file_replace(path, ss_ptr(&sh), 0, 0700);
	ss_done(&sh);
	if (ret != 0)
		return hfail(msg, msg_size, 500, "Cannot write %s: %s", path, strerror(errno));

	state_lock();
	sncpy(run_as, sizeof(run_as), state_ptr()->config.notify_run_as_user);
	state_unlock();
	if (run_as[0]) {
		struct passwd* pw = getpwnam(run_as);
		if (pw) {
			priv_enter();
			if (chown(path, pw->pw_uid, pw->pw_gid) != 0)
				log_msg(LVL_WARNING, "host: cannot give %s to %s", path, run_as);
			priv_leave();
		}
	}

	char cmd[PATH_MAX + 32];
	snprintf(cmd, sizeof(cmd), "%s \"%%s\" \"%%n\" \"%%t\"", path);
	ss_json_str(s, level, "command", cmd);
	ss_json_uint(s, level, "channels", n);
	log_msg(LVL_INFO, "host: alerts go to %u channels with %s", n, path);

	return 0;
}

/** The channels of the script, to show them again. */
static void alerts_json(ss_t* s, int level)
{
	char path[PATH_MAX];
	ss_t text;

	host_side_path(ALERTS_NAME, path, sizeof(path));
	ss_json_str(s, level, "script", path);
	ss_json_array_open(s, &level, "channels");
	ss_init(&text, 4096);
	priv_enter();
	int r = file_read(path, &text);
	priv_leave();
	if (r == 0) {
		ss_write(&text, "", 1);
		char* save = 0;
		for (char* line = strtok_r(ss_ptr(&text), "\n", &save); line; line = strtok_r(0, "\n", &save)) {
			if (strncmp(line, "# channel\t", 10) != 0)
				continue;
			ss_json_open(s, &level);
			options_json(s, level, line + 10, ALERT_OPTIONS);
			ss_json_close(s, &level);
		}
	}
	ss_done(&text);
	ss_json_array_close(s, &level);
}

/****************************************************************************/
/* disks plugged in for a while: mount without a trace, and safe removal */

/** Mount points of the filesystems of a whole disk, as lines. */
static unsigned disk_mounts(const char* disk, char out[][PATH_MAX], unsigned max)
{
	ss_t s;
	struct mount_entry entry;
	unsigned n = 0;
	int r;

	ss_init(&s, 4096);
	if (file_read("/proc/self/mounts", &s) == 0) {
		const char* cursor = ss_ptr(&s);
		while ((r = mount_next(&cursor, &entry, 0, 0)) >= 0 && n < max) {
			char base[64];
			char sys[PATH_MAX];
			if (r != 1 || strncmp(entry.source, "/dev/", 5) != 0)
				continue;
			if (device_base(entry.source, base, sizeof(base)) != 0)
				continue;
			snprintf(sys, sizeof(sys), "/sys/block/%s/%s", disk, base);
			if (strcmp(base, disk) == 0 || access(sys, F_OK) == 0)
				sncpy(out[n++], PATH_MAX, entry.target);
		}
	}
	ss_done(&s);

	return n;
}

/** The whole disk of a device, itself when it's not a partition. */
static int device_disk(const char* device, char* disk, size_t disk_size)
{
	char name[64];
	char path[PATH_MAX];
	char real[PATH_MAX];

	if (strncmp(device, "/dev/", 5) != 0 || !valid_path(device) || device_base(device, name, sizeof(name)) != 0)
		return -1;
	snprintf(path, sizeof(path), "/sys/class/block/%s", name);
	if (realpath(path, real) == 0)
		return -1;
	snprintf(path, sizeof(path), "/sys/class/block/%s/partition", name);
	if (access(path, F_OK) != 0) {
		sncpy(disk, disk_size, name);
		return 0;
	}
	/* /sys/devices/.../sdb/sdb1: the folder above is the disk */
	char* slash = strrchr(real, '/');
	if (!slash)
		return -1;
	*slash = 0;
	slash = strrchr(real, '/');
	if (!slash)
		return -1;
	sncpy(disk, disk_size, slash + 1);
	return 0;
}

/** Tell if the disk is one of an array, to never take it away by mistake. */
static int disk_of_array(const char* disk, char* msg, size_t msg_size)
{
	struct host_disk* disks = malloc_nofail(sizeof(struct host_disk) * HOST_DISKS_MAX);
	unsigned count = host_disks(disks, HOST_DISKS_MAX);
	int ret = 0;

	for (unsigned i = 0; i < count && ret == 0; ++i) {
		char other[64];
		if (disks[i].device[0] && device_disk(disks[i].device, other, sizeof(other)) == 0 && strcmp(other, disk) == 0)
			ret = hfail(msg, msg_size, 409, "/dev/%s is the disk %s of the array %s. Remove it from the array first.", disk, disks[i].name, disks[i].array);
	}
	free(disks);

	return ret;
}

/** Mount a filesystem under /media until it's ejected or the machine restarts. Nothing is written in fstab. */
static int usb_mount(const char* device, ss_t* s, int level, char* msg, size_t msg_size)
{
	char disk[64];
	char name[64];
	char target[PATH_MAX];
	char label[128];
	ss_t out;

	if (device_disk(device, disk, sizeof(disk)) != 0 || device_base(device, name, sizeof(name)) != 0)
		return hfail(msg, msg_size, 400, "%s is not a disk or a part of one", device);
	int ret = disk_of_array(disk, msg, msg_size);
	if (ret != 0)
		return ret;

	ss_t all;
	struct mount_entry entry;
	int r;
	ss_init(&all, 4096);
	if (file_read("/proc/self/mounts", &all) == 0) {
		const char* cursor = ss_ptr(&all);
		while ((r = mount_next(&cursor, &entry, 0, 0)) >= 0) {
			char base[64];
			if (r == 1 && strncmp(entry.source, "/dev/", 5) == 0 && device_base(entry.source, base, sizeof(base)) == 0 && strcmp(base, name) == 0) {
				ss_done(&all);
				ss_json_str(s, level, "target", entry.target);
				return 0; /* already there */
			}
		}
	}
	ss_done(&all);

	/* the folder takes the label of the filesystem, when it has a plain one */
	label[0] = 0;
	ss_init(&out, 256);
	const char* blk[] = { "-s", "LABEL", "-o", "value", device, 0 };
	if (tool_run("blkid", blk, 0, &out, 30) == 0) {
		ss_write(&out, "", 1);
		sncpy(label, sizeof(label), ss_ptr(&out));
		strtrim(label);
		for (char* c = label; *c; ++c) {
			if (!isalnum((unsigned char)*c) && *c != '-' && *c != '_')
				*c = '_';
		}
		if (strlen(label) > 32)
			label[32] = 0;
	}
	ss_done(&out);
	snprintf(target, sizeof(target), "/media/%s", label[0] ? label : name);
	struct stat st;
	struct mount_entry busy;
	if (mount_find(target, &busy) == 0 || (lstat(target, &st) == 0 && !S_ISDIR(st.st_mode)))
		snprintf(target, sizeof(target), "/media/%s-%s", label[0] ? label : "disk", name);

	if (make_dirs(target) != 0)
		return hfail(msg, msg_size, 500, "Cannot create %s: %s", target, strerror(errno));
	const char* args[] = { "-o", "nosuid,nodev", device, target, 0 };
	if (tool_check("mount", args, 0, 120, msg, msg_size) != 0) {
		dir_remove(target);
		return 500;
	}

	ss_json_str(s, level, "target", target);
	log_msg(LVL_INFO, "host: %s mounted in %s until it's ejected", device, target);
	host_event("info", "usb_open", device, target);
	return 0;
}

/** Unmount every filesystem of a disk and turn it off, so it can be unplugged. */
static int usb_eject(const char* device, ss_t* s, int level, char* msg, size_t msg_size)
{
	char disk[64];
	char path[PATH_MAX];
	char mounts[16][PATH_MAX];

	if (device_disk(device, disk, sizeof(disk)) != 0)
		return hfail(msg, msg_size, 400, "%s is not a disk", device);
	int ret = disk_of_array(disk, msg, msg_size);
	if (ret != 0)
		return ret;
	if (job_is_running())
		return hfail(msg, msg_size, 409, "A storage operation is running. Wait for it to finish, then eject the disk.");

	unsigned n = disk_mounts(disk, mounts, 16);
	for (unsigned i = 0; i < n; ++i) {
		if (strcmp(mounts[i], "/") == 0 || strcmp(mounts[i], "/boot") == 0 || strncmp(mounts[i], "/boot/", 6) == 0 || system_path(mounts[i]))
			return hfail(msg, msg_size, 409, "/dev/%s holds the system of this machine: it cannot be ejected", disk);
	}
	/* a pool would lose a disk under its feet */
	{
		ss_t all;
		struct mount_entry entry;
		struct pool_branch* branches = malloc_nofail(sizeof(struct pool_branch) * 64);
		char pool[PATH_MAX];
		int r;
		pool[0] = 0;
		ss_init(&all, 4096);
		if (file_read("/proc/self/mounts", &all) == 0) {
			const char* cursor = ss_ptr(&all);
			while (pool[0] == 0 && (r = mount_next(&cursor, &entry, 0, 0)) >= 0) {
				unsigned count = 64;
				char why[MSG_MAX];
				if (r != 1 || !is_mergerfs(entry.fstype) || pool_branches(entry.target, branches, &count, why, sizeof(why)) != 0)
					continue;
				for (unsigned b = 0; b < count && pool[0] == 0; ++b) {
					for (unsigned i = 0; i < n; ++i) {
						if (strcmp(branches[b].path, mounts[i]) == 0 || path_inside(branches[b].path, mounts[i]))
							sncpy(pool, sizeof(pool), entry.target);
					}
				}
			}
		}
		ss_done(&all);
		free(branches);
		if (pool[0])
			return hfail(msg, msg_size, 409, "/dev/%s is part of the pool %.200s. Take it out of the pool first.", disk, pool);
	}

	sync();
	for (unsigned i = 0; i < n; ++i) {
		const char* args[] = { mounts[i], 0 };
		char why[MSG_MAX];
		if (tool_check("umount", args, 0, 120, why, sizeof(why)) != 0)
			return hfail(msg, msg_size, 409, "%s is in use: close the files and the programs using it, then try again. (%.200s)", mounts[i], why);
		if (strncmp(mounts[i], "/media/", 7) == 0 || strncmp(mounts[i], "/mnt/backup-", 12) == 0)
			dir_remove(mounts[i]);
	}

	/* stop the disk and take it off the bus: the light goes off, the heads are parked */
	snprintf(path, sizeof(path), "/sys/block/%s/device/delete", disk);
	priv_enter();
	int f = open(path, O_WRONLY | O_CLOEXEC);
	int off = 0;
	if (f >= 0) {
		off = write(f, "1\n", 2) == 2;
		close(f);
	}
	priv_leave();

	ss_json_bool(s, level, "powered_off", off);
	ss_json_uint(s, level, "unmounted", n);
	ss_json_str(s, level, "note", off ? "The disk is off: it can be unplugged now" : "Nothing of the disk is in use any more: it can be unplugged now");
	log_msg(LVL_INFO, "host: /dev/%s ejected, %u filesystems unmounted%s", disk, n, off ? ", powered off" : "");
	host_event("info", "usb_eject", disk, off ? "Ejected and turned off: it can be unplugged" : "Ejected: it can be unplugged");

	return 0;
}

/****************************************************************************/
/* folders shared by other computers, as sources of the backups */

#define REMOTE_DIR "/mnt/remote"
#define REMOTES_MAX 32

static void remote_target(const char* name, char* out, size_t out_size)
{
	snprintf(out, out_size, "%s/%s", REMOTE_DIR, name);
}

static void remote_cred_path(const char* name, char* out, size_t out_size)
{
	char file[128];

	snprintf(file, sizeof(file), "snapraidd-remote-%s.cred", name);
	host_side_path(file, out, out_size);
}

/** Name of the remote a path is in, if it's inside /mnt/remote/NAME. */
static int remote_of_path(const char* path, char* name, size_t name_size)
{
	size_t len = strlen(REMOTE_DIR);

	if (strncmp(path, REMOTE_DIR, len) != 0 || path[len] != '/')
		return -1;
	const char* p = path + len + 1;
	size_t l = strcspn(p, "/");
	if (l == 0 || l >= name_size)
		return -1;
	memcpy(name, p, l);
	name[l] = 0;
	return valid_name(name) ? 0 : -1;
}

/**
 * Mount the folder of another computer, read-only.
 * \return 0 if mounted now, 1 if it was already, otherwise the HTTP status
 */
static int remote_mount(const char* name, char* msg, size_t msg_size)
{
	char key[128];
	char line[2048];
	char kind[16], host[256], share[512], user[256], domain[64], vers[16];
	char target[PATH_MAX];
	char source[1024];
	char options[PATH_MAX + 512];
	struct mount_entry entry;

	snprintf(key, sizeof(key), "remote.%s", name);
	kv_get(key, "", line, sizeof(line));
	if (line[0] == 0)
		return hfail(msg, msg_size, 404, "There is no folder of another computer named %s", name);
	opt_get(line, "kind", kind, sizeof(kind));
	opt_get(line, "host", host, sizeof(host));
	opt_get(line, "share", share, sizeof(share));
	opt_get(line, "user", user, sizeof(user));
	opt_get(line, "domain", domain, sizeof(domain));
	opt_get(line, "vers", vers, sizeof(vers));

	remote_target(name, target, sizeof(target));
	if (mount_find(target, &entry) == 0)
		return 1;
	if (make_dirs(target) != 0)
		return hfail(msg, msg_size, 500, "Cannot create %s: %s", target, strerror(errno));

	const char* type;
	if (strcmp(kind, "nfs") == 0) {
		type = "nfs";
		if (!tool_exists("mount.nfs"))
			return hfail(msg, msg_size, 501, "To read NFS folders this machine needs the package nfs-common (nfs-utils on Fedora)");
		snprintf(source, sizeof(source), "%s:%s%s", host, share[0] == '/' ? "" : "/", share);
		snprintf(options, sizeof(options), "ro,nosuid,nodev,noexec,soft,timeo=100,retrans=2");
	} else {
		type = "cifs";
		if (!tool_exists("mount.cifs"))
			return hfail(msg, msg_size, 501, "To read Windows (SMB) folders this machine needs the package cifs-utils");
		const char* sh = share;
		while (*sh == '/' || *sh == '\\')
			++sh;
		snprintf(source, sizeof(source), "//%s/%s", host, sh);
		if (user[0]) {
			char cred[PATH_MAX];
			remote_cred_path(name, cred, sizeof(cred));
			snprintf(options, sizeof(options), "ro,nosuid,nodev,noexec,iocharset=utf8,credentials=%s", cred);
		} else {
			snprintf(options, sizeof(options), "ro,nosuid,nodev,noexec,iocharset=utf8,guest");
		}
		if (vers[0]) {
			sncat(options, sizeof(options), ",vers=");
			sncat(options, sizeof(options), vers);
		}
	}

	const char* args[] = { "-t", type, "-o", options, source, target, 0 };
	char why[MSG_MAX];
	if (tool_check("mount", args, 0, 60, why, sizeof(why)) != 0) {
		dir_remove(target);
		const char* hint = "";
		if (strstr(why, "ermission denied") != 0 || strstr(why, "error(13)") != 0)
			hint = "The other computer refused the name or the password. ";
		else if (strstr(why, "o route") != 0 || strstr(why, "error(113)") != 0 || strstr(why, "error(112)") != 0 || strstr(why, "timed out") != 0 || strstr(why, "could not resolve") != 0 || strstr(why, "esolv") != 0)
			hint = "The other computer does not answer: check its name or address, and that it's on. ";
		else if (strstr(why, "error(2)") != 0 || strstr(why, "o such file") != 0 || strstr(why, "access denied by server") != 0)
			hint = "The other computer has no shared folder with this name, or does not let this machine read it. ";
		return hfail(msg, msg_size, 502, "%s(%.300s)", hint, why);
	}

	log_msg(LVL_INFO, "host: %s mounted read-only in %s", source, target);
	return 0;
}

static void remote_unmount(const char* name)
{
	char target[PATH_MAX];
	struct mount_entry entry;

	remote_target(name, target, sizeof(target));
	if (mount_find(target, &entry) != 0)
		return;
	const char* args[] = { target, 0 };
	if (tool_run("umount", args, 0, 0, 120) != 0) {
		const char* lazy[] = { "-l", target, 0 };
		tool_run("umount", lazy, 0, 0, 120);
	}
	dir_remove(target);
}

static int remote_save(const struct host_args* args, char* msg, size_t msg_size)
{
	char key[128];
	char line[2048];
	char v[512];
	const char* name = host_arg(args, "name");
	const char* password = host_arg(args, "password");

	if (!name || !valid_name(name))
		return hfail(msg, msg_size, 400, "A name has only letters, digits, - and _ (up to 32)");
	snprintf(key, sizeof(key), "remote.%s", name);
	line[0] = 0;
	for (unsigned i = 0; REMOTE_OPTIONS[i]; ++i) {
		char opt[32];
		sncpy(opt, sizeof(opt), REMOTE_OPTIONS[i]);
		*strchr(opt, ':') = 0;
		const char* val = host_arg(args, opt);
		if (!val || val[0] == 0)
			continue;
		if (line[0])
			sncat(line, sizeof(line), "\t");
		sncat(line, sizeof(line), opt);
		sncat(line, sizeof(line), "=");
		sncat(line, sizeof(line), val);
	}

	int ret = valid_options_line(line, REMOTE_OPTIONS, msg, msg_size);
	if (ret != 0)
		return ret;
	if (opt_get(line, "kind", v, sizeof(v)) != 0 || (strcmp(v, "smb") != 0 && strcmp(v, "nfs") != 0))
		return hfail(msg, msg_size, 400, "The kind is smb (Windows, Mac, NAS) or nfs (Linux)");
	int nfs = strcmp(v, "nfs") == 0;
	if (opt_get(line, "host", v, sizeof(v)) != 0)
		return hfail(msg, msg_size, 400, "Missing name or address of the other computer");
	if (opt_get(line, "share", v, sizeof(v)) != 0 || strchr(v, ',') != 0 || strstr(v, "..") != 0 || (!nfs && strpbrk(v, " ") == v))
		return hfail(msg, msg_size, 400, "Missing or invalid name of the shared folder");
	if (opt_get(line, "user", v, sizeof(v)) == 0 && strpbrk(v, ",\n") != 0)
		return hfail(msg, msg_size, 400, "Invalid user name");
	if (password && strpbrk(password, "\r\n") != 0)
		return hfail(msg, msg_size, 400, "Invalid password");

	/* the password is kept apart from the settings, readable by root only */
	if (!nfs && opt_get(line, "user", v, sizeof(v)) == 0) {
		char cred[PATH_MAX];
		char domain[64];
		remote_cred_path(name, cred, sizeof(cred));
		if (password && password[0]) {
			ss_t c;
			ss_init(&c, 512);
			ss_printf(&c, "username=%s\npassword=%s\n", v, password);
			if (opt_get(line, "domain", domain, sizeof(domain)) == 0 && domain[0])
				ss_printf(&c, "domain=%s\n", domain);
			ss_write(&c, "", 1);
			int w = file_replace(cred, ss_ptr(&c), 0, 0600);
			memset(ss_ptr(&c), 0, ss_len(&c));
			ss_done(&c);
			if (w != 0)
				return hfail(msg, msg_size, 500, "Cannot write %s: %s", cred, strerror(errno));
		} else {
			priv_enter();
			int have = access(cred, F_OK) == 0;
			priv_leave();
			if (!have)
				return hfail(msg, msg_size, 400, "Missing password");
		}
	}

	/* the next use mounts it again with what was saved */
	remote_unmount(name);

	return setting_store(key, line, msg, msg_size);
}

static int remote_delete(const char* name, char* msg, size_t msg_size)
{
	char key[128];
	char cred[PATH_MAX];
	char target[PATH_MAX + 2];

	if (!valid_name(name))
		return hfail(msg, msg_size, 400, "Invalid name");

	/* not while a backup reads from it */
	remote_target(name, target, sizeof(target));
	size_t len = strlen(target);
	pthread_mutex_lock(&host_mutex);
	const char* user = 0;
	for (unsigned i = 0; i < kv_count && !user; ++i) {
		char src[PATH_MAX];
		if (strncmp(kv_list[i].key, "backup.", 7) != 0 || opt_get(kv_list[i].val, "source", src, sizeof(src)) != 0)
			continue;
		if (strncmp(src, target, len) == 0 && (src[len] == 0 || src[len] == '/'))
			user = kv_list[i].key + 7;
	}
	char by[64];
	sncpy(by, sizeof(by), user ? user : "");
	pthread_mutex_unlock(&host_mutex);
	if (by[0])
		return hfail(msg, msg_size, 409, "The backup %s copies from this folder. Delete or change the backup first.", by);

	remote_unmount(name);
	remote_cred_path(name, cred, sizeof(cred));
	priv_enter();
	unlink(cred);
	priv_leave();
	snprintf(key, sizeof(key), "remote.%s", name);

	return setting_store(key, "", msg, msg_size);
}

/** Try the folder: mount it, tell what is inside, and leave it as it was. */
static int remote_test(const char* name, ss_t* s, int level, char* msg, size_t msg_size)
{
	char target[PATH_MAX];

	if (!valid_name(name))
		return hfail(msg, msg_size, 400, "Invalid name");
	int r = remote_mount(name, msg, msg_size);
	if (r != 0 && r != 1)
		return r;

	remote_target(name, target, sizeof(target));
	unsigned entries = 0;
	ss_json_array_open(s, &level, "folders");
	priv_enter();
	DIR* d = opendir(target);
	priv_leave();
	if (d) {
		struct dirent* dd;
		while ((dd = readdir(d)) != 0) {
			if (dd->d_name[0] == '.')
				continue;
			++entries;
			struct stat st;
			if (entries <= 200 && fstatat(dirfd(d), dd->d_name, &st, 0) == 0 && S_ISDIR(st.st_mode))
				ss_json_elem(s, level, dd->d_name);
		}
		closedir(d);
	}
	ss_json_array_close(s, &level);
	ss_json_uint(s, level, "entries", entries);
	ss_json_str(s, level, "target", target);

	if (r == 0 && !job_is_running())
		remote_unmount(name);

	return 0;
}

static void remotes_json(ss_t* s, int level)
{
	ss_json_array_open(s, &level, "remotes");
	for (unsigned i = 0; i < kv_count; ++i) {
		char target[PATH_MAX];
		char user[256];
		struct mount_entry entry;
		if (strncmp(kv_list[i].key, "remote.", 7) != 0)
			continue;
		const char* name = kv_list[i].key + 7;
		remote_target(name, target, sizeof(target));
		ss_json_open(s, &level);
		ss_json_str(s, level, "name", name);
		options_json(s, level, kv_list[i].val, REMOTE_OPTIONS);
		ss_json_str(s, level, "target", target);
		ss_json_bool(s, level, "password", opt_get(kv_list[i].val, "user", user, sizeof(user)) == 0 && user[0] != 0);
		ss_json_bool(s, level, "mounted", mount_find(target, &entry) == 0);
		ss_json_close(s, &level);
	}
	ss_json_array_close(s, &level);
}

static void status_json(ss_t* s, int level)
{
	struct statvfs vfs;

	ss_json_str(s, level, "settings_file", host_conf_path);
	ss_json_bool(s, level, "dry_run", host_dryrun);

	ss_json_object_open(s, &level, "tools");
	static const char* TOOLS[] = { "smartctl", "hdparm", "rsync", "smbd", "exportfs", "ethtool", "systemctl", "mergerfs", "upsc", "apcaccess", "mount.cifs", "mount.nfs", 0 };
	for (unsigned i = 0; TOOLS[i]; ++i)
		ss_json_bool(s, level, TOOLS[i], tool_exists(TOOLS[i]));
	ss_json_close(s, &level);

	pthread_mutex_lock(&host_mutex);

	ss_json_object_open(s, &level, "settings");
	for (unsigned i = 0; i < kv_count; ++i) {
		if (strchr(kv_list[i].key, '.') == 0)
			ss_json_str(s, level, kv_list[i].key, kv_list[i].val);
	}
	ss_json_close(s, &level);

	ss_json_object_open(s, &level, "docs");
	for (unsigned i = 0; i < kv_count; ++i) {
		if (strncmp(kv_list[i].key, "doc.", 4) == 0)
			ss_jsonf(s, level, "\"%s\": %s,\n", kv_list[i].key + 4, kv_list[i].val);
	}
	ss_json_close(s, &level);

	ss_json_array_open(s, &level, "shares");
	for (unsigned i = 0; i < kv_count; ++i) {
		if (strncmp(kv_list[i].key, "share.", 6) != 0)
			continue;
		ss_json_open(s, &level);
		ss_json_str(s, level, "name", kv_list[i].key + 6);
		options_json(s, level, kv_list[i].val, SHARE_OPTIONS);
		ss_json_close(s, &level);
	}
	ss_json_array_close(s, &level);

	ss_json_array_open(s, &level, "backups");
	for (unsigned i = 0; i < kv_count; ++i) {
		if (strncmp(kv_list[i].key, "backup.", 7) != 0)
			continue;
		const char* name = kv_list[i].key + 7;
		char key[128];
		ss_json_open(s, &level);
		ss_json_str(s, level, "name", name);
		options_json(s, level, kv_list[i].val, BACKUP_OPTIONS);
		snprintf(key, sizeof(key), "last.backup.%s", name);
		const char* last = kv_get_locked(key, "");
		if (last[0]) {
			char buf[MSG_MAX + 64];
			sncpy(buf, sizeof(buf), last);
			char* t1 = strchr(buf, '\t');
			char* t2 = t1 ? strchr(t1 + 1, '\t') : 0;
			if (t1 && t2) {
				*t1 = *t2 = 0;
				ss_json_i64(s, level, "last_time", strtoll(buf, 0, 10));
				ss_json_int(s, level, "last_status", atoi(t1 + 1));
				ss_json_str(s, level, "last_message", t2 + 1);
			}
		}
		char uuid[64];
		if (opt_get(kv_list[i].val, "dest_uuid", uuid, sizeof(uuid)) == 0) {
			char dev[PATH_MAX];
			char target[PATH_MAX];
			snprintf(dev, sizeof(dev), "/dev/disk/by-uuid/%s", uuid);
			ss_json_bool(s, level, "plugged", access(dev, F_OK) == 0);
			if (uuid_mount(uuid, target, sizeof(target)) == 0)
				ss_json_str(s, level, "mounted_at", target);
		}
		ss_json_close(s, &level);
	}
	ss_json_array_close(s, &level);

	ss_json_array_open(s, &level, "caches");
	for (unsigned i = 0; i < kv_count; ++i) {
		if (strncmp(kv_list[i].key, "cache.", 6) != 0)
			continue;
		const char* name = kv_list[i].key + 6;
		char key[128];
		char branch[PATH_MAX];
		ss_json_open(s, &level);
		ss_json_str(s, level, "name", name);
		options_json(s, level, kv_list[i].val, CACHE_OPTIONS);
		snprintf(key, sizeof(key), "last.cache.%s", name);
		const char* last = kv_get_locked(key, "");
		if (last[0]) {
			char buf[MSG_MAX + 64];
			sncpy(buf, sizeof(buf), last);
			char* t1 = strchr(buf, '\t');
			char* t2 = t1 ? strchr(t1 + 1, '\t') : 0;
			if (t1 && t2) {
				*t1 = *t2 = 0;
				ss_json_i64(s, level, "last_time", strtoll(buf, 0, 10));
				ss_json_int(s, level, "last_status", atoi(t1 + 1));
				ss_json_str(s, level, "last_message", t2 + 1);
			}
		}
		if (opt_get(kv_list[i].val, "branch", branch, sizeof(branch)) == 0 && statvfs(branch, &vfs) == 0) {
			ss_json_u64(s, level, "total_bytes", (uint64_t)vfs.f_blocks * vfs.f_frsize);
			ss_json_u64(s, level, "free_bytes", (uint64_t)vfs.f_bavail * vfs.f_frsize);
			ss_json_u64(s, level, "used_bytes", (uint64_t)(vfs.f_blocks - vfs.f_bfree) * vfs.f_frsize);

			/* what waits on it, and is not protected yet */
			struct cache_count count = { 0, 0 };
			priv_enter();
			cache_count_dir(branch, 0, &count);
			priv_leave();
			ss_json_uint(s, level, "waiting_files", count.files);
			ss_json_u64(s, level, "waiting_bytes", count.bytes);
			ss_json_bool(s, level, "waiting_more", count.files >= CACHE_COUNT_MAX);
		}
		ss_json_close(s, &level);
	}
	ss_json_array_close(s, &level);

	ss_json_array_open(s, &level, "keeps");
	for (unsigned i = 0; i < kv_count; ++i) {
		if (strncmp(kv_list[i].key, "keep.", 5) != 0)
			continue;
		const char* name = kv_list[i].key + 5;
		char key[128];
		ss_json_open(s, &level);
		ss_json_str(s, level, "name", name);
		options_json(s, level, kv_list[i].val, KEEP_OPTIONS);
		snprintf(key, sizeof(key), "last.keep.%s", name);
		const char* last = kv_get_locked(key, "");
		if (last[0]) {
			char buf[MSG_MAX + 64];
			sncpy(buf, sizeof(buf), last);
			char* t1 = strchr(buf, '\t');
			char* t2 = t1 ? strchr(t1 + 1, '\t') : 0;
			if (t1 && t2) {
				*t1 = *t2 = 0;
				ss_json_i64(s, level, "last_time", strtoll(buf, 0, 10));
				ss_json_int(s, level, "last_status", atoi(t1 + 1));
				ss_json_str(s, level, "last_message", t2 + 1);
			}
		}
		ss_json_close(s, &level);
	}
	ss_json_array_close(s, &level);

	ss_json_array_open(s, &level, "power");
	for (unsigned i = 0; i < kv_count; ++i) {
		if (strncmp(kv_list[i].key, "power.", 6) != 0)
			continue;
		ss_json_open(s, &level);
		ss_json_str(s, level, "disk", kv_list[i].key + 6);
		options_json(s, level, kv_list[i].val, POWER_OPTIONS);
		ss_json_close(s, &level);
	}
	ss_json_array_close(s, &level);

	remotes_json(s, level);

	ss_json_object_open(s, &level, "idle");
	ss_json_str(s, level, "action", kv_get_locked("idle_action", "none"));
	ss_json_int(s, level, "minutes", atoi(kv_get_locked("idle_minutes", "60")));
	ss_json_str(s, level, "busy", idle_busy);
	ss_json_i64(s, level, "idle_seconds", idle_busy[0] ? 0 : (int64_t)(time(0) - idle_since));
	ss_json_close(s, &level);

	ss_json_object_open(s, &level, "dircache");
	ss_json_bool(s, level, "enabled", atoi(kv_get_locked("dircache", "0")) != 0);
	ss_json_i64(s, level, "last_time", (int64_t)dircache_last);
	ss_json_u64(s, level, "entries", dircache_entries);
	ss_json_close(s, &level);

	ss_json_object_open(s, &level, "smart_tests");
	ss_json_str(s, level, "short", kv_get_locked("smart_short", ""));
	ss_json_str(s, level, "long", kv_get_locked("smart_long", ""));
	ss_json_i64(s, level, "last_start", (int64_t)smart_last_start);
	ss_json_str(s, level, "last_kind", smart_last_kind);
	ss_json_close(s, &level);

	pthread_mutex_unlock(&host_mutex);

	ups_json(s, level);

	/* facts for the health checks of the UI */
	ss_json_object_open(s, &level, "facts");
	ss_json_bool(s, level, "clock_synchronized", access("/run/systemd/timesync/synchronized", F_OK) == 0);
	if (statvfs("/", &vfs) == 0) {
		ss_json_u64(s, level, "root_free_bytes", (uint64_t)vfs.f_bavail * vfs.f_frsize);
		ss_json_u64(s, level, "root_total_bytes", (uint64_t)vfs.f_blocks * vfs.f_frsize);
	}
	char logdir[PATH_MAX];
	state_lock();
	sncpy(logdir, sizeof(logdir), state_ptr()->config.sys_log_directory);
	state_unlock();
	if (logdir[0] && statvfs(logdir, &vfs) == 0) {
		ss_json_str(s, level, "log_dir", logdir);
		ss_json_u64(s, level, "log_free_bytes", (uint64_t)vfs.f_bavail * vfs.f_frsize);
	}
	ss_t conf;
	ss_init(&conf, 4096);
	int samba_included = file_read(SMB_CONF, &conf) == 0 && strstr(ss_ptr(&conf), "include = " SMB_SHARES_CONF) != 0;
	ss_done(&conf);
	ss_json_bool(s, level, "samba_ready", samba_included);
	ss_json_close(s, &level);
}

/****************************************************************************/
/* requests */

int host_get_is_private(const char* what)
{
	return strcmp(what, "diagnostics") == 0 || strcmp(what, "settings_backup") == 0 || strcmp(what, "openfiles") == 0 || strcmp(what, "alerts") == 0;
}

int host_get(const char* what, const struct host_args* query, ss_t* s, int level, char* msg, size_t msg_size)
{
	if (what[0] == 0) {
		status_json(s, level);
		return 0;
	}
	if (strcmp(what, "history") == 0) {
		history_json(s, level);
		return 0;
	}
	if (strcmp(what, "network") == 0) {
		wol_json(s, level);
		return 0;
	}
	if (strcmp(what, "runs") == 0) {
		const char* limit = host_arg(query, "limit");
		runs_tick();
		runs_json(s, level, host_arg(query, "array"), limit && valid_int(limit, 1, 5000) ? atoi(limit) : 200);
		return 0;
	}
	if (strcmp(what, "ups_detect") == 0) {
		ups_detect_json(s, level);
		return 0;
	}
	if (strcmp(what, "events") == 0) {
		const char* limit = host_arg(query, "limit");
		events_json(s, level, limit && valid_int(limit, 1, EVENTS_MAX) ? atoi(limit) : 50);
		return 0;
	}
	if (strcmp(what, "space") == 0) {
		const char* days = host_arg(query, "days");
		space_tick();
		space_json(s, level, days && valid_int(days, 1, SPACE_DAYS_KEPT) ? atoi(days) : SPACE_DAYS_FIT);
		return 0;
	}
	if (strcmp(what, "alerts") == 0) {
		alerts_json(s, level);
		return 0;
	}
	if (strcmp(what, "share_users") == 0) {
		smb_users_json(s, level);
		return 0;
	}
	if (strcmp(what, "smart") == 0) {
		const char* device = host_arg(query, "device");
		if (!device)
			return hfail(msg, msg_size, 400, "Missing device");
		return smart_log_json(device, s, level, msg, msg_size);
	}
	if (strcmp(what, "openfiles") == 0) {
		const char* path = host_arg(query, "path");
		if (!path || !valid_browse_path(path) || path[1] == 0)
			return hfail(msg, msg_size, 400, "Missing or invalid path");
		open_files_json(path, s, level);
		return 0;
	}
	if (strcmp(what, "diagnostics") == 0) {
		ss_t text;
		char name[64];
		time_t now = time(0);
		ss_init(&text, 65536);
		diagnostics_build(&text);
		ss_write(&text, "", 1);
		strftime(name, sizeof(name), "snapraidd-diagnostics-%Y%m%d-%H%M.txt", localtime(&now));
		ss_json_str(s, level, "filename", name);
		ss_json_str(s, level, "text", ss_ptr(&text));
		ss_done(&text);
		return 0;
	}
	if (strcmp(what, "settings_backup") == 0) {
		settings_backup_json(s, level);
		return 0;
	}

	return hfail(msg, msg_size, 404, "Unknown request %s", what);
}

/** Make a "name=value<TAB>..." line from the arguments of a request. */
static void options_from_args(const struct host_args* args, const char* const* allowed, char* line, size_t line_size)
{
	line[0] = 0;
	for (unsigned i = 0; allowed[i]; ++i) {
		char name[32];
		const char* colon = strchr(allowed[i], ':');
		size_t nl = colon - allowed[i];
		memcpy(name, allowed[i], nl);
		name[nl] = 0;
		const char* val = host_arg(args, name);
		if (!val)
			continue;
		if (line[0])
			sncat(line, line_size, "\t");
		sncat(line, line_size, name);
		sncat(line, line_size, "=");
		sncat(line, line_size, val);
	}
}

/** Store one setting after checking it. */
static int setting_store(const char* key, const char* val, char* msg, size_t msg_size)
{
	int ret = setting_check(key, val, msg, msg_size);
	if (ret != 0)
		return ret;

	pthread_mutex_lock(&host_mutex);
	ret = kv_set_locked(key, val);
	if (ret == 0)
		ret = kv_save_locked();
	pthread_mutex_unlock(&host_mutex);

	if (ret != 0)
		return hfail(msg, msg_size, 500, "Cannot save the settings in %s", host_conf_path);

	log_msg(LVL_INFO, "host: setting %s = %s", key, val[0] ? val : "(removed)");
	return 0;
}

static const char* need(const struct host_args* args, const char* key)
{
	const char* v = host_arg(args, key);
	return v ? v : "";
}

int host_post(const char* action, const struct host_args* args, ss_t* s, int level, char* msg, size_t msg_size)
{
	char key[128];
	char line[4096];
	int ret;

	msg[0] = 0;

	if (strcmp(action, "settings") == 0) {
		/* simple settings and documents of the UI; shares, backups and power have their own requests */
		for (unsigned i = 0; i < args->count; ++i) {
			const char* k = args->key[i];
			if (strncmp(k, "share.", 6) == 0 || strncmp(k, "backup.", 7) == 0 || strncmp(k, "power.", 6) == 0 || strncmp(k, "cache.", 6) == 0 || strncmp(k, "keep.", 5) == 0 || strncmp(k, "remote.", 7) == 0 || strncmp(k, "last.", 5) == 0)
				return hfail(msg, msg_size, 400, "Use the request of its own for %s", k);
			ret = setting_check(k, args->val[i], msg, msg_size);
			if (ret != 0)
				return ret;
		}
		for (unsigned i = 0; i < args->count; ++i) {
			ret = setting_store(args->key[i], args->val[i], msg, msg_size);
			if (ret != 0)
				return ret;
		}
		/* what follows a setting, like the look at the UPS, does not wait for the next round */
		host_wake();
		if (host_arg(args, "wol") && strcmp(host_arg(args, "wol"), "1") == 0) {
			ret = wol_apply(msg, msg_size);
			if (ret != 0)
				ss_json_str(s, level, "warning", msg);
		}
		if (host_arg(args, "dircache"))
			dircache_last = 0;
		status_json(s, level);
		return 0;
	}

	if (strcmp(action, "share_save") == 0 || strcmp(action, "share_delete") == 0) {
		const char* name = need(args, "name");
		if (!valid_name(name))
			return hfail(msg, msg_size, 400, "A share name has only letters, digits, - and _ (up to 32)");
		snprintf(key, sizeof(key), "share.%s", name);
		if (strcmp(action, "share_save") == 0) {
			options_from_args(args, SHARE_OPTIONS, line, sizeof(line));
			const char* path = host_arg(args, "path");
			struct stat st;
			char real[PATH_MAX];
			if (!path || stat(path, &st) != 0 || !S_ISDIR(st.st_mode))
				return hfail(msg, msg_size, 404, "The folder %s does not exist", path ? path : "");
			if (realpath(path, real) == 0 || !data_area(real) || system_path(real))
				return hfail(msg, msg_size, 400, "The folder %s is not under /mnt, /srv or /media once its links are followed", path);
		} else {
			line[0] = 0;
		}
		ret = setting_store(key, line, msg, msg_size);
		if (ret != 0)
			return ret;
		ret = shares_apply(msg, msg_size);
		if (ret != 0)
			ss_json_str(s, level, "warning", msg);
		ss_json_bool(s, level, "applied", ret == 0);
		return 0;
	}

	if (strcmp(action, "share_user_set") == 0)
		return smb_user_set(need(args, "user"), need(args, "password"), msg, msg_size);
	if (strcmp(action, "share_user_delete") == 0)
		return smb_user_delete(need(args, "user"), msg, msg_size);
	if (strcmp(action, "permissions") == 0)
		return perms_start(need(args, "path"), msg, msg_size);

	if (strcmp(action, "backup_save") == 0 || strcmp(action, "backup_delete") == 0) {
		const char* name = need(args, "name");
		if (!valid_name(name))
			return hfail(msg, msg_size, 400, "A backup name has only letters, digits, - and _ (up to 32)");
		snprintf(key, sizeof(key), "backup.%s", name);
		if (strcmp(action, "backup_save") == 0)
			options_from_args(args, BACKUP_OPTIONS, line, sizeof(line));
		else
			line[0] = 0;
		ret = setting_store(key, line, msg, msg_size);
		if (ret == 0 && line[0] == 0) {
			snprintf(key, sizeof(key), "last.backup.%s", name);
			pthread_mutex_lock(&host_mutex);
			kv_set_locked(key, "");
			kv_save_locked();
			pthread_mutex_unlock(&host_mutex);
		}
		return ret;
	}
	if (strcmp(action, "backup_run") == 0)
		return backup_run(need(args, "name"), msg, msg_size);

	if (strcmp(action, "cache_save") == 0 || strcmp(action, "cache_delete") == 0) {
		const char* name = need(args, "name");
		if (!valid_name(name))
			return hfail(msg, msg_size, 400, "A name has only letters, digits, - and _ (up to 32)");
		snprintf(key, sizeof(key), "cache.%s", name);
		if (strcmp(action, "cache_save") == 0) {
			options_from_args(args, CACHE_OPTIONS, line, sizeof(line));
			ret = setting_check(key, line, msg, msg_size);
			if (ret != 0)
				return ret;
			ret = cache_check(need(args, "pool"), need(args, "branch"), msg, msg_size);
			if (ret != 0)
				return ret;
		} else {
			line[0] = 0;
		}
		ret = setting_store(key, line, msg, msg_size);
		if (ret == 0 && line[0] == 0) {
			snprintf(key, sizeof(key), "last.cache.%s", name);
			pthread_mutex_lock(&host_mutex);
			kv_set_locked(key, "");
			kv_save_locked();
			pthread_mutex_unlock(&host_mutex);
		}
		return ret;
	}
	if (strcmp(action, "keep_save") == 0 || strcmp(action, "keep_delete") == 0) {
		const char* name = need(args, "name");
		if (!valid_name(name))
			return hfail(msg, msg_size, 400, "A name has only letters, digits, - and _ (up to 32)");
		snprintf(key, sizeof(key), "keep.%s", name);
		if (strcmp(action, "keep_save") == 0) {
			char from[PATH_MAX];
			options_from_args(args, KEEP_OPTIONS, line, sizeof(line));
			ret = setting_check(key, line, msg, msg_size);
			if (ret != 0)
				return ret;
			if (keep_strays(line, from, sizeof(from), msg, msg_size) < 0)
				return 400;
		} else {
			line[0] = 0;
		}
		ret = setting_store(key, line, msg, msg_size);
		if (ret == 0 && line[0] == 0) {
			snprintf(key, sizeof(key), "last.keep.%s", name);
			pthread_mutex_lock(&host_mutex);
			kv_set_locked(key, "");
			kv_save_locked();
			pthread_mutex_unlock(&host_mutex);
		}
		return ret;
	}
	if (strcmp(action, "keep_run") == 0)
		return keep_run(need(args, "name"), msg, msg_size);
	if (strcmp(action, "cache_run") == 0)
		return cache_run(need(args, "name"), 1, msg, msg_size);
	if (strcmp(action, "usage") == 0)
		return usage_start(need(args, "path"), msg, msg_size);
	if (strcmp(action, "surface") == 0)
		return surface_start(need(args, "device"), msg, msg_size);

	if (strcmp(action, "power_save") == 0) {
		const char* disk = need(args, "disk");
		snprintf(key, sizeof(key), "power.%s", disk);
		options_from_args(args, POWER_OPTIONS, line, sizeof(line));
		ret = setting_store(key, line, msg, msg_size);
		if (ret != 0)
			return ret;
		if (line[0]) {
			ret = power_apply_one(disk, line, msg, msg_size);
			if (ret != 0)
				ss_json_str(s, level, "warning", msg);
			ss_json_bool(s, level, "applied", ret == 0);
		}
		return 0;
	}

	if (strcmp(action, "smart_test") == 0)
		return smart_test_start(need(args, "device"), need(args, "kind"), msg, msg_size);

	if (strcmp(action, "wipe") == 0) {
		const char* device = need(args, "device");
		if (strcmp(need(args, "confirm"), device) != 0)
			return hfail(msg, msg_size, 400, "To wipe a disk, confirm with its device name");
		return wipe_start(device, need(args, "method"), msg, msg_size);
	}

	if (strcmp(action, "usb_mount") == 0)
		return usb_mount(need(args, "device"), s, level, msg, msg_size);
	if (strcmp(action, "usb_eject") == 0)
		return usb_eject(need(args, "device"), s, level, msg, msg_size);
	if (strcmp(action, "remote_save") == 0)
		return remote_save(args, msg, msg_size);
	if (strcmp(action, "remote_delete") == 0)
		return remote_delete(need(args, "name"), msg, msg_size);
	if (strcmp(action, "remote_test") == 0)
		return remote_test(need(args, "name"), s, level, msg, msg_size);
	if (strcmp(action, "alerts_save") == 0)
		return alerts_save(need(args, "channels"), s, level, msg, msg_size);

	if (strcmp(action, "copy") == 0) {
		const char* mirror = host_arg(args, "mirror");
		return copy_start("copy", need(args, "source"), need(args, "target"), mirror && strcmp(mirror, "1") == 0, 0, msg, msg_size);
	}

	if (strcmp(action, "file_delete") == 0)
		return file_delete(need(args, "path"), msg, msg_size);
	if (strcmp(action, "file_rename") == 0)
		return file_rename(need(args, "path"), need(args, "name"), msg, msg_size);

	if (strcmp(action, "wol") == 0)
		return wol_apply(msg, msg_size);

	if (strcmp(action, "restore") == 0)
		return settings_restore(need(args, "path"), need(args, "text"), msg, msg_size);

	return hfail(msg, msg_size, 404, "Unknown request %s", action);
}

/****************************************************************************/
/* thread */

static pthread_t host_thread_id;
static pthread_mutex_t host_wait_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t host_cond = PTHREAD_COND_INITIALIZER;
static int host_stop;
static int host_started;

static void host_wake(void)
{
	pthread_mutex_lock(&host_wait_mutex);
	pthread_cond_signal(&host_cond);
	pthread_mutex_unlock(&host_wait_mutex);
}

static void* host_thread(void* arg)
{
	(void)arg;
	int last_minute = -1;
	int first = 1;
	time_t last_recycle = 0;

	log_bind(state_ptr());

	while (1) {
		time_t now = time(0);
		struct tm tm;
		localtime_r(&now, &tm);
		int minute = tm.tm_yday * 1440 + tm.tm_hour * 60 + tm.tm_min;

		if (minute != last_minute) {
			last_minute = minute;
			window_tick(&tm);
			smart_tick(&tm);
			backups_tick(&tm, first);
			caches_tick(&tm);
			keeps_tick(&tm);
			ratio_tick();
			changes_tick();
			runs_tick();
			space_tick();
			idle_tick(&tm);
			first = 0;
		}
		ups_tick();
		history_tick();
		dircache_tick();
		if (now - last_recycle >= 6 * 3600) {
			last_recycle = now;
			recycle_clean();
		}

		pthread_mutex_lock(&host_wait_mutex);
		if (!host_stop) {
			struct timespec ts;
			clock_gettime(CLOCK_REALTIME, &ts);
			ts.tv_sec += 15;
			pthread_cond_timedwait(&host_cond, &host_wait_mutex, &ts);
		}
		int stop = host_stop;
		pthread_mutex_unlock(&host_wait_mutex);
		if (stop)
			break;
	}

	return 0;
}

static void host_reload_settings(void)
{
	pthread_mutex_lock(&host_mutex);
	for (unsigned i = 0; i < kv_count; ++i) {
		free(kv_list[i].key);
		free(kv_list[i].val);
	}
	kv_count = 0;
	pthread_mutex_unlock(&host_mutex);

	kv_load();
	power_apply_all();
}

void host_init(void)
{
	const char* dry = getenv("SNAPRAIDD_HOST_DRYRUN");
	host_dryrun = dry && strcmp(dry, "1") == 0;

	host_conf_locate();
	kv_load();
	idle_since = time(0);

	log_msg(LVL_INFO, "host: settings of the machine in %s", host_conf_path);
}

void host_start(void)
{
	char msg[MSG_MAX];

	power_apply_all();
	if (kv_int("wol", 0))
		wol_apply(msg, sizeof(msg));

	if (pthread_create(&host_thread_id, 0, host_thread, 0) == 0)
		host_started = 1;
	else
		log_msg(LVL_ERROR, "host: cannot start the thread of the machine");
}

void host_done(void)
{
	if (!host_started)
		return;

	pthread_mutex_lock(&host_wait_mutex);
	host_stop = 1;
	pthread_cond_signal(&host_cond);
	pthread_mutex_unlock(&host_wait_mutex);

	pthread_join(host_thread_id, 0);
	host_started = 0;

	dircache_pressure(0);
}

/****************************************************************************/
/* selftest */

#define HCHECK(cond) \
	do { \
		if (!(cond)) { \
			fprintf(stderr, "Failed host test at line %d: %s\n", __LINE__, #cond); \
			return -1; \
		} \
	} while (0)

int host_selftest(void)
{
	struct sched one;
	struct tm tm;
	char msg[MSG_MAX];
	char buf[256];

	/* schedules */
	HCHECK(sched_parse_one("02:00", &one) == 0 && one.day == -1 && one.hour == 2 && one.minute == 0);
	HCHECK(sched_parse_one("Sun 03:30", &one) == 0 && one.day == 0 && one.nth == 0 && one.minute == 30);
	HCHECK(sched_parse_one("sat#2 23:59", &one) == 0 && one.day == 6 && one.nth == 2);
	HCHECK(sched_parse_one("Sun#5 03:00", &one) != 0);
	HCHECK(sched_parse_one("24:00", &one) != 0);
	HCHECK(sched_parse_one("Sun03:00", &one) != 0);
	HCHECK(sched_parse_one("Funday 03:00", &one) != 0);
	HCHECK(sched_valid("") && sched_valid("Mon 01:00, Thu 02:00") && !sched_valid("Mon 1:00"));

	memset(&tm, 0, sizeof(tm));
	tm.tm_wday = 0;
	tm.tm_mday = 9; /* second Sunday */
	tm.tm_hour = 4;
	tm.tm_min = 0;
	HCHECK(sched_match("Sun#2 04:00", &tm));
	HCHECK(!sched_match("Sun#1 04:00", &tm));
	HCHECK(sched_match("Mon 01:00, 04:00", &tm));
	HCHECK(!sched_match("Sun 04:01", &tm));

	/* write test: a clean pass finds nothing, one changed byte is found */
	{
		char tmp[] = "/tmp/snapraidd-selftest-XXXXXX";
		int f = mkstemp(tmp);
		HCHECK(f >= 0);
		unsigned char* b1 = malloc_nofail(WIPE_CHUNK);
		unsigned char* b2 = malloc_nofail(WIPE_CHUNK);
		uint64_t size = WIPE_CHUNK + 4096 + 3;
		uint64_t done = 0;
		unsigned bad = 0;
		HCHECK(burnin_pass(f, size, 42, 0, b1, b2, &done, &bad) == 0 && done == size);
		HCHECK(burnin_pass(f, size, 42, 1, b1, b2, &done, &bad) == 0 && bad == 0);
		HCHECK(burnin_pass(f, size, 43, 1, b1, b2, &done, &bad) == 0 && bad == 2);
		unsigned char flip;
		HCHECK(pread(f, &flip, 1, WIPE_CHUNK + 100) == 1);
		flip ^= 0x10;
		HCHECK(pwrite(f, &flip, 1, WIPE_CHUNK + 100) == 1);
		bad = 0;
		HCHECK(burnin_pass(f, size, 42, 1, b1, b2, &done, &bad) == 0 && bad == 1);
		close(f);
		unlink(tmp);
		free(b1);
		free(b2);
	}

	/* state of a UPS, as NUT and apcupsd tell it */
	{
		int ob, lb, ch, rt;
		char st[64];
		HCHECK(ups_parse("battery.charge: 100\nbattery.runtime: 1800\nups.status: OL CHRG\n", 0, &ob, &lb, &ch, &rt, st, sizeof(st)) == 0 && !ob && !lb && ch == 100 && rt == 1800);
		HCHECK(ups_parse("battery.charge: 37\nups.status: OB DISCHRG\n", 0, &ob, &lb, &ch, &rt, st, sizeof(st)) == 0 && ob && !lb && ch == 37 && rt == -1);
		HCHECK(ups_parse("ups.status: OB LB\n", 0, &ob, &lb, &ch, &rt, st, sizeof(st)) == 0 && ob && lb);
		HCHECK(ups_parse("ups.status: OFF\n", 0, &ob, &lb, &ch, &rt, st, sizeof(st)) != 0);
		HCHECK(ups_parse("Error: Data stale\n", 0, &ob, &lb, &ch, &rt, st, sizeof(st)) != 0);
		HCHECK(ups_parse("APC      : 001,036,0879\nSTATUS   : ONLINE \nBCHARGE  : 100.0 Percent\nTIMELEFT : 45.5 Minutes\n", 1, &ob, &lb, &ch, &rt, st, sizeof(st)) == 0 && !ob && ch == 100 && rt == 2730);
		HCHECK(ups_parse("STATUS   : ONBATT LOWBATT\nBCHARGE  : 9.0 Percent\n", 1, &ob, &lb, &ch, &rt, st, sizeof(st)) == 0 && ob && lb && ch == 9);
		HCHECK(ups_parse("STATUS   : COMMLOST\n", 1, &ob, &lb, &ch, &rt, st, sizeof(st)) != 0);
		HCHECK(valid_ups("apc") && valid_ups("nut:myups") && valid_ups("nut:ups@192.168.1.5:3493") && !valid_ups("nut:") && !valid_ups("nut:-l") && !valid_ups("nut:a b") && !valid_ups("other"));
	}

	/* record of the runs */
	{
		struct run_line r, back;
		ss_t out;
		memset(&r, 0, sizeof(r));
		r.end = 1700000000;
		sncpy(r.array, sizeof(r.array), "default");
		sncpy(r.command, sizeof(r.command), "scrub");
		sncpy(r.status, sizeof(r.status), "error");
		r.exit_code = 1;
		r.seconds = 61;
		r.data = 3;
		r.removed = 7;
		ss_init(&out, 256);
		run_format(&out, &r);
		ss_write(&out, "", 1);
		char* nl = strchr(ss_ptr(&out), '\n');
		HCHECK(nl != 0);
		*nl = 0;
		HCHECK(run_parse(ss_ptr(&out), &back) == 0 && back.end == r.end && back.data == 3 && back.removed == 7 && back.seconds == 61 && strcmp(back.command, "scrub") == 0);
		ss_done(&out);
		char bad[] = "1700000000\tdefault\tdiff\tok\t0\t1\t0\t0\t0\t0\t0\t0\t0\t0";
		HCHECK(run_parse(bad, &back) != 0);
		char cut[] = "1700000000\tdefault\tsync\tok";
		HCHECK(run_parse(cut, &back) != 0);
	}

	/* addresses of the alerts and folders of other computers */
	HCHECK(valid_web_url("https://ntfy.sh/my-topic") && valid_web_url("http://192.168.1.2:8080/hook?a=1&b=2"));
	HCHECK(!valid_web_url("ftp://x.example/a") && !valid_web_url("https://x.example/'; reboot; '") && !valid_web_url("https://x.example/$(id)") && !valid_web_url("https://x.example/a b"));
	HCHECK(remote_of_path("/mnt/remote/nas/photos", buf, sizeof(buf)) == 0 && strcmp(buf, "nas") == 0);
	HCHECK(remote_of_path("/mnt/remote/nas", buf, sizeof(buf)) == 0 && remote_of_path("/mnt/remote", buf, sizeof(buf)) != 0 && remote_of_path("/mnt/remotes/nas", buf, sizeof(buf)) != 0);
	HCHECK(setting_check("remote.nas", "kind=smb\thost=nas.local\tshare=My Photos\tuser=anna", msg, sizeof(msg)) == 0);
	HCHECK(setting_check("remote.nas", "kind=smb\thost=nas local\tshare=x", msg, sizeof(msg)) != 0);
	HCHECK(setting_check("remote.nas", "kind=smb\thost=-oproxy\tshare=x", msg, sizeof(msg)) != 0);
	HCHECK(setting_check("ups", "nut:myups", msg, sizeof(msg)) == 0 && setting_check("ups", "usb", msg, sizeof(msg)) != 0);
	HCHECK(setting_check("sync_changes_minutes", "0", msg, sizeof(msg)) != 0 && setting_check("sync_changes", "200", msg, sizeof(msg)) == 0);

	/* options lines */
	const char* line = "path=/mnt/storage/My Movies\tsmb=1\tusers=anna,bob";
	HCHECK(opt_get(line, "path", buf, sizeof(buf)) == 0 && strcmp(buf, "/mnt/storage/My Movies") == 0);
	HCHECK(opt_get(line, "users", buf, sizeof(buf)) == 0 && strcmp(buf, "anna,bob") == 0);
	HCHECK(opt_get(line, "nfs", buf, sizeof(buf)) != 0);
	HCHECK(opt_bool(line, "smb", 0) == 1 && opt_bool(line, "nfs", 0) == 0);

	/* settings */
	HCHECK(setting_check("maintenance_stop_at", "07:00", msg, sizeof(msg)) == 0);
	HCHECK(setting_check("maintenance_stop_at", "Sun 07:00", msg, sizeof(msg)) != 0);
	HCHECK(setting_check("idle_action", "suspend", msg, sizeof(msg)) == 0);
	HCHECK(setting_check("idle_action", "reboot", msg, sizeof(msg)) != 0);
	HCHECK(setting_check("idle_minutes", "5", msg, sizeof(msg)) != 0);
	HCHECK(setting_check("share.Movies", line, msg, sizeof(msg)) == 0);
	HCHECK(setting_check("share.Mov ies", line, msg, sizeof(msg)) != 0);
	HCHECK(setting_check("share.etc", "path=/etc", msg, sizeof(msg)) != 0);
	HCHECK(setting_check("share.x", "path=/mnt/a/../etc", msg, sizeof(msg)) != 0);
	HCHECK(setting_check("share.x", "path=/mnt/a\tsmb=2", msg, sizeof(msg)) != 0);
	HCHECK(setting_check("share.x", "path=/mnt/a\trm=1", msg, sizeof(msg)) != 0);
	HCHECK(setting_check("share.x", "path=/mnt/a\"b", msg, sizeof(msg)) != 0);
	HCHECK(setting_check("share.x", "path=/mnt/a\tusers=a;b", msg, sizeof(msg)) != 0);
	HCHECK(setting_check("backup.photos", "source=/mnt/storage/Photos\tdest_uuid=1234-ABCD\twhen=Sun 05:00\tplug=1", msg, sizeof(msg)) == 0);
	HCHECK(setting_check("backup.photos", "source=/mnt/storage/Photos", msg, sizeof(msg)) != 0);
	HCHECK(setting_check("backup.photos", "source=/mnt/storage/Photos\tdest_path=/mnt/usb\twhen=sometimes", msg, sizeof(msg)) != 0);
	HCHECK(setting_check("power.WD-123", "apm=127\twcache=1", msg, sizeof(msg)) == 0);
	HCHECK(setting_check("power.WD-123", "apm=x", msg, sizeof(msg)) != 0);
	HCHECK(setting_check("doc.bays", "{\"rows\":2}", msg, sizeof(msg)) == 0);
	HCHECK(setting_check("doc.bays", "not json", msg, sizeof(msg)) != 0);
	HCHECK(setting_check("doc.bays", "{\n}", msg, sizeof(msg)) != 0);
	HCHECK(setting_check("unknown_key", "1", msg, sizeof(msg)) != 0);
	HCHECK(setting_check("smart_short", "", msg, sizeof(msg)) == 0);

	/* trees */
	HCHECK(valid_tree("/mnt/storage/Photos", msg, sizeof(msg)) == 0);
	HCHECK(valid_tree("/mnt/storage/My Photos", msg, sizeof(msg)) == 0);
	HCHECK(valid_tree("/mnt", msg, sizeof(msg)) != 0);
	HCHECK(valid_tree("/etc/x", msg, sizeof(msg)) != 0);
	HCHECK(valid_tree("/home/user", msg, sizeof(msg)) != 0);
	HCHECK(valid_tree("/mnt/a/../../etc", msg, sizeof(msg)) != 0);
	HCHECK(valid_tree("/mnt/a/..", msg, sizeof(msg)) != 0);
	HCHECK(valid_tree("/mnt/a/$(x)", msg, sizeof(msg)) != 0);
	HCHECK(valid_tree("/mnt/storage/Photos/", msg, sizeof(msg)) != 0);
	{
		/* a link inside the data area pointing out of it */
		char dir[] = "/tmp/hosttestXXXXXX";
		if (mkdtemp(dir)) {
			char link[PATH_MAX];
			snprintf(link, sizeof(link), "%s/out", dir);
			HCHECK(symlink("/etc", link) == 0);
			HCHECK(real_inside("/etc/passwd") == 0);
			snprintf(link, sizeof(link), "%s/out/passwd", dir);
			HCHECK(real_inside(link) == 0);
			snprintf(link, sizeof(link), "%s/out", dir);
			unlink(link);
			dir_remove(dir);
		}
	}

	/* redaction */
	ss_t out;
	ss_init(&out, 256);
	redact_conf("net_port = 7627\nnet_auth_credential = admin:$argon\n  notify_result = curl https://x/secret\nhook_script=/x\n", &out);
	ss_write(&out, "", 1);
	HCHECK(strstr(ss_ptr(&out), "secret") == 0 && strstr(ss_ptr(&out), "argon") == 0 && strstr(ss_ptr(&out), "net_port = 7627") != 0);
	HCHECK(strstr(ss_ptr(&out), "notify_result = <removed>") != 0);
	ss_done(&out);

	ss_init(&out, 256);
	ss_prints(&out, "disk WD-1234 and WD-1234 again");
	replace_all(&out, "WD-1234", "serial-1");
	HCHECK(strcmp(ss_ptr(&out), "disk serial-1 and serial-1 again") == 0);
	ss_done(&out);

	/* diskstats */
	const char* stats = "   8       0 sda 100 0 2000 0 50 0 4000 0 0 0 0\n 259 0 nvme0n1 1 0 10 0 2 0 20 0 0 0 0\n";
	uint64_t rd, wr;
	HCHECK(diskstats_get(stats, "nvme0n1", &rd, &wr) == 0 && rd == 10 && wr == 20);
	HCHECK(diskstats_get(stats, "sda", &rd, &wr) == 0 && rd == 2000 && wr == 4000);
	HCHECK(diskstats_get(stats, "sdb", &rd, &wr) != 0);

	/* growth of the used space */
	{
		int64_t d[10];
		double u[10];
		double slope = 0;
		for (int i = 0; i < 10; ++i) {
			d[i] = 20000 + i;
			u[i] = 1000.0 + 50.0 * i;
		}
		HCHECK(space_fit(d, u, 10, &slope) == 0 && slope > 49.99 && slope < 50.01);
		/* six days are too few for a forecast */
		HCHECK(space_fit(d, u, 6, &slope) != 0);
		/* a missing day does not matter, a shrinking array grows less than zero */
		d[3] = 20012;
		for (int i = 0; i < 10; ++i)
			u[i] = 5000.0 - 10.0 * (double)(d[i] - 20000);
		HCHECK(space_fit(d, u, 10, &slope) == 0 && slope < -9.99 && slope > -10.01);
		/* all on the same day: no line */
		for (int i = 0; i < 10; ++i)
			d[i] = 20000;
		HCHECK(space_fit(d, u, 10, &slope) != 0);
		HCHECK(space_fit(d, u, 1, &slope) != 0);
	}

	/* fields of an event line */
	event_field(buf, sizeof(buf), "a\tb\nc");
	HCHECK(strcmp(buf, "a b c") == 0);
	event_field(buf, sizeof(buf), "");
	HCHECK(strcmp(buf, "-") == 0);
	event_field(buf, sizeof(buf), 0);
	HCHECK(strcmp(buf, "-") == 0);

	return 0;
}

#else

void host_event(const char* level, const char* kind, const char* target, const char* text)
{
	(void)level;
	(void)kind;
	(void)target;
	(void)text;
}

int space_fit(const int64_t* day, const double* used, unsigned n, double* slope)
{
	(void)day;
	(void)used;
	(void)n;
	(void)slope;
	return -1;
}

void host_init(void)
{
}

void host_start(void)
{
}

void host_done(void)
{
}

int host_move_stays(const char* tag, const char* rel)
{
	(void)tag;
	(void)rel;
	return 0;
}

int host_keep_disks(const char* pool, const char* rel, char* disks, size_t disks_size)
{
	(void)pool;
	(void)rel;
	(void)disks;
	(void)disks_size;
	return 0;
}

void host_move_done(const char* tag, int status, const char* message)
{
	(void)tag;
	(void)status;
	(void)message;
}

int host_get_is_private(const char* what)
{
	(void)what;
	return 1;
}

int host_get(const char* what, const struct host_args* query, ss_t* s, int level, char* msg, size_t msg_size)
{
	(void)what;
	(void)query;
	(void)s;
	(void)level;
	snprintf(msg, msg_size, "Not supported on this system");
	return 501;
}

int host_post(const char* action, const struct host_args* args, ss_t* s, int level, char* msg, size_t msg_size)
{
	(void)action;
	(void)args;
	(void)s;
	(void)level;
	snprintf(msg, msg_size, "Not supported on this system");
	return 501;
}

int host_selftest(void)
{
	return 0;
}

#endif
