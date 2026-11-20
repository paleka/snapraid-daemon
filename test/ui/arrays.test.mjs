// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Paleka

// Tests of the logic of more arrays in the web interface: what the Arrays
// page shows, the plan that moves a disk between two arrays, and how the
// Storage page of an array treats the disks and the pools of the others.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'arrays-test-'));
for (const name of ['arrays', 'storage', 'api', 'utils']) {
    const src = readFileSync(join(here, '..', '..', 'commander', 'js', `${name}.js`), 'utf8');
    writeFileSync(join(tmp, `${name}.mjs`), src.replace(/from '\.\/(\w+)\.js'/g, "from './$1.mjs'"));
}
const { __test: A } = await import(pathToFileURL(join(tmp, 'arrays.mjs')).href);
const { __test: S } = await import(pathToFileURL(join(tmp, 'storage.mjs')).href);
const { API } = await import(pathToFileURL(join(tmp, 'api.mjs')).href);

const GB = 1e9;

test('the three themes ship the same code', () => {
    const names = readdirSync(join(here, '..', '..', 'commander', 'js')).sort();
    for (const theme of ['brutale', 'quiet']) {
        assert.deepEqual(readdirSync(join(here, '..', '..', theme, 'js')).sort(), names, theme);
        names.forEach(n => assert.equal(
            readFileSync(join(here, '..', '..', theme, 'js', n), 'utf8'),
            readFileSync(join(here, '..', '..', 'commander', 'js', n), 'utf8'), `${theme}/js/${n}`));
    }
});

test('the three themes share the pages for everyday use, and Quiet the layout of Commander', () => {
    const css = (theme, name) => readFileSync(join(here, '..', '..', theme, 'css', name), 'utf8');
    for (const theme of ['brutale', 'quiet']) assert.equal(css(theme, 'simple.css'), css('commander', 'simple.css'), theme);
    assert.equal(css('quiet', 'style.css'), css('commander', 'style.css'));
});

test('Quiet follows the light or dark of the computer, the others start light', () => {
    const html = (theme) => readFileSync(join(here, '..', '..', theme, 'index.html'), 'utf8');
    assert.match(html('quiet'), /data-theme-default="system"/);
    assert.doesNotMatch(html('commander'), /data-theme-default/);
    assert.doesNotMatch(html('brutale'), /data-theme-default/);
    // every file of the theme is in the package
    const make = readFileSync(join(here, '..', '..', 'Makefile.am'), 'utf8');
    for (const f of ['css/quiet.css', 'css/fonts/Inter-400.woff2', 'css/fonts/OFL-Inter']) assert.match(make, new RegExp(`quiet/${f.replace(/\./g, '\\.')}`));
});

/* ------------------------------------------------------------------ */
/* addresses                                                           */
/* ------------------------------------------------------------------ */

test('the default array keeps the addresses it always had', () => {
    API.setArray('default');
    assert.equal(API.base(), '/snapraid/v1');
    assert.equal(API.array(), 'default');
    API.setArray('media');
    assert.equal(API.base(), '/snapraid/v1/arrays/media');
    API.setArray('');
    assert.equal(API.array(), 'default');
});

/* ------------------------------------------------------------------ */
/* overall health                                                      */
/* ------------------------------------------------------------------ */

test('the overall health is the worst one of the arrays set up', () => {
    const a = (health, configured = true) => ({ health, configured });
    assert.equal(A.overallHealth([a('passed'), a('passed')]), 'passed');
    assert.equal(A.overallHealth([a('passed'), a('degraded')]), 'degraded');
    assert.equal(A.overallHealth([a('degraded'), a('failing'), a('prefail')]), 'failing');
    assert.equal(A.overallHealth([a('corrupt'), a('passed')]), 'corrupt');
    // an array still to set up doesn't make the machine look bad
    assert.equal(A.overallHealth([a('passed'), a('pending', false)]), 'passed');
    assert.equal(A.overallHealth([a('pending', false)]), 'pending');
    assert.equal(A.overallHealth([]), 'pending');
    // a configured array whose state is not yet known counts
    assert.equal(A.overallHealth([a('pending', true)]), 'pending');
});

/* ------------------------------------------------------------------ */
/* separate mounts                                                     */
/* ------------------------------------------------------------------ */

const mnt = (source, target, fstype = 'ext4', extra = {}) => ({ source, target, fstype, options: 'rw,noatime', is_dir: true, total_bytes: 100 * GB, free_bytes: 40 * GB, ...extra });

test('separate mounts are the filesystems of no array and of no system', () => {
    const inv = {
        pools: [{ mountpoint: '/mnt/scratch', branches: [{ path: '/mnt/x1/' }] }],
        mounts: [
            mnt('/dev/sda2', '/'), mnt('/dev/sda1', '/boot/efi', 'vfat'),
            mnt('/dev/sda2', '/etc/hosts', 'ext4', { is_dir: false }),
            mnt('/dev/sda2', '/srv/bind'),                         // the system disk seen again somewhere else
            mnt('/dev/sdb1', '/mnt/d1', 'ext4', { array: 'default', role: 'data', disk: 'd1' }),
            mnt('/dev/sdc1', '/mnt/p1', 'ext4', { array: 'media', role: 'parity', disk: 'parity' }),
            mnt('/dev/sdd1', '/mnt/apps'),
            mnt('/dev/sde1', '/mnt/x1'),
            mnt('nas:/export', '/mnt/nas', 'nfs4'),
            mnt('//nas/share', '/mnt/smb', 'cifs'),
            mnt('tmpfs', '/run', 'tmpfs'),
            mnt('/dev/sdf1', '/mnt/image', 'ext4', { options: 'ro,relatime' }),
            mnt('/dev/sdg1', '/mnt/rodeo', 'ext4', { options: 'rw,errors=remount-ro' }),
            mnt('mergerfs', '/mnt/scratch', 'fuse.mergerfs'),
            mnt('/dev/sdh1', '/mnt/snapraid-removed/d9'),
            mnt('/dev/sdd1', '/mnt/apps')                          // listed twice
        ]
    };
    const list = A.separateMounts(inv);
    assert.deepEqual(list.map(m => m.target), ['/mnt/apps', '/mnt/x1', '/mnt/nas', '/mnt/smb', '/mnt/rodeo']);
    assert.deepEqual(list.map(m => m.network), [false, false, true, true, false]);
    assert.deepEqual(list.map(m => m.inPool), [false, true, false, false, false]);
    assert.deepEqual(A.separateMounts({}), []);
});

/* ------------------------------------------------------------------ */
/* moving a disk                                                       */
/* ------------------------------------------------------------------ */

const FROM = ['# the first', 'parity /mnt/p1/snapraid.parity', 'content /var/snapraid.content', 'content /mnt/d1/snapraid.content', 'content /mnt/d2/snapraid.content',
    'data d1 /mnt/d1', 'data d2 /mnt/d2/', 'data d3 /mnt/d3', 'exclude *.tmp', 'autosave 500', ''].join('\n');
const TO = ['# the second', 'parity /mnt/p2/snapraid.parity', 'content /var/media.content', 'data m1 /mnt/m1', 'exclude /lost+found/', ''].join('\n');

test('a disk moves with its files: parked, dropped, then added', () => {
    const p = A.planMoveDisk('default', FROM, TO, 'd2', 'm2');
    assert.equal(p.error, undefined);
    assert.equal(p.placeholder, '/mnt/snapraid-removed/d2');
    assert.equal(p.path, '/mnt/d2');
    assert.equal(p.name, 'm2');
    // first the array forgets the disk keeping its place, and the content file that was on it
    assert.match(p.parked, /^data d2 \/mnt\/snapraid-removed\/d2$/m);
    assert.doesNotMatch(p.parked, /content \/mnt\/d2/);
    assert.match(p.parked, /^content \/mnt\/d1\/snapraid\.content$/m);
    assert.match(p.parked, /^data d1 \/mnt\/d1$/m);
    // then the line goes
    assert.doesNotMatch(p.dropped, /data d2/);
    assert.match(p.dropped, /^data d3 \/mnt\/d3$/m);
    // comments, rules and options survive
    for (const text of [p.parked, p.dropped]) {
        assert.match(text, /^# the first$/m);
        assert.match(text, /^exclude \*\.tmp$/m);
        assert.match(text, /^autosave 500$/m);
        assert.match(text, /^parity \/mnt\/p1\/snapraid\.parity$/m);
    }
    // the other array gets it after its own data disks, and nothing else changes there
    assert.equal(p.added, ['# the second', 'parity /mnt/p2/snapraid.parity', 'content /var/media.content', 'data m1 /mnt/m1', 'data m2 /mnt/d2', 'exclude /lost+found/', ''].join('\n'));
});

test('the stand-in folder of a named array cannot clash with the one of another', () => {
    assert.equal(A.planMoveDisk('media', FROM, TO, 'd2', 'x').placeholder, '/mnt/snapraid-removed/media-d2');
});

test('a move that would break an array is refused before anything is touched', () => {
    const err = (...args) => A.planMoveDisk(...args).error || '';
    assert.match(err('default', FROM, TO, 'd9', 'm2'), /no data disk d9/);
    assert.match(err('default', FROM, TO, 'd2', 'm1'), /already has a disk named m1/);
    assert.match(err('default', FROM, TO, 'd2', 'bad name'), /letters, digits/);
    assert.match(err('default', FROM, TO, 'd2', ''), /letters, digits/);
    assert.match(err('default', FROM, 'content /var/x.content\ndata m1 /mnt/m1\n', 'd2', 'm2'), /no parity yet/);
    assert.match(err('default', 'parity /mnt/p1/a.parity\ncontent /var/a.content\ncontent /mnt/p1/a.content\ndata only /mnt/d1\n', TO, 'only', 'm2'), /only data disk/);
    assert.match(err('default', FROM.replace('data d2 /mnt/d2/', 'data d2 /mnt/snapraid-removed/d2'), TO, 'd2', 'm2'), /already being removed/);
    // one parity needs two content files: taking the disk holding one of two is refused
    const tight = 'parity /mnt/p1/a.parity\ncontent /var/a.content\ncontent /mnt/d2/a.content\ndata d1 /mnt/d1\ndata d2 /mnt/d2\n';
    assert.match(err('default', tight, TO, 'd2', 'm2'), /left with 1: it needs 2/);
    assert.equal(err('default', tight, TO, 'd1', 'm2'), '');
});

/* ------------------------------------------------------------------ */
/* the Storage page of one array among others                          */
/* ------------------------------------------------------------------ */

const TB = 1e12;
const disk = (name, mount, extra = {}) => ({
    node: { name, path: `/dev/${name}`, type: 'disk', size: 4 * TB, ro: false, rm: false, rota: true, tran: 'sata', model: 'TEST', serial: `S-${name}`,
        children: mount ? [{ name: `${name}1`, path: `/dev/${name}1`, type: 'part', size: 4 * TB, fstype: 'ext4', uuid: `u-${name}` }] : undefined },
    mount: mount ? { source: `/dev/${name}1`, target: mount, fstype: 'ext4', options: 'rw', is_dir: true, total_bytes: 3.7 * TB, free_bytes: 2 * TB, ...extra } : null
});

/** Two arrays, three pools: the inventory as the daemon gives it for the array asked. */
const twoArrays = (array) => {
    const disks = [
        disk('sdb', '/mnt/d1', { array: 'default', role: 'data', disk: 'd1' }),
        disk('sdc', '/mnt/d2', { array: 'default', role: 'data', disk: 'd2' }),
        disk('sdd', '/mnt/p1', { array: 'default', role: 'parity', disk: 'parity' }),
        disk('sde', '/mnt/m1', { array: 'media', role: 'data', disk: 'm1' }),
        disk('sdf', '/mnt/m2', { array: 'media', role: 'data', disk: 'm2' }),
        disk('sdg', '/mnt/q1', { array: 'media', role: 'parity', disk: 'parity' }),
        disk('sdh', '/mnt/x1'),
        disk('sdi', null)
    ];
    const br = (path, owner, name) => ({ path, mode: 'RW', total_bytes: 3.7 * TB, free_bytes: 2 * TB, ...(owner ? { array: owner, role: 'data', disk: name } : {}), protected: !!owner });
    const pl = (mountpoint, branches) => ({ mountpoint, persistent: true, version: '2.40.2', fstab_options: 'category.create=pfrd', options: { 'category.create': 'pfrd' }, branches, total_bytes: 1, free_bytes: 1 });
    const confs = {
        default: 'parity /mnt/p1/snapraid.parity\ncontent /var/snapraid.content\ncontent /mnt/d1/snapraid.content\ndata d1 /mnt/d1\ndata d2 /mnt/d2\n',
        media: 'parity /mnt/q1/snapraid.parity\ncontent /var/media.content\ncontent /mnt/m1/snapraid.content\ndata m1 /mnt/m1\ndata m2 /mnt/m2\n'
    };
    return {
        admin: true, supported: true, array,
        tools: { lsblk: true, sfdisk: true, mkfs_ext4: true, mergerfs: true, rsync: true },
        engine_conf: { path: array === 'default' ? '/etc/snapraid.conf' : `/etc/snapraid/${array}.conf`, exists: true, text: confs[array] },
        lsblk: { blockdevices: [{ name: 'sda', path: '/dev/sda', type: 'disk', size: 100 * GB, children: [{ name: 'sda1', path: '/dev/sda1', type: 'part', size: 100 * GB, fstype: 'ext4' }] }, ...disks.map(d => d.node)] },
        blkid: [], fstab: [],
        mounts: [{ source: '/dev/sda1', target: '/', fstype: 'ext4', options: 'rw', is_dir: true, total_bytes: 100 * GB, free_bytes: 50 * GB }, ...disks.map(d => d.mount).filter(Boolean)],
        pools: [
            pl('/mnt/storage', [br('/mnt/d1', 'default', 'd1'), br('/mnt/d2', 'default', 'd2')]),
            pl('/mnt/media', [br('/mnt/m1', 'media', 'm1'), br('/mnt/m2', 'media', 'm2')]),
            pl('/mnt/scratch', [br('/mnt/x1')])
        ]
    };
};

test('the disks of another array are not free to take', () => {
    const m = S.buildModel(twoArrays('media'));
    const st = Object.fromEntries(m.disks.map(d => [d.name, d.state]));
    assert.deepEqual(st, { sda: 'system', sdb: 'foreign', sdc: 'foreign', sdd: 'foreign', sde: 'array', sdf: 'array', sdg: 'array', sdh: 'mounted', sdi: 'blank' });
    assert.equal(m.disks.find(d => d.name === 'sdb').owner, 'default');
    // the guided setup offers only what belongs to nobody: every array draws from the same spares
    assert.deepEqual(S.candidates(m).map(c => c.id), ['/dev/sdh1', '/dev/sdi']);
    assert.deepEqual(S.candidates(S.buildModel(twoArrays('default'))).map(c => c.id), ['/dev/sdh1', '/dev/sdi']);
});

test('every array has its own pool, shown first', () => {
    const m = S.buildModel(twoArrays('media'));
    assert.equal(m.array, 'media');
    assert.equal(m.pool.mountpoint, '/mnt/media');
    assert.deepEqual(m.pools.map(p => p.mountpoint), ['/mnt/media', '/mnt/storage', '/mnt/scratch']);
    const d = S.buildModel(twoArrays('default'));
    assert.equal(d.pool.mountpoint, '/mnt/storage');
    assert.equal(d.pools[0].mountpoint, '/mnt/storage');
    // the layout of an array shows its pool only
    Object.assign(S.state, { health: {} });
    assert.deepEqual(S.layoutOf(m).pools.map(p => p.mountpoint), ['/mnt/media']);
    assert.deepEqual(S.layoutOf(d).pools.map(p => p.mountpoint), ['/mnt/storage']);
});

test('a new pool gets a folder nobody uses', () => {
    assert.equal(S.buildModel(twoArrays('default')).poolDefault, '/mnt/storage2');
    assert.equal(S.buildModel(twoArrays('media')).poolDefault, '/mnt/storage-media');
    const inv = twoArrays('media');
    inv.pools.push({ ...inv.pools[2], mountpoint: '/mnt/storage-media' });
    assert.equal(S.buildModel(inv).poolDefault, '/mnt/storage-media2');
    const one = twoArrays('default');
    one.pools = [];
    assert.equal(S.buildModel(one).poolDefault, '/mnt/storage');
    assert.equal(S.buildModel(one).pool, null);
});

test('a branch tells what protects it', () => {
    const none = new Set();
    const bp = (b, array = 'media', paths = none) => { const r = S.branchProtection(b, array, paths); return [r.text, r.ok, r.mine]; };
    assert.deepEqual(bp({ path: '/mnt/m1', protected: true, array: 'media', role: 'data' }), ['protected', true, true]);
    assert.deepEqual(bp({ path: '/mnt/d1', protected: true, array: 'default', role: 'data' }), ['protected by default', true, false]);
    assert.deepEqual(bp({ path: '/mnt/x1', protected: false }), ['not protected', false, false]);
    assert.deepEqual(bp({ path: '/mnt/q1', protected: false, array: 'media', role: 'parity' }), ['parity of media', false, true]);
    // a daemon of one array only says nothing: the data disks of the configuration decide
    assert.deepEqual(bp({ path: '/mnt/m1/' }, 'default', new Set(['/mnt/m1'])), ['protected', true, true]);
    assert.deepEqual(bp({ path: '/mnt/zz' }, 'default', new Set(['/mnt/m1'])), ['not in array', false, false]);
});

test('the advisor of an array minds its own pools', () => {
    Object.assign(S.state, { health: {}, known: {}, lastSync: null, array: { health: 'passed' }, changed: [], system: null });
    const titles = (inv) => S.advise(S.buildModel(inv)).map(f => f.title);
    // the pool of the other array and the loose one are not its business
    let t = titles(twoArrays('media'));
    assert.ok(!t.some(x => /not protected|spans|no parity/.test(x)), t.join(' | '));
    // the pool without parity is recalled where the machine is set up, as a note
    const d = S.advise(S.buildModel(twoArrays('default')));
    assert.equal(d.find(f => f.title === 'The pool /mnt/scratch has no parity')?.level, 'tip');
    assert.ok(!d.some(f => f.level === 'warn'), d.map(f => f.title).join(' | '));
    // a disk of no array in its own pool is
    let inv = twoArrays('media');
    inv.pools[1].branches.push({ path: '/mnt/x1', mode: 'RW', protected: false });
    t = titles(inv);
    assert.ok(t.includes('Part of the pool /mnt/media is not protected'), t.join(' | '));
    // and so is a disk of another array, which is protected, but not by this one
    inv = twoArrays('media');
    inv.pools[1].branches.push({ path: '/mnt/d1', mode: 'RW', protected: true, array: 'default', role: 'data', disk: 'd1' });
    t = titles(inv);
    assert.ok(t.includes('The pool /mnt/media spans more arrays'), t.join(' | '));
    assert.ok(!t.some(x => /not protected/.test(x)), t.join(' | '));
});

test('content files only on the data disks are pointed out', () => {
    Object.assign(S.state, { health: {}, known: {}, lastSync: null, array: { health: 'passed' }, changed: [], system: null });
    const inv = twoArrays('default');
    const tip = 'Every content file is on a data disk';
    assert.ok(!S.advise(S.buildModel(inv)).some(f => f.title === tip));
    inv.engine_conf.text = inv.engine_conf.text.replace('content /var/snapraid.content\n', 'content /mnt/d2/snapraid.content\n');
    assert.ok(S.advise(S.buildModel(inv)).some(f => f.title === tip));
});

test('the content file of a new array is named after its configuration', () => {
    const inv = twoArrays('media');
    inv.engine_conf.text = '';
    inv.mounts.forEach(m => { if (m.array === 'media') { delete m.array; delete m.role; delete m.disk; } });
    inv.pools.splice(1, 1);
    const m = S.buildModel(inv);
    const cands = S.candidates(m);
    const roles = Object.fromEntries(cands.map(c => [c.id, 'ignore']));
    roles['/dev/sde1'] = 'data'; roles['/dev/sdf1'] = 'data'; roles['/dev/sdg1'] = 'p0';
    const plan = S.buildPlan(m, { cands, roles, fstype: 'ext4', base: '/mnt', pool: true, poolPath: m.poolDefault, policy: 'pfrd', minfree: '20G', excludes: true, sync: true });
    assert.deepEqual(plan.errors, []);
    assert.match(plan.text, /^content \/etc\/snapraid\/media\.content$/m);
    assert.doesNotMatch(plan.text, /\/var\/snapraid\.content/);
    // its pool doesn't land on the one of the default array
    assert.ok(plan.steps.some(s => s.title === 'Create the mergerfs pool /mnt/storage-media'));
    // and the pool of another array is refused as its own
    const bad = S.buildPlan(m, { cands, roles, fstype: 'ext4', base: '/mnt', pool: true, poolPath: '/mnt/storage', policy: 'pfrd', minfree: '20G', excludes: true, sync: true });
    assert.ok(bad.errors.some(e => /pool of the array default/.test(e)), bad.errors.join(' | '));
});

test('the advisor speaks of the pools of its array, and names them', () => {
    const surprising = (array) => {
        const inv = twoArrays(array);
        // every pool with the two options the advisor has a tip about
        inv.pools.forEach(p => { p.options = { 'category.create': 'epmfs', moveonenospc: 'false' }; });
        return S.advise(S.buildModel(inv)).map(f => f.title).filter(t => /no space left|growing on a full disk/.test(t));
    };
    // the default array: its own pool, and the one of the disks that are in no array
    assert.deepEqual(surprising('default').sort(), [
        'A file growing on a full disk of /mnt/scratch will fail',
        'A file growing on a full disk of /mnt/storage will fail',
        'The pool /mnt/scratch can report “no space left” with space free',
        'The pool /mnt/storage can report “no space left” with space free'
    ]);
    // another array: its own pool only
    assert.deepEqual(surprising('media').sort(), [
        'A file growing on a full disk of /mnt/media will fail',
        'The pool /mnt/media can report “no space left” with space free'
    ]);
});

test('a mounted disk of no array is not called unused', () => {
    const l = S.layoutOf(S.buildModel(twoArrays('default')));
    // sdh is a branch of the pool /mnt/scratch, sdi is blank
    assert.deepEqual(l.spare.map(d => [d.name, d.state]), [['sdh', 'pooled'], ['sdi', 'blank']]);
    const inv = twoArrays('default');
    inv.pools = inv.pools.filter(p => p.mountpoint !== '/mnt/scratch');
    assert.deepEqual(S.layoutOf(S.buildModel(inv)).spare.map(d => [d.name, d.state]), [['sdh', 'mounted'], ['sdi', 'blank']]);
});
