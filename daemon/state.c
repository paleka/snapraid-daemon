// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Andrea Mazzoleni

#include "os/portable.h"

#include "support.h"
#include "elem.h"
#include "conf.h"
#include "state.h"

struct snapraid_host HOST;
struct snapraid_state STATE;

/**
 * Initialize the part of the state that is specific of one array.
 */
static void state_setup(struct snapraid_state* state, const char* name)
{
	memset(state, 0, sizeof(*state));

	state->host = &HOST;
	sncpy(state->name, sizeof(state->name), name);
	tommy_list_init(&state->device_catalog);
	tommy_list_init(&state->log_task_list);
	diff_cleanup(&state->array.diff_parse, 0);
	diff_cleanup(&state->array.diff_current, 0);
	diff_cleanup(&state->array.diff_prev, 0);
	fix_cleanup(&state->array.fix_current);
	tommy_hashtable_init(&state->parser_association_hash, PARSER_ASSOCIATION_HASH_SIZE);
	tommy_hashtable_init(&state->parser_duplicate_hash, PARSER_DUPLICATE_HASH_SIZE);
	state->daemon_loading = 1;
	state->array.health = HEALTH_PENDING;
	sncpy(state->array.health_reason, sizeof(state->array.health_reason), "Daemon is initializing and array health assessment is pending");
}

static void state_cleanup(struct snapraid_state* state)
{
	tommy_list_foreach(&state->log_task_list, message_free);
	tommy_list_foreach(&state->runner.waiting_list, task_free);
	if (state->runner.latest && state->runner.latest->running) /* if running it isn't in the lists */
		task_free(state->runner.latest);
	tommy_list_foreach(&state->runner.history_list, task_free);
	tommy_tree_foreach(&state->array.diff_parse.file_tree, file_free);
	tommy_tree_foreach(&state->array.diff_current.file_tree, file_free);
	tommy_tree_foreach(&state->array.diff_prev.file_tree, file_free);
	tommy_tree_foreach(&state->array.fix_current.file_tree, file_free);
	tommy_list_foreach(&state->array.bucket_parse_list, bucket_free);
	tommy_list_foreach(&state->array.bucket_list, bucket_free);
	tommy_list_foreach(&state->array.disk_list, disk_free);
	tommy_list_foreach(&state->device_catalog, device_free);
	tommy_list_foreach(&state->parser_association, association_free);
	tommy_hashtable_done(&state->parser_association_hash);
	tommy_hashtable_foreach(&state->parser_duplicate_hash, free);
	tommy_hashtable_done(&state->parser_duplicate_hash);
}

struct snapraid_state* state_init(void)
{
	struct snapraid_host* host = &HOST;

	memset(host, 0, sizeof(*host));

	thread_mutex_init(&host->state_lock);
	thread_mutex_init(&host->log_lock);
	thread_rwlock_init(&host->web_lock);
	tommy_list_init(&host->state_list);
	tommy_list_init(&host->removed_list);
	host->daemon_terminating = 0;
	host->daemon_failing = 0;
	host->daemon_aborting = 0;
	host->daemon_start_time = time(0);

	state_setup(&STATE, ARRAY_DEFAULT);
	tommy_list_insert_tail(&host->state_list, &STATE.node, &STATE);

	return &STATE;
}

void state_done(struct snapraid_state* state)
{
	struct snapraid_host* host = &HOST;

	assert(state == &STATE);

	/* the other arrays, the removed ones included */
	for (int pass = 0; pass < 2; ++pass) {
		tommy_node* i = tommy_list_head(pass == 0 ? &host->state_list : &host->removed_list);
		while (i) {
			struct snapraid_state* other = i->data;
			i = i->next;
			if (other != &STATE)
				state_free(other);
		}
	}

	state_cleanup(state);

	tommy_list_foreach(&host->web.page_list, page_free);
	crypto_wipe(host->rest_auth_cache, sizeof(host->rest_auth_cache));
	thread_mutex_destroy(&host->state_lock);
	thread_mutex_destroy(&host->log_lock);
	thread_rwlock_destroy(&host->web_lock);

	memset(&STATE, 0, sizeof(STATE)); /* clear to have leaks reported */
	memset(&HOST, 0, sizeof(HOST));
}

struct snapraid_state* state_alloc(const char* name)
{
	struct snapraid_state* state = malloc_nofail(sizeof(struct snapraid_state));

	state_setup(state, name);

	return state;
}

void state_free(struct snapraid_state* state)
{
	state_cleanup(state);
	config_done(state);
	free(state);
}

int state_name_valid(const char* name)
{
	size_t len = strlen(name);

	if (len == 0 || len >= ARRAY_NAME_MAX)
		return 0;
	if (strspn(name, "abcdefghijklmnopqrstuvwxyz0123456789_-") != len)
		return 0;
	if (name[0] == '_' || name[0] == '-')
		return 0;

	return 1;
}

struct snapraid_state* state_find_locked(const char* name)
{
	for (tommy_node* i = tommy_list_head(&HOST.state_list); i; i = i->next) {
		struct snapraid_state* state = i->data;
		if (strcmp(state->name, name) == 0)
			return state;
	}

	return 0;
}

struct snapraid_state* state_ptr(void)
{
	return &STATE;
}

struct snapraid_host* host_ptr(void)
{
	return &HOST;
}

void state_lock(void)
{
	thread_mutex_lock(&HOST.state_lock);
}

void state_unlock(void)
{
	thread_mutex_unlock(&HOST.state_lock);
}

void log_lock(void)
{
	thread_mutex_lock(&HOST.log_lock);
}

void log_unlock(void)
{
	thread_mutex_unlock(&HOST.log_lock);
}

void web_rdlock(void)
{
	thread_rwlock_rdlock(&HOST.web_lock);
}

void web_wrlock(void)
{
	thread_rwlock_wrlock(&HOST.web_lock);
}

void web_unlock(void)
{
	thread_rwlock_unlock(&HOST.web_lock);
}
