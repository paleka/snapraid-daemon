// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Paleka

#include "os/portable.h"

#include "os/os.h"
#include "state.h"
#include "support.h"
#include "log.h"
#include "conf.h"
#include "elem.h"
#include "runner.h"
#include "scheduler.h"
#include "parser.h"
#include "storage.h"
#include "arrays.h"

#define ARRAY_CONF_EXT ".conf"
#define ARRAY_REMOVED_EXT ".removed"

/****************************************************************************/
/* arrays */

void arrays_dir(char* dst, size_t dst_size)
{
	struct snapraid_state* main_state = state_ptr();

	sncpy(dst, dst_size, main_state->config.conf);

	/* /etc/snapraidd.conf -> /etc/snapraidd.d */
	size_t len = strlen(dst);
	size_t ext = strlen(ARRAY_CONF_EXT);
	if (len > ext && strcmp(dst + len - ext, ARRAY_CONF_EXT) == 0)
		dst[len - ext] = 0;
	sncat(dst, dst_size, ".d");
}

/**
 * Directory where the SnapRAID configuration files of the new arrays are
 * placed if not told otherwise: "snapraid", next to the main configuration.
 */
static void arrays_engine_dir(char* dst, size_t dst_size)
{
	struct snapraid_state* main_state = state_ptr();

	sncpy(dst, dst_size, main_state->config.conf);

	char* slash = strrchr(dst, '/');
#ifdef _WIN32
	char* backslash = strrchr(dst, '\\');
	if (backslash != 0 && (slash == 0 || backslash > slash))
		slash = backslash;
#endif
	if (slash != 0)
		slash[1] = 0;
	else
		dst[0] = 0;
	sncat(dst, dst_size, "snapraid");
}

void array_engine_conf_locked(struct snapraid_state* state, char* path, size_t path_size)
{
	if (state->engine_conf_arg[0] != 0)
		sncpy(path, path_size, state->engine_conf_arg);
	else
		sncpy(path, path_size, state->array.engine_conf);
}

/**
 * Check that no other array works with the same SnapRAID configuration file.
 * Two daemons states on the same array would fight for it.
 */
static struct snapraid_state* array_find_engine_conf_locked(const char* engine_conf, struct snapraid_state* exclude)
{
	struct snapraid_host* host = host_ptr();

	for (tommy_node* i = tommy_list_head(&host->state_list); i; i = i->next) {
		struct snapraid_state* other = i->data;
		char path[PATH_MAX];

		if (other == exclude)
			continue;

		array_engine_conf_locked(other, path, sizeof(path));

		/* the default array may not know yet its file: assume the default of the engine */
#ifndef _WIN32
		if (path[0] == 0 && config_is_default(other))
			sncpy(path, sizeof(path), "/etc/snapraid.conf");
#endif

		if (strcmp(path, engine_conf) == 0)
			return other;
	}

	return 0;
}

/**
 * Allocate the state of an array and load its configuration file.
 * The state lock must be held, or the context be single-threaded.
 * @return The new state, not yet in the list of the host, or 0 on error
 */
static struct snapraid_state* array_load_locked(const char* name)
{
	char dir[PATH_MAX];
	struct snapraid_state* state = state_alloc(name);
	struct snapraid_config* config = &state->config;

	sl_init(&config->line_list);
	tommy_list_init(&config->maintenance_list);
	tommy_list_init(&config->smartignore_list);

	arrays_dir(dir, sizeof(dir));
	sncpy(config->conf, sizeof(config->conf), dir);
	sncat(config->conf, sizeof(config->conf), "/");
	sncat(config->conf, sizeof(config->conf), name);
	sncat(config->conf, sizeof(config->conf), ARRAY_CONF_EXT);

	if (config_load_locked(state) != 0) {
		log_msg(LVL_ERROR, "array %s not loaded, fix %s and reload the daemon", name, config->conf);
		state_free(state);
		return 0;
	}

	struct snapraid_state* other = array_find_engine_conf_locked(config->engine_conf, state);
	if (other != 0) {
		log_msg(LVL_ERROR, "array %s not loaded, its engine_conf %s is already the one of the array %s", name, config->engine_conf, other->name);
		state_free(state);
		return 0;
	}

	sncpy(state->engine_conf_arg, sizeof(state->engine_conf_arg), config->engine_conf);

	return state;
}

/**
 * Prepare the runner of an array and read its past logs.
 * The array is not yet in the list of the host, so no lock is needed.
 */
static void array_prepare(struct snapraid_state* state)
{
	log_bind(state);
	os_privileges_acquire();
	runner_init(state);
	parse_past_log(state);
	os_privileges_release();
	log_bind(0);

	state->daemon_loading = 0;
}

/**
 * Queue the startup probe and prepare the scheduler.
 */
static void array_ready(struct snapraid_state* state)
{
	char msg[MSG_MAX];
	int status;

	if (runner(state, CMD_STARTUP, CMD_PROBE, 0, 0, 0, msg, sizeof(msg), &status) != 0) {
		log_msg(LVL_ERROR, "failed to run the startup probe command of the array %s", state->name);
		/* continue anyway to provide an interface */
	}

	scheduler_init(state);
}

static void array_start(struct snapraid_state* state)
{
	scheduler_start(state);
	runner_start(state);
}

/**
 * List the names of the arrays that have a configuration file.
 */
static void arrays_scan(sl_t* names)
{
	char dir[PATH_MAX];

	arrays_dir(dir, sizeof(dir));

	os_privileges_acquire();
	DIR* d = opendir(dir);
	if (d != 0) {
		struct dirent* dd;
		while ((dd = readdir(d)) != 0) {
			char name[ARRAY_NAME_MAX + 8];
			size_t len = strlen(dd->d_name);
			size_t ext = strlen(ARRAY_CONF_EXT);

			if (len <= ext || len - ext >= sizeof(name) || strcmp(dd->d_name + len - ext, ARRAY_CONF_EXT) != 0)
				continue;

			memcpy(name, dd->d_name, len - ext);
			name[len - ext] = 0;

			if (!state_name_valid(name) || strcmp(name, ARRAY_DEFAULT) == 0) {
				log_msg(LVL_WARNING, "ignoring %s/%s, '%s' is not a valid name for an array", dir, dd->d_name, name);
				continue;
			}

			sl_insert_str(names, name);
		}
		closedir(d);
	}
	os_privileges_release();
}

void arrays_init(void)
{
	struct snapraid_host* host = host_ptr();
	sl_t names;

	sl_init(&names);
	arrays_scan(&names);

	for (tommy_node* i = tommy_list_head(&names); i; i = i->next) {
		sn_t* name = i->data;
		struct snapraid_state* state = array_load_locked(name->str);

		if (state == 0)
			continue;

		array_prepare(state);
		tommy_list_insert_tail(&host->state_list, &state->node, state);
		log_msg(LVL_INFO, "array %s loaded, engine_conf=%s", state->name, state->engine_conf_arg);
	}

	sl_free(&names);
}

void arrays_ready(void)
{
	struct snapraid_host* host = host_ptr();

	for (tommy_node* i = tommy_list_head(&host->state_list); i; i = i->next) {
		struct snapraid_state* state = i->data;
		if (!config_is_default(state))
			array_ready(state);
	}
}

void arrays_start(void)
{
	struct snapraid_host* host = host_ptr();

	for (tommy_node* i = tommy_list_head(&host->state_list); i; i = i->next) {
		struct snapraid_state* state = i->data;
		if (!config_is_default(state))
			array_start(state);
	}
}

void arrays_done(void)
{
	struct snapraid_host* host = host_ptr();

	/* the list doesn't change anymore: the rest server is already stopped */
	for (tommy_node* i = tommy_list_head(&host->state_list); i; i = i->next) {
		struct snapraid_state* state = i->data;
		if (!config_is_default(state)) {
			scheduler_done(state);
			runner_done(state);
		}
	}
}

void arrays_pulse_locked(void)
{
	struct snapraid_host* host = host_ptr();

	for (tommy_node* i = tommy_list_head(&host->state_list); i; i = i->next) {
		struct snapraid_state* state = i->data;
		scheduler_pulse(state);
	}
}

void arrays_inherit_locked(void)
{
	struct snapraid_host* host = host_ptr();

	for (tommy_node* i = tommy_list_head(&host->state_list); i; i = i->next) {
		struct snapraid_state* state = i->data;
		if (!config_is_default(state)) {
			/* the log directory is fixed when the array starts, like sys_log_directory */
			char sys_log_directory[PATH_MAX];
			sncpy(sys_log_directory, sizeof(sys_log_directory), state->config.sys_log_directory);
			config_inherit_locked(state);
			sncpy(state->config.sys_log_directory, sizeof(state->config.sys_log_directory), sys_log_directory);
			pulse(state, PULSE_CONFIG);
		}
	}
}

/**
 * Stop the threads of an array and move it to the removed ones.
 * The state lock must be held, and it's released while waiting for the threads.
 */
static void array_retire_locked_yield(struct snapraid_state* state)
{
	struct snapraid_host* host = host_ptr();

	/* from now on daemon_is_running() is false for this array, and its threads end */
	state->removed = 1;
	tommy_list_remove_existing(&host->state_list, &state->node);
	tommy_list_insert_tail(&host->removed_list, &state->node, state);
	arbiter_release_locked(state);

	state_unlock();

	scheduler_done(state);
	runner_done(state);

	state_lock();
}

static int array_is_idle_locked(struct snapraid_state* state)
{
	return !(state->runner.latest && state->runner.latest->running)
	       && tommy_list_empty(&state->runner.waiting_list)
	       && state->runner.task_pending == 0;
}

void arrays_reload_locked_yield(void)
{
	struct snapraid_host* host = host_ptr();
	sl_t names;

	arrays_inherit_locked();

	sl_init(&names);

	state_unlock();
	arrays_scan(&names);
	state_lock();

	/* arrays we already have */
	for (tommy_node* i = tommy_list_head(&host->state_list); i; ) {
		struct snapraid_state* state = i->data;
		i = i->next;

		if (config_is_default(state))
			continue;

		int found = 0;
		for (tommy_node* j = tommy_list_head(&names); j; j = j->next) {
			sn_t* name = j->data;
			if (strcmp(name->str, state->name) == 0)
				found = 1;
		}

		if (found) {
			if (config_reload_locked(state) < 0)
				log_msg(LVL_ERROR, "failed to reload config from %s", state->config.conf);
		} else if (array_is_idle_locked(state)) {
			log_msg(LVL_INFO, "array %s removed, its configuration file is gone", state->name);
			array_retire_locked_yield(state);
			/* the list may have changed while unlocked: start again */
			i = tommy_list_head(&host->state_list);
		} else {
			log_msg(LVL_WARNING, "array %s has no more a configuration file, but it's kept until its tasks end. Reload again later.", state->name);
		}
	}

	/* new arrays */
	for (tommy_node* j = tommy_list_head(&names); j; j = j->next) {
		sn_t* name = j->data;

		if (state_find_locked(name->str) != 0)
			continue;

		struct snapraid_state* state = array_load_locked(name->str);
		if (state == 0)
			continue;

		state_unlock();
		array_prepare(state);
		state_lock();

		tommy_list_insert_tail(&host->state_list, &state->node, state);
		log_msg(LVL_INFO, "array %s loaded, engine_conf=%s", state->name, state->engine_conf_arg);

		state_unlock();
		array_ready(state);
		array_start(state);
		state_lock();
	}

	sl_free(&names);
}

/**
 * Check a path given from the network for a configuration file: absolute,
 * without "..", and made only of plain characters.
 */
static int array_path_valid(const char* path)
{
	size_t len = strlen(path);

#ifdef _WIN32
	/* C:\dir\file.conf or C:/dir/file.conf */
	if (len < 4 || len >= PATH_MAX - 16 || !isalpha((unsigned char)path[0]) || path[1] != ':' || (path[2] != '/' && path[2] != '\\'))
		return 0;
	if (strspn(path + 2, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/\\._-+ ") != len - 2)
		return 0;
	if (strstr(path, "..") != 0 || path[len - 1] == '/' || path[len - 1] == '\\')
		return 0;
	return 1;
#else
	if (len < 2 || len >= PATH_MAX - 16 || path[0] != '/')
		return 0;
	if (strspn(path, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/._-+") != len)
		return 0;
	if (strstr(path, "..") != 0 || strstr(path, "//") != 0 || path[len - 1] == '/')
		return 0;

	return 1;
#endif
}

static int array_fail(char* msg, size_t msg_size, int* status, int code, const char* fmt, ...) __attribute__((format(attribute_printf, 5, 6)));

static int array_fail(char* msg, size_t msg_size, int* status, int code, const char* fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	vsnprintf(msg, msg_size, fmt, ap);
	va_end(ap);

	*status = code;
	return -1;
}

int array_create(const char* name, const char* engine_conf_arg, char* msg, size_t msg_size, int* status)
{
	struct snapraid_host* host = host_ptr();
	struct snapraid_state* main_state = state_ptr();
	char engine_conf[PATH_MAX];
	char dir[PATH_MAX];
	char conf[PATH_MAX];

	if (!state_name_valid(name))
		return array_fail(msg, msg_size, status, 400, "Invalid name for an array: use up to %d lowercase letters, digits, - and _, starting with a letter or a digit", ARRAY_NAME_MAX - 1);
	if (strcmp(name, ARRAY_DEFAULT) == 0)
		return array_fail(msg, msg_size, status, 409, "The array '%s' always exists: it's the one of the main configuration file", ARRAY_DEFAULT);

	if (engine_conf_arg[0] != 0) {
		if (!array_path_valid(engine_conf_arg))
			return array_fail(msg, msg_size, status, 400, "Invalid path for the SnapRAID configuration file: use an absolute path made of letters, digits and / . _ - +");
		sncpy(engine_conf, sizeof(engine_conf), engine_conf_arg);
	} else {
		arrays_engine_dir(engine_conf, sizeof(engine_conf));
		sncat(engine_conf, sizeof(engine_conf), "/");
		sncat(engine_conf, sizeof(engine_conf), name);
		sncat(engine_conf, sizeof(engine_conf), ".conf");
	}

	arrays_dir(dir, sizeof(dir));
	sncpy(conf, sizeof(conf), dir);
	sncat(conf, sizeof(conf), "/");
	sncat(conf, sizeof(conf), name);
	sncat(conf, sizeof(conf), ARRAY_CONF_EXT);

	/* a truncated path would be another file */
	if (strlen(conf) + 16 >= PATH_MAX || strlen(engine_conf) + 16 >= PATH_MAX)
		return array_fail(msg, msg_size, status, 400, "The path of the configuration file is too long");

	state_lock();

	if (!daemon_is_running(main_state)) {
		state_unlock();
		return array_fail(msg, msg_size, status, 503, "Daemon is terminating");
	}

	if (state_find_locked(name) != 0) {
		state_unlock();
		return array_fail(msg, msg_size, status, 409, "An array named '%s' already exists", name);
	}

	struct snapraid_state* other = array_find_engine_conf_locked(engine_conf, 0);
	if (other != 0) {
		state_unlock();
		return array_fail(msg, msg_size, status, 409, "%s is already the SnapRAID configuration file of the array '%s': every array needs a file of its own", engine_conf, other->name);
	}

	/* a file left by something else is not overwritten */
	os_privileges_acquire();
	int exists = access(conf, F_OK) == 0;
	if (!exists && mkdir(dir, 0755) != 0 && errno != EEXIST) {
		int err = errno;
		os_privileges_release();
		state_unlock();
		return array_fail(msg, msg_size, status, 500, "Failed to create the directory %s, %s", dir, strerror(err));
	}
	os_privileges_release();
	if (exists) {
		state_unlock();
		return array_fail(msg, msg_size, status, 409, "%s already exists. Reload the daemon to load it, or remove the file.", conf);
	}

	/*
	 * The new array starts with the same choices made for the default one:
	 * schedule, thresholds, scrub plan, spindown, hooks and notifications.
	 * They are written in full in its file, to be changed from there on.
	 */
	struct snapraid_state* state = state_alloc(name);
	struct snapraid_config* config = &state->config;
	struct snapraid_config transient;

	config_dup_locked(main_state, &transient);

	/* its own text, and nothing that is tied to the disks of the default array */
	sl_free(&transient.line_list);
	sl_init(&transient.line_list);
	tommy_list_foreach(&transient.smartignore_list, smartignore_free);
	tommy_list_init(&transient.smartignore_list);
	sncpy(transient.engine_conf, sizeof(transient.engine_conf), engine_conf);

	char line[PATH_MAX + 64];
	snprintf(line, sizeof(line), "# SnapRAID Daemon, configuration of the array '%s'", name);
	sl_insert_str(&transient.line_list, line);
	sl_insert_str(&transient.line_list, "# Same options of the main configuration file, without the ones of the machine (sys_*, net_*).");
	sl_insert_str(&transient.line_list, "");
	sl_insert_str(&transient.line_list, "# The SnapRAID configuration file of this array. It cannot be changed while the daemon runs.");
	snprintf(line, sizeof(line), "engine_conf = %s", engine_conf);
	sl_insert_str(&transient.line_list, line);
	sl_insert_str(&transient.line_list, "");

	sl_init(&config->line_list);
	tommy_list_init(&config->maintenance_list);
	tommy_list_init(&config->smartignore_list);
	sncpy(config->conf, sizeof(config->conf), conf);

	config_apply_locked(state, &transient);
	config_free(&transient);
	config_inherit_locked(state);

	if (config_save_locked(state) != 0) {
		state_free(state);
		state_unlock();
		return array_fail(msg, msg_size, status, 500, "Failed to write %s", conf);
	}

	sncpy(state->engine_conf_arg, sizeof(state->engine_conf_arg), engine_conf);

	state_unlock();

	array_prepare(state);

	state_lock();
	tommy_list_insert_tail(&host->state_list, &state->node, state);
	state_unlock();

	log_msg(LVL_INFO, "array %s created, engine_conf=%s", name, engine_conf);

	array_ready(state);
	array_start(state);

	*status = 201;
	return 0;
}

int array_remove(const char* name, char* msg, size_t msg_size, int* status)
{
	char removed[PATH_MAX + 16];
	char conf[PATH_MAX];

	if (strcmp(name, ARRAY_DEFAULT) == 0)
		return array_fail(msg, msg_size, status, 409, "The array '%s' is the one of the main configuration file and cannot be removed", ARRAY_DEFAULT);

	state_lock();

	struct snapraid_state* state = state_find_locked(name);
	if (state == 0) {
		state_unlock();
		return array_fail(msg, msg_size, status, 404, "There is no array named '%s'", name);
	}

	if (!array_is_idle_locked(state)) {
		state_unlock();
		return array_fail(msg, msg_size, status, 409, "The array '%s' has tasks running or queued. Wait for them, or stop them, and try again.", name);
	}

	sncpy(conf, sizeof(conf), state->config.conf);

	array_retire_locked_yield(state);

	state_unlock();

	/* without its file the array doesn't come back at the next start */
	snprintf(removed, sizeof(removed), "%s" ARRAY_REMOVED_EXT, conf);
	os_privileges_acquire();
#ifdef _WIN32
	/* the rename doesn't replace the file left by a previous removal */
	remove(removed);
#endif
	int ret = rename(conf, removed);
	int err = errno;
	os_privileges_release();

	if (ret != 0) {
		log_msg(LVL_ERROR, "array %s removed, but failed to rename %s, errno=%s(%d)", name, conf, strerror(err), err);
		return array_fail(msg, msg_size, status, 500, "The array '%s' is stopped, but %s cannot be renamed, %s. Remove the file, or the array comes back at the next start.", name, conf, strerror(err));
	}

	log_msg(LVL_INFO, "array %s removed, its configuration is kept as %s", name, removed);

	*status = 200;
	return 0;
}

const char* array_heavy_command_locked(const char* name)
{
	struct snapraid_state* state = state_find_locked(name);

	if (state == 0)
		return 0;

	if (state->runner.latest && state->runner.latest->running && arbiter_is_heavy(state->runner.latest->cmd))
		return command_name(state->runner.latest->cmd);

	/* with the engine in hand the next heavy command starts right away */
	if (state->running) {
		for (tommy_node* i = tommy_list_head(&state->runner.waiting_list); i; i = i->next) {
			struct snapraid_task* task = i->data;
			if (arbiter_is_heavy(task->cmd))
				return command_name(task->cmd);
		}
	}

	return 0;
}

void arrays_wake(void)
{
	struct snapraid_host* host = host_ptr();

	state_lock();
	for (tommy_node* i = tommy_list_head(&host->state_list); i; i = i->next) {
		struct snapraid_state* state = i->data;
		thread_cond_signal(&state->runner.cond);
	}
	state_unlock();
}

/****************************************************************************/
/* arbiter */

int arbiter_is_heavy(int cmd)
{
	switch (cmd) {
	case CMD_DIFF :
	case CMD_SYNC :
	case CMD_SCRUB :
	case CMD_FIX :
	case CMD_CHECK :
		return 1;
	}

	return 0;
}

/**
 * Check if two arrays have a data or parity disk on the same physical device.
 */
static int arrays_share_device_locked(struct snapraid_state* a, struct snapraid_state* b)
{
	for (tommy_node* i = tommy_list_head(&a->array.disk_list); i; i = i->next) {
		struct snapraid_disk* disk_a = i->data;
		if (disk_a->kind != DISK_DATA && disk_a->kind != DISK_PARITY)
			continue;
		for (tommy_node* pi = tommy_list_head(&disk_a->device_pointer_list); pi; pi = pi->next) {
			struct snapraid_device_pointer* pointer_a = pi->data;
			if (!device_is_connected(pointer_a->device))
				continue;
			for (tommy_node* j = tommy_list_head(&b->array.disk_list); j; j = j->next) {
				struct snapraid_disk* disk_b = j->data;
				if (disk_b->kind != DISK_DATA && disk_b->kind != DISK_PARITY)
					continue;
				for (tommy_node* pj = tommy_list_head(&disk_b->device_pointer_list); pj; pj = pj->next) {
					struct snapraid_device_pointer* pointer_b = pj->data;
					if (strcmp(pointer_a->device->file, pointer_b->device->file) == 0)
						return 1;
				}
			}
		}
	}

	return 0;
}

struct snapraid_state* arbiter_waiting_for_locked(struct snapraid_state* state)
{
	struct snapraid_host* host = host_ptr();
	int parallel = state_ptr()->config.array_parallel;

	if (state->running)
		return 0;

	for (tommy_node* i = tommy_list_head(&host->state_list); i; i = i->next) {
		struct snapraid_state* other = i->data;
		if (other == state || !other->running)
			continue;
		if (!parallel || arrays_share_device_locked(state, other))
			return other;
	}

	return 0;
}

int arbiter_acquire_locked(struct snapraid_state* state)
{
	/* a balance is moving files on the data disks of this array */
	if (storage_job_claims_array(state->name))
		return 0;

	if (state->running)
		return 1;

	if (arbiter_waiting_for_locked(state) != 0)
		return 0;

	state->running = 1;
	return 1;
}

void arbiter_release_locked(struct snapraid_state* state)
{
	struct snapraid_host* host = host_ptr();

	if (state->running) {
		int more = 0;

		/* keep the engine to complete the sequence already queued */
		if (!state->removed) {
			for (tommy_node* i = tommy_list_head(&state->runner.waiting_list); i; i = i->next) {
				struct snapraid_task* task = i->data;
				if (arbiter_is_heavy(task->cmd))
					more = 1;
			}
		}

		if (!more) {
			state->running = 0;
			pulse(state, PULSE_TASKS);
		}
	}

	/* something may be now allowed to start: a heavy command or a shutdown */
	for (tommy_node* i = tommy_list_head(&host->state_list); i; i = i->next) {
		struct snapraid_state* other = i->data;
		if (other != state)
			thread_cond_signal(&other->runner.cond);
	}
}

int arrays_others_busy_locked(struct snapraid_state* state)
{
	struct snapraid_host* host = host_ptr();

	for (tommy_node* i = tommy_list_head(&host->state_list); i; i = i->next) {
		struct snapraid_state* other = i->data;
		if (other == state)
			continue;
		if (other->runner.latest && other->runner.latest->running)
			return 1;
		for (tommy_node* j = tommy_list_head(&other->runner.waiting_list); j; j = j->next) {
			struct snapraid_task* task = j->data;
			if (task->cmd != CMD_SHUTDOWN)
				return 1;
		}
	}

	return 0;
}
