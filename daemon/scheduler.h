// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Andrea Mazzoleni

#ifndef SCHEDULER_H
#define SCHEDULER_H

#include "state.h"

/****************************************************************************/
/* scheduler */

/**
 * Initialize the scheduler system.
 * @param state Current snapraid state
 */
void scheduler_init(struct snapraid_state* state);

/**
 * Start the scheduler thread.
 * @param state Current snapraid state
 */
void scheduler_start(struct snapraid_state* state);

/**
 * Cleanup the scheduler system.
 * @param state Current snapraid state
 */
void scheduler_done(struct snapraid_state* state);

/**
 * Trigger a scheduler check.
 * @param state Current snapraid state
 */
void scheduler_pulse(struct snapraid_state* state);

/**
 * Schedule a maintenance operation (sync followed by optional scrub).
 * @param state Current snapraid state
 * @param spindown 1 to spindown disks after completion, 0 to don't spindown, -1 use configured management
 * @param threshold 1 to apply configured thresholds
 * @param msg Buffer for error message
 * @param msg_size Size of message buffer
 * @param status Pointer to store HTTP status code
 */
void schedule_maintenance(struct snapraid_state* state, int spindown, int threshold, char* msg, size_t msg_size, int* status);

/**
 * Schedule the recovery of an array with replaced or changed disks.
 *
 * It follows the recovering procedure of the SnapRAID manual: `fix -d NAME`
 * for every disk to rebuild, optionally `check -d NAME -a` to verify the
 * result ignoring the parity, and then `sync` to record the new disks.
 *
 * With `accept` nothing is rebuilt: the disks are taken as they are and
 * only the `sync` runs. It's for disks whose content was copied by other
 * means, where only the filesystem UUID is new.
 *
 * It's the only sequence allowed to run fix, check and sync while the
 * array is DEGRADED, PREFAIL or FAILING, because those are the states
 * a recovery starts from.
 *
 * @param state Current snapraid state
 * @param disks Names of the data disks and parity levels to rebuild
 * @param check 1 to verify the rebuilt disks before the sync
 * @param accept 1 to skip the rebuild
 * @param force_uuid 1 to add -U, --force-uuid, needed when more disks changed UUID than the parity levels
 * @param msg Buffer for error message
 * @param msg_size Size of message buffer
 * @param status Pointer to store HTTP status code
 */
void schedule_recover(struct snapraid_state* state, sl_t* disks, int check, int accept, int force_uuid, char* msg, size_t msg_size, int* status);

/**
 * Schedule a heal operation (fix errors).
 * @param state Current snapraid state
 * @param spindown 1 to spindown disks after completion, 0 to don't spindown, -1 use configured management
 * @param msg Buffer for error message
 * @param msg_size Size of message buffer
 * @param status Pointer to store HTTP status code
 */
void schedule_heal(struct snapraid_state* state, int spindown, char* msg, size_t msg_size, int* status);

/**
 * Schedule an undelete operation.
 * @param state Current snapraid state
 * @param spindown 1 to spindown disks after completion, 0 otherwise
 * @param filter_list List of file filters for undelete
 * @param disk_filter_list List of disk filters for undelete
 * @param msg Buffer for error message
 * @param msg_size Size of message buffer
 * @param status Pointer to store HTTP status code
 */
void schedule_undelete(struct snapraid_state* state, int spindown, sl_t* filter_list, sl_t* disk_filter_list, char* msg, size_t msg_size, int* status);

/**
 * Converts a filter pattern from unified API/Unix escaping syntax to SnapRAID Windows syntax.
 * @param dst Destination buffer
 * @param dst_size Size of destination buffer
 * @param src Source filter string
 * @return 0 on success, -1 if converted string exceeds dst_size
 */
int filter_escape_to_windows(char* dst, size_t dst_size, const char* src);

/**
 * Schedule a spindown of idle disks.
 * @param state Current snapraid state
 * @param msg Buffer for error message
 * @param msg_size Size of message buffer
 * @param status Pointer to store HTTP status code
 */
void schedule_suspend_idle(struct snapraid_state* state, char* msg, size_t msg_size, int* status);

/**
 * Schedule a refresh.
 * @param state Current snapraid state
 * @param msg Buffer for error message
 * @param msg_size Size of message buffer
 * @param status Pointer to store HTTP status code
 */
void schedule_refresh(struct snapraid_state* state, char* msg, size_t msg_size, int* status);

/**
 * Schedule a custom sequence of commands.
 * @param state Current snapraid state
 * @param scheds List of schedule entries
 * @param msg Buffer for error message
 * @param msg_size Size of message buffer
 * @param status Pointer to store HTTP status code
 */
void schedule_commands(struct snapraid_state* state, tommy_list* scheds, char* msg, size_t msg_size, int* status);

#endif

