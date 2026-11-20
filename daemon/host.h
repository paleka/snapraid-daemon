// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Paleka

#ifndef HOST_H
#define HOST_H

#include "state.h"
#include "str.h"

/*
 * Machine wide features, beside the arrays: settings of the machine kept in
 * snapraidd-host.conf next to the main configuration, and a thread acting on
 * them once a minute.
 *
 * - time window of the maintenance, SMART self-tests on a schedule
 * - disk power settings (APM, AAM, write cache), applied again at every start
 * - folder listings kept in memory, so browsing does not spin disks up
 * - suspend or power off when idle, Wake-on-LAN
 * - SMB and NFS shares, with users, recycle bin and permissions
 * - backups of folders to another disk, on a schedule or when it's plugged in
 * - wipe of a disk, copy of a tree, file operations, open files of a mount
 * - diagnostics, backup and restore of the settings, read and write history
 *
 * Requests come from rest.c as a flat list of names and values.
 */

#define HOST_ARGS_MAX 32

struct host_args {
	unsigned count;
	const char* key[HOST_ARGS_MAX];
	const char* val[HOST_ARGS_MAX];
};

/**
 * Value of an argument of the request, or 0 if missing.
 */
const char* host_arg(const struct host_args* args, const char* key);

/**
 * Load the settings of the machine and apply them. Called after the arrays are loaded.
 */
void host_init(void);

/**
 * Start the thread of the machine.
 */
void host_start(void);

/**
 * Stop the thread of the machine.
 */
void host_done(void);

/**
 * Answer a GET of /snapraid/v1/host[/what].
 * \return 0 on success, otherwise the HTTP status with the reason in msg.
 */
int host_get(const char* what, const struct host_args* query, ss_t* s, int level, char* msg, size_t msg_size);

/**
 * Answer a POST of /snapraid/v1/host/action.
 * \return 0 on success, otherwise the HTTP status with the reason in msg.
 */
int host_post(const char* action, const struct host_args* args, ss_t* s, int level, char* msg, size_t msg_size);

/**
 * Tell if the request is one that also needs the storage administration rights to be read.
 */
int host_get_is_private(const char* what);

/** Told by the move of files at its end, with the tag given at its start. */
void host_move_done(const char* tag, int status, const char* message);

/** If a file of a pool is in a folder set to stay on the fast disk of that tag. */
int host_move_stays(const char* tag, const char* rel);

/**
 * The disks chosen for the folder of a file of a pool.
 * \param disks Branches separated by ':'.
 * \return 1 if the folder has chosen disks.
 */
int host_keep_disks(const char* pool, const char* rel, char* disks, size_t disks_size);

int host_selftest(void);

#endif
