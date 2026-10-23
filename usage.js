// usage.js
// Recording how Rako staff use the tool, for the usage dashboard
// (dashboard.html) - but only while a Rako account is signed in through
// Sales (sales.js). Signed out, nothing is recorded: every listener below
// returns straight away, nothing is saved up for later, and whatever was on
// the drawing before signing in isn't counted either.
//
// Three Firestore collections in the rako-system-designer project (see
// firestore.rules - staff can only write their own records, and only the
// admins in usage-shared.js can read them):
//   toolPresence/{uid}           what each person is doing right now
//   toolUsage/{auto id}          a batch of their actions, for the activity feed
//   toolUsageDaily/{uid}_{day}   their running totals for the day
// Writes are batched: actions at most every couple of minutes, plus a
// heartbeat while the tool is open, so a day's use is a few hundred small
// writes per person.

import { FIREBASE, DOCS, API, toFields, summariseDrawing } from './register.js?v=1.55';
import { onStaffChange, onBeforeSignOut, staffName } from './sales.js?v=1.55';
import { getSchematicData } from './canvas.js?v=1.55';
import { displayName } from './drawings.js?v=1.55';
import { USAGE_EVENTS, USAGE_DAILY, PRESENCE, NOT_PARTS, dayKey, fieldSeg, describeAction } from './usage-shared.js?v=1.55';

const TOOL_VERSION = 'v1.55';
const TICK_MS = 15 * 1000;             // how often to look at what's going on
const FLUSH_MS = 2 * 60 * 1000;        // actions are sent at most this often
const PRESENCE_MIN_MS = 60 * 1000;     // "what they're doing" is updated at most this often
const BEAT_MS = 3 * 60 * 1000;         // "still here" at least this often while the tool is open
const SLOW_BEAT_MS = 10 * 60 * 1000;   // ...or this often, once they've been idle a long while
const IDLE_MS = 2 * 60 * 1000;         // no clicks or keys for this long: idle
const LONG_IDLE_MS = 30 * 60 * 1000;
const ACTIVE_WINDOW_MS = 60 * 1000;    // time counts as active when there was input this recently
const MERGE_MS = 60 * 1000;            // the same action again within this is one entry ("added 3 × RAK8")
const MAX_PENDING = 300;
const KEEP_EVENTS_MS = 365 * 24 * 60 * 60 * 1000;

let user = null;          // the signed-in Rako account (sales.js) - null means nothing is recorded
let token = null;         // its latest ID token, kept for the last write as the page closes
let session = null;       // { id, start }
let pending = [];         // actions not sent yet
let features = {};        // feature -> uses, not sent yet
let activeMs = 0;         // active time not sent yet
let lastTick = 0, lastInput = 0, lastFlush = 0, lastPresence = 0, lastPrint = 0;
let lastPresenceSig = '';
let lastAction = null;    // { text, at } - shown on the dashboard
let baseline = null;      // the drawing as last seen, to tell what changed
let mode = 'select';
let timer = null;
let sending = false;
let refused = false;      // the database turned us away: stop for this session
let printing = false;

/* ------------------------------------------------------------------
 * What's on the drawing, and what changed
 * ------------------------------------------------------------------ */

/** A part's name as the palette shows it ("WCM" rather than "KeypadWCM"). */
function paletteName(type) {
    const item = [...document.querySelectorAll('#palette .palette-item[data-type]')].find(el => el.dataset.type === type);
    const name = item && item.textContent.trim();
    return name || type;
}

function snapshot() {
    let data;
    try { data = getSchematicData(); } catch (e) { return null; }
    const s = summariseDrawing(data, paletteName);
    const pd = data.projectDetails || {};
    const i = Number(data.activePageIndex) || 0;
    return {
        name: displayName(pd.projectName), version: pd.version || '',
        tabs: s.tabs.length, tab: s.tabs[i] || '', tabIndex: i,
        items: s.items, cables: s.cables, components: s.components
    };
}

const MERGEABLE = new Set(['added', 'removed', 'cables', 'uncabled', 'tabAdded', 'tabRemoved']);

function record(a, extra = {}) {
    if (!user || refused || !session) return;
    const now = Date.now();
    const last = pending[pending.length - 1];
    if (last && last.a === a && now - last.at < MERGE_MS
        && ((MERGEABLE.has(a) && last.t === extra.t && last.d === extra.d) || a === 'renamed' || a === 'version')) {
        if (MERGEABLE.has(a)) last.n += extra.n;
        else Object.assign(last, extra, { from: last.from }); // typing a name: one entry, from the first name to the last
        last.at = now;
    } else {
        pending.push({ a, ...extra, at: now });
        if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
    }
    const e = pending[pending.length - 1];
    if (a !== 'start' && a !== 'end') {
        const text = describeAction(e);
        lastAction = { text: text[0].toUpperCase() + text.slice(1), at: now };
    }
}

function diff(before, now) {
    const d = now.name;
    new Set([...Object.keys(before.components), ...Object.keys(now.components)]).forEach(t => {
        const n = (now.components[t] || 0) - (before.components[t] || 0);
        if (n > 0) record('added', { t, n, d });
        else if (n < 0) record('removed', { t, n: -n, d });
    });
    const c = now.cables - before.cables;
    if (c > 0) record('cables', { n: c, d });
    else if (c < 0) record('uncabled', { n: -c, d });
    const tb = now.tabs - before.tabs;
    if (tb > 0) record('tabAdded', { n: tb, d });
    else if (tb < 0) record('tabRemoved', { n: -tb, d });
    if (before.name !== now.name) record('renamed', { from: before.name, d });
    if (before.version !== now.version) record('version', { v: now.version, d });
}

/* ------------------------------------------------------------------
 * What they're doing right now
 * ------------------------------------------------------------------ */

function currentMode() {
    if (document.querySelector('.canvas-text-box.editing')) return 'text';
    if (document.getElementById('drawing-canvas')?.classList.contains('draw-mode')) return 'draw';
    if (document.getElementById('drawing-canvas-wrapper')?.classList.contains('hand-mode')) return 'hand';
    return 'select';
}

const isOpen = (sel) => { const el = document.querySelector(sel); return !!(el && !el.hidden); };

function doingNow() {
    if (printing) return 'Printing';
    if (isOpen('#quickAdd')) return 'Adding a part';
    if (isOpen('#recentDrawings')) return 'Looking through recent drawings';
    if (isOpen('#retrieveDrawing')) return 'Retrieving a drawing';
    if (isOpen('#tourCallout')) return 'Taking the tour';
    if (isOpen('#appHelpModal')) return 'Reading the help';
    if (isOpen('#salesPanel')) return 'In the Sales panel';
    if (mode === 'drag') return 'Moving parts';
    if (mode === 'text') return 'Editing a label';
    if (mode === 'draw') return 'Drawing cables';
    if (mode === 'hand') return 'Moving around the drawing';
    const focus = document.activeElement;
    if (focus && focus.closest && focus.closest('#projectInfoForm')) return 'Filling in project details';
    if (focus && focus.id === 'paletteSearch') return 'Searching for a part';
    return 'Working on the drawing';
}

function currentState(now) {
    if (document.visibilityState === 'hidden') return { state: 'away', doing: 'In another tab or window' };
    if (now - lastInput > IDLE_MS) return { state: 'idle', doing: 'Idle' };
    return { state: 'active', doing: doingNow() };
}

const beatFor = (st, now) => (st.state !== 'active' && now - lastInput > LONG_IDLE_MS ? SLOW_BEAT_MS : BEAT_MS);

function environment() {
    const ua = navigator.userAgent;
    const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
    const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
        : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
    return { browser, os, screen: `${screen.width}×${screen.height}`, ver: TOOL_VERSION };
}

/* ------------------------------------------------------------------
 * Sending
 * ------------------------------------------------------------------ */

function autoId() {
    const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return [...crypto.getRandomValues(new Uint8Array(20))].map(b => abc[b % abc.length]).join('');
}

const who = () => ({ uid: user.uid, email: user.email, name: staffName(user) });

/** The day's running totals, added to rather than rewritten (so two windows can't undo each other). */
function dailyWrite(batch, feats, act, now) {
    const transforms = [];
    const inc = (path, n) => { if (n) transforms.push({ fieldPath: path, increment: { integerValue: String(n) } }); };
    const counts = {}, parts = {}, names = new Set();
    const add = (k, n = 1) => { counts[k] = (counts[k] || 0) + n; };
    batch.forEach(e => {
        switch (e.a) {
            case 'added':
                if (!NOT_PARTS.has(e.t)) { add('added', e.n); parts[e.t] = (parts[e.t] || 0) + e.n; }
                break;
            case 'removed': if (!NOT_PARTS.has(e.t)) add('removed', e.n); break;
            case 'cables': add('cables', e.n); break;
            case 'tabAdded': add('tabs', e.n); break;
            case 'opened': add('opened'); break;
            case 'printed': add('printed'); break;
            case 'savedFile': add('savedFile'); break;
            case 'issued': add('issued'); break;
            case 'withdrew': add('withdrew'); break;
        }
        // Drawings "worked on": changed, printed, saved or issued - not just opened.
        if (e.d && !['start', 'end', 'opened'].includes(e.a)) names.add(e.d);
    });
    inc('activeSec', act);
    inc('sessions', batch.filter(e => e.a === 'start').length);
    Object.entries(counts).forEach(([k, n]) => inc(`counts.${k}`, n));
    Object.entries(parts).forEach(([t, n]) => inc(`components.${fieldSeg(t)}`, n));
    Object.entries(feats).forEach(([k, n]) => inc(`features.${fieldSeg(k)}`, n));
    if (names.size) transforms.push({ fieldPath: 'drawings', appendMissingElements: { values: [...names].map(s => ({ stringValue: s })) } });
    transforms.push({ fieldPath: 'lastSeen', setToServerValue: 'REQUEST_TIME' });
    const day = dayKey(now);
    return {
        update: { name: `${DOCS}/${USAGE_DAILY}/${user.uid}_${day}`, fields: toFields({ ...who(), day }) },
        updateMask: { fieldPaths: ['uid', 'email', 'name', 'day'] },
        updateTransforms: transforms
    };
}

function presenceWrite(st, snap, beat) {
    return {
        update: {
            name: `${DOCS}/${PRESENCE}/${user.uid}`,
            fields: toFields({
                ...who(), session: session.id, since: session.start,
                state: st.state, doing: st.doing, beatSec: Math.round(beat / 1000),
                drawing: snap ? { name: snap.name, version: snap.version, tab: snap.tab, tabIndex: snap.tabIndex, tabs: snap.tabs, items: snap.items, cables: snap.cables } : null,
                lastAction, ...environment()
            })
        },
        updateTransforms: [{ fieldPath: 'lastSeen', setToServerValue: 'REQUEST_TIME' }]
    };
}

async function commit(writes, idToken, keepalive) {
    const body = JSON.stringify({ writes });
    let res;
    try {
        res = await fetch(`${API}${DOCS}:commit?key=${FIREBASE.apiKey}`, {
            method: 'POST',
            keepalive: keepalive && body.length < 60000, // a page that's closing may only send a little
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
            body
        });
    } catch (e) {
        return 'retry'; // offline: try again next time
    }
    if (res.ok) return 'ok';
    if (res.status === 403) return 'refused';
    if (res.status === 400) return 'bad';
    return 'retry';
}

/**
 * Send whatever is due: the batch of actions (at most every FLUSH_MS) and
 * what they're doing now (when it changed, or as a heartbeat). `force`
 * sends straight away; `keepalive` is for a page that's closing, and uses
 * the token already in hand because there's no time to fetch another.
 */
async function flush({ force = false, keepalive = false, state = null } = {}) {
    // One routine write at a time; a forced one (leaving, signing out) never waits behind it.
    if (!user || refused || !session || (sending && !keepalive && !force)) return;
    const now = Date.now();
    const st = state || currentState(now);
    const beat = beatFor(st, now);
    // Cheap to work out every tick: the drawing as autosave last saw it, and the tab showing.
    const b = baseline || {};
    const tabLabel = document.querySelector('#pageTabsBar .page-tab.active .page-tab-label');
    const sig = [st.state, st.doing, b.name, tabLabel ? tabLabel.textContent : b.tab, b.items, b.cables].join('|');
    const hasActions = pending.length > 0 || Object.keys(features).length > 0 || activeMs >= 1000;
    const sendActions = hasActions && (force || now - lastFlush >= FLUSH_MS);
    const sendPresence = force || sendActions || now - lastPresence >= beat - TICK_MS
        || (sig !== lastPresenceSig && now - lastPresence >= PRESENCE_MIN_MS);
    if (!sendActions && !sendPresence) return;
    const snap = snapshot() || baseline;

    const batch = sendActions ? pending.splice(0) : [];
    const feats = sendActions ? features : {};
    if (sendActions) features = {};
    const act = sendActions ? Math.floor(activeMs / 1000) : 0;
    activeMs -= act * 1000;

    const writes = [];
    if (batch.length) {
        const fields = toFields({ v: 2, ...who(), session: session.id, day: dayKey(now), events: batch,
            drawing: snap ? { name: snap.name, version: snap.version, tabs: snap.tabs, items: snap.items, cables: snap.cables } : null });
        // For an optional Firestore TTL policy: the feed's detail can go after a year (daily totals stay).
        fields.expireAt = { timestampValue: new Date(now + KEEP_EVENTS_MS).toISOString() };
        writes.push({
            update: { name: `${DOCS}/${USAGE_EVENTS}/${autoId()}`, fields },
            currentDocument: { exists: false },
            updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }]
        });
    }
    if (sendActions) writes.push(dailyWrite(batch, feats, act, now));
    writes.push(presenceWrite(st, snap, beat));

    let idToken = token;
    if (!keepalive) {
        sending = true;
        try { idToken = token = await user.getIdToken(); } catch (e) {}
    }
    if (!idToken) { sending = false; putBack(batch, feats, act); return; }
    const result = await commit(writes, idToken, keepalive);
    if (!keepalive) sending = false;
    if (result === 'ok') {
        if (sendActions) lastFlush = now;
        lastPresence = now;
        lastPresenceSig = sig;
    } else if (result === 'refused') {
        // Not allowed to write (the rules aren't published yet, or this
        // account isn't staff after all): stop for this session.
        refused = true;
        pending = []; features = {}; activeMs = 0;
        console.warn('Usage records were refused by the database; not recording this session.');
    } else if (result === 'retry') {
        putBack(batch, feats, act);
    } else {
        console.warn('Usage records were rejected as malformed; dropped one batch.');
    }
}

function putBack(batch, feats, act) {
    if (!user) return;
    pending = batch.concat(pending).slice(-MAX_PENDING);
    Object.entries(feats).forEach(([k, n]) => { features[k] = (features[k] || 0) + n; });
    activeMs += act * 1000;
}

/* ------------------------------------------------------------------
 * Starting and stopping with the sign-in
 * ------------------------------------------------------------------ */

function start(u) {
    stop();
    user = u;
    refused = false;
    const now = Date.now();
    session = { id: autoId(), start: now };
    pending = []; features = {}; activeMs = 0;
    lastTick = lastInput = now;
    lastFlush = lastPresence = 0;
    lastPresenceSig = '';
    lastAction = null;
    mode = currentMode();
    baseline = snapshot();
    user.getIdToken().then(t => { token = t; }).catch(() => {});
    record('start', environment());
    flush({ force: true });
    timer = setInterval(tick, TICK_MS);
}

/** Forget everything not yet sent and stop listening in. */
function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    user = null; token = null; session = null;
    pending = []; features = {}; activeMs = 0;
    baseline = null; lastAction = null;
}

function end(why, keepalive) {
    if (!user || !session) return Promise.resolve();
    accrue(true); // up to the moment it closed (it may already count as hidden)
    record('end', { why, sec: Math.round((Date.now() - session.start) / 1000) });
    const doing = why === 'signed-out' ? 'Signed out' : 'Closed the tool';
    return flush({ force: true, keepalive, state: { state: why === 'signed-out' ? 'signed-out' : 'closed', doing } });
}

/** Time since the last look counts as active when the tool is in front and was touched in the last minute. */
function accrue(wasVisible = document.visibilityState === 'visible') {
    const now = Date.now();
    if (wasVisible && now - lastInput < ACTIVE_WINDOW_MS) {
        activeMs += Math.min(now - lastTick, TICK_MS * 2);
    }
    lastTick = now;
}

function tick() {
    if (!user) return;
    accrue();
    flush();
}

function feature(key) {
    if (!user || refused) return;
    features[key] = (features[key] || 0) + 1;
}

export function setupUsage() {
    onStaffChange((u) => {
        if (u && (!user || user.uid !== u.uid)) start(u);
        else if (!u && user) stop();
    });
    onBeforeSignOut(async () => {
        await end('signed-out', false);
        stop();
    });

    // Leaving: one last write on the way out. Back again from the
    // browser's back/forward cache: a fresh session.
    window.addEventListener('pagehide', () => {
        if (!user) return;
        const u = user;
        end('closed', true);
        stop();
        user = null;
        window.__rakoUsageResume = u;
    });
    window.addEventListener('pageshow', (e) => {
        if (e.persisted && window.__rakoUsageResume && !user) start(window.__rakoUsageResume);
        window.__rakoUsageResume = null;
    });
    document.addEventListener('visibilitychange', () => {
        if (!user) return;
        // Into the background: say so (if it's been a minute), with keepalive in case the tab is discarded.
        if (document.visibilityState === 'hidden') { accrue(true); flush({ keepalive: true }); }
        else { lastTick = lastInput = Date.now(); flush(); }
    });

    // Being there: any click, key or scroll.
    const touched = () => { if (user) lastInput = Date.now(); };
    ['pointerdown', 'keydown', 'wheel'].forEach(t => window.addEventListener(t, touched, { capture: true, passive: true }));

    // The drawing changed (autosave noticed): count what was added or taken away.
    document.addEventListener('schematic:content', () => {
        if (!user) return;
        const snap = snapshot();
        if (!snap) return;
        if (baseline) diff(baseline, snap);
        baseline = snap;
    });
    // A different drawing is open: counting starts afresh from it.
    document.addEventListener('schematic:opened', (e) => {
        if (!user) return;
        const snap = snapshot();
        const how = (e.detail && e.detail.how) || 'recent';
        record('opened', { how, d: snap ? snap.name : '' });
        baseline = snap;
    });
    document.addEventListener('schematic:issued', (e) => record('issued', { code: e.detail && e.detail.code, d: baseline ? baseline.name : '' }));
    document.addEventListener('schematic:withdrawn', (e) => record('withdrew', { code: e.detail && e.detail.code, d: baseline ? baseline.name : '' }));

    window.addEventListener('beforeprint', () => {
        if (!user) return;
        printing = true;
        if (Date.now() - lastPrint < 3000) return;
        lastPrint = Date.now();
        const snap = snapshot() || baseline;
        record('printed', { d: snap ? snap.name : '', n: snap ? snap.tabs : 1 });
    });
    window.addEventListener('afterprint', () => { printing = false; });

    // Modes: entering Draw Line or the hand tool, by button or key.
    const onMode = () => {
        const next = currentMode();
        if (next !== mode && next === 'draw') feature('drawLine');
        if (next !== mode && next === 'hand') feature('hand');
        mode = next;
    };
    document.addEventListener('schematic:mode', onMode);
    document.addEventListener('schematic:drag', (e) => { mode = e.detail && e.detail.active ? 'drag' : currentMode(); });

    // Buttons.
    const CLICKS = [
        ['#undoBtn', 'undo'], ['#redoBtn', 'redo'],
        ['#zoomInBtn, #zoomOutBtn, #zoomResetBtn, #zoomFitBtn', 'zoom'],
        ['.connector-color-option', 'cableColour'], ['#customConnectorOption', 'customColour'],
        ['#addTextBtn', 'label'], ['#recentBtn, #statusSave', 'recent'], ['#loadFromFileBtn', 'loadFile'],
        ['#retrieveBtn', 'retrieve'], ['#helpBtn', 'help'], ['#tourBtn', 'tour']
    ];
    document.addEventListener('click', (e) => {
        if (!user || !e.target.closest) return;
        if (e.target.closest('#saveToFileBtn')) {
            const snap = snapshot() || baseline;
            record('savedFile', { d: snap ? snap.name : '' });
            return;
        }
        const hit = CLICKS.find(([sel]) => e.target.closest(sel));
        if (hit && !e.target.closest('[disabled]')) feature(hit[1]);
    }, true);

    // Shortcuts.
    let lastWheelZoom = 0;
    window.addEventListener('keydown', (e) => {
        if (!user) return;
        const typing = e.target && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
        const k = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && !typing) {
            if (k === 'z' && !e.shiftKey) feature('undo');
            else if (k === 'y' || (k === 'z' && e.shiftKey)) feature('redo');
            return;
        }
        if (!typing && !e.altKey && ['+', '=', '-', '0'].includes(e.key)) feature('zoom');
    }, true);
    window.addEventListener('wheel', (e) => {
        if (!user || !(e.ctrlKey || e.metaKey)) return;
        if (Date.now() - lastWheelZoom > 1500) feature('zoom');
        lastWheelZoom = Date.now();
    }, { capture: true, passive: true });

    // Typing in the search box or project details: once per visit to the box.
    const once = { search: false, details: false };
    document.addEventListener('input', (e) => {
        if (!user || !e.target) return;
        if (e.target.id === 'paletteSearch' && !once.search) { once.search = true; feature('search'); }
        if (e.target.closest && e.target.closest('#projectInfoForm') && !once.details) { once.details = true; feature('details'); }
    }, true);
    document.addEventListener('focusout', (e) => {
        if (e.target && e.target.id === 'paletteSearch') once.search = false;
        if (e.target && e.target.closest && e.target.closest('#projectInfoForm')) once.details = false;
    }, true);

    // The / quick-add popup opening.
    const qa = document.getElementById('quickAdd');
    if (qa) {
        new MutationObserver(() => { if (!qa.hidden) feature('quickAdd'); })
            .observe(qa, { attributes: true, attributeFilter: ['hidden'] });
    }
}
