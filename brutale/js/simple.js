// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Paleka

// The pages for everyday use: Home, My files, Disks, Protection, Sharing,
// Backups, Alerts, System and Help. Plain words, one main action per page,
// details on request, and every change checked after it's saved.
// The detailed pages of the daemon stay available under "Advanced".

import { API } from './api.js';
import { escHtml, escAttr, showToast } from './utils.js';
import { dialog, confirmDo, applyWidths, storageSnapshot, storageOpen, StorageAPI, waitJob } from './storage.js';
import * as P from './plain.js';

/* ------------------------------------------------------------------ */
/* API of the machine                                                  */
/* ------------------------------------------------------------------ */

const hostCall = async (path, method = 'GET', body) => {
    const response = await fetch(`/snapraid/v1/host${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await response.json(); } catch (ignore) { /* not json */ }
    if (!response.ok) throw new Error(json?.message || `Request failed with status ${response.status}`);
    return json;
};

export const HostAPI = {
    status: () => hostCall(''),
    history: () => hostCall('/history'),
    network: () => hostCall('/network'),
    shareUsers: () => hostCall('/share_users'),
    smartLog: (device) => hostCall(`/smart?device=${encodeURIComponent(device)}`),
    openFiles: (path) => hostCall(`/openfiles?path=${encodeURIComponent(path)}`),
    diagnostics: () => hostCall('/diagnostics'),
    settingsBackup: () => hostCall('/settings_backup'),
    settings: (values) => hostCall('/settings', 'POST', values),
    shareSave: (share) => hostCall('/share_save', 'POST', share),
    shareDelete: (name) => hostCall('/share_delete', 'POST', { name }),
    shareUserSet: (user, password) => hostCall('/share_user_set', 'POST', { user, password }),
    shareUserDelete: (user) => hostCall('/share_user_delete', 'POST', { user }),
    permissions: (path) => hostCall('/permissions', 'POST', { path }),
    backupSave: (b) => hostCall('/backup_save', 'POST', b),
    backupDelete: (name) => hostCall('/backup_delete', 'POST', { name }),
    backupRun: (name) => hostCall('/backup_run', 'POST', { name }),
    powerSave: (p) => hostCall('/power_save', 'POST', p),
    smartTest: (device, kind) => hostCall('/smart_test', 'POST', { device, kind }),
    wipe: (device, method) => hostCall('/wipe', 'POST', { device, method, confirm: device }),
    copy: (source, target, mirror = false) => hostCall('/copy', 'POST', { source, target, mirror }),
    fileDelete: (path) => hostCall('/file_delete', 'POST', { path }),
    fileRename: (path, name) => hostCall('/file_rename', 'POST', { path, name }),
    wol: () => hostCall('/wol', 'POST', {}),
    restore: (path, text) => hostCall('/restore', 'POST', { path, text })
};

/* ------------------------------------------------------------------ */
/* small pieces                                                        */
/* ------------------------------------------------------------------ */

const S = { view: null, actions: null, hash: '', busy: false, cache: {} };

const esc = escHtml;

/** A word of the trade, explained on hover. */
const term = (word, shown = word) => `<span class="sp-term" data-tooltip="${escAttr(P.GLOSSARY[word] || '')}">${esc(shown)}</span>`;

const ICON = {
    ok: '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
    bad: '<svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>',
    busy: '<svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>',
    setup: '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
    tip: '<svg viewBox="0 0 24 24"><path d="M9 21h6v-1H9v1zm3-19a7 7 0 0 0-4 12.74V17h8v-2.26A7 7 0 0 0 12 2z"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z"/></svg>',
    disk: '<svg viewBox="0 0 24 24"><path d="M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm6 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM7 19a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg>',
    shield: '<svg viewBox="0 0 24 24"><path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>',
    share: '<svg viewBox="0 0 24 24"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>',
    backup: '<svg viewBox="0 0 24 24"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>'
};

const icon = (name, cls = '') => `<span class="sp-icon ${cls}">${ICON[name] || ''}</span>`;

const button = (label, act, data = {}, cls = 'btn-secondary') =>
    `<button class="btn ${cls}" data-sp="${act}" ${Object.entries(data).map(([k, v]) => `data-${k}="${escAttr(v)}"`).join(' ')}>${esc(label)}</button>`;

/** A card with what it is for, in one sentence. */
const section = (title, why, body, extra = '') => `
    <div class="card sp-section">
        <div class="sp-section-head">
            <div><h3>${esc(title)}</h3>${why ? `<div class="sp-why">${why}</div>` : ''}</div>
            ${extra ? `<div class="sp-section-extra">${extra}</div>` : ''}
        </div>
        ${body}
    </div>`;

const finding = (f) => `
    <div class="sp-row sp-row-${f.level}">
        ${icon(f.level === 'tip' ? 'tip' : f.level === 'ok' ? 'ok' : f.level === 'bad' ? 'bad' : 'warn', `sp-icon-${f.level}`)}
        <div class="sp-row-main"><div class="sp-row-title">${esc(f.title)}</div><div class="sp-row-text">${esc(f.text)}</div></div>
        ${f.action ? (f.action.st
            ? `<button class="btn btn-secondary btn-sm" data-sp="storage" data-st-action="${escAttr(f.action.st)}" data-st-data="${escAttr(JSON.stringify(f.action.data || {}))}">${esc(f.action.label)}</button>`
            : `<button class="btn btn-secondary btn-sm" data-sp="go" data-act="${escAttr(f.action.act)}">${esc(f.action.label)}</button>`) : ''}
    </div>`;

const empty = (text, action = '') => `<div class="sp-empty"><div>${text}</div>${action ? `<div class="mt-4">${action}</div>` : ''}</div>`;

/** Field of a form, with the help under it. */
const field = (label, input, help = '') => `
    <label class="sp-field">
        <span class="sp-field-label">${esc(label)}</span>
        ${input}
        ${help ? `<span class="sp-field-help">${help}</span>` : ''}
    </label>`;

const toggle = (id, on, label, help = '') => `
    <div class="sp-toggle">
        <label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span class="slider"></span></label>
        <label for="${id}" class="sp-toggle-text"><span class="sp-field-label">${esc(label)}</span>${help ? `<span class="sp-field-help">${help}</span>` : ''}</label>
    </div>`;

const val = (id) => document.getElementById(id)?.value ?? '';
const checked = (id) => !!document.getElementById(id)?.checked;

/** Show that a change was saved and read back from the server. */
const savedNote = (id, text) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = `${icon('ok', 'sp-icon-ok')} ${esc(text)}`;
    el.classList.add('sp-saved-on');
};

/** Run something that changes the machine, telling the outcome in plain words. */
const act = async (fn, okText) => {
    try {
        const r = await fn();
        if (r?.warning) showToast(r.warning, 'warning');
        else if (okText) showToast(okText, 'success');
        return r || true;
    } catch (e) {
        showToast(e.message, 'error');
        return null;
    }
};

const goTo = (what) => {
    const routes = { drives: '#/drives', protection: '#/protection', alerts: '#/alerts', backups: '#/backups', sharing: '#/sharing', files: '#/files', system: '#/system', help: '#/help', home: '#/' };
    if (what === 'setup') return storageOpen('overview', 'wizard');
    if (what === 'recover') return storageOpen('array', 'recover');
    if (what === 'protect') return protectNow();
    if (what === 'heal') return healNow();
    window.location.hash = routes[what] || '#/';
};

const protectNow = async () => {
    const ok = await confirmDo({
        title: 'Protect the latest changes now',
        intro: 'The protection is updated with the files changed since the last time, then a small part of the data is checked for damage.',
        effects: ['The disks spin up and work for a while: minutes for a few changes, hours after big copies.', 'You can keep using your files meanwhile.'],
        safe: ['No file is changed or moved.', 'If many files were deleted, it stops and asks you first.'],
        label: 'Protect now'
    });
    if (ok) await act(() => API.startMaintenance({}), 'Started: the progress is on the Home page');
};

const healNow = async () => {
    const ok = await confirmDo({
        title: 'Repair the damaged data',
        intro: 'The damaged parts are rebuilt from the protection, then checked again.',
        effects: ['Only the damaged files are rewritten, with their right content.'],
        safe: ['The other files are not touched.'],
        label: 'Repair'
    });
    if (ok) await act(() => API.startHeal({}), 'Repair started');
};

/** Follow a background job of the machine in a dialog until it ends. */
const followJob = async (title) => {
    const dlg = dialog({ title, large: false, body: '<div class="loading-spinner"></div>', buttons: [{ label: 'Stop', cls: 'btn-danger', onClick: () => StorageAPI.jobStop().catch(e => showToast(e.message, 'error')) }] });
    const draw = (j) => {
        const pct = j.kind === 'wipe' && S.cache.wipeSize ? Math.min(100, Math.round((j.bytes || 0) * 100 / S.cache.wipeSize)) : null;
        dlg.setBody(`
            <div class="sp-job">
                <div class="font-bold">${esc(j.running ? 'Working…' : j.success ? 'Done' : 'Not finished')}</div>
                ${pct != null ? `<div class="progress-container mt-2"><div class="progress-bar" data-width="${pct}"></div></div>` : ''}
                <div class="text-sm text-muted mt-2">${P.plural(j.files || 0, 'file', 'files')} · ${P.bytes(j.bytes || 0)} · ${P.humanSpan(j.elapsed_seconds || 0)}</div>
                ${j.current && j.running ? `<div class="text-xs font-mono text-muted mt-2 truncate">${esc(j.current)}</div>` : ''}
                ${!j.running ? `<p class="text-sm mt-4 ${j.success ? 'text-emerald' : 'text-red'}">${esc(j.message || '')}</p>` : ''}
                ${!j.running && (j.result || []).length ? `<ul class="text-xs mt-2">${j.result.slice(0, 20).map(r => `<li>${esc(r.value || r.path || '')}</li>`).join('')}</ul>` : ''}
            </div>`);
    };
    try {
        const job = await waitJob(draw);
        draw(job);
        dlg.setButtons([{ label: 'Close', cls: 'btn-primary', onClick: (d) => { d.close(); refresh(); } }]);
        return job;
    } catch (e) {
        dlg.setBody(`<p class="text-red">${esc(e.message)}</p>`);
        dlg.setButtons([{ label: 'Close', onClick: (d) => d.close() }]);
        return null;
    }
};

const refresh = () => { if (SIMPLE_PAGES[S.hash]) loadSimplePage(S.hash, S.view, S.actions); };

const header = (html) => { if (S.actions) S.actions.innerHTML = html; };

const draw = (html) => {
    if (!S.view) return;
    S.view.innerHTML = `<div class="sp-page fade-in">${html}</div>`;
    applyWidths(S.view);
    // inline styles are refused by the security policy of the daemon: set them here
    S.view.querySelectorAll('[data-cols]').forEach(el => { el.style.gridTemplateColumns = `repeat(${el.dataset.cols}, minmax(84px, 1fr))`; });
};

/** The data most pages need, read together. */
const loadCommon = async (what) => {
    const get = {
        state: () => API.getState(),
        array: () => API.getArray({ limit_diffs: 0, limit_fixes: 0 }),
        tasks: () => API.getTasks({ limit_history: 60, limit_messages: 60 }),
        config: () => API.getConfig(),
        disks: () => API.getDisks(),
        host: () => HostAPI.status(),
        storage: () => storageSnapshot(),
        inv: () => API.getInventory(),
        system: () => API.getSystem()
    };
    const keys = what.split(' ');
    const values = await Promise.all(keys.map(k => get[k]().catch(e => ({ __error: e.message }))));
    const out = {};
    keys.forEach((k, i) => { out[k] = values[i]?.__error ? null : values[i]; if (values[i]?.__error) out[`${k}Error`] = values[i].__error; });
    return out;
};

/* ------------------------------------------------------------------ */
/* Home                                                                */
/* ------------------------------------------------------------------ */

const diskProblems = (disks) => [...(disks?.data_disks || []), ...(disks?.parity_disks || [])]
    .filter(d => ['prefail', 'failing', 'degraded'].includes(d.health) || (d.devices || []).some(v => ['warning', 'critical', 'danger'].includes(v.smart?.temperature_status) || (v.health && !['passed', 'pending', 'unknown'].includes(v.health)))).length;

const loadHome = async () => {
    const d = await loadCommon('state array tasks config disks host storage');
    const st = d.state || {};
    const model = d.storage?.model;
    const configured = !!model && (model.data.length > 0 || model.parity.length > 0);
    const activeTask = (d.tasks?.active || [])[0];
    const status = P.homeStatus({
        configured,
        health: d.array?.health || st.health,
        healthReason: d.array?.health_reason,
        active: st.active_command ? { command: st.active_command, progress: st.progress, eta_seconds: st.eta_seconds } : activeTask ? { command: activeTask.command, progress: activeTask.progress } : null,
        array: d.array, tasks: d.tasks, config: d.config, diskProblems: diskProblems(d.disks)
    });

    const findings = [
        ...(d.storage?.findings || []).filter(f => f.level === 'bad' || f.level === 'warn'),
        ...P.machineFindings({ host: d.host, config: d.config, disks: d.disks, nowIso: d.array?.pulse?.current_at })
    ];
    const tips = (d.storage?.findings || []).filter(f => f.level === 'tip');

    // tiles
    const live = model ? model.data.filter(x => x.ok) : [];
    const total = live.reduce((a, x) => a + x.total, 0);
    const free = live.reduce((a, x) => a + x.free, 0);
    const usedPct = total ? Math.round((total - free) * 100 / total) : 0;
    const k = model ? model.parity.length : 0;
    const allDisks = [...(d.disks?.data_disks || []), ...(d.disks?.parity_disks || [])];
    const problems = diskProblems(d.disks);
    const sync = P.lastTask(d.tasks, 'sync', true);
    const shares = d.host?.shares || [];
    const backups = d.host?.backups || [];
    const lastBackup = backups.filter(b => b.last_time).sort((a, b) => b.last_time - a.last_time)[0];

    const tile = (route, ic, label, value, sub, extra = '') => `
        <a class="sp-tile" href="${route}">
            <div class="sp-tile-head">${icon(ic)}<span>${esc(label)}</span></div>
            <div class="sp-tile-value">${value}</div>
            ${extra}
            <div class="sp-tile-sub">${sub}</div>
        </a>`;

    const recent = (d.tasks?.history || []).filter(t => !P.ROUTINE.includes(t.command)).slice(0, 5);

    // the main action is in the status itself: the header only offers what's not there
    if (status.level === 'busy') header(button('Stop', 'stop', {}, 'btn-danger'));
    else if (!status.action && configured) header(button('Protect now', 'go', { act: 'protect' }, 'btn-secondary'));
    else header('');

    draw(`
        <div class="sp-hero sp-hero-${status.level}">
            <div class="sp-hero-icon">${ICON[status.level === 'ok' ? 'ok' : status.level === 'busy' ? 'busy' : status.level === 'setup' ? 'setup' : status.level === 'bad' ? 'bad' : 'warn']}</div>
            <div class="sp-hero-text">
                <div class="sp-hero-title">${esc(status.title)}</div>
                <div class="sp-hero-sub">${esc(status.text)}</div>
                ${status.level === 'busy' && st.progress != null ? `<div class="progress-container sp-hero-progress"><div class="progress-bar" data-width="${st.progress}"></div></div>` : ''}
            </div>
            ${status.action ? `<div class="sp-hero-action">${button(status.action.label, 'go', { act: status.action.act }, 'btn-primary')}</div>` : ''}
        </div>

        ${configured ? `
        <div class="sp-tiles">
            ${tile('#/files', 'folder', 'Space', total ? `${P.bytes(free)} <small>free</small>` : '–', total ? `${usedPct}% of ${P.bytes(total)} used` : 'no data disk',
                total ? `<div class="progress-container"><div class="progress-bar ${usedPct >= 90 ? 'st-bar-red' : usedPct >= 75 ? 'st-bar-amber' : ''}" data-width="${usedPct}"></div></div>` : '')}
            ${tile('#/drives', 'disk', 'Disks', problems ? `<span class="text-amber">${P.plural(problems, 'needs', 'need')} a look</span>` : `${allDisks.length} healthy`, `${model.data.length} for files, ${k} for protection`)}
            ${tile('#/protection', 'shield', 'Protection', k ? `${P.plural(k, 'disk', 'disks')} can fail` : 'none', sync ? `updated ${P.ago(sync.finished_at, d.array?.pulse?.current_at)}` : 'not updated recently')}
            ${tile('#/sharing', 'share', 'Sharing & backups', `${P.plural(shares.length, 'share', 'shares')}`, lastBackup ? `last backup ${P.humanSpan(Date.now() / 1000 - lastBackup.last_time)} ago` : backups.length ? 'backup not run yet' : 'no backup yet')}
        </div>` : ''}

        ${findings.length ? section('Needs your attention', 'Most important first. Each one says what to do.', `<div class="sp-rows">${findings.map(finding).join('')}</div>`)
            : configured ? section('Needs your attention', '', empty(`${icon('ok', 'sp-icon-ok')} Nothing. Everything was checked and looks right.`)) : ''}

        ${recent.length ? section('What happened lately', 'The work done by the server by itself or on your request.', `
            <div class="sp-rows">
                ${recent.map(t => {
                    const w = P.taskWords(t);
                    return `<div class="sp-row sp-row-${w.ok ? 'ok' : 'warn'}">${icon(w.ok ? 'ok' : 'warn', w.ok ? 'sp-icon-ok' : 'sp-icon-warn')}
                        <div class="sp-row-main"><div class="sp-row-title">${esc(w.title)}</div><div class="sp-row-text">${esc(w.detail)}</div></div>
                        <div class="sp-row-when">${esc(P.ago(t.finished_at || t.started_at, d.array?.pulse?.current_at))}</div></div>`;
                }).join('')}
            </div>`, '<a class="sp-link" href="#/tasks">All the activity</a>') : ''}

        ${tips.length ? section('Ideas', 'Not problems: things that could be better.', `<div class="sp-rows">${tips.map(finding).join('')}</div>`) : ''}
    `);
};

/* ------------------------------------------------------------------ */
/* My files                                                            */
/* ------------------------------------------------------------------ */

/** SnapRAID filter of a path relative to the disks, with its wildcards escaped. */
const filterOf = (rel, dir) => `${rel.replace(/^\/+/, '').replace(/([*?[\]\\])/g, '\\$1')}${dir ? '/' : ''}`;

/** Start a command of the array and wait for its end. */
const runTask = async (tasks, command) => {
    const before = await API.getTasks({ limit_history: 1, limit_messages: 0 }).catch(() => null);
    const last = Math.max(0, ...[...(before?.history || []), ...(before?.active || []), ...(before?.pending || [])].map(t => t.number || 0));
    await API.schedule(tasks);
    for (let i = 0; i < 3600; ++i) {
        await new Promise(r => setTimeout(r, 1500));
        const t = await API.getTasks({ limit_history: 20, limit_messages: 400 }).catch(() => null);
        const done = (t?.history || []).find(x => x.number > last && x.command === command);
        if (done) return done;
    }
    throw new Error('The command is taking too long: follow it in Tasks');
};

const filesTargets = (inv, model) => {
    const parityMounts = new Set((model?.parity || []).flatMap(p => p.files.map(f => f.mount?.target)).filter(Boolean));
    return (inv?.mounts || [])
        .filter(m => /^\/(mnt|srv|media)\//.test(m.target) && !parityMounts.has(m.target) && (m.source.startsWith('/dev/') || /mergerfs/.test(m.fstype)))
        .map(m => ({ path: m.target, free: m.free_bytes, pool: /mergerfs/.test(m.fstype) }));
};

const loadFiles = async () => {
    const d = await loadCommon('storage inv');
    const model = d.storage?.model;
    const pools = d.inv?.pools || [];
    S.cache.filesModel = model;
    S.cache.filesInv = d.inv;

    if (!pools.length) {
        header('');
        draw(section('My files', 'Your files, as the other computers see them.', empty(model?.data?.length
            ? 'Each data disk is its own folder: there is no pool showing them together. A pool makes one big folder of all the disks.'
            : 'There are no files yet: set up your storage first.',
        model?.data?.length ? `<button class="btn btn-primary" data-sp="storage" data-st-action="pool-create" data-st-data="{}">Make one folder of all the disks</button>` : button('Start the guided setup', 'go', { act: 'setup' }, 'btn-primary'))));
        return;
    }

    if (!S.cache.pool || !pools.some(p => p.mountpoint === S.cache.pool)) S.cache.pool = (model?.pool || pools[0]).mountpoint;
    if (!S.cache.path) S.cache.path = '/';
    const pool = S.cache.pool;
    const path = S.cache.path;

    let list;
    try {
        list = await StorageAPI.browse(pool, path);
    } catch (e) {
        S.cache.path = '/';
        draw(section('My files', '', `<p class="text-red">${esc(e.message)}</p>`));
        return;
    }

    const diskOf = (i) => {
        const b = list.branches[i];
        const data = (model?.data || []).find(x => x.path && b && (x.path.replace(/\/+$/, '') === b.replace(/\/+$/, '')));
        return data ? data.name : b.split('/').pop();
    };
    const crumbs = path.split('/').filter(Boolean);
    const entries = [...list.entries].sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));

    header(`${button('Check this folder for damage', 'file-check', { path, dir: '1' })} ${button('Get back deleted files', 'restore', { path }, 'btn-primary')}`);

    draw(`
        ${pools.length > 1 ? `<div class="sp-tabs">${pools.map(p => `<button class="sp-tab ${p.mountpoint === pool ? 'active' : ''}" data-sp="files-pool" data-pool="${escAttr(p.mountpoint)}">${esc(p.mountpoint)}</button>`).join('')}</div>` : ''}
        ${section('My files', `Everything in <span class="font-mono">${esc(pool)}</span>, the folder that shows all the data disks together. Each file lives on one disk: you see which.`, `
            <div class="sp-crumbs">
                <a href="#" data-sp="files-go" data-path="/">${icon('folder')} ${esc(pool)}</a>
                ${crumbs.map((c, i) => `<span>/</span><a href="#" data-sp="files-go" data-path="/${escAttr(crumbs.slice(0, i + 1).join('/'))}">${esc(c)}</a>`).join('')}
            </div>
            ${list.truncated ? '<div class="text-sm text-amber mb-2">Only the first entries are shown.</div>' : ''}
            ${entries.length ? `
            <div class="sp-files">
                ${path !== '/' ? `<div class="sp-file"><a href="#" class="sp-file-name" data-sp="files-go" data-path="${escAttr('/' + crumbs.slice(0, -1).join('/'))}">${icon('folder')} ..</a></div>` : ''}
                ${entries.map(e => {
                    const rel = `${path === '/' ? '' : path}/${e.name}`;
                    const full = `${pool}${rel}`;
                    const on = (e.on || []).map(diskOf);
                    return `
                    <div class="sp-file">
                        ${e.dir ? `<a href="#" class="sp-file-name" data-sp="files-go" data-path="${escAttr(rel)}">${icon('folder')} ${esc(e.name)}</a>`
                            : `<span class="sp-file-name">${icon('file')} ${esc(e.name)}</span>`}
                        <span class="sp-file-meta">${e.dir ? '' : P.bytes(e.size)}</span>
                        <span class="sp-file-meta" data-tooltip="The disks holding it">${on.length ? `on ${esc(on.join(', '))}` : ''}${e.duplicate ? ' <span class="badge badge-orange" data-tooltip="The same file is on more disks: only one copy is shown">copies</span>' : ''}</span>
                        <span class="sp-file-actions">
                            <button class="btn btn-sm btn-secondary" data-sp="file-check" data-path="${escAttr(rel)}" data-dir="${e.dir ? 1 : 0}" data-tooltip="Compare with what the protection saved">Check</button>
                            ${e.dir ? `<button class="btn btn-sm btn-secondary" data-sp="file-copy" data-path="${escAttr(full)}" data-dir="1" data-tooltip="Copy it to another disk">Copy to…</button>` : ''}
                            <button class="btn btn-sm btn-secondary" data-sp="file-rename" data-path="${escAttr(full)}">Rename</button>
                            <button class="btn btn-sm btn-secondary sp-danger-text" data-sp="file-delete" data-path="${escAttr(full)}" data-rel="${escAttr(rel)}" data-dir="${e.dir ? 1 : 0}">Delete</button>
                        </span>
                    </div>`;
                }).join('')}
            </div>` : empty('This folder is empty.')}`)}
    `);
};

const fileCheck = async (rel, dir) => {
    const what = rel === '/' ? 'all your files' : rel;
    const ok = await confirmDo({
        title: 'Check for damage',
        intro: `Every file in <span class="font-mono">${esc(what)}</span> is read and compared with what the protection saved at its last update.`,
        effects: ['The disks spin up and the files are read: big folders take a while.'],
        safe: ['Nothing is changed: it only reads.'],
        label: 'Check'
    });
    if (!ok) return;
    const dlg = dialog({ title: 'Checking…', large: false, body: '<div class="loading-spinner"></div><p class="text-sm text-muted mt-2">Reading the files. You can close this window: the check goes on, and its result is in Tasks.</p>', buttons: [{ label: 'Close', onClick: (x) => x.close() }] });
    try {
        const args = rel === '/' ? [] : ['-f', filterOf(rel, dir)];
        const task = await runTask([{ command: 'check', args }], 'check');
        const all = P.damagedFiles(task);
        const changed = all.filter(b => b.kind === 'changed');
        const bad = all.filter(b => b.kind === 'damaged');
        const list = (l) => `<ul class="sp-list-plain">${l.map(b => `<li><span class="font-mono">${esc(b.path)}</span>${b.problem ? ` <span class="text-muted">— ${esc(b.problem)}</span>` : ''}</li>`).join('')}</ul>`;
        dlg.setTitle(bad.length ? 'Some files are damaged' : changed.length ? 'No damage' : 'All good');
        dlg.setBody(`
            ${bad.length ? `<p class="text-sm mb-2 text-red font-bold">${P.plural(bad.length, 'file is', 'files are')} damaged: the content differs from what was saved, though nobody changed it.</p>${list(bad)}
                <p class="text-sm mt-2 mb-4">Repairing a file puts it back as it was at the last update of the protection.</p>` : ''}
            ${changed.length ? `<p class="text-sm mb-2">${P.plural(changed.length, 'file was', 'files were')} changed after the last update of the protection. That's normal: the next update includes ${changed.length === 1 ? 'it' : 'them'}.</p>${list(changed)}` : ''}
            ${!all.length ? `<p>${icon('ok', 'sp-icon-ok')} Every file matches what the protection saved.</p>` : ''}`);
        dlg.setButtons(bad.length ? [
            { label: 'Close', onClick: (x) => x.close() },
            {
                label: 'Repair the damaged files', cls: 'btn-primary', onClick: async (x) => {
                    x.close();
                    const pools = (S.cache.filesInv?.pools || []).map(p => p.mountpoint);
                    const branches = (S.cache.filesModel?.data || []).map(z => z.path.replace(/\/+$/, ''));
                    const rels = bad.map(b => {
                        const base = [...pools, ...branches].find(p => b.path.startsWith(p + '/'));
                        return base ? b.path.slice(base.length) : null;
                    }).filter(Boolean);
                    if (!rels.length) return showToast('The files could not be matched to a disk', 'error');
                    const sure = await confirmDo({
                        title: `Repair ${P.plural(rels.length, 'file', 'files')}`,
                        effects: ['Each file is rebuilt as it was at the last update of the protection.'],
                        safe: ['The other files are not touched.'],
                        label: 'Repair'
                    });
                    if (sure) await act(() => API.schedule([{ command: 'fix', args: rels.flatMap(r => ['-f', filterOf(r, false)]) }]), 'Repair started: see Tasks');
                }
            }] : [{ label: 'Close', cls: 'btn-primary', onClick: (x) => x.close() }]);
    } catch (e) {
        dlg.setBody(`<p class="text-red">${esc(e.message)}</p>`);
    }
};

const restoreDeleted = async (inPath) => {
    const dlg = dialog({ title: 'Get back deleted files', large: true, body: '<div class="loading-spinner"></div><p class="text-sm text-muted mt-2">Looking for the files deleted since the last update of the protection…</p>', buttons: [{ label: 'Close', onClick: (x) => x.close() }] });
    try {
        await runTask([{ command: 'diff' }], 'diff');
        const array = await API.getArray({ limit_diffs: 5000, limit_fixes: 0 });
        const prefix = inPath && inPath !== '/' ? inPath.replace(/^\//, '') + '/' : '';
        const removed = (array.diffs || []).filter(x => x.change === 'removed' && x.path.startsWith(prefix));
        if (!removed.length) {
            dlg.setBody(`<p>${prefix ? `Nothing was deleted in <span class="font-mono">${esc(inPath)}</span>` : 'Nothing was deleted'} since the last update of the protection.</p>
                <p class="text-sm text-muted mt-2">Files deleted before that update cannot be brought back from here. A backup copy can have them.</p>`);
            return;
        }
        dlg.setTitle(`${P.plural(removed.length, 'deleted file', 'deleted files')} can come back`);
        dlg.setBody(`
            <p class="text-sm mb-2">They were deleted after the last update of the protection, so it can still rebuild them. Choose which ones. They come back where they were.</p>
            <label class="sp-check-all"><input type="checkbox" id="sp-rs-all" checked> All</label>
            <div class="sp-pick">${removed.slice(0, 1000).map((x, i) => `<label class="sp-pick-row"><input type="checkbox" class="sp-rs" data-i="${i}" checked> <span class="font-mono">${esc(x.path)}</span> <span class="text-muted text-xs">on ${esc(x.disk)}</span></label>`).join('')}</div>
            ${removed.length > 1000 ? '<p class="text-xs text-muted">Only the first 1000 are listed.</p>' : ''}
            <div class="st-effects st-effects-safe mt-4"><div class="st-effects-title">What does not change</div><ul><li>Files that exist are never overwritten.</li></ul></div>`);
        dlg.body.querySelector('#sp-rs-all').addEventListener('change', (e) => dlg.body.querySelectorAll('.sp-rs').forEach(c => { c.checked = e.target.checked; }));
        dlg.setButtons([
            { label: 'Cancel', onClick: (x) => x.close() },
            {
                label: 'Bring them back', cls: 'btn-primary', onClick: async (x) => {
                    const picked = [...x.body.querySelectorAll('.sp-rs:checked')].map(c => removed[Number(c.dataset.i)]);
                    if (!picked.length) return showToast('Choose at least one file', 'warning');
                    x.close();
                    const all = picked.length === removed.length;
                    const filters = all && prefix ? [filterOf(prefix.slice(0, -1), true)] : all ? [] : picked.map(p => filterOf(p.path, false));
                    await act(() => API.undelete({ filters }), `Bringing back ${P.plural(picked.length, 'file', 'files')}: see the progress on Home`);
                }
            }
        ]);
    } catch (e) {
        dlg.setBody(`<p class="text-red">${esc(e.message)}</p>`);
    }
};

const fileRename = (full) => {
    const name = full.split('/').pop();
    const dlg = dialog({
        title: 'Rename', large: false,
        body: field('New name', `<input class="form-control" id="sp-rn" value="${escAttr(name)}">`, 'Only the name changes: it stays in the same folder and on the same disk.'),
        buttons: [
            { label: 'Cancel', onClick: (x) => x.close() },
            {
                label: 'Rename', cls: 'btn-primary', onClick: async (x) => {
                    const n = val('sp-rn').trim();
                    if (!n || n === name) return x.close();
                    if (await act(() => HostAPI.fileRename(full, n), 'Renamed')) { x.close(); refresh(); }
                }
            }
        ]
    });
    setTimeout(() => dlg.body.querySelector('#sp-rn')?.select(), 50);
};

const fileDelete = async (full, rel, dir) => {
    let when = 'its next update';
    try {
        const config = await API.getConfig();
        when = P.whenWords(P.nextRun(config.maintenance_schedule)) || when;
    } catch (ignore) { /* keep the generic words */ }
    const ok = await confirmDo({
        title: `Delete ${dir ? 'the folder' : 'the file'} ${rel}`,
        intro: `<span class="font-mono">${esc(full)}</span>`,
        effects: [dir ? 'The folder and everything inside it are deleted from the disks.' : 'The file is deleted from its disk.', `Until the next update of the protection (${esc(when)}) you can still get it back from My files → Get back deleted files. After that it's gone, unless a backup has it.`],
        safe: ['Nothing else is touched.'],
        label: 'Delete', danger: true
    });
    if (ok && await act(() => HostAPI.fileDelete(full), 'Deleted')) refresh();
};

const fileCopy = (full, dir) => {
    const targets = filesTargets(S.cache.filesInv, S.cache.filesModel).filter(t => !full.startsWith(t.path + '/'));
    const name = full.split('/').pop();
    dialog({
        title: `Copy ${name}`, large: false,
        body: `
            ${field('To', `<select class="form-control" id="sp-cp-to">${targets.map(t => `<option value="${escAttr(t.path)}">${esc(t.path)} — ${P.bytes(t.free)} free${t.pool ? ' (pool)' : ''}</option>`).join('')}</select>`, 'A disk or a pool of this machine, like a USB disk.')}
            ${field('Into the folder', `<input class="form-control" id="sp-cp-dir" value="${escAttr(name)}">`, 'Created if missing. A copy already there is updated: only what changed is copied.')}
            ${dir ? '' : '<p class="text-xs text-muted">Only folders can be copied from here: to copy a single file, copy its folder or use a share.</p>'}`,
        buttons: [
            { label: 'Cancel', onClick: (x) => x.close() },
            {
                label: 'Copy', cls: 'btn-primary', onClick: async (x) => {
                    const to = `${val('sp-cp-to').replace(/\/+$/, '')}/${val('sp-cp-dir').replace(/^\/+|\/+$/g, '')}`;
                    if (!dir) return showToast('Choose a folder to copy', 'warning');
                    x.close();
                    if (await act(() => HostAPI.copy(full, to))) followJob(`Copying ${name}`);
                }
            }
        ]
    });
};

/* ------------------------------------------------------------------ */
/* Disks                                                               */
/* ------------------------------------------------------------------ */

const ROLE_WORDS = { data: 'keeps files', parity: 'keeps the protection', blank: 'not used, empty', mounted: 'not in the protection', unmounted: 'not in use', unformatted: 'not in use', system: 'system disk', foreign: 'used by another array', other: 'used by something else' };

/** Every physical disk, with what it's for and what the daemon knows of it. */
const diskEntries = (model, daemonDisks, others = []) => {
    const out = [];
    const byNode = new Map();
    const current = API.array();
    // the disks of this array first, then the ones of the other arrays of the machine
    for (const [arrayName, dl] of [[current, daemonDisks], ...others]) {
        for (const kind of ['data_disks', 'parity_disks']) {
            for (const dd of dl?.[kind] || []) {
                for (const dev of dd.devices || []) {
                    if (!byNode.has(dev.node)) byNode.set(dev.node, { disk: dd, dev, role: kind === 'data_disks' ? 'data' : 'parity', array: arrayName === current ? '' : arrayName });
                }
            }
        }
    }
    for (const pd of model?.disks || []) {
        const hit = byNode.get(pd.path);
        out.push({
            id: pd.serial || hit?.dev?.serial || pd.name,
            node: pd.path, name: hit ? `${hit.array ? `${hit.array}: ` : ''}${hit.disk.name}` : pd.name, role: hit ? hit.role : pd.state, array: hit?.array || '',
            model: pd.model || hit?.dev?.model || '', serial: pd.serial || hit?.dev?.serial || '', size: pd.size,
            transport: (pd.transport || hit?.dev?.interface || '').toUpperCase(), rotational: pd.rotational, removable: pd.removable,
            health: hit ? hit.disk.health : null, dev: hit?.dev || null, disk: hit?.disk || null,
            mount: hit?.role === 'data' && !hit.array ? (model.data.find(x => x.name === hit.disk.name)?.mount?.target || null) : (pd.filesystems.find(f => f.mount)?.mount?.target || null)
        });
        if (hit) byNode.delete(pd.path);
    }
    // disks the daemon knows but that are not there
    for (const { disk, dev, role, array } of byNode.values())
        out.push({ id: dev.serial || disk.name, node: dev.node, name: `${array ? `${array}: ` : ''}${disk.name}`, role, array, model: dev.model || '', serial: dev.serial || '', size: dev.size_bytes, transport: '', health: disk.health, dev, disk, missing: true });
    const order = { data: 0, parity: 1 };
    return out.filter(e => e.role !== 'system' || e.dev).sort((a, b) => (a.array ? 1 : 0) - (b.array ? 1 : 0) || (a.array || '').localeCompare(b.array || '') || (order[a.role] ?? 2) - (order[b.role] ?? 2) || a.name.localeCompare(b.name, undefined, { numeric: true }));
};

const healthWords = (e) => {
    if (e.missing) return { level: 'bad', text: 'Not found: disconnected or dead' };
    const h = e.health || e.dev?.health;
    const t = e.dev?.smart?.temperature_status;
    if (h === 'failing') return { level: 'bad', text: 'Failing: replace it soon' };
    if (h === 'prefail') return { level: 'bad', text: 'Worn out: plan a replacement' };
    if (h === 'degraded') return { level: 'bad', text: 'Missing or replaced' };
    if (t === 'critical' || t === 'danger') return { level: 'bad', text: 'Too hot' };
    if (t === 'warning') return { level: 'warn', text: 'Warm' };
    if (h && !['passed', 'pending', 'unknown'].includes(h)) return { level: 'warn', text: `Health: ${h}` };
    if (!e.dev) return { level: 'tip', text: 'Not watched: it is in no array' };
    return { level: 'ok', text: 'Healthy' };
};

const bar = (values, max, cls) => {
    const w = 240;
    const h = 28;
    const n = values.length || 1;
    const bw = w / n;
    return `<svg class="sp-spark ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${values.map((v, i) => {
        const bh = max ? Math.max(v ? 1 : 0, (v / max) * h) : 0;
        return `<rect x="${(i * bw).toFixed(2)}" y="${(h - bh).toFixed(2)}" width="${Math.max(0.5, bw - 0.4).toFixed(2)}" height="${bh.toFixed(2)}"/>`;
    }).join('')}</svg>`;
};

const loadDrives = async () => {
    const d = await loadCommon('disks host storage');
    const model = d.storage?.model;
    const names = (d.storage?.model?.inv?.arrays || []).map(a => a.name).filter(n => n !== API.array());
    const others = await Promise.all(names.map(n => fetch(`/snapraid/v1/arrays/${encodeURIComponent(n)}/disks`).then(r => r.ok ? r.json() : null).then(j => [n, j]).catch(() => [n, null])));
    const entries = diskEntries(model, d.disks, others);
    S.cache.drives = entries;
    S.cache.filesModel = model;
    S.cache.filesInv = model?.inv;
    const bays = P.bayDoc(d.host?.docs?.bays, entries.length);
    S.cache.bays = bays;
    const placing = S.cache.placing;
    const history = await HostAPI.history().catch(() => null);
    const shortPlan = P.parseSchedule(d.host?.smart_tests?.short)[0];
    const longPlan = P.parseSchedule(d.host?.smart_tests?.long)[0];

    header(`${button('Test all disks', 'test-all')} ${button('Add or replace a disk', 'storage', { 'st-action': '', 'st-tab': 'array' }, 'btn-primary')}`);

    const roleCls = (e) => e.role === 'data' ? 'data' : e.role === 'parity' ? 'parity' : 'spare';
    const bayCell = (i) => {
        const id = Object.keys(bays.slots).find(k => bays.slots[k] === i);
        const e = entries.find(x => x.id === id);
        const hw = e ? healthWords(e) : null;
        return `<button class="sp-bay ${e ? `sp-bay-${roleCls(e)} sp-bay-h-${hw.level}` : 'sp-bay-empty'} ${placing ? 'sp-bay-target' : ''}" data-sp="bay" data-bay="${i}" ${e ? `data-tooltip="${escAttr(`${e.name} — ${e.model} ${e.serial}`)}"` : ''}>
            <span class="sp-bay-num">${i + 1}</span>
            ${e ? `<span class="sp-bay-name">${esc(e.name)}</span><span class="sp-bay-sub">${P.bytes(e.size)}</span>${hw.level === 'bad' ? '<span class="sp-bay-alert">this one</span>' : ''}` : '<span class="sp-bay-sub">empty</span>'}
        </button>`;
    };
    const unplaced = entries.filter(e => bays.slots[e.id] == null);

    const ioOf = (node) => {
        const base = (node || '').split('/').pop();
        return (history?.devices || []).find(x => x.device === base);
    };

    draw(`
        ${section('Where your disks are', 'A picture of your case. When a disk fails, it shows which one to pull out.', `
            <div class="sp-bays" data-cols="${bays.cols}">
                ${Array.from({ length: bays.rows * bays.cols }, (_, i) => bayCell(i)).join('')}
            </div>
            ${placing ? `
                <div class="sp-place-bar">
                    <div class="text-sm"><b>${esc(entries.find(e => e.id === placing)?.name || '')}</b>: click the bay where this disk is. ${button('Take it out of the picture', 'bay-clear')} ${button('Cancel', 'bay-cancel')}</div>
                </div>` : ''}
            <div class="sp-unplaced">
                ${unplaced.length ? `<span class="text-sm text-muted">Not placed yet — click one, then its bay:</span> ${unplaced.map(e => `<button class="sp-chip sp-chip-${roleCls(e)} ${placing === e.id ? 'active' : ''}" data-sp="bay-pick" data-id="${escAttr(e.id)}">${esc(e.name)} · ${P.bytes(e.size)}</button>`).join('')}`
                    : '<span class="text-sm text-muted">Every disk has its place. Click a disk in the picture to move it.</span>'}
            </div>`, `<span class="text-sm text-muted">Bays</span> <input class="form-control sp-num" type="number" min="1" max="12" id="sp-bay-rows" value="${bays.rows}" data-tooltip="Rows"> × <input class="form-control sp-num" type="number" min="1" max="12" id="sp-bay-cols" value="${bays.cols}" data-tooltip="Columns"> ${button('Set', 'bay-size')}`)}

        ${section('Your disks', 'What each disk is for, and how it feels.', `
            <div class="sp-disks">
                ${entries.map(e => {
                    const hw = healthWords(e);
                    const temp = e.dev?.smart?.temperature_celsius;
                    const io = ioOf(e.node);
                    const max = io ? Math.max(1, ...io.read_kb, ...io.write_kb) : 0;
                    return `
                    <div class="sp-disk sp-disk-${roleCls(e)}">
                        <div class="sp-disk-head">
                            ${icon('disk', `sp-icon-${roleCls(e)}`)}
                            <div class="sp-disk-title"><b>${esc(e.name)}</b> <span class="text-muted">· ${esc(ROLE_WORDS[e.role] || e.role)}${e.array ? ` in the array ${esc(e.array)}` : ''}</span>
                                <div class="text-xs text-muted">${esc([e.model, e.transport, P.bytes(e.size), e.serial ? `serial ${e.serial}` : ''].filter(Boolean).join(' · '))}</div></div>
                            <span class="sp-pill sp-pill-${hw.level}">${esc(hw.text)}</span>
                        </div>
                        <div class="sp-disk-facts">
                            ${temp ? `<span>${temp} °C</span>` : ''}
                            ${e.dev?.power === 'standby' ? '<span>Sleeping</span>' : e.dev?.power === 'active' ? '<span>Awake</span>' : ''}
                            ${e.dev ? `<span class="sp-selftest" data-node="${escAttr(e.node)}">self-test…</span>` : ''}
                            ${e.mount ? `<span class="font-mono text-xs">${esc(e.mount)}</span>` : ''}
                        </div>
                        ${io && io.read_kb.length >= 3 && max > 1 ? `<div class="sp-io" data-tooltip="Read and written in the last hours, every 5 minutes"><span class="text-xs text-muted">read</span>${bar(io.read_kb, max, 'sp-spark-read')}<span class="text-xs text-muted">write</span>${bar(io.write_kb, max, 'sp-spark-write')}</div>` : ''}
                        <div class="sp-disk-actions">
                            ${e.dev && !e.array ? `<button class="btn btn-sm btn-secondary" data-action="smart-details" data-node="${escAttr(e.node)}">Health details</button>` : ''}
                            ${e.dev || ['blank', 'mounted', 'unmounted'].includes(e.role) ? `<button class="btn btn-sm btn-secondary" data-sp="disk-test" data-node="${escAttr(e.node)}" data-name="${escAttr(e.name)}">Test…</button>` : ''}
                            ${e.dev ? `<button class="btn btn-sm btn-secondary" data-sp="disk-power" data-id="${escAttr(e.id)}">Power…</button>` : ''}
                            ${e.mount && e.role !== 'parity' ? `<button class="btn btn-sm btn-secondary" data-sp="disk-busy" data-path="${escAttr(e.mount)}">What uses it?</button>` : ''}
                            ${e.role === 'data' && !e.array && e.mount ? `<button class="btn btn-sm btn-secondary" data-sp="file-copy" data-path="${escAttr(e.mount)}" data-dir="1" data-tooltip="Before replacing a disk that still reads: copy everything to the new one">Copy its files…</button>` : ''}
                            ${(e.role === 'data' || e.role === 'parity') && !e.array ? `<button class="btn btn-sm btn-secondary" data-sp="storage" data-st-action="replace" data-st-data="${escAttr(JSON.stringify({ kind: e.role, name: e.name }))}">Replace…</button>` : ''}
                            ${['blank', 'mounted', 'unmounted', 'unformatted'].includes(e.role) ? `<button class="btn btn-sm btn-secondary" data-sp="storage" data-st-action="" data-st-tab="array">Use it…</button>` : ''}
                            ${['blank', 'unmounted', 'unformatted', 'other'].includes(e.role) && !e.dev ? `<button class="btn btn-sm btn-danger" data-sp="disk-wipe" data-node="${escAttr(e.node)}" data-size="${e.size || 0}">Erase…</button>` : ''}
                        </div>
                    </div>`;
                }).join('')}
            </div>`)}

        ${section('Automatic health tests', `Every disk can test itself with its ${term('smart', 'self-diagnosis')}. The short test takes minutes, the long one reads the whole disk and takes hours. Both run while the disks keep working.`, `
            <div class="sp-form">
                <div class="sp-form-row">
                    ${toggle('sp-st-short', !!shortPlan, 'Short test every week')}
                    <select class="form-control sp-w-auto" id="sp-st-short-day">${P.DAYS.map((x, i) => `<option value="${i}" ${(shortPlan ? shortPlan.day : 0) === i ? 'selected' : ''}>${x}</option>`).join('')}</select>
                    <input class="form-control sp-w-auto" type="time" id="sp-st-short-time" value="${shortPlan ? `${String(shortPlan.hour).padStart(2, '0')}:${String(shortPlan.minute).padStart(2, '0')}` : '03:30'}">
                </div>
                <div class="sp-form-row">
                    ${toggle('sp-st-long', !!longPlan, 'Long test every month, on the first')}
                    <select class="form-control sp-w-auto" id="sp-st-long-day">${P.DAYS.map((x, i) => `<option value="${i}" ${(longPlan ? longPlan.day : 6) === i ? 'selected' : ''}>${x}</option>`).join('')}</select>
                    <input class="form-control sp-w-auto" type="time" id="sp-st-long-time" value="${longPlan ? `${String(longPlan.hour).padStart(2, '0')}:${String(longPlan.minute).padStart(2, '0')}` : '04:30'}">
                </div>
                <div class="sp-form-foot">${button('Save', 'smart-save', {}, 'btn-primary')}<span class="sp-saved" id="sp-st-saved"></span></div>
            </div>`)}
    `);

    // the self-test results come one by one, they take a moment
    for (const el of S.view.querySelectorAll('.sp-selftest')) {
        HostAPI.smartLog(el.dataset.node).then(r => {
            const st = P.selfTestSummary(r.text);
            el.textContent = st.text;
            el.className = `sp-selftest sp-pill sp-pill-${st.state === 'ok' ? 'ok' : st.state === 'bad' ? 'bad' : st.state === 'running' ? 'busy' : 'tip'}`;
        }).catch(() => { el.textContent = ''; });
    }
};

const baySave = async (doc) => {
    const r = await act(() => HostAPI.settings({ 'doc.bays': JSON.stringify(doc) }));
    if (r) refresh();
};

const diskTest = (node, name) => {
    dialog({
        title: `Test ${name}`, large: false,
        body: `
            <p class="text-sm">The disk tests itself while it keeps working. The result shows here when it's done.</p>
            <div class="sp-choices mt-4">
                <label class="sp-choice"><input type="radio" name="sp-tk" value="short" checked><span><b>Short</b> — a few minutes. Finds most problems.</span></label>
                <label class="sp-choice"><input type="radio" name="sp-tk" value="long"><span><b>Long</b> — reads the whole disk, hours for big disks. Finds the rest.</span></label>
            </div>`,
        buttons: [
            { label: 'Cancel', onClick: (x) => x.close() },
            {
                label: 'Start the test', cls: 'btn-primary', onClick: async (x) => {
                    const kind = x.body.querySelector('input[name="sp-tk"]:checked').value;
                    x.close();
                    if (await act(() => HostAPI.smartTest(node, kind), `${kind === 'short' ? 'Short' : 'Long'} test started on ${name}`)) setTimeout(refresh, 1500);
                }
            }
        ]
    });
};

const diskPower = (id) => {
    const e = (S.cache.drives || []).find(x => x.id === id);
    if (!e) return;
    const cur = (S.cache.hostPower || []).find(p => p.disk === e.id) || {};
    const opt = (v, label, sel) => `<option value="${v}" ${String(sel) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
    dialog({
        title: `Power settings of ${e.name}`, large: false,
        body: `
            <p class="text-sm mb-4">Set again at every start of the service. Many USB disks and all the virtual ones ignore them: you'll be told.</p>
            ${field('Power saving', `<select class="form-control" id="sp-pw-apm">${opt('', 'Leave as it is', cur.apm ?? '')}${opt(127, 'Save power, the disk may sleep', cur.apm)}${opt(192, 'Balanced', cur.apm)}${opt(254, 'Fastest, no power saving', cur.apm)}</select>`, 'Sleeping after idle time is set in System → Power.')}
            ${field('Noise', `<select class="form-control" id="sp-pw-aam">${opt('', 'Leave as it is', cur.aam ?? '')}${opt(128, 'Quiet', cur.aam)}${opt(254, 'Fast', cur.aam)}</select>`, 'Only older disks have it.')}
            ${field('Write cache', `<select class="form-control" id="sp-pw-wc">${opt('', 'Leave as it is', cur.wcache == null ? '' : cur.wcache ? 1 : 0)}${opt(1, 'On — faster', cur.wcache == null ? '' : cur.wcache ? 1 : 0)}${opt(0, 'Off — safer without a UPS', cur.wcache == null ? '' : cur.wcache ? 1 : 0)}</select>`, 'With it on, a power cut can lose the last seconds of writes.')}`,
        buttons: [
            { label: 'Cancel', onClick: (x) => x.close() },
            {
                label: 'Save and apply', cls: 'btn-primary', onClick: async (x) => {
                    const body = { disk: e.id };
                    if (val('sp-pw-apm')) body.apm = val('sp-pw-apm');
                    if (val('sp-pw-aam')) body.aam = val('sp-pw-aam');
                    if (val('sp-pw-wc')) body.wcache = val('sp-pw-wc') === '1';
                    x.close();
                    try {
                        const r = await HostAPI.powerSave(body);
                        if (r.applied === false) showToast(`Saved, but this disk does not accept it: ${r.warning || ''}`, 'warning');
                        else showToast('Saved and applied', 'success');
                    } catch (err) { showToast(err.message, 'error'); }
                }
            }
        ]
    });
};

const diskWipe = async (node, sizeBytes) => {
    const dlg = dialog({
        title: `Erase ${node}`, large: false,
        body: `
            <div class="st-effects"><div class="st-effects-title">What happens</div><ul>
                <li>Every byte of the disk is overwritten: files, folders and partitions. Nothing can be read back, by anybody.</li>
                <li>It takes time: about ${P.humanSpan((sizeBytes || 0) / 150e6)} for this disk.</li></ul></div>
            <div class="st-effects st-effects-safe"><div class="st-effects-title">Safety</div><ul>
                <li>Disks of your arrays and mounted disks are refused.</li></ul></div>
            <div class="sp-choices mt-4">
                <label class="sp-choice"><input type="radio" name="sp-wm" value="zero" checked><span><b>Zeros</b> — enough to sell or give away the disk.</span></label>
                <label class="sp-choice"><input type="radio" name="sp-wm" value="random"><span><b>Random data</b> — slower, for the cautious.</span></label>
            </div>
            ${field('Type the name of the disk to confirm', `<input class="form-control font-mono" id="sp-wipe-confirm" placeholder="${escAttr(node)}">`)}`,
        buttons: [
            { label: 'Cancel', onClick: (x) => x.close() },
            {
                label: 'Erase the disk', cls: 'btn-danger', onClick: async (x) => {
                    if (val('sp-wipe-confirm').trim() !== node) return showToast(`Type ${node} to confirm`, 'warning');
                    const method = x.body.querySelector('input[name="sp-wm"]:checked').value;
                    x.close();
                    S.cache.wipeSize = Number(sizeBytes) || 0;
                    if (await act(() => HostAPI.wipe(node, method))) followJob(`Erasing ${node}`);
                }
            }
        ]
    });
    void dlg;
};

const diskBusy = async (path) => {
    try {
        const r = await HostAPI.openFiles(path);
        const list = r.processes || [];
        dialog({
            title: `What uses ${path}`, large: false,
            body: list.length ? `
                <p class="text-sm mb-2">These programs have files open there, or are working inside it. While they do, the disk cannot be removed or unmounted, and it does not sleep.</p>
                <table class="data-table"><thead><tr><th>Program</th><th>User</th><th>Files open</th></tr></thead><tbody>
                ${list.map(p => `<tr><td>${esc(p.name)} <span class="text-xs text-muted">pid ${p.pid}</span>${p.example ? `<div class="text-xs font-mono text-muted">${esc(p.example)}</div>` : ''}</td><td>${esc(p.user)}</td><td>${p.files}${p.cwd ? ' + working folder' : ''}</td></tr>`).join('')}
                </tbody></table>` : `<p>${icon('ok', 'sp-icon-ok')} Nothing uses it right now.</p>`,
            buttons: [{ label: 'Close', cls: 'btn-primary', onClick: (x) => x.close() }]
        });
    } catch (e) { showToast(e.message, 'error'); }
};

const smartSave = async () => {
    const t = (id) => val(id) || '03:00';
    const day3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const shortV = checked('sp-st-short') ? `${day3[Number(val('sp-st-short-day'))]} ${t('sp-st-short-time')}` : '';
    const longV = checked('sp-st-long') ? `${day3[Number(val('sp-st-long-day'))]}#1 ${t('sp-st-long-time')}` : '';
    const r = await act(() => HostAPI.settings({ smart_short: shortV, smart_long: longV }));
    if (!r) return;
    // read back what the server keeps
    const back = r.smart_tests || {};
    const words = [back.short ? `short ${P.describeSchedule(back.short)}` : '', back.long ? `long ${P.describeSchedule(back.long)}` : ''].filter(Boolean);
    savedNote('sp-st-saved', words.length ? `Saved: ${words.join('; ')}` : 'Saved: no automatic tests');
};

/* ------------------------------------------------------------------ */
/* Protection                                                          */
/* ------------------------------------------------------------------ */

/** Read a schedule as "daily at a time" or "some days at a time"; anything else is custom. */
const scheduleForm = (text) => {
    const list = P.parseSchedule(text);
    if (!list.length) return { mode: 'off', days: [], time: '02:00', text: '' };
    const time = `${String(list[0].hour).padStart(2, '0')}:${String(list[0].minute).padStart(2, '0')}`;
    const sameTime = list.every(e => e.hour === list[0].hour && e.minute === list[0].minute && !e.nth);
    if (sameTime && list.length === 1 && list[0].day < 0) return { mode: 'daily', days: [], time, text };
    if (sameTime && list.every(e => e.day >= 0)) return { mode: 'days', days: list.map(e => e.day), time, text };
    return { mode: 'custom', days: [], time, text };
};

const loadProtection = async () => {
    const d = await loadCommon('config array tasks host storage');
    const c = d.config || {};
    const nowIso = d.array?.pulse?.current_at;
    const sync = P.lastTask(d.tasks, 'sync', true);
    const scrub = P.lastTask(d.tasks, 'scrub', true);
    const changes = P.pendingChanges(d.array);
    const next = P.nextRun(c.maintenance_schedule);
    const blocked = P.blockedSync(d.tasks);
    const form = scheduleForm(c.maintenance_schedule);
    const stopAt = d.host?.settings?.maintenance_stop_at || '';
    const conf = d.storage?.model?.conf || [];
    const tempLimit = conf.find(e => e.type === 'option' && e.key === 'temp_limit')?.value || '';
    const k = d.storage?.model?.parity?.length || 0;
    S.cache.protConf = conf;
    S.cache.protTemp = tempLimit;
    const pct = Number(c.scrub_percentage) || 0;
    const runsPerWeek = form.mode === 'daily' ? 7 : form.mode === 'days' ? form.days.length : 7;
    const fullEvery = pct > 0 && runsPerWeek ? Math.ceil(100 / pct / runsPerWeek * 7) : 0;

    const runs = (d.tasks?.history || []).filter(t => (t.command === 'sync' || t.command === 'scrub') && t.status !== 'canceled').slice(0, 24);
    const maxDur = Math.max(1, ...runs.map(P.taskSeconds));

    header(button('Protect now', 'go', { act: 'protect' }, 'btn-primary'));

    const pctOptions = [0, 1, 3, 5, 8, 12, 25, 50, 100];
    if (!pctOptions.includes(pct)) pctOptions.push(pct);

    draw(`
        ${blocked ? `
        <div class="sp-hero sp-hero-warn">
            <div class="sp-hero-icon">${ICON.warn}</div>
            <div class="sp-hero-text">
                <div class="sp-hero-title">Waiting for your OK</div>
                <div class="sp-hero-sub">${esc(P.plural(blocked.count, `file was ${blocked.what === 'removed' ? 'deleted' : 'changed'}`, `files were ${blocked.what === 'removed' ? 'deleted' : 'changed'}`))} since the last update, more than the safety limit of ${blocked.limit}. Until you decide, the protection keeps the old state, so ${blocked.what === 'removed' ? 'the deleted files can still be brought back' : 'the old versions can still be rebuilt'}.</div>
            </div>
            <div class="sp-hero-action">
                ${blocked.what === 'removed' ? button('Get them back', 'restore', { path: '/' }) : ''}
                ${button('It was on purpose: update', 'sync-anyway', {}, 'btn-primary')}
            </div>
        </div>` : ''}

        ${section('How protected you are', `With ${term('parity', 'protection')} on ${P.plural(k, 'disk', 'disks')}, any ${P.plural(k, 'disk', 'disks')} can fail and every file can be rebuilt — as it was at the last ${term('sync', 'update')}.`, `
            <div class="sp-facts">
                <div><div class="sp-fact-label">Last update</div><div class="sp-fact-value">${sync ? esc(P.ago(sync.finished_at, nowIso)) : '–'}</div></div>
                <div><div class="sp-fact-label">Changed since then</div><div class="sp-fact-value">${P.plural(changes, 'file', 'files')}</div></div>
                <div><div class="sp-fact-label">Next automatic update</div><div class="sp-fact-value">${esc(next ? P.whenWords(next) : 'not planned')}</div></div>
                <div><div class="sp-fact-label">Last check for damage</div><div class="sp-fact-value">${scrub ? esc(P.ago(scrub.finished_at, nowIso)) : '–'}</div></div>
            </div>`)}

        ${section('Automatic protection', 'When the server updates the protection and checks your data by itself. Pick a time when nobody uses it: the disks work hard for a while.', `
            <div class="sp-form">
                <div class="sp-form-row">
                    <span class="sp-field-label">Update the protection</span>
                    <select class="form-control sp-w-auto" id="sp-pr-mode">
                        <option value="daily" ${form.mode === 'daily' ? 'selected' : ''}>every day</option>
                        <option value="days" ${form.mode === 'days' ? 'selected' : ''}>on some days</option>
                        <option value="custom" ${form.mode === 'custom' ? 'selected' : ''}>custom</option>
                        <option value="off" ${form.mode === 'off' ? 'selected' : ''}>never (not recommended)</option>
                    </select>
                    <span id="sp-pr-at">at</span> <input class="form-control sp-w-auto" type="time" id="sp-pr-time" value="${esc(form.time)}">
                </div>
                <div class="sp-form-row ${form.mode === 'days' ? '' : 'hidden'}" id="sp-pr-days">
                    ${P.DAYS.map((x, i) => `<label class="sp-day"><input type="checkbox" class="sp-pr-day" value="${i}" ${form.days.includes(i) ? 'checked' : ''}> ${x.slice(0, 3)}</label>`).join('')}
                </div>
                <div class="sp-form-row ${form.mode === 'custom' ? '' : 'hidden'}" id="sp-pr-custom">
                    ${field('Times', `<input class="form-control" id="sp-pr-text" value="${escAttr(form.text)}">`, 'Like “02:00, Sun 05:00”: every day at 2, and on Sundays at 5 too.')}
                </div>
                <div class="sp-form-row">
                    ${toggle('sp-pr-stop', !!stopAt, 'Stop by a set time', 'If it’s still working then, it stops and continues the next time. Nothing is lost.')}
                    <input class="form-control sp-w-auto" type="time" id="sp-pr-stop-time" value="${esc(stopAt || '07:00')}">
                </div>
                <hr class="sp-hr">
                <div class="sp-form-row">
                    <span class="sp-field-label">Each time, ${term('scrub', 'check for damage')}</span>
                    <select class="form-control sp-w-auto" id="sp-pr-pct">${pctOptions.sort((a, b) => a - b).map(v => `<option value="${v}" ${v === pct ? 'selected' : ''}>${v ? `${v}% of the data` : 'nothing'}</option>`).join('')}</select>
                    <span>not checked in the last</span>
                    <input class="form-control sp-num" type="number" min="0" max="365" id="sp-pr-older" value="${Number(c.scrub_older_than) || 0}"> <span>days</span>
                </div>
                <div class="sp-field-help" id="sp-pr-pct-help">${pct ? `All your data is checked about every ${P.plural(fullEvery, 'day', 'days')}.` : 'Silent damage, like a disk returning wrong data, is found only by checking.'}</div>
                <hr class="sp-hr">
                <div class="sp-form-row">
                    <span class="sp-field-label">Safety check: ask me first if more than</span>
                    <input class="form-control sp-num" type="number" min="0" max="10000" id="sp-pr-del" value="${Number(c.sync_threshold_deletes) || 0}"> <span>files were deleted, or</span>
                    <input class="form-control sp-num" type="number" min="0" max="10000" id="sp-pr-upd" value="${Number(c.sync_threshold_updates) || 0}"> <span>changed</span>
                </div>
                <div class="sp-field-help">A disk that did not mount, or a virus encrypting files, looks like many files deleted or changed. Updating the protection then would make it forget the good versions. 0 means never ask.</div>
                <div class="sp-form-row mt-2">
                    ${toggle('sp-pr-temp', !!tempLimit, 'Pause when a disk gets hot', 'The work waits for the disks to cool down.')}
                    <input class="form-control sp-num" type="number" min="40" max="70" id="sp-pr-temp-v" value="${esc(tempLimit || '50')}"> <span>°C</span>
                </div>
                <div class="sp-form-foot">${button('Save', 'prot-save', {}, 'btn-primary')}<span class="sp-saved" id="sp-pr-saved"></span></div>
            </div>`)}

        ${section('Past runs', 'Each bar is one run: the longer, the more there was to do.', runs.length ? `
            <div class="sp-runs">
                ${runs.map(t => {
                    const w = P.taskWords(t);
                    const secs = P.taskSeconds(t);
                    return `<div class="sp-run">
                        <span class="sp-run-when">${esc(P.ago(t.finished_at || t.started_at, nowIso))}</span>
                        <span class="sp-run-what">${esc(w.title)}</span>
                        <span class="sp-run-bar"><span class="sp-run-fill sp-run-${t.command} ${w.ok ? '' : 'sp-run-bad'}" data-width="${Math.max(1, Math.round(secs * 100 / maxDur))}"></span></span>
                        <span class="sp-run-dur">${esc(P.humanSpan(secs))}${t.speed_mbs ? ` · ${t.speed_mbs} MB/s` : ''}</span>
                    </div>`;
                }).join('')}
            </div>` : empty('No run yet.'), '<a class="sp-link" href="#/tasks">Every detail</a>')}
    `);

    const mode = document.getElementById('sp-pr-mode');
    mode?.addEventListener('change', () => {
        document.getElementById('sp-pr-days').classList.toggle('hidden', mode.value !== 'days');
        document.getElementById('sp-pr-custom').classList.toggle('hidden', mode.value !== 'custom');
        document.getElementById('sp-pr-time').classList.toggle('hidden', mode.value === 'custom' || mode.value === 'off');
        document.getElementById('sp-pr-at').classList.toggle('hidden', mode.value === 'custom' || mode.value === 'off');
    });
    mode?.dispatchEvent(new Event('change'));
};

const protSave = async () => {
    const mode = val('sp-pr-mode');
    const time = val('sp-pr-time') || '02:00';
    const day3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let schedule = '';
    if (mode === 'daily') schedule = time;
    else if (mode === 'days') schedule = [...document.querySelectorAll('.sp-pr-day:checked')].map(c => `${day3[Number(c.value)]} ${time}`).join(', ');
    else if (mode === 'custom') {
        schedule = P.formatSchedule(P.parseSchedule(val('sp-pr-text')));
        if (!schedule && val('sp-pr-text').trim()) return showToast('The times could not be read: write them like “02:00, Sun 05:00”', 'error');
    }
    if (mode === 'days' && !schedule) return showToast('Choose at least one day', 'warning');
    if (mode === 'off') {
        const sure = await confirmDo({ title: 'Turn off the automatic protection', effects: ['Nothing updates the protection by itself any more: files added or changed from now on are not protected until you press Protect now.'], label: 'Turn it off', danger: true });
        if (!sure) return;
    }

    const patch = {
        maintenance_schedule: schedule,
        scrub_percentage: Number(val('sp-pr-pct')),
        scrub_older_than: Number(val('sp-pr-older')) || 0,
        sync_threshold_deletes: Number(val('sp-pr-del')) || 0,
        sync_threshold_updates: Number(val('sp-pr-upd')) || 0
    };
    try {
        await API.updateConfig(patch);
        await HostAPI.settings({ maintenance_stop_at: checked('sp-pr-stop') ? (val('sp-pr-stop-time') || '07:00') : '' });

        // the temperature limit is an option of SnapRAID itself
        const want = checked('sp-pr-temp') ? String(Number(val('sp-pr-temp-v')) || 50) : '';
        if (want !== (S.cache.protTemp || '')) {
            const conf = (S.cache.protConf || []).filter(e => !(e.type === 'option' && e.key === 'temp_limit'));
            const { serializeConf, confInsert } = await import('./storage.js');
            if (want) confInsert(conf, { type: 'option', key: 'temp_limit', value: want });
            await StorageAPI.saveConf(serializeConf(conf));
        }

        // read back and say what will happen
        const back = await API.getConfig();
        const next = P.nextRun(back.maintenance_schedule);
        savedNote('sp-pr-saved', back.maintenance_schedule
            ? `Saved and checked: ${P.describeSchedule(back.maintenance_schedule)}. Next: ${P.whenWords(next)}.`
            : 'Saved and checked: automatic protection is off.');
    } catch (e) {
        showToast(e.message, 'error');
    }
};

const syncAnyway = async () => {
    const ok = await confirmDo({
        title: 'Update the protection anyway',
        intro: 'Do this only if the files were deleted or changed on purpose, for example after cleaning up.',
        effects: ['The protection takes the files as they are now.', 'Files deleted before this cannot be brought back from the protection afterwards.'],
        safe: ['The files on the disks are not touched.'],
        label: 'Update the protection', danger: true
    });
    if (ok) await act(() => API.schedule([{ command: 'sync' }]), 'Updating the protection');
};

/* ------------------------------------------------------------------ */
/* Sharing                                                             */
/* ------------------------------------------------------------------ */

const loadSharing = async () => {
    const d = await loadCommon('host storage inv');
    const host = d.host || {};
    const shares = host.shares || [];
    const users = (await HostAPI.shareUsers().catch(() => ({ share_users: [] }))).share_users || [];
    S.cache.shareUsers = users;
    S.cache.shareInv = d.inv;
    S.cache.shareModel = d.storage?.model;
    const name = window.location.hostname || 'server';
    const smbMissing = !host.tools?.smbd;

    header(button('Share a folder', 'share-edit', {}, 'btn-primary'));

    draw(`
        ${smbMissing ? `<div class="restricted-banner"><div class="restricted-banner-title">Samba is not installed</div>Shares can be set up here, but other computers can open them only once the samba package is installed on this machine.</div>` : ''}

        ${section('Shared folders', `A ${term('share')} is a folder the other computers of your home can open, like a disk of their own.`, shares.length ? `
            <div class="sp-cards">
                ${shares.map(s => {
                    const a = P.shareAddresses(name, s.name);
                    const who = s.guest ? 'Everyone on your network, no password' : s.users ? `Only ${s.users.split(',').join(', ')}` : 'Every user below';
                    return `
                    <div class="sp-card">
                        <div class="sp-card-head">${icon('share')}<div><b>${esc(s.name)}</b>${s.comment ? ` <span class="text-muted">· ${esc(s.comment)}</span>` : ''}<div class="text-xs font-mono text-muted">${esc(s.path)}</div></div></div>
                        <ul class="sp-card-facts">
                            <li>${esc(who)}${s.writable === false ? ', read only' : ', can change files'}</li>
                            <li>${s.recycle ? `Deleted files kept ${P.plural(s.recycle_days || 30, 'day', 'days')} in the ${term('recycle bin')} (folder .recycle)` : 'No recycle bin: deleted files go at once'}</li>
                            ${s.nfs ? `<li>Also for Linux and TV boxes (NFS)${s.nfs_hosts ? `: ${esc(s.nfs_hosts)}` : ''}</li>` : ''}
                        </ul>
                        <div class="sp-open">
                            <div><span class="text-xs text-muted">Windows</span> <span class="font-mono">${esc(a.windows)}</span></div>
                            <div><span class="text-xs text-muted">Mac, Linux</span> <span class="font-mono">${esc(a.mac)}</span></div>
                        </div>
                        <div class="sp-card-actions">
                            ${button('Change', 'share-edit', { name: s.name })}
                            ${button('Fix permissions', 'share-perms', { path: s.path })}
                            ${button('Stop sharing', 'share-delete', { name: s.name }, 'btn-danger')}
                        </div>
                    </div>`;
                }).join('')}
            </div>` : empty('Nothing is shared yet. Share a folder so your computers, phones and TV can open it.', button('Share a folder', 'share-edit', {}, 'btn-primary')))}

        ${section('People', 'Who can open the shares that are not for everyone. Each person has a name and a password, only for the shares.', `
            ${users.length ? `<div class="sp-users">${users.map(u => `<span class="sp-chip">${esc(u)} <button class="sp-chip-x" data-sp="user-delete" data-user="${escAttr(u)}" data-tooltip="Remove">×</button></span>`).join('')}</div>` : '<p class="text-sm text-muted">Nobody yet.</p>'}
            <div class="sp-form-row mt-4">
                <input class="form-control sp-w-auto" id="sp-u-name" placeholder="Name, like anna" autocomplete="off">
                <input class="form-control sp-w-auto" id="sp-u-pass" type="password" placeholder="Password" autocomplete="new-password">
                ${button('Add', 'user-add', {}, 'btn-primary')}
            </div>
            <div class="sp-field-help">To change a password, add the same name again with the new one.</div>`)}
    `);
};

const shareEdit = async (name) => {
    const host = await HostAPI.status().catch(() => ({ shares: [] }));
    const s = (host.shares || []).find(x => x.name === name) || { smb: true, writable: true, recycle: true, recycle_days: 30, guest: false };
    const users = S.cache.shareUsers || [];
    const pools = (S.cache.shareInv?.pools || []).map(p => p.mountpoint);
    const picked = new Set((s.users || '').split(',').filter(Boolean));
    // the top folders of the pools are what people share most
    let folders = [];
    for (const p of pools) {
        try {
            const l = await StorageAPI.browse(p, '/');
            folders = folders.concat(l.entries.filter(e => e.dir).map(e => `${p}/${e.name}`));
        } catch (ignore) { /* not readable */ }
        folders.push(p);
    }

    dialog({
        title: name ? `Change the share ${name}` : 'Share a folder', large: true,
        body: `
            ${field('Folder', `<input class="form-control font-mono" id="sp-sh-path" list="sp-sh-folders" value="${escAttr(s.path || folders[0] || '')}"><datalist id="sp-sh-folders">${folders.map(f => `<option value="${escAttr(f)}">`).join('')}</datalist>`, 'Pick one of the list, or write the path of a folder.')}
            ${field('Name on the network', `<input class="form-control" id="sp-sh-name" value="${escAttr(s.name || P.shareNameOf(s.path || folders[0] || 'share'))}" ${name ? 'disabled' : ''}>`, 'What the other computers show. Letters, digits, - and _.')}
            ${field('Description', `<input class="form-control" id="sp-sh-comment" value="${escAttr(s.comment || '')}">`)}
            <div class="sp-field-label mt-4">Who can open it</div>
            <div class="sp-choices">
                <label class="sp-choice"><input type="radio" name="sp-sh-who" value="guest" ${s.guest ? 'checked' : ''}><span><b>Everyone on my network</b> — no password. Fine for movies and music at home.</span></label>
                <label class="sp-choice"><input type="radio" name="sp-sh-who" value="users" ${s.guest ? '' : 'checked'}><span><b>Only these people</b> — with their password.</span></label>
            </div>
            <div class="sp-users mt-2" id="sp-sh-users">${users.length ? users.map(u => `<label class="sp-chip"><input type="checkbox" class="sp-sh-user" value="${escAttr(u)}" ${picked.has(u) || !s.users ? 'checked' : ''}> ${esc(u)}</label>`).join('') : '<span class="text-sm text-amber">Nobody is set up yet: add people on the Sharing page first, or share with everyone.</span>'}</div>
            <div class="mt-4">${toggle('sp-sh-write', s.writable !== false, 'They can change and delete files', 'Off: they can only open and copy.')}</div>
            <div class="mt-2">${toggle('sp-sh-recycle', !!s.recycle, 'Keep deleted files for a while', 'Files deleted from another computer go to the folder .recycle first.')}
                <div class="sp-form-row"><span class="text-sm">Keep them</span><input class="form-control sp-num" type="number" min="1" max="365" id="sp-sh-days" value="${s.recycle_days || 30}"><span class="text-sm">days</span></div></div>
            <details class="sp-more mt-4"><summary>More options</summary>
                <div class="mt-2">${toggle('sp-sh-nfs', !!s.nfs, 'Also share with NFS', 'For Linux computers and some TV boxes.')}</div>
                ${field('NFS: which computers', `<input class="form-control" id="sp-sh-hosts" value="${escAttr(s.nfs_hosts || '')}" placeholder="192.168.1.0/24">`, 'Empty: all. Addresses or networks, separated by commas.')}
                <div class="mt-2">${toggle('sp-sh-hidden', !!s.hidden, 'Hide it from the list of shares', 'It still opens when its name is typed.')}</div>
            </details>`,
        buttons: [
            { label: 'Cancel', onClick: (x) => x.close() },
            {
                label: name ? 'Save' : 'Share it', cls: 'btn-primary', onClick: async (x) => {
                    const guest = x.body.querySelector('input[name="sp-sh-who"]:checked').value === 'guest';
                    const chosen = [...x.body.querySelectorAll('.sp-sh-user:checked')].map(c => c.value);
                    if (!guest && !chosen.length) return showToast('Choose who can open it, or share with everyone', 'warning');
                    const body = {
                        name: name || val('sp-sh-name').trim(), path: val('sp-sh-path').trim().replace(/\/+$/, ''), comment: val('sp-sh-comment').trim(),
                        smb: true, guest, users: guest ? '' : chosen.join(','), writable: checked('sp-sh-write'),
                        recycle: checked('sp-sh-recycle'), recycle_days: String(Number(val('sp-sh-days')) || 30),
                        nfs: checked('sp-sh-nfs'), nfs_hosts: val('sp-sh-hosts').trim(), hidden: checked('sp-sh-hidden')
                    };
                    try {
                        const r = await HostAPI.shareSave(body);
                        x.close();
                        if (r.applied === false) showToast(`Saved. ${r.warning || ''}`, 'warning');
                        else showToast(`Shared: open it as ${P.shareAddresses(window.location.hostname || 'server', body.name).windows}`, 'success');
                        refresh();
                    } catch (e) { showToast(e.message, 'error'); }
                }
            }
        ]
    });
    // the name follows the folder until a person writes one
    const p = document.getElementById('sp-sh-path');
    const n = document.getElementById('sp-sh-name');
    if (p && n && !name) {
        let touched = false;
        n.addEventListener('input', () => { touched = true; });
        p.addEventListener('input', () => { if (!touched) n.value = P.shareNameOf(p.value); });
    }
};

/* ------------------------------------------------------------------ */
/* Backups                                                             */
/* ------------------------------------------------------------------ */

/** Disks a backup can go to: mounted filesystems in no array, and USB disks not mounted. */
const backupTargets = (inv, model) => {
    const out = [];
    const used = new Set([...(model?.data || []).map(x => x.mount?.target), ...(model?.parity || []).flatMap(p => p.files.map(f => f.mount?.target))].filter(Boolean));
    for (const b of inv?.blkid || []) {
        if (!b.uuid || ['swap', 'linux_raid_member', 'LVM2_member', 'crypto_LUKS'].includes(b.fstype)) continue;
        const m = (inv.mounts || []).find(x => x.source === b.device);
        if (m && (used.has(m.target) || !/^\/(mnt|srv|media)\//.test(m.target))) continue;
        out.push({ uuid: b.uuid, label: b.label || '', device: b.device, fstype: b.fstype, mount: m?.target || '', free: m?.free_bytes });
    }
    return out;
};

const loadBackups = async () => {
    const d = await loadCommon('host inv storage');
    const host = d.host || {};
    const backups = host.backups || [];
    S.cache.backupInv = d.inv;
    S.cache.backupModel = d.storage?.model;

    header(button('Make a backup', 'backup-edit', {}, 'btn-primary'));

    draw(`
        ${section('Backup copies', 'The protection rebuilds a broken disk. A backup is different: a second copy of your most important folders on another disk, ideally one you can take away. It keeps a file you deleted or overwrote by mistake.', backups.length ? `
            <div class="sp-cards">
                ${backups.map(b => {
                    const target = (backupTargets(d.inv, d.storage?.model).find(t => t.uuid === b.dest_uuid) || {});
                    const where = b.dest_path ? b.dest_path : `${target.label || 'disk'} ${b.dest_uuid ? `(${b.dest_uuid.slice(0, 8)}…)` : ''}${b.dest_dir ? ` / ${b.dest_dir}` : ''}`;
                    const lastOk = b.last_status === 0 || b.last_status === 207;
                    return `
                    <div class="sp-card">
                        <div class="sp-card-head">${icon('backup')}<div><b>${esc(b.name)}</b><div class="text-xs text-muted"><span class="font-mono">${esc(b.source)}</span> → ${esc(where)}</div></div>
                            ${b.dest_uuid ? `<span class="sp-pill sp-pill-${b.plugged ? 'ok' : 'tip'}">${b.plugged ? 'disk connected' : 'disk away'}</span>` : ''}</div>
                        <ul class="sp-card-facts">
                            <li>${[b.when ? P.describeSchedule(b.when) : '', b.plug ? 'when its disk is plugged in' : ''].filter(Boolean).join(', and ') || 'only when you press Run now'}</li>
                            <li>${b.mirror ? 'Exact copy: files deleted here are deleted there too' : 'Adds and updates: nothing is ever deleted from the copy'}</li>
                            <li>${b.last_time ? `<span class="${lastOk ? 'text-emerald' : 'text-red'}">${lastOk ? 'Last run worked' : 'Last run failed'}</span>, ${esc(P.humanSpan(Date.now() / 1000 - b.last_time))} ago${b.last_message && !lastOk ? `: ${esc(b.last_message)}` : ''}` : 'Never run yet'}</li>
                        </ul>
                        <div class="sp-card-actions">
                            ${button('Run now', 'backup-run', { name: b.name }, 'btn-primary')}
                            ${button('Change', 'backup-edit', { name: b.name })}
                            ${button('Delete', 'backup-delete', { name: b.name }, 'btn-danger')}
                        </div>
                    </div>`;
                }).join('')}
            </div>` : empty('No backup yet. Plug in a USB disk, then make a backup of your photos and documents.', button('Make a backup', 'backup-edit', {}, 'btn-primary')))}
    `);
};

const backupEdit = async (name) => {
    const host = await HostAPI.status().catch(() => ({ backups: [] }));
    const b = (host.backups || []).find(x => x.name === name) || { plug: true, mirror: false, enabled: true };
    const targets = backupTargets(S.cache.backupInv, S.cache.backupModel);
    const pools = (S.cache.backupInv?.pools || []).map(p => p.mountpoint);
    let folders = [];
    for (const p of pools) {
        try { folders = folders.concat((await StorageAPI.browse(p, '/')).entries.filter(e => e.dir).map(e => `${p}/${e.name}`)); } catch (ignore) { /* skip */ }
    }
    const plan = P.parseSchedule(b.when)[0];
    dialog({
        title: name ? `Change the backup ${name}` : 'Make a backup', large: true,
        body: `
            ${field('What to copy', `<input class="form-control font-mono" id="sp-bk-src" list="sp-bk-folders" value="${escAttr(b.source || folders[0] || '')}"><datalist id="sp-bk-folders">${folders.map(f => `<option value="${escAttr(f)}">`).join('')}</datalist>`, 'A folder. Everything inside it is copied.')}
            ${field('To which disk', targets.length ? `<select class="form-control" id="sp-bk-dest">${targets.map(t => `<option value="${escAttr(t.uuid)}" ${t.uuid === b.dest_uuid ? 'selected' : ''}>${esc(t.label || t.device)} — ${esc(t.fstype)}${t.mount ? `, at ${t.mount}, ${P.bytes(t.free)} free` : ', not mounted'}</option>`).join('')}</select>`
                : '<div class="text-sm text-amber">No disk outside your arrays was found. Plug in a USB disk with a filesystem, then reload.</div>', 'Disks of the arrays are not offered: a backup on the same disks would fail together with them.')}
            ${field('Into the folder', `<input class="form-control" id="sp-bk-dir" value="${escAttr(b.dest_dir || `Backups/${(b.source || folders[0] || 'files').split('/').pop()}`)}">`)}
            ${field('Name', `<input class="form-control" id="sp-bk-name" value="${escAttr(b.name || P.shareNameOf(b.source || folders[0] || 'backup'))}" ${name ? 'disabled' : ''}>`)}
            <div class="sp-field-label mt-4">When</div>
            ${toggle('sp-bk-plug', b.plug !== false, 'As soon as the disk is plugged in', 'When it ends, the disk is released and can be unplugged.')}
            <div class="sp-form-row mt-2">${toggle('sp-bk-sched', !!plan, 'On a schedule')}
                <select class="form-control sp-w-auto" id="sp-bk-day"><option value="-1">every day</option>${P.DAYS.map((x, i) => `<option value="${i}" ${plan && plan.day === i ? 'selected' : ''}>every ${x}</option>`).join('')}</select>
                <input class="form-control sp-w-auto" type="time" id="sp-bk-time" value="${plan ? `${String(plan.hour).padStart(2, '0')}:${String(plan.minute).padStart(2, '0')}` : '05:00'}"></div>
            <div class="mt-4">${toggle('sp-bk-mirror', !!b.mirror, 'Exact copy', 'Files deleted here are deleted from the copy too. Off is safer: nothing is ever removed from the copy.')}</div>`,
        buttons: [
            { label: 'Cancel', onClick: (x) => x.close() },
            {
                label: 'Save', cls: 'btn-primary', onClick: async (x) => {
                    const day3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                    const day = Number(val('sp-bk-day'));
                    const body = {
                        name: name || val('sp-bk-name').trim(), source: val('sp-bk-src').trim().replace(/\/+$/, ''),
                        dest_uuid: val('sp-bk-dest'), dest_dir: val('sp-bk-dir').trim().replace(/^\/+|\/+$/g, ''),
                        plug: checked('sp-bk-plug'), mirror: checked('sp-bk-mirror'), enabled: true,
                        when: checked('sp-bk-sched') ? `${day >= 0 ? `${day3[day]} ` : ''}${val('sp-bk-time') || '05:00'}` : ''
                    };
                    if (!body.dest_uuid) return showToast('Choose a disk', 'warning');
                    if (!body.when) delete body.when;
                    try {
                        await HostAPI.backupSave(body);
                        x.close();
                        const sure = await confirmDo({ title: 'Saved', intro: 'Run the first copy now? The first one copies everything and can take long; the next ones only what changed.', label: 'Run it now' });
                        if (sure && await act(() => HostAPI.backupRun(body.name))) followJob(`Backup ${body.name}`);
                        else refresh();
                    } catch (e) { showToast(e.message, 'error'); }
                }
            }
        ]
    });
};

/* ------------------------------------------------------------------ */
/* Alerts                                                              */
/* ------------------------------------------------------------------ */

const loadAlerts = async () => {
    const d = await loadCommon('config');
    const c = d.config || {};
    const cur = P.notifyParse(c.notify_result);
    const level = c.notify_result_level || 'warning';
    const browser = (() => { try { return localStorage.getItem('sp-browser-alerts') === '1'; } catch (e) { return false; } })();
    const full = c.config_full_access;

    header(button('Send a test', 'alert-test'));

    draw(`
        ${!full ? `<div class="restricted-banner"><div class="restricted-banner-title">Read-only</div>Alerts run a command on this machine, so they can be changed from here only with net_config_full_access = 1 in snapraidd.conf.</div>` : ''}
        ${section('Where to tell you', 'When something goes wrong — a failing disk, damaged files, a backup that did not run — the server sends a message here.', `
            <div class="sp-choices">
                ${Object.entries(P.CHANNELS).map(([k, ch]) => `<label class="sp-choice"><input type="radio" name="sp-al-ch" value="${k}" ${cur.channel === k ? 'checked' : ''}><span><b>${esc(ch.label)}</b></span></label>`).join('')}
                <label class="sp-choice"><input type="radio" name="sp-al-ch" value="" ${!cur.channel ? 'checked' : ''}><span><b>Nowhere</b> — only on this page</span></label>
                ${cur.channel === 'custom' ? `<label class="sp-choice"><input type="radio" name="sp-al-ch" value="custom" checked><span><b>Custom command</b> <span class="font-mono text-xs">${esc(cur.fields.command)}</span></span></label>` : ''}
            </div>
            <div id="sp-al-fields" class="mt-4"></div>
            <div class="sp-form-row mt-4">
                <span class="sp-field-label">Send</span>
                <select class="form-control sp-w-auto" id="sp-al-level">
                    <option value="error" ${level === 'error' || level === 'critical' ? 'selected' : ''}>only real problems</option>
                    <option value="warning" ${level === 'warning' ? 'selected' : ''}>problems and warnings</option>
                    <option value="info" ${level === 'info' ? 'selected' : ''}>also a report after every run</option>
                </select>
            </div>
            <div class="sp-form-foot">${full ? button('Save', 'alert-save', {}, 'btn-primary') : ''}<span class="sp-saved" id="sp-al-saved"></span></div>`)}

        ${section('In this browser', 'A pop-up on this computer while this page is open in a tab. Handy, but not a replacement for the above.', `
            ${toggle('sp-al-browser', browser, 'Show a pop-up when the health changes')}`)}
    `);

    const drawFields = () => {
        const ch = document.querySelector('input[name="sp-al-ch"]:checked')?.value;
        const box = document.getElementById('sp-al-fields');
        const def = P.CHANNELS[ch];
        box.innerHTML = def ? def.fields.map(([k, label, ph]) => field(label, `<input class="form-control" id="sp-al-f-${k}" placeholder="${escAttr(ph)}" value="${escAttr(cur.channel === ch ? cur.fields[k] || '' : '')}">`)).join('')
            + (ch === 'ntfy' ? '<div class="sp-field-help">Install the ntfy app on your phone and subscribe to the same topic. Pick a topic hard to guess: anyone who knows it reads the messages.</div>' : '')
            + (ch === 'email' ? '<div class="sp-field-help">Needs a working “mail” command on this machine.</div>' : '') : '';
    };
    document.querySelectorAll('input[name="sp-al-ch"]').forEach(r => r.addEventListener('change', drawFields));
    drawFields();
    document.getElementById('sp-al-browser')?.addEventListener('change', async (e) => {
        try { localStorage.setItem('sp-browser-alerts', e.target.checked ? '1' : '0'); } catch (ignore) { /* no storage */ }
        if (e.target.checked && 'Notification' in window && Notification.permission !== 'granted') {
            const p = await Notification.requestPermission();
            if (p !== 'granted') showToast('The browser refused: allow notifications for this site in its settings', 'warning');
        }
    });
};

const alertSave = async () => {
    const ch = document.querySelector('input[name="sp-al-ch"]:checked')?.value || '';
    let cmd = '';
    if (ch === 'custom') cmd = P.notifyParse((await API.getConfig()).notify_result).fields.command;
    else if (ch) {
        const f = {};
        for (const [k] of P.CHANNELS[ch].fields) f[k] = val(`sp-al-f-${k}`).trim();
        if (Object.values(f).some(v => !v)) return showToast('Fill in every field', 'warning');
        cmd = P.notifyCommand(ch, f);
    }
    try {
        await API.updateConfig({ notify_result: cmd, notify_result_level: val('sp-al-level') });
        const back = await API.getConfig();
        savedNote('sp-al-saved', back.notify_result ? `Saved and checked. Send a test to see it arrive.` : 'Saved: no messages are sent.');
    } catch (e) { showToast(e.message, 'error'); }
};

/* ------------------------------------------------------------------ */
/* System                                                              */
/* ------------------------------------------------------------------ */

const loadSystem = async () => {
    const d = await loadCommon('host config system');
    const host = d.host || {};
    const s = host.settings || {};
    const c = d.config || {};
    const net = await HostAPI.network().catch(() => ({ interfaces: [] }));
    const phys = (net.interfaces || []).filter(i => i.physical);
    const spin = String(c.spindown_idle_minutes || '0').split(',').map(x => Number(x.trim()) || 0);
    const idle = host.idle || {};

    header('');

    draw(`
        ${section('Power', 'Save electricity when nobody uses the server.', `
            <div class="sp-form">
                <div class="sp-form-row">
                    <span class="sp-field-label">Let the disks sleep after</span>
                    <input class="form-control sp-num" type="number" min="0" max="1440" id="sp-sy-spin" value="${spin[0]}"> <span>minutes without use</span>
                </div>
                <div class="sp-field-help">0: never. A sleeping disk wakes up by itself when a file is opened, after a few seconds.</div>
                <div class="sp-form-row mt-2">
                    ${toggle('sp-sy-dircache', s.dircache === '1', 'Keep the folder listings in memory', 'Browsing the folders then does not wake up the disks.')}
                </div>
                <hr class="sp-hr">
                <div class="sp-form-row">
                    <span class="sp-field-label">When nobody uses the server for</span>
                    <input class="form-control sp-num" type="number" min="10" max="1440" id="sp-sy-idle-min" value="${Number(s.idle_minutes) || 60}"> <span>minutes,</span>
                    <select class="form-control sp-w-auto" id="sp-sy-idle">
                        <option value="none" ${(s.idle_action || 'none') === 'none' ? 'selected' : ''}>stay on</option>
                        <option value="suspend" ${s.idle_action === 'suspend' ? 'selected' : ''}>go to sleep</option>
                        <option value="shutdown" ${s.idle_action === 'shutdown' ? 'selected' : ''}>switch off</option>
                    </select>
                </div>
                <div class="sp-field-help">“Nobody uses it” means: no work running, nobody connected to a share or by SSH, no disk activity and little network traffic, and no automatic protection due in the next 30 minutes. Right now: <b>${esc(idle.action === 'none' ? 'off' : idle.busy ? `busy, ${idle.busy}` : `idle for ${P.humanSpan(idle.idle_seconds || 0)}`)}</b>.</div>
                <div class="sp-form-row mt-2">
                    ${toggle('sp-sy-wol', s.wol === '1', 'Wake it up from the network (Wake-on-LAN)', 'Another computer or a phone app can switch it on again.')}
                </div>
                ${phys.length ? `<div class="sp-field-help">Wake it with the address ${phys.map(i => `<span class="font-mono">${esc(i.mac)}</span> (${esc(i.name)}${i.wake_on ? `, now ${esc(i.wake_on === 'g' ? 'on' : 'off')}` : ''})`).join(', ')}. The BIOS must allow it too.</div>` : ''}
                <div class="sp-form-foot">${button('Save', 'system-save', {}, 'btn-primary')}<span class="sp-saved" id="sp-sy-saved"></span></div>
            </div>`)}

        ${section('Your settings', 'Keep a copy of every setting of this page and of the arrays. With it, a new system disk is set up again in minutes.', `
            <div class="sp-form-row">
                ${button('Download the settings', 'settings-download', {}, 'btn-primary')}
                <label class="btn btn-secondary">Restore from a file…<input type="file" id="sp-sy-restore" accept=".json" class="hidden"></label>
            </div>
            <div class="sp-field-help">The file has your configuration files. Restoring shows each file before it is written, and keeps the old one next to it.</div>`)}

        ${section('Getting help', 'When asking for help on a forum, the diagnostics tell the helpers how this machine is set up. Serial numbers, passwords and the name of the machine are removed.', `
            <div class="sp-form-row">${button('Download the diagnostics', 'diagnostics', {}, 'btn-primary')} <a class="sp-link" href="#/help">Help and guides</a></div>`)}

        ${section('About', '', `
            <div class="sp-facts">
                <div><div class="sp-fact-label">Machine</div><div class="sp-fact-value">${esc(d.system?.hostname || '–')}</div></div>
                <div><div class="sp-fact-label">System</div><div class="sp-fact-value">${esc(d.system?.os_distribution || '–')}</div></div>
                <div><div class="sp-fact-label">Settings file</div><div class="sp-fact-value font-mono text-xs">${esc(host.settings_file || '')}</div></div>
                <div><div class="sp-fact-label">Every option</div><div class="sp-fact-value"><a class="sp-link" href="#/settings">Daemon settings</a></div></div>
            </div>`)}
    `);

    document.getElementById('sp-sy-restore')?.addEventListener('change', (e) => { if (e.target.files[0]) settingsRestore(e.target.files[0]); e.target.value = ''; });
};

const systemSave = async () => {
    try {
        const minutes = Number(val('sp-sy-spin')) || 0;
        await API.updateConfig({ spindown_idle_minutes: String(minutes) });
        const r = await HostAPI.settings({ dircache: checked('sp-sy-dircache') ? '1' : '0', idle_action: val('sp-sy-idle'), idle_minutes: String(Math.max(10, Number(val('sp-sy-idle-min')) || 60)), wol: checked('sp-sy-wol') ? '1' : '0' });
        if (r.warning) showToast(r.warning, 'warning');
        const back = r.idle || {};
        savedNote('sp-sy-saved', `Saved and checked: disks sleep ${minutes ? `after ${minutes} minutes` : 'never'}; when idle the server ${back.action === 'none' ? 'stays on' : back.action === 'suspend' ? `sleeps after ${back.minutes} minutes` : `switches off after ${back.minutes} minutes`}.`);
    } catch (e) { showToast(e.message, 'error'); }
};

const download = (name, text, type = 'text/plain') => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
};

const settingsRestore = async (file) => {
    let doc;
    try { doc = JSON.parse(await file.text()); } catch (e) { return showToast('This is not a settings file', 'error'); }
    if (doc.kind !== 'snapraidd-settings' || !Array.isArray(doc.files)) return showToast('This is not a settings file of this program', 'error');
    let current = {};
    try { current = Object.fromEntries((await HostAPI.settingsBackup()).files.map(f => [f.path, f.text])); } catch (e) { return showToast(e.message, 'error'); }
    const rows = doc.files.map((f, i) => {
        const same = current[f.path] === f.text;
        const known = f.path in current || /snapraidd\.d\/|snapraid\//.test(f.path);
        return `<label class="sp-pick-row"><input type="checkbox" class="sp-rst" data-i="${i}" ${!same && known ? 'checked' : ''} ${same ? 'disabled' : ''}> <span class="font-mono">${esc(f.path)}</span> <span class="text-xs ${same ? 'text-muted' : 'text-amber'}">${same ? 'same as now' : 'different'}</span>
            ${same ? '' : `<details class="sp-more"><summary>See it</summary><pre class="sp-pre">${esc(f.text)}</pre></details>`}</label>`;
    }).join('');
    dialog({
        title: `Restore the settings of ${doc.made || 'a backup'}`, large: true,
        body: `<p class="text-sm mb-2">Choose the files to put back. The current version of each is kept with the extension .before-restore. The SnapRAID configurations are checked before they are written.</p><div class="sp-pick">${rows}</div>`,
        buttons: [
            { label: 'Cancel', onClick: (x) => x.close() },
            {
                label: 'Restore', cls: 'btn-danger', onClick: async (x) => {
                    const picked = [...x.body.querySelectorAll('.sp-rst:checked')].map(c => doc.files[Number(c.dataset.i)]);
                    if (!picked.length) return x.close();
                    x.close();
                    let ok = 0;
                    for (const f of picked) {
                        try { await HostAPI.restore(f.path, f.text); ++ok; } catch (e) { showToast(`${f.path}: ${e.message}`, 'error'); }
                    }
                    if (ok) showToast(`${P.plural(ok, 'file', 'files')} restored. The daemon reads them again now.`, 'success');
                }
            }
        ]
    });
};

/* ------------------------------------------------------------------ */
/* Help                                                                */
/* ------------------------------------------------------------------ */

const GUIDES = [
    ['A disk failed or makes noises', 'Don’t panic: every file can be rebuilt. Open Disks: the failing disk is marked, and the picture of your case shows which one it is. Buy a disk at least as big, put it in, then use “Replace…” on the old disk. The protection rebuilds its files on the new one. Until then, avoid deleting files.', 'drives'],
    ['I deleted a file by mistake', 'If the protection was not updated since, open My files and use “Get back deleted files”. If it was, the file can only come from a backup copy, or from the recycle bin of the share if you deleted it from another computer.', 'files'],
    ['The protection waits for my OK', 'Many files were deleted or changed at once, so the server stopped to ask. On the Protection page, look at what was deleted: get the files back, or confirm it was on purpose.', 'protection'],
    ['Space is running out', 'Look at My files to see what takes space, delete what you don’t need, or add a disk on the Disks page. The protection disks must be at least as big as the biggest data disk.', 'files'],
    ['A computer cannot open a share', 'On Sharing, check the address shown under the share and who can open it. The person must use the name and password set on the Sharing page, not the one of this machine.', 'sharing'],
    ['I want messages on my phone', 'On Alerts, pick “Phone notification (ntfy)”, choose a secret topic, and subscribe to it in the ntfy app.', 'alerts']
];

const loadHelp = async () => {
    const d = await loadCommon('host config disks storage');
    const findings = [
        ...(d.storage?.findings || []),
        ...P.machineFindings({ host: d.host, config: d.config, disks: d.disks })
    ];
    header(button('Download the diagnostics', 'diagnostics'));
    draw(`
        ${section('Health check', 'Everything this program looks at, with what to do. The same as on Home, plus the small things.', `<div class="sp-rows">${findings.length ? findings.map(finding).join('') : empty('Nothing to report.')}</div>`)}
        ${section('What to do when…', '', `<div class="sp-guides">${GUIDES.map(([q, a, go]) => `<details class="sp-guide"><summary>${esc(q)}</summary><p>${esc(a)}</p>${button('Go there', 'go', { act: go })}</details>`).join('')}</div>`)}
        ${section('Words used here', '', `<dl class="sp-glossary">${Object.entries(P.GLOSSARY).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`)}
        ${section('More', '', `<p class="text-sm">The manual of SnapRAID: <a class="sp-link" href="https://www.snapraid.it/manual" target="_blank" rel="noopener noreferrer">snapraid.it/manual</a> · Every detail of this machine: the pages under <b>Advanced</b> in the menu.</p>`)}
    `);
};

/* ------------------------------------------------------------------ */
/* pages and events                                                    */
/* ------------------------------------------------------------------ */

export const SIMPLE_PAGES = {
    '#/': { title: 'Home', load: loadHome, pulse: ['array', 'activity', 'tasks', 'disks'] },
    '#/files': { title: 'My files', load: loadFiles, pulse: [] },
    '#/drives': { title: 'Disks', load: loadDrives, pulse: [] },
    '#/protection': { title: 'Protection', load: loadProtection, pulse: [] },
    '#/sharing': { title: 'Sharing', load: loadSharing, pulse: [], machine: true },
    '#/backups': { title: 'Backups', load: loadBackups, pulse: [], machine: true },
    '#/alerts': { title: 'Alerts', load: loadAlerts, pulse: [] },
    '#/system': { title: 'System', load: loadSystem, pulse: [], machine: true },
    '#/help': { title: 'Help', load: loadHelp, pulse: [], machine: true }
};

export const loadSimplePage = async (hash, view, actions) => {
    S.hash = hash;
    S.view = view;
    S.actions = actions;
    if (hash !== '#/files') { S.cache.path = S.cache.path || '/'; }
    await SIMPLE_PAGES[hash].load();
};

/** Called at every poll: pages that show live state are drawn again when it changes. */
export const simplePulse = async (hash, pulse, old) => {
    const page = SIMPLE_PAGES[hash];
    if (!page || !page.pulse.length || S.busy) return;
    // never while a dialog is open or a field is being edited
    if (document.querySelector('.modal-overlay') || S.view?.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    // at most every 5 seconds: during a task the pulse changes all the time
    if (Date.now() - (S.lastPulseLoad || 0) < 5000) return;
    if (page.pulse.some(k => pulse[k] !== old[k])) {
        S.busy = true;
        S.lastPulseLoad = Date.now();
        try { await page.load(); } catch (ignore) { /* the next poll tries again */ }
        S.busy = false;
    }
};

let lastHealth = null;

/** A pop-up of the browser when the health changes, if asked on the Alerts page. */
export const simpleHealthWatch = (state) => {
    const h = state?.health;
    if (!h) return;
    const prev = lastHealth;
    lastHealth = h;
    let on = false;
    try { on = localStorage.getItem('sp-browser-alerts') === '1'; } catch (ignore) { /* no storage */ }
    if (!on || !prev || prev === h || !('Notification' in window) || Notification.permission !== 'granted') return;
    const bad = ['failing', 'prefail', 'degraded', 'corrupt'].includes(h);
    try {
        new Notification(bad ? 'SnapRAID: something needs your attention' : 'SnapRAID: back to normal', { body: `The health of the array ${state.array || ''} is now ${h}.` });
    } catch (ignore) { /* not allowed */ }
};

export const initSimple = () => {
    document.addEventListener('click', async (e) => {
        const el = e.target.closest('[data-sp]');
        if (!el || el.disabled) return;
        const ds = el.dataset;
        switch (ds.sp) {
            case 'go': goTo(ds.act); break;
            case 'stop': if (await confirmDo({ title: 'Stop the work', effects: ['The running work stops. The next run continues from where it stopped.'], label: 'Stop' })) act(() => API.stopTask(), 'Stopping'); break;
            case 'storage': {
                let data = {};
                try { data = JSON.parse(ds.stData || '{}'); } catch (ignore) { /* none */ }
                storageOpen(ds.stTab || (ds.stAction === 'wizard' ? 'overview' : 'array'), ds.stAction || null, data);
                break;
            }
            case 'files-go': e.preventDefault(); S.cache.path = ds.path || '/'; refresh(); break;
            case 'files-pool': S.cache.pool = ds.pool; S.cache.path = '/'; refresh(); break;
            case 'file-check': fileCheck(ds.path, ds.dir === '1'); break;
            case 'restore': restoreDeleted(ds.path); break;
            case 'file-rename': fileRename(ds.path); break;
            case 'file-delete': fileDelete(ds.path, ds.rel, ds.dir === '1'); break;
            case 'file-copy': fileCopy(ds.path, ds.dir === '1'); break;
            case 'bay-pick': S.cache.placing = S.cache.placing === ds.id ? null : ds.id; refresh(); break;
            case 'bay': {
                const bay = Number(ds.bay);
                const bays = S.cache.bays;
                if (S.cache.placing) {
                    const id = S.cache.placing;
                    S.cache.placing = null;
                    await baySave(P.bayPlace(bays, id, bay));
                } else {
                    const id = Object.keys(bays.slots).find(k => bays.slots[k] === bay);
                    if (id) { S.cache.placing = id; refresh(); }
                }
                break;
            }
            case 'bay-clear': { const id = S.cache.placing; S.cache.placing = null; if (id) await baySave(P.bayPlace(S.cache.bays, id, null)); break; }
            case 'bay-cancel': S.cache.placing = null; refresh(); break;
            case 'bay-size': await baySave({ ...S.cache.bays, rows: Number(val('sp-bay-rows')) || 1, cols: Number(val('sp-bay-cols')) || 1 }); break;
            case 'disk-test': diskTest(ds.node, ds.name); break;
            case 'disk-power': {
                const h = await HostAPI.status().catch(() => ({ power: [] }));
                S.cache.hostPower = h.power || [];
                diskPower(ds.id);
                break;
            }
            case 'disk-wipe': diskWipe(ds.node, ds.size); break;
            case 'disk-busy': diskBusy(ds.path); break;
            case 'test-all': {
                const ok = await confirmDo({ title: 'Test all the disks', intro: 'Every disk of the arrays runs its short self-test, a few minutes. The results show on this page.', safe: ['The disks keep working normally.'], label: 'Start' });
                if (ok) {
                    const nodes = [...new Set((S.cache.drives || []).filter(x => x.dev && !x.missing).map(x => x.node))];
                    const res = await Promise.all(nodes.map(n => HostAPI.smartTest(n, 'short').then(() => 1).catch(() => 0)));
                    showToast(`Started on ${P.plural(res.reduce((a, b) => a + b, 0), 'disk', 'disks')}`, 'success');
                    setTimeout(refresh, 1500);
                }
                break;
            }
            case 'smart-save': smartSave(); break;
            case 'prot-save': protSave(); break;
            case 'sync-anyway': syncAnyway(); break;
            case 'share-edit': shareEdit(ds.name); break;
            case 'share-delete':
                if (await confirmDo({ title: `Stop sharing ${ds.name}`, effects: ['The other computers cannot open it any more.'], safe: ['The folder and its files stay where they are.'], label: 'Stop sharing', danger: true })
                    && await act(() => HostAPI.shareDelete(ds.name), 'No longer shared')) refresh();
                break;
            case 'share-perms':
                if (await confirmDo({ title: 'Fix the permissions', intro: `Every file and folder in <span class="font-mono">${esc(ds.path)}</span> is made readable and writable by the people of the shares.`, effects: ['Use it when a computer cannot open or change some files.', 'Big folders take a while.'], safe: ['The content of the files does not change.'], label: 'Fix' })
                    && await act(() => HostAPI.permissions(ds.path))) followJob('Fixing the permissions');
                break;
            case 'user-add': {
                const u = val('sp-u-name').trim();
                const p = val('sp-u-pass');
                if (!u || !p) return showToast('Write a name and a password', 'warning');
                if (await act(() => HostAPI.shareUserSet(u, p), `${u} can now open the shares chosen for them`)) refresh();
                break;
            }
            case 'user-delete':
                if (await confirmDo({ title: `Remove ${ds.user}`, effects: [`${ds.user} cannot open the shares any more.`], safe: ['No file is deleted.'], label: 'Remove', danger: true })
                    && await act(() => HostAPI.shareUserDelete(ds.user), 'Removed')) refresh();
                break;
            case 'backup-edit': backupEdit(ds.name); break;
            case 'backup-run': if (await act(() => HostAPI.backupRun(ds.name))) followJob(`Backup ${ds.name}`); break;
            case 'backup-delete':
                if (await confirmDo({ title: `Delete the backup ${ds.name}`, effects: ['It does not run any more.'], safe: ['The copies already made stay on their disk.'], label: 'Delete', danger: true })
                    && await act(() => HostAPI.backupDelete(ds.name), 'Deleted')) refresh();
                break;
            case 'alert-save': alertSave(); break;
            case 'alert-test': {
                const level = val('sp-al-level');
                const words = level === 'info' ? 'A report is on its way: it should arrive in a moment.'
                    : 'A report was made. With “only problems” chosen, a healthy array sends nothing: choose “also a report after every run”, save, and test again to see one arrive.';
                await act(() => fetch(`${API.base()}/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => { if (!r.ok) throw new Error('The report could not be made'); }), words);
                break;
            }
            case 'system-save': systemSave(); break;
            case 'settings-download':
                try {
                    const doc = await HostAPI.settingsBackup();
                    delete doc.success;
                    download(`snapraidd-settings-${(doc.made || '').slice(0, 10)}.json`, JSON.stringify(doc, null, 2), 'application/json');
                } catch (er) { showToast(er.message, 'error'); }
                break;
            case 'diagnostics':
                try {
                    showToast('Collecting… it takes a few seconds', 'info');
                    const r = await HostAPI.diagnostics();
                    download(r.filename, r.text);
                } catch (er) { showToast(er.message, 'error'); }
                break;
        }
    });
};
