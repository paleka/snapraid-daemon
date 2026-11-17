// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Paleka

/*
 * The Arrays page: every array of the machine with its health, the pools
 * and the mounts with what protects them, and the operations that involve
 * more than one array.
 *
 * The other pages work on one array, the one chosen here or with the
 * switcher in the sidebar.
 */

import { API, ARRAY_DEFAULT } from './api.js';
import { escHtml, escAttr, showToast, formatDiskSize, formatElapsedTime } from './utils.js';
import { parseConf, serializeConf, confInsert, dialog, stepList, stripSlash, isUnder, REMOVED_BASE } from './storage.js';

const state = { view: null, arrays: null, inv: null, onChange: null, signature: '' };

const SYSTEM_TARGETS = ['/', '/boot', '/boot/efi', '/efi', '/usr', '/var', '/home', '/nix'];
const HEALTH_ORDER = ['passed', 'pending', 'corrupt', 'degraded', 'prefail', 'failing'];
const HEALTH_COLOR = { passed: 'green', pending: 'grey', corrupt: 'orange', degraded: 'orange', prefail: 'orange', failing: 'red' };
const HEALTH_TEXT = { passed: 'healthy', pending: 'pending', corrupt: 'silent errors', degraded: 'degraded', prefail: 'disk about to fail', failing: 'disk failing' };

const badge = (text, color) => `<span class="badge badge-${color}">${escHtml(text)}</span>`;
const size = (bytes) => (bytes == null ? '–' : formatDiskSize(bytes));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* model                                                               */
/* ------------------------------------------------------------------ */

/** The worst health among the arrays that are set up. */
export const overallHealth = (arrays) => {
    const set = (arrays || []).filter(a => a.configured || a.health !== 'pending');
    if (!set.length) return 'pending';
    return set.map(a => a.health).sort((a, b) => HEALTH_ORDER.indexOf(b) - HEALTH_ORDER.indexOf(a))[0];
};

/** Colour index of an array, the same everywhere in the page. */
const colorOf = (arrays, name) => {
    const i = (arrays || []).findIndex(a => a.name === name);
    return i < 0 ? 'x' : String(i % 6);
};

/**
 * Filesystems that are of no array and of no pool: an SSD for the
 * applications, a backup disk, a network share.
 */
export const separateMounts = (inv) => {
    const seen = new Set();
    const branches = new Set((inv.pools || []).flatMap(p => p.branches.map(b => stripSlash(b.path))));
    return (inv.mounts || []).filter(m => {
        if (m.array || m.is_dir === false || seen.has(m.target)) return false;
        if (/mergerfs/.test(m.fstype) || SYSTEM_TARGETS.includes(m.target)) return false;
        if (m.target.startsWith(REMOVED_BASE) || /^(tmpfs|devtmpfs|shm)$/.test(m.fstype)) return false;
        // a read-only filesystem is an image of something, not a place where files get lost
        if (/(^|,)ro(,|$)/.test(m.options || '')) return false;
        const disk = m.source.startsWith('/dev/');
        const network = /^(nfs|nfs4|cifs|smb3|fuse\.sshfs)$/.test(m.fstype);
        if (!disk && !network) return false;
        // what the system itself is on, also when mounted more than once like in a container
        if ((inv.mounts || []).some(o => SYSTEM_TARGETS.includes(o.target) && o.source === m.source)) return false;
        seen.add(m.target);
        return true;
    }).map(m => ({ ...m, network: !m.source.startsWith('/dev/'), inPool: branches.has(stripSlash(m.target)) }));
};

/** What an array holds, from the inventory: its data disks and parity files with their filesystem. */
const usesOf = (inv, name, role) => ((inv.arrays || []).find(a => a.name === name)?.uses || [])
    .filter(u => u.role === role && !u.path.startsWith(REMOVED_BASE + '/'));

const mountInfo = (inv, target) => (inv.mounts || []).find(m => m.target === target);

/**
 * The changes to the two SnapRAID configurations that move a data disk,
 * with its files, from an array to another.
 *
 * The disk leaves the first array like any removed disk: it's pointed to an
 * empty folder and the parity is synced, so the first array stays fully
 * protected. Only then it's dropped there and added to the second array.
 *
 * @returns {{error?: string, placeholder?: string, path?: string, name?: string, parked?: string, dropped?: string, added?: string}}
 */
export const planMoveDisk = (fromName, fromText, toText, diskName, newName) => {
    const from = parseConf(fromText);
    const to = parseConf(toText);
    const entry = from.find(e => e.type === 'data' && e.name === diskName);
    if (!entry) return { error: `There is no data disk ${diskName} in the array ${fromName}.` };
    if (entry.path.startsWith(REMOVED_BASE + '/')) return { error: `${diskName} is already being removed from the array ${fromName}.` };
    if (from.filter(e => e.type === 'data').length < 2) return { error: `${diskName} is the only data disk of the array ${fromName}: an array cannot be left without data disks. Remove the array instead.` };
    if (!to.some(e => e.type === 'parity')) return { error: 'The destination array has no parity yet: set it up first, the disk can be added afterwards.' };
    if (!/^[A-Za-z0-9_]+$/.test(newName)) return { error: 'The name of the disk can have only letters, digits and _.' };
    if (to.some(e => e.type === 'data' && e.name === newName)) return { error: `The destination array already has a disk named ${newName}.` };

    const path = stripSlash(entry.path);
    const parityLevels = from.filter(e => e.type === 'parity').length;
    const contentLeft = from.filter(e => e.type === 'content' && !isUnder(e.path, path)).length;
    if (contentLeft < parityLevels + 1)
        return { error: `The array ${fromName} keeps a content file on this disk and would be left with ${contentLeft}: it needs ${parityLevels + 1}. Add a content file on another disk in Storage, Configuration, then try again.` };

    const placeholder = fromName === ARRAY_DEFAULT ? `${REMOVED_BASE}/${diskName}` : `${REMOVED_BASE}/${fromName}-${diskName}`;
    const parked = from.filter(e => !(e.type === 'content' && isUnder(e.path, path))).map(e => (e === entry ? { ...e, path: placeholder } : e));
    const dropped = parked.filter(e => !(e.type === 'data' && e.name === diskName));
    const added = parseConf(serializeConf(to));
    confInsert(added, { type: 'data', key: 'data', name: newName, path });

    return { placeholder, path, name: newName, parked: serializeConf(parked), dropped: serializeConf(dropped), added: serializeConf(added) };
};

/* ------------------------------------------------------------------ */
/* API of a named array                                                */
/* ------------------------------------------------------------------ */

const urlOf = (name) => (name === ARRAY_DEFAULT ? '/snapraid/v1' : `/snapraid/v1/arrays/${name}`);

const call = async (name, endpoint, method = 'GET', body) => {
    const response = await fetch(`${urlOf(name)}${endpoint}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await response.json(); } catch (ignore) { /* not json */ }
    if (!response.ok) throw new Error(json?.message || `Request failed with status ${response.status}`);
    return json;
};

/** Wait for the tasks of an array to end, and tell how the last sync went. */
const waitSync = async (name, onTick) => {
    await sleep(2000);
    for (;;) {
        const tasks = await call(name, '/tasks?limit_messages=0');
        const busy = (tasks.active || []).length + (tasks.pending || []).length;
        if (onTick) onTick(tasks);
        if (!busy) {
            const last = (tasks.history || []).find(t => t.command === 'sync');
            if (!last || last.status !== 'terminated' || last.exit_code !== 0)
                throw new Error(`The sync of the array ${name} did not complete. Nothing else was changed: the disk is still marked as being removed there. Look at Tasks, solve the problem, then finish from Storage of that array.`);
            return;
        }
        await sleep(2000);
    }
};

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

const usageBar = (total, free) => {
    if (!total) return '<span class="text-xs text-muted">–</span>';
    const used = total - free;
    const pct = Math.round(used * 100 / total);
    return `
        <div class="ar-usage"><div class="ar-usage-bar ${pct >= 95 ? 'ar-usage-full' : ''}" data-style-width="${pct}%"></div></div>
        <div class="text-xs text-muted">${size(used)} of ${size(total)} · ${pct}%</div>`;
};

const taskLine = (a) => {
    if (a.active_command)
        return `<span class="text-emerald font-bold">${escHtml(a.active_command.toUpperCase())}</span>${a.progress !== undefined ? ` ${a.progress}%` : ''}${a.pending_count ? ` · ${a.pending_count} queued` : ''}`;
    if (a.waiting_for === 'storage') return 'waiting for the balance of its disks to end';
    if (a.waiting_for === '*') return 'waiting for the other arrays before shutting down';
    if (a.waiting_for) return `waiting for the array <b>${escHtml(a.waiting_for)}</b> to finish`;
    if (a.pending_count) return `${a.pending_count} queued`;
    return 'idle';
};

/** How much is waiting for the next sync: what a failed disk would take with it. */
const windowLine = (a) => {
    if (!a.configured) return '';
    const since = a.last_sync_at ? formatElapsedTime(Math.max(0, (Date.now() - new Date(a.last_sync_at).getTime()) / 1000)) : null;
    // a sync run from the command line is not known here
    const when = since ? (since === 'now' ? 'synced just now' : `last sync ${since} ago`) : 'no sync run from here yet';
    if (a.diff_pending) return `<span class="text-amber">${plural(a.diff_pending, 'change', 'changes')} not yet protected</span> · ${when}`;
    return `everything protected · ${when}`;
};

const renderArrayCard = (a, arrays, selected) => {
    const color = colorOf(arrays, a.name);
    return `
        <div class="card ar-card ar-c${color} ${a.name === selected ? 'ar-card-selected' : ''}">
            <div class="flex justify-between items-center flex-wrap gap-2 mb-2">
                <h3><span class="ar-dot"></span>${escHtml(a.name)}${a.default ? ' <span class="text-xs text-muted">main configuration</span>' : ''}</h3>
                <div>${a.configured ? badge(HEALTH_TEXT[a.health] || a.health, HEALTH_COLOR[a.health] || 'grey') : badge('not set up', 'blue')}</div>
            </div>
            ${a.configured ? `
                <div class="text-sm mb-2">${plural(a.data_disks_count, 'data disk', 'data disks')} · ${a.parity_disks_count ? `${plural(a.parity_disks_count, 'disk', 'disks')} can fail` : 'no parity'}</div>
                ${usageBar(a.total_space_bytes, a.free_space_bytes)}
                <div class="text-sm mt-2">${windowLine(a)}</div>
                <div class="text-sm text-muted mt-1">${taskLine(a)}</div>
                ${a.health !== 'passed' && a.health_reason ? `<div class="text-sm text-amber mt-2">${escHtml(a.health_reason)}</div>` : ''}`
            : `<div class="text-sm text-muted mb-2">No disks yet. Open it and run the guided setup in Storage: it uses the disks that no other array has.</div>`}
            <div class="text-xs text-muted font-mono mt-2">${escHtml(a.engine_conf || '')}</div>
            <div class="flex gap-2 mt-4 flex-wrap">
                <button class="btn btn-primary btn-sm" data-ar="open" data-name="${escAttr(a.name)}" data-to="${a.configured ? '#/' : '#/storage'}">${a.configured ? 'Open' : 'Set up'}</button>
                ${a.configured ? `<button class="btn btn-secondary btn-sm" data-ar="open" data-name="${escAttr(a.name)}" data-to="#/storage">Storage</button>` : ''}
                ${a.default ? '' : `<button class="btn btn-secondary btn-sm" data-ar="remove" data-name="${escAttr(a.name)}" data-tooltip="Stop handling this array. Its disks and files are not touched.">Remove…</button>`}
            </div>
        </div>`;
};

/** Disks on the left, the arrays protecting them in the middle, the pools showing them on the right. */
const renderMap = (arrays, inv) => {
    const chip = (text, cls, tip) => `<span class="ar-chip ${cls}" ${tip ? `data-tooltip="${escAttr(tip)}"` : ''}>${escHtml(text)}</span>`;
    const base = (p) => p.slice(p.lastIndexOf('/') + 1) || p;

    const arrayBoxes = arrays.map(a => {
        const c = colorOf(arrays, a.name);
        const data = usesOf(inv, a.name, 'data');
        const parity = usesOf(inv, a.name, 'parity');
        return `
            <div class="ar-box ar-c${c}">
                <div class="ar-box-title"><span class="ar-dot"></span>${escHtml(a.name)}</div>
                <div class="ar-chips">
                    ${data.map(u => chip(u.name, 'ar-chip-data', `${u.path}${mountInfo(inv, u.mount)?.total_bytes ? ` · ${size(mountInfo(inv, u.mount).total_bytes)}` : ''}`)).join('')}
                    ${parity.map(u => chip(u.name, 'ar-chip-parity', u.path)).join('')}
                    ${!data.length && !parity.length ? '<span class="text-xs text-muted">no disks yet</span>' : ''}
                </div>
            </div>`;
    }).join('');

    const poolBoxes = (inv.pools || []).map(p => `
        <div class="ar-box">
            <div class="ar-box-title font-mono">${escHtml(p.mountpoint)}</div>
            <div class="ar-chips">
                ${p.branches.map(b => b.protected
                    ? chip(b.disk || base(b.path), `ar-chip-data ar-c${colorOf(arrays, b.array)}`, `${b.path} · protected by ${b.array}`)
                    : chip(base(b.path), 'ar-chip-loose', `${b.path} · in no array: no parity for the files landing here`)).join('')}
            </div>
        </div>`).join('');

    const loose = separateMounts(inv).filter(m => !m.inPool);

    return `
        <div class="ar-map">
            <div class="ar-col">
                <div class="ar-col-title">Arrays <span class="text-muted">parity protects these disks</span></div>
                ${arrayBoxes}
            </div>
            <div class="ar-col">
                <div class="ar-col-title">Pools <span class="text-muted">folders joining disks</span></div>
                ${poolBoxes || '<div class="text-sm text-muted">No pool. Every disk is a folder of its own.</div>'}
            </div>
            <div class="ar-col">
                <div class="ar-col-title">Separate <span class="text-muted">no parity</span></div>
                ${loose.length ? `<div class="ar-box"><div class="ar-chips">${loose.map(m => chip(base(m.target), 'ar-chip-loose', `${m.target} · ${m.fstype}${m.total_bytes ? ` · ${size(m.total_bytes)}` : ''}`)).join('')}</div></div>`
                    : '<div class="text-sm text-muted">Nothing mounted outside of arrays and pools.</div>'}
            </div>
        </div>
        <div class="ar-legend">
            <span class="ar-chip ar-chip-data ar-c0">data</span> coloured like its array
            <span class="ar-chip ar-chip-parity">parity</span>
            <span class="ar-chip ar-chip-loose">not protected</span>
        </div>`;
};

const renderPools = (arrays, inv) => {
    const pools = inv.pools || [];
    if (!pools.length) return '';
    return `
        <div class="card">
            <h3>Pools</h3>
            <div class="text-sm text-muted mt-2 mb-4">A pool is only a view: every file is a plain file on one of its disks, protected by the array that disk is in.</div>
            <div class="overflow-x-auto"><table class="data-table dense">
                <thead><tr><th>Folder</th><th>Usage</th><th>Disks</th><th>Protection</th></tr></thead>
                <tbody>${pools.map(p => {
                    const owners = [...new Set(p.branches.filter(b => b.protected).map(b => b.array))];
                    const bare = p.branches.filter(b => !b.protected);
                    let prot;
                    if (!bare.length && owners.length === 1) prot = badge(`protected by ${owners[0]}`, 'green');
                    else if (!bare.length) prot = badge(`protected by ${owners.join(' and ')}`, 'blue');
                    else if (!owners.length) prot = badge('not protected', 'orange');
                    else prot = badge(`${plural(bare.length, 'disk', 'disks')} not protected`, 'orange');
                    return `
                    <tr>
                        <td class="font-mono">${escHtml(p.mountpoint)}${p.persistent ? '' : ` ${badge('not saved in fstab', 'orange')}`}</td>
                        <td class="ar-usage-cell">${usageBar(p.total_bytes, p.free_bytes)}</td>
                        <td>${p.branches.map(b => `<div class="text-xs font-mono">${escHtml(b.path)} ${b.protected ? `<span class="text-muted">${escHtml(b.array)}/${escHtml(b.disk)}</span>` : '<span class="text-amber">no array</span>'}</div>`).join('')}</td>
                        <td>${prot}${owners.length > 1 ? '<div class="text-xs text-muted mt-1">Each array protects only the files on its own disks, on its own schedule.</div>' : ''}</td>
                    </tr>`;
                }).join('')}</tbody>
            </table></div>
        </div>`;
};

const renderSeparate = (inv) => {
    const list = separateMounts(inv);
    if (!list.length) return '';
    return `
        <div class="card">
            <h3>Separate mounts</h3>
            <div class="text-sm text-muted mt-2 mb-4">Filesystems that are in no array. They are watched, but a failure here loses what is on them: keep a backup, or add the disk to an array from its Storage page.</div>
            <div class="overflow-x-auto"><table class="data-table dense">
                <thead><tr><th>Mounted at</th><th>From</th><th>Usage</th><th></th></tr></thead>
                <tbody>${list.map(m => `
                    <tr>
                        <td class="font-mono">${escHtml(m.target)}</td>
                        <td><span class="font-mono text-xs">${escHtml(m.source)}</span> <span class="text-xs text-muted">${escHtml(m.fstype)}</span></td>
                        <td class="ar-usage-cell">${usageBar(m.total_bytes, m.free_bytes)}</td>
                        <td>${badge(m.network ? 'network share' : 'not protected', m.network ? 'grey' : 'orange')}${m.inPool ? ` ${badge('in a pool', 'blue')}` : ''}</td>
                    </tr>`).join('')}</tbody>
            </table></div>
        </div>`;
};

const render = () => {
    const { arrays, inv } = state;
    const list = arrays.arrays;
    const health = overallHealth(list);
    const set = list.filter(a => a.configured);
    const pools = (inv.pools || []).length;
    const loose = separateMounts(inv).length;
    const waiting = list.filter(a => a.waiting_for && a.waiting_for !== '*' && a.waiting_for !== 'storage');
    const movable = set.length >= 2 || (set.length === 1 && list.length >= 2);

    state.view.innerHTML = `
        <div class="fade-in ar-page">
            <div class="card ar-summary ar-summary-${HEALTH_COLOR[health] || 'grey'}">
                <div>
                    <div class="ar-summary-title">${health === 'passed' ? 'Everything is healthy' : health === 'pending' ? 'Nothing is set up yet' : `Needs attention: ${escHtml(HEALTH_TEXT[health] || health)}`}</div>
                    <div class="text-sm">${plural(list.length, 'array', 'arrays')} · ${plural(pools, 'pool', 'pools')} · ${plural(loose, 'separate mount', 'separate mounts')}</div>
                </div>
                <div class="flex gap-2 flex-wrap">
                    ${movable && inv.admin ? `<button class="btn btn-secondary" data-ar="move" data-tooltip="Move a data disk, with its files, to another array">Move a disk…</button>` : ''}
                    <button class="btn btn-primary" data-ar="add" data-tooltip="Another set of disks with its own parity and schedule">Add an array…</button>
                </div>
            </div>
            ${list.length > 1 ? `
            <div class="card ar-run">
                <div>
                    <div class="font-bold">${arrays.array_parallel ? 'Arrays that share no disk run at the same time' : 'Arrays run one at a time'}</div>
                    <div class="text-sm text-muted">${arrays.array_parallel
                        ? 'Faster, but every disk of the machine can be working, and heating, together.'
                        : 'A sync or a scrub of an array waits for the one of another to end. Checks of the disks are never delayed.'}
                        ${waiting.length ? `<span class="text-amber">Now waiting: ${waiting.map(a => escHtml(a.name)).join(', ')}.</span>` : ''}</div>
                </div>
                <button class="btn btn-secondary btn-sm" data-ar="parallel" data-value="${arrays.array_parallel ? '0' : '1'}">${arrays.array_parallel ? 'Run one at a time' : 'Allow together'}</button>
            </div>` : ''}
            <div class="ar-grid">${list.map(a => renderArrayCard(a, list, API.array())).join('')}</div>
            <div class="card">
                <h3>How it fits together</h3>
                <div class="text-sm text-muted mt-2 mb-4">An array protects its disks with parity. A pool shows disks as one folder. A disk can be in one array only; a pool can take disks from anywhere.</div>
                ${renderMap(list, inv)}
            </div>
            ${renderPools(list, inv)}
            ${renderSeparate(inv)}
        </div>`;
    state.view.querySelectorAll('[data-style-width]').forEach(el => { el.style.width = el.dataset.styleWidth; });
};

/* ------------------------------------------------------------------ */
/* loading                                                             */
/* ------------------------------------------------------------------ */

const signatureOf = (arrays) => JSON.stringify((arrays.arrays || []).map(a => [a.name, a.health, a.configured, a.active_command, a.progress, a.pending_count, a.waiting_for, a.diff_pending, a.data_disks_count, a.free_space_bytes, a.last_sync_at]).concat([arrays.array_parallel]));

export const loadArrays = async (view, onChange) => {
    state.view = view || state.view;
    if (onChange) state.onChange = onChange;
    const [arrays, inv] = await Promise.all([API.getArrays(), API.getInventory()]);
    state.arrays = arrays;
    state.inv = inv;
    state.signature = signatureOf(arrays);
    render();
};

/** Called at every poll while the page is shown: redraw only when something changed. */
export const refreshArrays = async (arrays) => {
    if (!state.view || !document.body.contains(state.view) || !arrays) return;
    if (document.querySelector('.modal-overlay')) return;
    const signature = signatureOf(arrays);
    if (signature === state.signature) return;
    try { await loadArrays(); } catch (ignore) { /* shown at the next poll */ }
};

const reload = async () => {
    try { await loadArrays(); } catch (e) { showToast('Failed to reload: ' + e.message, 'error'); }
    if (state.onChange) state.onChange();
};

const adminGuard = () => {
    if (state.inv?.admin) return true;
    showToast(state.inv?.admin_reason || 'Changing the arrays from here is disabled.', 'warning');
    return false;
};

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

const addArray = () => {
    if (!adminGuard()) return;
    const dir = (state.arrays.arrays[0]?.daemon_conf || '/etc/snapraidd.conf').replace(/[^/]*$/, '') + 'snapraid';
    const dl = dialog({
        title: 'Add an array',
        large: false,
        body: `
            <p class="text-sm text-muted mb-4">An array is a set of disks with its own parity, schedule and settings. Use more than one to keep, for example,
                a few small disks for documents apart from the big ones for media, each with the protection it deserves.</p>
            <div class="form-group"><label for="ar-name">Name</label>
                <input class="form-control" id="ar-name" placeholder="media" autocomplete="off" spellcheck="false" maxlength="31">
                <div class="text-xs text-muted mt-1">Lowercase letters, digits, - and _. It shows up in logs, notifications and addresses.</div></div>
            <div class="form-group"><label for="ar-conf">SnapRAID configuration file</label>
                <input class="form-control font-mono" id="ar-conf" placeholder="${escAttr(dir)}/NAME.conf" autocomplete="off" spellcheck="false">
                <div class="text-xs text-muted mt-1">Leave empty for a new array. To take over an array already set up by hand, write the path of its configuration: it's read as it is, nothing is changed.</div></div>
            <div class="st-effects">
                <div class="st-effects-title">What happens</div>
                <ul><li>The array appears here, empty or with the disks of its configuration.</li>
                    <li>It starts with the same schedule and settings of the main array: change them in its Settings.</li>
                    <li>No disk is touched. The guided setup in Storage does that, and asks before.</li></ul>
            </div>`,
        buttons: [
            { label: 'Cancel', onClick: (d) => d.close() },
            {
                label: 'Add', cls: 'btn-primary', onClick: async (d) => {
                    const name = d.body.querySelector('#ar-name').value.trim();
                    const conf = d.body.querySelector('#ar-conf').value.trim();
                    if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(name)) { showToast('Choose a name made of lowercase letters, digits, - and _', 'warning'); return; }
                    try {
                        const created = await API.createArray(name, conf);
                        d.close();
                        showToast(`Array ${name} added`, 'info');
                        await reload();
                        // a new empty array goes straight to its setup; one taken over shows what it has
                        if (!conf) open(created?.name || name, '#/storage');
                    } catch (e) { showToast(e.message, 'error'); }
                }
            }
        ]
    });
    setTimeout(() => dl.body.querySelector('#ar-name')?.focus(), 50);
};

const removeArray = (name) => {
    if (!adminGuard()) return;
    const a = state.arrays.arrays.find(x => x.name === name);
    if (!a) return;
    dialog({
        title: `Remove the array ${name}`,
        large: false,
        body: `
            <div class="st-effects">
                <div class="st-effects-title">What happens</div>
                <ul><li>The daemon stops handling <b>${escHtml(name)}</b>: no more syncs, scrubs, checks of its disks or notifications.</li>
                    ${a.configured ? `<li class="text-amber">Its files stay where they are, but new and changed files are <b>no longer protected</b> until something syncs the array again.</li>` : ''}
                    <li>Its settings are kept aside as <span class="font-mono">${escHtml((a.daemon_conf || '') + '.removed')}</span>.</li></ul>
                <div class="st-effects-title mt-4">What is not touched</div>
                <ul><li>The disks, the files, the parity and the content files.</li>
                    <li>The SnapRAID configuration <span class="font-mono">${escHtml(a.engine_conf || '')}</span>: add an array with this file to take it back, or use it from the command line.</li>
                    <li>Mounts and pools.</li></ul>
            </div>`,
        buttons: [
            { label: 'Cancel', onClick: (d) => d.close() },
            {
                label: 'Remove the array', cls: 'btn-danger', onClick: async (d) => {
                    try {
                        await API.removeArray(name);
                        d.close();
                        if (API.array() === name) API.setArray(ARRAY_DEFAULT);
                        showToast(`Array ${name} removed`, 'info');
                        reload();
                    } catch (e) { showToast(e.message, 'error'); }
                }
            }
        ]
    });
};

const setParallel = async (value) => {
    if (!adminGuard()) return;
    try {
        await fetch('/snapraid/v2/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ array_parallel: value }) })
            .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `Request failed with status ${r.status}`); });
        showToast(value ? 'Arrays that share no disk now run together' : 'Arrays now run one at a time', 'info');
        reload();
    } catch (e) { showToast(e.message, 'error'); }
};

const moveDisk = () => {
    if (!adminGuard()) return;
    const { inv } = state;
    const arrays = state.arrays.arrays;
    const sources = arrays.filter(a => usesOf(inv, a.name, 'data').length >= 2);
    if (!sources.length || arrays.length < 2) {
        dialog({ title: 'Move a disk', large: false, body: 'There is no disk to move: it takes an array with at least two data disks, and a second array set up with its parity.', buttons: [{ label: 'Close', onClick: (d) => d.close() }] });
        return;
    }
    const w = { from: sources[0].name, disk: '', to: '', name: '' };
    const targets = () => arrays.filter(a => a.name !== w.from && usesOf(inv, a.name, 'parity').length);
    const disks = () => usesOf(inv, w.from, 'data');
    const fix = () => {
        if (!disks().some(d => d.name === w.disk)) w.disk = disks()[0]?.name || '';
        if (!targets().some(a => a.name === w.to)) w.to = targets()[0]?.name || '';
        const used = new Set(usesOf(inv, w.to, 'data').map(d => d.name));
        w.name = w.disk;
        for (let i = 2; used.has(w.name); ++i) w.name = `${w.disk}_${i}`;
    };
    fix();

    const check = () => {
        const errors = [];
        const d = disks().find(x => x.name === w.disk);
        if (!w.to) errors.push('There is no other array set up with its parity to move the disk to.');
        if (d && w.to) {
            // the parity must be able to hold the largest data disk
            const total = mountInfo(inv, d.mount)?.total_bytes || 0;
            const parity = usesOf(inv, w.to, 'parity').filter(u => u.name === 'parity').reduce((a, u) => a + (mountInfo(inv, u.mount)?.total_bytes || 0), 0);
            if (total && parity && parity < total * 0.9)
                errors.push(`The parity of ${w.to} has ${size(parity)}, less than this disk (${size(total)}): it could not protect it. Give ${w.to} a larger parity first.`);
        }
        [w.from, w.to].filter(Boolean).forEach(n => {
            const a = arrays.find(x => x.name === n);
            if (a.active_command || a.pending_count) errors.push(`The array ${n} is working: wait for its tasks to end.`);
            else if (!['passed', 'corrupt'].includes(a.health)) errors.push(`The array ${n} is ${a.health}: solve that first, a disk is moved only between healthy arrays.`);
        });
        const from = arrays.find(x => x.name === w.from);
        if (from?.diff_pending) errors.push(`The array ${w.from} has ${plural(from.diff_pending, 'change', 'changes')} not yet synced: sync it first, so nothing is left behind unprotected.`);
        return errors;
    };

    const body = () => {
        const d = disks().find(x => x.name === w.disk);
        const errors = check();
        const steps = d && w.to ? [
            { title: `Point ${w.disk} of ${w.from} to an empty folder`, detail: `the files stay on ${d.path}` },
            { title: `Sync ${w.from}, so its parity forgets the disk`, detail: 'sync --force-empty · can take hours on big arrays' },
            { title: `Drop ${w.disk} from the configuration of ${w.from}` },
            { title: `Add it to ${w.to} as ${w.name}`, detail: d.path },
            { title: `Sync ${w.to}, so its parity protects the disk`, detail: 'continues in the background, follow it in Tasks' }
        ] : [];
        const inPool = (inv.pools || []).filter(p => d && p.branches.some(b => stripSlash(b.path) === stripSlash(d.path)));
        return `
            <p class="text-sm text-muted mb-4">Moves a data disk to another array together with its files. Nothing is copied or erased: only which parity protects the disk changes.</p>
            <div class="form-row">
                <div class="form-group"><label for="mv-from">From the array</label>
                    <select class="form-control" id="mv-from">${sources.map(a => `<option ${a.name === w.from ? 'selected' : ''}>${escHtml(a.name)}</option>`).join('')}</select></div>
                <div class="form-group"><label for="mv-disk">Disk</label>
                    <select class="form-control" id="mv-disk">${disks().map(x => `<option value="${escAttr(x.name)}" ${x.name === w.disk ? 'selected' : ''}>${escHtml(x.name)} — ${escHtml(x.path)}</option>`).join('')}</select></div>
            </div>
            <div class="form-row">
                <div class="form-group"><label for="mv-to">To the array</label>
                    <select class="form-control" id="mv-to">${targets().map(a => `<option ${a.name === w.to ? 'selected' : ''}>${escHtml(a.name)}</option>`).join('')}</select></div>
                <div class="form-group"><label for="mv-name">Name there</label>
                    <input class="form-control" id="mv-name" value="${escAttr(w.name)}" autocomplete="off" spellcheck="false"></div>
            </div>
            ${errors.map(e => `<div class="text-sm text-red mt-2">${escHtml(e)}</div>`).join('')}
            ${steps.length && !errors.length ? `
            <div class="st-effects-title mt-4">What is going to be done, in this order</div>
            ${stepList(steps)}
            <div class="restricted-banner mt-4">
                <div class="restricted-banner-title">Between the two syncs the disk has no parity</div>
                From the end of the first sync to the end of the second, a failure of this disk loses its files. The other disks of both arrays stay protected all the time.
                ${inPool.length ? `<br>The disk stays in the pool ${inPool.map(p => escHtml(p.mountpoint)).join(', ')}: its files keep the same paths there.` : ''}
            </div>` : ''}`;
    };

    const buttons = () => [
        { label: 'Cancel', onClick: (d) => d.close() },
        { label: 'Move the disk', cls: 'btn-primary', disabled: check().length > 0, onClick: (d) => run(d) }
    ];

    const draw = (dl) => {
        dl.setBody(body());
        dl.setButtons(buttons());
        const q = (id) => dl.body.querySelector(id);
        q('#mv-from').addEventListener('change', (e) => { w.from = e.target.value; w.disk = ''; fix(); draw(dl); });
        q('#mv-disk').addEventListener('change', (e) => { w.disk = e.target.value; fix(); draw(dl); });
        q('#mv-to').addEventListener('change', (e) => { w.to = e.target.value; fix(); draw(dl); });
        q('#mv-name').addEventListener('change', (e) => { w.name = e.target.value.trim(); });
    };

    const run = async (dl) => {
        w.name = dl.body.querySelector('#mv-name').value.trim();
        let plan;
        try {
            const [from, to] = await Promise.all([call(w.from, '/storage'), call(w.to, '/storage')]);
            plan = planMoveDisk(w.from, from.engine_conf.text, to.engine_conf.text, w.disk, w.name);
        } catch (e) { showToast(e.message, 'error'); return; }
        if (plan.error) { showToast(plan.error, 'warning'); return; }

        const steps = [
            { title: 'Create an empty folder standing in for the disk', detail: plan.placeholder, run: () => call(w.from, '/storage/mkdir', 'POST', { path: plan.placeholder }) },
            { title: `Point ${w.disk} of ${w.from} to the empty folder`, run: () => call(w.from, '/storage/engine_conf', 'PUT', { text: plan.parked }) },
            {
                title: `Sync ${w.from}, so its parity forgets the disk`, detail: 'sync --force-empty',
                run: async (tick) => {
                    await call(w.from, '/schedule', 'POST', { tasks: [{ command: 'probe' }, { command: 'sync', args: ['-E'] }] });
                    await waitSync(w.from, (tasks) => { const t = (tasks.active || [])[0]; tick(t && t.progress !== undefined ? `${t.command} ${t.progress}%` : 'working'); });
                }
            },
            {
                title: `Drop ${w.disk} from the configuration of ${w.from}`,
                run: async () => { await call(w.from, '/storage/engine_conf', 'PUT', { text: plan.dropped }); await call(w.from, '/schedule', 'POST', { tasks: [{ command: 'probe' }] }); }
            },
            { title: `Add it to ${w.to} as ${plan.name}`, detail: plan.path, run: () => call(w.to, '/storage/engine_conf', 'PUT', { text: plan.added }) },
            { title: `Start the sync of ${w.to}`, detail: 'continues in the background, follow it in Tasks', run: () => call(w.to, '/schedule', 'POST', { tasks: [{ command: 'probe' }, { command: 'sync' }] }) }
        ];

        const status = steps.map(() => 'todo');
        let note = '';
        const paint = (error) => dl.setBody(`
            <ol class="st-steps">${steps.map((s, i) => `
                <li class="st-step st-step-${status[i]}">
                    <span class="st-step-mark">${{ todo: '○', run: '…', ok: '✓', fail: '✕' }[status[i]]}</span>
                    <div><div class="font-bold">${escHtml(s.title)}</div>
                        ${s.detail ? `<div class="text-xs text-muted font-mono">${escHtml(s.detail)}</div>` : ''}
                        ${status[i] === 'run' && note ? `<div class="text-xs text-muted">${escHtml(note)}</div>` : ''}
                        ${status[i] === 'fail' ? `<div class="text-sm text-red mt-1">${escHtml(error)}</div>` : ''}</div>
                </li>`).join('')}</ol>
            <p class="text-sm text-muted mt-4">Keep this page open until the steps are done.</p>`);

        dl.setTitle(`Moving ${w.disk} from ${w.from} to ${w.to}`);
        dl.setButtons([{ label: 'Working…', disabled: true, onClick: () => { } }]);
        for (let i = 0; i < steps.length; ++i) {
            status[i] = 'run'; note = ''; paint();
            try {
                await steps[i].run((text) => { if (text !== note) { note = text; paint(); } });
                status[i] = 'ok';
            } catch (e) {
                status[i] = 'fail'; paint(e.message);
                dl.body.insertAdjacentHTML('beforeend', `<p class="text-sm mt-4">Stopped here. The steps marked ✓ are done and stay in place. No file was moved or erased.</p>`);
                dl.setButtons([{ label: 'Close', onClick: (d) => { d.close(); reload(); } }]);
                return;
            }
        }
        paint();
        dl.body.insertAdjacentHTML('beforeend', `<p class="text-sm mt-4 text-emerald">The disk is now in ${escHtml(w.to)}. It's protected again when the sync of ${escHtml(w.to)} completes: follow it in Tasks.</p>`);
        dl.setButtons([{ label: 'Done', cls: 'btn-primary', onClick: (d) => { d.close(); reload(); } }]);
    };

    const dl = dialog({ title: 'Move a disk to another array', body: '', buttons: [] });
    draw(dl);
};

const open = (name, to) => {
    API.setArray(name);
    if (state.onChange) state.onChange();
    if (window.location.hash === to) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else window.location.hash = to;
};

/** The switcher of the sidebar: every array with its health, the current one marked. */
export const renderSwitcher = (arrays) => {
    const list = arrays?.arrays || [];
    if (list.length < 2) return '';
    return `
        <div class="ar-switch-title">Array</div>
        ${list.map(a => `
            <button class="ar-switch ${a.name === API.array() ? 'active' : ''}" data-ar="select" data-name="${escAttr(a.name)}"
                data-tooltip="${escAttr(a.configured ? `${HEALTH_TEXT[a.health] || a.health}${a.active_command ? ` · ${a.active_command}` : ''}` : 'not set up')}">
                <span class="ar-health ar-health-${a.configured ? (HEALTH_COLOR[a.health] || 'grey') : 'grey'}"></span>
                <span class="ar-switch-name">${escHtml(a.name)}</span>
                ${a.active_command ? `<span class="ar-switch-busy">${a.progress !== undefined ? `${a.progress}%` : '…'}</span>` : ''}
            </button>`).join('')}`;
};

export const initArrays = (onSelect) => {
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-ar]');
        if (!el) return;
        const ds = el.dataset;
        switch (ds.ar) {
            case 'add': addArray(); break;
            case 'remove': removeArray(ds.name); break;
            case 'move': moveDisk(); break;
            case 'parallel': setParallel(ds.value === '1'); break;
            case 'open': open(ds.name, ds.to); break;
            case 'select': API.setArray(ds.name); onSelect(); break;
        }
    });
};

export const __test = { separateMounts, overallHealth, planMoveDisk, signatureOf };
