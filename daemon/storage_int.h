// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Paleka

#ifndef STORAGE_INT_H
#define STORAGE_INT_H

/*
 * Helpers of storage.c shared with host.c. Linux only.
 */

#ifdef __linux__

#include <sys/stat.h>

#include "str.h"

#define BRANCH_MAX 64

struct mount_entry {
	char source[PATH_MAX];
	char target[PATH_MAX];
	char fstype[64];
	char options[1024];
};

struct pool_branch {
	char path[PATH_MAX];
	int writable;
	uint64_t total;
	uint64_t free;
};

typedef int walk_func(const char* rel, const struct stat* st, void* arg);

/* privileges, nesting allowed */
void priv_enter(void);
void priv_leave(void);

/* validation */
int valid_chars(const char* str, const char* extra, size_t max);
int valid_path(const char* path);
int valid_browse_path(const char* path);
int system_path(const char* path);
int path_inside(const char* path, const char* dir);

/* tools, run as root without shell */
int tool_find(const char* name, char* path, size_t path_size);
int tool_exists(const char* name);
int tool_run(const char* name, const char** args, const char* stdin_text, ss_t* out, unsigned timeout_sec);
int tool_check(const char* name, const char** args, const char* stdin_text, unsigned timeout_sec, char* msg, size_t msg_size);

/* files */
int file_read(const char* path, ss_t* s);
int file_replace(const char* path, const char* text, const char* backup_ext, mode_t mode);
int make_dirs(const char* path);
int dir_is_empty(const char* path);

/* mounts and disks */
int mount_next(const char** cursor, struct mount_entry* entry, const char** line_begin, const char** line_end);
int is_mergerfs(const char* fstype);
int mount_find(const char* target, struct mount_entry* found);
int disk_in_use(const char* name, char* msg, size_t msg_size);
int pool_branches(const char* mountpoint, struct pool_branch* branches, unsigned* count, char* msg, size_t msg_size);
void pool_branches_space(struct pool_branch* branches, unsigned count);

/* tree walk, stopped by job_stopping() */
int walk_skip(const char* name, int top);
int walk_tree(const char* root, const char* rel, unsigned depth, walk_func* func, void* arg);

/* the background job: one at a time for storage and host operations */
int job_begin(const char* kind, const char* target, char* msg, size_t msg_size);
int job_launch(void* (*func)(void*), char* msg, size_t msg_size);
void job_finish(int status, const char* message);
void job_current(const char* what);
int job_stopping(void);
int job_is_running(void);
void job_progress(uint64_t files, uint64_t bytes);
void job_claim(const char* array);
void job_result_line(const char* name, const char* value);

#endif

#endif
