// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Paleka

// Tests of the logic of the pages for everyday use: the headline of Home,
// schedules, task words, notifications, tool outputs and the bay map.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'plain-test-'));
writeFileSync(join(tmp, 'plain.mjs'), readFileSync(join(here, '..', '..', 'commander', 'js', 'plain.js'), 'utf8'));
const P = await import(pathToFileURL(join(tmp, 'plain.mjs')).href);

/* ------------------------------------------------------------------ */
/* schedules                                                           */
/* ------------------------------------------------------------------ */

test('schedules are read like the daemon reads them', () => {
    assert.deepEqual(P.parseSchedule('02:00, Sun 05:00'), [{ day: -1, nth: 0, hour: 2, minute: 0 }, { day: 0, nth: 0, hour: 5, minute: 0 }]);
    assert.deepEqual(P.parseSchedule('Sat#1 04:30'), [{ day: 6, nth: 1, hour: 4, minute: 30 }]);
    assert.deepEqual(P.parseSchedule('25:00, Funday 01:00, 1:00, '), []);
    assert.equal(P.formatSchedule(P.parseSchedule('02:00,sun 05:00, Sat#1 04:30')), '02:00, Sun 05:00, Sat#1 04:30');
});

test('schedules are said in words', () => {
    assert.equal(P.describeSchedule(''), 'never');
    assert.equal(P.describeSchedule('02:00'), 'every day at 02:00');
    assert.equal(P.describeSchedule('02:00, Sun 05:00'), 'every day at 02:00 and every Sunday at 05:00');
    assert.equal(P.describeSchedule('Sat#1 04:30'), 'the first Saturday of every month at 04:30');
});

test('the next run of a schedule', () => {
    const now = new Date(2026, 10, 19, 21, 0); // Thursday 19 November 2026, 21:00
    assert.equal(P.nextRun('02:00', now).getTime(), new Date(2026, 10, 20, 2, 0).getTime());
    assert.equal(P.nextRun('22:00', now).getTime(), new Date(2026, 10, 19, 22, 0).getTime());
    assert.equal(P.nextRun('Sun 05:00', now).getTime(), new Date(2026, 10, 22, 5, 0).getTime());
    assert.equal(P.nextRun('Sun#1 04:00', now).getTime(), new Date(2026, 11, 6, 4, 0).getTime());
    assert.equal(P.nextRun('', now), null);
    assert.equal(P.whenWords(new Date(2026, 10, 20, 2, 0), now), 'tonight at 02:00');
    assert.equal(P.whenWords(new Date(2026, 10, 20, 9, 0), now), 'tomorrow at 09:00');
    assert.equal(P.whenWords(new Date(2026, 10, 22, 5, 0), now), 'on Sunday at 05:00');
});

test('time spans in words', () => {
    assert.equal(P.humanSpan(30), '30 seconds');
    assert.equal(P.humanSpan(60), '60 seconds');
    assert.equal(P.humanSpan(3600), '60 minutes');
    assert.equal(P.humanSpan(7200), '2 hours');
    assert.equal(P.humanSpan(3 * 86400), '3 days');
    assert.equal(P.bytes(1.5e12), '1.5 TB');
    assert.equal(P.bytes(512), '512 B');
});

/* ------------------------------------------------------------------ */
/* the headline                                                        */
/* ------------------------------------------------------------------ */

const NOW = '2026-11-19T21:00:00';
const base = (over = {}) => ({
    configured: true, health: 'passed', active: null, diskProblems: 0,
    array: { pulse: { current_at: NOW }, blocks_count: 100, blocks_unsynced: 0, blocks_bad: 0 },
    tasks: { history: [{ command: 'sync', status: 'terminated', exit_code: 0, finished_at: '2026-11-19T02:30:00' }] },
    config: { maintenance_schedule: '02:00' },
    now: new Date(2026, 10, 19, 21, 0),
    ...over
});

test('home: everything fine', () => {
    const s = P.homeStatus(base());
    assert.equal(s.level, 'ok');
    assert.equal(s.title, 'Your files are safe');
    assert.match(s.text, /Protected 19 hours ago/);
    assert.match(s.text, /tonight at 02:00/);
    assert.equal(s.action, null);
});

test('home: changes waiting offer to protect them', () => {
    const s = P.homeStatus(base({ array: { ...base().array, diff_added: 3, diff_updated: 2 } }));
    assert.equal(s.level, 'ok');
    assert.match(s.text, /5 files changed since then/);
    assert.equal(s.action.act, 'protect');
});

test('home: the most serious state wins', () => {
    assert.equal(P.homeStatus(base({ configured: false })).level, 'setup');
    assert.equal(P.homeStatus(base({ health: 'failing', healthReason: 'Disk d2 fails.' })).action.act, 'drives');
    assert.equal(P.homeStatus(base({ health: 'degraded' })).action.act, 'recover');
    assert.equal(P.homeStatus(base({ array: { ...base().array, blocks_bad: 4 } })).action.act, 'heal');
    // a failing disk is more important than the work in progress
    assert.equal(P.homeStatus(base({ health: 'failing', active: { command: 'sync', progress: 10 } })).level, 'bad');
    const busy = P.homeStatus(base({ active: { command: 'scrub', progress: 40, eta_seconds: 600 } }));
    assert.equal(busy.level, 'busy');
    assert.match(busy.title, /Checking for damage/);
    assert.match(busy.text, /40% done, about 10 minutes left/);
});

test('home: old, never or off', () => {
    const old = P.homeStatus(base({ tasks: { history: [{ command: 'sync', status: 'terminated', exit_code: 0, finished_at: '2026-11-10T02:30:00' }] } }));
    assert.equal(old.level, 'warn');
    assert.match(old.title, /getting old/);
    const never = P.homeStatus(base({ tasks: { history: [] }, array: { ...base().array, blocks_unsynced: 100 } }));
    assert.match(never.title, /not protected yet/);
    // the task history was cleaned: not "never"
    assert.equal(P.homeStatus(base({ tasks: { history: [] } })).level, 'ok');
    const off = P.homeStatus(base({ config: { maintenance_schedule: '' } }));
    assert.equal(off.action.act, 'protection');
});

test('home: a sync stopped by the safety check waits for the OK', () => {
    const tasks = { history: [{ command: 'sync', status: 'terminated', exit_code: 2, finished_at: '2026-11-19T02:30:00', messages: [{ level: 'fatal', text: 'Too many files were removed (61, limit is 50). Sync aborted.' }] }] };
    assert.deepEqual(P.blockedSync(tasks), { what: 'removed', count: 61, limit: 50, at: '2026-11-19T02:30:00' });
    const s = P.homeStatus(base({ tasks }));
    assert.equal(s.title, 'The protection waits for your OK');
    assert.match(s.text, /61 files were deleted/);
    // once a sync works again, nothing waits
    tasks.history.unshift({ command: 'sync', status: 'terminated', exit_code: 0, finished_at: '2026-11-19T03:00:00' });
    assert.equal(P.blockedSync(tasks), null);
});

/* ------------------------------------------------------------------ */
/* tasks                                                               */
/* ------------------------------------------------------------------ */

test('tasks in words', () => {
    assert.deepEqual(P.taskWords({ command: 'sync', status: 'terminated', exit_code: 0 }), { title: 'Protection updated', detail: 'The newest files can now be rebuilt too.', ok: true });
    const scrubSkipped = P.taskWords({ command: 'scrub', status: 'canceled', messages: [{ text: 'The preceding sync operation failed with exit code 2' }] });
    assert.equal(scrubSkipped.title, 'Checked for damage: skipped');
    assert.match(scrubSkipped.detail, /did not finish/);
    const empty = P.taskWords({ command: 'sync', status: 'terminated', exit_code: 1, messages: [{ level: 'fatal', text: "If you want to 'sync' anyway, use 'snapraid --force-empty sync'." }] });
    assert.match(empty.detail, /may not be mounted/);
    const soft = P.taskWords({ command: 'check', status: 'terminated', exit_code: 1, messages: [{ level: 'fatal', text: 'WARNING! There are soft errors!' }] });
    assert.equal(soft.ok, true);
    assert.match(soft.title, /changes found/);
    const stopped = P.taskWords({ command: 'scrub', status: 'terminated', exit_code: 1, messages: [{ level: 'error', text: 'Stop requested' }] });
    assert.match(stopped.detail, /continues from there/);
    assert.equal(P.pendingChanges({ diff_added: 1, diff_removed: 2, diff_updated: 3, diff_moved: 4, diff_equal: 100 }), 10);
});

/* ------------------------------------------------------------------ */
/* findings of the machine                                             */
/* ------------------------------------------------------------------ */

test('machine findings', () => {
    const host = { facts: { root_free_bytes: 1e8, root_total_bytes: 1e11, clock_synchronized: true }, backups: [{ name: 'photos', last_status: 500, last_message: 'disk full' }], shares: [], smart_tests: {}, tools: {} };
    const f = P.machineFindings({ host, config: { notify_result: '' }, disks: { data_disks: [{ name: 'd1', devices: [{ smart: { temperature_status: 'critical', temperature_celsius: 61 } }] }] } });
    assert.deepEqual(f.map(x => x.level), ['bad', 'bad', 'bad', 'warn', 'tip']);
    assert.ok(f.some(x => /system disk is almost full/.test(x.title)));
    assert.ok(f.some(x => /photos.*failed/.test(x.title)));
    assert.ok(f.some(x => /d1 is too hot/.test(x.title)));
    assert.ok(f.some(x => /Nobody is told/.test(x.title)));
    const quiet = P.machineFindings({ host: { facts: {}, backups: [{ name: 'a', last_status: 0 }], shares: [], smart_tests: { short: 'Sun 03:00' }, tools: {} }, config: { notify_result: 'x' }, disks: {} });
    assert.deepEqual(quiet, []);
});

/* ------------------------------------------------------------------ */
/* notifications                                                       */
/* ------------------------------------------------------------------ */

test('notification commands go and come back', () => {
    const cases = [
        ['ntfy', { topic: 'my-topic' }],
        ['ntfy', { topic: 'https://ntfy.example.com/x' }],
        ['discord', { url: 'https://discord.com/api/webhooks/1/abc' }],
        ['telegram', { token: '123:ABC', chat: '-100200' }],
        ['email', { to: 'me@example.com' }],
        ['webhook', { url: 'https://hooks.example.com/in' }]
    ];
    for (const [ch, f] of cases) {
        const cmd = P.notifyCommand(ch, f);
        assert.ok(cmd.length > 10, ch);
        const back = P.notifyParse(cmd);
        assert.equal(back.channel, ch, cmd);
        assert.deepEqual(back.fields, f, cmd);
    }
    assert.match(P.notifyCommand('ntfy', { topic: 'abc' }), /'https:\/\/ntfy\.sh\/abc'$/);
    assert.deepEqual(P.notifyParse('/usr/local/bin/my-script %s'), { channel: 'custom', fields: { command: '/usr/local/bin/my-script %s' } });
    assert.deepEqual(P.notifyParse(''), { channel: '', fields: {} });
    // a quote in a field cannot leave its quoting
    assert.match(P.notifyCommand('email', { to: "a'; rm -rf /'" }), /^mail -s "%s" 'a'\\''; rm -rf \/'\\'''$/);
});

/* ------------------------------------------------------------------ */
/* tool outputs                                                        */
/* ------------------------------------------------------------------ */

test('damaged and changed files of a check', () => {
    const task = { messages: [
        { level: 'error', text: "File '/mnt/lab/d4/Music/a.flac' is larger than expected." },
        { level: 'error', text: "Data error in file '/mnt/lab/d1/Photos/b.jpg' at position '7'" },
        { level: 'error', text: "File '/mnt/lab/d4/Music/a.flac' is larger than expected." },
        { level: 'info', text: 'Everything OK' }
    ] };
    const r = P.damagedFiles(task);
    assert.equal(r.length, 2);
    assert.equal(r[0].kind, 'changed');
    assert.equal(r[1].path, '/mnt/lab/d1/Photos/b.jpg');
    assert.equal(r[1].kind, 'damaged');
});

test('self-test logs', () => {
    assert.equal(P.selfTestSummary('No self-tests have been logged.').state, 'none');
    assert.equal(P.selfTestSummary('Self-test execution status:      ( 249)\tSelf-test routine in progress...\n\t\t\t\t\t70% of test remaining.').remaining, 70);
    assert.equal(P.selfTestSummary('Num  Test_Description\n# 1  Short offline       Completed without error       00%      5400         -').state, 'ok');
    assert.equal(P.selfTestSummary('# 1  Extended offline    Completed: read failure       90%      5400         123456').state, 'bad');
    assert.equal(P.selfTestSummary('# 1  Short offline       Aborted by host               10%      5400         -').state, 'warn');
});

test('shares', () => {
    assert.equal(P.shareNameOf('/mnt/storage/My Movies'), 'My-Movies');
    assert.equal(P.shareNameOf('/mnt/storage/'), 'storage');
    assert.equal(P.shareNameOf('/mnt/x/Fotos à la mer!'), 'Fotos-la-mer');
    assert.deepEqual(P.shareAddresses('nas', 'Media'), { windows: '\\\\nas\\Media', mac: 'smb://nas/Media', linux: 'smb://nas/Media' });
});

/* ------------------------------------------------------------------ */
/* bays                                                                */
/* ------------------------------------------------------------------ */

test('bay map', () => {
    const d = P.bayDoc(null, 6);
    assert.equal(d.cols, 4);
    assert.equal(d.rows, 2);
    const kept = P.bayDoc({ rows: 1, cols: 2, slots: { a: 0, b: 1, c: 5, e: -1, f: 1.5 } }, 6);
    assert.deepEqual(kept.slots, { a: 0, b: 1 });
    // a disk placed where another is sends the other back
    const moved = P.bayPlace(kept, 'c', 0);
    assert.deepEqual(moved.slots, { b: 1, c: 0 });
    assert.deepEqual(P.bayPlace(moved, 'c', null).slots, { b: 1 });
});

test('home: the deleted files are back, only the update is missing', () => {
    const tasks = { history: [{ command: 'sync', status: 'terminated', exit_code: 2, finished_at: '2026-11-19T02:30:00', messages: [{ level: 'fatal', text: 'Too many files were removed (61, limit is 50). Sync aborted.' }] }] };
    const s = P.homeStatus(base({ tasks, array: { ...base().array, diff_removed: 3 } }));
    assert.equal(s.title, 'Update the protection now');
    assert.equal(s.action.act, 'protect');
    assert.equal(P.taskWords(tasks.history[0]).title, 'Protection update paused');
    assert.match(P.taskWords({ command: 'fix', status: 'terminated', exit_code: 1, messages: [{ level: 'fatal', text: 'DANGER! Unrecoverable errors detected!' }] }).detail, /could not be rebuilt/);
});
