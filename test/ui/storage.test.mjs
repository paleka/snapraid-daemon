// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Paleka

// Tests of the logic of the Storage page: configuration parsing, the model
// built from the inventory, the guided setup rules, and the advisor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The page modules are plain browser ES modules. Load them from a copy with
// the .mjs extension, so that every Node version takes them as modules.
const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'storage-test-'));
for (const name of ['storage', 'api', 'utils']) {
    const src = readFileSync(join(here, '..', '..', 'commander', 'js', `${name}.js`), 'utf8');
    writeFileSync(join(tmp, `${name}.mjs`), src.replace(/from '\.\/(\w+)\.js'/g, "from './$1.mjs'"));
}
const { __test: T } = await import(pathToFileURL(join(tmp, 'storage.mjs')).href);

// the two themes ship the same code
test('brutale has the same storage.js of commander', () => {
    const a = readFileSync(join(here, '..', '..', 'commander', 'js', 'storage.js'), 'utf8');
    const b = readFileSync(join(here, '..', '..', 'brutale', 'js', 'storage.js'), 'utf8');
    assert.equal(a, b);
});

/* ------------------------------------------------------------------ */
/* a machine to test with                                              */
/* ------------------------------------------------------------------ */

const GB = 1e9, TB = 1e12, TiB = 1024 ** 4;

/**
 * Build the inventory the daemon would report.
 * disks: { name, size, fs, label, uuid, mount, used, tran, ro, options, whole }
 *   fs without mount = unmounted filesystem; nothing = blank disk.
 */
const machine = ({ disks = [], conf = '', pools = [], fstab, tools = {}, admin = true, mounts = [], blkid, confPath = '/etc/snapraid.conf' } = {}) => {
    const inv = {
        admin, supported: true,
        tools: { lsblk: true, sfdisk: true, wipefs: true, mkfs_ext4: true, mkfs_xfs: true, mkfs_btrfs: false, mergerfs: true, rsync: true, ...tools },
        engine_conf: { path: confPath, exists: !!conf, text: conf },
        lsblk: { blockdevices: [] }, blkid: [], pools,
        mounts: [{ source: '/dev/sda1', target: '/', fstype: 'ext4', options: 'rw,relatime', is_dir: true, total_bytes: 100 * GB, free_bytes: 50 * GB }, ...mounts],
        fstab: []
    };
    inv.lsblk.blockdevices.push({ name: 'sda', path: '/dev/sda', type: 'disk', size: 120 * GB, ro: false, rm: false, rota: false, children: [{ name: 'sda1', path: '/dev/sda1', type: 'part', size: 110 * GB, fstype: 'ext4', uuid: 'root-uuid' }] });
    disks.forEach(d => {
        const node = { name: d.name, path: `/dev/${d.name}`, type: d.type || 'disk', size: d.size, ro: !!d.ro, rm: false, rota: true, tran: d.tran || 'sata', model: d.model || 'TEST DISK', serial: `S-${d.name}` };
        if (d.children) {
            node.children = d.children;
        } else if (d.fs) {
            const part = d.whole ? node : { name: `${d.name}1`, path: `/dev/${d.name}1`, type: 'part', size: d.size - 2e6 };
            part.fstype = d.fs; part.label = d.label || ''; part.uuid = d.uuid || `uuid-${d.name}`;
            if (!d.whole) node.children = [part];
            inv.blkid.push({ device: part.path, fstype: d.fs, uuid: part.uuid, label: part.label });
            if (d.mount) {
                const total = Math.round(d.size * 0.93);
                inv.mounts.push({ source: part.path, target: d.mount, fstype: d.fs, options: d.options || 'rw,noatime', is_dir: true, total_bytes: total, free_bytes: total - (d.used || 0) });
                if (d.fstab !== false) inv.fstab.push({ source: `UUID=${part.uuid}`, target: d.mount, fstype: d.fs, options: d.fstabOptions || 'defaults,noatime,nofail' });
            }
        }
        inv.lsblk.blockdevices.push(node);
    });
    pools.forEach(p => {
        inv.mounts.push({ source: 'mergerfs', target: p.mountpoint, fstype: 'fuse.mergerfs', options: 'rw,allow_other', is_dir: true, total_bytes: p.total_bytes || 0, free_bytes: p.free_bytes || 0 });
        if (p.persistent !== false) inv.fstab.push({ source: p.branches.map(b => b.path).join(':'), target: p.mountpoint, fstype: 'mergerfs', options: p.fstab_options || 'category.create=pfrd' });
    });
    if (fstab) inv.fstab = fstab;
    if (blkid) inv.blkid = blkid;
    return inv;
};

const pool = (mountpoint, paths, options = {}, extra = {}) => ({
    mountpoint, persistent: true, version: '2.40.2', fstab_options: 'cache.files=off,category.create=pfrd,minfreespace=20G',
    options: { 'category.create': 'pfrd', minfreespace: String(20 * 1024 ** 3), moveonenospc: 'pfrd', ...options },
    branches: paths.map(p => (typeof p === 'string' ? { path: p, mode: 'RW', total_bytes: 3.7 * TB, free_bytes: 2 * TB } : p)),
    total_bytes: paths.length * 3.7 * TB, free_bytes: paths.length * 2 * TB, ...extra
});

/** A healthy array: 3 data and 1 parity of 4 TB, with a pool. */
const healthy = (over = {}) => machine({
    disks: [
        { name: 'sdb', size: 4 * TB, fs: 'ext4', label: 'parity1', mount: '/mnt/parity1', used: 2 * TB },
        { name: 'sdc', size: 4 * TB, fs: 'ext4', label: 'disk1', mount: '/mnt/disk1', used: 2 * TB },
        { name: 'sdd', size: 4 * TB, fs: 'ext4', label: 'disk2', mount: '/mnt/disk2', used: 1 * TB },
        { name: 'sde', size: 4 * TB, fs: 'ext4', label: 'disk3', mount: '/mnt/disk3', used: 1 * TB },
        ...(over.moreDisks || [])
    ],
    conf: over.conf || [
        '# my array', 'parity /mnt/parity1/snapraid.parity',
        'content /var/snapraid.content', 'content /mnt/disk1/snapraid.content',
        'data d1 /mnt/disk1', 'data d2 /mnt/disk2', 'data d3 /mnt/disk3',
        'exclude *.tmp', 'autosave 500', ''
    ].join('\n'),
    pools: over.pools || [pool('/mnt/storage', ['/mnt/disk1', '/mnt/disk2', '/mnt/disk3'])],
    ...(over.machine || {})
});

const resetState = (over = {}) => {
    Object.assign(T.state, { health: {}, known: {}, lastSync: null, array: {}, changed: [], system: null }, over);
};

const findings = (inv, stateOver) => {
    resetState(stateOver);
    return T.advise(T.buildModel(inv));
};
const has = (list, level, re) => list.some(f => f.level === level && re.test(`${f.title} ${f.text}`));

/** Run the guided setup on a model with the given roles. */
const plan = (m, roles, opts = {}) => {
    const cands = T.candidates(m);
    const w = {
        cands, roles: {}, fstype: 'ext4', base: '/mnt', pool: true, poolPath: '/mnt/storage', policy: 'pfrd', minfree: '20G',
        excludes: true, sync: true, ...opts
    };
    cands.forEach(c => { w.roles[c.id] = roles[c.id] || 'ignore'; });
    Object.keys(roles).forEach(id => assert.ok(cands.some(c => c.id === id), `${id} is not a candidate`));
    return T.buildPlan(m, w);
};
const titles = (p) => p.steps.map(s => s.title);
const blank = (n, size = 4 * TB, first = 'b') => Array.from({ length: n }, (_, i) => ({ name: `sd${String.fromCharCode(first.charCodeAt(0) + i)}`, size }));

/* ------------------------------------------------------------------ */
/* snapraid.conf                                                       */
/* ------------------------------------------------------------------ */

test('conf: a round trip keeps comments, order and unknown options', () => {
    const text = [
        '# SnapRAID configuration', '', 'parity /mnt/parity1/snapraid.parity', '2-parity /mnt/p2a/snapraid.2-parity,/mnt/p2b/snapraid.2-parity',
        'content /var/snapraid.content', 'data d1 /mnt/disk1/', 'data d2 /mnt/disk2/', '# excludes', 'exclude *.tmp', 'include /photos/',
        'smartctl d1 -d sat %s', 'temp_limit 50', 'extra spare /mnt/spare', 'nohidden', 'blocksize 256', 'autosave 500', 'pool /pool', ''
    ].join('\n');
    assert.equal(T.serializeConf(T.parseConf(text)), text);
});

test('conf: Windows line ends, tabs and the old "disk" keyword', () => {
    const c = T.parseConf('parity\t/mnt/p/snapraid.parity\r\ndisk d1 /mnt/disk1\r\nDATA d2   /mnt/disk2\r\n');
    assert.deepEqual(c.filter(e => e.type === 'data').map(e => [e.name, e.path]), [['d1', '/mnt/disk1'], ['d2', '/mnt/disk2']]);
    assert.equal(c.find(e => e.type === 'parity').paths[0], '/mnt/p/snapraid.parity');
    assert.ok(!T.serializeConf(c).includes('\r'));
});

test('conf: split parity and paths with spaces', () => {
    const c = T.parseConf('parity /mnt/a/snapraid.parity , /mnt/b/snapraid.parity\ndata media /mnt/My Disk/data\nexclude /Some Folder/\n');
    assert.deepEqual(c[0].paths, ['/mnt/a/snapraid.parity', '/mnt/b/snapraid.parity']);
    assert.equal(c[1].path, '/mnt/My Disk/data');
    assert.equal(c[2].pattern, '/Some Folder/');
});

test('conf: empty and comment-only files', () => {
    assert.deepEqual(T.parseConf(''), []);
    assert.deepEqual(T.parseConf(undefined), []);
    const m = T.buildModel(machine({ conf: '# nothing yet\n#data d1 /mnt/disk1\n' }));
    assert.equal(m.configured, false);
    assert.equal(m.data.length, 0);
});

/* ------------------------------------------------------------------ */
/* the model                                                           */
/* ------------------------------------------------------------------ */

test('model: disk states', () => {
    const m = T.buildModel(machine({
        disks: [
            { name: 'sdb', size: 4 * TB },                                          // blank
            { name: 'sdc', size: 4 * TB, fs: 'ext4', label: 'old' },                // filesystem, not mounted
            { name: 'sdd', size: 4 * TB, fs: 'ext4', mount: '/mnt/extra' },         // mounted, unused
            { name: 'sde', size: 4 * TB, fs: 'ext4', mount: '/mnt/disk1' },         // in the array
            { name: 'sdf', size: 4 * TB, fs: 'ext4', mount: '/mnt/parity1' },
            { name: 'sdg', size: 16 * GB, fs: 'swap', whole: true },                // swap
            { name: 'sdh', size: 4 * TB, ro: true },                                // read-only device
            { name: 'sr0', size: 1 * GB, type: 'rom' },
            { name: 'sdi', size: 4 * TB, children: [{ name: 'sdi1', path: '/dev/sdi1', type: 'part', size: 1 * GB }, { name: 'sdi2', path: '/dev/sdi2', type: 'part', size: 3 * TB }] }
        ],
        conf: 'parity /mnt/parity1/snapraid.parity\ncontent /var/snapraid.content\ndata d1 /mnt/disk1\n'
    }));
    const st = Object.fromEntries(m.disks.map(d => [d.name, d.state]));
    assert.deepEqual(st, { sda: 'system', sdb: 'blank', sdc: 'unmounted', sdd: 'mounted', sde: 'array', sdf: 'array', sdg: 'system', sdi: 'unformatted' });
    // what the setup may take: never the system disk, never what the array uses
    assert.deepEqual(T.candidates(m).map(c => c.id).sort(), ['/dev/sdb', '/dev/sdc1', '/dev/sdd1', '/dev/sdi']);
});

test('model: a data folder inside a filesystem, and one that is not mounted', () => {
    const m = T.buildModel(machine({
        disks: [{ name: 'sdb', size: 4 * TB, fs: 'ext4', mount: '/mnt/disk1' }, { name: 'sdc', size: 4 * TB, fs: 'ext4', mount: '/mnt/parity1' }],
        conf: 'parity /mnt/parity1/snapraid.parity\ncontent /var/snapraid.content\ndata d1 /mnt/disk1/media\ndata d2 /mnt/disk2\n'
    }));
    assert.equal(m.data[0].ok, true);
    assert.equal(m.data[0].mount.target, '/mnt/disk1');
    // /mnt/disk2 is only a folder of the system disk: its disk is missing
    assert.equal(m.data[1].ok, false);
    assert.equal(m.data[1].total, null);
    // /mnt/disk10 must not be taken for something inside /mnt/disk1
    assert.equal(m.mountOf('/mnt/disk10').target, '/');
});

test('model: filesystems on LVM, RAID and encryption are usable, their members are not', () => {
    const lv = { name: 'vg-data', path: '/dev/mapper/vg-data', type: 'lvm', size: 7 * TB, fstype: 'xfs', uuid: 'lv-uuid' };
    const m = T.buildModel(machine({
        disks: [
            { name: 'sdb', size: 4 * TB, children: [{ name: 'sdb1', path: '/dev/sdb1', type: 'part', size: 4 * TB, fstype: 'LVM2_member', children: [lv] }] },
            { name: 'sdc', size: 4 * TB, children: [{ name: 'sdc1', path: '/dev/sdc1', type: 'part', size: 4 * TB, fstype: 'LVM2_member', children: [lv] }] },
            { name: 'sdd', size: 4 * TB, fs: 'crypto_LUKS', whole: true },
            { name: 'sde', size: 4 * TB, children: [{ name: 'sde1', path: '/dev/sde1', type: 'part', size: 4 * TB, fstype: 'linux_raid_member' }] }
        ]
    }));
    const st = Object.fromEntries(m.disks.map(d => [d.name, d.state]));
    assert.equal(st.sdb, 'unmounted');
    assert.equal(st.sdd, 'other');
    assert.equal(st.sde, 'other');
    // the volume spans two disks, but it is offered once, and never for formatting
    const c = T.candidates(m);
    assert.deepEqual(c.map(x => [x.id, x.kind]), [['/dev/mapper/vg-data', 'fs']]);
    assert.ok(m.disks.find(d => d.name === 'sdb').layered);
});

test('model: split parity is the sum of its files and fails with any of them', () => {
    const m = T.buildModel(machine({
        disks: [
            { name: 'sdb', size: 2 * TB, fs: 'ext4', mount: '/mnt/p1a' }, { name: 'sdc', size: 2 * TB, fs: 'ext4', mount: '/mnt/p1b' },
            { name: 'sdd', size: 4 * TB, fs: 'ext4', mount: '/mnt/disk1' }
        ],
        conf: 'parity /mnt/p1a/snapraid.parity,/mnt/p1b/snapraid.parity,/mnt/p1c/snapraid.parity\ncontent /var/snapraid.content\ndata d1 /mnt/disk1\n'
    }));
    assert.equal(m.parity[0].files.length, 3);
    assert.equal(m.parity[0].ok, false);
    assert.equal(m.parity[0].total, Math.round(2 * TB * 0.93) * 2);
    assert.equal(T.layoutOf(m).parity.map(p => p.name).join(), 'parity 1/3,parity 2/3,parity 3/3');
});

/* ------------------------------------------------------------------ */
/* guided setup                                                        */
/* ------------------------------------------------------------------ */

test('setup: four blank disks, with a pool', () => {
    const m = T.buildModel(machine({ disks: blank(4) }));
    const p = plan(m, { '/dev/sdb': 'p0', '/dev/sdc': 'data', '/dev/sdd': 'data', '/dev/sde': 'data' });
    assert.deepEqual(p.errors, []);
    assert.equal(p.text, [
        'parity /mnt/parity1/snapraid.parity',
        'data disk1 /mnt/disk1', 'data disk2 /mnt/disk2', 'data disk3 /mnt/disk3',
        'content /var/snapraid.content', 'content /mnt/disk1/snapraid.content', 'content /mnt/disk2/snapraid.content',
        ...['*.unrecoverable', '/tmp/', '/lost+found/', 'downloads/', 'appdata/', '*.!sync', '.AppleDouble', '._AppleDouble', '.DS_Store', '._.DS_Store', '.Thumbs.db', '.fseventsd', '.Spotlight-V100', '.TemporaryItems', '.Trashes', '.Trash-*', '.AppleDB', '.nfs*'].map(x => `exclude ${x}`),
        'autosave 500', ''
    ].join('\n'));
    // everything that erases is marked, and nothing is used before it exists
    const t = titles(p);
    assert.equal(p.steps.filter(s => s.danger).length, 4);
    assert.ok(p.steps.filter(s => s.danger).every(s => /^Format /.test(s.title)));
    const at = (re) => t.findIndex(x => re.test(x));
    assert.ok(at(/Format \/dev\/sdc/) < at(/Mount it at \/mnt\/disk1/));
    assert.ok(at(/Mount it at \/mnt\/disk3/) < at(/Create the mergerfs pool/));
    assert.ok(at(/Create the mergerfs pool/) < at(/Write the SnapRAID configuration/));
    assert.ok(at(/Write the SnapRAID configuration/) < at(/Start the sync/));
    assert.equal(at(/Start the sync/), t.length - 1);
    // the pool takes the data disks and never the parity
    const poolStep = p.steps.find(s => /mergerfs pool/.test(s.title));
    assert.ok(poolStep.detail.startsWith('/mnt/disk1:/mnt/disk2:/mnt/disk3 '));
    assert.ok(!poolStep.detail.includes('parity'));
    assert.deepEqual(p.preview.pools[0].branches, ['/mnt/disk1', '/mnt/disk2', '/mnt/disk3']);
});

test('setup: without mergerfs nothing about pools', () => {
    const m = T.buildModel(machine({ disks: blank(3), tools: { mergerfs: false } }));
    const p = plan(m, { '/dev/sdb': 'p0', '/dev/sdc': 'data', '/dev/sdd': 'data' }, { pool: false });
    assert.deepEqual(p.errors, []);
    assert.ok(!titles(p).some(t => /pool/i.test(t)));
    assert.equal(p.preview.pools.length, 0);
});

test('setup: the rules that stop it', () => {
    const m = T.buildModel(machine({ disks: [...blank(2, 4 * TB), { name: 'sdd', size: 8 * TB }, { name: 'sde', size: 8 * TB }] }));
    const err = (roles, opts) => plan(m, roles, opts).errors.join(' | ');
    assert.match(err({}), /Nothing selected/);
    assert.match(err({ '/dev/sdb': 'data', '/dev/sdc': 'data' }), /at least one parity/);
    assert.match(err({ '/dev/sdb': 'p0' }), /at least one data disk/);
    // parity smaller than the largest data disk
    assert.match(err({ '/dev/sdb': 'p0', '/dev/sdd': 'data' }), /parity has .* less than the largest data disk/);
    // two small disks on the same level are enough: split parity
    assert.equal(err({ '/dev/sdb': 'p0', '/dev/sdc': 'p0', '/dev/sdd': 'data' }), '');
    // a level cannot be skipped
    assert.match(err({ '/dev/sdd': 'p1', '/dev/sdb': 'data' }), /2-parity needs the levels before it/);
    // same size disks are fine even if filesystems differ a little
    assert.equal(err({ '/dev/sdd': 'p0', '/dev/sde': 'data', '/dev/sdb': 'data' }), '');
    assert.match(err({ '/dev/sdd': 'p0', '/dev/sde': 'data' }, { base: '/mnt/my disks' }), /without spaces/);
    assert.match(err({ '/dev/sdd': 'p0', '/dev/sde': 'data' }, { minfree: 'lots' }), /space to keep free/);
    // the pool cannot live inside a disk, nor contain the disks
    assert.match(err({ '/dev/sdd': 'p0', '/dev/sde': 'data' }, { poolPath: '/mnt/disk1/pool' }), /overlaps a disk folder/);
    assert.match(err({ '/dev/sdd': 'p0', '/dev/sde': 'data' }, { poolPath: '/mnt' }), /overlaps a disk folder/);
});

test('setup: SnapRAID limits', () => {
    const many = T.buildModel(machine({ disks: Array.from({ length: 260 }, (_, i) => ({ name: `d${i}`, size: 4 * TB })) }));
    const roles = Object.fromEntries(many.disks.filter(d => d.name !== 'sda').map((d, i) => [d.path, i < 6 ? `p${i}` : 'data']));
    assert.match(plan(many, roles).errors.join(' | '), /up to 251 data disks/);
    // 6 levels and 251 data disks are accepted
    const ok = Object.fromEntries(Object.entries(roles).slice(0, 257));
    const p = plan(many, ok);
    assert.deepEqual(p.errors, []);
    assert.equal(p.parityCount, 6);
    assert.equal(p.dataCount, 251);
    assert.equal(T.parseConf(p.text).filter(e => e.type === 'content').length, 8);   // one per parity level, plus two

    const nine = T.buildModel(machine({ disks: [...blank(9, 1 * TB), { name: 'sdz', size: 4 * TB }] }));
    const split = Object.fromEntries(nine.disks.filter(d => d.size === 1 * TB).map(d => [d.path, 'p0']));
    assert.match(plan(nine, { ...split, '/dev/sdz': 'data' }).errors.join(' | '), /split over 9 disks, the limit is 8/);
});

test('setup: ext4 cannot hold a parity file over 16 TiB', () => {
    const m = T.buildModel(machine({ disks: [{ name: 'sdb', size: 20 * TB }, { name: 'sdc', size: 20 * TB }] }));
    const roles = { '/dev/sdb': 'p0', '/dev/sdc': 'data' };
    assert.match(plan(m, roles, { fstype: 'ext4' }).errors.join(' | '), /larger than 16 TiB/);
    assert.deepEqual(plan(m, roles, { fstype: 'xfs' }).errors, []);
    // 16 TB disks are below the limit
    const small = T.buildModel(machine({ disks: [{ name: 'sdb', size: 16 * TB }, { name: 'sdc', size: 16 * TB }] }));
    assert.ok(16 * TB < T.EXT4_FILE_MAX);
    assert.deepEqual(plan(small, roles, { fstype: 'ext4' }).errors, []);
});

test('setup: disks that already hold files are mounted, never formatted', () => {
    const m = T.buildModel(machine({
        disks: [
            { name: 'sdb', size: 8 * TB },
            { name: 'sdc', size: 4 * TB, fs: 'xfs', label: 'movies', mount: '/srv/movies', used: 3 * TB },
            { name: 'sdd', size: 4 * TB, fs: 'ext4', label: 'photos', uuid: 'photos-uuid' }
        ]
    }));
    const p = plan(m, { '/dev/sdb': 'p0', '/dev/sdc1': 'data', '/dev/sdd1': 'data' });
    assert.deepEqual(p.errors, []);
    assert.deepEqual(p.steps.filter(s => s.danger).map(s => s.title), ['Format /dev/sdb as ext4 for parity']);
    assert.ok(titles(p).includes('Mount /dev/sdd1 at /mnt/disk2, now and at every boot'));
    assert.ok(!titles(p).some(t => t.includes('/dev/sdc')));       // already mounted: left where it is
    assert.ok(p.text.includes('data disk1 /srv/movies\n'));
    assert.ok(p.text.includes('data disk2 /mnt/disk2\n'));
});

test('setup: adding to an array keeps what is there', () => {
    const inv = healthy({ moreDisks: [{ name: 'sdf', size: 4 * TB }, { name: 'sdg', size: 4 * TB }] });
    const m = T.buildModel(inv);
    const p = plan(m, { '/dev/sdf': 'data' }, { poolPath: '/mnt/storage' });
    assert.deepEqual(p.errors, []);
    const lines = p.text.split('\n');
    assert.equal(lines[0], '# my array');
    assert.ok(lines.includes('data d1 /mnt/disk1') && lines.includes('exclude *.tmp'));
    assert.ok(lines.includes('data disk1 /mnt/disk1-2'));          // /mnt/disk1 is taken: no collision
    assert.equal(lines.filter(l => l.startsWith('exclude')).length, 1);   // the user's rules are not replaced
    assert.equal(lines.filter(l => l.startsWith('parity')).length, 1);
    const t = titles(p);
    assert.ok(t.includes('Add the new data disks to the pool /mnt/storage'));
    assert.ok(t.includes('Start the sync'));
    assert.ok(p.steps.find(s => /pool/.test(s.title)).detail.startsWith('/mnt/disk1:/mnt/disk2:/mnt/disk3:/mnt/disk1-2 '));
});

test('setup: a new parity level on a synced array needs a full sync', () => {
    const m = T.buildModel(healthy({ moreDisks: [{ name: 'sdf', size: 4 * TB }] }));
    const p = plan(m, { '/dev/sdf': 'p1' });
    assert.deepEqual(p.errors, []);
    assert.ok(p.text.includes('parity /mnt/parity1/snapraid.parity\n2-parity /mnt/parity2/snapraid.2-parity\n'));
    const last = p.steps[p.steps.length - 1];
    assert.match(last.title, /full sync/);
    assert.match(last.detail, /sync --force-full/);
    // content files grow with the parity: one on the system disk, and one more than the levels on data disks
    assert.equal(T.parseConf(p.text).filter(e => e.type === 'content').length, 4);
    // without the sync, say what is missing
    const q = plan(m, { '/dev/sdf': 'p1' }, { sync: false });
    assert.match(q.steps[q.steps.length - 1].detail, /protects nothing until a full sync/);
    // extending an existing level is not a new level
    const r = plan(m, { '/dev/sdf': 'p0' });
    assert.ok(r.text.includes('parity /mnt/parity1/snapraid.parity,/mnt/parity1-2/snapraid.parity\n'));
    assert.equal(r.steps[r.steps.length - 1].title, 'Start the sync');
});

/* ------------------------------------------------------------------ */
/* advisor                                                             */
/* ------------------------------------------------------------------ */

test('advisor: a healthy array has nothing to fix', () => {
    const f = findings(healthy());
    assert.ok(has(f, 'ok', /Everything looks right/));
    assert.ok(!f.some(x => x.level === 'bad' || x.level === 'warn'), JSON.stringify(f.filter(x => x.level !== 'ok' && x.level !== 'tip')));
});

test('advisor: nothing set up', () => {
    const f = findings(machine({ disks: blank(3) }));
    assert.ok(has(f, 'tip', /Nothing is set up yet/));
    assert.equal(f[0].action.st, 'wizard');
    assert.ok(has(findings(machine({})), 'tip', /No free disk was found/));
});

test('advisor: the parity disk in the pool', () => {
    const f = findings(healthy({ pools: [pool('/mnt/storage', ['/mnt/disk1', '/mnt/disk2', '/mnt/disk3', '/mnt/parity1'])] }));
    assert.ok(has(f, 'bad', /parity disk is part of the pool/));
});

test('advisor: data, parity or content pointing into the pool', () => {
    const conf = 'parity /mnt/storage/snapraid.parity\ncontent /mnt/storage/snapraid.content\ncontent /var/snapraid.content\ndata d1 /mnt/storage\ndata d2 /mnt/disk2\ndata d3 /mnt/disk3\nexclude *.tmp\n';
    const f = findings(healthy({ conf }));
    assert.ok(has(f, 'bad', /d1 points to the pool/));
    assert.ok(has(f, 'bad', /parity is inside the pool/));
    assert.ok(has(f, 'bad', /content file is inside the pool/));
    // the pool is not reported as a missing disk
    assert.ok(!has(f, 'bad', /d1 is not mounted/));
});

test('advisor: a disk that failed to mount', () => {
    const inv = healthy();
    inv.mounts = inv.mounts.filter(m => m.target !== '/mnt/disk2');
    const f = findings(inv);
    assert.ok(has(f, 'bad', /d2 is not mounted/));
    assert.equal(f.find(x => /d2 is not mounted/.test(x.title)).action.st, 'replace');
    assert.ok(!has(f, 'ok', /Everything looks right/));
});

test('advisor: parity and data on one disk, two data on one disk', () => {
    const conf = 'parity /mnt/disk1/snapraid.parity\ncontent /var/snapraid.content\ncontent /mnt/disk2/snapraid.content\ndata d1 /mnt/disk1\ndata d2 /mnt/disk2/a\ndata d3 /mnt/disk2/b\nexclude *.tmp\n';
    const f = findings(healthy({ conf, pools: [] }));
    assert.ok(has(f, 'bad', /parity shares a disk with d1/));
    assert.ok(has(f, 'bad', /d2 and d3 are on the same disk/));
});

test('advisor: too few parity disks, too small parity, too few content files', () => {
    const disks = [{ name: 'sdb', size: 4 * TB, fs: 'ext4', mount: '/mnt/parity1' }, ...Array.from({ length: 6 }, (_, i) => ({ name: `sd${'cdefgh'[i]}`, size: i === 0 ? 8 * TB : 4 * TB, fs: 'ext4', mount: `/mnt/disk${i + 1}` }))];
    const conf = ['parity /mnt/parity1/snapraid.parity', 'content /mnt/disk1/snapraid.content', 'content /mnt/disk1/copy.content', ...disks.slice(1).map((d, i) => `data d${i + 1} ${d.mount}`), 'exclude *.tmp', ''].join('\n');
    const f = findings(machine({ disks, conf }));
    assert.ok(has(f, 'warn', /6 data disks with 1 parity disk/));
    assert.ok(has(f, 'bad', /parity is smaller than a data disk/));
    assert.ok(has(f, 'warn', /Too few content files.*2 copies on 1 disk/));
});

test('advisor: read-only filesystem, missing fstab entry, missing nofail', () => {
    const inv = healthy();
    inv.mounts.find(m => m.target === '/mnt/disk2').options = 'ro,noatime';
    inv.fstab = inv.fstab.filter(e => e.target !== '/mnt/disk3');
    inv.fstab.find(e => e.target === '/mnt/disk1').options = 'defaults';
    const f = findings(inv);
    assert.ok(has(f, 'bad', /d2 is read-only/));
    assert.ok(has(f, 'warn', /1 disk is not mounted at boot.*\/mnt\/disk3/));
    assert.ok(has(f, 'tip', /dead disk can stop the boot.*\/mnt\/disk1/));
    // "errors=remount-ro" is an option, not a read-only mount
    const ok = healthy();
    ok.mounts.find(m => m.target === '/mnt/disk2').options = 'rw,errors=remount-ro';
    assert.ok(!has(findings(ok), 'bad', /read-only/));
});

test('advisor: pool policies that surprise', () => {
    const f = findings(healthy({ pools: [pool('/mnt/storage', ['/mnt/disk1', '/mnt/disk2', '/mnt/disk3'], { 'category.create': 'epmfs', moveonenospc: 'false' }, { persistent: false })] }));
    assert.ok(has(f, 'tip', /no space left.*epmfs/));
    assert.ok(has(f, 'tip', /growing on a full disk/));
    assert.ok(has(f, 'warn', /pool \/mnt\/storage is not saved/));
    // a data disk left out, and a branch that is not in the array
    const g = findings(healthy({ pools: [pool('/mnt/storage', ['/mnt/disk1', '/mnt/disk2', '/mnt/other'])] }));
    assert.ok(has(g, 'tip', /d3 not in the pool/));
    assert.ok(has(g, 'warn', /Part of the pool is not protected.*\/mnt\/other/));
});

test('advisor: cloned disk, full parity, big parity on ext4, memory', () => {
    const inv = healthy();
    inv.blkid.push({ device: '/dev/sdz1', fstype: 'ext4', uuid: 'uuid-sdc' });
    assert.ok(has(findings(inv), 'warn', /same UUID.*\/dev\/sdc1 and \/dev\/sdz1/));

    const full = healthy();
    const d1 = full.mounts.find(m => m.target === '/mnt/disk1');
    d1.free_bytes = Math.round(d1.total_bytes * 0.01);
    const f = findings(full);
    assert.ok(has(f, 'warn', /parity is about to be full/));
    assert.ok(has(f, 'warn', /d1 is almost full/));

    const big = machine({
        disks: [{ name: 'sdb', size: 22 * TB, fs: 'ext4', mount: '/mnt/parity1' }, { name: 'sdc', size: 22 * TB, fs: 'xfs', mount: '/mnt/disk1' }, { name: 'sdd', size: 22 * TB, fs: 'xfs', mount: '/mnt/disk2' }],
        conf: 'parity /mnt/parity1/snapraid.parity\ncontent /var/snapraid.content\ncontent /mnt/disk1/snapraid.content\ndata d1 /mnt/disk1\ndata d2 /mnt/disk2\nexclude *.tmp\n'
    });
    assert.ok(22 * TB * 0.93 > 16 * TiB);
    assert.ok(has(findings(big), 'warn', /parity cannot use its whole disk/));

    // 40 TB of data need about 2.4 GiB for the hashes: too much for a 4 GB machine, fine with 32 GB
    assert.ok(has(findings(big, { system: { memory_total_bytes: 4 * GB } }), 'warn', /large for the memory/));
    assert.ok(!has(findings(big, { system: { memory_total_bytes: 32 * GB } }), 'warn', /large for the memory/));
});

test('advisor: degraded array offers the recovery', () => {
    const f = findings(healthy(), { array: { health: 'degraded', health_reason: 'Disk d2 has split 0 with UUID changed' }, changed: ['d2'] });
    const x = f.find(y => /array is degraded/.test(y.title));
    assert.equal(x.level, 'bad');
    assert.equal(x.action.st, 'recover');
    assert.equal(f[0].level, 'bad');                                 // the serious ones come first
    assert.ok(!has(f, 'ok', /Everything looks right/));
});

test('advisor: failing disk, removal in progress, read-only mode, no excludes', () => {
    const f = findings(healthy(), { health: { d1: 'failing', parity: 'prefail', d2: 'passed' } });
    assert.equal(f.find(x => /d1 is failing/.test(x.title)).action.data.kind, 'data');
    assert.equal(f.find(x => /parity is showing signs/.test(x.title)).action.data.kind, 'parity');

    const rm = healthy({ conf: 'parity /mnt/parity1/snapraid.parity\ncontent /var/snapraid.content\ncontent /mnt/disk1/snapraid.content\ndata d1 /mnt/disk1\ndata d2 /mnt/snapraid-removed/d2\n' });
    const g = findings(rm);
    assert.ok(has(g, 'tip', /d2 is being removed/));
    assert.ok(!has(g, 'bad', /d2 is not mounted/));
    assert.ok(has(g, 'tip', /Nothing is excluded/));

    const ro = healthy({ machine: { admin: false } });
    ro.admin_reason = 'Storage administration is disabled.';
    assert.ok(has(findings(ro), 'tip', /Read-only mode.*Storage administration is disabled/));
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* disks of different sizes                                            */
/* ------------------------------------------------------------------ */

/** An array of 2, 4 and 8 TB data disks with an 8 TB parity, plus free disks to choose from. */
const mixed = (spares = [], over = {}) => machine({
    disks: [
        { name: 'sdb', size: 8 * TB, fs: 'ext4', label: 'parity1', mount: '/mnt/parity1', used: 5 * TB, ...over.parity },
        { name: 'sdc', size: 2 * TB, fs: 'ext4', label: 'disk1', mount: '/mnt/disk1', used: 1.5 * TB },
        { name: 'sdd', size: 4 * TB, fs: 'ext4', label: 'disk2', mount: over.dead ? undefined : '/mnt/disk2', used: 1 * TB },
        { name: 'sde', size: 8 * TB, fs: 'xfs', label: 'disk3', mount: '/mnt/disk3', used: 5 * TB },
        ...spares
    ],
    conf: ['parity /mnt/parity1/snapraid.parity', 'content /var/snapraid.content', 'content /mnt/disk1/snapraid.content',
        'data d1 /mnt/disk1', 'data d2 /mnt/disk2', 'data d3 /mnt/disk3', 'exclude *.tmp', 'autosave 500', ''].join('\n')
});
const verdictOf = (inv, kind, name, dev, stateOver, fstype = 'ext4') => {
    resetState({ known: {}, ...stateOver });
    const m = T.buildModel(inv);
    const c = T.candidates(m).find(x => x.id === dev);
    assert.ok(c, `${dev} is not a candidate`);
    return T.replaceCheck(m, kind, name, c, fstype);
};

test('sizes: the setup gives the largest disks to the parity whatever the order', () => {
    const m = T.buildModel(machine({ disks: [{ name: 'sdb', size: 2 * TB }, { name: 'sdc', size: 12 * TB }, { name: 'sdd', size: 4 * TB }, { name: 'sde', size: 8 * TB }] }));
    const p = plan(m, { '/dev/sdb': 'data', '/dev/sdc': 'p0', '/dev/sdd': 'data', '/dev/sde': 'data' });
    assert.deepEqual(p.errors, []);
    // the same disks with a small one as parity are refused
    const q = plan(m, { '/dev/sdb': 'p0', '/dev/sdc': 'data', '/dev/sdd': 'data', '/dev/sde': 'data' });
    assert.ok(q.errors.some(e => /less than the largest data disk/.test(e)));
    // two small disks joined on one level are enough
    const r = plan(m, { '/dev/sdb': 'data', '/dev/sdc': 'ignore', '/dev/sdd': 'p0', '/dev/sde': 'p0' });
    assert.ok(r.errors.some(e => /less than the largest|at least one data/.test(e)) === false, r.errors.join(' | '));
    assert.match(r.text, /^parity \S+snapraid\.parity,\S+snapraid\.parity$/m);
});

test('sizes: growing an array with a disk larger than the parity is refused with the way out', () => {
    const m = T.buildModel(mixed([{ name: 'sdf', size: 16 * TB }, { name: 'sdg', size: 1 * TB }]));
    resetState({ known: {} });
    const big = plan(m, { '/dev/sdf': 'data' }, { pool: false });
    assert.ok(big.errors.some(e => /parity has .* less than the largest data disk/.test(e)), big.errors.join(' | '));
    const small = plan(m, { '/dev/sdg': 'data' }, { pool: false });
    assert.deepEqual(small.errors, []);
});

test('sizes: a data disk can be replaced by a smaller one when its files fit', () => {
    // d2 is a 4 TB disk holding 1 TB
    const inv = mixed([{ name: 'sdf', size: 2 * TB }, { name: 'sdg', size: 1 * TB }, { name: 'sdh', size: 4 * TB }]);
    const smaller = verdictOf(inv, 'data', 'd2', '/dev/sdf');
    assert.equal(smaller.blocked, null);
    assert.ok(smaller.warnings.some(w => /smaller than the old one/.test(w)));
    assert.match(verdictOf(inv, 'data', 'd2', '/dev/sdg').blocked, /too small: d2 held/);
    const same = verdictOf(inv, 'data', 'd2', '/dev/sdh');
    assert.equal(same.blocked, null);
    assert.deepEqual(same.warnings, []);
});

test('sizes: the replacement of a dead disk is judged on what the last sync recorded', () => {
    const inv = mixed([{ name: 'sdf', size: 2 * TB }, { name: 'sdg', size: 6 * TB }], { dead: true });
    const known = { d2: { total: 3.7 * TB, used: 3 * TB } };
    assert.match(verdictOf(inv, 'data', 'd2', '/dev/sdf', { known }).blocked, /too small/);
    assert.equal(verdictOf(inv, 'data', 'd2', '/dev/sdg', { known }).blocked, null);
    // nothing known (never synced): nothing to refuse
    assert.equal(verdictOf(inv, 'data', 'd2', '/dev/sdf').blocked, null);
});

test('sizes: a data disk larger than the parity is allowed and explained', () => {
    const v = verdictOf(mixed([{ name: 'sdf', size: 16 * TB }]), 'data', 'd1', '/dev/sdf');
    assert.equal(v.blocked, null);
    assert.ok(v.warnings.some(w => /larger than the parity/.test(w) && /insufficient parity space/.test(w)));
});

test('sizes: a parity must hold the fullest data disk, and is warned when smaller than the largest', () => {
    // the fullest data disk holds 5 TB, the largest is 8 TB
    const inv = mixed([{ name: 'sdf', size: 4 * TB }, { name: 'sdg', size: 6 * TB }, { name: 'sdh', size: 8 * TB }, { name: 'sdi', size: 20 * TB }]);
    assert.match(verdictOf(inv, 'parity', 'parity', '/dev/sdf').blocked, /too small: a data disk holds/);
    const tight = verdictOf(inv, 'parity', 'parity', '/dev/sdg');
    assert.equal(tight.blocked, null);
    assert.ok(tight.warnings.some(w => /smaller than the largest data disk/.test(w)));
    assert.deepEqual(verdictOf(inv, 'parity', 'parity', '/dev/sdh'), { blocked: null, warnings: [] });
    assert.ok(verdictOf(inv, 'parity', 'parity', '/dev/sdi', {}, 'ext4').warnings.some(w => /16 TiB/.test(w)));
    assert.deepEqual(verdictOf(inv, 'parity', 'parity', '/dev/sdi', {}, 'xfs').warnings, []);
});

test('sizes: the advisor tells a parity that is too small from one that is only tight', () => {
    const arr = (paritySize) => machine({
        disks: [{ name: 'sdb', size: paritySize, fs: 'ext4', mount: '/mnt/parity1' }, { name: 'sdc', size: 8 * TB, fs: 'ext4', mount: '/mnt/disk1', used: 1 * TB }, { name: 'sdd', size: 2 * TB, fs: 'ext4', mount: '/mnt/disk2' }],
        conf: ['parity /mnt/parity1/snapraid.parity', 'content /var/snapraid.content', 'content /mnt/disk1/snapraid.content', 'data d1 /mnt/disk1', 'data d2 /mnt/disk2', 'exclude *.tmp', ''].join('\n')
    });
    const small = findings(arr(4 * TB));
    assert.ok(has(small, 'bad', /parity is smaller than a data disk/));
    const tight = findings(arr(7.6 * TB));
    assert.ok(!has(tight, 'bad', /smaller than a data disk/));
    assert.ok(has(tight, 'warn', /a little smaller than the largest data disk/));
    const fine = findings(arr(8 * TB));
    assert.ok(!has(fine, 'bad', /smaller/) && !has(fine, 'warn', /a little smaller/));
    const larger = findings(arr(16 * TB));
    assert.ok(!has(larger, 'warn', /a little smaller/));
});

test('sizes: a sync stopped by a full parity is explained with the files involved', () => {
    const task = (exit, texts) => ({ command: 'sync', status: 'terminated', exit_code: exit, messages: texts.map(text => ({ level: 'fatal', text })) });
    const stopped = T.lastSyncOf({ history: [
        { command: 'probe', status: 'terminated', exit_code: 0, messages: [] },
        task(1, ['Failed to allocate all the required parity space. You miss 99614720 bytes.', 'outofparity /mnt/disk1/Movies/a.mkv', 'outofparity /mnt/disk1/Movies/b.mkv', 'Insufficient parity space. Data requires more parity than available.']),
        task(0, [])] });
    assert.deepEqual(stopped.outOfParity, ['/mnt/disk1/Movies/a.mkv', '/mnt/disk1/Movies/b.mkv']);
    const f = findings(healthy(), { lastSync: stopped });
    assert.ok(has(f, 'bad', /parity is full.*2 files did not fit, starting with \/mnt\/disk1\/Movies\/a\.mkv/));
    // a later good sync clears it, and another kind of failure is not mistaken for it
    assert.equal(T.lastSyncOf({ history: [task(0, []), stopped] }).parityFull, undefined);
    assert.ok(!T.lastSyncOf({ history: [task(1, ['Disk d1 is not accessible'])] }).parityFull);
    assert.ok(!T.lastSyncOf(null).parityFull);
    assert.ok(!has(findings(healthy()), 'bad', /parity is full/));
});

test('sizes: the pool balance looks at fill levels, not at bytes', () => {
    // 1 TB of 2 TB is fuller than 2 TB of 8 TB
    const need = T.balanceNeed({ branches: [
        { path: '/mnt/disk1', mode: 'RW', total_bytes: 2 * TB, free_bytes: 1 * TB },
        { path: '/mnt/disk2', mode: 'RW', total_bytes: 8 * TB, free_bytes: 6 * TB }] });
    assert.equal(Math.round(need.spread), 25);
    assert.ok(need.bytes > 0.35 * TB && need.bytes < 0.45 * TB, String(need.bytes));   // 0.4 TB brings both to 30%
});

test('helpers: sizes', () => {
    assert.equal(T.parseSize('20G'), 20 * 1024 ** 3);
    assert.equal(T.parseSize('500M'), 500 * 1024 ** 2);
    assert.equal(T.parseSize('1.5T'), Math.round(1.5 * 1024 ** 4));
    assert.equal(T.parseSize('4GiB'), 4 * 1024 ** 3);
    assert.equal(T.parseSize(' 100 k '), 100 * 1024);
    assert.equal(T.parseSize('4096'), 4096);
    for (const bad of ['', 'lots', '-5G', '5 5G', '5X', 'G']) assert.equal(T.parseSize(bad), null, bad);
    assert.equal(T.shortSize(20 * 1024 ** 3), '20G');
    assert.equal(T.shortSize(String(4 * 1024 ** 3)), '4G');
    assert.equal(T.shortSize(1536 * 1024 ** 2), '1536M');
    assert.equal(T.parseSize(T.shortSize(21474836480)), 21474836480);
});

test('helpers: mergerfs options', () => {
    let o = 'cache.files=off,category.create=epmfs,minfreespace=4G,allow_other';
    o = T.setOption(o, 'category.create', 'pfrd');
    o = T.setOption(o, 'minfreespace', '20G');
    assert.equal(T.getOption(o, 'category.create'), 'pfrd');
    assert.equal(T.getOption(o, 'minfreespace'), '20G');
    assert.equal(o.split(',').filter(x => x.startsWith('category.create')).length, 1);
    assert.ok(o.split(',').includes('allow_other') && o.split(',').includes('cache.files=off'));
    assert.equal(T.getOption(o, 'category'), null);                  // not a prefix match
    assert.equal(T.getOption('', 'x'), null);
    // what a new pool gets must pass the daemon's validation
    assert.match(T.defaultPoolOptions('pfrd', '20G'), /^[A-Za-z0-9._,=:\/+-]+$/);
});

test('helpers: parity guideline and balance estimate', () => {
    assert.deepEqual([1, 4, 5, 14, 15, 21, 22, 28, 29, 35, 36, 251].map(T.recommendedParity), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
    const b = (used, total = 100) => ({ path: '/x', mode: 'RW', total_bytes: total, free_bytes: total - used });
    assert.deepEqual(T.balanceNeed({ branches: [b(80), b(20)] }), { bytes: 30, spread: 60 });
    assert.deepEqual(T.balanceNeed({ branches: [b(50), b(50)] }), { bytes: 0, spread: 0 });
    // read-only branches do not take part
    assert.deepEqual(T.balanceNeed({ branches: [b(80), b(20), { ...b(0), mode: 'RO' }] }), { bytes: 30, spread: 60 });
    assert.deepEqual(T.balanceNeed({ branches: [] }), { bytes: 0, spread: 0 });
    // different sizes meet at the same percentage, not at the same amount
    const n = T.balanceNeed({ branches: [b(900, 1000), b(0, 4000)] });
    assert.equal(Math.round(n.bytes), 720);
});
