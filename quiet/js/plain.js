// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Paleka

// The logic of the pages for everyday use, without any page: what the state of
// the machine means in plain words, schedules, notifications and the parsing of
// tool outputs. Kept apart so it can be tested (test/ui/plain.test.mjs).

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const NTH = ['', 'first', 'second', 'third', 'fourth'];

/* ------------------------------------------------------------------ */
/* words                                                               */
/* ------------------------------------------------------------------ */

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "3 minutes", "5 hours", "2 days": the biggest unit that fits. */
export const humanSpan = (seconds) => {
    const s = Math.max(0, Math.round(seconds));
    if (s < 90) return plural(s, 'second', 'seconds');
    if (s < 90 * 60) return plural(Math.round(s / 60), 'minute', 'minutes');
    if (s < 36 * 3600) return plural(Math.round(s / 3600), 'hour', 'hours');
    return plural(Math.round(s / 86400), 'day', 'days');
};

/** Seconds from an ISO local time to the reference one (the server's "now"). */
export const secondsSince = (iso, nowIso) => {
    if (!iso) return null;
    const t = Date.parse(iso);
    const now = nowIso ? Date.parse(nowIso) : Date.now();
    if (Number.isNaN(t) || Number.isNaN(now)) return null;
    return (now - t) / 1000;
};

export const ago = (iso, nowIso) => {
    const s = secondsSince(iso, nowIso);
    return s == null ? 'never' : `${humanSpan(s)} ago`;
};

export const bytes = (n) => {
    if (n == null || Number.isNaN(n)) return '–';
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0;
    let v = n;
    while (v >= 1000 && i < u.length - 1) { v /= 1000; ++i; }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};

/** Short explanations of the words of the trade, shown on hover. */
export const GLOSSARY = {
    ups: 'A battery that keeps the server on during a power cut, long enough to finish and turn off cleanly. UPS stands for uninterruptible power supply.',
    eject: 'Releasing a disk so it can be unplugged without losing what was still being written.',
    parity: 'Extra information kept on the protection disks. With it, the files of a failed disk can be rebuilt.',
    sync: 'Updating the protection, so the newest files can be rebuilt too. SnapRAID protects a snapshot: what changed after the last update is not protected yet.',
    scrub: 'Reading a part of the data and comparing it with what was saved, to find damage before it is too late.',
    pool: 'One folder that shows the files of all the data disks together, as if they were one big disk.',
    array: 'The group of disks protected together: data disks and protection disks.',
    smart: 'Self-diagnosis built into every disk. It warns about wear and errors before a disk fails.',
    share: 'A folder that the other computers of your network can open.',
    'recycle bin': 'Files deleted from a share over the network go here first, and are really deleted after some days.',
    'fast disk': 'An SSD placed in front of the big disks. New files are written to it first, then moved to the big disks at night. Also called cache.',
    mover: 'The nightly work that moves the files from the fast disk to the disks of the array, where the protection covers them.'
};

/* ------------------------------------------------------------------ */
/* schedules                                                           */
/* ------------------------------------------------------------------ */

/**
 * Parse a schedule of the daemon: "02:00", "Sun 05:00", "Sun#1 04:00" (first Sunday of the month),
 * separated by commas. Entries that cannot be read are skipped.
 */
export const parseSchedule = (text) => (text || '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^(?:([A-Za-z]{3})(?:#([1-4]))?\s+)?(\d{2}):(\d{2})$/);
    if (!m) return null;
    const day = m[1] ? DAY3.findIndex(d => d.toLowerCase() === m[1].toLowerCase()) : -1;
    if (m[1] && day < 0) return null;
    const hour = Number(m[3]);
    const minute = Number(m[4]);
    if (hour > 23 || minute > 59) return null;
    return { day, nth: m[2] ? Number(m[2]) : 0, hour, minute };
}).filter(Boolean);

const hhmm = (e) => `${String(e.hour).padStart(2, '0')}:${String(e.minute).padStart(2, '0')}`;

export const formatSchedule = (list) => list.map(e => e.day < 0 ? hhmm(e) : `${DAY3[e.day]}${e.nth ? `#${e.nth}` : ''} ${hhmm(e)}`).join(', ');

/** "every day at 02:00 and every Sunday at 05:00" */
export const describeSchedule = (text) => {
    const list = parseSchedule(text);
    if (!list.length) return 'never';
    const one = (e) => e.day < 0 ? `every day at ${hhmm(e)}`
        : e.nth ? `the ${NTH[e.nth]} ${DAYS[e.day]} of every month at ${hhmm(e)}`
            : `every ${DAYS[e.day]} at ${hhmm(e)}`;
    const words = list.map(one);
    return words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
};

/** The next time a schedule fires after the given date, or null. */
export const nextRun = (text, now = new Date()) => {
    const list = parseSchedule(text);
    let best = null;
    for (const e of list) {
        for (let d = 0; d <= 62; ++d) {
            const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, e.hour, e.minute, 0, 0);
            if (t <= now) continue;
            if (e.day >= 0 && t.getDay() !== e.day) continue;
            if (e.nth && Math.floor((t.getDate() - 1) / 7) + 1 !== e.nth) continue;
            if (!best || t < best) best = t;
            break;
        }
    }
    return best;
};

/** "tonight at 02:00", "tomorrow at 05:00", "on Sunday at 05:00", "on 1 March at 04:00" */
export const whenWords = (date, now = new Date()) => {
    if (!date) return 'not planned';
    const days = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
    const at = `at ${hhmm({ hour: date.getHours(), minute: date.getMinutes() })}`;
    if (days === 0) return `${date.getHours() >= 18 || date.getHours() < 5 ? 'tonight' : 'today'} ${at}`;
    if (days === 1) return `${date.getHours() < 5 ? 'tonight' : 'tomorrow'} ${at}`;
    if (days < 7) return `on ${DAYS[date.getDay()]} ${at}`;
    return `on ${date.getDate()} ${date.toLocaleString('en', { month: 'long' })} ${at}`;
};

/* ------------------------------------------------------------------ */
/* tasks                                                               */
/* ------------------------------------------------------------------ */

const TASK_WORDS = {
    sync: ['Protection updated', 'Updating the protection'],
    scrub: ['Checked for damage', 'Checking for damage'],
    fix: ['Files repaired', 'Repairing files'],
    check: ['Files verified', 'Verifying files'],
    diff: ['Looked for changes', 'Looking for changes'],
    probe: ['Disks looked at', 'Looking at the disks'],
    smart: ['Disk health read', 'Reading the disk health'],
    up: ['Disks woken up', 'Waking up the disks'],
    down: ['Disks put to sleep', 'Putting the disks to sleep'],
    down_idle: ['Idle disks put to sleep', 'Putting idle disks to sleep'],
    report: ['Report sent', 'Sending the report'],
    read: ['State read', 'Reading the state'],
    status: ['Status read', 'Reading the status'],
    start: ['Started', 'Starting'],
    shutdown: ['Machine switched off', 'Switching off the machine']
};

/** Routine commands, not worth telling a person about. */
export const ROUTINE = ['probe', 'smart', 'report', 'read', 'status', 'start', 'down_idle', 'up', 'down'];

export const taskTitle = (task, running = false) => (TASK_WORDS[task.command] || [task.command, task.command])[running ? 1 : 0];

/** Did the task do its job? */
export const taskOk = (task) => task.status === 'terminated' && !task.exit_code;

/** One line in plain words about a finished task. */
/** Messages of the engine said again for a person. */
const PLAIN_ERRORS = [
    [/There are soft errors/, 'Some files changed after the last update of the protection: that is not damage.'],
    [/Too many files were removed \((\d+), limit is (\d+)\)/, 'Stopped by the safety check: $1 files were deleted, more than $2. It waits for your OK on the Protection page.'],
    [/Too many files were updated \((\d+), limit is (\d+)\)/, 'Stopped by the safety check: $1 files were changed, more than $2. It waits for your OK on the Protection page.'],
    [/--force-empty/, 'A data disk looks empty: it may not be mounted. Nothing was changed. If you emptied it on purpose, say so on the Disks page: turn on Advanced, then “Empty it…”.'],
    [/The preceding sync operation failed/, 'Skipped, because the update of the protection before it did not finish.'],
    [/Insufficient parity space|Failed to allocate all the required parity space/, 'The protection disk is full: a data disk holds more than it can protect.'],
    [/are now missing or have been rewritten/, 'A data disk looks empty: it may not be mounted. Nothing was changed. If you emptied it on purpose, say so on the Disks page: turn on Advanced, then “Empty it…”.'],
    [/Unrecoverable errors detected/, 'Some files could not be rebuilt: they had changed after the last update of the protection, which keeps only the state of that moment.']
];

export const plainError = (text) => {
    for (const [re, words] of PLAIN_ERRORS) {
        const m = (text || '').match(re);
        if (m) return words.replace(/\$(\d)/g, (_, i) => m[Number(i)]);
    }
    return text;
};

export const taskWords = (task) => {
    // diff tells with its exit code that there are differences
    if (task.command === 'diff' && task.status === 'terminated' && task.exit_code === 2)
        return { title: 'Looked for changes', detail: 'Some files changed since the last update of the protection.', ok: true };
    const ok = taskOk(task);
    let detail = '';
    if (task.status === 'canceled') {
        const why = (task.messages || []).map(m => m.text || '').find(t => /preceding/.test(t));
        return { title: `${taskTitle(task)}: skipped`, detail: why ? plainError(why) : 'It did not start.', ok: false };
    }
    else if (task.status === 'signaled' || (task.messages || []).some(m => /Stop requested/.test(m.text || ''))) detail = 'Stopped before the end. The next run continues from there.';
    else if (!ok) {
        const errs = (task.messages || []).filter(m => m.level === 'error' || m.level === 'fatal').map(m => m.text).filter(Boolean);
        const known = errs.map(plainError).find((t, i) => t !== errs[i]);
        const err = known || errs.pop();
        detail = err ? (known ? err : `It did not finish: ${err}`) : 'It did not finish. The details are in Tasks.';
        if (errs.some(t => /Too many files were (removed|updated)/.test(t)))
            return { title: 'Protection update paused', detail, ok: false };
        if (errs.some(t => /There are soft errors/.test(t)) && !errs.some(t => /data errors|unrecoverable/i.test(t)) && known)
            return { title: `${taskTitle(task)}: changes found`, detail, ok: true };
    } else if (task.command === 'scrub') detail = 'No damage found.';
    else if (task.command === 'sync') detail = 'The newest files can now be rebuilt too.';
    return { title: ok ? taskTitle(task) : `${taskTitle(task)}: problem`, detail, ok };
};

export const lastTask = (tasks, command, onlyOk = false) => (tasks?.history || []).find(t => t.command === command && t.status === 'terminated' && (!onlyOk || !t.exit_code));

/** Duration in seconds of a finished task. */
export const taskSeconds = (t) => {
    if (!t.started_at || !t.finished_at) return 0;
    return Math.max(0, (Date.parse(t.finished_at) - Date.parse(t.started_at)) / 1000);
};

/**
 * The latest update of the protection was stopped by the safety check, because too many
 * files were deleted or changed: it waits for a person to say it's fine.
 * \return { what: 'removed' | 'updated', count, limit } or null
 */
export const blockedSync = (tasks) => {
    const sync = (tasks?.history || []).find(t => t.command === 'sync' && t.status === 'terminated');
    if (!sync || !sync.exit_code) return null;
    for (const m of sync.messages || []) {
        const hit = (m.text || '').match(/Too many files were (removed|updated) \((\d+), limit is (\d+)\)/);
        if (hit) return { what: hit[1], count: Number(hit[2]), limit: Number(hit[3]), at: sync.finished_at };
    }
    return null;
};

/** Files changed since the last update of the protection, as counted by the latest diff. */
export const pendingChanges = (array) => array ? (array.diff_added || 0) + (array.diff_removed || 0) + (array.diff_updated || 0) + (array.diff_moved || 0) + (array.diff_copied || 0) + (array.diff_relocated || 0) + (array.diff_restored || 0) : 0;

/* ------------------------------------------------------------------ */
/* the headline of the home page                                       */
/* ------------------------------------------------------------------ */

/**
 * What a person needs to know first, in one headline, one sentence and one action.
 * \param d { configured, health, healthReason, active (state of the running task or null), array, tasks, config, now, diskProblems }
 * \return { level: 'setup' | 'bad' | 'warn' | 'busy' | 'ok', title, text, action: { label, act } | null }
 */
export const homeStatus = (d) => {
    const array = d.array || {};
    const now = d.now || new Date();
    const nowIso = array.pulse?.current_at;
    if (!d.configured)
        return { level: 'setup', title: 'Let’s set up your storage', text: 'Choose which disks keep your files and which keep the protection. It takes a few minutes, and every step is explained before it happens.', action: { label: 'Start the guided setup', act: 'setup' } };

    if (['failing', 'prefail'].includes(d.health))
        return { level: 'bad', title: 'A disk is failing', text: `${d.healthReason || 'A disk reports serious errors.'} Your files are still there. Replace the disk soon: the protection rebuilds its files on the new one.`, action: { label: 'See which disk', act: 'drives' } };
    if (d.health === 'degraded')
        return { level: 'bad', title: 'A disk is missing or was replaced', text: `${d.healthReason || 'A disk does not answer as expected.'} The automatic protection is paused until it is solved.`, action: { label: 'Fix it', act: 'recover' } };
    if (d.health === 'corrupt' || (array.blocks_bad || 0) > 0)
        return { level: 'bad', title: 'Some data is damaged', text: `${plural(array.blocks_bad || 0, 'block was', 'blocks were')} found damaged. The protection can usually repair them.`, action: { label: 'Repair now', act: 'heal' } };

    if (d.active)
        return { level: 'busy', title: `${taskTitle({ command: d.active.command }, true)}…`, text: d.active.progress != null ? `${d.active.progress}% done${d.active.eta_seconds ? `, about ${humanSpan(d.active.eta_seconds)} left` : ''}. You can keep using your files.` : 'You can keep using your files.', action: null };

    const blocked = blockedSync(d.tasks);
    // the files may be back since: then only the update is missing
    const latest = blocked ? (blocked.what === 'removed' ? array.diff_removed : array.diff_updated) : null;
    if (blocked && latest != null && latest < blocked.limit)
        return { level: 'warn', title: 'Update the protection now', text: `The last update stopped because ${plural(blocked.count, `file was ${blocked.what === 'removed' ? 'deleted' : 'changed'}`, `files were ${blocked.what === 'removed' ? 'deleted' : 'changed'}`)}. Now there are ${latest}: below the safety limit of ${blocked.limit}.`, action: { label: 'Protect now', act: 'protect' } };
    if (blocked)
        return { level: 'warn', title: 'The protection waits for your OK', text: `${plural(blocked.count, `file was ${blocked.what === 'removed' ? 'deleted' : 'changed'}`, `files were ${blocked.what === 'removed' ? 'deleted' : 'changed'}`)} since the last update, more than the safety limit of ${blocked.limit}. If it was on purpose, say so; if not, you can still get them back.`, action: { label: 'Look at it', act: 'protection' } };

    if ((d.diskProblems || 0) > 0)
        return { level: 'warn', title: 'A disk shows signs of wear', text: `${plural(d.diskProblems, 'disk reports', 'disks report')} errors or high temperature. Nothing is lost; keep an eye on it.`, action: { label: 'See the disks', act: 'drives' } };

    const sync = lastTask(d.tasks, 'sync', true);
    const changes = pendingChanges(array);
    const next = nextRun(d.config?.maintenance_schedule, now);
    const nextText = next ? `The next automatic update is ${whenWords(next, now)}.` : 'No automatic update is planned: set one in Protection.';
    // the history of the tasks is kept for some days only: "never" is told by the blocks
    if (!sync && array.blocks_count && array.blocks_unsynced >= array.blocks_count)
        return { level: 'warn', title: 'Your files are not protected yet', text: `The protection was never updated. ${nextText}`, action: { label: 'Protect now', act: 'protect' } };
    const age = sync ? secondsSince(sync.finished_at, nowIso) : null;
    if (age != null && age > 3 * 86400)
        return { level: 'warn', title: 'The protection is getting old', text: `It was last updated ${humanSpan(age)} ago: files changed since then cannot be rebuilt. ${nextText}`, action: { label: 'Protect now', act: 'protect' } };
    if (!next)
        return { level: 'warn', title: 'Automatic protection is off', text: `Nothing updates the protection by itself.${age != null ? ` It was last updated ${humanSpan(age)} ago.` : ''}`, action: { label: 'Turn it on', act: 'protection' } };

    return {
        level: 'ok', title: 'Your files are safe',
        text: `${age != null ? `Protected ${humanSpan(age)} ago` : 'Protected'}${changes ? `, ${plural(changes, 'file changed', 'files changed')} since then` : ''}. ${nextText}`,
        action: changes ? { label: 'Protect the changes now', act: 'protect' } : null
    };
};

/* ------------------------------------------------------------------ */
/* findings beyond the Storage advisor                                 */
/* ------------------------------------------------------------------ */

/**
 * Health checks of the machine, most serious first. Each is { level: bad|warn|tip, title, text, action: { label, act } }.
 */
export const machineFindings = ({ host, config, disks, nowIso }) => {
    const out = [];
    const add = (level, title, text, action = null) => out.push({ level, title, text, action });
    const facts = host?.facts || {};

    if (facts.root_total_bytes && facts.root_free_bytes < Math.min(2e9, facts.root_total_bytes * 0.05))
        add('bad', 'The system disk is almost full', `Only ${bytes(facts.root_free_bytes)} are free on the disk of the system. Logs and updates may fail.`);
    if (facts.log_free_bytes != null && facts.log_free_bytes < 5e8)
        add('warn', 'Little space left for the logs', `${bytes(facts.log_free_bytes)} free in ${facts.log_dir}. Without its logs the daemon forgets what it did.`);

    for (const b of host?.backups || []) {
        if (b.last_status != null && b.last_status !== 0 && b.last_status !== 207)
            add('bad', `The backup “${b.name}” failed`, b.last_message || 'See the Backups page.', { label: 'Open Backups', act: 'backups' });
    }

    const all = [...(disks?.data_disks || []), ...(disks?.parity_disks || [])];
    for (const d of all) {
        for (const dev of d.devices || []) {
            const st = dev.smart?.temperature_status;
            if (st === 'critical' || st === 'danger')
                add('bad', `${d.name} is too hot`, `It's at ${dev.smart.temperature_celsius} °C. Heat shortens the life of disks: check the fans and the air flow.`, { label: 'See the disks', act: 'drives' });
        }
    }

    for (const f of cacheFindings(host))
        out.push(f);

    if (config && !config.notify_result)
        add('warn', 'Nobody is told when something goes wrong', 'Problems are only shown here. Get a message on your phone or by email instead.', { label: 'Set up alerts', act: 'alerts' });
    if (host && !host.smart_tests?.short && !host.smart_tests?.long)
        add('tip', 'Disk self-tests are not scheduled', 'A short test every week and a long one every month find failing disks earlier.', { label: 'Schedule them', act: 'drives' });
    if (host && !(host.backups || []).length)
        add('tip', 'No backup copy', 'Protection rebuilds a failed disk, but a file deleted or overwritten by mistake is gone after the next update. A copy on another disk keeps it.', { label: 'Make a backup', act: 'backups' });
    if (host && (host.shares || []).some(s => s.smb !== false) && !facts.samba_ready && !host.tools?.smbd)
        add('warn', 'Shares are set but Samba is missing', 'Install the samba package so the other computers can open them.');
    if (host && host.facts && host.facts.clock_synchronized === false && host.tools?.systemctl)
        add('tip', 'The clock may not be synchronized', 'Schedules run on the clock of this machine. Turn on time synchronization (timedatectl set-ntp true).');
    void nowIso;

    const order = { bad: 0, warn: 1, tip: 2, ok: 3 };
    return out.sort((a, b) => order[a.level] - order[b.level]);
};

/* ------------------------------------------------------------------ */
/* fast disks                                                          */
/* ------------------------------------------------------------------ */

/**
 * What waits on a fast disk, as counted by the daemon: { files, bytes, more }.
 * 'more' tells that the count stopped at its limit.
 */
export const cacheWaiting = (c) => ({ files: c?.waiting_files || 0, bytes: c?.waiting_bytes || 0, more: !!c?.waiting_more });

/** The same in words: "3 files (12 MB) waiting", "empty". */
export const cacheWaitingWords = (c) => {
    const w = cacheWaiting(c);
    if (!w.files) return 'empty';
    return w.more ? `more than ${w.files} files waiting` : `${plural(w.files, 'file', 'files')} (${bytes(w.bytes)}) waiting`;
};

/** The line of the SnapRAID configuration that sets the temperature limit, however it was parsed. */
export const isTempLimit = (e) => (e.type === 'option' && e.key === 'temp_limit') || (e.type === 'raw' && /^\s*temp_limit(\s|$)/.test(e.raw || ''));

/** The temperature limit of a parsed SnapRAID configuration, or '' when there is none. */
export const confTempLimit = (conf) => {
    const e = (conf || []).find(isTempLimit);
    if (!e) return '';
    return String(e.type === 'option' ? e.value : (e.raw.trim().split(/\s+/)[1] || '')).trim();
};

/** What a fast disk does, in one sentence. */
export const cacheWords = (c) => {
    const when = c.when ? describeSchedule(c.when) : '';
    const age = Number(c.age_hours) > 0 ? `files not changed for ${plural(Number(c.age_hours), 'hour', 'hours')}` : 'every file';
    const parts = [when ? `${when}, ${age} is moved to the other disks` : 'Files are moved only when you press Move now'];
    if (Number(c.fill) > 0) parts.push(`at once when it is more than ${c.fill}% full`);
    const text = `${parts.join('; ')}${c.sync === false ? '' : '. Then the protection is updated'}.`;
    return text.charAt(0).toUpperCase() + text.slice(1);
};

/** What the home page says about the fast disks. */
export const cacheFindings = (host) => {
    const out = [];
    for (const c of host?.caches || []) {
        if (c.last_status != null && c.last_status !== 0 && c.last_status !== 499)
            out.push({ level: 'bad', title: `The move from the fast disk “${c.name}” failed`, text: c.last_message || 'See the Disks page.', action: { label: 'Open Disks', act: 'drives' } });
        else if (c.total_bytes && c.free_bytes < c.total_bytes * 0.05)
            out.push({ level: 'warn', title: `The fast disk “${c.name}” is full`, text: 'New files go straight to the big disks until it is emptied. Move its files now, or let it move them earlier.', action: { label: 'Open Disks', act: 'drives' } });
        else if (c.enabled === false || (!c.when && !(Number(c.fill) > 0)))
            out.push({ level: 'warn', title: `The fast disk “${c.name}” is never emptied`, text: 'Its files stay there, outside the protection. Set a time for the move.', action: { label: 'Open Disks', act: 'drives' } });
    }
    return out;
};

/* ------------------------------------------------------------------ */
/* folders kept on chosen disks                                        */
/* ------------------------------------------------------------------ */

/** A name for the setting of a folder kept on chosen disks, not yet taken. */
export const keepName = (rel, taken = []) => {
    const base = (String(rel || '').split('/').filter(Boolean).pop() || 'folder').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'folder';
    let name = base;
    for (let i = 2; taken.includes(name); ++i) name = `${base}-${i}`;
    return name;
};

/** The setting of a folder, if it has one: same pool and same path. */
export const keepOf = (keeps, pool, rel) => (keeps || []).find(k => k.pool === pool && k.path === rel) || null;

/** What keeping a folder on its disks means, in one sentence. */
export const keepWords = (k, diskName = (p) => p.split('/').pop()) => {
    const disks = String(k.disks || '').split(':').filter(Boolean).map(diskName);
    const list = disks.length > 1 ? `${disks.slice(0, -1).join(', ')} and ${disks[disks.length - 1]}` : disks[0] || '–';
    if (k.enabled === false || !k.when) return `Chosen: ${list}. Nothing is brought back by itself: use Tidy now.`;
    const when = describeSchedule(k.when);
    return `Kept on ${list}. New files that land on another disk are brought back ${when.charAt(0).toLowerCase()}${when.slice(1)}.`;
};

/** How a folder is spread over the disks, from the result of the 'usage' job. */
export const usageRows = (job) => (job?.result || []).map(r => {
    const [b, f] = String(r.value || '').split(' ');
    return { path: r.name, bytes: Number(b) || 0, files: Number(f) || 0 };
}).sort((a, b) => b.bytes - a.bytes);

/** The outcome of a move of files among disks, in plain words. */
export const moveWords = (job) => {
    if (!job) return '';
    const moved = `${plural(job.files || 0, 'file', 'files')} moved (${bytes(job.bytes || 0)})`;
    if (!job.success) return `${job.message || 'Not finished'}`;
    if (job.skipped) return `${moved}. ${plural(job.skipped, 'file was', 'files were')} left where ${job.skipped === 1 ? 'it was' : 'they were'}: see why below.`;
    return job.files ? `${moved}.` : 'There was nothing to move.';
};

/* ------------------------------------------------------------------ */
/* the first visit                                                     */
/* ------------------------------------------------------------------ */

export const TOUR = [
    { title: 'Welcome', text: 'This server keeps your files on several disks and protects them, so a broken disk does not cost you anything. Four things are worth knowing. It takes a minute.' },
    { title: 'Home tells you if all is well', text: 'One sentence at the top says how things are, and one button does what is needed. Green means there is nothing to do. Around it, tiles show the space, the disks, what comes next and what happened; “Needs your attention” lists anything to look at, most important first.' },
    { title: 'Your data and your server', text: 'The menu has two groups. “Your data”: My files, Sharing with the other computers, and Backups. “Your server”: the Disks, the Protection, Alerts and System. Each page starts with the everyday things. Ctrl K (Cmd K on a Mac) finds any page, disk, share or setting.' },
    { title: 'Advanced is there when you want it', text: 'Pages and windows with finer controls have an “Advanced” switch. Leave it off and the usual choices are made for you; turn it on to see and change them. The switch is remembered for each page.' },
    { title: 'Nothing happens by surprise', text: 'Before anything is changed, a window tells what will happen and what stays as it is. After saving, the page reads the setting back and tells when it runs next. Help explains every word and the common jobs.' }
];

/* ------------------------------------------------------------------ */
/* notifications                                                       */
/* ------------------------------------------------------------------ */

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export const CHANNELS = {
    ntfy: { label: 'Phone notification (ntfy)', fields: [['topic', 'Topic or full address', 'ntfy.sh/my-secret-topic']] },
    discord: { label: 'Discord', fields: [['url', 'Webhook address', 'https://discord.com/api/webhooks/…']] },
    telegram: { label: 'Telegram', fields: [['token', 'Bot token', '123456:ABC…'], ['chat', 'Chat ID', '123456789']] },
    email: { label: 'Email (local mail command)', fields: [['to', 'Address', 'me@example.com']] },
    webhook: { label: 'Other web address (POST)', fields: [['url', 'Address', 'https://…']] }
};

/** The command of the daemon (notify_result) that sends the report to a channel. */
export const notifyCommand = (channel, f) => {
    switch (channel) {
        case 'ntfy': {
            const topic = String(f.topic || '').trim();
            const url = /^https?:\/\//.test(topic) ? topic : topic.includes('/') ? `https://${topic}` : `https://ntfy.sh/${topic}`;
            return `curl -fsS --max-time 30 --retry 3 -H "Title: %s" -H "Priority: %n" -H "Tags: %t" --data-binary @- ${shq(url)}`;
        }
        case 'discord':
            return `curl -fsS --max-time 30 --retry 3 -H "Content-Type: application/json" -d "{\\"content\\": \\"%s\\"}" ${shq(f.url)}`;
        case 'telegram':
            return `curl -fsS --max-time 30 --retry 3 --data-urlencode "chat_id=${String(f.chat).replace(/[^0-9-]/g, '')}" --data-urlencode "text=%s" ${shq(`https://api.telegram.org/bot${f.token}/sendMessage`)}`;
        case 'email':
            return `mail -s "%s" ${shq(f.to)}`;
        case 'webhook':
            return `curl -fsS --max-time 30 --retry 3 -H "Title: %s" --data-binary @- ${shq(f.url)}`;
        default:
            return '';
    }
};

/** Recognize a command made by notifyCommand, to show it as a form again. */
export const notifyParse = (cmd) => {
    if (!cmd) return { channel: '', fields: {} };
    const quoted = (re) => { const m = cmd.match(re); return m ? m[1].replace(/'\\''/g, "'") : ''; };
    if (/api\.telegram\.org\/bot/.test(cmd))
        return { channel: 'telegram', fields: { token: quoted(/api\.telegram\.org\/bot([^/']+)\/sendMessage/), chat: quoted(/chat_id=([0-9-]+)/) } };
    if (/discord(app)?\.com\/api\/webhooks/.test(cmd))
        return { channel: 'discord', fields: { url: quoted(/'(https:\/\/[^']+)'$/) } };
    if (/^mail -s/.test(cmd))
        return { channel: 'email', fields: { to: quoted(/'([^']+)'$/) } };
    if (/-H "Priority: %n"/.test(cmd)) {
        const url = quoted(/'(https?:\/\/[^']+)'$/);
        return { channel: 'ntfy', fields: { topic: url.replace(/^https:\/\/ntfy\.sh\//, '') } };
    }
    if (/^curl .*--data-binary @- '/.test(cmd))
        return { channel: 'webhook', fields: { url: quoted(/'(https?:\/\/[^']+)'$/) } };
    return { channel: 'custom', fields: { command: cmd } };
};

/* ------------------------------------------------------------------ */
/* tool outputs                                                        */
/* ------------------------------------------------------------------ */

/**
 * The files a check or a scrub complained about, from the messages of its task.
 * \return [{ path, problem }]
 */
export const damagedFiles = (task) => {
    const out = [];
    const seen = new Set();
    for (const m of task?.messages || []) {
        const t = m.text || '';
        const hit = t.match(/^(?:File|Data error in file|Error reading file|Unexpected .* in file) '([^']+)'(?:[ :,]+(.*))?$/) || t.match(/'([^']+)'.*(error|larger|smaller|missing|damaged)/i);
        if (hit && !seen.has(hit[1])) {
            seen.add(hit[1]);
            const problem = (hit[2] || '').replace(/\.$/, '');
            // a size or a time different from the last update is a change, not damage
            const changed = /larger|smaller|timestamp|time|size|missing/i.test(problem) && !/data error|damaged|unrecoverable/i.test(t);
            out.push({ path: hit[1], problem, kind: changed ? 'changed' : 'damaged' });
        }
    }
    return out;
};

/** What the self-test log of a disk says, in short. */
export const selfTestSummary = (text) => {
    const t = text || '';
    const running = t.match(/Self-test routine in progress[\s\S]*?(\d+)% of test remaining/);
    if (running) return { state: 'running', remaining: Number(running[1]), text: `Testing, ${100 - Number(running[1])}% done` };
    const line = t.split('\n').find(l => /^#\s*1\s/.test(l));
    if (!line) return { state: 'none', text: 'Never tested' };
    if (/Completed without error/.test(line)) return { state: 'ok', text: `Last test (${/Extended|long/i.test(line) ? 'long' : 'short'}) passed` };
    if (/in progress/i.test(line)) return { state: 'running', text: 'Testing' };
    if (/Aborted|Interrupted/i.test(line)) return { state: 'warn', text: 'Last test was interrupted' };
    return { state: 'bad', text: 'Last test found errors' };
};

/** Name a share from a folder: "/mnt/storage/My Movies" -> "My-Movies". */
export const shareNameOf = (path) => (path.split('/').filter(Boolean).pop() || 'share').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'share';

/** Addresses to open a share from the other computers. */
export const shareAddresses = (host, name) => ({ windows: `\\\\${host}\\${name}`, mac: `smb://${host}/${name}`, linux: `smb://${host}/${name}` });

/* ------------------------------------------------------------------ */
/* bays                                                                */
/* ------------------------------------------------------------------ */

/** The bay map with defaults: { rows, cols, slots: { diskId: bayIndex }, info: { diskId: { bought, note } } } */
export const bayDoc = (doc, diskCount) => {
    const d = doc && typeof doc === 'object' ? doc : {};
    const n = Math.max(1, diskCount);
    const cols = Number(d.cols) > 0 ? Math.min(12, Number(d.cols)) : Math.min(n, 4);
    const rows = Number(d.rows) > 0 ? Math.min(12, Number(d.rows)) : Math.ceil(n / cols);
    const slots = {};
    for (const [k, v] of Object.entries(d.slots || {})) {
        if (Number.isInteger(v) && v >= 0 && v < rows * cols) slots[k] = v;
    }
    return { rows, cols, slots, info: d.info && typeof d.info === 'object' ? d.info : {} };
};

/** Place a disk in a bay; a disk already there goes back to the unplaced ones. */
export const bayPlace = (doc, diskId, bay) => {
    const slots = { ...doc.slots };
    for (const [k, v] of Object.entries(slots)) if (v === bay) delete slots[k];
    if (bay == null) delete slots[diskId];
    else slots[diskId] = bay;
    return { ...doc, slots };
};

export const __test = { shq };

/* ------------------------------------------------------------------ */
/* alerts on more channels at once                                     */
/* ------------------------------------------------------------------ */

/** The address of an ntfy topic, as typed: a name, a host/name or a full address. */
export const ntfyUrl = (topic) => {
    const t = String(topic || '').trim();
    return /^https?:\/\//.test(t) ? t : t.includes('/') ? `https://${t}` : `https://ntfy.sh/${t}`;
};

/** A channel of the form as a line of the daemon: "kind=ntfy<TAB>url=https://…". */
export const alertLine = (channel, f) => {
    const v = (x) => String(x || '').trim();
    switch (channel) {
        case 'ntfy': return v(f.topic) ? `kind=ntfy\turl=${ntfyUrl(f.topic)}` : '';
        case 'discord': return v(f.url) ? `kind=discord\turl=${v(f.url)}` : '';
        case 'webhook': return v(f.url) ? `kind=webhook\turl=${v(f.url)}` : '';
        case 'telegram': return v(f.token) && v(f.chat) ? `kind=telegram\ttoken=${v(f.token)}\tchat=${v(f.chat).replace(/[^0-9-]/g, '')}` : '';
        case 'email': return v(f.to) ? `kind=email\tto=${v(f.to)}` : '';
        default: return '';
    }
};

/** A channel the daemon gives back ({ kind, url, token, chat, to }) as the form shows it. */
export const alertForm = (c) => {
    switch (c?.kind) {
        case 'ntfy': return { channel: 'ntfy', fields: { topic: String(c.url || '').replace(/^https:\/\/ntfy\.sh\//, '') } };
        case 'discord': case 'webhook': return { channel: c.kind, fields: { url: c.url || '' } };
        case 'telegram': return { channel: 'telegram', fields: { token: c.token || '', chat: c.chat || '' } };
        case 'email': return { channel: 'email', fields: { to: c.to || '' } };
        default: return null;
    }
};

/** The command of the reports is the script of the daemon that sends to more channels. */
export const isAlertScript = (cmd) => /\/snapraidd-alerts\.sh "%s" "%n" "%t"$/.test(String(cmd || ''));

/** What the Alerts page says about where the messages go. */
export const alertSummary = (list) => {
    const names = (list || []).map(x => {
        const def = CHANNELS[x.channel];
        if (!def) return 'a custom command';
        const f = x.fields || {};
        return x.channel === 'email' ? `email to ${f.to}` : x.channel === 'ntfy' ? `ntfy topic ${String(f.topic || '').split('/').pop()}` : def.label.replace(/ \(.*\)$/, '');
    });
    if (!names.length) return 'Messages go nowhere: problems show only on these pages.';
    if (names.length === 1) return `Messages go to ${names[0]}.`;
    return `Messages go to ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}, all of them every time.`;
};

/* ------------------------------------------------------------------ */
/* record of the runs                                                  */
/* ------------------------------------------------------------------ */

const RUN_TITLES = { sync: 'Protection updated', scrub: 'Checked for damage', fix: 'Repair', check: 'Full check' };

/** One run of the record in words: { title, detail, level: ok | warn | bad, problems } */
export const runWords = (r) => {
    const found = (r.errors_io || 0) + (r.errors_data || 0);
    const title = RUN_TITLES[r.command] || r.command;
    const bits = [];
    if (r.command === 'sync' && (r.added || r.removed || r.updated)) bits.push(`${[r.added ? `${r.added} added` : '', r.updated ? `${r.updated} changed` : '', r.removed ? `${r.removed} deleted` : ''].filter(Boolean).join(', ')}`);
    if (r.errors_data) bits.push(`${plural(r.errors_data, 'block with silent damage', 'blocks with silent damage')}`);
    if (r.errors_io) bits.push(`${plural(r.errors_io, 'read error', 'read errors')} of a disk`);
    if (r.recovered) bits.push(`${plural(r.recovered, 'error', 'errors')} repaired`);
    if (r.unrecoverable) bits.push(`${plural(r.unrecoverable, 'error', 'errors')} that could not be repaired`);
    if (r.result === 'stopped') return { title: `${title}: stopped`, detail: ['Stopped before the end, the next run goes on from there.', ...bits].join(' '), level: 'warn', problems: found };
    if (r.unrecoverable) return { title, detail: bits.join(', '), level: 'bad', problems: found };
    // a repair finds what it repairs: that is its success
    if (r.command === 'fix' && r.result !== 'error') return { title, detail: bits.length ? bits.join(', ') : 'Nothing needed a repair.', level: 'ok', problems: 0 };
    if (found) return { title: `${title}: problems found`, detail: `${bits.join(', ')}.${r.command === 'fix' ? '' : ' Use Repair on the Home page.'}`, level: 'bad', problems: found };
    if (r.result === 'error') return { title: `${title}: did not finish`, detail: bits.length ? bits.join(', ') : 'See every detail for the reason.', level: 'bad', problems: 0 };
    return { title, detail: bits.length ? bits.join(', ') : r.command === 'sync' ? 'Nothing had changed.' : 'No problem found.', level: 'ok', problems: 0 };
};

/** The sum of the record, in one sentence. */
export const runsSummary = (rec, nowIso) => {
    if (!rec?.total) return 'No run recorded yet.';
    const since = rec.since ? ` in ${humanSpan(secondsSince(rec.since, nowIso))}` : '';
    const head = `${plural(rec.total, 'run', 'runs')}${since}`;
    if (!rec.errors_found && !rec.errors_fixed && !rec.errors_lost) return `${head}, no damage found.`;
    return `${head}: ${plural(rec.errors_found, 'error', 'errors')} found, ${rec.errors_fixed} repaired${rec.errors_lost ? `, ${rec.errors_lost} that could not be repaired` : ''}.`;
};

/* ------------------------------------------------------------------ */
/* battery backup (UPS)                                                */
/* ------------------------------------------------------------------ */

/** The state of the UPS in words: { level, text } */
export const upsWords = (u) => {
    if (!u || !u.configured || u.state === 'off') return { level: 'tip', text: 'Not watched' };
    const left = [u.charge >= 0 ? `${u.charge}%` : '', u.runtime_seconds >= 0 ? `about ${humanSpan(u.runtime_seconds)} left` : ''].filter(Boolean).join(', ');
    switch (u.state) {
        case 'online': return { level: 'ok', text: `On the mains${left ? ` · battery ${left}` : ''}` };
        case 'battery': return { level: 'warn', text: `Power cut: on battery${left ? `, ${left}` : ''}` };
        case 'low': return { level: 'bad', text: `Battery low${left ? `: ${left}` : ''}` };
        default: return { level: 'bad', text: u.error || 'The UPS does not answer' };
    }
};

/** The name of a UPS for people: "labups" for nut:labups, "APC (apcupsd)" for apc. */
export const upsName = (id) => id === 'apc' ? 'APC (apcupsd)' : String(id || '').replace(/^nut:/, '');

/* ------------------------------------------------------------------ */
/* the tiles of Home                                                   */
/* ------------------------------------------------------------------ */

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/**
 * The last nights, one mark each, from the record of the runs of every array.
 * level: bad (a run failed or found damage it could not repair), warn (stopped),
 * checked (checked for damage), updated (protection updated), none.
 */
export const nightsStrip = (runs, now = new Date(), days = 14) => {
    const byDay = new Map();
    for (const r of runs || []) {
        const at = new Date(r.finished_at);
        if (Number.isNaN(at.getTime())) continue;
        const k = dayKey(at);
        const list = byDay.get(k) || [];
        list.push(r);
        byDay.set(k, list);
    }
    const out = [];
    for (let i = days - 1; i >= 0; --i) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const list = byDay.get(dayKey(d)) || [];
        const words = list.map(runWords);
        let level = 'none';
        if (words.some(w => w.level === 'bad')) level = 'bad';
        else if (words.some(w => w.level === 'warn')) level = 'warn';
        else if (list.some(r => r.command === 'scrub' || r.command === 'check')) level = 'checked';
        else if (list.length) level = 'updated';
        const text = list.length ? list.map(r => `${r.array}: ${runWords(r).title}`).join('; ') : 'Nothing ran';
        out.push({ day: d.getDate(), weekday: DAYS[d.getDay()].slice(0, 3), level, text, today: i === 0 });
    }
    return out;
};

/** When the space runs out, from the samples of the daemon: { level, text } */
export const forecastWords = (f) => {
    if (!f || !f.total_bytes) return { level: 'tip', text: 'No data disk measured yet.' };
    const free = Math.max(0, f.total_bytes - f.used_bytes);
    if (!f.forecast) return { level: 'tip', text: 'A forecast comes after a week of daily measures.' };
    const growth = f.growth_bytes_per_day || 0;
    if (growth <= 0 || f.days_to_full == null) return { level: 'ok', text: 'Not growing over the last 90 days.' };
    const daysLeft = f.days_to_full;
    const pace = `${bytes(growth * 30)} a month`;
    if (daysLeft < 45) return { level: daysLeft < 14 ? 'bad' : 'warn', text: `At ${pace}, full in about ${plural(Math.max(1, daysLeft), 'day', 'days')}.` };
    if (daysLeft < 730) return { level: daysLeft < 120 ? 'warn' : 'ok', text: `At ${pace}, full in about ${plural(Math.round(daysLeft / 30.4), 'month', 'months')}.` };
    return { level: 'ok', text: `At ${pace}, ${bytes(free)} last more than two years.` };
};

/** Percent of the data read back for damage in the last days, from the scrub history of an array. */
export const checkedWithin = (hist, days = 30) => {
    if (!hist?.points?.length) return null;
    let sum = 0;
    for (const p of hist.points) if (p.ago <= days) sum += p.scrubbed || 0;
    return Math.min(100, Math.round(sum));
};

/** The scrub history in five spans of age: [{ label, pct }] */
export const SCRUB_SPANS = [[0, 7, '0–7 days'], [8, 14, '8–14 days'], [15, 30, '15–30 days'], [31, 60, '31–60 days'], [61, Infinity, 'over 60 days']];
export const scrubAges = (hist) => {
    const out = SCRUB_SPANS.map(([lo, hi, label]) => ({ lo, hi, label, pct: 0 }));
    for (const p of hist?.points || []) {
        const span = out.find(s => p.ago >= s.lo && p.ago <= s.hi);
        if (span) span.pct += (p.scrubbed || 0) + (p.new || 0);
    }
    return out.map(s => ({ label: s.label, pct: Math.round(s.pct * 10) / 10 }));
};

/** A time to come, short: "Tonight 02:00", "Tomorrow 05:00", "Sat 04:30", "1 Dec 04:00" */
export const shortWhen = (date, now = new Date()) => {
    if (!date) return '';
    const days = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
    const t = hhmm({ hour: date.getHours(), minute: date.getMinutes() });
    if (days === 0) return `${date.getHours() >= 18 || date.getHours() < 5 ? 'Tonight' : 'Today'} ${t}`;
    if (days === 1) return `${date.getHours() < 5 ? 'Tonight' : 'Tomorrow'} ${t}`;
    if (days < 7) return `${DAYS[date.getDay()].slice(0, 3)} ${t}`;
    return `${date.getDate()} ${date.toLocaleString('en', { month: 'short' })} ${t}`;
};

/** What the server does by itself next, the soonest first: [{ at, what, sub }] */
export const comingUp = ({ config, host }, now = new Date(), max = 4) => {
    const list = [];
    const add = (when, what, sub) => {
        const at = nextRun(when, now);
        if (at) list.push({ at, what, sub });
    };
    if (config?.maintenance_schedule) {
        const pct = Number(config.scrub_percentage) || 0;
        add(config.maintenance_schedule, 'Update the protection', pct ? `then check ${pct}% of the data for damage` : 'of every array');
    }
    add(host?.smart_tests?.short, 'Short disk self-test', 'all the disks, a few minutes');
    add(host?.smart_tests?.long, 'Long disk self-test', 'all the disks, some hours');
    for (const b of host?.backups || []) if (b.enabled !== false && b.when) add(b.when, `Backup “${b.name}”`, b.source || '');
    for (const c of host?.caches || []) if (c.enabled !== false && c.when) add(c.when, 'Move from the fast disk', c.pool || '');
    return list.sort((a, b) => a.at - b.at).slice(0, max);
};

const EVENT_JOBS = {
    wipe: 'Disk erased', burnin: 'Write test of a disk', surface: 'Reading test of a disk', move: 'Files moved to other disks',
    empty: 'Disk emptied', mover: 'Files moved from the fast disk', copy: 'Copy', permissions: 'Permissions reset',
    format: 'Disk prepared', balance: 'Disks balanced', parity_move: 'Protection moved to a larger disk'
};

/** An event of the machine in words: { level, title, detail } */
export const eventWords = (e) => {
    const level = ['ok', 'info', 'warn', 'bad'].includes(e.level) ? (e.level === 'info' ? 'tip' : e.level) : 'tip';
    switch (e.kind) {
        case 'power_cut': return { level, title: 'Power cut', detail: e.text };
        case 'power_back': return { level, title: 'Power back', detail: e.text };
        case 'power_shutdown': return { level, title: 'Battery running out', detail: e.text };
        case 'idle': return { level, title: 'Went to sleep', detail: e.text };
        case 'usb_open': return { level, title: 'USB disk opened', detail: e.text ? `Its files are in ${e.text}` : '' };
        case 'usb_eject': return { level, title: `USB disk ${e.target} ejected`, detail: e.text };
        case 'backup': return { level, title: `Backup “${e.target}” ${level === 'ok' ? 'finished' : level === 'warn' ? 'did not copy everything' : 'failed'}`, detail: e.text };
        default: {
            const words = EVENT_JOBS[e.kind] || e.kind;
            return { level, title: level === 'ok' ? words : `${words}: ${level === 'warn' ? 'stopped' : 'failed'}`, detail: e.text };
        }
    }
};

/** Search of the palette: the items with every word of the query, the best first. */
export const paletteMatch = (items, query, max = 12) => {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return items.slice(0, max);
    const scored = [];
    for (const it of items) {
        const label = it.label.toLowerCase();
        const hay = `${label} ${(it.keys || '').toLowerCase()} ${(it.group || '').toLowerCase()}`;
        if (!words.every(w => hay.includes(w))) continue;
        let score = 0;
        if (label.startsWith(words[0])) score += 4;
        else if (label.split(/[^a-z0-9]+/).some(p => p.startsWith(words[0]))) score += 2;
        if (words.every(w => label.includes(w))) score += 1;
        scored.push({ it, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, max).map(x => x.it);
};
