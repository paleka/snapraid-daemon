// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Paleka

// Storage page: array layout, mergerfs pool, disks, guided setup and
// SnapRAID configuration editing.

import { API } from './api.js';
import { escHtml, escAttr, showToast, formatDiskSize } from './utils.js';

/* ------------------------------------------------------------------ */
/* snapraid.conf model                                                 */
/* ------------------------------------------------------------------ */

const PARITY_KEYS = ['parity', '2-parity', '3-parity', '4-parity', '5-parity', '6-parity'];

const DEFAULT_EXCLUDES = [
    '*.unrecoverable', '/tmp/', '/lost+found/', 'downloads/', 'appdata/', '*.!sync',
    '.AppleDouble', '._AppleDouble', '.DS_Store', '._.DS_Store', '.Thumbs.db', '.fseventsd',
    '.Spotlight-V100', '.TemporaryItems', '.Trashes', '.Trash-*', '.AppleDB', '.nfs*'
];

/**
 * Parse the configuration keeping every line, so that comments and options
 * this page doesn't know about survive a round trip.
 */
export const parseConf = (text) => {
    const entries = (text || '').replace(/\r/g, '').split('\n').map(raw => {
        const line = raw.trim();
        if (!line || line.startsWith('#')) return { type: 'raw', raw };
        const m = line.match(/^(\S+)\s*(.*)$/);
        const key = m[1].toLowerCase();
        const rest = m[2].trim();
        if (PARITY_KEYS.includes(key) || key === 'z-parity')
            return { type: 'parity', key, paths: rest.split(',').map(s => s.trim()).filter(Boolean) };
        if (key === 'data' || key === 'disk') {
            const d = rest.match(/^(\S+)\s+(.*)$/);
            if (d) return { type: 'data', key, name: d[1], path: d[2].trim() };
        }
        if (key === 'content') return { type: 'content', path: rest };
        if (key === 'exclude' || key === 'include') return { type: 'filter', key, pattern: rest };
        if (['blocksize', 'hashsize', 'autosave', 'nohidden', 'pool', 'share'].includes(key))
            return { type: 'option', key, value: rest };
        return { type: 'raw', raw };
    });
    // a final empty line is only the terminator of the last one
    while (entries.length && entries[entries.length - 1].type === 'raw' && entries[entries.length - 1].raw.trim() === '')
        entries.pop();
    return entries;
};

export const serializeConf = (entries) => entries.map(e => {
    switch (e.type) {
        case 'parity': return `${e.key} ${e.paths.join(',')}`;
        case 'data': return `${e.key} ${e.name} ${e.path}`;
        case 'content': return `content ${e.path}`;
        case 'filter': return `${e.key} ${e.pattern}`;
        case 'option': return e.value ? `${e.key} ${e.value}` : e.key;
        default: return e.raw;
    }
}).join('\n') + '\n';

/** Insert an entry after the last one of the same type, to keep the file tidy. */
const confInsert = (entries, entry) => {
    let at = -1;
    entries.forEach((e, i) => { if (e.type === entry.type) at = i; });
    if (at < 0) {
        // parity lines open the file, right after the initial comments; everything else goes at the end
        const first = entries.findIndex(e => e.type !== 'raw');
        at = entry.type === 'parity' && first >= 0 ? first - 1 : entries.length - 1;
    }
    entries.splice(at + 1, 0, entry);
};

const confOption = (entries, key) => entries.find(e => e.type === 'option' && e.key === key);

const stripSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
const dirname = (p) => { const s = stripSlash(p); const i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i); };
const isUnder = (path, dir) => { const p = stripSlash(path), d = stripSlash(dir); return p === d || d === '/' || p.startsWith(d + '/'); };

/* ------------------------------------------------------------------ */
/* inventory model                                                     */
/* ------------------------------------------------------------------ */

const SYSTEM_TARGETS = ['/', '/boot', '/boot/efi', '/efi', '/usr', '/var', '/home', '/etc/hosts', '/etc/hostname', '/etc/resolv.conf', '/nix'];

const truthy = (v) => v === true || v === 1 || v === '1';

// what is on a device that is a piece of something else, not a filesystem to use
const MEMBER_TYPES = ['LVM2_member', 'crypto_LUKS', 'linux_raid_member', 'zfs_member', 'swap'];

// the limits of SnapRAID
const MAX_DATA = 251;
const MAX_SPLIT = 8;

/**
 * Merge what the daemon reports into something the page can reason about:
 * which filesystem is where, what the array uses, what is free to take.
 */
export const buildModel = (inv) => {
    const conf = parseConf(inv.engine_conf?.text || '');
    const dataEntries = conf.filter(e => e.type === 'data');
    const parityEntries = conf.filter(e => e.type === 'parity');
    const contentEntries = conf.filter(e => e.type === 'content');

    // the last mount on a directory is the visible one
    const mountByTarget = new Map();
    (inv.mounts || []).forEach(m => mountByTarget.set(m.target, m));
    const mounts = [...mountByTarget.values()];
    const mountOf = (path) => {
        let best = null;
        mounts.forEach(m => {
            if (m.is_dir !== false && isUnder(path, m.target) && (!best || m.target.length > best.target.length)) best = m;
        });
        return best;
    };

    const systemSources = new Set(mounts.filter(m => SYSTEM_TARGETS.includes(m.target) && m.source.startsWith('/dev/')).map(m => m.source));
    const blkid = new Map((inv.blkid || []).map(b => [b.device, b]));
    const pools = inv.pools || [];
    const poolTargets = new Set(pools.map(p => p.mountpoint));
    const branchSet = new Set(pools.flatMap(p => p.branches.map(b => stripSlash(b.path))));

    // what the array uses, by mount point
    const roleByTarget = new Map();
    const addRole = (path, role) => {
        const m = mountOf(path);
        if (!m) return;
        if (!roleByTarget.has(m.target)) roleByTarget.set(m.target, []);
        if (!roleByTarget.get(m.target).includes(role)) roleByTarget.get(m.target).push(role);
    };
    dataEntries.forEach(e => addRole(e.path, `data ${e.name}`));
    parityEntries.forEach(e => e.paths.forEach(p => addRole(p, e.key)));

    const fsNode = (node) => {
        const path = node.path || `/dev/${node.name}`;
        const id = blkid.get(path) || {};
        const fstype = node.fstype || id.fstype || '';
        const mount = mounts.find(m => m.source === path) || null;
        return {
            path,
            size: Number(node.size) || 0,
            fstype,
            label: node.label || id.label || '',
            uuid: node.uuid || id.uuid || '',
            pttype: id.pttype || '',
            mount,
            roles: mount ? (roleByTarget.get(mount.target) || []) : [],
            system: (mount && (SYSTEM_TARGETS.includes(mount.target) || systemSources.has(path))) || systemSources.has(path) || fstype === 'swap'
        };
    };

    // everything stacked on a disk: partitions, and what RAID, LVM or encryption build on them
    const descend = (node, acc = []) => {
        (node.children || []).forEach(c => { acc.push(c); descend(c, acc); });
        return acc;
    };

    const disks = (inv.lsblk?.blockdevices || [])
        .filter(d => (d.type === 'disk' || d.type === 'loop') && Number(d.size) > 0 && !truthy(d.ro))
        .map(d => {
            const self = fsNode(d);
            const below = descend(d);
            const nodes = below.map(fsNode);
            const parts = nodes.filter((n, i) => below[i].type === 'part');
            const layered = below.some(c => c.type !== 'part');
            const filesystems = (below.length ? nodes : [self]).filter(n => n.fstype && !MEMBER_TYPES.includes(n.fstype));
            const all = [self, ...nodes];
            let state;
            if (all.some(n => n.system)) state = 'system';
            else if (all.some(n => n.roles.length)) state = 'array';
            else if (!below.length && !self.fstype && !self.pttype) state = 'blank';
            else if (!filesystems.length) state = layered || all.some(n => MEMBER_TYPES.includes(n.fstype)) ? 'other' : 'unformatted';
            else if (filesystems.some(f => f.mount)) state = 'mounted';
            else state = 'unmounted';
            return {
                path: self.path, name: d.name, size: self.size,
                model: (d.model || '').trim(), serial: (d.serial || '').trim(),
                rotational: truthy(d.rota), transport: d.tran || (d.type === 'loop' ? 'loop' : ''),
                removable: truthy(d.rm), parts, filesystems, state, layered
            };
        });

    const describe = (path) => {
        const m = mountOf(path);
        const real = m && m.target !== '/' && !poolTargets.has(m.target);
        return {
            mount: m,
            onPool: !!m && poolTargets.has(m.target),
            ok: !!real,
            total: real ? m.total_bytes : null,
            free: real ? m.free_bytes : null,
            inPool: branchSet.has(stripSlash(path))
        };
    };

    return {
        inv, conf, disks, mounts, pools, mountOf, describe, branchSet, poolTargets,
        data: dataEntries.map(e => ({ ...e, ...describe(e.path), removing: e.path.startsWith(REMOVED_BASE + '/') })),
        parity: parityEntries.map(e => {
            // a parity level can be split over more files, on different disks
            const files = e.paths.map(path => ({ path, ...describe(path) }));
            return {
                ...e, files, mount: files[0]?.mount, inPool: false,
                ok: files.length > 0 && files.every(f => f.ok),
                total: files.reduce((a, f) => a + (f.total || 0), 0),
                free: files.reduce((a, f) => a + (f.free || 0), 0)
            };
        }),
        content: contentEntries.map(e => e.path),
        configured: dataEntries.length > 0 && parityEntries.length > 0
    };
};

const REMOVED_BASE = '/mnt/snapraid-removed';

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

const call = async (endpoint, method, body) => {
    const response = await fetch(`/snapraid/v1/storage${endpoint}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await response.json(); } catch (ignore) { /* not json */ }
    if (!response.ok) throw new Error(json?.message || `Request failed with status ${response.status}`);
    return json;
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Follow the background operation of the daemon until it ends. */
const waitJob = async (onTick) => {
    for (;;) {
        const { job } = await call('/job', 'GET');
        if (onTick) onTick(job);
        if (!job.running) return job;
        await sleep(1000);
    }
};

const StorageAPI = {
    get: () => call('', 'GET'),
    saveConf: (text) => call('/engine_conf', 'PUT', { text }),
    // formatting runs in background: big disks take minutes
    format: async (device, fstype, label, purpose, wipe) => {
        await call('/format', 'POST', { device, fstype, label, purpose, wipe });
        const job = await waitJob();
        if (!job.success) throw new Error(job.message);
        return job;
    },
    mount: (source, target, fstype, options, persist = true) => call('/mount', 'POST', { source, target, fstype, options, persist }),
    unmount: (target, forget) => call('/unmount', 'POST', { target, forget }),
    pool: (mountpoint, branches, options, persist = true) => call('/pool', 'POST', { mountpoint, branches: branches.join(':'), options, persist }),
    mkdir: (path) => call('/mkdir', 'POST', { path }),
    recover: (disks, check, accept = false, forceUuid = false) => call('/recover', 'POST', { disks: disks.join(','), check, accept, force_uuid: forceUuid }),
    balance: (mountpoint, maxBytes, spread) => call('/balance', 'POST', { mountpoint, max_bytes: String(Math.round(maxBytes)), spread: String(spread) }),
    duplicates: (mountpoint) => call('/duplicates', 'POST', { mountpoint }),
    jobStop: () => call('/job_stop', 'POST', {}),
    browse: (pool, path) => call(`/browse?pool=${encodeURIComponent(pool)}&path=${encodeURIComponent(path)}`, 'GET')
};

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

const state = { model: null, health: {}, view: null, tab: 'overview', array: {}, changed: [], system: null, browse: null, watching: false };

const size = (bytes) => (bytes == null ? '–' : formatDiskSize(bytes));
const badge = (text, color) => `<span class="badge badge-${color}">${escHtml(text)}</span>`;

const usageBar = (total, free) => {
    if (!total) return '<span class="text-muted text-xs">not mounted</span>';
    const used = total - free;
    const pct = Math.min(100, Math.round(used * 100 / total));
    const cls = pct >= 90 ? 'st-bar-red' : pct >= 75 ? 'st-bar-amber' : '';
    return `
        <div class="st-usage">
            <div class="progress-container"><div class="progress-bar ${cls}" data-width="${pct}"></div></div>
            <div class="text-xs text-muted">${size(used)} of ${size(total)} used, ${size(free)} free</div>
        </div>`;
};

const applyWidths = (root) => {
    root.querySelectorAll('[data-width]').forEach(el => { el.style.width = `${el.dataset.width}%`; });
    root.querySelectorAll('[data-height]').forEach(el => { el.style.height = `${el.dataset.height}%`; });
};

/** SnapRAID's guideline on how many parity disks an array of this size deserves. */
const recommendedParity = (dataCount) => (dataCount <= 4 ? 1 : dataCount <= 14 ? 2 : dataCount <= 21 ? 3 : dataCount <= 28 ? 4 : dataCount <= 35 ? 5 : 6);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const parseSize = (text) => {
    const m = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?$/i);
    if (!m) return null;
    const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2].toUpperCase()];
    return Math.round(parseFloat(m[1]) * mult);
};

const shortSize = (bytes) => {
    const units = ['', 'K', 'M', 'G', 'T'];
    let v = Number(bytes), i = 0;
    while (v >= 1024 && v % 1024 === 0 && i < units.length - 1) { v /= 1024; ++i; }
    return `${v}${units[i]}`;
};

const POLICIES = [
    ['pfrd', 'Random, weighted by free space: recommended by mergerfs. Spreads new files over the disks, more on the emptier ones.'],
    ['mfs', 'Most free space: every new file goes to the emptiest disk. Disks fill evenly.'],
    ['lfs', 'Least free space: fills one disk before starting the next. Other disks can stay asleep.'],
    ['epmfs', 'Existing path, most free space: files follow their folder. Can report “no space left” while other disks are empty.'],
    ['ff', 'First found: always the first disk of the list that has room.']
];

// ext4 cannot hold a file bigger than this, and a parity is one file
const EXT4_FILE_MAX = 16 * 1024 ** 4;

const defaultPoolOptions = (policy, minfree) =>
    `cache.files=off,category.create=${policy},func.getattr=newest,dropcacheonclose=false,minfreespace=${minfree},moveonenospc=true,fsname=mergerfs,allow_other`;

const setOption = (options, key, value) => {
    const list = options.split(',').filter(o => o && o !== key && !o.startsWith(key + '='));
    list.push(`${key}=${value}`);
    return list.join(',');
};

const getOption = (options, key) => {
    const hit = (options || '').split(',').find(o => o.startsWith(key + '='));
    return hit ? hit.slice(key.length + 1) : null;
};

/** A dialog with our own buttons, on top of the modal styles of the app. */
const dialog = ({ title, body, large = true, buttons }) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-container ${large ? 'large st-dialog' : ''}">
            <div class="modal-title">${escHtml(title)}</div>
            <div class="modal-body st-dialog-body">${body}</div>
            <div class="modal-actions"></div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.offsetHeight;
    overlay.classList.add('active');

    const api = {
        overlay,
        body: overlay.querySelector('.modal-body'),
        close: () => { overlay.classList.remove('active'); setTimeout(() => overlay.remove(), 200); },
        setTitle: (t) => { overlay.querySelector('.modal-title').innerText = t; },
        setBody: (html) => { api.body.innerHTML = html; applyWidths(api.body); },
        setButtons: (list) => {
            const box = overlay.querySelector('.modal-actions');
            box.innerHTML = '';
            list.forEach(b => {
                const el = document.createElement('button');
                el.className = `btn ${b.cls || 'btn-secondary'}`;
                el.innerText = b.label;
                if (b.id) el.id = b.id;
                if (b.disabled) el.disabled = true;
                el.addEventListener('click', () => b.onClick(api, el));
                box.appendChild(el);
            });
        }
    };
    api.setButtons(buttons);
    applyWidths(api.body);
    return api;
};

/**
 * Ask before doing something, saying in plain words what is going to happen.
 * \return A promise resolving to true only when confirmed.
 */
const confirmDo = ({ title, intro, effects = [], safe = [], label = 'Confirm', danger = false }) => new Promise((resolve) => {
    dialog({
        title, large: false,
        body: `
            ${intro ? `<p class="text-sm mb-4">${intro}</p>` : ''}
            ${effects.length ? `<div class="st-effects"><div class="st-effects-title">What happens</div><ul>${effects.map(e => `<li>${e}</li>`).join('')}</ul></div>` : ''}
            ${safe.length ? `<div class="st-effects st-effects-safe"><div class="st-effects-title">What does not change</div><ul>${safe.map(e => `<li>${e}</li>`).join('')}</ul></div>` : ''}`,
        buttons: [
            { label: 'Cancel', onClick: (d) => { d.close(); resolve(false); } },
            { label, cls: danger ? 'btn-danger' : 'btn-primary', onClick: (d) => { d.close(); resolve(true); } }
        ]
    });
});

const adminGuard = () => {
    if (state.model?.inv.admin) return true;
    showToast('Read-only: set net_storage_admin = 1 in snapraidd.conf to make changes from here', 'warning');
    return false;
};

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

const renderArrayCard = (m) => {
    if (!m.configured && !m.data.length && !m.parity.length) {
        return `
            <div class="card card-border-blue">
                <h3>SnapRAID array</h3>
                <p class="text-sm text-muted mt-2 mb-4">
                    No array is configured yet. The guided setup prepares the disks, optionally joins them in a
                    mergerfs pool, and writes the SnapRAID configuration for you.
                </p>
                <button class="btn btn-primary" data-st="wizard">Start guided setup</button>
            </div>`;
    }

    const largestData = Math.max(0, ...m.data.map(d => d.total || 0));
    const row = (kind, name, path, d, actions) => `
        <tr>
            <td class="whitespace-nowrap">${kind} <span class="font-mono font-bold">${escHtml(name)}</span>
                ${state.health[name] && state.health[name] !== 'passed' ? badge(state.health[name], 'orange') : ''}</td>
            <td class="font-mono text-xs">${escHtml(path)}<div class="text-muted">${d.ok ? `${escHtml(d.mount.source)} · ${escHtml(d.mount.fstype)}` : ''}</div></td>
            <td class="st-usage-cell">${d.ok ? usageBar(d.total, d.free) : badge('not mounted', 'red')}</td>
            <td>${d.inPool ? badge('in pool', 'blue') : ''}</td>
            <td class="text-right whitespace-nowrap">${actions}</td>
        </tr>`;

    const rows = [
        ...m.parity.flatMap(p => p.files.map((f, i) => row(badge('parity', 'purple'), p.files.length > 1 ? `${p.key} ${i + 1}/${p.files.length}` : p.key, f.path, f,
            `${i === 0 && p.ok && p.total < largestData * 0.9 ? badge('smaller than a data disk', 'red') : ''}
             ${p.files.length > 1
                ? `<span class="text-xs text-muted" data-tooltip="A split parity file is replaced by mounting the new disk at the same place and running Recover">split</span>`
                : `<button class="btn btn-secondary btn-sm" data-st="replace" data-kind="parity" data-name="${escAttr(p.key)}" data-tooltip="Move this parity to another disk and rebuild it">Replace</button>`}`))),
        ...m.data.map(d => row(badge('data', 'green'), d.name, d.path, d, d.removing
            ? `${badge('removing', 'orange')} <button class="btn btn-primary btn-sm" data-st="remove-finish" data-name="${escAttr(d.name)}" data-tooltip="Once the sync has completed, drop the disk from the configuration">Finish removal</button>`
            : `<button class="btn btn-secondary btn-sm" data-st="replace" data-kind="data" data-name="${escAttr(d.name)}" data-tooltip="Rebuild the content of this disk on another one">Replace</button>
               <button class="btn btn-secondary btn-sm" data-st="remove" data-name="${escAttr(d.name)}" data-tooltip="Take this disk out of the array">Remove</button>`))
    ].join('');

    const protection = m.parity.length
        ? `Survives the loss of ${m.parity.length === 1 ? 'any one disk' : `any ${m.parity.length} disks`}.`
        : 'No parity configured: nothing is protected.';

    return `
        <div class="card">
            <div class="flex justify-between items-center flex-wrap gap-2 mb-2">
                <h3>SnapRAID array</h3>
                <button class="btn btn-primary btn-sm" data-st="wizard" data-tooltip="Add data or parity disks to the array">Add disks</button>
            </div>
            <div class="text-sm text-muted mb-4">${m.data.length} data, ${m.parity.length} parity. ${protection}
                Content files: <span class="font-mono text-xs">${m.content.map(escHtml).join(', ') || 'none'}</span></div>
            <div class="overflow-x-auto">
                <table class="data-table dense">
                    <thead><tr><th>Role</th><th>Location</th><th>Usage</th><th></th><th></th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
};

const renderPoolCard = (m) => {
    const tools = m.inv.tools || {};
    if (!m.pools.length) {
        return `
            <div class="card">
                <h3>mergerfs pool</h3>
                <p class="text-sm text-muted mt-2 mb-4">
                    A pool shows all the data disks as one folder. Files stay as plain files on each disk, so SnapRAID
                    keeps protecting them and any disk can still be read on its own.
                </p>
                ${tools.mergerfs
                    ? (m.data.length
                        ? `<button class="btn btn-primary" data-st="pool-create">Create a pool from the data disks</button>`
                        : `<div class="text-sm text-muted">The guided setup creates the pool together with the array.</div>`)
                    : `<div class="restricted-banner"><div class="restricted-banner-title">mergerfs is not installed</div>
                       Install the <code>mergerfs</code> package on this machine and reload this page.</div>`}
            </div>`;
    }

    return m.pools.map((p, idx) => {
        const policy = p.options['category.create'] || getOption(p.fstab_options, 'category.create') || 'mfs';
        const minfree = p.options.minfreespace ? shortSize(p.options.minfreespace) : (getOption(p.fstab_options, 'minfreespace') || '4G');
        const known = POLICIES.some(([k]) => k === policy);
        const dataPaths = new Set(m.data.map(d => stripSlash(d.path)));
        const rows = p.branches.map(b => `
            <tr>
                <td class="font-mono text-xs">${escHtml(b.path)}</td>
                <td>${badge(b.mode || 'RW', b.mode === 'RO' ? 'grey' : 'green')}
                    ${dataPaths.has(stripSlash(b.path)) ? badge('protected', 'blue') : badge('not in array', 'orange')}</td>
                <td class="st-usage-cell">${usageBar(b.total_bytes, b.free_bytes)}</td>
                <td class="text-right"><button class="btn btn-secondary btn-sm" data-st="pool-branch-remove" data-pool="${idx}" data-path="${escAttr(b.path)}"
                    data-tooltip="Stop showing this disk in the pool. Its files stay on the disk." ${p.branches.length > 1 ? '' : 'disabled'}>Remove</button></td>
            </tr>`).join('');
        const fills = p.branches.filter(b => b.total_bytes).map(b => (b.total_bytes - b.free_bytes) * 100 / b.total_bytes);
        const spread = fills.length ? Math.round(Math.max(...fills) - Math.min(...fills)) : 0;
        const candidates = m.data.filter(d => d.ok && !d.removing && !p.branches.some(b => stripSlash(b.path) === stripSlash(d.path)));

        return `
            <div class="card">
                <div class="flex justify-between items-center flex-wrap gap-2 mb-2">
                    <h3>mergerfs pool <span class="font-mono">${escHtml(p.mountpoint)}</span></h3>
                    <div>${p.persistent ? badge('mounted at boot', 'green') : badge('not saved in fstab', 'orange')}
                        ${p.version ? badge(`mergerfs ${p.version}`, 'grey') : ''}</div>
                </div>
                <div class="st-usage-wide mb-4">${usageBar(p.total_bytes, p.free_bytes)}</div>
                ${spread >= 30 ? `<div class="text-sm text-amber mb-4">The disks are unevenly filled (${spread} points between the fullest and the emptiest). New files follow the policy below, existing ones are not moved.</div>` : ''}
                <div class="overflow-x-auto mb-4">
                    <table class="data-table dense">
                        <thead><tr><th>Branch</th><th></th><th>Usage</th><th></th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
                ${candidates.length ? `<div class="mb-4 text-sm">Data disks outside the pool:
                    ${candidates.map(c => `<button class="btn btn-secondary btn-sm" data-st="pool-branch-add" data-pool="${idx}" data-path="${escAttr(c.path)}">Add ${escHtml(c.name)}</button>`).join(' ')}</div>` : ''}
                <div class="form-row st-form-row">
                    <div class="form-group">
                        <label for="pool-policy-${idx}">Where new files go</label>
                        <select class="form-control" id="pool-policy-${idx}">
                            ${POLICIES.map(([k]) => `<option value="${k}" ${k === policy ? 'selected' : ''}>${k}</option>`).join('')}
                            ${known ? '' : `<option value="${escAttr(policy)}" selected>${escHtml(policy)}</option>`}
                        </select>
                        <div class="text-xs text-muted mt-1" id="pool-policy-help-${idx}">${escHtml((POLICIES.find(([k]) => k === policy) || ['', ''])[1])}</div>
                    </div>
                    <div class="form-group">
                        <label for="pool-minfree-${idx}">Keep free on each disk</label>
                        <input class="form-control" id="pool-minfree-${idx}" value="${escAttr(minfree)}">
                        <div class="text-xs text-muted mt-1">A disk with less free space than this gets no new files (e.g. 20G, 500M).</div>
                    </div>
                    <div class="form-group st-form-button">
                        <button class="btn btn-primary" data-st="pool-apply" data-pool="${idx}" data-tooltip="Applied immediately, nothing is unmounted">Apply</button>
                    </div>
                </div>
            </div>`;
    }).join('');
};

const STATE_BADGE = {
    system: ['system', 'grey'], array: ['in array', 'green'], other: ['part of RAID, LVM or encryption', 'grey'],
    blank: ['blank', 'blue'], unformatted: ['no filesystem', 'blue'], mounted: ['mounted, unused', 'yellow'], unmounted: ['not mounted', 'yellow']
};

const renderDisksCard = (m) => {
    const rows = m.disks.map(d => {
        const [text, color] = STATE_BADGE[d.state];
        const fs = d.filesystems.map(f => `
            <div class="text-xs"><span class="font-mono">${escHtml(f.path)}</span> ${escHtml(f.fstype)}${f.label ? ` “${escHtml(f.label)}”` : ''}
                ${f.mount ? `→ <span class="font-mono">${escHtml(f.mount.target)}</span>` : ''}
                ${f.roles.map(r => badge(r, r.startsWith('data') ? 'green' : 'purple')).join(' ')}</div>`).join('');
        let actions = '';
        if (!d.layered && (d.state === 'blank' || d.state === 'unformatted' || d.state === 'unmounted' || d.state === 'mounted'))
            actions += `<button class="btn btn-secondary btn-sm" data-st="prepare" data-device="${escAttr(d.path)}" data-tooltip="Create a new empty filesystem on this disk and mount it">Format…</button> `;
        d.filesystems.forEach(f => {
            if (!f.mount && !f.system && f.fstype !== 'swap' && d.state === 'unmounted')
                actions += `<button class="btn btn-secondary btn-sm" data-st="mount" data-device="${escAttr(f.path)}" data-tooltip="Mount this filesystem keeping its content">Mount…</button> `;
            if (f.mount && !f.roles.length && d.state === 'mounted')
                actions += `<button class="btn btn-secondary btn-sm" data-st="unmount" data-target="${escAttr(f.mount.target)}" data-tooltip="Unmount and forget this filesystem">Unmount</button> `;
        });
        return `
            <tr>
                <td class="whitespace-nowrap"><span class="font-mono font-bold">${escHtml(d.path)}</span>
                    <div class="text-xs text-muted">${escHtml([d.model, d.serial].filter(Boolean).join(' · ') || d.transport || '')}</div></td>
                <td class="whitespace-nowrap">${size(d.size)}<div class="text-xs text-muted">${d.transport === 'loop' ? 'loop device' : d.rotational ? 'HDD' : 'SSD'}${d.removable ? ' · removable' : ''}</div></td>
                <td>${badge(text, color)}${d.layered && d.filesystems.length ? '<div class="text-xs text-muted mt-1">through RAID, LVM or encryption</div>' : ''}</td>
                <td>${fs || '<span class="text-xs text-muted">nothing on it</span>'}</td>
                <td class="text-right whitespace-nowrap">${actions}</td>
            </tr>`;
    }).join('');

    return `
        <div class="card">
            <h3>Disks</h3>
            <div class="text-sm text-muted mt-2 mb-4">Every disk this machine sees. Disks marked blank or unused can be taken by the guided setup.</div>
            <div class="overflow-x-auto">
                <table class="data-table dense">
                    <thead><tr><th>Disk</th><th>Size</th><th>State</th><th>Filesystems</th><th></th></tr></thead>
                    <tbody>${rows || '<tr><td colspan="5" class="text-muted">No disks reported. Is lsblk installed?</td></tr>'}</tbody>
                </table>
            </div>
        </div>`;
};

const renderConfCard = (m) => {
    const filters = m.conf.filter(e => e.type === 'filter').map(e => `${e.key} ${e.pattern}`).join('\n');
    const opt = (k) => confOption(m.conf, k);
    return `
        <div class="card">
            <div class="flex justify-between items-center flex-wrap gap-2 mb-2">
                <h3>SnapRAID configuration</h3>
                <span class="font-mono text-xs text-muted">${escHtml(m.inv.engine_conf?.path || '')}</span>
            </div>
            <div class="grid-2">
                <div>
                    <div class="form-group">
                        <label for="conf-filters">Files to leave out or to keep</label>
                        <div class="text-xs text-muted mb-2">One rule per line, first match wins: <code>exclude *.tmp</code>, <code>exclude /downloads/</code>, <code>include /photos/</code>.</div>
                        <textarea id="conf-filters" class="form-control font-mono text-sm" rows="9" spellcheck="false">${escHtml(filters)}</textarea>
                        <button class="btn btn-secondary btn-sm mt-2" data-st="conf-defaults" data-tooltip="Add the usual temporary and system files to the list">Add common excludes</button>
                    </div>
                </div>
                <div>
                    <div class="form-group">
                        <label for="conf-content">Content files</label>
                        <div class="text-xs text-muted mb-2">The index of the array, one path per line. Keep copies on different disks: at least one more than the parity disks.</div>
                        <textarea id="conf-content" class="form-control font-mono text-sm" rows="4" spellcheck="false">${escHtml(m.content.join('\n'))}</textarea>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label for="conf-autosave">Autosave (GB)</label>
                            <input id="conf-autosave" class="form-control" inputmode="numeric" value="${escAttr(opt('autosave')?.value || '')}" placeholder="off">
                            <div class="text-xs text-muted mt-1">Save progress during long syncs every this many GB.</div>
                        </div>
                        <div class="form-group">
                            <label for="conf-blocksize">Block size (KiB)</label>
                            <input id="conf-blocksize" class="form-control" inputmode="numeric" value="${escAttr(opt('blocksize')?.value || '')}" placeholder="256" ${m.configured ? 'disabled' : ''}>
                            <div class="text-xs text-muted mt-1">Fixed once the array has been synced.</div>
                        </div>
                    </div>
                    <div class="form-group">
                        <div class="flex items-center gap-4">
                            <label class="switch"><input type="checkbox" id="conf-nohidden" ${opt('nohidden') ? 'checked' : ''}><span class="slider"></span></label>
                            <label for="conf-nohidden" class="mb-0 cursor-pointer font-bold">Skip hidden files</label>
                        </div>
                    </div>
                    <button class="btn btn-primary" data-st="conf-save">Save configuration</button>
                    <button class="btn btn-secondary" data-st="conf-raw" data-tooltip="Edit the configuration file as text">Edit as text</button>
                </div>
            </div>
        </div>`;
};

/* ------------------------------------------------------------------ */
/* layout diagram                                                      */
/* ------------------------------------------------------------------ */

/** What the diagram draws, taken from the current state. */
const layoutOf = (m) => ({
    pools: m.pools.map(p => ({ mountpoint: p.mountpoint, policy: p.options['category.create'] || '', total: p.total_bytes, free: p.free_bytes, branches: p.branches.map(b => stripSlash(b.path)) })),
    data: m.data.map(d => ({ name: d.name, path: stripSlash(d.path), total: d.total, free: d.free, missing: !d.ok, removing: d.removing, health: state.health[d.name] })),
    parity: m.parity.flatMap(p => p.files.map((f, i) => ({ name: p.files.length > 1 ? `${p.key} ${i + 1}/${p.files.length}` : p.key, level: p.key, total: f.total, free: f.free, missing: !f.ok, health: state.health[p.key] }))),
    spare: m.disks.filter(d => ['blank', 'unformatted', 'mounted', 'unmounted'].includes(d.state)).map(d => ({ name: d.path.replace('/dev/', ''), total: d.size, state: d.state }))
});

const diskTile = (role, d) => {
    const pct = d.total && d.free != null ? Math.min(100, Math.round((d.total - d.free) * 100 / d.total)) : 0;
    const bad = d.missing || (d.health && !['passed', 'pending'].includes(d.health));
    const note = d.missing ? 'not mounted' : d.removing ? 'being removed' : d.isNew ? 'new' : role === 'spare'
        ? ({ blank: 'blank', unformatted: 'blank', mounted: 'unused', unmounted: 'unused' }[d.state])
        : (d.free != null ? `${pct}% full` : '');
    return `
        <div class="tp-tile tp-${role} ${d.isNew ? 'tp-new' : ''} ${bad ? 'tp-bad' : ''}" data-tooltip="${escAttr(`${d.name}${d.path ? ` · ${d.path}` : ''} · ${size(d.total)}${d.free != null ? ` · ${size(d.free)} free` : ''}${d.health && d.health !== 'passed' ? ` · health ${d.health}` : ''}`)}">
            <div class="tp-gauge"><div class="tp-gauge-fill ${pct >= 90 ? 'st-bar-red' : pct >= 75 ? 'st-bar-amber' : ''}" data-height="${role === 'spare' ? 0 : pct}"></div></div>
            <div class="tp-name">${escHtml(d.name)}</div>
            <div class="tp-size">${size(d.total)}</div>
            <div class="tp-note">${escHtml(note || ' ')}</div>
        </div>`;
};

/**
 * The array at a glance: the pool on top of its data disks, the parity
 * disks protecting them, and what is still unused.
 */
const renderDiagram = (l) => {
    const pooled = (pool) => l.data.filter(d => pool.branches.includes(d.path));
    const loose = l.data.filter(d => !l.pools.some(p => p.branches.includes(d.path)));
    const k = new Set(l.parity.map(p => p.level || p.name)).size;
    const groups = [];
    const dense = l.data.length + l.parity.length + (l.spare || []).length > 16;

    l.pools.forEach(pool => {
        const members = pooled(pool);
        const foreign = pool.branches.filter(b => !l.data.some(d => d.path === b));
        groups.push(`
            <div class="tp-group">
                <div class="tp-pool">
                    <div class="tp-pool-title">Pool <span class="font-mono">${escHtml(pool.mountpoint)}</span></div>
                    <div class="tp-pool-sub">one folder for ${plural(pool.branches.length, 'disk', 'disks')}${pool.total ? ` · ${size(pool.free)} free of ${size(pool.total)}` : ''}${pool.policy ? ` · new files: ${escHtml(pool.policy)}` : ''}</div>
                </div>
                <div class="tp-tiles tp-stems">
                    ${members.map(d => diskTile('data', d)).join('')}
                    ${foreign.map(b => diskTile('foreign', { name: b.split('/').pop(), path: b, total: null, free: null })).join('')}
                </div>
                <div class="tp-caption">Data disks${foreign.length ? ' · dashed ones are in the pool but not protected' : ''}</div>
            </div>`);
    });

    if (loose.length) {
        groups.push(`
            <div class="tp-group">
                ${l.pools.length ? '<div class="tp-pool tp-pool-none"><div class="tp-pool-title">Outside the pool</div><div class="tp-pool-sub">used through their own folder</div></div>' : ''}
                <div class="tp-tiles">${loose.map(d => diskTile('data', d)).join('')}</div>
                <div class="tp-caption">Data disks</div>
            </div>`);
    }

    groups.push(`
        <div class="tp-link ${k ? '' : 'tp-link-off'}">
            <div class="tp-shield">${k ? '&#128737;' : '&#9888;'}</div>
            <div>${k ? `protected by` : 'not protected'}</div>
        </div>`);

    groups.push(`
        <div class="tp-group">
            <div class="tp-tiles">${l.parity.map(p => diskTile('parity', p)).join('') || '<div class="tp-empty">no parity disk</div>'}</div>
            <div class="tp-caption">${k ? `Parity · any ${k === 1 ? 'one disk' : `${k} disks`} can fail` : 'Parity'}</div>
        </div>`);

    if (l.spare && l.spare.length) {
        groups.push(`
            <div class="tp-group tp-group-spare">
                <div class="tp-tiles">${l.spare.map(d => diskTile('spare', d)).join('')}</div>
                <div class="tp-caption">Not used yet</div>
            </div>`);
    }

    return `<div class="tp ${dense ? 'tp-dense' : ''}">${groups.join('')}</div>`;
};

/* ------------------------------------------------------------------ */
/* advisor                                                             */
/* ------------------------------------------------------------------ */

/**
 * Look at the whole setup like an experienced admin would, and say in plain
 * words what deserves attention, most serious first.
 */
const advise = (m) => {
    const out = [];
    const add = (level, title, text, action) => out.push({ level, title, text, action });
    const tools = m.inv.tools || {};
    const free = candidates(m);
    const blank = free.filter(c => c.kind === 'blank');

    if (!m.data.length && !m.parity.length) {
        add('tip', 'Nothing is set up yet', free.length
            ? `${plural(free.length, 'disk is', 'disks are')} ready to use. The guided setup takes it from here: you only choose which disks hold data and which hold parity.`
            : 'No free disk was found. Connect the disks you want to use and reload this page.',
            free.length ? { label: 'Start guided setup', st: 'wizard' } : null);
        if (!tools.mergerfs) add('tip', 'mergerfs is not installed', 'Without it every disk is a separate folder. Install the mergerfs package if you prefer one big folder across all the data disks.');
        return out;
    }

    if (['degraded', 'prefail', 'failing'].includes(state.array.health) && (state.changed.length || state.array.health === 'degraded'))
        add('bad', `The array is ${state.array.health}`,
            `${state.array.health_reason || ''} Maintenance is suspended until this is solved. If a disk was replaced or reformatted, the recovery rebuilds it and brings the array back.`,
            { label: 'Recover…', st: 'recover' });

    // SnapRAID keeps the hashes of every block in memory
    if (state.system?.memory_total_bytes && m.data.length) {
        const bs = (Number(confOption(m.conf, 'blocksize')?.value) || 256) * 1024;
        const hs = Number(confOption(m.conf, 'hashsize')?.value) || 16;
        const ram = m.data.reduce((a, d) => a + (d.total || 0), 0) * (1 + hs) / bs;
        if (ram > state.system.memory_total_bytes * 0.5)
            add('warn', 'The array is large for the memory of this machine',
                `A sync needs about ${size(ram)} of RAM for ${size(m.data.reduce((a, d) => a + (d.total || 0), 0))} of data, and this machine has ${size(state.system.memory_total_bytes)}. Add memory, or see “hashsize” in the SnapRAID manual before the array grows.`);
    }
    if (m.data.length > MAX_DATA)
        add('bad', 'Too many data disks', `SnapRAID handles up to ${MAX_DATA} data disks, this configuration has ${m.data.length}.`);

    // ---- the classic ways to lose the protection without noticing
    const fsOf = (path) => m.mountOf(path)?.target;
    m.data.filter(d => d.onPool).forEach(d => add('bad', `${d.name} points to the pool`,
        `SnapRAID must see each disk on its own. ${d.path} is the merged folder, so every file would be counted on this disk too. Point ${d.name} to the folder of the disk itself.`,
        { label: 'Edit configuration', st: 'tab', data: { tab: 'config' } }));
    m.parity.forEach(p => p.files.forEach(f => {
        if (f.onPool)
            add('bad', `${p.key} is inside the pool`, `${f.path} is in the merged folder: the parity would land on a data disk and protect nothing. Keep parity on its own disk, outside the pool.`, { label: 'Edit configuration', st: 'tab', data: { tab: 'config' } });
        const sharing = m.data.filter(d => d.ok && f.ok && fsOf(d.path) === fsOf(f.path));
        if (sharing.length)
            add('bad', `${p.key} shares a disk with ${sharing.map(d => d.name).join(', ')}`, `Parity and data on the same disk are lost together. Move ${f.path} to a disk of its own.`);
        m.pools.filter(pool => f.ok && pool.branches.some(b => fsOf(b.path) === fsOf(f.path))).forEach(pool =>
            add('bad', `The parity disk is part of the pool ${pool.mountpoint}`, `New files written to the pool end on the parity disk, the parity cannot grow and syncs start failing. Take ${f.mount.target} out of the pool.`, { label: 'Open the pool', st: 'tab', data: { tab: 'pool' } }));
    }));
    m.content.filter(c => m.poolTargets.has(fsOf(c))).forEach(c => add('bad', 'A content file is inside the pool', `${c} would be written to whatever disk the pool picks. Give it a fixed place on a disk folder.`, { label: 'Edit configuration', st: 'tab', data: { tab: 'config' } }));
    const byFs = {};
    m.data.filter(d => d.ok).forEach(d => { (byFs[fsOf(d.path)] = byFs[fsOf(d.path)] || []).push(d.name); });
    Object.entries(byFs).filter(([, names]) => names.length > 1).forEach(([fs, names]) =>
        add('bad', `${names.join(' and ')} are on the same disk`, `Both are folders of ${fs}: one failure takes both, and the parity can rebuild only one disk per level.`));

    // a filesystem that hit errors is remounted read-only by the kernel
    [...m.data.map(d => ({ name: d.name, mount: d.mount, ok: d.ok })), ...m.parity.flatMap(p => p.files.map(f => ({ name: p.key, mount: f.mount, ok: f.ok })))]
        .filter(d => d.ok && d.mount.options.split(',').includes('ro'))
        .forEach(d => add('bad', `${d.name} is read-only`, `${d.mount.target} is mounted read-only, usually because the filesystem found errors. Check the disk (SMART, fsck) before trusting it.`));

    // what is mounted now but not at the next boot, and what can block the boot
    const fstabOf = (target) => (m.inv.fstab || []).find(e => stripSlash(e.target) === target);
    const arrayMounts = [...new Set([...m.data.filter(d => d.ok).map(d => d.mount.target), ...m.parity.flatMap(p => p.files.filter(f => f.ok).map(f => f.mount.target))])];
    const unsaved = arrayMounts.filter(t => !fstabOf(t));
    if (unsaved.length && (m.inv.fstab || []).length)
        add('warn', `${plural(unsaved.length, 'disk is', 'disks are')} not mounted at boot`, `${unsaved.join(', ')} ${unsaved.length === 1 ? 'has' : 'have'} no entry in /etc/fstab: after a reboot the folder is empty, and a sync would see the disk as wiped.`);
    const strict = arrayMounts.filter(t => fstabOf(t) && !fstabOf(t).options.split(',').includes('nofail'));
    if (strict.length)
        add('tip', 'A dead disk can stop the boot', `${strict.join(', ')} ${strict.length === 1 ? 'is' : 'are'} mounted without the “nofail” option: if the disk dies the machine waits for it at boot. Add nofail in /etc/fstab.`);

    m.parity.forEach(p => {
        if (p.files.length === 1 && p.files[0].ok && p.files[0].mount.fstype === 'ext4' && p.total > EXT4_FILE_MAX)
            add('warn', `${p.key} cannot use its whole disk`, 'ext4 holds files up to 16 TiB and the parity is a single file. With data disks beyond that size, move the parity to xfs or split it over two disks.');
        const fullest = Math.max(0, ...m.data.filter(d => d.ok).map(d => d.total - d.free));
        if (p.ok && fullest > p.total * 0.97)
            add('warn', `${p.key} is about to be full`, `The fullest data disk holds ${size(fullest)} and ${p.key} has ${size(p.total)}. When the parity is full the sync fails: free space on that data disk or use a larger parity.`);
    });

    const uuids = {};
    (m.inv.blkid || []).filter(b => b.uuid && b.fstype && !MEMBER_TYPES.includes(b.fstype)).forEach(b => { (uuids[b.uuid] = uuids[b.uuid] || []).push(b.device); });
    Object.values(uuids).filter(devs => devs.length > 1).forEach(devs =>
        add('warn', 'Two filesystems have the same UUID', `${devs.join(' and ')} are identical copies (a cloned disk). Mounts by UUID can pick the wrong one: disconnect the old disk, or give the copy a new UUID (tune2fs -U random, xfs_admin -U generate).`));

    m.pools.forEach(pool => {
        const policy = pool.options['category.create'] || '';
        if (policy.startsWith('ep'))
            add('tip', `The pool can report “no space left” with space free`, `With the “${policy}” policy a file can only go to a disk that already has its folder. When those disks are full the write fails even if others are empty. Use pfrd or mfs unless you want folders kept together.`, { label: 'Open the pool', st: 'tab', data: { tab: 'pool' } });
        if (pool.options.moveonenospc === 'false')
            add('tip', 'A file growing on a full disk will fail', 'The pool option “moveonenospc” is off: when a disk fills up while a file is being written, the write fails instead of moving the file to another disk.');
    });
    if (m.configured && !m.conf.some(e => e.type === 'filter'))
        add('tip', 'Nothing is excluded', 'Temporary files, downloads in progress and application data change during a sync and make it fail. Exclude them in the configuration.', { label: 'Edit configuration', st: 'tab', data: { tab: 'config' } });

    const notMounted = [...m.data, ...m.parity].filter(d => !d.ok && !d.onPool && !d.removing);
    notMounted.forEach(d => add('bad', `${d.name || d.key} is not mounted`,
        `Its folder is empty because the disk is missing or failed to mount. Do not sync in this state. If the disk is dead, replace it and its content is rebuilt from the others.`,
        { label: 'Replace it', st: 'replace', data: { kind: d.key ? 'parity' : 'data', name: d.name || d.key } }));

    if (!m.parity.length)
        add('bad', 'No parity disk', 'Nothing protects the data: a single disk failure loses everything on that disk. Add a disk at least as large as your largest data disk and use it as parity.', { label: 'Add disks', st: 'wizard' });

    const largest = Math.max(0, ...m.data.map(d => d.total || 0));
    m.parity.filter(p => p.ok && p.total < largest * 0.9).forEach(p => add('bad', `${p.key} is smaller than a data disk`,
        `Parity must be at least as large as the largest data disk (${size(largest)}), or the sync stops when it fills up.`,
        { label: 'Replace it', st: 'replace', data: { kind: 'parity', name: p.key } }));

    const live = m.data.filter(d => !d.removing);
    const want = recommendedParity(live.length);
    if (m.parity.length && m.parity.length < want)
        add('warn', `${plural(live.length, 'data disk', 'data disks')} with ${plural(m.parity.length, 'parity disk', 'parity disks')}`,
            `With this many disks the chance of two failing close together is real. SnapRAID's guideline for ${live.length} data disks is ${want} parity disks.`, { label: 'Add disks', st: 'wizard' });

    const contentDisks = new Set(m.content.map(c => m.mountOf(c)?.target)).size;
    if (m.parity.length && contentDisks < m.parity.length + 1)
        add('warn', 'Too few content files', `The content file is the index of the array. Keep ${m.parity.length + 1} copies on different disks, so that it survives the same failures the parity covers. You have ${plural(m.content.length, 'copy', 'copies')} on ${plural(contentDisks, 'disk', 'disks')}.`,
            { label: 'Edit configuration', st: 'tab', data: { tab: 'config' } });

    m.data.filter(d => d.removing).forEach(d => add('tip', `${d.name} is being removed`, 'When the sync has completed, finish the removal to drop it from the configuration.',
        { label: 'Finish removal', st: 'remove-finish', data: { name: d.name } }));

    m.pools.forEach(p => {
        if (!p.persistent) add('warn', `The pool ${p.mountpoint} is not saved`, 'It works now but disappears at the next reboot. Press Apply in the Pool tab to save it.', { label: 'Open the pool', st: 'tab', data: { tab: 'pool' } });
        const foreign = p.branches.filter(b => !m.data.some(d => stripSlash(d.path) === stripSlash(b.path)));
        if (foreign.length) add('warn', 'Part of the pool is not protected', `${foreign.map(b => b.path).join(', ')} ${foreign.length === 1 ? 'is' : 'are'} in the pool but not in the array: files landing there have no parity.`, { label: 'Open the pool', st: 'tab', data: { tab: 'pool' } });
        const outside = live.filter(d => d.ok && !p.branches.some(b => stripSlash(b.path) === stripSlash(d.path)));
        if (outside.length && m.pools.length === 1) add('tip', `${outside.map(d => d.name).join(', ')} not in the pool`, 'Protected by the array, but its space does not show up in the pool folder.', { label: 'Open the pool', st: 'tab', data: { tab: 'pool' } });
        const fills = p.branches.filter(b => b.total_bytes).map(b => (b.total_bytes - b.free_bytes) * 100 / b.total_bytes);
        if (fills.length > 1 && Math.max(...fills) - Math.min(...fills) >= 40)
            add('tip', 'The disks are unevenly filled', 'Normal after adding an empty disk. With the “mfs” policy new files go to the emptiest disk and the levels even out over time.');
    });
    if (!m.pools.length && live.length > 1)
        add('tip', 'No pool', tools.mergerfs ? 'Each data disk is a separate folder. A mergerfs pool shows them as one, without moving any file.' : 'Each data disk is a separate folder. Install the mergerfs package to join them in one.',
            tools.mergerfs ? { label: 'Create a pool', st: 'pool-create' } : null);

    live.filter(d => d.ok && d.total && d.free / d.total < 0.05).forEach(d => add('warn', `${d.name} is almost full`, `${size(d.free)} left. ${m.pools.length ? 'The pool sends new files to the other disks, but files growing in place can still fail.' : 'Move something to another disk or add one.'}`));

    Object.entries(state.health).filter(([, h]) => ['prefail', 'failing'].includes(h)).forEach(([name, h]) => {
        const isParity = m.parity.some(p => p.key === name);
        add('bad', `${name} is ${h === 'failing' ? 'failing' : 'showing signs of failure'}`, 'Its SMART data reports problems. Replace it while it still works: the copy is rebuilt from the other disks.',
            { label: 'Replace it', st: 'replace', data: { kind: isParity ? 'parity' : 'data', name } });
    });

    if (blank.length) add('tip', `${plural(blank.length, 'blank disk', 'blank disks')} available`, 'Use them to grow the array, as extra parity, or keep them as spares ready for a replacement.', { label: 'Add disks', st: 'wizard' });
    if (!m.inv.admin) add('tip', 'Read-only mode', `This page can show everything but change nothing. ${m.inv.admin_reason || ''}`);

    if (!out.some(f => f.level === 'bad' || f.level === 'warn'))
        out.unshift({ level: 'ok', title: 'Everything looks right', text: `The array is protected against the loss of ${m.parity.length === 1 ? 'any one disk' : `any ${m.parity.length} disks`}.` });

    const order = { bad: 0, warn: 1, ok: 2, tip: 3 };
    return out.sort((a, b) => order[a.level] - order[b.level]);
};

const renderAdvisor = (m) => {
    const marks = { bad: '!', warn: '!', ok: '✓', tip: 'i' };
    return `
        <div class="card">
            <h3>Advisor</h3>
            <div class="text-sm text-muted mt-2 mb-4">What deserves your attention, most important first.</div>
            <div class="st-findings">
                ${advise(m).map(f => `
                    <div class="st-finding st-finding-${f.level}">
                        <span class="st-finding-mark">${marks[f.level]}</span>
                        <div class="flex-1"><div class="font-bold">${escHtml(f.title)}</div><div class="text-sm">${escHtml(f.text)}</div></div>
                        ${f.action ? `<button class="btn btn-secondary btn-sm" data-st="${f.action.st}" ${Object.entries(f.action.data || {}).map(([k, v]) => `data-${k}="${escAttr(v)}"`).join(' ')}>${escHtml(f.action.label)}</button>` : ''}
                    </div>`).join('')}
            </div>
        </div>`;
};

const renderOverview = (m) => {
    const live = m.data.filter(d => d.ok);
    const usable = live.reduce((a, d) => a + d.total, 0);
    const used = live.reduce((a, d) => a + (d.total - d.free), 0);
    const parityBytes = m.parity.filter(p => p.ok).reduce((a, p) => a + p.total, 0);
    const k = m.parity.length;
    const stat = (label, value, sub) => `<div class="st-stat"><div class="st-stat-label">${label}</div><div class="st-stat-value">${value}</div><div class="st-stat-sub">${sub}</div></div>`;
    const empty = !m.data.length && !m.parity.length;

    return `
        ${empty ? '' : `
        <div class="st-stats">
            ${stat('Usable space', size(usable), `${size(usable - used)} free`)}
            ${stat('Protection', k ? `${plural(k, 'disk', 'disks')}` : 'none', k ? 'can fail without losing data' : 'no parity configured')}
            ${stat('Disks', `${m.data.length} + ${k}`, `data + parity${parityBytes && usable ? ` · ${Math.round(parityBytes * 100 / (parityBytes + usable))}% of the space is parity` : ''}`)}
            ${stat('Pool', m.pools.length ? escHtml(m.pools[0].mountpoint) : 'none', m.pools.length ? 'one folder for all the data' : 'each disk is its own folder')}
        </div>`}
        <div class="card">
            <div class="flex justify-between items-center flex-wrap gap-2 mb-2">
                <h3>Layout</h3>
                <div class="tp-legend"><span class="tp-key tp-key-data"></span>data <span class="tp-key tp-key-parity"></span>parity <span class="tp-key tp-key-spare"></span>unused</div>
            </div>
            <div class="text-sm text-muted mb-4">${empty
                ? 'These are the disks found on this machine. Once set up, this picture shows how they work together.'
                : 'Every column is a disk, filled up to how full it is. Files live on the data disks; the parity disks hold what is needed to rebuild any of them.'}</div>
            ${renderDiagram(layoutOf(m))}
        </div>
        ${renderAdvisor(m)}`;
};

const TABS = [['overview', 'Overview'], ['array', 'Array & disks'], ['pool', 'Pool'], ['config', 'Configuration']];

const render = () => {
    const m = state.model;
    const inv = m.inv;
    if (!inv.supported) {
        state.view.innerHTML = `<div class="card"><h3>Storage</h3><p class="text-muted mt-2">Disk setup is available only when the daemon runs on Linux.</p></div>`;
        return;
    }
    state.view.innerHTML = `
        <div class="fade-in st-page">
            ${inv.admin ? '' : `
            <div class="restricted-banner">
                <div class="restricted-banner-title">Read-only</div>
                ${escHtml(inv.admin_reason || 'Changing disks, mounts, pools and the SnapRAID configuration from here is disabled.')}
            </div>`}
            <div class="st-tabs">
                ${TABS.map(([k, label]) => `<button class="st-tab ${state.tab === k ? 'active' : ''}" data-st="tab" data-tab="${k}">${label}</button>`).join('')}
            </div>
            ${state.tab === 'overview' ? renderOverview(m) : ''}
            ${state.tab === 'array' ? renderArrayCard(m) + renderDisksCard(m) : ''}
            ${state.tab === 'pool' ? renderPoolCard(m) + (m.pools.length ? renderToolsCard(m, m.pools[0], 0) : '') : ''}
            ${state.tab === 'config' ? renderConfCard(m) : ''}
        </div>`;
    applyWidths(state.view);
};

export const loadStorage = async (view) => {
    state.view = view || state.view;
    const [inv, disks, array, system] = await Promise.all([StorageAPI.get(), API.getDisks().catch(() => null), API.getState().catch(() => null), API.getSystem().catch(() => null)]);
    state.health = {};
    state.changed = [];
    if (disks) {
        [...(disks.data_disks || []), ...(disks.parity_disks || [])].forEach(d => {
            state.health[d.name] = d.health;
            // a filesystem different than the one recorded at the last sync
            if ((d.splits || []).some(sp => sp.stored_uuid && sp.uuid !== sp.stored_uuid)) state.changed.push(d.name);
        });
    }
    state.array = array || {};
    state.system = system;
    state.model = buildModel(inv);
    render();
    if (inv.job?.running) watchJob();
};

const reload = async () => {
    try { await loadStorage(); } catch (e) { showToast('Failed to reload: ' + e.message, 'error'); }
};

/** Ask the daemon to read the configuration again, optionally running commands after. */
const afterConfChange = async (tasks = []) => {
    try {
        await API.schedule([{ command: 'probe' }, ...tasks]);
    } catch (e) {
        showToast('Saved, but the daemon is busy: ' + e.message, 'warning');
    }
};

/* ------------------------------------------------------------------ */
/* step runner                                                         */
/* ------------------------------------------------------------------ */

/**
 * Show a list of steps, run them one after the other and stop at the first failure.
 * Each step is { title, detail, danger, run }.
 */
const runSteps = async (dlg, steps, doneText) => {
    const draw = (status, error) => {
        dlg.setBody(`
            <ol class="st-steps">
                ${steps.map((s, i) => `
                    <li class="st-step st-step-${status[i]}">
                        <span class="st-step-mark">${{ todo: '○', run: '…', ok: '✓', fail: '✕' }[status[i]]}</span>
                        <div><div class="font-bold">${escHtml(s.title)}</div>
                            ${s.detail ? `<div class="text-xs text-muted font-mono">${escHtml(s.detail)}</div>` : ''}
                            ${status[i] === 'fail' ? `<div class="text-sm text-red mt-1">${escHtml(error)}</div>` : ''}</div>
                    </li>`).join('')}
            </ol>`);
    };
    const status = steps.map(() => 'todo');
    dlg.setButtons([{ label: 'Working…', disabled: true, onClick: () => { } }]);
    for (let i = 0; i < steps.length; ++i) {
        status[i] = 'run';
        draw(status);
        try {
            await steps[i].run();
            status[i] = 'ok';
        } catch (e) {
            status[i] = 'fail';
            draw(status, e.message);
            dlg.setButtons([{ label: 'Close', onClick: (d) => { d.close(); reload(); } }]);
            dlg.body.insertAdjacentHTML('beforeend', `<p class="text-sm mt-4">Stopped here. The steps marked ✓ are done and stay in place; fix the problem and run the setup again for the rest.</p>`);
            return false;
        }
    }
    draw(status);
    dlg.body.insertAdjacentHTML('beforeend', `<p class="text-sm mt-4 text-emerald">${escHtml(doneText)}</p>`);
    dlg.setButtons([{ label: 'Done', cls: 'btn-primary', onClick: (d) => { d.close(); reload(); } }]);
    return true;
};

const stepList = (steps) => `
    <ol class="st-steps">
        ${steps.map(s => `
            <li class="st-step ${s.danger ? 'st-step-danger' : ''}">
                <span class="st-step-mark">${s.danger ? '!' : '○'}</span>
                <div><div class="font-bold">${escHtml(s.title)}</div>${s.detail ? `<div class="text-xs text-muted font-mono">${escHtml(s.detail)}</div>` : ''}</div>
            </li>`).join('')}
    </ol>`;

/** The typed confirmation required before anything gets erased. */
const eraseConfirm = (steps) => steps.some(s => s.danger) ? `
    <div class="restricted-banner st-danger mt-4">
        <div class="restricted-banner-title">This erases disks</div>
        Everything on the disks marked with ! is destroyed and cannot be recovered. Type <code>ERASE</code> to go on.
        <input class="form-control mt-2" id="st-erase" autocomplete="off" spellcheck="false">
    </div>` : '';

const eraseOk = (dlg, steps) => !steps.some(s => s.danger) || dlg.body.querySelector('#st-erase')?.value.trim() === 'ERASE';

/* ------------------------------------------------------------------ */
/* guided setup                                                        */
/* ------------------------------------------------------------------ */

const fsChoices = (tools) => [['ext4', tools.mkfs_ext4], ['xfs', tools.mkfs_xfs], ['btrfs', tools.mkfs_btrfs]].filter(([, ok]) => ok).map(([k]) => k);

const mountOptions = () => 'defaults,noatime,nofail';

/** Everything the setup can take: blank disks and filesystems nobody uses. */
const candidates = (m) => {
    const list = [];
    m.disks.forEach(d => {
        if (d.state === 'blank' || d.state === 'unformatted') {
            list.push({ id: d.path, kind: 'blank', disk: d, size: d.size, title: d.path, sub: [d.model, d.serial, d.transport === 'usb' ? 'USB: may disconnect under load' : ''].filter(Boolean).join(' · ') || 'empty disk', note: 'will be formatted' });
        } else if (d.state === 'unmounted' || d.state === 'mounted') {
            d.filesystems.filter(f => !f.roles.length && f.fstype !== 'swap').forEach(f => {
                list.push({
                    id: f.path, kind: 'fs', disk: d, fs: f, size: f.mount?.total_bytes || f.size, title: f.path,
                    sub: `${f.fstype}${f.label ? ` “${f.label}”` : ''}${f.mount ? ` on ${f.mount.target}` : ''}`,
                    note: 'content is kept'
                });
            });
        }
    });
    const ids = new Set();
    return list.filter(c => !ids.has(c.id) && ids.add(c.id));
};

const nextName = (used, prefix) => {
    for (let i = 1; ; ++i) {
        if (!used.has(`${prefix}${i}`)) { used.add(`${prefix}${i}`); return `${prefix}${i}`; }
    }
};

/**
 * Turn the choices of the wizard into the list of steps and the new configuration.
 */
const isParityRole = (r) => /^p[0-5]$/.test(r || '');

const buildPlan = (m, w) => {
    const conf = parseConf(serializeConf(m.conf));
    const usedNames = new Set(m.data.map(d => d.name));
    const usedTargets = new Set([...m.mounts.map(x => x.target), ...(m.inv.fstab || []).map(x => x.target)]);
    const steps = [];
    const newData = [];
    const newParity = [];
    const errors = [];
    const base = stripSlash(w.base);
    const splits = {};
    m.parity.forEach(p => { splits[p.key] = p.paths.length; });
    let newLevel = false;

    const chosen = w.cands.filter(c => w.roles[c.id] && w.roles[c.id] !== 'ignore');
    // parity first and by level, so that the steps read in a natural order
    const rank = (c) => (isParityRole(w.roles[c.id]) ? Number(w.roles[c.id][1]) : 9);
    chosen.sort((a, b) => rank(a) - rank(b));

    chosen.forEach(c => {
        const role = isParityRole(w.roles[c.id]) ? 'parity' : 'data';
        let name, parityKey;
        if (role === 'data') {
            name = nextName(usedNames, 'disk');
        } else {
            const level = Number(w.roles[c.id][1]);
            parityKey = PARITY_KEYS[level];
            const n = splits[parityKey] || 0;
            splits[parityKey] = n + 1;
            name = n === 0 ? `parity${level + 1}` : `parity${level + 1}-${n + 1}`;
        }

        let target;
        if (c.kind === 'fs' && c.fs.mount) {
            target = c.fs.mount.target;
        } else {
            target = `${base}/${name}`;
            for (let i = 2; usedTargets.has(target); ++i) target = `${base}/${name}-${i}`;
            usedTargets.add(target);
            if (c.kind === 'blank') {
                steps.push({
                    title: `Format ${c.id} as ${w.fstype} for ${role === 'data' ? `data disk ${name}` : parityKey}`,
                    detail: `${size(c.size)} · label ${name}`, danger: true,
                    run: async () => {
                        const res = await StorageAPI.format(c.id, w.fstype, name, role, false);
                        c.uuid = res.uuid; c.partition = res.partition;
                    }
                });
                steps.push({
                    title: `Mount it at ${target}, now and at every boot`, detail: `${w.fstype} · ${mountOptions()}`,
                    run: () => StorageAPI.mount(c.uuid ? `UUID=${c.uuid}` : c.partition, target, w.fstype, mountOptions())
                });
            } else {
                steps.push({
                    title: `Mount ${c.id} at ${target}, now and at every boot`, detail: `${c.fs.fstype} · content is kept`,
                    run: () => StorageAPI.mount(c.fs.uuid ? `UUID=${c.fs.uuid}` : c.id, target, c.fs.fstype, mountOptions())
                });
            }
        }

        const usable = c.kind === 'blank' ? c.size * 0.93 : c.size;
        if (role === 'data') {
            confInsert(conf, { type: 'data', key: 'data', name, path: target });
            newData.push({ name, path: target, size: c.size });
        } else {
            const file = `${target}/snapraid.${parityKey}`;
            const existing = conf.find(e => e.type === 'parity' && e.key === parityKey);
            if (existing) {
                existing.paths.push(file);
            } else {
                confInsert(conf, { type: 'parity', key: parityKey, paths: [file] });
                if (m.configured) newLevel = true;
            }
            newParity.push({ key: parityKey, size: c.size, usable });
        }
    });

    // keep the parity lines in level order
    const parityLines = conf.filter(e => e.type === 'parity').sort((a, b) => PARITY_KEYS.indexOf(a.key) - PARITY_KEYS.indexOf(b.key));
    let pi = 0;
    conf.forEach((e, i) => { if (e.type === 'parity') conf[i] = parityLines[pi++]; });

    // content files: on the system disk and on data disks, one more than the parity levels
    const parityCount = parityLines.length;
    const dataAll = conf.filter(e => e.type === 'data');
    const contents = conf.filter(e => e.type === 'content');
    if (!contents.length) {
        const confPath = m.inv.engine_conf.path;
        confInsert(conf, { type: 'content', path: confPath === '/etc/snapraid.conf' ? '/var/snapraid.content' : `${dirname(confPath)}/snapraid.content` });
    }
    dataAll.forEach(d => {
        const have = conf.filter(e => e.type === 'content');
        if (have.length < parityCount + 2 && !have.some(e => isUnder(e.path, d.path)))
            confInsert(conf, { type: 'content', path: `${stripSlash(d.path)}/snapraid.content` });
    });

    if (!conf.some(e => e.type === 'filter') && w.excludes)
        DEFAULT_EXCLUDES.forEach(p => conf.push({ type: 'filter', key: 'exclude', pattern: p }));
    if (!confOption(conf, 'autosave')) conf.push({ type: 'option', key: 'autosave', value: '500' });

    // checks, following the rules of the SnapRAID manual
    const newDataSizes = chosen.filter(c => w.roles[c.id] === 'data').map(c => (c.kind === 'blank' ? c.size * 0.93 : c.size));
    const largestData = Math.max(0, ...newDataSizes, ...m.data.map(d => d.total || 0));
    if (!chosen.length) errors.push('Nothing selected.');
    if (!parityCount) errors.push('Choose at least one parity disk: without parity nothing is protected.');
    if (!dataAll.length) errors.push('Choose at least one data disk.');
    if (dataAll.length > MAX_DATA) errors.push(`SnapRAID handles up to ${MAX_DATA} data disks.`);
    parityLines.forEach(e => {
        const level = PARITY_KEYS.indexOf(e.key);
        if (level > 0 && !parityLines.some(x => x.key === PARITY_KEYS[level - 1]))
            errors.push(`${e.key} needs the levels before it: assign a disk to ${PARITY_KEYS[level - 1]} first.`);
        if (e.paths.length > MAX_SPLIT) errors.push(`${e.key} is split over ${e.paths.length} disks, the limit is ${MAX_SPLIT}.`);
        const old = m.parity.find(p => p.key === e.key);
        const capacity = (old ? old.total : 0) + newParity.filter(p => p.key === e.key).reduce((a, p) => a + p.usable, 0);
        if (dataAll.length && (!old || old.ok) && capacity < largestData * 0.9)
            errors.push(`${e.key} has ${size(capacity)}, less than the largest data disk (${size(largestData)}). Give it a larger disk, or a second disk on the same level to split it.`);
    });
    if (chosen.some(c => c.kind === 'blank') && !w.fstype) errors.push('No tool to create filesystems is installed (mkfs.ext4, mkfs.xfs).');
    chosen.filter(c => isParityRole(w.roles[c.id]) && c.size > EXT4_FILE_MAX && (c.kind === 'blank' ? w.fstype : c.fs.fstype) === 'ext4').forEach(c =>
        errors.push(`${c.id} is larger than 16 TiB, and ext4 cannot hold a parity file that big. Choose xfs as filesystem, or use smaller disks on the same parity level.`));
    if (!/^\/[A-Za-z0-9._+\/-]*$/.test(base)) errors.push('The folder for the mount points must be an absolute path without spaces.');

    // the pool
    if (w.pool) {
        const mp = stripSlash(w.poolPath);
        if (!/^\/[A-Za-z0-9._+\/-]+$/.test(mp)) errors.push('The pool folder must be an absolute path without spaces.');
        if (parseSize(w.minfree) == null) errors.push('The space to keep free must be a size like 20G or 500M.');
        // the pool is a view over the disks: it cannot be inside one of them, nor contain them
        const dirs = [...dataAll.map(d => stripSlash(d.path)), ...parityLines.flatMap(e => e.paths.map(dirname))];
        if (dirs.some(d => isUnder(mp, d) || isUnder(d, mp)))
            errors.push(`The pool folder ${mp} overlaps a disk folder. Keep it apart, for example /mnt/storage with disks in /mnt/disk1, /mnt/disk2…`);
        const existing = m.pools.find(p => p.mountpoint === mp);
        const branches = existing ? existing.branches.map(b => stripSlash(b.path)) : m.data.filter(d => !d.removing).map(d => stripSlash(d.path));
        newData.forEach(d => { if (!branches.includes(d.path)) branches.push(d.path); });
        const options = existing?.fstab_options
            ? setOption(setOption(existing.fstab_options, 'category.create', w.policy), 'minfreespace', w.minfree)
            : defaultPoolOptions(w.policy, w.minfree);
        if (branches.length && (newData.length || !existing)) {
            steps.push({
                title: existing ? `Add the new data disks to the pool ${mp}` : `Create the mergerfs pool ${mp}`,
                detail: `${branches.join(':')} · ${w.policy}, keep ${w.minfree} free`,
                run: () => StorageAPI.pool(mp, branches, options)
            });
        }
    }

    const text = serializeConf(conf);
    steps.push({ title: `Write the SnapRAID configuration`, detail: m.inv.engine_conf.path, run: () => StorageAPI.saveConf(text) });
    if (w.sync) {
        // a parity level added to a synced array is computed from scratch, keeping the protection of the others
        steps.push({
            title: newLevel ? 'Start a full sync, to compute the new parity level' : 'Start the sync',
            detail: `${newLevel ? 'sync --force-full' : 'sync'} · continues in the background, follow it in Tasks`,
            run: () => API.schedule([{ command: 'probe' }, newLevel ? { command: 'sync', args: ['-F'] } : { command: 'sync' }])
        });
    } else {
        steps.push({
            title: 'Reload the array', detail: newLevel ? 'no sync started: the new parity level protects nothing until a full sync (sync -F)' : 'no sync started',
            run: () => API.schedule([{ command: 'probe' }])
        });
    }

    // how it is going to look
    const poolPath = w.pool ? stripSlash(w.poolPath) : null;
    const preview = layoutOf(m);
    preview.spare = [];
    newData.forEach(d => preview.data.push({ name: d.name, path: d.path, total: d.size, free: d.size, isNew: true }));
    const seen = {};
    m.parity.forEach(p => { seen[p.key] = p.files.length; });
    newParity.forEach(p => {
        seen[p.key] = (seen[p.key] || 0) + 1;
        preview.parity.push({ name: splits[p.key] > 1 ? `${p.key} ${seen[p.key]}/${splits[p.key]}` : p.key, level: p.key, total: p.size, free: p.size, isNew: true });
    });
    preview.parity.sort((a, b) => PARITY_KEYS.indexOf(a.level) - PARITY_KEYS.indexOf(b.level));
    if (poolPath) {
        let pool = preview.pools.find(p => p.mountpoint === poolPath);
        if (!pool) {
            pool = { mountpoint: poolPath, policy: w.policy, total: 0, free: 0, branches: m.data.filter(d => !d.removing).map(d => stripSlash(d.path)) };
            preview.pools.push(pool);
        }
        pool.policy = w.policy;
        newData.forEach(d => { if (!pool.branches.includes(d.path)) pool.branches.push(d.path); });
        pool.total = 0; pool.free = 0;
    }

    return { steps, text, errors, newData, preview, dataCount: dataAll.length, parityCount };
};

const openWizard = () => {
    if (!adminGuard()) return;
    const m = state.model;
    const tools = m.inv.tools || {};
    const cands = candidates(m);
    const adding = m.configured;

    if (!cands.length) {
        dialog({
            title: adding ? 'Add disks' : 'Guided setup', large: false,
            body: 'There is no blank disk and no unused filesystem to take. Connect a disk, or free one in the Disks list below, then try again.',
            buttons: [{ label: 'Close', onClick: (d) => d.close() }]
        });
        return;
    }

    // largest disks become parity, as many as there are already, or one
    const w = {
        cands, roles: {}, step: 0,
        fstype: fsChoices(tools)[0] || '', base: '/mnt',
        pool: !!tools.mergerfs, poolPath: m.pools[0]?.mountpoint || '/mnt/storage',
        policy: m.pools[0]?.options['category.create'] || 'pfrd',
        minfree: m.pools[0]?.options.minfreespace ? shortSize(m.pools[0].options.minfreespace) : '',
        excludes: true, sync: true
    };
    const bySize = [...cands].sort((a, b) => b.size - a.size);
    // when growing an array, a filesystem with content is not taken unless asked
    cands.forEach(c => { w.roles[c.id] = adding && c.kind === 'fs' ? 'ignore' : 'data'; });
    if (!adding) {
        // as many parity disks as the guideline asks for the data disks left
        let parityWanted = 1;
        while (parityWanted < cands.length - 1 && recommendedParity(cands.length - parityWanted) > parityWanted) ++parityWanted;
        if (cands.length >= 2) bySize.slice(0, parityWanted).forEach((c, i) => { w.roles[c.id] = `p${i}`; });
    }
    if (!w.minfree) {
        // room for a typical big file, but never more than a small part of the smallest disk
        const smallest = Math.min(...cands.map(c => c.size));
        w.minfree = smallest > 400e9 ? '20G' : smallest > 40e9 ? '4G' : shortSize(Math.max(1, Math.round(smallest / 25 / 1024 ** 2)) * 1024 ** 2);
    }

    const titles = ['Choose the disks', 'Options', 'Review'];
    const head = () => `
        <div class="st-wizard-head">
            ${titles.map((t, i) => `<span class="st-wizard-tab ${i === w.step ? 'active' : ''} ${i < w.step ? 'done' : ''}">${i + 1}. ${t}</span>`).join('')}
        </div>`;

    const stepDisks = () => `
        ${head()}
        <p class="text-sm text-muted mb-4">
            ${adding ? 'Pick what to add to the array.' : 'Pick a role for each disk. Parity disks hold the recovery information: each parity level lets the array survive the loss of one more disk, and must be at least as large as the largest data disk.'}
            Up to ${MAX_DATA} data disks and 6 parity levels. Two disks given the same parity level are joined (split parity): use it when one disk alone is too small.
        </p>
        <div class="st-scroll"><table class="data-table dense">
            <thead><tr><th>Disk</th><th>Size</th><th></th><th class="st-role-col">Use as</th></tr></thead>
            <tbody>
                ${w.cands.map(c => `
                    <tr>
                        <td><span class="font-mono font-bold">${escHtml(c.title)}</span><div class="text-xs text-muted">${escHtml(c.sub)}</div></td>
                        <td class="whitespace-nowrap">${size(c.size)}</td>
                        <td>${c.kind === 'blank' ? badge(c.note, 'orange') : badge(c.note, 'green')}</td>
                        <td>
                            <select class="form-control" data-role-for="${escAttr(c.id)}">
                                <option value="data" ${w.roles[c.id] === 'data' ? 'selected' : ''}>Data</option>
                                ${PARITY_KEYS.map((k, i) => `<option value="p${i}" ${w.roles[c.id] === `p${i}` ? 'selected' : ''}>Parity ${i + 1}${m.parity.some(p => p.key === k) ? ' (extend)' : ''}</option>`).join('')}
                                <option value="ignore" ${w.roles[c.id] === 'ignore' ? 'selected' : ''}>Don't use</option>
                            </select>
                        </td>
                    </tr>`).join('')}
            </tbody>
        </table></div>
        <div id="st-wizard-summary" class="st-wizard-summary"></div>
        <div id="st-wizard-errors"></div>`;

    const drawSummary = (dlg) => {
        const box = dlg.body.querySelector('#st-wizard-summary');
        if (!box) return;
        const plan = buildPlan(m, w);
        const usable = plan.preview.data.reduce((a, d) => a + (d.total || 0), 0);
        const want = recommendedParity(plan.dataCount);
        box.innerHTML = `
            <div><b>${size(usable)}</b> usable in ${plural(plan.dataCount, 'data disk', 'data disks')}</div>
            <div>${plan.parityCount ? `<b>${plural(plan.parityCount, 'disk', 'disks')}</b> can fail without losing data` : '<b class="text-red">no protection</b>'}</div>
            ${plan.parityCount && plan.parityCount < want ? `<div class="text-amber">For ${plural(plan.dataCount, 'data disk', 'data disks')} the guideline is ${plural(want, 'parity disk', 'parity disks')}</div>` : ''}`;
    };

    const stepOptions = () => {
        const fss = fsChoices(tools);
        const anyBlank = w.cands.some(c => c.kind === 'blank' && w.roles[c.id] !== 'ignore');
        void anyBlank;
        return `
        ${head()}
        <div class="form-row">
            <div class="form-group ${anyBlank ? '' : 'disabled-control'}">
                <label for="w-fstype">Filesystem for the new disks</label>
                <select class="form-control" id="w-fstype" ${anyBlank ? '' : 'disabled'}>
                    ${fss.map(f => `<option ${f === w.fstype ? 'selected' : ''}>${f}</option>`).join('')}
                </select>
                <div class="text-xs text-muted mt-1">ext4 is the safe default. Each disk keeps its own independent filesystem.</div>
            </div>
            <div class="form-group">
                <label for="w-base">Mount the disks under</label>
                <input class="form-control font-mono" id="w-base" value="${escAttr(w.base)}">
                <div class="text-xs text-muted mt-1">They become ${escHtml(stripSlash(w.base))}/disk1, ${escHtml(stripSlash(w.base))}/parity1…</div>
            </div>
        </div>
        <div class="st-wizard-section">
            <div class="flex items-center gap-4 ${tools.mergerfs ? '' : 'disabled-control'}">
                <label class="switch"><input type="checkbox" id="w-pool" ${w.pool ? 'checked' : ''} ${tools.mergerfs ? '' : 'disabled'}><span class="slider"></span></label>
                <label for="w-pool" class="mb-0 cursor-pointer font-bold">Join the data disks in one folder with mergerfs</label>
            </div>
            <div class="text-xs text-muted mt-1 mb-4">${tools.mergerfs
                ? 'Recommended. You use one folder; mergerfs decides on which disk each file lands. Files stay plain files on every disk.'
                : 'mergerfs is not installed on this machine. Install the mergerfs package to enable this; the array works without it.'}</div>
            <div id="w-pool-fields" class="${w.pool ? '' : 'hidden'}">
                <div class="form-row">
                    <div class="form-group">
                        <label for="w-pool-path">Pool folder</label>
                        <input class="form-control font-mono" id="w-pool-path" value="${escAttr(w.poolPath)}">
                    </div>
                    <div class="form-group">
                        <label for="w-minfree">Keep free on each disk</label>
                        <input class="form-control" id="w-minfree" value="${escAttr(w.minfree)}">
                    </div>
                </div>
                <div class="form-group">
                    <label for="w-policy">Where new files go</label>
                    <select class="form-control" id="w-policy">
                        ${POLICIES.map(([k, d]) => `<option value="${k}" ${k === w.policy ? 'selected' : ''}>${k} — ${escHtml(d)}</option>`).join('')}
                    </select>
                </div>
            </div>
        </div>
        <div class="st-wizard-section">
            ${adding ? '' : `
            <div class="flex items-center gap-4 mb-3">
                <label class="switch"><input type="checkbox" id="w-excludes" ${w.excludes ? 'checked' : ''}><span class="slider"></span></label>
                <label for="w-excludes" class="mb-0 cursor-pointer font-bold">Leave out temporary and system files</label>
            </div>`}
            <div class="flex items-center gap-4">
                <label class="switch"><input type="checkbox" id="w-sync" ${w.sync ? 'checked' : ''}><span class="slider"></span></label>
                <label for="w-sync" class="mb-0 cursor-pointer font-bold">Start a sync when done</label>
            </div>
            <div class="text-xs text-muted mt-1">The sync computes the parity. Until it completes, the new content is not protected.</div>
        </div>
        <div id="st-wizard-errors"></div>`;
    };

    const stepReview = (plan) => `
        ${head()}
        <div class="st-preview">
            <div class="st-effects-title">How it will look</div>
            ${renderDiagram(plan.preview)}
        </div>
        <div class="st-effects-title mt-4">What is going to be done, in this order</div>
        ${stepList(plan.steps)}
        <details class="mt-4"><summary class="text-sm cursor-pointer">SnapRAID configuration that will be written</summary>
            <pre class="st-pre">${escHtml(plan.text)}</pre></details>
        ${eraseConfirm(plan.steps)}`;

    const readOptions = (dlg) => {
        const q = (id) => dlg.body.querySelector(id);
        if (!q('#w-base')) return;
        w.fstype = q('#w-fstype')?.value || w.fstype;
        w.base = q('#w-base').value.trim() || '/mnt';
        w.pool = q('#w-pool').checked;
        w.poolPath = q('#w-pool-path').value.trim();
        w.minfree = q('#w-minfree').value.trim();
        w.policy = q('#w-policy').value;
        if (q('#w-excludes')) w.excludes = q('#w-excludes').checked;
        w.sync = q('#w-sync').checked;
    };

    const showErrors = (dlg, errors) => {
        const box = dlg.body.querySelector('#st-wizard-errors');
        if (box) box.innerHTML = errors.map(e => `<div class="text-sm text-red mt-2">${escHtml(e)}</div>`).join('');
        return errors.length === 0;
    };

    const roleErrors = () => buildPlan(m, w).errors.filter(e => !e.includes('folder') && !e.includes('space to keep'));
    // the candidates of a big machine do not fit: let the list scroll
    

    const go = (dlg) => {
        if (w.step === 0) {
            dlg.setBody(stepDisks());
            showErrors(dlg, roleErrors());
            drawSummary(dlg);
            dlg.body.querySelectorAll('[data-role-for]').forEach(sel => sel.addEventListener('change', () => {
                w.roles[sel.dataset.roleFor] = sel.value;
                showErrors(dlg, roleErrors());
                drawSummary(dlg);
            }));
            dlg.setButtons([
                { label: 'Cancel', onClick: (d) => d.close() },
                { label: 'Next', cls: 'btn-primary', onClick: () => { if (showErrors(dlg, roleErrors())) { w.step = 1; go(dlg); } } }
            ]);
        } else if (w.step === 1) {
            dlg.setBody(stepOptions());
            dlg.body.querySelector('#w-pool').addEventListener('change', (e) => dlg.body.querySelector('#w-pool-fields').classList.toggle('hidden', !e.target.checked));
            dlg.setButtons([
                { label: 'Back', onClick: () => { readOptions(dlg); w.step = 0; go(dlg); } },
                { label: 'Next', cls: 'btn-primary', onClick: () => { readOptions(dlg); if (showErrors(dlg, buildPlan(m, w).errors)) { w.step = 2; go(dlg); } } }
            ]);
        } else {
            const plan = buildPlan(m, w);
            dlg.setBody(stepReview(plan));
            dlg.setButtons([
                { label: 'Back', onClick: () => { w.step = 1; go(dlg); } },
                {
                    label: plan.steps.some(s => s.danger) ? 'Erase and set up' : 'Set up', cls: plan.steps.some(s => s.danger) ? 'btn-danger' : 'btn-primary',
                    onClick: () => {
                        if (!eraseOk(dlg, plan.steps)) { showToast('Type ERASE to confirm', 'warning'); return; }
                        dlg.setTitle('Setting up');
                        runSteps(dlg, plan.steps, w.sync ? 'All set. The sync is running: follow it in Tasks.' : 'All set.');
                    }
                }
            ]);
        }
    };

    const dlg = dialog({ title: adding ? 'Add disks to the array' : 'Guided setup', body: '', buttons: [] });
    go(dlg);
};

/* ------------------------------------------------------------------ */
/* single actions                                                      */
/* ------------------------------------------------------------------ */

const prepareDisk = (device) => {
    if (!adminGuard()) return;
    const m = state.model;
    const d = m.disks.find(x => x.path === device);
    const fss = fsChoices(m.inv.tools || {});
    if (!d || !fss.length) { showToast('No tool to create filesystems is installed', 'error'); return; }
    const blank = d.state === 'blank';
    const mounted = d.filesystems.filter(f => f.mount);

    dialog({
        title: `Format ${device}`,
        body: `
            <p class="text-sm text-muted mb-4">${size(d.size)} ${escHtml(d.model)}. Creates one partition with a new empty filesystem and mounts it.
                To use the disk in the array, run <b>Add disks</b> afterwards, or use it directly from there.</p>
            <div class="form-row">
                <div class="form-group"><label for="p-fstype">Filesystem</label>
                    <select class="form-control" id="p-fstype">${fss.map(f => `<option>${f}</option>`).join('')}</select></div>
                <div class="form-group"><label for="p-label">Label</label>
                    <input class="form-control" id="p-label" value="disk" maxlength="12"></div>
            </div>
            <div class="form-group"><label for="p-target">Mount at</label>
                <input class="form-control font-mono" id="p-target" value="/mnt/${escAttr(d.name)}"></div>
            ${blank ? '' : `
            <div class="restricted-banner st-danger">
                <div class="restricted-banner-title">This disk is not empty</div>
                ${d.filesystems.map(f => `${escHtml(f.path)} ${escHtml(f.fstype)}${f.label ? ` “${escHtml(f.label)}”` : ''}`).join(', ') || 'It has a partition table.'}
                Everything on it is destroyed. Type <code>ERASE</code> to go on.
                <input class="form-control mt-2" id="st-erase" autocomplete="off" spellcheck="false">
            </div>`}`,
        buttons: [
            { label: 'Cancel', onClick: (dl) => dl.close() },
            {
                label: 'Format', cls: 'btn-danger', onClick: (dl) => {
                    const q = (id) => dl.body.querySelector(id).value.trim();
                    if (!blank && q('#st-erase') !== 'ERASE') { showToast('Type ERASE to confirm', 'warning'); return; }
                    const fstype = q('#p-fstype'), label = q('#p-label'), target = q('#p-target');
                    let res = {};
                    const steps = [
                        ...mounted.map(f => ({ title: `Unmount ${f.mount.target}`, run: () => StorageAPI.unmount(f.mount.target, true) })),
                        { title: `Format ${device} as ${fstype}`, detail: `label ${label}`, run: async () => { res = await StorageAPI.format(device, fstype, label, 'data', !blank); } },
                        { title: `Mount it at ${target}, now and at every boot`, run: () => StorageAPI.mount(res.uuid ? `UUID=${res.uuid}` : res.partition, target, fstype, mountOptions()) }
                    ];
                    runSteps(dl, steps, 'The disk is ready.');
                }
            }
        ]
    });
};

const mountFs = (device) => {
    if (!adminGuard()) return;
    const f = state.model.disks.flatMap(d => d.filesystems).find(x => x.path === device);
    if (!f) return;
    dialog({
        title: `Mount ${device}`, large: false,
        body: `
            <p class="text-sm text-muted mb-4">${escHtml(f.fstype)}${f.label ? ` “${escHtml(f.label)}”` : ''}. The content is kept, and the mount is saved for every boot.</p>
            <div class="form-group"><label for="m-target">Mount at</label>
                <input class="form-control font-mono" id="m-target" value="/mnt/${escAttr(f.label || device.split('/').pop())}"></div>`,
        buttons: [
            { label: 'Cancel', onClick: (dl) => dl.close() },
            {
                label: 'Mount', cls: 'btn-primary', onClick: async (dl) => {
                    try {
                        await StorageAPI.mount(f.uuid ? `UUID=${f.uuid}` : device, dl.body.querySelector('#m-target').value.trim(), f.fstype, mountOptions());
                        dl.close(); showToast('Mounted', 'info'); reload();
                    } catch (e) { showToast(e.message, 'error'); }
                }
            }
        ]
    });
};

const unmountFs = (target) => {
    if (!adminGuard()) return;
    dialog({
        title: `Unmount ${target}`, large: false,
        body: 'The filesystem is unmounted and removed from the mounts done at boot. Nothing on it is changed.',
        buttons: [
            { label: 'Cancel', onClick: (dl) => dl.close() },
            {
                label: 'Unmount', cls: 'btn-primary', onClick: async (dl) => {
                    try { await StorageAPI.unmount(target, true); dl.close(); showToast('Unmounted', 'info'); reload(); }
                    catch (e) { showToast(e.message, 'error'); }
                }
            }
        ]
    });
};

/* --- pool --- */

const poolOptionsFrom = (p, idx) => {
    const policy = document.getElementById(`pool-policy-${idx}`)?.value || p.options['category.create'] || 'mfs';
    const minfree = document.getElementById(`pool-minfree-${idx}`)?.value.trim() || shortSize(p.options.minfreespace || 4 * 1024 ** 3);
    if (parseSize(minfree) == null) throw new Error('The space to keep free must be a size like 20G or 500M');
    const base = p.fstab_options || defaultPoolOptions(policy, minfree);
    return setOption(setOption(base, 'category.create', policy), 'minfreespace', minfree);
};

const poolUpdate = async (idx, change, okText, ask) => {
    if (!adminGuard()) return;
    const p = state.model.pools[idx];
    if (ask && !(await confirmDo(ask(p)))) return;
    try {
        const branches = change(p.branches.map(b => (b.mode && b.mode !== 'RW' ? `${stripSlash(b.path)}=${b.mode}` : stripSlash(b.path))));
        await StorageAPI.pool(p.mountpoint, branches, poolOptionsFrom(p, idx));
        showToast(okText, 'info');
        reload();
    } catch (e) {
        showToast(e.message, 'error');
    }
};

const poolCreate = () => {
    if (!adminGuard()) return;
    const m = state.model;
    const branches = m.data.filter(d => d.ok && !d.removing).map(d => stripSlash(d.path));
    dialog({
        title: 'Create a mergerfs pool',
        body: `
            <p class="text-sm text-muted mb-4">Joins the ${branches.length} data disks in one folder. Nothing is moved or changed on the disks.</p>
            <div class="form-row">
                <div class="form-group"><label for="c-path">Pool folder</label><input class="form-control font-mono" id="c-path" value="/mnt/storage"></div>
                <div class="form-group"><label for="c-minfree">Keep free on each disk</label><input class="form-control" id="c-minfree" value="4G"></div>
            </div>
            <div class="form-group"><label for="c-policy">Where new files go</label>
                <select class="form-control" id="c-policy">${POLICIES.map(([k, d]) => `<option value="${k}">${k} — ${escHtml(d)}</option>`).join('')}</select></div>
            <p class="text-xs text-muted mt-2">Parity disks are never added: a pool that includes one fills it with data.</p>
            <div class="text-xs text-muted font-mono">${escHtml(branches.join(':'))}</div>`,
        buttons: [
            { label: 'Cancel', onClick: (dl) => dl.close() },
            {
                label: 'Create', cls: 'btn-primary', onClick: async (dl) => {
                    const q = (id) => dl.body.querySelector(id).value.trim();
                    if (parseSize(q('#c-minfree')) == null) { showToast('The space to keep free must be a size like 20G or 500M', 'warning'); return; }
                    try {
                        await StorageAPI.pool(q('#c-path'), branches, defaultPoolOptions(q('#c-policy'), q('#c-minfree')));
                        dl.close(); showToast('Pool created', 'info'); reload();
                    } catch (e) { showToast(e.message, 'error'); }
                }
            }
        ]
    });
};

/* --- replace --- */

const replaceDisk = (kind, name) => {
    if (!adminGuard()) return;
    const m = state.model;
    const entry = kind === 'data' ? m.data.find(d => d.name === name) : m.parity.find(p => p.key === name);
    if (!entry) return;
    const oldPath = kind === 'data' ? stripSlash(entry.path) : (entry.files[0].mount?.target && entry.files[0].mount.target !== '/' ? entry.files[0].mount.target : dirname(entry.paths[0]));
    const cands = candidates(m).filter(c => !(c.kind === 'fs' && c.fs.mount));
    const fss = fsChoices(m.inv.tools || {});
    const needed = entry.ok ? entry.total : 0;

    if (!cands.length) {
        dialog({
            title: `Replace ${name}`, large: false,
            body: 'There is no blank disk and no unmounted filesystem to use as replacement. Connect the new disk first.',
            buttons: [{ label: 'Close', onClick: (d) => d.close() }]
        });
        return;
    }

    const plan = (dl) => {
        const c = cands.find(x => x.id === dl.body.querySelector('#r-new').value);
        const fstype = dl.body.querySelector('#r-fstype')?.value || fss[0];
        const check = dl.body.querySelector('#r-check').checked;
        const steps = [];
        const label = kind === 'data' ? name.slice(0, 12) : `parity${PARITY_KEYS.indexOf(name) + 1}`;
        if (entry.ok && entry.mount.target === oldPath)
            steps.push({ title: `Unmount the old disk from ${oldPath}`, detail: entry.mount.source, run: () => StorageAPI.unmount(oldPath, true) });
        else
            steps.push({ title: `Forget the old mount of ${oldPath}`, run: () => StorageAPI.unmount(oldPath, true).catch(() => { }) });
        if (c.kind === 'blank') {
            steps.push({
                title: `Format ${c.id} as ${fstype}`, detail: `${size(c.size)} · label ${label}`, danger: true,
                run: async () => { const res = await StorageAPI.format(c.id, fstype, label, kind, false); c.uuid = res.uuid; c.partition = res.partition; }
            });
            steps.push({ title: `Mount it at ${oldPath}, in place of the old disk`, run: () => StorageAPI.mount(c.uuid ? `UUID=${c.uuid}` : c.partition, oldPath, fstype, mountOptions()) });
        } else {
            steps.push({ title: `Mount ${c.id} at ${oldPath}, in place of the old disk`, detail: 'content is kept', run: () => StorageAPI.mount(c.fs.uuid ? `UUID=${c.fs.uuid}` : c.id, oldPath, c.fs.fstype, mountOptions()) });
        }
        steps.push({
            title: `Rebuild ${name} from the rest of the array`,
            detail: `fix -d ${name}${check && kind === 'data' ? ` → check -d ${name} -a` : ''} → sync`,
            run: () => StorageAPI.recover([name], check && kind === 'data')
        });
        return { steps, c };
    };

    const dlg = dialog({
        title: `Replace ${kind === 'data' ? 'data disk' : ''} ${name}`,
        body: `
            <p class="text-sm text-muted mb-4">
                The new disk takes the place of the old one at <span class="font-mono">${escHtml(oldPath)}</span>, and SnapRAID rebuilds
                what was on it from the other disks. Nothing changes in the configuration${entry.inPool ? ' or in the pool' : ''}.
                If the old disk still works, leave it connected: it is only unmounted, not erased.
            </p>
            <div class="form-row">
                <div class="form-group"><label for="r-new">New disk</label>
                    <select class="form-control" id="r-new">
                        ${cands.map(c => `<option value="${escAttr(c.id)}" ${c.size < needed ? 'disabled' : ''}>${escHtml(c.title)} · ${size(c.size)} · ${c.kind === 'blank' ? 'blank' : escHtml(c.sub)}${c.size < needed ? ' (too small)' : ''}</option>`).join('')}
                    </select></div>
                <div class="form-group"><label for="r-fstype">Filesystem</label>
                    <select class="form-control" id="r-fstype">${fss.map(f => `<option>${f}</option>`).join('')}</select></div>
            </div>
            <div class="flex items-center gap-4 ${kind === 'data' ? '' : 'hidden'}">
                <label class="switch"><input type="checkbox" id="r-check" checked><span class="slider"></span></label>
                <label for="r-check" class="mb-0 cursor-pointer font-bold">Verify the rebuilt files before syncing</label>
            </div>
            <div id="r-plan" class="mt-4"></div>`,
        buttons: [
            { label: 'Cancel', onClick: (dl) => dl.close() },
            {
                label: 'Replace', cls: 'btn-danger', onClick: (dl) => {
                    const p = plan(dl);
                    if (!eraseOk(dl, p.steps)) { showToast('Type ERASE to confirm', 'warning'); return; }
                    runSteps(dl, p.steps, 'The rebuild is running: follow it in Tasks. Files that cannot be recovered get the .unrecoverable extension.');
                }
            }
        ]
    });
    const draw = () => {
        const p = plan(dlg);
        dlg.body.querySelector('#r-plan').innerHTML = stepList(p.steps) + eraseConfirm(p.steps);
    };
    dlg.body.querySelectorAll('select, input[type=checkbox]').forEach(el => el.addEventListener('change', draw));
    draw();
};

/* --- recover --- */

/**
 * Bring back an array stopped because some disks are not the ones recorded
 * at the last sync, following the recovering procedure of SnapRAID.
 */
const recoverDialog = () => {
    if (!adminGuard()) return;
    const m = state.model;
    const all = [...m.data.filter(d => !d.removing).map(d => ({ name: d.name, kind: 'data' })), ...m.parity.map(p => ({ name: p.key, kind: 'parity' }))];
    const levels = m.parity.length;

    const read = (dl) => {
        const disks = [...dl.body.querySelectorAll('[data-recover]:checked')].map(el => el.dataset.recover);
        const accept = dl.body.querySelector('#rc-accept').checked;
        const check = dl.body.querySelector('#rc-check').checked;
        // SnapRAID takes by itself as many new disks as the parity levels
        const force = Math.max(disks.length, state.changed.length) > levels;
        const names = disks.join(', ');
        const steps = [];
        if (!accept) {
            steps.push({ title: `Rebuild ${names || '…'} from the other disks`, detail: `fix ${disks.map(d => `-d ${d}`).join(' ')}${force ? ' --force-uuid' : ''}` });
            if (check && disks.some(d => !d.includes('parity')))
                steps.push({ title: 'Verify what was rebuilt, file by file', detail: `check ${disks.filter(d => !d.includes('parity')).map(d => `-d ${d}`).join(' ')} -a${force ? ' --force-uuid' : ''}` });
        }
        steps.push({ title: 'Sync, recording the disks as they are now', detail: `sync${force ? ' --force-uuid' : ''}` });
        return { disks, accept, check, force, steps };
    };

    const dlg = dialog({
        title: 'Recover the array',
        body: `
            <p class="text-sm mb-4">${escHtml(state.array.health_reason || 'Some disks are not the ones recorded at the last sync.')}</p>
            <div class="form-group">
                <label>Which disks lost their content?</label>
                <div class="text-xs text-muted mb-2">The ones with a new filesystem are already selected. Their missing files are rebuilt from the parity and the other disks; files that are still there are verified and kept.</div>
                <div class="st-checks">
                    ${all.map(d => `<label class="st-check"><input type="checkbox" data-recover="${escAttr(d.name)}" ${state.changed.includes(d.name) ? 'checked' : ''}> <span class="font-mono">${escHtml(d.name)}</span>${state.changed.includes(d.name) ? ' <span class="text-xs text-amber">changed</span>' : ''}</label>`).join('')}
                </div>
            </div>
            <div class="flex items-center gap-4 mb-3">
                <label class="switch"><input type="checkbox" id="rc-check" checked><span class="slider"></span></label>
                <label for="rc-check" class="mb-0 cursor-pointer font-bold">Verify the rebuilt files before syncing</label>
            </div>
            <div class="flex items-center gap-4">
                <label class="switch"><input type="checkbox" id="rc-accept"><span class="slider"></span></label>
                <label for="rc-accept" class="mb-0 cursor-pointer font-bold">Nothing was lost: the files are already in place</label>
            </div>
            <div class="text-xs text-muted mt-1 mb-4">Only for disks you cloned or restored yourself. Skips the rebuild and just records the new disks. If files are in fact missing, this makes the loss permanent.</div>
            <div id="rc-plan"></div>`,
        buttons: [
            { label: 'Cancel', onClick: (dl) => dl.close() },
            {
                label: 'Recover', cls: 'btn-danger', onClick: async (dl) => {
                    const r = read(dl);
                    if (!r.accept && !r.disks.length) { showToast('Select the disks to rebuild', 'warning'); return; }
                    try {
                        await StorageAPI.recover(r.disks, r.check, r.accept, r.force);
                        dl.close();
                        showToast('Recovery started: follow it in Tasks', 'info');
                        reload();
                    } catch (e) { showToast(e.message, 'error'); }
                }
            }
        ]
    });
    const draw = () => {
        const r = read(dlg);
        dlg.body.querySelector('#rc-plan').innerHTML = `
            <div class="st-effects-title">What is going to be done, in this order</div>${stepList(r.steps)}
            ${r.force ? `<p class="text-sm text-amber mt-4">More disks changed than the ${plural(levels, 'parity level', 'parity levels')} of the array, so SnapRAID has to be told explicitly to go on (--force-uuid). First make sure that every disk is mounted in its own place.</p>` : ''}
            <p class="text-sm text-muted mt-4">Files that cannot be rebuilt are kept with the .unrecoverable extension. Until the final sync you can run the recovery again.</p>`;
    };
    dlg.body.querySelectorAll('input').forEach(el => el.addEventListener('change', draw));
    draw();
};

/* --- background operations --- */

const jobTitle = (job) => ({ format: `Formatting ${job.target}`, balance: `Balancing ${job.target}`, duplicates: `Looking for duplicates in ${job.target}` }[job.kind] || job.kind);

const branchName = (path) => {
    const d = state.model?.data.find(x => stripSlash(x.path) === stripSlash(path));
    return d ? d.name : path.split('/').pop();
};

const renderJob = (job) => {
    if (!job || !job.id || job.kind === 'format') return '';
    if (job.running) {
        return `
            <div class="card card-border-blue">
                <div class="flex justify-between items-center flex-wrap gap-2">
                    <h3>${escHtml(jobTitle(job))}…</h3>
                    <button class="btn btn-secondary btn-sm" data-st="job-stop" ${job.stopping ? 'disabled' : ''}>${job.stopping ? 'Stopping…' : 'Stop'}</button>
                </div>
                <div class="text-sm mt-2">${job.kind === 'balance'
                    ? `${plural(job.files, 'file', 'files')} moved, ${size(job.bytes)}`
                    : `${plural(job.files, 'file', 'files')} compared, ${job.found} on more than one disk`}</div>
                <div class="text-xs text-muted font-mono truncate">${escHtml(job.current || '')}</div>
            </div>`;
    }

    let detail = '';
    if (job.kind === 'balance') {
        detail = `<div class="text-sm mt-2">${plural(job.files, 'file', 'files')} moved, ${size(job.bytes)}.
            ${job.files ? 'For SnapRAID the moved files are new on one disk and gone from another: <b>sync</b> to protect them again.' : ''}</div>
            ${job.files ? '<button class="btn btn-primary btn-sm mt-2" data-st="sync-now">Sync now</button>' : ''}`;
    } else if (job.kind === 'duplicates') {
        const rows = (job.result || []).map(r => {
            const sizes = new Set(r.copies.map(c => c.size));
            return `<tr>
                <td class="font-mono text-xs break-all">${escHtml(r.path)}</td>
                <td class="text-xs">${r.copies.map((c, i) => `<div>${badge(branchName(c.branch), i === 0 ? 'green' : 'grey')} ${size(c.size)} · ${new Date(c.mtime * 1000).toLocaleDateString()}</div>`).join('')}</td>
                <td>${sizes.size > 1 ? badge('different', 'red') : badge('same size', 'grey')}</td>
            </tr>`;
        }).join('');
        detail = job.found ? `
            <div class="text-sm mt-2 mb-4">${plural(job.found, 'file is', 'files are')} on more than one disk, taking ${size(job.found_bytes)} more than needed.
                The pool shows the copy on the first disk of its list (green). To free the space, delete the other copies from the folder of their own disk, then sync.
                ${job.found > (job.result || []).length ? `Showing the first ${(job.result || []).length}.` : ''}</div>
            <div class="overflow-x-auto st-scroll"><table class="data-table dense"><thead><tr><th>File</th><th>Copies</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '';
    }
    return `
        <div class="card ${job.success ? '' : 'border-red'}">
            <h3>${escHtml(jobTitle(job).replace(/ing /, 'ing of '))}: ${job.success ? 'done' : 'failed'}</h3>
            <div class="text-sm mt-2 ${job.success ? '' : 'text-red'}">${escHtml(job.message || '')}</div>
            ${detail}
        </div>`;
};

/** Keep the card of the running operation up to date, then reload everything. */
const watchJob = async () => {
    if (state.watching) return;
    state.watching = true;
    try {
        const job = await waitJob((j) => {
            if (state.model) state.model.inv.job = j;
            const box = document.getElementById('st-job');
            if (box) box.innerHTML = renderJob(j);
        });
        if (job.kind === 'balance' && state.syncAfter && job.files) {
            state.syncAfter = false;
            await API.schedule([{ command: 'sync' }]).then(() => showToast('Balance done, sync started', 'info')).catch(e => showToast('Balance done, but the sync did not start: ' + e.message, 'warning'));
        }
    } catch (e) {
        showToast(e.message, 'error');
    }
    state.watching = false;
    if (window.location.hash === '#/storage') reload();
};

/* --- balance, duplicates, browse --- */

/** How much has to move to bring every disk of the pool to the same fill level. */
const balanceNeed = (p) => {
    const b = p.branches.filter(x => x.total_bytes && x.mode !== 'RO' && x.mode !== 'NC');
    const total = b.reduce((a, x) => a + x.total_bytes, 0);
    const used = b.reduce((a, x) => a + (x.total_bytes - x.free_bytes), 0);
    const mean = total ? used / total : 0;
    const fills = b.map(x => (x.total_bytes - x.free_bytes) * 100 / x.total_bytes);
    return {
        bytes: b.reduce((a, x) => a + Math.max(0, (x.total_bytes - x.free_bytes) - mean * x.total_bytes), 0),
        spread: fills.length ? Math.round(Math.max(...fills) - Math.min(...fills)) : 0
    };
};

const renderToolsCard = (m, p, idx) => {
    const need = balanceNeed(p);
    const tools = m.inv.tools || {};
    return `
        <div id="st-job">${renderJob(m.inv.job)}</div>
        <div class="grid-2">
            <div class="card">
                <h3>Balance</h3>
                <p class="text-sm text-muted mt-2 mb-4">Moves files from the fullest disks to the emptiest, so that every disk ends at about the same level. Paths inside the pool do not change.
                    The fullest and the emptiest disk are now <b>${need.spread} points</b> apart; evening them out means moving about <b>${size(need.bytes)}</b>.</p>
                ${tools.rsync ? `
                <div class="form-row">
                    <div class="form-group"><label for="bal-spread-${idx}">Stop when within</label>
                        <select class="form-control" id="bal-spread-${idx}"><option value="2">2 points</option><option value="5" selected>5 points</option><option value="10">10 points</option><option value="20">20 points</option></select></div>
                    <div class="form-group"><label for="bal-max-${idx}">Move at most</label>
                        <input class="form-control" id="bal-max-${idx}" value="${escAttr(shortSize(Math.max(1, Math.ceil(need.bytes / 1024 ** 2)) * 1024 ** 2))}"></div>
                </div>
                <div class="flex items-center gap-4 mb-4">
                    <label class="switch"><input type="checkbox" id="bal-sync-${idx}" checked><span class="slider"></span></label>
                    <label for="bal-sync-${idx}" class="mb-0 cursor-pointer font-bold">Sync when done</label>
                </div>
                <button class="btn btn-primary" data-st="balance" data-pool="${idx}" ${need.spread < 2 ? 'disabled' : ''}>Balance…</button>
                ${need.spread < 2 ? '<span class="text-sm text-muted ml-2">Already even.</span>' : ''}`
                : `<div class="restricted-banner"><div class="restricted-banner-title">rsync is not installed</div>Files are moved with rsync. Install the <code>rsync</code> package and reload this page.</div>`}
            </div>
            <div class="card">
                <h3>Duplicates</h3>
                <p class="text-sm text-muted mt-2 mb-4">The same path can exist on more than one disk, for example after copying by hand to a disk folder. The pool shows only one copy; the others waste space and can be out of date.</p>
                <button class="btn btn-primary" data-st="duplicates" data-pool="${idx}">Look for duplicates</button>
            </div>
        </div>
        ${renderBrowse(p, idx)}`;
};

const renderBrowse = (p, idx) => {
    const b = state.browse && state.browse.pool === p.mountpoint ? state.browse : null;
    if (!b) {
        return `
            <div class="card">
                <h3>Where are my files</h3>
                <p class="text-sm text-muted mt-2 mb-4">Browse the pool and see on which disk every file and folder really is.</p>
                <button class="btn btn-primary" data-st="browse" data-pool="${idx}" data-path="/">Browse ${escHtml(p.mountpoint)}</button>
            </div>`;
    }
    const parts = b.path.split('/').filter(Boolean);
    const crumbs = [`<a href="#/storage" data-st="browse" data-pool="${idx}" data-path="/">${escHtml(p.mountpoint)}</a>`,
        ...parts.map((part, i) => `<a href="#/storage" data-st="browse" data-pool="${idx}" data-path="/${escAttr(parts.slice(0, i + 1).join('/'))}">${escHtml(part)}</a>`)].join(' / ');
    const entries = [...b.entries].sort((x, y) => (y.dir - x.dir) || x.name.localeCompare(y.name));
    const rows = entries.map(e => `
        <tr>
            <td>${e.dir
                ? `<a href="#/storage" class="font-bold" data-st="browse" data-pool="${idx}" data-path="${escAttr(`${b.path === '/' ? '' : b.path}/${e.name}`)}">${escHtml(e.name)}/</a>`
                : escHtml(e.name)}</td>
            <td class="whitespace-nowrap text-xs">${e.dir ? '' : size(e.size)}</td>
            <td>${e.on.map(i => badge(branchName(b.branches[i]), 'green')).join(' ')} ${e.duplicate ? badge('duplicate', 'red') : ''}</td>
        </tr>`).join('');
    return `
        <div class="card">
            <h3>Where are my files</h3>
            <div class="text-sm mt-2 mb-4">${crumbs}</div>
            <div class="overflow-x-auto st-scroll">
                <table class="data-table dense">
                    <thead><tr><th>Name</th><th>Size</th><th>On disk</th></tr></thead>
                    <tbody>${rows || '<tr><td colspan="3" class="text-muted">Empty folder</td></tr>'}</tbody>
                </table>
            </div>
            ${b.truncated ? '<div class="text-xs text-muted mt-2">Only the first 2000 entries are shown.</div>' : ''}
        </div>`;
};

const browseTo = async (idx, path) => {
    const p = state.model.pools[idx];
    try {
        state.browse = await StorageAPI.browse(p.mountpoint, path || '/');
        render();
    } catch (e) { showToast(e.message, 'error'); }
};

const balanceStart = async (idx) => {
    if (!adminGuard()) return;
    const p = state.model.pools[idx];
    const max = parseSize(document.getElementById(`bal-max-${idx}`).value);
    const spread = Number(document.getElementById(`bal-spread-${idx}`).value);
    const sync = document.getElementById(`bal-sync-${idx}`).checked;
    if (!max) { showToast('The amount to move must be a size like 50G or 500M', 'warning'); return; }
    if (!(await confirmDo({
        title: `Balance the pool ${p.mountpoint}`,
        effects: [
            `Up to <b>${size(max)}</b> of files move from the fullest disks to the emptiest, one at a time, until the disks are within ${spread} points.`,
            'Each file is copied with rsync, verified, and only then removed from the disk it came from.',
            sync ? 'A sync starts at the end, to protect the files in their new place.' : '<b>No sync at the end:</b> until you run one, the moved files are not protected and the recovery of the other disks is weaker.'
        ],
        safe: ['Paths inside the pool stay the same: programs using the pool see no difference.', 'It can be stopped at any moment; what was moved stays moved.'],
        label: 'Start balancing'
    }))) return;
    try {
        await StorageAPI.balance(p.mountpoint, max, spread);
        state.syncAfter = sync;
        showToast('Balance started', 'info');
        await reload();
    } catch (e) { showToast(e.message, 'error'); }
};

const duplicatesStart = async (idx) => {
    if (!adminGuard()) return;
    try {
        await StorageAPI.duplicates(state.model.pools[idx].mountpoint);
        await reload();
    } catch (e) { showToast(e.message, 'error'); }
};

/* --- remove --- */

const removeDisk = (name) => {
    if (!adminGuard()) return;
    const m = state.model;
    const d = m.data.find(x => x.name === name);
    if (!d) return;
    const placeholder = `${REMOVED_BASE}/${name}`;
    const pool = m.pools.find(p => p.branches.some(b => stripSlash(b.path) === stripSlash(d.path)));
    const contentOnIt = m.content.filter(c => isUnder(c, d.path));
    const used = d.ok ? d.total - d.free : 0;

    const steps = [];
    if (pool) {
        const idx = m.pools.indexOf(pool);
        const rest = pool.branches.map(b => stripSlash(b.path)).filter(p => p !== stripSlash(d.path));
        if (rest.length)
            steps.push({ title: `Take ${d.path} out of the pool ${pool.mountpoint}`, run: () => StorageAPI.pool(pool.mountpoint, rest, poolOptionsFrom(pool, idx)) });
    }
    const conf = parseConf(serializeConf(m.conf));
    conf.forEach(e => { if (e.type === 'data' && e.name === name) e.path = placeholder; });
    const text = serializeConf(conf.filter(e => !(e.type === 'content' && isUnder(e.path, d.path))));
    steps.push({ title: 'Create an empty folder standing in for the disk', detail: placeholder, run: () => StorageAPI.mkdir(placeholder) });
    steps.push({ title: `Point ${name} to the empty folder`, detail: m.inv.engine_conf.path, run: () => StorageAPI.saveConf(text) });
    steps.push({ title: 'Sync, so the parity forgets the disk', detail: 'sync --force-empty', run: () => API.schedule([{ command: 'probe' }, { command: 'sync', args: ['-E'] }]) });

    dialog({
        title: `Remove data disk ${name}`,
        body: `
            <p class="text-sm mb-4">
                The files on <span class="font-mono">${escHtml(d.path)}</span> (${size(used)}) stay on the disk, but they leave the array:
                they are no longer protected${pool ? ' and no longer visible in the pool' : ''}. Move elsewhere what you want to keep in the array <b>before</b> going on.
            </p>
            ${contentOnIt.length && m.content.length - contentOnIt.length < m.parity.length + 1 ? `<p class="text-sm text-amber mb-4">A content file lives on this disk. After the removal only ${m.content.length - contentOnIt.length} remain: add one on another disk in the configuration below.</p>` : ''}
            ${stepList(steps)}
            <p class="text-sm text-muted mt-4">When the sync has completed, come back here and press <b>Finish removal</b> to drop the disk from the configuration.</p>`,
        buttons: [
            { label: 'Cancel', onClick: (dl) => dl.close() },
            { label: 'Remove from the array', cls: 'btn-danger', onClick: (dl) => runSteps(dl, steps, 'The sync is running: follow it in Tasks, then press Finish removal.') }
        ]
    });
};

const removeFinish = async (name) => {
    if (!adminGuard()) return;
    const m = state.model;
    if (!(await confirmDo({
        title: `Finish removing ${name}`,
        intro: `Do this only after the sync started by the removal has completed.`,
        effects: [`<b>${escHtml(name)}</b> is deleted from the SnapRAID configuration.`, 'The daemon reloads the array.'],
        safe: ['The files on the removed disk are untouched: the disk can be unplugged or reused.'],
        label: 'Finish removal'
    }))) return;
    try {
        const tasks = await API.getTasks();
        if ((tasks.active || []).length || (tasks.pending || []).length) {
            showToast('A task is still running: wait for the sync to complete', 'warning');
            return;
        }
        const last = (tasks.history || []).find(t => t.command === 'sync');
        if (last && last.exit_code !== 0) {
            showToast('The last sync did not complete: run it again before finishing', 'warning');
            return;
        }
        const conf = m.conf.filter(e => !(e.type === 'data' && e.name === name));
        await StorageAPI.saveConf(serializeConf(conf));
        await afterConfChange();
        showToast(`Disk ${name} removed from the array`, 'info');
        reload();
    } catch (e) {
        showToast(e.message, 'error');
    }
};

/* --- configuration --- */

const confSave = async () => {
    if (!adminGuard()) return;
    const m = state.model;
    if (!(await confirmDo({
        title: 'Save the SnapRAID configuration',
        effects: [
            `<span class="font-mono">${escHtml(m.inv.engine_conf.path)}</span> is rewritten with the rules, content files and options shown here.`,
            'Excluded files leave the array at the next sync: they stay on disk but are no longer protected.',
            'The daemon reloads the array right away.'
        ],
        safe: ['Disks, parity and pool are not touched.', 'The previous configuration is kept next to it as .bak.'],
        label: 'Save'
    }))) return;
    const lines = (id) => document.getElementById(id).value.split('\n').map(s => s.trim()).filter(Boolean);
    const filters = [];
    for (const l of lines('conf-filters')) {
        const f = l.match(/^(exclude|include)\s+(\S.*)$/i);
        if (!f) { showToast(`Not a rule: "${l}". Start each line with exclude or include.`, 'error'); return; }
        filters.push({ type: 'filter', key: f[1].toLowerCase(), pattern: f[2] });
    }
    const contents = lines('conf-content');
    if (contents.some(c => !c.startsWith('/'))) { showToast('Content files need absolute paths', 'error'); return; }
    if (m.configured && contents.length < 1) { showToast('At least one content file is required', 'error'); return; }
    const num = (id, what) => {
        const v = document.getElementById(id).value.trim();
        if (v && !/^\d+$/.test(v)) throw new Error(`${what} must be a number`);
        return v;
    };

    try {
        const autosave = num('conf-autosave', 'Autosave'), blocksize = num('conf-blocksize', 'Block size');
        const nohidden = document.getElementById('conf-nohidden').checked;
        // keep the position of the first entry of each kind, replace the whole group
        const replaceGroup = (conf, type, fresh) => {
            const at = conf.findIndex(e => e.type === type);
            const rest = conf.filter(e => e.type !== type);
            if (at < 0) return [...rest, ...fresh];
            const before = conf.slice(0, at).filter(e => e.type !== type).length;
            rest.splice(before, 0, ...fresh);
            return rest;
        };
        let conf = parseConf(serializeConf(m.conf));
        conf = replaceGroup(conf, 'content', contents.map(path => ({ type: 'content', path })));
        conf = replaceGroup(conf, 'filter', filters);
        const setOpt = (key, value, present) => {
            conf = conf.filter(e => !(e.type === 'option' && e.key === key));
            if (present) conf.push({ type: 'option', key, value });
        };
        setOpt('autosave', autosave, !!autosave);
        if (!m.configured) setOpt('blocksize', blocksize, !!blocksize);
        setOpt('nohidden', '', nohidden);
        await StorageAPI.saveConf(serializeConf(conf));
        await afterConfChange();
        showToast('Configuration saved. The previous one is kept as .bak', 'info');
        reload();
    } catch (e) {
        showToast(e.message, 'error');
    }
};

const confRaw = () => {
    const m = state.model;
    dialog({
        title: m.inv.engine_conf.path,
        body: `
            <p class="text-sm text-muted mb-2">The file as it is. A wrong line stops every SnapRAID command, the previous version is kept as .bak.</p>
            <textarea id="conf-raw" class="form-control font-mono text-sm" rows="22" spellcheck="false">${escHtml(m.inv.engine_conf.text)}</textarea>`,
        buttons: [
            { label: 'Cancel', onClick: (dl) => dl.close() },
            {
                label: 'Save', cls: 'btn-primary', onClick: async (dl) => {
                    if (!adminGuard()) return;
                    try {
                        await StorageAPI.saveConf(dl.body.querySelector('#conf-raw').value.replace(/\r/g, '').replace(/\n*$/, '\n'));
                        await afterConfChange();
                        dl.close(); showToast('Configuration saved', 'info'); reload();
                    } catch (e) { showToast(e.message, 'error'); }
                }
            }
        ]
    });
};

const confDefaults = () => {
    const box = document.getElementById('conf-filters');
    const have = new Set(box.value.split('\n').map(s => s.trim()));
    const add = DEFAULT_EXCLUDES.map(p => `exclude ${p}`).filter(l => !have.has(l));
    box.value = [box.value.trim(), ...add].filter(Boolean).join('\n');
    showToast(add.length ? `${add.length} rules added, save to apply` : 'They are all there already', 'info');
};

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

export const initStorage = () => {
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-st]');
        if (!el || el.disabled) return;
        const ds = el.dataset;
        switch (ds.st) {
            case 'wizard': openWizard(); break;
            case 'reload': reload().then(() => showToast('Reloaded', 'info')); break;
            case 'prepare': prepareDisk(ds.device); break;
            case 'mount': mountFs(ds.device); break;
            case 'unmount': unmountFs(ds.target); break;
            case 'replace': replaceDisk(ds.kind, ds.name); break;
            case 'remove': removeDisk(ds.name); break;
            case 'remove-finish': removeFinish(ds.name); break;
            case 'pool-create': poolCreate(); break;
            case 'tab': state.tab = ds.tab; render(); window.scrollTo(0, 0); document.getElementById('view-container')?.scrollTo?.(0, 0); break;
            case 'pool-apply':
                poolUpdate(Number(ds.pool), b => b, 'Pool updated', (p) => ({
                    title: `Change the pool ${p.mountpoint}`,
                    effects: ['The new policy and free space limit apply to files created from now on.', 'The settings are saved, so they are the same after a reboot.'],
                    safe: ['No file is moved. Nothing is unmounted, programs using the pool do not notice.'],
                    label: 'Apply'
                }));
                break;
            case 'pool-branch-add':
                poolUpdate(Number(ds.pool), b => [...b, stripSlash(ds.path)], 'Disk added to the pool', (p) => ({
                    title: `Add ${ds.path} to the pool`,
                    effects: [`The files already on <span class="font-mono">${escHtml(ds.path)}</span> appear in <span class="font-mono">${escHtml(p.mountpoint)}</span>, merged with the others.`, 'New files can land on this disk too.'],
                    safe: ['No file is moved or copied.'],
                    label: 'Add to the pool'
                }));
                break;
            case 'pool-branch-remove':
                poolUpdate(Number(ds.pool), b => b.filter(x => x.split('=')[0] !== stripSlash(ds.path)), 'Disk removed from the pool', (p) => ({
                    title: `Take ${ds.path} out of the pool`,
                    effects: [`The files on <span class="font-mono">${escHtml(ds.path)}</span> disappear from <span class="font-mono">${escHtml(p.mountpoint)}</span>. Programs reading them through the pool stop finding them.`, 'No new file is written to this disk through the pool.'],
                    safe: ['The files stay on the disk, readable at its own folder.', 'The SnapRAID array is not changed: the disk stays protected.'],
                    label: 'Take out', danger: true
                }));
                break;
            case 'recover': recoverDialog(); break;
            case 'balance': balanceStart(Number(ds.pool)); break;
            case 'duplicates': duplicatesStart(Number(ds.pool)); break;
            case 'browse': e.preventDefault(); browseTo(Number(ds.pool), ds.path); break;
            case 'job-stop': StorageAPI.jobStop().then(() => showToast('Stopping after the current file', 'info')).catch(er => showToast(er.message, 'error')); break;
            case 'sync-now': API.schedule([{ command: 'sync' }]).then(() => showToast('Sync started: follow it in Tasks', 'info')).catch(er => showToast(er.message, 'error')); break;
            case 'conf-save': confSave(); break;
            case 'conf-raw': confRaw(); break;
            case 'conf-defaults': confDefaults(); break;
        }
    });

    document.addEventListener('change', (e) => {
        const m = e.target.id?.match(/^pool-policy-(\d+)$/);
        if (m) {
            const help = document.getElementById(`pool-policy-help-${m[1]}`);
            if (help) help.innerText = (POLICIES.find(([k]) => k === e.target.value) || ['', ''])[1];
        }
    });
};

// The parts with logic and no page, for the tests in test/ui.
export const __test = {
    parseConf, serializeConf, buildModel, buildPlan, candidates, advise, layoutOf, balanceNeed,
    parseSize, shortSize, setOption, getOption, recommendedParity, defaultPoolOptions, state,
    MAX_DATA, MAX_SPLIT, EXT4_FILE_MAX
};
