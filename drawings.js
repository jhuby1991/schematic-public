// drawings.js
// "Recent drawings": every drawing is kept in this browser as it is worked
// on, each under its own id. Starting a new drawing, opening a file or
// working in a second window adds an entry - it never overwrites another
// one - and nothing expires. Only the oldest are let go, once there are
// more than MAX_DRAWINGS (or the browser's storage is full).
//
// Up to v1.41 there was a single autosave slot: it was replaced as soon as
// new work started (even if the offer to restore it was never answered),
// and anything over an hour old was deleted unseen on the next visit.

const DATA_PREFIX = 'rakoDrawing:';
export const META_PREFIX = 'rakoDrawingMeta:';
export const LEGACY_KEY = 'schematicAutoSave'; // the old single slot, moved across on first open
export const MAX_DRAWINGS = 20;
const DEFAULT_NAME = 'Schematic'; // what the Name box starts with

export function newDrawingId() {
    return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function pagesOf(data) {
    if (Array.isArray(data.pages)) return data.pages;
    return [data]; // a file from before tabs: everything at the top level
}

/* A tab that hasn't been looked at yet is stored exactly as it was opened;
   the first time it's drawn the app fills in its defaults (no rotation, a
   blank Term/Star label, ...) and writes it back in its own shape. Neither
   is a change, so the comparison below ignores field order, empty and
   default values, and ids. Otherwise just clicking through the tabs of a
   file you'd opened would count as editing it. */
const NUMERIC = new Set(['x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'fontSize', 'size', 'rotation']);
// Output labels a component gets when nobody has typed any (canvas.js).
const DEFAULT_LABELS = [
    Array.from({ length: 8 }, (_, i) => `Circuit ${i + 1}`), // RAK8, DIN8S
    Array.from({ length: 4 }, (_, i) => `Circuit ${i + 1}`), // DIN4C, DIN4T
    ['Up to 64 DALI Ballasts']                                // DINDLI
].map(a => JSON.stringify(a));
function isEmptyValue(key, v) {
    if (v === null || v === undefined || v === '') return true;
    if (Array.isArray(v)) return !v.length || (key === 'labels' && DEFAULT_LABELS.includes(JSON.stringify(v)));
    if (key === 'rotation') return !Number(v);
    if (key === 'termStarState') return v === 'blank';
    return false;
}
function canonical(obj, { skip = [] } = {}) {
    const out = {};
    Object.keys(obj || {}).sort().forEach(k => {
        if (skip.includes(k)) return;
        let v = obj[k];
        if (isEmptyValue(k, v)) return;
        if (NUMERIC.has(k) && typeof v === 'string' && v.trim() !== '' && !isNaN(v)) v = Number(v);
        if (k === 'imgSrc' && typeof v === 'string') {
            try { v = new URL(v, document.baseURI).href; } catch (e) {}
        }
        out[k] = v;
    });
    return out;
}
const canonicalItem = (item) => canonical(item, { skip: item && item.html !== undefined ? ['id', 'text'] : ['id'] });
const canonicalLine = (c) => [Number(c.x1), Number(c.y1), Number(c.x2), Number(c.y2), c.color || 'black', c.type === 'dashed' ? 'dashed' : 'colour'];

/** What the drawing contains, as a string - which tab happens to be showing doesn't count. */
export function contentKey(data) {
    return JSON.stringify([
        canonical(data.projectDetails),
        pagesOf(data).map(p => [
            p.name || '',
            (p.items || []).map(canonicalItem),
            (p.connections || []).map(canonicalLine),
            (p.gridLines || []).map(g => canonical(g)),
            (p.rectangles || []).map(r => canonical(r))
        ]),
        data.issue && data.issue.code ? data.issue.code : null // issuing it is a change worth saving
    ]);
}

/** Nothing worth keeping: nothing drawn on any tab, and only the default project details. */
export function isBlank(data) {
    if (!data) return true;
    const d = data.projectDetails || {};
    const drawn = pagesOf(data).some(p => ['items', 'connections', 'gridLines', 'rectangles'].some(k => Array.isArray(p[k]) && p[k].length));
    const name = (d.projectName || '').trim();
    return !drawn && (!name || name === DEFAULT_NAME) && !(d.salesperson || '').trim() && !(d.quoteReference || '').trim();
}

export function displayName(projectName) {
    const name = (projectName || '').trim();
    // The name as it appears in the Name box. The starting name, "Schematic",
    // used to be listed as "Untitled drawing", so Recent didn't match what
    // was on screen.
    return name || 'Untitled drawing';
}

function summarise(id, data) {
    const pages = pagesOf(data);
    return {
        id,
        name: displayName(data.projectDetails && data.projectDetails.projectName),
        version: (data.projectDetails && data.projectDetails.version) || '',
        tabs: pages.map((p, i) => p.name || `Tab ${i + 1}`),
        items: pages.reduce((n, p) => n + (Array.isArray(p.items) ? p.items.length : 0), 0)
    };
}

/** Every kept drawing's summary, most recently edited first. */
export function listDrawings() {
    const out = [];
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith(META_PREFIX)) continue;
            try {
                const meta = JSON.parse(localStorage.getItem(key));
                if (meta && meta.id && localStorage.getItem(DATA_PREFIX + meta.id) !== null) out.push(meta);
            } catch (e) { /* a damaged entry is skipped, not fatal */ }
        }
    } catch (e) { /* storage blocked */ }
    return out.sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

export function hasDrawings() {
    try {
        if (localStorage.getItem(LEGACY_KEY)) return true;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(META_PREFIX)) return true;
        }
    } catch (e) {}
    return false;
}

export function readDrawing(id) {
    try {
        const raw = localStorage.getItem(DATA_PREFIX + id);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

export function deleteDrawing(id) {
    try {
        localStorage.removeItem(DATA_PREFIX + id);
        localStorage.removeItem(META_PREFIX + id);
    } catch (e) {}
}

/** Let the oldest go (never `keepId`); false when there's nothing left to let go. */
function dropOldest(keepId) {
    const oldest = listDrawings().filter(m => m.id !== keepId).pop();
    if (!oldest) return false;
    deleteDrawing(oldest.id);
    return true;
}

/**
 * Store a drawing under `id`. When storage is full the oldest drawings make
 * room. Returns false only if it can't be stored at all (a private window,
 * storage switched off, or one drawing bigger than the whole allowance).
 */
export function writeDrawing(id, data, extra = {}, updated = Date.now()) {
    const json = JSON.stringify(data);
    const meta = JSON.stringify({ ...summarise(id, data), ...extra, updated });
    for (let attempt = 0; attempt <= MAX_DRAWINGS; attempt++) {
        try {
            localStorage.setItem(DATA_PREFIX + id, json);
            localStorage.setItem(META_PREFIX + id, meta);
            const all = listDrawings();
            all.filter(m => m.id !== id).slice(MAX_DRAWINGS - 1).forEach(m => deleteDrawing(m.id));
            return true;
        } catch (e) {
            if (!dropOldest(id)) return false;
        }
    }
    return false;
}

/** A kept drawing with exactly this content, if there is one. */
export function findDrawingByContent(key) {
    return listDrawings().find(m => {
        const data = readDrawing(m.id);
        return data && contentKey(data) === key;
    }) || null;
}

/** Bring the old single autosave slot (up to v1.41) into Recent drawings, keeping its time. */
export function migrateLegacy() {
    let raw = null;
    try { raw = localStorage.getItem(LEGACY_KEY); } catch (e) { return; }
    if (!raw) return;
    let keep = true;
    try {
        const saved = JSON.parse(raw);
        if (saved && saved.data && !isBlank(saved.data) && !findDrawingByContent(contentKey(saved.data))) {
            keep = !writeDrawing(newDrawingId(), saved.data, { savedToFile: false }, saved.timestamp || Date.now());
        } else {
            keep = false;
        }
    } catch (e) {
        keep = false; // unreadable: nothing to rescue
    }
    if (!keep) {
        try { localStorage.removeItem(LEGACY_KEY); } catch (e) {}
    }
}

/** "just now", "12 minutes ago", "today at 14:05", "yesterday at 09:30", "Monday at 16:40", "3 Oct". */
export function friendlyTime(ts, now = new Date()) {
    const when = new Date(ts);
    const minutes = Math.floor((now - when) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOf(now) - startOf(when)) / 86400000);
    if (days === 0) return `today at ${time}`;
    if (days === 1) return `yesterday at ${time}`;
    if (days > 1 && days < 7) return `${when.toLocaleDateString([], { weekday: 'long' })} at ${time}`;
    return when.toLocaleDateString([], when.getFullYear() === now.getFullYear()
        ? { day: 'numeric', month: 'short' }
        : { day: 'numeric', month: 'short', year: 'numeric' });
}

/* ------------------------------------------------------------------
 * The Recent drawings window
 * ------------------------------------------------------------------ */

/**
 * List every kept drawing. `onOpen(id)` and `onNew()` do the opening;
 * the drawing that's open now can't be deleted from here (its next
 * autosave would only bring it straight back).
 */
export function openRecentDialog({ currentId = null, onOpen, onNew } = {}) {
    document.getElementById('recentDrawings')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'recentDrawings';
    overlay.className = 'rd-overlay';
    overlay.innerHTML = `
        <div class="rd-box" role="dialog" aria-modal="true" aria-labelledby="rdTitle">
            <div class="rd-head">
                <div>
                    <h3 id="rdTitle">Recent drawings</h3>
                    <p>Kept automatically in this browser. Save File makes a copy you can email or open on another computer.</p>
                </div>
                <button type="button" class="rd-close" aria-label="Close"><i class="bi bi-x-lg"></i></button>
            </div>
            <ul class="rd-list"></ul>
            <div class="rd-foot">
                <span class="rd-count"></span>
                <button type="button" class="btn btn-sm btn-outline-secondary rd-new"><i class="bi bi-plus-lg"></i> New drawing</button>
            </div>
        </div>`;
    const list = overlay.querySelector('.rd-list');
    const count = overlay.querySelector('.rd-count');
    const previous = document.activeElement;

    function close() {
        overlay.classList.remove('rd-in');
        document.removeEventListener('keydown', onKey, true);
        setTimeout(() => overlay.remove(), 160);
        if (previous && previous.focus) previous.focus();
    }
    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    }

    function render() {
        const drawings = listDrawings();
        list.innerHTML = '';
        if (!drawings.length) {
            list.innerHTML = '<li class="rd-empty">Nothing yet. Drawings appear here as soon as you start one.</li>';
        }
        drawings.forEach(meta => {
            const isCurrent = meta.id === currentId;
            const li = document.createElement('li');
            li.className = 'rd-row' + (isCurrent ? ' rd-current' : '');
            const tabs = (meta.tabs || []).length > 1 ? `${meta.tabs.length} tabs` : (meta.tabs && meta.tabs[0]) || '';
            const bits = [`Edited ${friendlyTime(meta.updated)}`, tabs, `${meta.items} item${meta.items === 1 ? '' : 's'}`].filter(Boolean);
            li.innerHTML = `
                <button type="button" class="rd-main">
                    <span class="rd-name"><span class="rd-title"></span><span class="rd-ver"></span></span>
                    <span class="rd-meta"></span>
                </button>
                <span class="rd-state"></span>
                ${isCurrent ? '' : '<button type="button" class="rd-del"><i class="bi bi-trash3"></i></button>'}`;
            li.querySelector('.rd-title').textContent = meta.name;
            // The version only when it says something (every drawing starts at 1.0)
            if (meta.version && meta.version !== '1.0') li.querySelector('.rd-ver').textContent = `v${meta.version}`;
            li.querySelector('.rd-meta').textContent = bits.join(' · ');
            const state = li.querySelector('.rd-state');
            if (isCurrent) state.innerHTML = '<span class="rd-badge">Open now</span>';
            else if (meta.savedToFile) state.innerHTML = '<span class="rd-file"><i class="bi bi-check2"></i> Saved to file</span>';
            const main = li.querySelector('.rd-main');
            if (isCurrent) {
                main.disabled = true;
            } else {
                main.setAttribute('aria-label', `Open ${meta.name}`);
                main.addEventListener('click', () => { close(); onOpen && onOpen(meta.id); });
            }
            const del = li.querySelector('.rd-del');
            if (del) {
                del.setAttribute('aria-label', `Delete ${meta.name}`);
                del.title = 'Delete';
                del.addEventListener('click', () => {
                    // Deleted straight away, with a few seconds to take it back.
                    const data = readDrawing(meta.id);
                    deleteDrawing(meta.id);
                    li.className = 'rd-row rd-deleted';
                    li.innerHTML = '<span class="rd-gone"></span><button type="button" class="btn btn-sm btn-link rd-undo">Undo</button>';
                    li.querySelector('.rd-gone').textContent = `Deleted “${meta.name}”`;
                    const timer = setTimeout(() => { if (li.isConnected) render(); }, 6000);
                    li.querySelector('.rd-undo').addEventListener('click', () => {
                        clearTimeout(timer);
                        if (data) writeDrawing(meta.id, data, { savedToFile: !!meta.savedToFile }, meta.updated);
                        render();
                    });
                    updateCount();
                });
            }
            list.appendChild(li);
        });
        updateCount();
    }
    function updateCount() {
        const n = listDrawings().length;
        count.textContent = n ? `${n} of ${MAX_DRAWINGS} kept; the oldest make way for new ones` : '';
    }

    overlay.querySelector('.rd-close').addEventListener('click', close);
    overlay.querySelector('.rd-new').addEventListener('click', () => { close(); onNew && onNew(); });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);
    render();
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('rd-in'));
    const first = overlay.querySelector('.rd-main:not(:disabled)') || overlay.querySelector('.rd-new');
    if (first) first.focus();
    return { close };
}
