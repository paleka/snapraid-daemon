// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Paleka

#ifndef STORAGE_H
#define STORAGE_H

#include "state.h"
#include "str.h"

/****************************************************************************/
/* storage */

/**
 * Storage administration: disk inventory, filesystem creation, mounts,
 * /etc/fstab, mergerfs pools and the SnapRAID engine configuration file.
 *
 * All the functions changing the system return 0 on success, or a HTTP like
 * status code (400, 403, 409, 500, 501) with a human readable message in msg.
 *
 * Only available on Linux. On other platforms everything returns 501.
 */

#define STORAGE_TEXT_MAX 65536 /**< Max size of the configuration files handled */

/**
 * Emit the storage inventory as fields of the currently open JSON object.
 */
void storage_inventory_json(struct snapraid_state* state, ss_t* s, int level);

/**
 * Replace the SnapRAID engine configuration file. The previous one is kept as .bak.
 */
int storage_engine_conf_write(struct snapraid_state* state, const char* text, char* msg, size_t msg_size);

/**
 * Partition a whole disk with a single GPT partition and create a filesystem in it.
 * \param purpose "data" or "parity", used to tune the filesystem.
 * \param wipe If 0, refuse disks that already contain a partition table or filesystem.
 * \param part Filled with the path of the new partition.
 * \param uuid Filled with the UUID of the new filesystem.
 */
int storage_format(const char* device, const char* fstype, const char* label, const char* purpose, int wipe, char* part, size_t part_size, char* uuid, size_t uuid_size, char* msg, size_t msg_size);

/**
 * Mount a filesystem, optionally recording it in /etc/fstab.
 */
int storage_mount(const char* source, const char* target, const char* fstype, const char* options, int persist, char* msg, size_t msg_size);

/**
 * Unmount a filesystem, optionally removing it from /etc/fstab.
 */
int storage_unmount(const char* target, int forget, char* msg, size_t msg_size);

/**
 * Create a mergerfs pool, or update the branches and options of a mounted one.
 * \param branches Colon separated list of branch directories.
 */
int storage_pool(const char* mountpoint, const char* branches, const char* options, int persist, char* msg, size_t msg_size);

/**
 * Long operations run in background, one at a time. They are started by
 * the functions below and followed with storage_job_json().
 */

/** Emit the state of the last background job as fields of the open JSON object. */
void storage_job_json(ss_t* s, int level);

/** Ask the running background job to stop at the first safe point. */
int storage_job_stop(char* msg, size_t msg_size);

/** Like storage_format(), but in background. The result is in the job state. */
int storage_format_start(const char* device, const char* fstype, const char* label, const char* purpose, int wipe, char* msg, size_t msg_size);

/**
 * Move files between the branches of a pool, from the fullest to the
 * emptiest, until their fill levels are within `spread` percent points
 * or `max_bytes` were moved. Files are moved with rsync, like mergerfs.balance.
 */
int storage_balance_start(const char* mountpoint, uint64_t max_bytes, unsigned spread, char* msg, size_t msg_size);

/** Look for files present in more than one branch of a pool. */
int storage_duplicates_start(const char* mountpoint, char* msg, size_t msg_size);

/**
 * List a directory of a pool telling in which branches every entry is.
 * \param path Directory inside the pool, starting with /.
 */
int storage_browse_json(const char* mountpoint, const char* path, ss_t* s, int level, char* msg, size_t msg_size);

/**
 * Create a directory, with its parents, outside of the system ones.
 */
int storage_mkdir(const char* path, char* msg, size_t msg_size);

/**
 * Run the tests of the parts that need no disk: validation of what comes
 * from the network, mount table parsing, fstab editing, pool helpers.
 */
int storage_selftest(void);

#endif
