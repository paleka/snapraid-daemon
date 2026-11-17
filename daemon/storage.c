// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Paleka

#include "os/portable.h"

#include "app.h"
#include "state.h"
#include "support.h"
#include "log.h"
#include "storage.h"
#include "arrays.h"
#include "memory.h"

/****************************************************************************/
/* storage */

#ifdef __linux__

#include <linux/fs.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <sys/statvfs.h>
#include <sys/sysmacros.h>
#include <sys/xattr.h>

#define FSTAB_PATH "/etc/fstab"
#define ENGINE_CONF_DEFAULT "/etc/snapraid.conf"
#define EXEC_OUTPUT_MAX (512 * 1024)

/** The fstab to work on. Replaced only by the selftest. */
static const char* fstab_path = FSTAB_PATH;

/** Serialize all the operations changing the system. */
static pthread_mutex_t storage_mutex = PTHREAD_MUTEX_INITIALIZER;

/**
 * The privileges of the daemon are bracketed, and the bracket is not
 * reentrant. Count the nesting to keep them for a whole operation.
 */
static __thread unsigned priv_depth;

static void priv_enter(void)
{
	if (priv_depth++ == 0)
		os_privileges_acquire();
}

static void priv_leave(void)
{
	if (--priv_depth == 0)
		os_privileges_release();
}

/****************************************************************************/
/* validation */

/*
 * Everything received from the network ends up in argv of privileged tools
 * or in /etc/fstab. Only a conservative character set is accepted, which also
 * avoids any need of quoting in fstab.
 */
static int valid_chars(const char* str, const char* extra, size_t max)
{
	size_t len = strlen(str);

	if (len == 0 || len >= max)
		return 0;

	for (const char* p = str; *p; ++p) {
		if (!isalnum((unsigned char)*p) && strchr(extra, *p) == 0)
			return 0;
	}

	if (str[0] == '-' || strstr(str, "..") != 0)
		return 0;

	return 1;
}

static int valid_path(const char* path)
{
	if (path[0] != '/' || path[1] == 0)
		return 0;
	if (strstr(path, "//") != 0)
		return 0;
	return valid_chars(path, "/._-+", PATH_MAX);
}

static int valid_options(const char* options)
{
	return valid_chars(options, "/._-+,=:", 1024);
}

static int valid_label(const char* label)
{
	/* 12 is the limit of xfs, the smallest of the supported ones */
	return valid_chars(label, "_-", 13);
}

static int valid_source(const char* source)
{
	if (strncmp(source, "UUID=", 5) == 0)
		return valid_chars(source + 5, "-", 64);
	if (strncmp(source, "LABEL=", 6) == 0)
		return valid_chars(source + 6, "_-", 64);
	if (strncmp(source, "/dev/", 5) == 0)
		return valid_path(source);
	return 0;
}

/** Directories that can never be used as mount point. */
static int system_path(const char* path)
{
	static const char* exact[] = { "/", "/mnt", "/media", "/srv", "/home", "/opt", "/root", "/tmp", 0 };
	static const char* tree[] = { "/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/proc", "/run", "/sbin", "/sys", "/usr", "/var", 0 };
	size_t len = strlen(path);

	/* ignore a final slash */
	if (len > 1 && path[len - 1] == '/')
		--len;

	for (unsigned i = 0; exact[i]; ++i) {
		if (strlen(exact[i]) == len && strncmp(path, exact[i], len) == 0)
			return 1;
	}

	for (unsigned i = 0; tree[i]; ++i) {
		size_t l = strlen(tree[i]);
		if (strncmp(path, tree[i], l) == 0 && (path[l] == 0 || path[l] == '/'))
			return 1;
	}

	return 0;
}

static int fail(char* msg, size_t msg_size, int status, const char* fmt, ...) __attribute__((format(printf, 4, 5)));
static int fail(char* msg, size_t msg_size, int status, const char* fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	vsnprintf(msg, msg_size, fmt, ap);
	va_end(ap);

	log_msg(LVL_WARNING, "storage: %s", msg);

	return status;
}

/****************************************************************************/
/* background job */

#define JOB_RESULT_MAX 500 /**< Max number of entries reported by a job */
#define JOB_CLAIMS_MAX 16 /**< Max number of arrays claimed by a job */

struct storage_job {
	int running; /**< A job is in progress */
	int stop; /**< Stop requested */
	unsigned id; /**< Incremented at every start */
	char kind[16]; /**< "format", "balance", "duplicates" */
	char target[PATH_MAX]; /**< Device or pool */
	int status; /**< 0 on success, otherwise like the HTTP statuses of the direct operations */
	char message[MSG_MAX]; /**< Outcome in words */
	char current[PATH_MAX]; /**< What is being processed now */
	uint64_t files; /**< Files processed */
	uint64_t bytes; /**< Bytes processed */
	uint64_t found; /**< Entries found, also over JOB_RESULT_MAX */
	uint64_t found_bytes; /**< Space taken by the entries found */
	time_t started;
	time_t finished;
	char part[PATH_MAX]; /**< format: the new partition */
	char uuid[128]; /**< format: the new filesystem */
	ss_t result; /**< JSON elements of the "result" array */
	int result_valid;
	/* arguments */
	char a[PATH_MAX];
	char b[64];
	char c[64];
	char d[64];
	int flag;
	uint64_t max_bytes;
	unsigned spread;
	/* arrays whose data disks are being changed by the job */
	char claims[JOB_CLAIMS_MAX][ARRAY_NAME_MAX];
	unsigned claims_count;
};

static struct storage_job job;
static pthread_mutex_t job_mutex = PTHREAD_MUTEX_INITIALIZER;

static int job_busy(char* msg, size_t msg_size)
{
	pthread_mutex_lock(&job_mutex);
	int running = job.running;
	pthread_mutex_unlock(&job_mutex);

	if (running) {
		snprintf(msg, msg_size, "Another storage operation (%s) is still running. Wait for it to finish, or stop it.", job.kind);
		return 409;
	}

	return 0;
}

static int job_stopping(void)
{
	pthread_mutex_lock(&job_mutex);
	int stop = job.stop;
	pthread_mutex_unlock(&job_mutex);
	return stop;
}

static void job_current(const char* what)
{
	pthread_mutex_lock(&job_mutex);
	sncpy(job.current, sizeof(job.current), what);
	pthread_mutex_unlock(&job_mutex);
}

static void job_finish(int status, const char* message)
{
	pthread_mutex_lock(&job_mutex);
	job.status = status;
	sncpy(job.message, sizeof(job.message), message);
	job.current[0] = 0;
	job.finished = time(0);
	job.running = 0;
	pthread_mutex_unlock(&job_mutex);

	log_msg(status == 0 ? LVL_INFO : LVL_WARNING, "storage: %s of %s ended: %s", job.kind, job.target, message);

	/* the arrays that were waiting for the job can go on */
	arrays_wake();
}

int storage_job_claims_array(const char* name)
{
	int found = 0;

	pthread_mutex_lock(&job_mutex);
	if (job.running) {
		for (unsigned i = 0; i < job.claims_count; ++i) {
			if (strcmp(job.claims[i], name) == 0)
				found = 1;
		}
	}
	pthread_mutex_unlock(&job_mutex);

	return found;
}

/** Reserve the job slot. The caller fills the arguments and starts the thread. */
static int job_begin(const char* kind, const char* target, char* msg, size_t msg_size)
{
	pthread_mutex_lock(&job_mutex);
	if (job.running) {
		pthread_mutex_unlock(&job_mutex);
		snprintf(msg, msg_size, "Another storage operation (%s) is still running. Wait for it to finish, or stop it.", job.kind);
		return 409;
	}

	if (job.result_valid)
		ss_done(&job.result);
	unsigned id = job.id + 1;
	memset(&job, 0, sizeof(job));
	job.id = id;
	job.running = 1;
	job.started = time(0);
	sncpy(job.kind, sizeof(job.kind), kind);
	sncpy(job.target, sizeof(job.target), target);
	ss_init(&job.result, 1024);
	job.result_valid = 1;
	pthread_mutex_unlock(&job_mutex);

	return 0;
}

static int job_launch(void* (*func)(void*), char* msg, size_t msg_size)
{
	pthread_t thread;
	pthread_attr_t attr;

	pthread_attr_init(&attr);
	pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
	int ret = pthread_create(&thread, &attr, func, 0);
	pthread_attr_destroy(&attr);

	if (ret != 0) {
		job_finish(500, "Failed to start the background thread");
		snprintf(msg, msg_size, "Failed to start the background thread");
		return 500;
	}

	return 0;
}

void storage_job_json(ss_t* s, int level)
{
	pthread_mutex_lock(&job_mutex);

	ss_json_object_open(s, &level, "job");
	ss_json_uint(s, level, "id", job.id);
	if (job.id != 0) {
		ss_json_bool(s, level, "running", job.running);
		ss_json_bool(s, level, "stopping", job.running && job.stop);
		ss_json_str(s, level, "kind", job.kind);
		ss_json_str(s, level, "target", job.target);
		ss_json_str(s, level, "current", job.current);
		ss_jsonf(s, level, "\"files\": %" PRIu64 ",\n", job.files);
		ss_jsonf(s, level, "\"bytes\": %" PRIu64 ",\n", job.bytes);
		ss_jsonf(s, level, "\"found\": %" PRIu64 ",\n", job.found);
		ss_jsonf(s, level, "\"found_bytes\": %" PRIu64 ",\n", job.found_bytes);
		ss_jsonf(s, level, "\"elapsed_seconds\": %" PRIu64 ",\n", (uint64_t)((job.running ? time(0) : job.finished) - job.started));
		if (!job.running) {
			ss_json_bool(s, level, "success", job.status == 0);
			ss_json_str(s, level, "message", job.message);
			if (job.part[0])
				ss_json_str(s, level, "partition", job.part);
			if (job.uuid[0])
				ss_json_str(s, level, "uuid", job.uuid);
			ss_json_array_open(s, &level, "result");
			if (job.result_valid && ss_len(&job.result) > 0)
				ss_write(s, ss_ptr(&job.result), ss_len(&job.result));
			ss_json_array_close(s, &level);
		}
	}
	ss_json_close(s, &level);

	pthread_mutex_unlock(&job_mutex);
}

int storage_job_stop(char* msg, size_t msg_size)
{
	pthread_mutex_lock(&job_mutex);
	int running = job.running;
	int stoppable = strcmp(job.kind, "format") != 0;
	if (running && stoppable)
		job.stop = 1;
	pthread_mutex_unlock(&job_mutex);

	if (!running) {
		snprintf(msg, msg_size, "No storage operation is running");
		return 409;
	}
	if (!stoppable) {
		snprintf(msg, msg_size, "A format cannot be interrupted");
		return 409;
	}

	return 0;
}

/****************************************************************************/
/* tools */

static const char* tool_dirs[] = { "/usr/sbin", "/sbin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/local/bin", 0 };

static int tool_find(const char* name, char* path, size_t path_size)
{
	for (unsigned i = 0; tool_dirs[i]; ++i) {
		snprintf(path, path_size, "%s/%s", tool_dirs[i], name);
		if (access(path, X_OK) == 0)
			return 0;
	}

	path[0] = 0;
	return -1;
}

static int tool_exists(const char* name)
{
	char path[PATH_MAX];

	return tool_find(name, path, sizeof(path)) == 0;
}

/**
 * Run a tool with root privileges, without any shell involved.
 * \param args 0 terminated list of arguments, without the program name.
 * \param stdin_text Text to feed to the tool, or 0.
 * \param out Collects stdout and stderr, or 0 to discard them.
 * \return The exit code of the tool, -1 on failure, -2 if the tool is missing.
 */
static int tool_run(const char* name, const char** args, const char* stdin_text, ss_t* out, unsigned timeout_sec)
{
	char path[PATH_MAX];
	const char* argv[32];
	unsigned argc = 0;
	int out_fds[2];
	int in_fds[2] = { -1, -1 };
	static char* envp[] = { "PATH=/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin", "LC_ALL=C", 0 };

	if (tool_find(name, path, sizeof(path)) != 0)
		return -2;

	argv[argc++] = path;
	while (*args && argc < 31)
		argv[argc++] = *args++;
	argv[argc] = 0;

	if (pipe2(out_fds, O_CLOEXEC) != 0)
		return -1;
	if (stdin_text && pipe2(in_fds, O_CLOEXEC) != 0) {
		close(out_fds[0]);
		close(out_fds[1]);
		return -1;
	}

	priv_enter();
	pid_t pid = fork();
	if (pid == 0) {
		/* only async-signal-safe calls from here */
		os_signal_restore_after_fork();
		setpgid(0, 0);
		if (in_fds[0] != -1) {
			dup2(in_fds[0], 0);
		} else {
			int devnull = open("/dev/null", O_RDONLY);
			if (devnull >= 0)
				dup2(devnull, 0);
		}
		dup2(out_fds[1], 1);
		dup2(out_fds[1], 2);
		execve(path, (char**)argv, envp);
		_exit(127);
	}
	priv_leave();

	close(out_fds[1]);
	if (in_fds[0] != -1)
		close(in_fds[0]);

	if (pid < 0) {
		close(out_fds[0]);
		if (in_fds[1] != -1)
			close(in_fds[1]);
		return -1;
	}

	if (in_fds[1] != -1) {
		/* always a few bytes, they fit in the pipe buffer */
		ssize_t ignore = write(in_fds[1], stdin_text, strlen(stdin_text));
		(void)ignore;
		close(in_fds[1]);
	}

	uint64_t deadline = os_tick_sec() + timeout_sec;
	size_t total = 0;
	int timed_out = 0;
	while (1) {
		char buf[4096];
		struct pollfd pfd = { out_fds[0], POLLIN, 0 };
		uint64_t now = os_tick_sec();

		if (now >= deadline) {
			timed_out = 1;
			break;
		}

		int r = poll(&pfd, 1, 1000);
		if (r < 0 && errno != EINTR)
			break;
		if (r <= 0)
			continue;

		ssize_t n = read(out_fds[0], buf, sizeof(buf));
		if (n < 0 && errno == EINTR)
			continue;
		if (n <= 0)
			break;
		if (out && total < EXEC_OUTPUT_MAX)
			ss_write(out, buf, n);
		total += n;
	}
	close(out_fds[0]);

	if (timed_out) {
		priv_enter();
		kill(-pid, SIGKILL);
		kill(pid, SIGKILL);
		priv_leave();
	}

	int status;
	while (waitpid(pid, &status, 0) < 0) {
		if (errno != EINTR)
			return -1;
	}

	if (timed_out || !WIFEXITED(status))
		return -1;

	return WEXITSTATUS(status);
}

/** Run a tool and report its failure, with the last line it printed. */
static int tool_check(const char* name, const char** args, const char* stdin_text, unsigned timeout_sec, char* msg, size_t msg_size)
{
	ss_t out;
	int ret;

	ss_init(&out, 1024);
	ret = tool_run(name, args, stdin_text, &out, timeout_sec);
	if (ret == 0) {
		ss_done(&out);
		return 0;
	}

	if (ret == -2) {
		ss_done(&out);
		return fail(msg, msg_size, 501, "The tool '%s' is not installed", name);
	}

	/* keep the last not empty line of the output */
	ss_write(&out, "", 1);
	char* text = ss_ptr(&out);
	char* end = text + strlen(text);
	while (end > text && isspace((unsigned char)end[-1]))
		*--end = 0;
	char* line = strrchr(text, '\n');
	line = line ? line + 1 : text;

	if (ret < 0)
		ret = fail(msg, msg_size, 500, "The tool '%s' failed or timed out. %.150s", name, line);
	else
		ret = fail(msg, msg_size, 500, "The tool '%s' failed with exit code %d. %.150s", name, ret, line);

	ss_done(&out);
	return ret;
}

/****************************************************************************/
/* files */

/** Read a whole text file. The result is always 0 terminated. */
static int file_read(const char* path, ss_t* s)
{
	priv_enter();
	int f = open(path, O_RDONLY | O_CLOEXEC);
	priv_leave();
	if (f < 0)
		return -1;

	while (ss_len(s) < STORAGE_TEXT_MAX) {
		char buf[4096];
		ssize_t n = read(f, buf, sizeof(buf));
		if (n < 0 && errno == EINTR)
			continue;
		if (n <= 0)
			break;
		ss_write(s, buf, n);
	}
	close(f);

	ss_write(s, "", 1);
	--s->len; /* the terminator is not part of the text */

	return 0;
}

/**
 * Replace a text file in an atomic way, keeping the previous version with
 * the specified backup extension. Symbolic links are followed.
 */
static int file_replace(const char* path, const char* text, const char* backup_ext, mode_t mode)
{
	char real[PATH_MAX];
	char tmp[PATH_MAX + 32];
	char bak[PATH_MAX + 32];
	struct stat st;
	int ret = -1;

	priv_enter();

	if (realpath(path, real) == 0) {
		if (errno != ENOENT)
			goto bail;
		sncpy(real, sizeof(real), path);
	}

	if (stat(real, &st) == 0) {
		mode = st.st_mode & 0777;
		if (backup_ext) {
			ss_t old;
			snprintf(bak, sizeof(bak), "%s%s", real, backup_ext);
			ss_init(&old, 4096);
			if (file_read(real, &old) == 0) {
				int b = open(bak, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, mode);
				if (b >= 0) {
					ssize_t ignore = write(b, ss_ptr(&old), ss_len(&old));
					(void)ignore;
					close(b);
				}
			}
			ss_done(&old);
		}
	}

	snprintf(tmp, sizeof(tmp), "%s.tmp%u", real, (unsigned)getpid());
	int f = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, mode);
	if (f < 0)
		goto bail;

	size_t len = strlen(text);
	if (write(f, text, len) != (ssize_t)len || fsync(f) != 0) {
		close(f);
		unlink(tmp);
		goto bail;
	}
	close(f);

	if (rename(tmp, real) != 0) {
		unlink(tmp);
		goto bail;
	}

	ret = 0;

bail:
	priv_leave();
	return ret;
}

static int make_dirs(const char* path)
{
	char buf[PATH_MAX];
	int ret = 0;

	sncpy(buf, sizeof(buf), path);

	priv_enter();
	for (char* p = buf + 1;; ++p) {
		if (*p == '/' || *p == 0) {
			char c = *p;
			*p = 0;
			if (mkdir(buf, 0755) != 0 && errno != EEXIST) {
				ret = -1;
				break;
			}
			*p = c;
			if (c == 0)
				break;
		}
	}
	priv_leave();

	return ret;
}

/**
 * Protect an empty mount point: with the immutable flag nothing can be
 * written in the directory while its filesystem is not mounted. Without it,
 * when a disk fails to mount, files silently end in the system disk until
 * it's full, and pools and syncs see an empty disk.
 * Not every filesystem supports the flag: failures are ignored.
 */
static void dir_guard(const char* path, int on)
{
	priv_enter();
	int f = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	if (f >= 0) {
		int flags;
		if (ioctl(f, FS_IOC_GETFLAGS, &flags) == 0) {
			int wanted = on ? (flags | FS_IMMUTABLE_FL) : (flags & ~FS_IMMUTABLE_FL);
			if (wanted != flags && ioctl(f, FS_IOC_SETFLAGS, &wanted) != 0)
				log_msg(LVL_INFO, "storage: cannot %s the immutable flag of %s, errno=%s(%d)", on ? "set" : "clear", path, strerror(errno), errno);
		}
		close(f);
	}
	priv_leave();
}

/** Check if a path is the other one, or inside it. */
static int path_inside(const char* path, const char* dir)
{
	size_t len = strlen(dir);

	if (len > 1 && dir[len - 1] == '/')
		--len;
	if (len == 1 && dir[0] == '/')
		return 1;

	return strncmp(path, dir, len) == 0 && (path[len] == 0 || path[len] == '/');
}

/** Check if the name is one of the policies of mergerfs. */
static int valid_policy(const char* name)
{
	static const char* POLICIES[] = {
		"all", "epall", "epff", "eplfs", "eplus", "epmfs", "eppfrd", "eprand", "erofs", "ff", "lfs", "lus",
		"mfs", "msplfs", "msplus", "mspmfs", "msppfrd", "newest", "pfrd", "rand", 0
	};

	for (unsigned i = 0; POLICIES[i]; ++i) {
		if (strcmp(name, POLICIES[i]) == 0)
			return 1;
	}

	return 0;
}

/** Check if a comma separated list of mount options has the given one. */
static int option_has(const char* options, const char* option)
{
	size_t len = strlen(option);
	const char* p = options;

	while (*p) {
		size_t tok = strcspn(p, ",");
		if (tok == len && strncmp(p, option, len) == 0)
			return 1;
		p += tok;
		if (*p == ',')
			++p;
	}

	return 0;
}

/****************************************************************************/
/* mount table */

struct mount_entry {
	char source[PATH_MAX];
	char target[PATH_MAX];
	char fstype[64];
	char options[1024];
};

/** Decode the \040 like sequences used in /proc/mounts and /etc/fstab. */
static void mount_unescape(char* str)
{
	char* out = str;

	for (char* p = str; *p; ++p) {
		if (p[0] == '\\' && p[1] >= '0' && p[1] <= '3' && p[2] >= '0' && p[2] <= '7' && p[3] >= '0' && p[3] <= '7') {
			*out++ = ((p[1] - '0') << 6) | ((p[2] - '0') << 3) | (p[3] - '0');
			p += 3;
		} else {
			*out++ = *p;
		}
	}
	*out = 0;
}

/**
 * Parse the next line of a mount table.
 * \return 1 if an entry was read, 0 for a line without entry, -1 at the end.
 */
static int mount_next(const char** cursor, struct mount_entry* entry, const char** line_begin, const char** line_end)
{
	const char* p = *cursor;
	char line[PATH_MAX * 2 + 1200];

	if (*p == 0)
		return -1;

	const char* end = strchr(p, '\n');
	size_t len = end ? (size_t)(end - p) : strlen(p);
	*cursor = end ? end + 1 : p + len;
	if (line_begin)
		*line_begin = p;
	if (line_end)
		*line_end = *cursor;

	if (len >= sizeof(line))
		return 0;
	memcpy(line, p, len);
	line[len] = 0;

	char* fields[4];
	char* save = 0;
	char* tok = strtok_r(line, " \t\r", &save);
	if (!tok || tok[0] == '#')
		return 0;
	for (unsigned i = 0; i < 4; ++i) {
		if (!tok)
			return 0;
		fields[i] = tok;
		tok = strtok_r(0, " \t\r", &save);
	}

	for (unsigned i = 0; i < 4; ++i)
		mount_unescape(fields[i]);

	sncpy(entry->source, sizeof(entry->source), fields[0]);
	sncpy(entry->target, sizeof(entry->target), fields[1]);
	sncpy(entry->fstype, sizeof(entry->fstype), fields[2]);
	sncpy(entry->options, sizeof(entry->options), fields[3]);

	/* ignore a final slash in mount points */
	size_t tl = strlen(entry->target);
	if (tl > 1 && entry->target[tl - 1] == '/')
		entry->target[tl - 1] = 0;

	return 1;
}

static int is_mergerfs(const char* fstype)
{
	return strcmp(fstype, "fuse.mergerfs") == 0 || strcmp(fstype, "mergerfs") == 0;
}

/** Find the filesystem mounted at the specified directory. The last one wins. */
static int mount_find(const char* target, struct mount_entry* found)
{
	ss_t s;
	struct mount_entry entry;
	int ret = -1;
	int r;

	ss_init(&s, 4096);
	if (file_read("/proc/self/mounts", &s) != 0) {
		ss_done(&s);
		return -1;
	}

	const char* cursor = ss_ptr(&s);
	while ((r = mount_next(&cursor, &entry, 0, 0)) >= 0) {
		if (r == 1 && strcmp(entry.target, target) == 0) {
			if (found)
				*found = entry;
			ret = 0;
		}
	}

	ss_done(&s);
	return ret;
}

/**
 * Set or remove the fstab line of a mount point.
 * \param line New line without the final newline, or 0 to remove.
 */
static int fstab_set(const char* target, const char* line)
{
	ss_t old;
	ss_t new;
	struct mount_entry entry;
	const char* begin;
	const char* end;
	int replaced = 0;
	int r;

	ss_init(&old, 4096);
	ss_init(&new, 4096);
	file_read(fstab_path, &old); /* a missing fstab is like an empty one */
	ss_write(&old, "", 1);

	/* pools go after the filesystems they are made of */
	int before_pools = line != 0 && strstr(line, "mergerfs") == 0;

	const char* cursor = ss_ptr(&old);
	while ((r = mount_next(&cursor, &entry, &begin, &end)) >= 0) {
		if (r == 1 && strcmp(entry.target, target) == 0) {
			if (line && !replaced) {
				ss_prints(&new, line);
				ss_prints(&new, "\n");
			}
			replaced = 1;
			continue;
		}
		if (r == 1 && before_pools && !replaced && is_mergerfs(entry.fstype)) {
			ss_prints(&new, line);
			ss_prints(&new, "\n");
			replaced = 1;
		}
		ss_write(&new, begin, end - begin);
		if (end > begin && end[-1] != '\n')
			ss_prints(&new, "\n");
	}

	if (line && !replaced) {
		ss_prints(&new, line);
		ss_prints(&new, "\n");
	}
	ss_write(&new, "", 1);

	int ret = file_replace(fstab_path, ss_ptr(&new), ".snapraidd.bak", 0644);

	ss_done(&old);
	ss_done(&new);
	return ret;
}

/****************************************************************************/
/* mergerfs */

/** Read a runtime option of a mounted pool from its control file. */
static int pool_get(const char* mountpoint, const char* key, char* value, size_t value_size)
{
	char control[PATH_MAX + 16];
	char name[128];

	snprintf(control, sizeof(control), "%s/.mergerfs", mountpoint);
	snprintf(name, sizeof(name), "user.mergerfs.%s", key);

	priv_enter();
	ssize_t n = getxattr(control, name, value, value_size - 1);
	priv_leave();
	if (n < 0) {
		value[0] = 0;
		return -1;
	}

	value[n] = 0;
	return 0;
}

static int pool_put(const char* mountpoint, const char* key, const char* value)
{
	char control[PATH_MAX + 16];
	char name[128];

	snprintf(control, sizeof(control), "%s/.mergerfs", mountpoint);
	snprintf(name, sizeof(name), "user.mergerfs.%s", key);

	priv_enter();
	int ret = setxattr(control, name, value, strlen(value), 0);
	priv_leave();

	return ret;
}

/** Options of a pool that can be read and changed while it's mounted. */
static const char* pool_runtime_keys[] = {
	"category.create", "minfreespace", "moveonenospc", "cache.files", "dropcacheonclose",
	"func.getattr", "inodecalc", "link_cow", "xattr", "statfs", 0
};

/****************************************************************************/
/* inventory */

static void json_statvfs(ss_t* s, int level, const char* path)
{
	struct statvfs vfs;

	priv_enter();
	int ret = statvfs(path, &vfs);
	priv_leave();

	if (ret == 0) {
		ss_jsonf(s, level, "\"total_bytes\": %" PRIu64 ",\n", (uint64_t)vfs.f_blocks * vfs.f_frsize);
		ss_jsonf(s, level, "\"free_bytes\": %" PRIu64 ",\n", (uint64_t)vfs.f_bavail * vfs.f_frsize);
	}
}

/* what the arrays use, see the layout functions below */
#define LAYOUT_MAX 512 /**< Max number of entries of all the arrays together */

#define LAYOUT_DATA 'd'
#define LAYOUT_PARITY 'p'
#define LAYOUT_CONTENT 'c'

struct layout_entry {
	char array[ARRAY_NAME_MAX]; /**< Name of the array */
	char role; /**< One of the LAYOUT_* */
	char name[64]; /**< Name of the data disk, or of the parity level */
	char path[PATH_MAX]; /**< Directory of the data disk, or parity or content file */
	char mount[PATH_MAX]; /**< Mount point of the filesystem holding it. Empty if not known. */
};

struct layout {
	struct layout_entry* entries;
	unsigned count;
};

static void json_mount_use(ss_t* s, int level, const struct layout* layout, const char* target);

static void json_mount_table(ss_t* s, int level, const char* field, const char* path, int with_space, const struct layout* layout)
{
	ss_t text;
	struct mount_entry entry;
	int r;

	ss_init(&text, 4096);
	file_read(path, &text);
	ss_write(&text, "", 1);

	ss_json_array_open(s, &level, field);
	const char* cursor = ss_ptr(&text);
	while ((r = mount_next(&cursor, &entry, 0, 0)) >= 0) {
		if (r != 1)
			continue;
		/* only what lives in a directory of its own */
		if (entry.target[0] != '/')
			continue;
		if (with_space) {
			static const char* pseudo[] = {
				"proc", "sysfs", "devtmpfs", "devpts", "cgroup", "cgroup2", "securityfs", "pstore", "bpf",
				"tracefs", "debugfs", "configfs", "fusectl", "mqueue", "hugetlbfs", "autofs", "binfmt_misc",
				"ramfs", "rpc_pipefs", "nsfs", "efivarfs", "selinuxfs", "squashfs", "overlay", "fuse.lxcfs", 0
			};
			int skip = 0;
			for (unsigned i = 0; pseudo[i]; ++i) {
				if (strcmp(entry.fstype, pseudo[i]) == 0)
					skip = 1;
			}
			if (skip)
				continue;
		}

		ss_json_open(s, &level);
		ss_json_str(s, level, "source", entry.source);
		ss_json_str(s, level, "target", entry.target);
		ss_json_str(s, level, "fstype", entry.fstype);
		ss_json_str(s, level, "options", entry.options);
		if (with_space) {
			struct stat st;
			priv_enter();
			int is_dir = stat(entry.target, &st) == 0 && S_ISDIR(st.st_mode);
			priv_leave();
			ss_json_bool(s, level, "is_dir", is_dir);
			if (is_dir)
				json_statvfs(s, level, entry.target);
			if (layout != 0 && !is_mergerfs(entry.fstype))
				json_mount_use(s, level, layout, entry.target);
		}
		ss_json_close(s, &level);
	}
	ss_json_array_close(s, &level);

	ss_done(&text);
}

static const struct layout_entry* layout_find_dir(const struct layout* layout, const char* dir, int* partial);
static const char* layout_role_name(char role);

static void json_pools(ss_t* s, int level, const struct layout* layout)
{
	ss_t text;
	ss_t fstab;
	struct mount_entry entry;
	int r;

	ss_init(&text, 4096);
	ss_init(&fstab, 4096);
	file_read("/proc/self/mounts", &text);
	ss_write(&text, "", 1);
	file_read(fstab_path, &fstab);
	ss_write(&fstab, "", 1);

	ss_json_array_open(s, &level, "pools");
	const char* cursor = ss_ptr(&text);
	while ((r = mount_next(&cursor, &entry, 0, 0)) >= 0) {
		char value[4096];

		if (r != 1 || !is_mergerfs(entry.fstype))
			continue;

		ss_json_open(s, &level);
		ss_json_str(s, level, "mountpoint", entry.target);
		ss_json_str(s, level, "mount_options", entry.options);
		json_statvfs(s, level, entry.target);
		if (pool_get(entry.target, "version", value, sizeof(value)) == 0)
			ss_json_str(s, level, "version", value);

		/* is it going to be there after a reboot? */
		struct mount_entry saved;
		const char* fc = ss_ptr(&fstab);
		int persistent = 0;
		int fr;
		while ((fr = mount_next(&fc, &saved, 0, 0)) >= 0) {
			if (fr == 1 && strcmp(saved.target, entry.target) == 0 && is_mergerfs(saved.fstype)) {
				persistent = 1;
				ss_json_str(s, level, "fstab_options", saved.options);
			}
		}
		ss_json_bool(s, level, "persistent", persistent);

		ss_json_object_open(s, &level, "options");
		for (unsigned i = 0; pool_runtime_keys[i]; ++i) {
			if (pool_get(entry.target, pool_runtime_keys[i], value, sizeof(value)) == 0)
				ss_json_str(s, level, pool_runtime_keys[i], value);
		}
		ss_json_close(s, &level);

		/* without control file fall back to the mount source, that normally lists the branches */
		if (pool_get(entry.target, "branches", value, sizeof(value)) != 0)
			sncpy(value, sizeof(value), entry.source);

		ss_json_array_open(s, &level, "branches");
		char* save = 0;
		for (char* tok = strtok_r(value, ":", &save); tok; tok = strtok_r(0, ":", &save)) {
			/* branches are in the form /path=MODE,MINFREESPACE */
			char* mode = strchr(tok, '=');
			if (mode)
				*mode++ = 0;
			ss_json_open(s, &level);
			ss_json_str(s, level, "path", tok);
			if (mode) {
				char* comma = strchr(mode, ',');
				if (comma)
					*comma = 0;
				ss_json_str(s, level, "mode", mode);
			}
			json_statvfs(s, level, tok);

			/* what protects the files written in this branch */
			int partial;
			const struct layout_entry* use = layout_find_dir(layout, tok, &partial);
			if (use != 0) {
				ss_json_str(s, level, "array", use->array);
				ss_json_str(s, level, "role", layout_role_name(use->role));
				ss_json_str(s, level, "disk", use->name);
			}
			ss_json_bool(s, level, "protected", use != 0 && use->role == LAYOUT_DATA && !partial);
			ss_json_close(s, &level);
		}
		ss_json_array_close(s, &level);

		ss_json_close(s, &level);
	}
	ss_json_array_close(s, &level);

	ss_done(&text);
	ss_done(&fstab);
}

static void engine_conf_path(struct snapraid_state* state, char* path, size_t path_size)
{
	state_lock();
	array_engine_conf_locked(state, path, path_size);
	state_unlock();

	if (path[0] == 0)
		sncpy(path, path_size, ENGINE_CONF_DEFAULT);
}

/****************************************************************************/
/* layout */

/**
 * What the arrays use: the directory of every data disk, and every parity
 * and content file, as written in their SnapRAID configuration files.
 *
 * It tells which array protects a mount or the branch of a pool, and it
 * keeps a disk from ending in two arrays.
 */

static void layout_init(struct layout* layout)
{
	layout->entries = malloc_nofail(LAYOUT_MAX * sizeof(struct layout_entry));
	layout->count = 0;
}

static void layout_done(struct layout* layout)
{
	free(layout->entries);
}

static void layout_add(struct layout* layout, const char* array, char role, const char* name, const char* path)
{
	if (layout->count >= LAYOUT_MAX || path[0] == 0)
		return;

	struct layout_entry* e = &layout->entries[layout->count++];
	sncpy(e->array, sizeof(e->array), array);
	e->role = role;
	sncpy(e->name, sizeof(e->name), name);
	sncpy(e->path, sizeof(e->path), path);
	e->mount[0] = 0;

	/* /mnt/d1/ and /mnt/d1 are the same place */
	size_t len = strlen(e->path);
	while (len > 1 && e->path[len - 1] == '/')
		e->path[--len] = 0;
}

/**
 * Read the disks and files of an array from the text of its SnapRAID
 * configuration: "data NAME DIR", "parity FILE[,FILE]", "N-parity FILE[,FILE]"
 * and "content FILE".
 */
static void layout_parse(struct layout* layout, const char* array, const char* text)
{
	const char* line = text;

	while (*line) {
		char buf[PATH_MAX + 128];
		const char* end = strchr(line, '\n');
		size_t len = end ? (size_t)(end - line) : strlen(line);
		const char* next = end ? end + 1 : line + len;

		if (len >= sizeof(buf)) {
			line = next;
			continue;
		}
		memcpy(buf, line, len);
		buf[len] = 0;
		line = next;

		/* trim */
		char* s = buf;
		while (*s && isspace((unsigned char)*s))
			++s;
		char* tail = s + strlen(s);
		while (tail > s && isspace((unsigned char)tail[-1]))
			*--tail = 0;
		if (*s == 0 || *s == '#')
			continue;

		/* the keyword */
		char* arg = s;
		while (*arg && !isspace((unsigned char)*arg))
			++arg;
		if (*arg == 0)
			continue;
		*arg++ = 0;
		while (*arg && isspace((unsigned char)*arg))
			++arg;

		size_t kl = strlen(s);
		if (strcmp(s, "data") == 0 || strcmp(s, "disk") == 0) {
			char* dir = arg;
			while (*dir && !isspace((unsigned char)*dir))
				++dir;
			if (*dir == 0)
				continue;
			*dir++ = 0;
			while (*dir && isspace((unsigned char)*dir))
				++dir;
			layout_add(layout, array, LAYOUT_DATA, arg, dir);
		} else if (strcmp(s, "content") == 0) {
			layout_add(layout, array, LAYOUT_CONTENT, "content", arg);
		} else if (strcmp(s, "parity") == 0 || (kl == 8 && strcmp(s + 1, "-parity") == 0)) {
			/* a parity can be split in more files */
			char* save = 0;
			for (char* tok = strtok_r(arg, ",", &save); tok; tok = strtok_r(0, ",", &save)) {
				while (*tok && isspace((unsigned char)*tok))
					++tok;
				char* tok_end = tok + strlen(tok);
				while (tok_end > tok && isspace((unsigned char)tok_end[-1]))
					*--tok_end = 0;
				layout_add(layout, array, LAYOUT_PARITY, s, tok);
			}
		}
	}
}

/**
 * Find for every entry the filesystem holding it: the mount point that is
 * the longest prefix of its path.
 * \param mounts Text of /proc/self/mounts.
 */
static void layout_mounts(struct layout* layout, const char* mounts)
{
	struct mount_entry entry;
	const char* cursor = mounts;
	int r;

	while ((r = mount_next(&cursor, &entry, 0, 0)) >= 0) {
		if (r != 1 || entry.target[0] != '/')
			continue;
		/* a pool is not where a disk is */
		if (is_mergerfs(entry.fstype))
			continue;
		for (unsigned i = 0; i < layout->count; ++i) {
			struct layout_entry* e = &layout->entries[i];
			if (path_inside(e->path, entry.target) && strlen(entry.target) >= strlen(e->mount))
				sncpy(e->mount, sizeof(e->mount), entry.target);
		}
	}
}

/**
 * Load the layout of every array, or of all but one.
 */
static void layout_load(struct layout* layout, struct snapraid_state* exclude)
{
	struct snapraid_host* host = host_ptr();
	char (*paths)[PATH_MAX];
	char (*names)[ARRAY_NAME_MAX];
	unsigned count = 0;
	ss_t text;

	layout_init(layout);

	/* the files are read without holding the state lock */
	state_lock();
	unsigned max = tommy_list_count(&host->state_list);
	paths = malloc_nofail((max + 1) * sizeof(*paths));
	names = malloc_nofail((max + 1) * sizeof(*names));
	for (tommy_node* i = tommy_list_head(&host->state_list); i; i = i->next) {
		struct snapraid_state* state = i->data;
		if (state == exclude)
			continue;
		array_engine_conf_locked(state, paths[count], PATH_MAX);
		if (paths[count][0] == 0)
			sncpy(paths[count], PATH_MAX, ENGINE_CONF_DEFAULT);
		sncpy(names[count], ARRAY_NAME_MAX, state->name);
		++count;
	}
	state_unlock();

	for (unsigned i = 0; i < count; ++i) {
		ss_init(&text, 4096);
		if (file_read(paths[i], &text) == 0) {
			ss_write(&text, "", 1);
			layout_parse(layout, names[i], ss_ptr(&text));
		}
		ss_done(&text);
	}

	free(paths);
	free(names);

	ss_init(&text, 4096);
	file_read("/proc/self/mounts", &text);
	ss_write(&text, "", 1);
	layout_mounts(layout, ss_ptr(&text));
	ss_done(&text);
}

/**
 * Check if two entries are on the same disk: on the same filesystem, when
 * it's known and it isn't the root one, where different directories are
 * the only way to tell things apart.
 */
static int layout_same_disk(const struct layout_entry* a, const struct layout_entry* b)
{
	return a->mount[0] != 0 && strcmp(a->mount, "/") != 0 && strcmp(a->mount, b->mount) == 0;
}

/**
 * Check what an array is going to use against what the other arrays use.
 *
 * A disk belongs to one array only: with a disk in two arrays, a sync of
 * the first makes the parity of the second out of date, and a recovery of
 * the second would bring back old data.
 *
 * \param mine What the array is going to use.
 * \param others What the other arrays use.
 * \return 0 if nothing is shared, otherwise 409 with the reason in msg.
 */
static int layout_conflict(const struct layout* mine, const struct layout* others, char* msg, size_t msg_size)
{
	for (unsigned i = 0; i < mine->count; ++i) {
		const struct layout_entry* a = &mine->entries[i];
		for (unsigned j = 0; j < others->count; ++j) {
			const struct layout_entry* b = &others->entries[j];

			if (a->role == LAYOUT_CONTENT || b->role == LAYOUT_CONTENT) {
				/* content files can be anywhere, also on the disks of another array, but not the same file */
				if (a->role == b->role && strcmp(a->path, b->path) == 0)
					return fail(msg, msg_size, 409, "The content file %s is already the one of the array '%s': every array needs its own content files", a->path, b->array);
				continue;
			}

			int same_path = path_inside(a->path, b->path) || path_inside(b->path, a->path);

			if (a->role == LAYOUT_DATA && b->role == LAYOUT_DATA) {
				if (same_path || layout_same_disk(a, b))
					return fail(msg, msg_size, 409, "%s is already the data disk '%s' of the array '%s': a disk can be in one array only", a->path, b->name, b->array);
			} else if (a->role == LAYOUT_PARITY && b->role == LAYOUT_PARITY) {
				if (strcmp(a->path, b->path) == 0)
					return fail(msg, msg_size, 409, "The parity file %s is already the %s of the array '%s': every array needs its own parity", a->path, b->name, b->array);
				if (layout_same_disk(a, b))
					return fail(msg, msg_size, 409, "The parity file %s is on the disk that holds the %s of the array '%s': a parity disk can serve one array only", a->path, b->name, b->array);
			} else if (same_path || layout_same_disk(a, b)) {
				const struct layout_entry* data = a->role == LAYOUT_DATA ? a : b;
				const struct layout_entry* parity = a->role == LAYOUT_DATA ? b : a;
				return fail(msg, msg_size, 409, "The data disk '%s' (%s) of the array '%s' and the %s (%s) of the array '%s' are on the same disk: a disk is either data or parity, and of one array only", data->name, data->path, data->array, parity->name, parity->path, parity->array);
			}
		}
	}

	return 0;
}

/**
 * Find what protects a directory, like the branch of a pool.
 *
 * \param partial Set to 1 if the directory is only in part inside a data
 *   disk: it contains the directory of a data disk, and also something else.
 * \return The entry of the data disk the directory is in, or of the parity
 *   kept on the same filesystem, or 0 if no array knows about it.
 */
static const struct layout_entry* layout_find_dir(const struct layout* layout, const char* dir, int* partial)
{
	const struct layout_entry* found = 0;

	*partial = 0;

	for (unsigned i = 0; i < layout->count; ++i) {
		const struct layout_entry* e = &layout->entries[i];
		if (e->role == LAYOUT_DATA && path_inside(dir, e->path))
			return e;
	}

	for (unsigned i = 0; i < layout->count; ++i) {
		const struct layout_entry* e = &layout->entries[i];
		if (e->role == LAYOUT_DATA && path_inside(e->path, dir)) {
			*partial = 1;
			return e;
		}
		if (e->role == LAYOUT_PARITY && found == 0 && path_inside(e->path, dir))
			found = e;
	}

	return found;
}

static const char* layout_role_name(char role)
{
	switch (role) {
	case LAYOUT_DATA : return "data";
	case LAYOUT_PARITY : return "parity";
	}
	return "content";
}

/**
 * Emit what the arrays use.
 */
static void json_layout(ss_t* s, int level, const struct layout* layout)
{
	struct snapraid_host* host = host_ptr();
	char (*names)[ARRAY_NAME_MAX];
	char (*paths)[PATH_MAX];
	unsigned count = 0;

	state_lock();
	unsigned max = tommy_list_count(&host->state_list);
	names = malloc_nofail((max + 1) * sizeof(*names));
	paths = malloc_nofail((max + 1) * sizeof(*paths));
	for (tommy_node* i = tommy_list_head(&host->state_list); i; i = i->next) {
		struct snapraid_state* state = i->data;
		sncpy(names[count], ARRAY_NAME_MAX, state->name);
		array_engine_conf_locked(state, paths[count], PATH_MAX);
		if (paths[count][0] == 0)
			sncpy(paths[count], PATH_MAX, ENGINE_CONF_DEFAULT);
		++count;
	}
	state_unlock();

	ss_json_array_open(s, &level, "arrays");
	for (unsigned a = 0; a < count; ++a) {
		struct stat st;

		priv_enter();
		int exists = stat(paths[a], &st) == 0;
		priv_leave();

		ss_json_open(s, &level);
		ss_json_str(s, level, "name", names[a]);
		ss_json_bool(s, level, "default", a == 0);
		ss_json_str(s, level, "engine_conf", paths[a]);
		ss_json_bool(s, level, "exists", exists);
		ss_json_array_open(s, &level, "uses");
		for (unsigned i = 0; i < layout->count; ++i) {
			const struct layout_entry* e = &layout->entries[i];
			if (strcmp(e->array, names[a]) != 0)
				continue;
			ss_json_open(s, &level);
			ss_json_str(s, level, "role", layout_role_name(e->role));
			ss_json_str(s, level, "name", e->name);
			ss_json_str(s, level, "path", e->path);
			if (e->mount[0] != 0)
				ss_json_str(s, level, "mount", e->mount);
			ss_json_close(s, &level);
		}
		ss_json_array_close(s, &level);
		ss_json_close(s, &level);
	}
	ss_json_array_close(s, &level);

	free(names);
	free(paths);
}

/**
 * Emit which array uses a mounted filesystem, and for what.
 */
static void json_mount_use(ss_t* s, int level, const struct layout* layout, const char* target)
{
	const struct layout_entry* best = 0;

	/* data wins over parity, and parity over content: it's what matters for the disk */
	for (unsigned i = 0; i < layout->count; ++i) {
		const struct layout_entry* e = &layout->entries[i];
		if (strcmp(e->mount, target) != 0)
			continue;
		if (best == 0
			|| (e->role == LAYOUT_DATA && best->role != LAYOUT_DATA)
			|| (e->role == LAYOUT_PARITY && best->role == LAYOUT_CONTENT))
			best = e;
	}

	if (best != 0) {
		ss_json_str(s, level, "array", best->array);
		ss_json_str(s, level, "role", layout_role_name(best->role));
		ss_json_str(s, level, "disk", best->name);
	}
}

void storage_inventory_json(struct snapraid_state* state, ss_t* s, int level)
{
	char path[PATH_MAX];
	ss_t text;

	ss_json_bool(s, level, "supported", 1);

	ss_json_object_open(s, &level, "tools");
	ss_json_bool(s, level, "lsblk", tool_exists("lsblk"));
	ss_json_bool(s, level, "sfdisk", tool_exists("sfdisk"));
	ss_json_bool(s, level, "parted", tool_exists("parted"));
	ss_json_bool(s, level, "wipefs", tool_exists("wipefs"));
	ss_json_bool(s, level, "mkfs_ext4", tool_exists("mkfs.ext4"));
	ss_json_bool(s, level, "mkfs_xfs", tool_exists("mkfs.xfs"));
	ss_json_bool(s, level, "mkfs_btrfs", tool_exists("mkfs.btrfs"));
	ss_json_bool(s, level, "mergerfs", tool_exists("mergerfs"));
	ss_json_bool(s, level, "rsync", tool_exists("rsync"));
	ss_json_close(s, &level);

	/* the engine configuration */
	engine_conf_path(state, path, sizeof(path));
	ss_init(&text, 4096);
	ss_json_object_open(s, &level, "engine_conf");
	ss_json_str(s, level, "path", path);
	if (file_read(path, &text) == 0) {
		ss_json_bool(s, level, "exists", 1);
		ss_json_str(s, level, "text", ss_ptr(&text));
	} else {
		ss_json_bool(s, level, "exists", 0);
		ss_json_str(s, level, "text", "");
	}
	ss_json_close(s, &level);
	ss_done(&text);

	/* the block devices, as reported by lsblk that already talks JSON */
	static const char* lsblk_args[] = {
		"--json", "--bytes", "--output",
		"NAME,KNAME,PATH,PKNAME,TYPE,SIZE,FSTYPE,LABEL,UUID,MOUNTPOINT,MODEL,SERIAL,ROTA,TRAN,RM,RO", 0
	};
	ss_init(&text, 8192);
	if (tool_run("lsblk", lsblk_args, 0, &text, 30) == 0 && ss_len(&text) > 2) {
		ss_write(&text, "", 1);
		char* json = ss_ptr(&text);
		char* end = json + strlen(json);
		while (end > json && isspace((unsigned char)end[-1]))
			*--end = 0;
		if (json[0] == '{' && end > json && end[-1] == '}') {
			ss_jsonf(s, level, "\"lsblk\": ");
			ss_prints(s, json);
			ss_prints(s, ",\n");
		}
	}
	ss_done(&text);

	/*
	 * What is on the devices, probed directly. Where udev is missing, like in
	 * containers, lsblk knows nothing about filesystems.
	 */
	static const char* blkid_args[] = { "-c", "/dev/null", "-o", "export", 0 };
	ss_init(&text, 4096);
	tool_run("blkid", blkid_args, 0, &text, 60);
	ss_write(&text, "\n\n", 3);
	ss_json_array_open(s, &level, "blkid");
	int open = 0;
	char* save = 0;
	char* all = ss_ptr(&text);
	for (char* line = all; line && *line; line = save) {
		save = strchr(line, '\n');
		if (save)
			*save++ = 0;
		char* value = strchr(line, '=');
		if (!value) {
			/* an empty line ends the device */
			if (open)
				ss_json_close(s, &level);
			open = 0;
			continue;
		}
		*value++ = 0;
		static const char* keys[] = { "DEVNAME", "UUID", "TYPE", "LABEL", "PTTYPE", "PARTUUID", 0 };
		static const char* names[] = { "device", "uuid", "fstype", "label", "pttype", "partuuid", 0 };
		for (unsigned i = 0; keys[i]; ++i) {
			if (strcmp(line, keys[i]) == 0) {
				if (!open)
					ss_json_open(s, &level);
				open = 1;
				ss_json_str(s, level, names[i], value);
			}
		}
	}
	if (open)
		ss_json_close(s, &level);
	ss_json_array_close(s, &level);
	ss_done(&text);

	struct layout layout;
	layout_load(&layout, 0);
	ss_json_str(s, level, "array", state->name);
	json_layout(s, level, &layout);
	json_mount_table(s, level, "mounts", "/proc/self/mounts", 1, &layout);
	json_mount_table(s, level, "fstab", fstab_path, 0, 0);
	json_pools(s, level, &layout);
	layout_done(&layout);
	storage_job_json(s, level);
}

/****************************************************************************/
/* engine configuration */

int storage_engine_conf_write(struct snapraid_state* state, const char* text, char* msg, size_t msg_size)
{
	char path[PATH_MAX];
	size_t len = strlen(text);

	if (len == 0 || len >= STORAGE_TEXT_MAX)
		return fail(msg, msg_size, 400, "The configuration is empty or too big");

	for (const char* p = text; *p; ++p) {
		if ((unsigned char)*p < 32 && *p != '\n' && *p != '\r' && *p != '\t')
			return fail(msg, msg_size, 400, "The configuration contains control characters");
	}

	engine_conf_path(state, path, sizeof(path));

	/* a disk must not end in two arrays */
	struct layout mine;
	struct layout others;
	ss_t mounts;
	layout_init(&mine);
	layout_parse(&mine, state->name, text);
	ss_init(&mounts, 4096);
	file_read("/proc/self/mounts", &mounts);
	ss_write(&mounts, "", 1);
	layout_mounts(&mine, ss_ptr(&mounts));
	ss_done(&mounts);
	layout_load(&others, state);
	int conflict = layout_conflict(&mine, &others, msg, msg_size);
	layout_done(&mine);
	layout_done(&others);
	if (conflict != 0)
		return conflict;

	pthread_mutex_lock(&storage_mutex);
	char* slash = strrchr(path, '/');
	if (slash != 0 && slash != path) {
		/* the file of a new array may be the first one in its directory */
		*slash = 0;
		make_dirs(path);
		*slash = '/';
	}
	int ret = file_replace(path, text, ".snapraidd.bak", 0644);
	pthread_mutex_unlock(&storage_mutex);

	if (ret != 0)
		return fail(msg, msg_size, 500, "Failed to write %s, %s", path, strerror(errno));

	log_msg(LVL_INFO, "storage: engine configuration %s replaced, previous one kept as .snapraidd.bak", path);
	return 0;
}

/****************************************************************************/
/* format */

static int sys_read(const char* path, char* buf, size_t size)
{
	int f = open(path, O_RDONLY | O_CLOEXEC);
	if (f < 0)
		return -1;

	ssize_t n = read(f, buf, size - 1);
	close(f);
	if (n < 0)
		return -1;

	buf[n] = 0;
	strtrim(buf);
	return 0;
}

static int dir_is_empty(const char* path)
{
	DIR* d = opendir(path);
	struct dirent* dd;
	int empty = 1;

	if (!d)
		return 1;
	while ((dd = readdir(d)) != 0) {
		if (dd->d_name[0] != '.')
			empty = 0;
	}
	closedir(d);

	return empty;
}

/**
 * Find the partitions of a whole disk.
 * \param first If not 0, filled with the kernel name of the first partition.
 * \return The number of partitions.
 */
static unsigned disk_partitions(const char* name, char* first, size_t first_size)
{
	char path[PATH_MAX];
	unsigned count = 0;

	snprintf(path, sizeof(path), "/sys/class/block/%s", name);
	DIR* d = opendir(path);
	if (!d)
		return 0;

	struct dirent* dd;
	while ((dd = readdir(d)) != 0) {
		char sub[PATH_MAX * 2];
		if (strncmp(dd->d_name, name, strlen(name)) != 0)
			continue;
		snprintf(sub, sizeof(sub), "%s/%s/partition", path, dd->d_name);
		if (access(sub, F_OK) != 0)
			continue;
		if (first && (count == 0 || strcmp(dd->d_name, first) < 0))
			sncpy(first, first_size, dd->d_name);
		++count;
	}
	closedir(d);

	return count;
}

/** Check that neither the disk nor any of its partitions is in use. */
static int disk_in_use(const char* name, char* msg, size_t msg_size)
{
	char path[PATH_MAX];
	ss_t s;
	struct mount_entry entry;
	int r;

	/* device mapper, md and similar */
	snprintf(path, sizeof(path), "/sys/class/block/%s/holders", name);
	if (!dir_is_empty(path))
		return fail(msg, msg_size, 409, "The disk %s is in use by another device (RAID, LVM or encryption)", name);

	snprintf(path, sizeof(path), "/sys/class/block/%s", name);
	DIR* d = opendir(path);
	if (d) {
		struct dirent* dd;
		while ((dd = readdir(d)) != 0) {
			char sub[PATH_MAX * 2];
			if (strncmp(dd->d_name, name, strlen(name)) != 0)
				continue;
			snprintf(sub, sizeof(sub), "%s/%s/holders", path, dd->d_name);
			if (!dir_is_empty(sub)) {
				closedir(d);
				return fail(msg, msg_size, 409, "The partition %s is in use by another device (RAID, LVM or encryption)", dd->d_name);
			}
		}
		closedir(d);
	}

	/* mounted filesystems and swap */
	static const char* tables[] = { "/proc/self/mounts", "/proc/swaps", 0 };
	for (unsigned t = 0; tables[t]; ++t) {
		ss_init(&s, 4096);
		file_read(tables[t], &s);
		ss_write(&s, "", 1);

		const char* cursor = ss_ptr(&s);
		const char* begin;
		while ((r = mount_next(&cursor, &entry, &begin, 0)) >= 0) {
			char real[PATH_MAX];
			const char* source = entry.source;

			if (t == 1) {
				/* /proc/swaps has the device as first word, and less than four columns are fine */
				char word[PATH_MAX];
				if (sscanf(begin, "%4095s", word) != 1 || word[0] != '/')
					continue;
				sncpy(entry.source, sizeof(entry.source), word);
			} else if (r != 1) {
				continue;
			}

			if (strncmp(source, "/dev/", 5) != 0)
				continue;
			if (realpath(source, real) == 0)
				sncpy(real, sizeof(real), source);

			const char* base = strrchr(real, '/') + 1;
			size_t nl = strlen(name);
			int same = strcmp(base, name) == 0;
			/* partitions are sda1, nvme0n1p1, loop0p1 */
			if (!same && strncmp(base, name, nl) == 0) {
				const char* tail = base + nl;
				if (*tail == 'p')
					++tail;
				same = *tail != 0 && strspn(tail, "0123456789") == strlen(tail);
			}
			if (same) {
				ss_done(&s);
				return fail(msg, msg_size, 409, "The disk %s is in use: %s is %s", name, real, t == 1 ? "a swap area" : "mounted");
			}
		}
		ss_done(&s);
	}

	return 0;
}

int storage_format(const char* device, const char* fstype, const char* label, const char* purpose, int wipe, char* part, size_t part_size, char* uuid, size_t uuid_size, char* msg, size_t msg_size)
{
	char path[PATH_MAX];
	char value[64];
	char part_name[NAME_MAX + 1];
	struct stat st;
	int ret;

	part[0] = 0;
	uuid[0] = 0;

	if (strncmp(device, "/dev/", 5) != 0 || !valid_chars(device + 5, "_-", 64))
		return fail(msg, msg_size, 400, "Invalid device");
	if (!valid_label(label))
		return fail(msg, msg_size, 400, "Invalid label: use up to 12 letters, digits, '-' or '_'");
	if (strcmp(fstype, "ext4") != 0 && strcmp(fstype, "xfs") != 0 && strcmp(fstype, "btrfs") != 0)
		return fail(msg, msg_size, 400, "Unsupported filesystem: use ext4, xfs or btrfs");

	const char* name = device + 5;
	char mkfs[32];
	snprintf(mkfs, sizeof(mkfs), "mkfs.%s", fstype);
	if (!tool_exists(mkfs))
		return fail(msg, msg_size, 501, "The tool '%s' is not installed", mkfs);
	if (!tool_exists("sfdisk") && !tool_exists("parted"))
		return fail(msg, msg_size, 501, "Neither 'sfdisk' nor 'parted' is installed");

	pthread_mutex_lock(&storage_mutex);
	priv_enter();

	/* it must be a whole writable disk */
	if (stat(device, &st) != 0 || !S_ISBLK(st.st_mode)) {
		ret = fail(msg, msg_size, 400, "%s is not a block device", device);
		goto bail;
	}
	snprintf(path, sizeof(path), "/sys/class/block/%s/partition", name);
	if (access(path, F_OK) == 0) {
		ret = fail(msg, msg_size, 400, "%s is a partition: select the whole disk", device);
		goto bail;
	}
	snprintf(path, sizeof(path), "/sys/class/block/%s/ro", name);
	if (sys_read(path, value, sizeof(value)) != 0 || strcmp(value, "0") != 0) {
		ret = fail(msg, msg_size, 409, "%s is read-only or not a disk", device);
		goto bail;
	}

	ret = disk_in_use(name, msg, msg_size);
	if (ret != 0)
		goto bail;

	/* never touch existing data without being told */
	if (!wipe) {
		static const char* probe_args[4];
		probe_args[0] = "-p";
		probe_args[1] = device;
		probe_args[2] = 0;
		/* blkid returns 2 when nothing is recognized */
		if (disk_partitions(name, 0, 0) != 0 || tool_run("blkid", probe_args, 0, 0, 30) == 0) {
			ret = fail(msg, msg_size, 409, "%s is not blank: it contains a partition table or a filesystem. Confirm the wipe to erase it.", device);
			goto bail;
		}
	}

	log_msg(LVL_WARNING, "storage: formatting %s as %s with label %s", device, fstype, label);

	const char* wipe_args[] = { "--all", "--force", device, 0 };
	if (tool_exists("wipefs")) {
		ret = tool_check("wipefs", wipe_args, 0, 120, msg, msg_size);
		if (ret != 0)
			goto bail;
	}

	/* a partition table with one partition covering the disk */
	if (tool_exists("sfdisk")) {
		const char* sfdisk_args[] = { "--quiet", "--wipe", "always", "--label", "gpt", device, 0 };
		ret = tool_check("sfdisk", sfdisk_args, ",,L\n", 120, msg, msg_size);
	} else {
		const char* parted_args[] = { "--script", "--align", "optimal", device, "mklabel", "gpt", "mkpart", "primary", "1MiB", "100%", 0 };
		ret = tool_check("parted", parted_args, 0, 120, msg, msg_size);
	}
	if (ret != 0)
		goto bail;

	/* wait for the kernel to see the partition, asking explicitly if needed */
	part_name[0] = 0;
	for (unsigned i = 0; i < 80; ++i) {
		if (disk_partitions(name, part_name, sizeof(part_name)) != 0)
			break;
		if (i == 20 || i == 50) {
			const char* partx_args[] = { "--add", device, 0 };
			tool_run("partx", partx_args, 0, 0, 30);
		}
		os_usleep(100000);
	}
	if (part_name[0] == 0) {
		ret = fail(msg, msg_size, 500, "The new partition of %s didn't show up", device);
		goto bail;
	}

	/* where there is no udev (containers) the device node has to be created by hand */
	int self_made = 0;
	snprintf(part, part_size, "/dev/%s", part_name);
	for (unsigned i = 0; i < 30 && stat(part, &st) != 0; ++i)
		os_usleep(100000);
	if (stat(part, &st) != 0) {
		unsigned ma, mi;
		snprintf(path, sizeof(path), "/sys/class/block/%s/dev", part_name);
		if (sys_read(path, value, sizeof(value)) != 0 || sscanf(value, "%u:%u", &ma, &mi) != 2
			|| mknod(part, S_IFBLK | 0660, makedev(ma, mi)) != 0) {
			ret = fail(msg, msg_size, 500, "The device node %s is missing", part);
			goto bail;
		}
		self_made = 1;
	}

	/* the filesystem */
	if (strcmp(fstype, "ext4") == 0) {
		/* no space reserved for root, and for parity few big inodes as suggested by the SnapRAID manual */
		if (strcmp(purpose, "parity") == 0) {
			const char* args[] = { "-q", "-F", "-m", "0", "-T", "largefile4", "-L", label, part, 0 };
			ret = tool_check(mkfs, args, 0, 3600, msg, msg_size);
		} else {
			const char* args[] = { "-q", "-F", "-m", "0", "-L", label, part, 0 };
			ret = tool_check(mkfs, args, 0, 3600, msg, msg_size);
		}
	} else if (strcmp(fstype, "xfs") == 0) {
		const char* args[] = { "-q", "-f", "-L", label, part, 0 };
		ret = tool_check(mkfs, args, 0, 3600, msg, msg_size);
	} else {
		const char* args[] = { "-q", "-f", "-L", label, part, 0 };
		ret = tool_check(mkfs, args, 0, 3600, msg, msg_size);
	}
	if (ret != 0)
		goto bail;

	ss_t out;
	ss_init(&out, 128);
	const char* uuid_args[] = { "-p", "-s", "UUID", "-o", "value", part, 0 };
	if (tool_run("blkid", uuid_args, 0, &out, 30) == 0) {
		ss_write(&out, "", 1);
		sncpy(uuid, uuid_size, ss_ptr(&out));
		strtrim(uuid);
	}
	ss_done(&out);

	if ((self_made || access("/run/udev/control", F_OK) != 0) && uuid[0] != 0 && valid_chars(uuid, "-", 64)) {
		/*
		 * Without udev nobody maintains /dev/disk/by-uuid, where SnapRAID
		 * looks to identify the disks. Drop what the partition was before
		 * and publish the new filesystem.
		 */
		make_dirs("/dev/disk/by-uuid");
		DIR* d = opendir("/dev/disk/by-uuid");
		if (d) {
			struct dirent* dd;
			while ((dd = readdir(d)) != 0) {
				char link[PATH_MAX];
				char dest[PATH_MAX];
				snprintf(link, sizeof(link), "/dev/disk/by-uuid/%s", dd->d_name);
				ssize_t n = readlink(link, dest, sizeof(dest) - 1);
				if (n > 0) {
					dest[n] = 0;
					const char* base = strrchr(dest, '/');
					if (strcmp(base ? base + 1 : dest, part_name) == 0)
						unlink(link);
				}
			}
			closedir(d);
		}
		snprintf(path, sizeof(path), "/dev/disk/by-uuid/%s", uuid);
		if (symlink(part, path) != 0)
			log_msg(LVL_WARNING, "storage: failed to create %s", path);
	}

	log_msg(LVL_INFO, "storage: formatted %s as %s, uuid %s", part, fstype, uuid);
	ret = 0;

bail:
	priv_leave();
	pthread_mutex_unlock(&storage_mutex);
	return ret;
}

/****************************************************************************/
/* mount */

int storage_mount(const char* source, const char* target, const char* fstype, const char* options, int persist, char* msg, size_t msg_size)
{
	char line[PATH_MAX * 2 + 1200];
	int ret;

	int busy = job_busy(msg, msg_size);
	if (busy != 0)
		return busy;

	if (!valid_source(source))
		return fail(msg, msg_size, 400, "Invalid source: use UUID=..., LABEL=... or /dev/...");
	if (!valid_path(target))
		return fail(msg, msg_size, 400, "Invalid mount point: use an absolute path made of letters, digits and . _ - +");
	if (system_path(target))
		return fail(msg, msg_size, 403, "%s is a system directory and cannot be used as mount point", target);
	if (!valid_chars(fstype, "._-", 32) || is_mergerfs(fstype))
		return fail(msg, msg_size, 400, "Invalid filesystem type");
	if (options[0] == 0)
		options = "defaults";
	if (!valid_options(options))
		return fail(msg, msg_size, 400, "Invalid mount options");

	pthread_mutex_lock(&storage_mutex);

	if (mount_find(target, 0) == 0) {
		ret = fail(msg, msg_size, 409, "Something is already mounted at %s", target);
		goto bail;
	}

	/* the same filesystem in two places is almost always a mistake, and for SnapRAID two disks on one device */
	char device[PATH_MAX];
	char link[PATH_MAX];
	device[0] = 0;
	if (strncmp(source, "UUID=", 5) == 0)
		snprintf(link, sizeof(link), "/dev/disk/by-uuid/%s", source + 5);
	else if (strncmp(source, "LABEL=", 6) == 0)
		snprintf(link, sizeof(link), "/dev/disk/by-label/%s", source + 6);
	else
		sncpy(link, sizeof(link), source);
	if (realpath(link, device) != 0) {
		ss_t table;
		struct mount_entry entry;
		int r;
		ss_init(&table, 4096);
		file_read("/proc/self/mounts", &table);
		ss_write(&table, "", 1);
		const char* cursor = ss_ptr(&table);
		while ((r = mount_next(&cursor, &entry, 0, 0)) >= 0) {
			char other[PATH_MAX];
			if (r != 1 || strncmp(entry.source, "/dev/", 5) != 0)
				continue;
			if (realpath(entry.source, other) != 0 && strcmp(other, device) == 0) {
				ss_done(&table);
				ret = fail(msg, msg_size, 409, "%s is already mounted at %s", source, entry.target);
				goto bail;
			}
		}
		ss_done(&table);
	}

	if (make_dirs(target) != 0) {
		ret = fail(msg, msg_size, 500, "Failed to create %s, %s", target, strerror(errno));
		goto bail;
	}
	if (!dir_is_empty(target)) {
		ret = fail(msg, msg_size, 409, "%s is not empty: mounting there would hide its content", target);
		goto bail;
	}

	dir_guard(target, 1);

	const char* args[] = { "-t", fstype, "-o", options, source, target, 0 };
	ret = tool_check("mount", args, 0, 120, msg, msg_size);

	/*
	 * With the "nofail" option mount reports success also when the device
	 * doesn't exist. Trust only what is really mounted.
	 */
	if (ret == 0 && mount_find(target, 0) != 0)
		ret = fail(msg, msg_size, 500, "%s was not mounted: no filesystem found for %s", target, source);
	if (ret != 0) {
		dir_guard(target, 0);
		goto bail;
	}

	if (persist) {
		/*
		 * What goes in fstab must never stop the boot of the machine: with
		 * "nofail" a dead or missing disk is skipped, and by UUID the line
		 * keeps pointing to the same filesystem when the device names change.
		 */
		char by_uuid[128 + 8];
		const char* saved_source = source;
		if (strncmp(source, "/dev/", 5) == 0) {
			static const char* blkid_keys[] = { "-c", "/dev/null", "-s", "UUID", "-o", "value", 0, 0 };
			const char* blkid_args[8];
			ss_t out;
			memcpy(blkid_args, blkid_keys, sizeof(blkid_keys));
			blkid_args[6] = source;
			ss_init(&out, 128);
			if (tool_run("blkid", blkid_args, 0, &out, 30) == 0) {
				ss_write(&out, "", 1);
				char* uuid = ss_ptr(&out);
				size_t ul = strcspn(uuid, "\r\n");
				uuid[ul] = 0;
				if (ul != 0 && ul < 128 && valid_chars(uuid, "-", 128)) {
					snprintf(by_uuid, sizeof(by_uuid), "UUID=%s", uuid);
					saved_source = by_uuid;
				}
			}
			ss_done(&out);
		}
		snprintf(line, sizeof(line), "%s %s %s %s%s 0 2", saved_source, target, fstype, options, option_has(options, "nofail") ? "" : ",nofail");
		if (fstab_set(target, line) != 0) {
			ret = fail(msg, msg_size, 500, "Mounted, but failed to update " FSTAB_PATH ", %s", strerror(errno));
			goto bail;
		}
	}

	log_msg(LVL_INFO, "storage: mounted %s at %s%s", source, target, persist ? " and saved in fstab" : "");
	ret = 0;

bail:
	pthread_mutex_unlock(&storage_mutex);
	return ret;
}

int storage_unmount(const char* target, int forget, char* msg, size_t msg_size)
{
	int ret;

	int busy = job_busy(msg, msg_size);
	if (busy != 0)
		return busy;

	if (!valid_path(target))
		return fail(msg, msg_size, 400, "Invalid mount point");
	if (system_path(target))
		return fail(msg, msg_size, 403, "%s is a system directory", target);

	pthread_mutex_lock(&storage_mutex);

	if (mount_find(target, 0) == 0) {
		const char* args[] = { target, 0 };
		ret = tool_check("umount", args, 0, 120, msg, msg_size);
		if (ret != 0)
			goto bail;
	} else if (!forget) {
		ret = fail(msg, msg_size, 409, "Nothing is mounted at %s", target);
		goto bail;
	}

	/* a directory that is no more a mount point goes back to normal */
	if (forget)
		dir_guard(target, 0);

	if (forget && fstab_set(target, 0) != 0) {
		ret = fail(msg, msg_size, 500, "Unmounted, but failed to update " FSTAB_PATH ", %s", strerror(errno));
		goto bail;
	}

	log_msg(LVL_INFO, "storage: unmounted %s%s", target, forget ? " and removed from fstab" : "");
	ret = 0;

bail:
	pthread_mutex_unlock(&storage_mutex);
	return ret;
}

int storage_mkdir(const char* path, char* msg, size_t msg_size)
{
	if (!valid_path(path))
		return fail(msg, msg_size, 400, "Invalid directory: use an absolute path made of letters, digits and . _ - +");
	if (system_path(path))
		return fail(msg, msg_size, 403, "%s is a system directory", path);

	if (make_dirs(path) != 0)
		return fail(msg, msg_size, 500, "Failed to create %s, %s", path, strerror(errno));

	log_msg(LVL_INFO, "storage: created directory %s", path);
	return 0;
}

/****************************************************************************/
/* pool */

int storage_pool(const char* mountpoint, const char* branches, const char* options, int persist, char* msg, size_t msg_size)
{
	char line[PATH_MAX + 8192];
	char buf[4096];
	struct mount_entry entry;
	struct stat st;
	int ret;

	int busy = job_busy(msg, msg_size);
	if (busy != 0)
		return busy;

	if (!valid_path(mountpoint))
		return fail(msg, msg_size, 400, "Invalid pool mount point: use an absolute path made of letters, digits and . _ - +");
	if (system_path(mountpoint))
		return fail(msg, msg_size, 403, "%s is a system directory and cannot be used as pool", mountpoint);
	if (!valid_chars(branches, "/._-+:=,", sizeof(buf)) || branches[0] != '/')
		return fail(msg, msg_size, 400, "Invalid branches");
	if (!valid_options(options))
		return fail(msg, msg_size, 400, "Invalid pool options");
	if (!tool_exists("mergerfs"))
		return fail(msg, msg_size, 501, "mergerfs is not installed. Install the 'mergerfs' package and try again.");

	/* every branch must be an existing directory, different than the pool itself */
	char seen[sizeof(buf) + 2];
	seen[0] = 0;
	sncpy(buf, sizeof(buf), branches);
	char* save = 0;
	unsigned count = 0;
	for (char* tok = strtok_r(buf, ":", &save); tok; tok = strtok_r(0, ":", &save)) {
		char* mode = strchr(tok, '=');
		if (mode)
			*mode = 0;
		priv_enter();
		int is_dir = valid_path(tok) && stat(tok, &st) == 0 && S_ISDIR(st.st_mode);
		priv_leave();
		if (!is_dir)
			return fail(msg, msg_size, 400, "The branch %s is not an existing directory", tok);
		if (path_inside(tok, mountpoint) || path_inside(mountpoint, tok))
			return fail(msg, msg_size, 400, "The pool %s and its branch %s overlap: keep the pool outside of every disk folder", mountpoint, tok);
		if (strstr(seen, tok) != 0) {
			/* a real duplicate only if delimited */
			char key[PATH_MAX + 2];
			snprintf(key, sizeof(key), "%s:", tok);
			if (strstr(seen, key) != 0)
				return fail(msg, msg_size, 400, "The branch %s is listed twice", tok);
		}
		sncat(seen, sizeof(seen), tok);
		sncat(seen, sizeof(seen), ":");

		/* a parity disk in the pool gets filled with data, and the parity cannot grow anymore */
		priv_enter();
		DIR* bd = opendir(tok);
		int has_parity = 0;
		if (bd) {
			struct dirent* dd;
			while ((dd = readdir(bd)) != 0) {
				size_t nl = strlen(dd->d_name);
				if (strncmp(dd->d_name, "snapraid.", 9) == 0 && nl >= 6 && strcmp(dd->d_name + nl - 6, "parity") == 0)
					has_parity = 1;
			}
			closedir(bd);
		}
		priv_leave();
		if (has_parity)
			return fail(msg, msg_size, 400, "%s holds a SnapRAID parity file: parity disks must never be part of a pool", tok);
		++count;
	}
	if (count == 0)
		return fail(msg, msg_size, 400, "At least one branch is required");

	pthread_mutex_lock(&storage_mutex);

	if (mount_find(mountpoint, &entry) == 0) {
		if (!is_mergerfs(entry.fstype)) {
			ret = fail(msg, msg_size, 409, "%s is already used by a %s filesystem", mountpoint, entry.fstype);
			goto bail;
		}

		/* a mounted pool is changed on the fly, nobody using it notices */
		if (pool_put(mountpoint, "branches", branches) != 0) {
			ret = fail(msg, msg_size, 500, "Failed to change the branches of %s, %s", mountpoint, strerror(errno));
			goto bail;
		}

		sncpy(buf, sizeof(buf), options);
		save = 0;
		for (char* tok = strtok_r(buf, ",", &save); tok; tok = strtok_r(0, ",", &save)) {
			char* value = strchr(tok, '=');
			if (!value)
				continue;
			*value++ = 0;
			for (unsigned i = 0; pool_runtime_keys[i]; ++i) {
				if (strcmp(tok, pool_runtime_keys[i]) != 0)
					continue;

				/*
				 * Some versions of mergerfs accept a policy they don't know
				 * without reporting an error, and are then left without a
				 * usable one: check the name before it reaches the pool.
				 */
				if ((strncmp(tok, "category.", 9) == 0 || strncmp(tok, "func.", 5) == 0) && !valid_policy(value)) {
					ret = fail(msg, msg_size, 400, "The pool refused %s=%s: it's not a policy of mergerfs", tok, value);
					goto bail;
				}
				if (pool_put(mountpoint, tok, value) != 0) {
					ret = fail(msg, msg_size, 400, "The pool refused %s=%s, %s", tok, value, strerror(errno));
					goto bail;
				}
			}
		}
	} else {
		if (make_dirs(mountpoint) != 0) {
			ret = fail(msg, msg_size, 500, "Failed to create %s, %s", mountpoint, strerror(errno));
			goto bail;
		}
		if (!dir_is_empty(mountpoint)) {
			ret = fail(msg, msg_size, 409, "%s is not empty: a pool would hide its content", mountpoint);
			goto bail;
		}

		dir_guard(mountpoint, 1);

		const char* args[] = { "-o", options, branches, mountpoint, 0 };
		ret = tool_check("mergerfs", args, 0, 120, msg, msg_size);
		if (ret == 0 && (mount_find(mountpoint, &entry) != 0 || !is_mergerfs(entry.fstype)))
			ret = fail(msg, msg_size, 500, "The pool %s did not come up, check the mergerfs options", mountpoint);
		if (ret != 0) {
			dir_guard(mountpoint, 0);
			goto bail;
		}
	}

	if (persist) {
		/*
		 * A pool that cannot come up must never stop the boot of the machine,
		 * and that takes the "nofail" option. The generic helper of FUSE
		 * drops it before starting mergerfs, while the helper of the mergerfs
		 * package hands it over, and mergerfs refuses what it doesn't know.
		 * So go through the FUSE helper when there is one, and without it
		 * keep the type of the mergerfs helper and leave the options alone.
		 */
		int fuse_helper = tool_exists("mount.fuse");
		const char* type = fuse_helper || !tool_exists("mount.mergerfs") ? "fuse.mergerfs" : "mergerfs";
		snprintf(line, sizeof(line), "%s %s %s %s%s 0 0", branches, mountpoint, type, options, fuse_helper && !option_has(options, "nofail") ? ",nofail" : "");
		if (fstab_set(mountpoint, line) != 0) {
			ret = fail(msg, msg_size, 500, "Pool active, but failed to update " FSTAB_PATH ", %s", strerror(errno));
			goto bail;
		}
	}

	log_msg(LVL_INFO, "storage: pool %s set to %s%s", mountpoint, branches, persist ? " and saved in fstab" : "");
	ret = 0;

bail:
	pthread_mutex_unlock(&storage_mutex);
	return ret;
}

/****************************************************************************/
/* format in background */

static void* format_thread(void* arg)
{
	char msg[MSG_MAX] = "";
	char part[PATH_MAX];
	char uuid[128];

	(void)arg;

	int ret = storage_format(job.target, job.b, job.c, job.d, job.flag, part, sizeof(part), uuid, sizeof(uuid), msg, sizeof(msg));

	pthread_mutex_lock(&job_mutex);
	sncpy(job.part, sizeof(job.part), part);
	sncpy(job.uuid, sizeof(job.uuid), uuid);
	pthread_mutex_unlock(&job_mutex);

	job_finish(ret, ret == 0 ? "Formatted" : msg);
	return 0;
}

int storage_format_start(const char* device, const char* fstype, const char* label, const char* purpose, int wipe, char* msg, size_t msg_size)
{
	/* what can be refused immediately, the rest is reported by the job */
	if (strncmp(device, "/dev/", 5) != 0 || !valid_chars(device + 5, "_-", 64))
		return fail(msg, msg_size, 400, "Invalid device");
	if (!valid_label(label))
		return fail(msg, msg_size, 400, "Invalid label: use up to 12 letters, digits, '-' or '_'");
	if (!valid_chars(fstype, "", 16) || !valid_chars(purpose, "", 16))
		return fail(msg, msg_size, 400, "Invalid filesystem or purpose");

	int ret = job_begin("format", device, msg, msg_size);
	if (ret != 0)
		return ret;

	sncpy(job.b, sizeof(job.b), fstype);
	sncpy(job.c, sizeof(job.c), label);
	sncpy(job.d, sizeof(job.d), purpose);
	job.flag = wipe;

	return job_launch(format_thread, msg, msg_size);
}

/****************************************************************************/
/* pool branches */

#define BRANCH_MAX 64

struct pool_branch {
	char path[PATH_MAX];
	int writable;
	uint64_t total;
	uint64_t free;
};

/** Split the branch list of mergerfs: /path=MODE,MINFREE:/path... */
static void pool_parse_branches(char* value, struct pool_branch* branches, unsigned* count)
{
	char* save = 0;

	*count = 0;
	for (char* tok = strtok_r(value, ":", &save); tok && *count < BRANCH_MAX; tok = strtok_r(0, ":", &save)) {
		struct pool_branch* b = &branches[*count];
		char* mode = strchr(tok, '=');
		if (mode)
			*mode++ = 0;
		sncpy(b->path, sizeof(b->path), tok);
		size_t len = strlen(b->path);
		if (len > 1 && b->path[len - 1] == '/')
			b->path[len - 1] = 0;
		b->writable = !mode || strncmp(mode, "RW", 2) == 0;
		b->total = 0;
		b->free = 0;
		++*count;
	}
}

/**
 * How many bytes have to move from the fuller to the emptier disk to bring
 * both at the same fill level.
 */
static uint64_t balance_meet(uint64_t used_src, uint64_t total_src, uint64_t used_dst, uint64_t total_dst)
{
	if (total_src == 0 || total_dst == 0)
		return 0;

	/* the level both end at, and how far the source is above it */
	double level = ((double)used_src + (double)used_dst) / ((double)total_src + (double)total_dst);
	double move = (double)used_src - level * (double)total_src;

	if (move <= 0)
		return 0;

	return (uint64_t)(move + 0.5);
}

/** A directory inside a pool: absolute, and never climbing out of it. */
static int valid_browse_path(const char* path)
{
	size_t len = strlen(path);

	if (path[0] != '/' || len >= PATH_MAX / 2)
		return 0;
	if (strstr(path, "/../") != 0 || strstr(path, "//") != 0)
		return 0;
	if (len >= 3 && strcmp(path + len - 3, "/..") == 0)
		return 0;

	return 1;
}

/** Read the branches of a mounted pool. */
static int pool_branches(const char* mountpoint, struct pool_branch* branches, unsigned* count, char* msg, size_t msg_size)
{
	struct mount_entry entry;
	char value[BRANCH_MAX * 128];

	*count = 0;

	if (!valid_path(mountpoint) || mount_find(mountpoint, &entry) != 0 || !is_mergerfs(entry.fstype))
		return fail(msg, msg_size, 400, "%s is not a mounted mergerfs pool", mountpoint);
	if (pool_get(mountpoint, "branches", value, sizeof(value)) != 0)
		return fail(msg, msg_size, 500, "Cannot read the branches of %s", mountpoint);

	pool_parse_branches(value, branches, count);

	return 0;
}

static void pool_branches_space(struct pool_branch* branches, unsigned count)
{
	for (unsigned i = 0; i < count; ++i) {
		struct statvfs vfs;
		branches[i].total = 0;
		branches[i].free = 0;
		if (statvfs(branches[i].path, &vfs) == 0) {
			branches[i].total = (uint64_t)vfs.f_blocks * vfs.f_frsize;
			branches[i].free = (uint64_t)vfs.f_bavail * vfs.f_frsize;
		}
	}
}

/** Files that are never touched: SnapRAID's own, and what the filesystem owns. */
static int walk_skip(const char* name, int top)
{
	if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0)
		return 1;
	if (top && (strcmp(name, "lost+found") == 0 || strncmp(name, "snapraid.content", 16) == 0
		|| strncmp(name, ".snapraid", 9) == 0 || strncmp(name, "snapraid.", 9) == 0))
		return 1;
	return 0;
}

typedef int walk_func(const char* rel, const struct stat* st, void* arg);

/**
 * Visit the regular files of a tree. The callback gets the path relative to the root,
 * starting with /, and stops the visit returning not zero.
 */
static int walk_tree(const char* root, const char* rel, unsigned depth, walk_func* func, void* arg)
{
	char path[PATH_MAX];
	int ret = 0;

	if (depth > 64 || job_stopping())
		return 0;
	if (snprintf(path, sizeof(path), "%s%s", root, rel) >= (int)sizeof(path))
		return 0;

	DIR* d = opendir(path);
	if (!d)
		return 0;

	struct dirent* dd;
	while (ret == 0 && (dd = readdir(d)) != 0) {
		char sub[PATH_MAX];
		struct stat st;

		if (walk_skip(dd->d_name, rel[0] == 0))
			continue;
		if (snprintf(sub, sizeof(sub), "%s/%s", rel, dd->d_name) >= (int)sizeof(sub))
			continue;
		if (snprintf(path, sizeof(path), "%s%s", root, sub) >= (int)sizeof(path))
			continue;
		if (lstat(path, &st) != 0)
			continue;
		if (S_ISDIR(st.st_mode))
			ret = walk_tree(root, sub, depth + 1, func, arg);
		else if (S_ISREG(st.st_mode))
			ret = func(sub, &st, arg);
	}
	closedir(d);

	return ret;
}

/****************************************************************************/
/* balance */

#define BALANCE_BATCH 512

struct balance_pick {
	const char* dst;
	uint64_t max_size; /**< Biggest file worth moving */
	unsigned count;
	char* rel[BALANCE_BATCH];
	uint64_t size[BALANCE_BATCH];
};

static int balance_collect(const char* rel, const struct stat* st, void* arg)
{
	struct balance_pick* pick = arg;
	char path[PATH_MAX];
	struct stat other;

	/* empty, hard linked, too big, or just written files stay where they are */
	if (st->st_size == 0 || st->st_nlink != 1 || (uint64_t)st->st_size > pick->max_size)
		return 0;
	if (st->st_mtime + 300 > time(0))
		return 0;

	/* never over a file with the same name */
	snprintf(path, sizeof(path), "%s%s", pick->dst, rel);
	if (lstat(path, &other) == 0)
		return 0;

	pick->rel[pick->count] = strdup(rel);
	pick->size[pick->count] = st->st_size;
	++pick->count;

	return pick->count == BALANCE_BATCH;
}

static double branch_fill(const struct pool_branch* b)
{
	return b->total ? (double)(b->total - b->free) * 100.0 / b->total : 0;
}

static void* balance_thread(void* arg)
{
	struct pool_branch branches[BRANCH_MAX];
	unsigned count;
	char msg[MSG_MAX] = "";
	char value[64];
	unsigned errors = 0;
	uint64_t minfree = 0;

	(void)arg;

	priv_enter();

	if (pool_branches(job.target, branches, &count, msg, sizeof(msg)) != 0) {
		priv_leave();
		job_finish(400, msg);
		return 0;
	}

	if (pool_get(job.target, "minfreespace", value, sizeof(value)) != 0 || stru64(&minfree, value) != 0)
		minfree = 0;

	while (1) {
		struct balance_pick pick;
		int src = -1;
		int dst = -1;

		if (job_stopping()) {
			snprintf(msg, sizeof(msg), "Stopped on request");
			break;
		}

		pool_branches_space(branches, count);
		for (unsigned i = 0; i < count; ++i) {
			if (!branches[i].writable || branches[i].total == 0)
				continue;
			if (src < 0 || branch_fill(&branches[i]) > branch_fill(&branches[src]))
				src = i;
			if (dst < 0 || branch_fill(&branches[i]) < branch_fill(&branches[dst]))
				dst = i;
		}
		if (src < 0 || src == dst) {
			snprintf(msg, sizeof(msg), "At least two writable disks are needed");
			break;
		}

		double gap = branch_fill(&branches[src]) - branch_fill(&branches[dst]);
		if (gap <= job.spread) {
			snprintf(msg, sizeof(msg), "Balanced: the disks are within %u points of each other", job.spread);
			break;
		}
		if (job.bytes >= job.max_bytes) {
			snprintf(msg, sizeof(msg), "Stopped at the requested amount, the disks are %.0f points apart", gap);
			break;
		}

		/*
		 * Moving a file of this size makes the two disks meet: bigger ones
		 * would only swap the problem.
		 */
		uint64_t used_src = branches[src].total - branches[src].free;
		uint64_t used_dst = branches[dst].total - branches[dst].free;
		uint64_t meet = balance_meet(used_src, branches[src].total, used_dst, branches[dst].total);
		uint64_t room = branches[dst].free > minfree ? branches[dst].free - minfree : 0;

		memset(&pick, 0, sizeof(pick));
		pick.dst = branches[dst].path;
		pick.max_size = meet < room ? meet : room;
		if (job.max_bytes - job.bytes < pick.max_size)
			pick.max_size = job.max_bytes - job.bytes;

		job_current("looking for files to move");
		if (pick.max_size > 0)
			walk_tree(branches[src].path, "", 0, balance_collect, &pick);

		if (pick.count == 0) {
			snprintf(msg, sizeof(msg), "Nothing more can be moved, the disks are %.0f points apart", gap);
			break;
		}

		uint64_t moved = 0;
		for (unsigned i = 0; i < pick.count; ++i) {
			char from[PATH_MAX * 2];
			char to[PATH_MAX];

			/* after enough was moved, measure again */
			if (job_stopping() || errors >= 5 || moved + pick.size[i] > pick.max_size)
				continue;

			snprintf(from, sizeof(from), "%s/.%s", branches[src].path, pick.rel[i]);
			snprintf(to, sizeof(to), "%s/", branches[dst].path);
			job_current(pick.rel[i]);

			/* the same recipe of mergerfs.balance */
			const char* args[] = { "-aHAXWE", "--numeric-ids", "--preallocate", "--relative", "--remove-source-files", from, to, 0 };
			ss_t out;
			ss_init(&out, 256);
			int ret = tool_run("rsync", args, 0, &out, 24 * 3600);
			ss_done(&out);
			if (ret != 0) {
				++errors;
				log_msg(LVL_WARNING, "storage: balance failed to move %s, rsync exit code %d", from, ret);
				continue;
			}

			moved += pick.size[i];
			pthread_mutex_lock(&job_mutex);
			++job.files;
			job.bytes += pick.size[i];
			pthread_mutex_unlock(&job_mutex);
		}

		for (unsigned i = 0; i < pick.count; ++i)
			free(pick.rel[i]);

		if (errors >= 5) {
			snprintf(msg, sizeof(msg), "Stopped after repeated errors moving files, see the daemon log");
			break;
		}
		if (moved == 0) {
			snprintf(msg, sizeof(msg), "Nothing more can be moved, the disks are %.0f points apart", gap);
			break;
		}
	}

	priv_leave();
	job_finish(errors >= 5 ? 500 : 0, msg);
	return 0;
}

int storage_balance_start(const char* mountpoint, uint64_t max_bytes, unsigned spread, char* msg, size_t msg_size)
{
	struct pool_branch branches[BRANCH_MAX];
	unsigned count;

	if (!tool_exists("rsync"))
		return fail(msg, msg_size, 501, "rsync is not installed. Install the 'rsync' package and try again.");
	if (max_bytes == 0)
		return fail(msg, msg_size, 400, "Nothing to move");
	if (spread < 1 || spread > 50)
		return fail(msg, msg_size, 400, "The allowed difference must be between 1 and 50 points");

	priv_enter();
	int ret = pool_branches(mountpoint, branches, &count, msg, msg_size);
	priv_leave();
	if (ret != 0)
		return ret;

	/*
	 * Moving files under a sync, a scrub or a recovery of the same disks
	 * makes the engine see files appear and disappear. The balance claims
	 * the arrays it touches: it doesn't start while one of them works on
	 * its disks, and they wait for the balance to end.
	 */
	struct layout layout;
	char claims[JOB_CLAIMS_MAX][ARRAY_NAME_MAX];
	unsigned claims_count = 0;
	layout_load(&layout, 0);
	for (unsigned i = 0; i < count; ++i) {
		int partial;
		const struct layout_entry* use = layout_find_dir(&layout, branches[i].path, &partial);
		if (use == 0 || use->role != LAYOUT_DATA)
			continue;
		int known = 0;
		for (unsigned j = 0; j < claims_count; ++j) {
			if (strcmp(claims[j], use->array) == 0)
				known = 1;
		}
		if (!known && claims_count < JOB_CLAIMS_MAX)
			sncpy(claims[claims_count++], ARRAY_NAME_MAX, use->array);
	}
	layout_done(&layout);

	state_lock();
	for (unsigned i = 0; i < claims_count; ++i) {
		const char* busy = array_heavy_command_locked(claims[i]);
		if (busy != 0) {
			ret = fail(msg, msg_size, 409, "The array '%s' is running a %s on the disks of this pool. Wait for it to finish, then balance.", claims[i], busy);
			state_unlock();
			return ret;
		}
	}

	ret = job_begin("balance", mountpoint, msg, msg_size);
	if (ret != 0) {
		state_unlock();
		return ret;
	}

	job.max_bytes = max_bytes;
	job.spread = spread;
	memcpy(job.claims, claims, sizeof(claims));
	job.claims_count = claims_count;
	state_unlock();

	return job_launch(balance_thread, msg, msg_size);
}

/****************************************************************************/
/* duplicates */

struct dup_scan {
	struct pool_branch* branches;
	unsigned count;
	unsigned index; /**< Branch being visited */
};

static int dup_check(const char* rel, const struct stat* st, void* arg)
{
	struct dup_scan* scan = arg;
	char path[PATH_MAX];
	struct stat other;
	unsigned copies = 0;
	int level = 2;

	/* reported only from the last branch having it */
	for (unsigned i = scan->index + 1; i < scan->count; ++i) {
		snprintf(path, sizeof(path), "%s%s", scan->branches[i].path, rel);
		if (lstat(path, &other) == 0 && S_ISREG(other.st_mode))
			return 0;
	}

	pthread_mutex_lock(&job_mutex);
	++job.files;
	pthread_mutex_unlock(&job_mutex);

	for (unsigned i = 0; i < scan->index; ++i) {
		snprintf(path, sizeof(path), "%s%s", scan->branches[i].path, rel);
		if (lstat(path, &other) == 0 && S_ISREG(other.st_mode))
			++copies;
	}
	if (copies == 0)
		return 0;

	pthread_mutex_lock(&job_mutex);
	++job.found;
	job.found_bytes += (uint64_t)st->st_size * copies;
	if (job.found <= JOB_RESULT_MAX) {
		ss_t* s = &job.result;
		ss_json_open(s, &level);
		ss_json_str(s, level, "path", rel);
		ss_json_array_open(s, &level, "copies");
		for (unsigned i = 0; i <= scan->index; ++i) {
			snprintf(path, sizeof(path), "%s%s", scan->branches[i].path, rel);
			if (lstat(path, &other) != 0 || !S_ISREG(other.st_mode))
				continue;
			ss_json_open(s, &level);
			ss_json_str(s, level, "branch", scan->branches[i].path);
			ss_jsonf(s, level, "\"size\": %" PRIu64 ",\n", (uint64_t)other.st_size);
			ss_jsonf(s, level, "\"mtime\": %" PRIi64 ",\n", (int64_t)other.st_mtime);
			ss_json_close(s, &level);
		}
		ss_json_array_close(s, &level);
		ss_json_close(s, &level);
	}
	pthread_mutex_unlock(&job_mutex);

	return 0;
}

static void* duplicates_thread(void* arg)
{
	struct pool_branch branches[BRANCH_MAX];
	struct dup_scan scan;
	char msg[MSG_MAX] = "";

	(void)arg;

	priv_enter();

	if (pool_branches(job.target, branches, &scan.count, msg, sizeof(msg)) != 0) {
		priv_leave();
		job_finish(400, msg);
		return 0;
	}

	scan.branches = branches;
	for (scan.index = 1; scan.index < scan.count && !job_stopping(); ++scan.index) {
		job_current(branches[scan.index].path);
		walk_tree(branches[scan.index].path, "", 0, dup_check, &scan);
	}

	priv_leave();

	if (job_stopping())
		job_finish(0, "Stopped on request, the list is partial");
	else if (job.found == 0)
		job_finish(0, "No file is present on more than one disk");
	else
		job_finish(0, "Files present on more than one disk were found");
	return 0;
}

int storage_duplicates_start(const char* mountpoint, char* msg, size_t msg_size)
{
	struct pool_branch branches[BRANCH_MAX];
	unsigned count;

	priv_enter();
	int ret = pool_branches(mountpoint, branches, &count, msg, msg_size);
	priv_leave();
	if (ret != 0)
		return ret;

	ret = job_begin("duplicates", mountpoint, msg, msg_size);
	if (ret != 0)
		return ret;

	return job_launch(duplicates_thread, msg, msg_size);
}

/****************************************************************************/
/* browse */

#define BROWSE_MAX 2000

struct browse_entry {
	char name[NAME_MAX + 1];
	int is_dir;
	uint64_t size;
	int64_t mtime;
	uint64_t mask; /**< Branches having it */
	unsigned copies; /**< Regular files with this name */
};

int storage_browse_json(const char* mountpoint, const char* path, ss_t* s, int level, char* msg, size_t msg_size)
{
	struct pool_branch branches[BRANCH_MAX];
	unsigned count;
	unsigned entries = 0;
	int truncated = 0;

	/* only inside the pool */
	if (!valid_browse_path(path))
		return fail(msg, msg_size, 400, "Invalid path");

	priv_enter();

	int ret = pool_branches(mountpoint, branches, &count, msg, msg_size);
	if (ret != 0) {
		priv_leave();
		return ret;
	}

	struct browse_entry* list = malloc_nofail(sizeof(struct browse_entry) * BROWSE_MAX);

	for (unsigned b = 0; b < count; ++b) {
		char dir[PATH_MAX * 2];
		if (snprintf(dir, sizeof(dir), "%s%s", branches[b].path, path) >= (int)sizeof(dir))
			continue;
		DIR* d = opendir(dir);
		if (!d)
			continue;

		struct dirent* dd;
		while ((dd = readdir(d)) != 0) {
			char file[PATH_MAX * 3];
			struct stat st;

			if (walk_skip(dd->d_name, path[1] == 0))
				continue;
			snprintf(file, sizeof(file), "%s/%s", dir, dd->d_name);
			if (lstat(file, &st) != 0 || (!S_ISDIR(st.st_mode) && !S_ISREG(st.st_mode)))
				continue;

			struct browse_entry* e = 0;
			for (unsigned i = 0; i < entries; ++i) {
				if (strcmp(list[i].name, dd->d_name) == 0) {
					e = &list[i];
					break;
				}
			}
			if (!e) {
				if (entries == BROWSE_MAX) {
					truncated = 1;
					continue;
				}
				e = &list[entries++];
				memset(e, 0, sizeof(*e));
				sncpy(e->name, sizeof(e->name), dd->d_name);
				e->is_dir = S_ISDIR(st.st_mode);
				e->size = S_ISDIR(st.st_mode) ? 0 : st.st_size;
				e->mtime = st.st_mtime;
			}
			e->mask |= 1ULL << b;
			if (S_ISREG(st.st_mode))
				++e->copies;
		}
		closedir(d);
	}

	priv_leave();

	ss_json_str(s, level, "pool", mountpoint);
	ss_json_str(s, level, "path", path);
	ss_json_bool(s, level, "truncated", truncated);
	ss_json_array_open(s, &level, "branches");
	for (unsigned b = 0; b < count; ++b)
		ss_json_elem(s, level, branches[b].path);
	ss_json_array_close(s, &level);
	ss_json_array_open(s, &level, "entries");
	for (unsigned i = 0; i < entries; ++i) {
		ss_json_open(s, &level);
		ss_json_str(s, level, "name", list[i].name);
		ss_json_bool(s, level, "dir", list[i].is_dir);
		ss_jsonf(s, level, "\"size\": %" PRIu64 ",\n", list[i].size);
		ss_jsonf(s, level, "\"mtime\": %" PRIi64 ",\n", list[i].mtime);
		ss_json_bool(s, level, "duplicate", list[i].copies > 1);
		ss_json_array_open(s, &level, "on");
		for (unsigned b = 0; b < count; ++b) {
			if (list[i].mask & (1ULL << b))
				ss_jsonf(s, level, "%u,\n", b);
		}
		ss_json_array_close(s, &level);
		ss_json_close(s, &level);
	}
	ss_json_array_close(s, &level);

	free(list);
	return 0;
}

/****************************************************************************/
/* selftest */

#define CHECK(cond) \
	do { \
		if (!(cond)) { \
			fprintf(stderr, "Failed storage test at line %d: %s\n", __LINE__, #cond); \
			return -1; \
		} \
	} while (0)

static int test_validation(void)
{
	/* paths: absolute, plain characters, nothing to climb or to inject */
	CHECK(valid_path("/mnt/disk1"));
	CHECK(valid_path("/mnt/my-disk_2.old+x"));
	CHECK(!valid_path("mnt/disk1"));
	CHECK(!valid_path("/"));
	CHECK(!valid_path(""));
	CHECK(!valid_path("/mnt/../etc"));
	CHECK(!valid_path("/mnt//disk1"));
	CHECK(!valid_path("/mnt/disk 1"));
	CHECK(!valid_path("/mnt/disk1;reboot"));
	CHECK(!valid_path("/mnt/$(id)"));
	CHECK(!valid_path("/mnt/disk1\n/dev/sda / ext4"));
	CHECK(!valid_path("/mnt/d\\040x"));
	CHECK(!valid_path("/mnt/disk#1"));

	/* system directories are never mount points */
	CHECK(system_path("/"));
	CHECK(system_path("/etc"));
	CHECK(system_path("/etc/"));
	CHECK(system_path("/etc/snapraid"));
	CHECK(system_path("/usr/local/data"));
	CHECK(system_path("/mnt"));
	CHECK(system_path("/mnt/"));
	CHECK(system_path("/home"));
	CHECK(system_path("/var/lib/x"));
	CHECK(!system_path("/mnt/disk1"));
	CHECK(!system_path("/home/user/pool"));
	CHECK(!system_path("/srv/storage"));
	CHECK(!system_path("/etcetera"));
	CHECK(!system_path("/variety"));

	CHECK(valid_source("UUID=1b278c47-a89c-467d-bfac-5952f38c8773"));
	CHECK(valid_source("UUID=1234-ABCD"));
	CHECK(valid_source("LABEL=disk_1"));
	CHECK(valid_source("/dev/sdb1"));
	CHECK(valid_source("/dev/mapper/vg-data"));
	CHECK(valid_source("/dev/disk/by-id/ata-WDC_WD40EFAX-68JH4N1_WD-WX12D80-part1"));
	CHECK(!valid_source("UUID="));
	CHECK(!valid_source("UUID=12 34"));
	CHECK(!valid_source("LABEL=my disk"));
	CHECK(!valid_source("/etc/passwd"));
	CHECK(!valid_source("//server/share"));
	CHECK(!valid_source("server:/export"));
	CHECK(!valid_source("/dev/../etc/shadow"));

	CHECK(valid_options("defaults,noatime,nofail"));
	CHECK(valid_options("cache.files=off,category.create=pfrd,minfreespace=20G,fsname=mergerfs"));
	CHECK(!valid_options(""));
	CHECK(!valid_options("defaults nofail"));
	CHECK(!valid_options("defaults\tnofail"));
	CHECK(!valid_options("-o,defaults"));
	CHECK(!valid_options("defaults,x=$(reboot)"));
	CHECK(!valid_options("defaults 0 0\n/dev/sda / ext4 defaults"));

	CHECK(valid_label("disk1"));
	CHECK(valid_label("parity6-8"));
	CHECK(valid_label("twelve_chars"));
	CHECK(!valid_label("thirteen_char"));
	CHECK(!valid_label(""));
	CHECK(!valid_label("my disk"));
	CHECK(!valid_label("-L"));

	CHECK(valid_browse_path("/"));
	CHECK(valid_browse_path("/Movies/Some Film (2020)"));
	CHECK(valid_browse_path("/a/..b/c"));
	CHECK(!valid_browse_path("Movies"));
	CHECK(!valid_browse_path("/Movies/../../etc"));
	CHECK(!valid_browse_path("/.."));
	CHECK(!valid_browse_path("/Movies/.."));
	CHECK(!valid_browse_path("//etc"));

	CHECK(path_inside("/mnt/disk1", "/mnt/disk1"));
	CHECK(path_inside("/mnt/disk1/sub", "/mnt/disk1"));
	CHECK(path_inside("/mnt/disk1/sub", "/mnt/disk1/"));
	CHECK(path_inside("/anything", "/"));
	CHECK(!path_inside("/mnt/disk10", "/mnt/disk1"));
	CHECK(!path_inside("/mnt/disk1", "/mnt/disk1/sub"));
	CHECK(!path_inside("/mnt/storage", "/mnt/disk1"));

	return 0;
}

static int test_mount_table(void)
{
	static const char table[] =
		"# /etc/fstab: static file system information.\n"
		"\n"
		"UUID=aaaa-bbbb\t/\text4\terrors=remount-ro\t0\t1\n"
		"   # an indented comment\n"
		"/dev/sdb1 /mnt/disk1/ ext4 defaults,nofail 0 2 # trailing comment\n"
		"/dev/sdc1 /mnt/my\\040disk xfs defaults 0 0\n"
		"broken line\n"
		"/mnt/disk1:/mnt/disk2 /mnt/storage fuse.mergerfs allow_other 0 0";
	struct mount_entry e;
	const char* cursor = table;
	char buf[64];

	CHECK(mount_next(&cursor, &e, 0, 0) == 0); /* comment */
	CHECK(mount_next(&cursor, &e, 0, 0) == 0); /* empty */
	CHECK(mount_next(&cursor, &e, 0, 0) == 1);
	CHECK(strcmp(e.source, "UUID=aaaa-bbbb") == 0 && strcmp(e.target, "/") == 0);
	CHECK(strcmp(e.fstype, "ext4") == 0 && strcmp(e.options, "errors=remount-ro") == 0);
	CHECK(mount_next(&cursor, &e, 0, 0) == 0); /* indented comment */
	CHECK(mount_next(&cursor, &e, 0, 0) == 1);
	CHECK(strcmp(e.target, "/mnt/disk1") == 0); /* final slash dropped */
	CHECK(strcmp(e.options, "defaults,nofail") == 0);
	CHECK(mount_next(&cursor, &e, 0, 0) == 1);
	CHECK(strcmp(e.target, "/mnt/my disk") == 0); /* escape decoded */
	CHECK(mount_next(&cursor, &e, 0, 0) == 0); /* too few fields */
	CHECK(mount_next(&cursor, &e, 0, 0) == 1); /* last line without newline */
	CHECK(is_mergerfs(e.fstype));
	CHECK(strcmp(e.source, "/mnt/disk1:/mnt/disk2") == 0);
	CHECK(mount_next(&cursor, &e, 0, 0) == -1);

	CHECK(is_mergerfs("mergerfs") && is_mergerfs("fuse.mergerfs"));
	CHECK(!is_mergerfs("fuse") && !is_mergerfs("ext4"));

	sncpy(buf, sizeof(buf), "a\\040b\\011c\\134d\\0");
	mount_unescape(buf);
	CHECK(strcmp(buf, "a b\tc\\d\\0") == 0);

	return 0;
}

static int test_fstab_has(const char* text, const char* line)
{
	return strstr(text, line) != 0;
}

static int test_fstab(void)
{
	char path[64];
	char bak[96];
	ss_t s;
	const char* saved = fstab_path;
	static const char initial[] =
		"# keep this comment\n"
		"UUID=root / ext4 errors=remount-ro 0 1\n"
		"/mnt/a:/mnt/b /mnt/storage fuse.mergerfs allow_other 0 0\n"
		"UUID=old /mnt/b ext4 defaults 0 2";

	mkdir("/tmp/snapraid", 0700);
	snprintf(path, sizeof(path), "/tmp/snapraid/selftest-%u.fstab", (unsigned)getpid());
	snprintf(bak, sizeof(bak), "%s.snapraidd.bak", path);
	fstab_path = path;

	/* a missing fstab is created */
	unlink(path);
	CHECK(fstab_set("/mnt/x", "UUID=x /mnt/x ext4 defaults 0 2") == 0);
	ss_init(&s, 256);
	CHECK(file_read(path, &s) == 0);
	CHECK(strcmp(ss_ptr(&s), "UUID=x /mnt/x ext4 defaults 0 2\n") == 0);
	ss_done(&s);

	int f = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
	CHECK(f >= 0);
	CHECK(write(f, initial, strlen(initial)) == (ssize_t)strlen(initial));
	close(f);

	/* a new disk goes before the pools, whatever is there stays */
	CHECK(fstab_set("/mnt/a", "UUID=new /mnt/a ext4 defaults,nofail 0 2") == 0);
	ss_init(&s, 256);
	CHECK(file_read(path, &s) == 0);
	const char* text = ss_ptr(&s);
	CHECK(test_fstab_has(text, "# keep this comment\n"));
	CHECK(test_fstab_has(text, "UUID=root / ext4 errors=remount-ro 0 1\n"));
	CHECK(test_fstab_has(text, "UUID=old /mnt/b ext4 defaults 0 2\n")); /* newline added */
	CHECK(strstr(text, "UUID=new /mnt/a") != 0 && strstr(text, "UUID=new /mnt/a") < strstr(text, "fuse.mergerfs"));
	ss_done(&s);

	/* the previous version is kept */
	ss_init(&s, 256);
	CHECK(file_read(bak, &s) == 0);
	CHECK(strcmp(ss_ptr(&s), initial) == 0);
	ss_done(&s);

	/* an existing mount point is replaced in place, never duplicated */
	CHECK(fstab_set("/mnt/b", "UUID=replaced /mnt/b xfs defaults 0 2") == 0);
	ss_init(&s, 256);
	CHECK(file_read(path, &s) == 0);
	text = ss_ptr(&s);
	CHECK(!test_fstab_has(text, "UUID=old"));
	CHECK(test_fstab_has(text, "UUID=replaced /mnt/b xfs defaults 0 2\n"));
	CHECK(strstr(strstr(text, " /mnt/b ") + 1, " /mnt/b ") == 0);
	ss_done(&s);

	/* a pool replaces its own line */
	CHECK(fstab_set("/mnt/storage", "/mnt/a:/mnt/b:/mnt/c /mnt/storage mergerfs allow_other 0 0") == 0);
	ss_init(&s, 256);
	CHECK(file_read(path, &s) == 0);
	text = ss_ptr(&s);
	CHECK(!test_fstab_has(text, "fuse.mergerfs"));
	CHECK(test_fstab_has(text, "/mnt/a:/mnt/b:/mnt/c /mnt/storage mergerfs allow_other 0 0\n"));
	ss_done(&s);

	/* removing leaves the rest untouched, and a missing entry is not an error */
	CHECK(fstab_set("/mnt/a", 0) == 0);
	CHECK(fstab_set("/mnt/never", 0) == 0);
	ss_init(&s, 256);
	CHECK(file_read(path, &s) == 0);
	text = ss_ptr(&s);
	CHECK(!test_fstab_has(text, "/mnt/a ext4"));
	CHECK(test_fstab_has(text, "# keep this comment\n"));
	CHECK(test_fstab_has(text, "UUID=root / ext4"));
	CHECK(test_fstab_has(text, "/mnt/storage mergerfs"));
	ss_done(&s);

	unlink(path);
	unlink(bak);
	fstab_path = saved;
	return 0;
}

static int test_pool(void)
{
	struct pool_branch b[BRANCH_MAX];
	unsigned count;
	char value[256];

	sncpy(value, sizeof(value), "/mnt/disk1=RW:/mnt/disk2/=RO:/mnt/disk3=NC,100G:/mnt/disk4:/mnt/disk5=RW,4G");
	pool_parse_branches(value, b, &count);
	CHECK(count == 5);
	CHECK(strcmp(b[0].path, "/mnt/disk1") == 0 && b[0].writable);
	CHECK(strcmp(b[1].path, "/mnt/disk2") == 0 && !b[1].writable);
	CHECK(strcmp(b[2].path, "/mnt/disk3") == 0 && !b[2].writable);
	CHECK(strcmp(b[3].path, "/mnt/disk4") == 0 && b[3].writable);
	CHECK(strcmp(b[4].path, "/mnt/disk5") == 0 && b[4].writable);

	value[0] = 0;
	pool_parse_branches(value, b, &count);
	CHECK(count == 0);

	/* equal disks: half of the difference */
	CHECK(balance_meet(80, 100, 20, 100) == 30);
	/* different sizes meet at the same percentage */
	uint64_t x = balance_meet(900, 1000, 0, 4000);
	CHECK(x == 720);
	CHECK((900 - x) * 4000 == x * 1000);
	/* nothing to do when the source is not fuller */
	CHECK(balance_meet(20, 100, 80, 100) == 0);
	CHECK(balance_meet(50, 100, 50, 100) == 0);
	CHECK(balance_meet(0, 0, 0, 0) == 0);
	/* real sizes do not overflow */
	x = balance_meet(17000000000000ULL, 18000000000000ULL, 1000000000000ULL, 18000000000000ULL);
	CHECK(x > 8000000000000ULL - 1024 && x < 8000000000000ULL + 1024);

	CHECK(walk_skip(".", 0) && walk_skip("..", 1));
	CHECK(walk_skip("snapraid.content", 1) && walk_skip("snapraid.content.lock", 1) && walk_skip("lost+found", 1));
	CHECK(walk_skip("snapraid.parity", 1) && walk_skip(".snapraid.content", 1));
	CHECK(!walk_skip("lost+found", 0) && !walk_skip("snapraid.content", 0));
	CHECK(!walk_skip("Movies", 1) && !walk_skip("snapraid-notes.txt", 1));

	return 0;
}

static int test_layout(void)
{
	struct layout a;
	struct layout b;
	char msg[MSG_MAX];
	int partial;

	static const char* MOUNTS =
		"/dev/sda1 / ext4 rw 0 0\n"
		"/dev/sdb1 /mnt/d1 ext4 rw 0 0\n"
		"/dev/sdc1 /mnt/d2 xfs rw 0 0\n"
		"/dev/sdd1 /mnt/p1 ext4 rw 0 0\n"
		"/dev/sde1 /mnt/d3 ext4 rw 0 0\n"
		"/dev/sdf1 /mnt/p2 ext4 rw 0 0\n"
		"a:b /mnt/pool fuse.mergerfs rw 0 0\n";

	layout_init(&a);
	layout_parse(&a, "default",
		"# comment\n"
		"parity /mnt/p1/snapraid.parity\n"
		"2-parity /mnt/q1/a.2-parity , /mnt/q2/b.2-parity\n"
		"  content   /var/snapraid.content\n"
		"content /mnt/d1/snapraid.content\r\n"
		"data d1 /mnt/d1/\n"
		"disk d2 /mnt/d2/files\n"
		"data broken\n"
		"exclude *.tmp\n"
		"autosave 500\n"
		"data last /mnt/with space/x");
	CHECK(a.count == 8);
	CHECK(a.entries[0].role == LAYOUT_PARITY && strcmp(a.entries[0].name, "parity") == 0 && strcmp(a.entries[0].path, "/mnt/p1/snapraid.parity") == 0);
	CHECK(a.entries[1].role == LAYOUT_PARITY && strcmp(a.entries[1].name, "2-parity") == 0 && strcmp(a.entries[1].path, "/mnt/q1/a.2-parity") == 0);
	CHECK(strcmp(a.entries[2].path, "/mnt/q2/b.2-parity") == 0);
	CHECK(a.entries[3].role == LAYOUT_CONTENT && strcmp(a.entries[3].path, "/var/snapraid.content") == 0);
	CHECK(strcmp(a.entries[4].path, "/mnt/d1/snapraid.content") == 0);
	CHECK(a.entries[5].role == LAYOUT_DATA && strcmp(a.entries[5].name, "d1") == 0 && strcmp(a.entries[5].path, "/mnt/d1") == 0);
	CHECK(strcmp(a.entries[6].name, "d2") == 0 && strcmp(a.entries[6].path, "/mnt/d2/files") == 0);
	CHECK(strcmp(a.entries[7].name, "last") == 0 && strcmp(a.entries[7].path, "/mnt/with space/x") == 0);
	CHECK(strcmp(a.entries[0].array, "default") == 0);

	layout_mounts(&a, MOUNTS);
	CHECK(strcmp(a.entries[0].mount, "/mnt/p1") == 0);
	CHECK(strcmp(a.entries[3].mount, "/") == 0);
	CHECK(strcmp(a.entries[5].mount, "/mnt/d1") == 0);
	CHECK(strcmp(a.entries[6].mount, "/mnt/d2") == 0);

	/* what protects a directory */
	CHECK(layout_find_dir(&a, "/mnt/d1", &partial) == &a.entries[5] && !partial);
	CHECK(layout_find_dir(&a, "/mnt/d1/sub", &partial) == &a.entries[5] && !partial);
	CHECK(layout_find_dir(&a, "/mnt/d2/files/x", &partial) == &a.entries[6] && !partial);
	CHECK(layout_find_dir(&a, "/mnt/d2", &partial) == &a.entries[6] && partial);
	CHECK(layout_find_dir(&a, "/mnt/p1", &partial) == &a.entries[0]);
	CHECK(layout_find_dir(&a, "/mnt/d10", &partial) == 0);
	CHECK(layout_find_dir(&a, "/mnt/d3", &partial) == 0);

	/* another array on its own disks */
	layout_init(&b);
	layout_parse(&b, "media", "parity /mnt/p2/snapraid.parity\ncontent /var/media.content\ncontent /mnt/d1/media.content\ndata m1 /mnt/d3\n");
	layout_mounts(&b, MOUNTS);
	CHECK(layout_conflict(&b, &a, msg, sizeof(msg)) == 0);
	CHECK(layout_conflict(&a, &b, msg, sizeof(msg)) == 0);
	layout_done(&b);

#define CONFLICT(text, word) \
	layout_init(&b); \
	layout_parse(&b, "media", text); \
	layout_mounts(&b, MOUNTS); \
	CHECK(layout_conflict(&b, &a, msg, sizeof(msg)) == 409 && strstr(msg, word) != 0); \
	layout_done(&b)

	/* the same data disk, a directory inside it, and the disk that contains its directory */
	CONFLICT("data m1 /mnt/d1\n", "one array only");
	CONFLICT("data m1 /mnt/d1/inside\n", "one array only");
	CONFLICT("data m1 /mnt/d2\n", "one array only");
	/* another directory of the same filesystem */
	CONFLICT("data m1 /mnt/d2/other\n", "one array only");
	/* the parity */
	CONFLICT("parity /mnt/p1/snapraid.parity\n", "own parity");
	CONFLICT("parity /mnt/p1/media.parity\n", "one array only");
	CONFLICT("parity /mnt/d1/media.parity\n", "either data or parity");
	CONFLICT("data m1 /mnt/p1\n", "either data or parity");
	/* the content */
	CONFLICT("content /var/snapraid.content\n", "own content");
#undef CONFLICT

	/* on the root filesystem only the directories tell things apart */
	layout_init(&b);
	layout_parse(&b, "media", "parity /srv/p/media.parity\ndata m1 /srv/m1\ncontent /var/media.content\n");
	layout_mounts(&b, MOUNTS);
	CHECK(strcmp(b.entries[0].mount, "/") == 0);
	layout_done(&a);
	layout_init(&a);
	layout_parse(&a, "default", "parity /srv/q/snapraid.parity\ndata d1 /srv/d1\n");
	layout_mounts(&a, MOUNTS);
	CHECK(layout_conflict(&b, &a, msg, sizeof(msg)) == 0);
	layout_done(&b);
	layout_done(&a);

	CHECK(option_has("defaults,noatime,nofail", "nofail") && option_has("nofail", "nofail") && option_has("nofail,ro", "nofail"));
	CHECK(!option_has("defaults,nofailover", "nofail") && !option_has("", "nofail") && !option_has("x-nofail", "nofail"));
	CHECK(valid_policy("mfs") && valid_policy("epmfs") && valid_policy("pfrd") && !valid_policy("nosuchpolicy") && !valid_policy("") && !valid_policy("MFS"));

	return 0;
}

int storage_selftest(void)
{
	if (test_layout() != 0)
		return -1;
	if (test_validation() != 0)
		return -1;
	if (test_mount_table() != 0)
		return -1;
	if (test_fstab() != 0)
		return -1;
	if (test_pool() != 0)
		return -1;

	return 0;
}

#else /* __linux__ */

int storage_selftest(void)
{
	return 0;
}

static int unsupported(char* msg, size_t msg_size)
{
	snprintf(msg, msg_size, "Storage administration is available only on Linux");
	return 501;
}

void storage_inventory_json(struct snapraid_state* state, ss_t* s, int level)
{
	(void)state;
	ss_json_bool(s, level, "supported", 0);
}

int storage_engine_conf_write(struct snapraid_state* state, const char* text, char* msg, size_t msg_size)
{
	(void)state;
	(void)text;
	return unsupported(msg, msg_size);
}

int storage_format(const char* device, const char* fstype, const char* label, const char* purpose, int wipe, char* part, size_t part_size, char* uuid, size_t uuid_size, char* msg, size_t msg_size)
{
	(void)device;
	(void)fstype;
	(void)label;
	(void)purpose;
	(void)wipe;
	(void)part;
	(void)part_size;
	(void)uuid;
	(void)uuid_size;
	return unsupported(msg, msg_size);
}

int storage_mount(const char* source, const char* target, const char* fstype, const char* options, int persist, char* msg, size_t msg_size)
{
	(void)source;
	(void)target;
	(void)fstype;
	(void)options;
	(void)persist;
	return unsupported(msg, msg_size);
}

int storage_unmount(const char* target, int forget, char* msg, size_t msg_size)
{
	(void)target;
	(void)forget;
	return unsupported(msg, msg_size);
}

int storage_mkdir(const char* path, char* msg, size_t msg_size)
{
	(void)path;
	return unsupported(msg, msg_size);
}

int storage_pool(const char* mountpoint, const char* branches, const char* options, int persist, char* msg, size_t msg_size)
{
	(void)mountpoint;
	(void)branches;
	(void)options;
	(void)persist;
	return unsupported(msg, msg_size);
}

void storage_job_json(ss_t* s, int level)
{
	(void)s;
	(void)level;
}

int storage_job_stop(char* msg, size_t msg_size)
{
	return unsupported(msg, msg_size);
}

int storage_job_claims_array(const char* name)
{
	(void)name;
	return 0;
}

int storage_format_start(const char* device, const char* fstype, const char* label, const char* purpose, int wipe, char* msg, size_t msg_size)
{
	(void)device;
	(void)fstype;
	(void)label;
	(void)purpose;
	(void)wipe;
	return unsupported(msg, msg_size);
}

int storage_balance_start(const char* mountpoint, uint64_t max_bytes, unsigned spread, char* msg, size_t msg_size)
{
	(void)mountpoint;
	(void)max_bytes;
	(void)spread;
	return unsupported(msg, msg_size);
}

int storage_duplicates_start(const char* mountpoint, char* msg, size_t msg_size)
{
	(void)mountpoint;
	return unsupported(msg, msg_size);
}

int storage_browse_json(const char* mountpoint, const char* path, ss_t* s, int level, char* msg, size_t msg_size)
{
	(void)mountpoint;
	(void)path;
	(void)s;
	(void)level;
	return unsupported(msg, msg_size);
}

#endif

