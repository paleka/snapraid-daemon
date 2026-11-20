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

/* ------------------------------------------------------------------ */
/* fast disks, moves, sizes, the temperature limit and the tour        */
/* ------------------------------------------------------------------ */

test('fast disk: what waits on it, and what it does in words', () => {
    // counted by the daemon: the space a filesystem takes for itself is not files waiting
    assert.deepEqual(P.cacheWaiting({ total_bytes: 250e9, used_bytes: 60e6, waiting_files: 0, waiting_bytes: 0 }), { files: 0, bytes: 0, more: false });
    assert.deepEqual(P.cacheWaiting(null), { files: 0, bytes: 0, more: false });
    assert.equal(P.cacheWaitingWords({ waiting_files: 0 }), 'empty');
    assert.match(P.cacheWaitingWords({ waiting_files: 1, waiting_bytes: 5e6 }), /^1 file \(.*\) waiting$/);
    assert.match(P.cacheWaitingWords({ waiting_files: 6, waiting_bytes: 54e6 }), /^6 files \(.*\) waiting$/);
    assert.equal(P.cacheWaitingWords({ waiting_files: 2000, waiting_bytes: 1e9, waiting_more: true }), 'more than 2000 files waiting');
    assert.equal(P.cacheWords({ when: '03:00', age_hours: 0, fill: 70, sync: true }),
        'Every day at 03:00, every file is moved to the other disks; at once when it is more than 70% full. Then the protection is updated.');
    assert.match(P.cacheWords({ when: '03:00', age_hours: 24, fill: 0, sync: false }), /files not changed for 24 hours is moved to the other disks\.$/);
    assert.match(P.cacheWords({ when: '', fill: 0 }), /^Files are moved only when you press Move now/);
});

test('fast disk: what the home page tells', () => {
    const ok = { name: 'cache', when: '03:00', fill: 70, enabled: true, total_bytes: 100, free_bytes: 90, last_status: 0 };
    assert.deepEqual(P.cacheFindings({ caches: [ok] }), []);
    assert.equal(P.cacheFindings({ caches: [{ ...ok, last_status: 500, last_message: 'rsync failed' }] })[0].level, 'bad');
    // stopped by the person: not a failure
    assert.deepEqual(P.cacheFindings({ caches: [{ ...ok, last_status: 499 }] }), []);
    assert.match(P.cacheFindings({ caches: [{ ...ok, free_bytes: 2 }] })[0].title, /is full/);
    assert.match(P.cacheFindings({ caches: [{ ...ok, when: '', fill: 0 }] })[0].title, /never emptied/);
    assert.match(P.cacheFindings({ caches: [{ ...ok, enabled: false }] })[0].title, /never emptied/);
    assert.deepEqual(P.cacheFindings({}), []);
    // and they reach the list of the home page
    assert.ok(P.machineFindings({ host: { caches: [{ ...ok, free_bytes: 2 }], facts: {} }, config: { notify_result: 'x' }, disks: {} }).some(f => /fast disk/.test(f.title)));
});

test('moves and sizes: the result of the jobs in words', () => {
    assert.equal(P.moveWords({ success: true, files: 0, bytes: 0, skipped: 0 }), 'There was nothing to move.');
    assert.match(P.moveWords({ success: true, files: 12, bytes: 3e9, skipped: 0 }), /^12 files moved \(/);
    assert.match(P.moveWords({ success: true, files: 12, bytes: 3e9, skipped: 1 }), /1 file was left where it was/);
    assert.match(P.moveWords({ success: true, files: 1, bytes: 10, skipped: 3 }), /3 files were left where they were/);
    assert.equal(P.moveWords({ success: false, message: 'Stopped on request after 4 files.' }), 'Stopped on request after 4 files.');
    assert.deepEqual(P.usageRows({ result: [{ name: '/mnt/d1', value: '100 2' }, { name: '/mnt/d2', value: '900 7' }] }),
        [{ path: '/mnt/d2', bytes: 900, files: 7 }, { path: '/mnt/d1', bytes: 100, files: 2 }]);
    assert.deepEqual(P.usageRows(null), []);
});

test('temperature limit: found however the configuration was parsed', () => {
    assert.equal(P.confTempLimit([{ type: 'raw', raw: 'temp_limit 55' }]), '55');
    assert.equal(P.confTempLimit([{ type: 'raw', raw: '  temp_limit\t48  ' }]), '48');
    assert.equal(P.confTempLimit([{ type: 'option', key: 'temp_limit', value: '50' }]), '50');
    assert.equal(P.confTempLimit([{ type: 'raw', raw: '# temp_limit 55' }, { type: 'raw', raw: 'temp_sleep 3' }]), '');
    assert.equal(P.confTempLimit(null), '');
    // saving a new limit removes the old line, whichever form it had
    const conf = [{ type: 'raw', raw: 'temp_limit 55' }, { type: 'raw', raw: 'temp_sleep 3' }, { type: 'option', key: 'temp_limit', value: '50' }];
    assert.deepEqual(conf.filter(e => !P.isTempLimit(e)), [{ type: 'raw', raw: 'temp_sleep 3' }]);
});

test('tour and glossary: the new words are explained', () => {
    assert.ok(P.TOUR.length >= 4 && P.TOUR.every(s => s.title && s.text));
    assert.ok(P.TOUR.some(s => /Advanced/.test(s.title)));
    assert.ok(P.GLOSSARY['fast disk'] && P.GLOSSARY.mover);
});

test('folders kept on chosen disks: name and words', () => {
    assert.equal(P.keepName('/Photos'), 'Photos');
    assert.equal(P.keepName('/Media/My Films (HD)'), 'My-Films-HD');
    assert.equal(P.keepName('/Photos', ['Photos', 'Photos-2']), 'Photos-3');
    assert.equal(P.keepName('/'), 'folder');
    assert.ok(/^[A-Za-z0-9_-]{1,32}$/.test(P.keepName('/x/' + 'é'.repeat(10) + 'a'.repeat(60))));
    const keeps = [{ name: 'Photos', pool: '/mnt/storage', path: '/Photos', disks: '/mnt/d1', when: '04:00', enabled: true }];
    assert.equal(P.keepOf(keeps, '/mnt/storage', '/Photos').name, 'Photos');
    assert.equal(P.keepOf(keeps, '/mnt/other', '/Photos'), null);
    assert.equal(P.keepOf(null, '/mnt/storage', '/Photos'), null);
    assert.equal(P.keepWords(keeps[0]), 'Kept on d1. New files that land on another disk are brought back every day at 04:00.');
    assert.match(P.keepWords({ disks: '/mnt/d1:/mnt/d2:/mnt/d3', when: '04:00' }, (p) => p.slice(5).toUpperCase()), /^Kept on D1, D2 and D3\./);
    assert.match(P.keepWords({ disks: '/mnt/d1', when: '', enabled: true }), /use Tidy now/);
    assert.match(P.keepWords({ disks: '/mnt/d1', when: '04:00', enabled: false }), /use Tidy now/);
});

test('alerts on more channels: lines for the daemon and back', () => {
    assert.equal(P.alertLine('ntfy', { topic: 'my-topic' }), 'kind=ntfy\turl=https://ntfy.sh/my-topic');
    assert.equal(P.alertLine('ntfy', { topic: 'ntfy.home.lan/alerts' }), 'kind=ntfy\turl=https://ntfy.home.lan/alerts');
    assert.equal(P.alertLine('telegram', { token: ' 123:abc ', chat: '-100 200' }), 'kind=telegram\ttoken=123:abc\tchat=-100200');
    assert.equal(P.alertLine('telegram', { token: '123:abc', chat: '' }), '');
    assert.equal(P.alertLine('email', { to: 'me@example.com' }), 'kind=email\tto=me@example.com');
    assert.equal(P.alertLine('pigeon', { url: 'x' }), '');
    for (const [ch, f] of [['ntfy', { topic: 'my-topic' }], ['discord', { url: 'https://discord.com/api/webhooks/1/a' }], ['telegram', { token: '1:a', chat: '5' }], ['email', { to: 'a@b' }], ['webhook', { url: 'https://x.example/h' }]]) {
        const line = P.alertLine(ch, f);
        const back = Object.fromEntries(line.split('\t').map(x => x.split('=')));
        assert.deepEqual(P.alertForm(back), { channel: ch, fields: f });
    }
    assert.equal(P.alertForm({ kind: 'other' }), null);
    assert.ok(P.isAlertScript('/etc/snapraidd-alerts.sh "%s" "%n" "%t"'));
    assert.ok(!P.isAlertScript('curl https://x/snapraidd-alerts.sh'));
    assert.match(P.alertSummary([]), /nowhere/);
    assert.equal(P.alertSummary([{ channel: 'email', fields: { to: 'a@b' } }]), 'Messages go to email to a@b.');
    assert.match(P.alertSummary([{ channel: 'email', fields: { to: 'a@b' } }, { channel: 'ntfy', fields: { topic: 'x' } }, { channel: 'telegram', fields: {} }]), /^Messages go to email to a@b, ntfy topic x and Telegram, all of them every time\.$/);
});

test('record of the runs in words', () => {
    assert.deepEqual(P.runWords({ command: 'sync', result: 'ok', added: 3, removed: 1 }), { title: 'Protection updated', detail: '3 added, 1 deleted', level: 'ok', problems: 0 });
    assert.equal(P.runWords({ command: 'sync', result: 'ok' }).detail, 'Nothing had changed.');
    const bad = P.runWords({ command: 'scrub', result: 'error', errors_data: 2 });
    assert.equal(bad.level, 'bad');
    assert.equal(bad.problems, 2);
    assert.match(bad.detail, /2 blocks with silent damage.*Repair/);
    assert.equal(P.runWords({ command: 'fix', result: 'ok', recovered: 1 }).detail, '1 error repaired');
    assert.deepEqual(P.runWords({ command: 'fix', result: 'ok', errors_data: 1, recovered: 1 }), { title: 'Repair', detail: '1 block with silent damage, 1 error repaired', level: 'ok', problems: 0 });
    assert.equal(P.runWords({ command: 'fix', result: 'ok', recovered: 1, unrecoverable: 2 }).level, 'bad');
    assert.equal(P.runWords({ command: 'scrub', result: 'stopped' }).level, 'warn');
    assert.match(P.runWords({ command: 'sync', result: 'error' }).title, /did not finish/);
    assert.equal(P.runsSummary(null), 'No run recorded yet.');
    assert.equal(P.runsSummary({ total: 4, since: '2026-11-01T00:00:00', errors_found: 0 }, '2026-11-11T00:00:00'), '4 runs in 10 days, no damage found.');
    assert.equal(P.runsSummary({ total: 1, errors_found: 3, errors_fixed: 2, errors_lost: 1 }), '1 run: 3 errors found, 2 repaired, 1 that could not be repaired.');
});

test('battery backup in words', () => {
    assert.equal(P.upsWords(null).text, 'Not watched');
    assert.deepEqual(P.upsWords({ configured: true, state: 'online', charge: 100, runtime_seconds: 2400 }), { level: 'ok', text: 'On the mains · battery 100%, about 40 minutes left' });
    assert.equal(P.upsWords({ configured: true, state: 'battery', charge: 80, runtime_seconds: -1 }).text, 'Power cut: on battery, 80%');
    assert.equal(P.upsWords({ configured: true, state: 'low', charge: 9, runtime_seconds: 60 }).level, 'bad');
    assert.equal(P.upsWords({ configured: true, state: 'unknown', error: 'The UPS does not answer' }).text, 'The UPS does not answer');
    assert.equal(P.upsName('nut:labups@nas'), 'labups@nas');
    assert.equal(P.upsName('apc'), 'APC (apcupsd)');
});

/* ------------------------------------------------------------------ */
/* the tiles of Home                                                   */
/* ------------------------------------------------------------------ */

test('the last nights: one mark a day, the worst run of the day wins', () => {
    const now = new Date(2026, 10, 20, 15, 0);
    const at = (d, h) => new Date(2026, 10, d, h, 0).toISOString();
    const runs = [
        { finished_at: at(20, 2), array: 'media', command: 'sync', result: 'ok' },
        { finished_at: at(19, 2), array: 'media', command: 'sync', result: 'ok' },
        { finished_at: at(19, 4), array: 'media', command: 'scrub', result: 'ok' },
        { finished_at: at(18, 2), array: 'photos', command: 'sync', result: 'stopped' },
        { finished_at: at(18, 3), array: 'media', command: 'sync', result: 'ok' },
        { finished_at: at(17, 2), array: 'media', command: 'scrub', result: 'ok', errors_data: 2, unrecoverable: 1 },
        { finished_at: at(1, 2), array: 'media', command: 'sync', result: 'ok' }
    ];
    const n = P.nightsStrip(runs, now, 14);
    assert.equal(n.length, 14);
    assert.deepEqual(n.slice(-4).map(x => x.level), ['bad', 'warn', 'checked', 'updated']);
    assert.equal(n[13].today, true);
    assert.equal(n[13].day, 20);
    assert.equal(n[0].day, 7);
    assert.equal(n[0].level, 'none');
    assert.match(n[11].text, /photos: Protection updated: stopped/);
    assert.equal(P.nightsStrip(null, now, 3).length, 3);
});

test('the forecast of the space in words', () => {
    const TB = 1e12;
    assert.equal(P.forecastWords(null).level, 'tip');
    assert.match(P.forecastWords({ total_bytes: 48 * TB, used_bytes: 31.4 * TB, forecast: false }).text, /after a week/);
    assert.match(P.forecastWords({ total_bytes: 48 * TB, used_bytes: 31.4 * TB, forecast: true, growth_bytes_per_day: -1e9 }).text, /Not growing/);
    const year = P.forecastWords({ total_bytes: 48 * TB, used_bytes: 31.4 * TB, forecast: true, growth_bytes_per_day: 40e9, days_to_full: 415 });
    assert.equal(year.level, 'ok');
    assert.match(year.text, /full in about 14 months/);
    assert.match(year.text, /1\.2 TB a month/);
    const soon = P.forecastWords({ total_bytes: TB, used_bytes: 0.95 * TB, forecast: true, growth_bytes_per_day: 5e9, days_to_full: 10 });
    assert.equal(soon.level, 'bad');
    assert.match(soon.text, /about 10 days/);
    assert.equal(P.forecastWords({ total_bytes: TB, used_bytes: 0.5 * TB, forecast: true, growth_bytes_per_day: 5e9, days_to_full: 100 }).level, 'warn');
    assert.match(P.forecastWords({ total_bytes: TB, used_bytes: 0.1 * TB, forecast: true, growth_bytes_per_day: 1e6, days_to_full: 9000 }).text, /more than two years/);
});

test('how much was checked for damage, and how old the checks are', () => {
    const hist = { x_axis_low: 70, points: [{ ago: 70, scrubbed: 5, new: 0 }, { ago: 40, scrubbed: 20, new: 0 }, { ago: 20, scrubbed: 30, new: 5 }, { ago: 3, scrubbed: 30, new: 10 }] };
    assert.equal(P.checkedWithin(hist, 30), 60);
    assert.equal(P.checkedWithin(null), null);
    const ages = P.scrubAges(hist);
    assert.deepEqual(ages.map(a => a.pct), [40, 0, 35, 20, 5]);
    assert.equal(ages[4].label, 'over 60 days');
    assert.deepEqual(P.scrubAges(null).map(a => a.pct), [0, 0, 0, 0, 0]);
});

test('what comes next, the soonest first', () => {
    const now = new Date(2026, 10, 20, 15, 0); // a Friday
    const list = P.comingUp({
        config: { maintenance_schedule: '02:00', scrub_percentage: 8 },
        host: {
            smart_tests: { short: 'Sat 04:30', long: '' },
            backups: [{ name: 'Photos', when: '01:00', source: '/mnt/pool/photos' }, { name: 'Off', when: '01:30', enabled: false }],
            caches: [{ pool: '/mnt/pool', when: '03:00' }]
        }
    }, now, 4);
    assert.deepEqual(list.map(x => x.what), ['Backup “Photos”', 'Update the protection', 'Move from the fast disk', 'Short disk self-test']);
    assert.match(list[1].sub, /8%/);
    assert.equal(P.shortWhen(list[0].at, now), 'Tonight 01:00');
    assert.equal(P.shortWhen(list[3].at, now), 'Tonight 04:30');
    assert.equal(P.shortWhen(new Date(2026, 10, 21, 9, 0), now), 'Tomorrow 09:00');
    assert.equal(P.shortWhen(new Date(2026, 10, 20, 16, 0), now), 'Today 16:00');
    assert.equal(P.shortWhen(new Date(2026, 10, 23, 9, 0), now), 'Mon 09:00');
    assert.equal(P.shortWhen(new Date(2026, 11, 1, 4, 0), now), '1 Dec 04:00');
    assert.deepEqual(P.comingUp({ config: {}, host: {} }, now), []);
});

test('the events of the machine in words', () => {
    assert.deepEqual(P.eventWords({ level: 'warn', kind: 'power_cut', text: 'Running on the battery of the UPS, 90% charged' }).title, 'Power cut');
    const b = P.eventWords({ level: 'bad', kind: 'backup', target: 'Photos', text: 'The copy failed' });
    assert.equal(b.title, 'Backup “Photos” failed');
    assert.equal(b.level, 'bad');
    assert.equal(P.eventWords({ level: 'ok', kind: 'backup', target: 'Photos' }).title, 'Backup “Photos” finished');
    assert.equal(P.eventWords({ level: 'ok', kind: 'wipe', target: '/dev/sdk' }).title, 'Disk erased');
    assert.equal(P.eventWords({ level: 'warn', kind: 'mover', target: 'ssd' }).title, 'Files moved from the fast disk: stopped');
    assert.equal(P.eventWords({ level: 'info', kind: 'usb_eject', target: 'sdj' }).level, 'tip');
    assert.equal(P.eventWords({ level: 'odd', kind: 'something' }).title, 'something: failed');
});

test('the search finds by name and by the words behind it', () => {
    const items = [
        { group: 'Page', label: 'Disks', keys: 'smart bays fast disk' },
        { group: 'Page', label: 'Protection', keys: 'parity sync scrub schedule' },
        { group: 'Setting', label: 'Battery backup (UPS)', keys: 'ups nut apc' },
        { group: 'Share', label: 'photos', keys: '/mnt/pool/photos' },
        { group: 'Disk', label: 'parity', keys: 'protection /dev/sdb' }
    ];
    assert.deepEqual(P.paletteMatch(items, 'ups').map(x => x.label), ['Battery backup (UPS)']);
    // a word inside brackets starts a word too: the UPS comes before the Backups
    assert.deepEqual(P.paletteMatch([{ label: 'Backups' }, ...items], 'ups').map(x => x.label), ['Battery backup (UPS)', 'Backups']);
    assert.deepEqual(P.paletteMatch(items, 'PAR').map(x => x.label), ['parity', 'Protection']);
    assert.deepEqual(P.paletteMatch(items, 'pool photos').map(x => x.label), ['photos']);
    assert.equal(P.paletteMatch(items, '').length, 5);
    assert.equal(P.paletteMatch(items, '', 2).length, 2);
    assert.deepEqual(P.paletteMatch(items, 'nothing here'), []);
});
