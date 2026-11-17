// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Andrea Mazzoleni

#include "os/portable.h"

#include "state.h"
#include "elem.h"
#include "log.h"

/****************************************************************************/
/* log */

#ifndef _WIN32
static int level_map[] = {
	LOG_CRIT,
	LOG_ERR,
	LOG_WARNING,
	LOG_INFO,
	LOG_DEBUG
};
#endif

int log_init(const char* ident)
{
#ifndef _WIN32
	openlog(ident, LOG_PID | LOG_NDELAY, LOG_DAEMON);
#else
	(void)ident;
#endif
	return 0;
}

#ifndef _WIN32
static void log_out(int level, int syslog, int termlog, const char* fmt, va_list ap)
{
	va_list ap2;

	va_copy(ap2, ap);

	if (syslog)
		vsyslog(level_map[level], fmt, ap);

	if (termlog) {
		vfprintf(stdout, fmt, ap2);
		fprintf(stdout, "\n");
		fflush(stdout);
	}

	va_end(ap2);
}
#else
static void log_out(int level, int syslog, int termlog, const char* fmt, va_list ap)
{
	va_list ap2;

	va_copy(ap2, ap);

	(void)level;
	(void)syslog;

	if (syslog) {
		char buf[1024];
		vsnprintf(buf, sizeof(buf), fmt, ap);
		windows_eventlog(level, buf);
	}

	if (termlog) {
		vfprintf(stderr, fmt, ap2);
		fprintf(stderr, "\n");
		fflush(stderr);
	}

	va_end(ap2);
}
#endif

#define LOG_MAX 1024

static void log_array(int level, int syslog, int termlog, const char* fmt, ...) __attribute__((format(attribute_printf, 4, 5)));

static void log_array(int level, int syslog, int termlog, const char* fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	log_out(level, syslog, termlog, fmt, ap);
	va_end(ap);
}

/**
 * Array the current thread works for, or 0 for the threads of the daemon
 * that are not specific of an array.
 *
 * Every array has its own runner and scheduler threads, working at the same
 * time: what they log is told apart with the name of the array, and the
 * messages for the task log are kept separated.
 */
static __thread struct snapraid_state* log_bound;

void log_bind(struct snapraid_state* state)
{
	log_bound = state;
}

/**
 * Like log_out(), with the name of the array in front, if not the default one.
 */
static void log_emit(int level, int syslog, int termlog, const char* fmt, va_list ap)
{
	if (log_bound == 0 || strcmp(log_bound->name, ARRAY_DEFAULT) == 0) {
		log_out(level, syslog, termlog, fmt, ap);
	} else {
		char buf[LOG_MAX];
		vsnprintf(buf, sizeof(buf), fmt, ap);
		log_array(level, syslog, termlog, "[%s] %s", log_bound->name, buf);
	}
}

void vlog_msg(int level, const char* fmt, va_list ap)
{
	int syslog;
	int termlog;
	int verboselog;

	/*
	 * Access fields of state->host->log requiring only log_lock (state_lock is not required).
	 * host_ptr() merely returns the global struct pointer without acquiring state_lock.
	 */
	log_lock();
	struct snapraid_host* host = host_ptr();
	syslog = host->log.syslog && level <= host->log.syslog_level;
	termlog = host->log.foreground;
	verboselog = host->log.verbose;

	log_unlock();

	if (level == LVL_DEBUG && !verboselog)
		return;

	log_emit(level, syslog, termlog, fmt, ap);
}

void log_msg(int level, const char* fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	vlog_msg(level, fmt, ap);
	va_end(ap);
}

void vlog_task(int level, const char* fmt, va_list ap)
{
	int syslog;
	int termlog;
	int verboselog;

	/*
	 * Access fields of state->host->log requiring only log_lock (state_lock is not required).
	 * host_ptr() merely returns the global struct pointer without acquiring state_lock.
	 */
	log_lock();
	struct snapraid_host* host = host_ptr();
	syslog = host->log.syslog && level <= host->log.syslog_level;
	termlog = host->log.foreground;
	verboselog = host->log.verbose;

	/* output also in the task log */
	if (level < LVL_INFO) {
		va_list ap2;
		char buf[LOG_MAX];

		strcpy(buf, "syslog: ");
		size_t len = strlen(buf);

		va_copy(ap2, ap);
		vsnprintf(buf + len, sizeof(buf) - len, fmt, ap2);
		va_end(ap2);

		/* what is logged by a thread not working for an array goes to the default one */
		struct snapraid_state* state = log_bound != 0 ? log_bound : state_ptr();
		message_insert(&state->log_task_list, level, MESSAGE_TYPE_SOFTWARE, buf);
	}

	log_unlock();

	if (level == LVL_DEBUG && !verboselog)
		return;

	log_emit(level, syslog, termlog, fmt, ap);
}

void log_task(int level, const char* fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	vlog_task(level, fmt, ap);
	va_end(ap);
}

void os_syslog(int level, const char* format, ...)
{
	va_list ap;

	va_start(ap, format);
	switch (level) {
	case OS_LVL_CRITICAL : vlog_task(LVL_CRITICAL, format, ap); break;
	case OS_LVL_ERROR : vlog_task(LVL_ERROR, format, ap); break;
	case OS_LVL_WARNING : vlog_task(LVL_WARNING, format, ap); break;
	case OS_LVL_INFO : vlog_task(LVL_INFO, format, ap); break;
	}

	va_end(ap);
}

void log_task_reset(void)
{
	log_lock();

	struct snapraid_state* state = log_bound != 0 ? log_bound : state_ptr();
	tommy_list_foreach(&state->log_task_list, message_free);
	tommy_list_init(&state->log_task_list);

	log_unlock();
}

void log_task_push(tommy_list* message_list)
{
	log_lock();

	struct snapraid_state* state = log_bound != 0 ? log_bound : state_ptr();

	tommy_node* i = tommy_list_head(&state->log_task_list);
	while (i != 0) {
		tommy_node* i_next = i->next;
		struct snapraid_message* message = i->data;

		tommy_list_insert_tail(message_list, &message->node, message);

		i = i_next;
	}

	tommy_list_init(&state->log_task_list);

	log_unlock();
}

void log_done(void)
{
#ifndef _WIN32
	closelog();
#endif
}

