// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Paleka

#ifndef ARRAYS_H
#define ARRAYS_H

#include "state.h"

/****************************************************************************/
/* arrays */

/**
 * More than one array in the same daemon.
 *
 * The default array is the one of the main configuration file of the daemon,
 * and it always exists. Every other array has a configuration file of its own,
 * NAME.conf, in the arrays directory next to the main configuration file:
 * /etc/snapraidd.conf gives /etc/snapraidd.d/NAME.conf.
 *
 * The file of an array has the same syntax of the main one. It must have the
 * option engine_conf, the SnapRAID configuration file of the array, and it
 * cannot have the options of the machine (sys_*, net_*, check_updates,
 * array_parallel, notify_syslog_*).
 *
 * Every array has its own state, runner thread and scheduler thread, and
 * logs in a directory of its own.
 */

/**
 * Get the directory of the configuration files of the arrays.
 */
void arrays_dir(char* dst, size_t dst_size);

/**
 * Load the arrays found in the arrays directory, and their past logs.
 *
 * Called at startup after the default array is loaded, in a single-threaded
 * context and before privileges are dropped. An array that cannot be loaded
 * is reported in the log and skipped.
 */
void arrays_init(void);

/**
 * Queue the startup probe of every array, the default one excluded, and
 * prepare their schedulers. Called at startup after privileges are dropped.
 */
void arrays_ready(void);

/**
 * Start the threads of every array, the default one excluded.
 */
void arrays_start(void);

/**
 * Stop the threads of every array, the default one excluded.
 */
void arrays_done(void);

/**
 * Wake up the scheduler of every array.
 * The state lock must be held.
 */
void arrays_pulse_locked(void);

/**
 * Copy again the options of the machine to every array, after the main
 * configuration changed. The state lock must be held.
 */
void arrays_inherit_locked(void);

/**
 * Reload the configuration of every array, the default one excluded. Arrays
 * whose file appeared are started, and arrays whose file is gone are removed
 * if they are idle.
 *
 * The state lock must be held, and it's released while working.
 */
void arrays_reload_locked_yield(void);

/**
 * Get the SnapRAID configuration file an array works with.
 * The state lock must be held.
 */
void array_engine_conf_locked(struct snapraid_state* state, char* path, size_t path_size);

/**
 * Create a new array at runtime, and start it.
 *
 * The SnapRAID configuration file is not created: the array is reported as
 * not configured until the file is written.
 *
 * @param name Name of the array
 * @param engine_conf SnapRAID configuration file, or an empty string for NAME.conf
 *     in the "snapraid" directory next to the main configuration file
 * @return 0 on success, otherwise -1 with msg and status set
 */
int array_create(const char* name, const char* engine_conf, char* msg, size_t msg_size, int* status);

/**
 * Remove an array at runtime.
 *
 * Only the daemon stops handling it: its configuration file is renamed to
 * NAME.conf.removed, and nothing else is touched. The SnapRAID configuration,
 * the content, the parity and the data stay where they are.
 *
 * The default array cannot be removed, and neither an array with tasks
 * running or queued.
 *
 * @return 0 on success, otherwise -1 with msg and status set
 */
int array_remove(const char* name, char* msg, size_t msg_size, int* status);

/**
 * Get the name of the heavy command an array is running, or is about to.
 * The state lock must be held.
 * @return The name of the command, or 0 if the array isn't working on its disks
 */
const char* array_heavy_command_locked(const char* name);

/**
 * Wake up the runner of every array, after something they may be waiting
 * for ended. The state lock must not be held.
 */
void arrays_wake(void);

/****************************************************************************/
/* arbiter */

/**
 * The arbiter decides which array can run a command of the engine that
 * reads or writes the whole disks (diff, sync, scrub, fix, check).
 *
 * By default one array at a time, in order to not have the disks of the
 * whole machine working, and heating, together. An array keeps the engine
 * until it has no more of these commands queued, so a maintenance is not
 * interleaved with the one of another array.
 *
 * With array_parallel = 1 arrays that share no physical disk run together.
 *
 * The light commands (probe, smart, up, down, status, list...) are never
 * delayed, so the disks of every array stay monitored during a long sync.
 */

/**
 * Check if the command is one that has to wait for the arbiter.
 */
int arbiter_is_heavy(int cmd);

/**
 * Ask to run a heavy command. The state lock must be held.
 * @return 1 if the array can run it now, 0 if it has to wait
 */
int arbiter_acquire_locked(struct snapraid_state* state);

/**
 * Tell that a task ended. The engine is given back if the array has no more
 * heavy commands queued, and the runners of the other arrays are woken up.
 * The state lock must be held.
 */
void arbiter_release_locked(struct snapraid_state* state);

/**
 * Get the array that the given one is waiting for.
 * The state lock must be held.
 * @return The state of the array holding the engine, or 0 if not waiting
 */
struct snapraid_state* arbiter_waiting_for_locked(struct snapraid_state* state);

/**
 * Check if another array has something running or queued, excluding queued
 * shutdowns. A shutdown of the machine waits for it.
 * The state lock must be held.
 */
int arrays_others_busy_locked(struct snapraid_state* state);

#endif
