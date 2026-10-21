// dashboard.js
// The usage dashboard (dashboard.html): who is signed in to the tool right
// now and what they're doing, and how the tool has been used over the last
// 7, 30 or 90 days. It reads what usage.js records - only ever for Rako
// staff while they're signed in - and only the admins in usage-shared.js
// can open it (firestore.rules enforces that; this page just explains it).
//
// dashboard.html?demo shows made-up sample data, to see the layout before
// any real usage has been recorded.

import { FIREBASE, EMULATOR, DOCS, API, STAFF_DOMAIN, fromFields } from './register.js?v=1.54';
import {
    USAGE_ADMINS, USAGE_EVENTS, USAGE_DAILY, PRESENCE, PRESENCE_GRACE_MS, FEATURES, NOT_PARTS, EDITS,
    dayKey, describeAction, formatDuration
} from './usage-shared.js?v=1.54';
import { redirectIfOldAddress } from './moved.js?v=1.54';

redirectIfOldAddress(); // the old GitHub Pages address: on to the new one

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const REFRESH_MS = 30 * 1000;       // who's signed in now
const FEED_LIMIT = 300;             // most recent batches of actions loaded for the feed
const FEED_PAGE = 40;
const RANGE_KEY = 'rakoUsageRange';
const DEMO = new URLSearchParams(location.search).has('demo');

const state = {
    range: readRange(),
    user: null,
    presence: [],
    daily: new Map(),     // id -> { uid, email, name, day, activeSec, sessions, counts, components, features, drawings, lastSeen }
    eventDocs: new Map(), // id -> raw batch
    rows: [],             // the feed: one row per action, newest first
    sort: { key: 'activeSec', dir: 'desc' },
    pick: null,           // uid the feed is narrowed to
    feedShown: FEED_PAGE,
    tableOpen: false,
    updatedAt: 0,
    loaded: false,
    failing: false
};

let fb = null;
let timer = null;
let tick = 0;

/* ------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);

/** Build an element. Text always goes in as text, never as HTML - names and drawing names are typed by people. */
function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
    });
    kids.flat(Infinity).forEach(c => {
        if (c == null || c === false) return;
        el.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return el;
}
/** replaceChildren that skips the nulls left by optional pieces. */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k != null && k !== false));
const icon = (name) => h('i', { class: `bi bi-${name}`, 'aria-hidden': 'true' });
function s(tag, attrs = {}) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
    return el;
}

function readRange() {
    try {
        const r = Number(localStorage.getItem(RANGE_KEY));
        return [7, 30, 90].includes(r) ? r : 7;
    } catch (e) { return 7; }
}

const isStaff = (u) => !!(u && u.emailVerified && (u.email || '').toLowerCase().endsWith('@' + STAFF_DOMAIN));
const isAdmin = (u) => !!(u && USAGE_ADMINS.includes((u.email || '').toLowerCase()));

/** "sam.patel@rakocontrols.com" -> "Sam Patel" when there's no name on record. */
function nameFromEmail(email) {
    return (email || '').split('@')[0].split(/[._-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || 'Someone';
}
const personName = (r) => (r && r.name && String(r.name).trim()) || nameFromEmail(r && r.email);
const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
const avatar = (name, cls = '') => h('span', { class: `avatar ${cls}`.trim(), 'aria-hidden': 'true', text: initials(name) });

const ms = (v) => (typeof v === 'number' ? v : Date.parse(v) || 0);
const timeOf = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

function ago(t, now = Date.now()) {
    const sec = Math.max(0, (now - t) / 1000);
    if (sec < 45) return 'just now';
    if (sec < 90) return '1 min ago';
    if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
    if (sameDay(t, now)) return `at ${timeOf(t)}`;
    if (sameDay(t, now - 86400000)) return `yesterday at ${timeOf(t)}`;
    return new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** The last `n` calendar days as YYYY-MM-DD, oldest first, ending `endOffset` days ago. */
function dayList(n, endOffset = 0) {
    const now = new Date();
    return Array.from({ length: n }, (_, i) => dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - endOffset - (n - 1 - i), 12)));
}
function dayLabel(day, style = 'short') {
    const [y, m, d] = day.split('-').map(Number);
    const date = new Date(y, m - 1, d, 12);
    const today = dayKey();
    if (style === 'feed') {
        if (day === today) return 'Today';
        if (day === dayList(1, 1)[0]) return 'Yesterday';
        return date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    }
    if (style === 'long') return date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function weekdayLabel(day) {
    const [y, m, d] = day.split('-').map(Number);
    return `${new Date(y, m - 1, d, 12).toLocaleDateString([], { weekday: 'short' })} ${d}`;
}

const hours = (sec) => {
    const h = sec / 3600;
    return h === 0 ? '0' : h < 10 ? h.toFixed(1) : String(Math.round(h));
};
const compact = (n) => (n >= 10000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------------
 * Reading the records (Firestore REST, like register.js)
 * ------------------------------------------------------------------ */

class ReadError extends Error {
    constructor(kind) { super(kind); this.kind = kind; }
}

async function authedFetch(url, init = {}) {
    let token;
    try { token = await state.user.getIdToken(); } catch (e) { throw new ReadError('offline'); }
    let res;
    try {
        res = await fetch(url, { ...init, cache: 'no-store', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
    } catch (e) {
        throw new ReadError('offline');
    }
    if (res.status === 403) throw new ReadError('refused');
    if (!res.ok) throw new ReadError('error');
    return res.json();
}

async function runQuery(structuredQuery) {
    const rows = await authedFetch(`${API}${DOCS}:runQuery?key=${FIREBASE.apiKey}`, { method: 'POST', body: JSON.stringify({ structuredQuery }) });
    return (Array.isArray(rows) ? rows : []).filter(r => r.document).map(r => ({ id: r.document.name.split('/').pop(), ...fromFields(r.document.fields) }));
}

async function listCollection(collection) {
    const out = [];
    let page = '';
    do {
        const j = await authedFetch(`${API}${DOCS}/${collection}?pageSize=300&key=${FIREBASE.apiKey}${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
        (j.documents || []).forEach(d => out.push({ id: d.name.split('/').pop(), ...fromFields(d.fields) }));
        page = j.nextPageToken || '';
    } while (page);
    return out;
}

const dailyQuery = (op, day) => ({
    from: [{ collectionId: USAGE_DAILY }],
    where: { fieldFilter: { field: { fieldPath: 'day' }, op, value: { stringValue: day } } },
    limit: 10000
});
const eventsQuery = (sinceIso, limit) => ({
    from: [{ collectionId: USAGE_EVENTS }],
    where: { fieldFilter: { field: { fieldPath: 'ts' }, op: 'GREATER_THAN', value: { timestampValue: sinceIso } } },
    orderBy: [{ field: { fieldPath: 'ts' }, direction: 'DESCENDING' }],
    limit
});

const source = {
    presence: () => (DEMO ? demo().presence : listCollection(PRESENCE)),
    // This period and the one before it, for the comparisons.
    daily: (fromDay) => (DEMO ? demo().daily.filter(d => d.day >= fromDay) : runQuery(dailyQuery('GREATER_THAN_OR_EQUAL', fromDay))),
    today: () => (DEMO ? demo().daily.filter(d => d.day === dayKey()) : runQuery(dailyQuery('EQUAL', dayKey()))),
    events: (sinceIso, limit) => (DEMO ? demo().events.filter(e => ms(e.ts) > ms(sinceIso)).slice(0, limit) : runQuery(eventsQuery(sinceIso, limit)))
};

/** A batch of actions as feed rows. Older single-action records (the private tool's) become one row each. */
function rowsOf(doc) {
    const base = { uid: doc.uid, name: personName(doc), email: doc.email, drawing: doc.drawing };
    const ts = ms(doc.ts);
    if (Array.isArray(doc.events)) {
        return doc.events.map((e, i) => ({ ...base, at: Number(e.at) || ts, e, key: `${doc.id}:${i}` }));
    }
    if (doc.action) return [{ ...base, at: ts, e: { a: doc.action }, key: doc.id }];
    return [];
}
function rebuildRows() {
    state.rows = [...state.eventDocs.values()].flatMap(rowsOf).sort((a, b) => b.at - a.at);
}
const newestEventTs = () => [...state.eventDocs.values()].reduce((m, d) => (ms(d.ts) > ms(m) ? d.ts : m), null);

async function loadAll() {
    document.body.classList.add('loading');
    spinRefresh(true);
    const days = state.range;
    const fromDay = dayList(days * 2)[0];
    const since = new Date(dayList(days)[0] + 'T00:00:00').toISOString();
    try {
        const [presence, daily, events] = await Promise.all([source.presence(), source.daily(fromDay), source.events(since, FEED_LIMIT)]);
        state.presence = presence;
        state.daily = new Map(daily.map(d => [d.id, d]));
        state.eventDocs = new Map(events.map(d => [d.id, d]));
        rebuildRows();
        state.loaded = true;
        state.failing = false;
        state.updatedAt = Date.now();
        renderAll();
    } catch (e) {
        handleReadError(e);
    } finally {
        document.body.classList.remove('loading');
        spinRefresh(false);
    }
}

/** Every 30 s: who's signed in. Every minute: new actions and today's totals. */
async function refresh() {
    if (!state.loaded || document.visibilityState === 'hidden') return;
    tick++;
    try {
        const full = tick % 2 === 0;
        const [presence, today, events] = await Promise.all([
            source.presence(),
            full ? source.today() : null,
            full ? source.events(newestEventTs() || new Date(dayList(state.range)[0] + 'T00:00:00').toISOString(), 100) : null
        ]);
        state.presence = presence;
        if (today) today.forEach(d => state.daily.set(d.id, d));
        if (events && events.length) {
            events.forEach(d => state.eventDocs.set(d.id, d));
            rebuildRows();
        }
        state.failing = false;
        state.updatedAt = Date.now();
        if (full) renderAll();
        else { renderNow(); renderPeople(); renderStatus(); }
    } catch (e) {
        handleReadError(e);
    }
}

function handleReadError(e) {
    const kind = e && e.kind;
    if (kind === 'refused') { showGate('refused'); return; }
    state.failing = true;
    if (!state.loaded) showGate('offline');
    else renderStatus();
}

function startRefreshing() {
    clearInterval(timer);
    timer = setInterval(refresh, REFRESH_MS);
}
document.addEventListener('visibilitychange', () => {
    renderStatus();
    if (document.visibilityState === 'visible' && state.loaded) { tick = 1; refresh(); }
});

/* ------------------------------------------------------------------
 * Working the numbers out
 * ------------------------------------------------------------------ */

function sumInto(target, src) {
    Object.entries(src || {}).forEach(([k, v]) => { target[k] = (target[k] || 0) + (Number(v) || 0); });
}

function summarise(days) {
    const inRange = new Set(days);
    const byDay = new Map(days.map(d => [d, { activeSec: 0, sessions: 0, people: new Set() }]));
    const people = new Map();
    const tot = { activeSec: 0, sessions: 0, counts: {}, components: {}, features: {}, drawings: new Set(), people: new Set(), records: 0 };
    state.daily.forEach(d => {
        if (!inRange.has(d.day)) return;
        tot.records++;
        const sec = Number(d.activeSec) || 0, ses = Number(d.sessions) || 0;
        const day = byDay.get(d.day);
        day.activeSec += sec; day.sessions += ses; day.people.add(d.uid);
        tot.activeSec += sec; tot.sessions += ses; tot.people.add(d.uid);
        sumInto(tot.counts, d.counts);
        sumInto(tot.components, d.components);
        sumInto(tot.features, d.features);
        (d.drawings || []).forEach(n => tot.drawings.add(n));
        let p = people.get(d.uid);
        if (!p) people.set(d.uid, p = { uid: d.uid, name: personName(d), email: d.email, activeSec: 0, sessions: 0, counts: {}, drawings: new Set(), lastSeen: 0 });
        p.activeSec += sec; p.sessions += ses;
        sumInto(p.counts, d.counts);
        (d.drawings || []).forEach(n => p.drawings.add(n));
        p.lastSeen = Math.max(p.lastSeen, ms(d.lastSeen));
        if (d.name) p.name = personName(d);
    });
    return { byDay, people, tot };
}

function presenceOf(uid) { return state.presence.find(p => p.uid === uid || p.id === uid); }

function isOnline(p, now = Date.now()) {
    if (!p || !['active', 'idle', 'away'].includes(p.state)) return false;
    const beat = (Number(p.beatSec) || 180) * 1000;
    return now - ms(p.lastSeen) < beat + PRESENCE_GRACE_MS;
}

/* ------------------------------------------------------------------
 * Page layout
 * ------------------------------------------------------------------ */

function panel(id, title, extra = {}) {
    return h('section', { class: `panel ${extra.class || ''}`.trim(), id, 'aria-labelledby': `${id}-h` },
        h('header', { class: 'panel-head' },
            extra.lead || null,
            h('h2', { id: `${id}-h`, text: title }),
            h('span', { class: 'sub', 'data-sub': '' }),
            h('div', { class: 'end', 'data-end': '' })),
        h('div', { class: extra.bodyClass ?? 'panel-body', 'data-body': '' }));
}
const bodyOf = (id) => $(`#${id} [data-body]`);
const subOf = (id) => $(`#${id} [data-sub]`);
const endOf = (id) => $(`#${id} [data-end]`);

function buildLayout() {
    const main = $('#main');
    fill(main, [
        DEMO ? h('div', { class: 'sample-banner', role: 'note' }, icon('info-circle'),
            h('span', {}, h('b', { text: 'Sample data. ' }), 'Nothing on this page is real - it shows what the dashboard looks like once Rako staff have used the tool while signed in.')) : null,
        panel('secNow', 'Signed in now', { lead: h('span', { class: 'live-dot', 'aria-hidden': 'true' }) }),
        h('div', { class: 'grid' }, h('section', { class: 'panel kpis', id: 'secKpis', 'aria-label': 'Totals for the period' })),
        h('div', { class: 'grid two' }, panel('secTime', 'Time in the tool'), panel('secFeatures', 'Features used')),
        h('div', { class: 'grid two even' }, panel('secPeople', 'People', { bodyClass: 'table-wrap' }), panel('secParts', 'Parts placed')),
        panel('secFeed', 'Recent activity', { bodyClass: '' })
    ].filter(Boolean));
    $('#toolbarControls').hidden = false;
    syncRangeButtons();
}

function renderAll() {
    if (!$('#secNow')) buildLayout();
    renderNow();
    renderKpis();
    renderTime();
    renderFeatures();
    renderPeople();
    renderParts();
    renderFeed();
    renderStatus();
}

/* ---- Signed in now ---- */

const DOING_ICONS = [
    [/^Drawing cables/, 'pencil'], [/^Printing/, 'printer'], [/^Adding a part/, 'plus-square'], [/^Editing a label/, 'fonts'],
    [/^Moving parts/, 'arrows-move'], [/^Moving around/, 'arrows-move'], [/help/, 'question-circle'], [/tour/, 'signpost-split'],
    [/recent drawings/, 'clock-history'], [/^Retrieving/, 'qr-code'], [/Sales/, 'person-badge'], [/project details/, 'file-earmark-text'],
    [/^Searching/, 'search'], [/^Idle/, 'cup-hot'], [/another tab/, 'window-stack']
];
const doingIcon = (text) => (DOING_ICONS.find(([re]) => re.test(text || '')) || [null, 'diagram-3'])[1];
const STATE_LABEL = { active: 'Active', idle: 'Idle', away: 'Away' };

function personCard(p, now) {
    const name = personName(p);
    const d = p.drawing || null;
    const facts = [];
    if (d) {
        facts.push(['Drawing', h('span', {}, `“${d.name || 'Untitled drawing'}”`, d.version ? h('small', { text: `  v${d.version}` }) : null)]);
        if (d.tabs > 1 || (d.tab && d.tab !== 'Tab 1')) facts.push(['Tab', `${d.tab || 'Tab'} (${(Number(d.tabIndex) || 0) + 1} of ${d.tabs})`]);
        facts.push(['On it', `${plural(Number(d.items) || 0, 'item')} · ${plural(Number(d.cables) || 0, 'cable')}`]);
    }
    if (p.lastAction && p.lastAction.text) facts.push(['Last action', h('span', { title: p.lastAction.text }, p.lastAction.text, h('small', { text: ` · ${ago(ms(p.lastAction.at), now)}` }))]);
    const since = ms(p.since);
    facts.push(['Session', h('span', {}, since ? formatDuration((now - since) / 1000) : '-',
        h('small', { text: [p.browser, p.os].filter(Boolean).length ? ` · ${[p.browser, p.os].filter(Boolean).join(' on ')}` : '' }))]);
    return h('article', { class: `person${p.state === 'active' ? ' is-active' : ''}` },
        h('div', { class: 'person-top' },
            avatar(name),
            h('div', {}, h('div', { class: 'person-name', text: name }), h('div', { class: 'person-email', text: p.email || '' })),
            h('span', { class: 'state', 'data-state': p.state, text: STATE_LABEL[p.state] || p.state })),
        h('div', { class: 'doing' }, icon(doingIcon(p.doing)), p.doing || 'Using the tool'),
        h('dl', { class: 'facts' }, facts.map(([k, v]) => [h('dt', { text: k }), h('dd', {}, v)])));
}

function renderNow() {
    const now = Date.now();
    const order = { active: 0, idle: 1, away: 2 };
    const online = state.presence.filter(p => isOnline(p, now))
        .sort((a, b) => (order[a.state] - order[b.state]) || personName(a).localeCompare(personName(b)));
    const earlier = state.presence.filter(p => !isOnline(p, now) && sameDay(ms(p.lastSeen), now))
        .sort((a, b) => ms(b.lastSeen) - ms(a.lastSeen));
    const body = bodyOf('secNow');
    const head = $('#secNow .panel-head');
    head.querySelector('.count')?.remove();
    head.querySelector('h2').after(h('span', { class: 'count', text: String(online.length), 'aria-label': `${online.length} signed in` }));
    subOf('secNow').textContent = 'updates every 30 seconds';
    const kids = [];
    if (online.length) kids.push(h('div', { class: 'people' }, online.map(p => personCard(p, now))));
    else kids.push(h('div', { class: 'empty' }, icon('person-dash'), 'Nobody is signed in to the tool right now.'));
    if (earlier.length) {
        kids.push(h('div', { class: 'earlier' }, 'Earlier today: ',
            earlier.map((p, i) => [i ? ', ' : '', h('b', { text: personName(p) }),
                ` (${p.state === 'signed-out' ? 'signed out' : p.state === 'closed' ? 'closed the tool' : 'last seen'} ${timeOf(ms(p.lastSeen))})`])));
    }
    body.replaceChildren(...kids);
}

/* ---- Stat tiles ---- */

function renderKpis() {
    const cur = summarise(dayList(state.range));
    const prev = summarise(dayList(state.range, state.range));
    const hasPrev = prev.tot.records > 0;
    const c = (t, k) => Number(t.counts[k]) || 0;
    const tiles = [
        ['People active', cur.tot.people.size, prev.tot.people.size],
        ['Time in the tool', cur.tot.activeSec, prev.tot.activeSec, 'h'],
        ['Sessions', cur.tot.sessions, prev.tot.sessions],
        ['Drawings worked on', cur.tot.drawings.size, prev.tot.drawings.size],
        ['Parts placed', c(cur.tot, 'added'), c(prev.tot, 'added')],
        ['Prints', c(cur.tot, 'printed'), c(prev.tot, 'printed')],
        ['Drawings issued', c(cur.tot, 'issued'), c(prev.tot, 'issued')]
    ];
    $('#secKpis').replaceChildren(...tiles.map(([label, now, before, unit]) => {
        const show = (v) => (unit === 'h' ? hours(v) : compact(v));
        const diff = unit === 'h' ? Math.round((now - before) / 360) / 10 : now - before;
        let delta;
        if (!hasPrev) delta = h('div', { class: 'kpi-delta', text: 'nothing earlier to compare' });
        else if (diff === 0) delta = h('div', { class: 'kpi-delta', text: `same as the previous ${state.range} days` });
        else delta = h('div', { class: 'kpi-delta', title: `${diff > 0 ? 'Up' : 'Down'} ${Math.abs(diff)}${unit === 'h' ? ' hours' : ''} on the previous ${state.range} days` },
            h('span', { class: diff > 0 ? 'up' : 'down', text: `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)}${unit === 'h' ? ' h' : ''}` }), ` vs previous ${state.range} days`);
        return h('div', { class: 'kpi' },
            h('div', { class: 'kpi-label', text: label }),
            h('div', { class: 'kpi-value' }, show(now), unit === 'h' ? h('small', { text: 'h' }) : null),
            delta);
    }));
}

/* ---- Time in the tool, per day (one series: no legend; today in the signal colour) ---- */

function niceStep(max) {
    const steps = [0.25, 0.5, 1, 2, 3, 5, 10, 20, 25, 50, 100, 200, 500];
    return steps.find(st => max / st <= 4) || 1000;
}

let tooltipEl = null;
function showTooltip(container, x, y, lines) {
    if (!tooltipEl || tooltipEl.parentNode !== container) {
        tooltipEl?.remove();
        tooltipEl = h('div', { class: 'tooltip', role: 'status' });
        container.append(tooltipEl);
    }
    tooltipEl.replaceChildren(
        h('div', { class: 'tt-date', text: lines[0] }),
        h('div', { class: 'tt-val', text: lines[1] }),
        ...lines.slice(2).map(t => h('div', { class: 'tt-row', text: t })));
    tooltipEl.hidden = false;
    const w = container.clientWidth;
    const half = (tooltipEl.offsetWidth || 160) / 2;
    tooltipEl.style.left = `${Math.max(half, Math.min(w - half, x))}px`;
    tooltipEl.style.top = `${y}px`;
}
const hideTooltip = () => { if (tooltipEl) tooltipEl.hidden = true; };

let timeObserver = null;
function renderTime() {
    const days = dayList(state.range);
    const { byDay, tot } = summarise(days);
    subOf('secTime').textContent = `${hours(tot.activeSec)} h in total, ${state.range === 7 ? 'last 7 days' : `last ${state.range} days`}`;
    const body = bodyOf('secTime');
    const wrap = h('div', { class: 'chart' });
    body.replaceChildren(wrap);

    const draw = () => {
        const W = Math.max(280, wrap.clientWidth || 600);
        const H = 240, padL = 34, padR = 4, padT = 10, padB = 24;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const vals = days.map(d => byDay.get(d).activeSec / 3600);
        const max = Math.max(...vals, 0.5);
        const step = niceStep(max);
        const top = Math.ceil(max / step) * step;
        const y = (v) => padT + plotH - (v / top) * plotH;
        const slot = plotW / days.length;
        const barW = Math.max(2, Math.min(24, slot * 0.62)); // thin columns, with air between
        const svgEl = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': `Hours of active use per day over the last ${state.range} days` });
        for (let v = 0; v <= top + 1e-9; v += step) {
            svgEl.append(s('line', { class: v === 0 ? 'axis-line' : 'grid-line', x1: padL, x2: W - padR, y1: Math.round(y(v)) + 0.5, y2: Math.round(y(v)) + 0.5 }));
            const t = s('text', { x: padL - 6, y: y(v) + 4, 'text-anchor': 'end' });
            t.textContent = `${Number.isInteger(v) ? v : v.toFixed(v < 1 ? 2 : 1).replace(/0$/, '')} h`;
            svgEl.append(t);
        }
        const labelEvery = Math.max(1, Math.ceil(days.length / Math.floor(plotW / 54)));
        const today = dayKey();
        days.forEach((d, i) => {
            const v = vals[i];
            const cx = padL + slot * i + slot / 2;
            const x0 = cx - barW / 2, yTop = y(v), base = y(0);
            const hgt = Math.max(0, base - yTop);
            const r = Math.min(4, barW / 2, hgt);
            const info = byDay.get(d);
            const label = `${dayLabel(d, 'long')}${d === today ? ' (today)' : ''}`;
            const lines = [label, v ? `${formatDuration(info.activeSec)} in the tool` : 'Not used',
                ...(v ? [`${plural(info.people.size, 'person', 'people')} · ${plural(info.sessions, 'session')}`] : [])];
            const hit = s('rect', { class: 'hit', x: padL + slot * i, y: padT, width: slot, height: plotH, tabindex: 0, 'aria-label': lines.join(', ') });
            const show = () => showTooltip(wrap, cx, Math.min(yTop, base - 2), lines);
            hit.addEventListener('pointerenter', show);
            hit.addEventListener('focus', show);
            hit.addEventListener('pointerleave', hideTooltip);
            hit.addEventListener('blur', hideTooltip);
            svgEl.append(hit);
            // A column with a rounded data end and a square base
            const path = hgt > 0
                ? `M${x0},${base} V${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop} H${x0 + barW - r} Q${x0 + barW},${yTop} ${x0 + barW},${yTop + r} V${base} Z`
                : `M${x0},${base} H${x0 + barW}`;
            svgEl.append(s('path', { class: `col${d === today ? ' today' : ''}`, d: path, 'pointer-events': 'none' }));
            const isLast = i === days.length - 1;
            if (isLast || (i % labelEvery === 0 && days.length - 1 - i >= labelEvery * 0.6)) {
                const t = s('text', { x: cx, y: H - 6, 'text-anchor': isLast ? 'end' : 'middle' });
                if (isLast) t.setAttribute('x', Math.min(cx + barW / 2 + 2, W - padR));
                t.textContent = isLast ? 'Today' : days.length <= 7 ? weekdayLabel(d) : dayLabel(d);
                svgEl.append(t);
            }
        });
        wrap.replaceChildren(svgEl);
        tooltipEl = null;
    };
    draw();
    let lastW = wrap.clientWidth;
    timeObserver?.disconnect();
    timeObserver = new ResizeObserver(() => { if (Math.abs(lastW - wrap.clientWidth) > 4) { lastW = wrap.clientWidth; draw(); } });
    timeObserver.observe(wrap);

    const table = h('table', {},
        h('thead', {}, h('tr', {}, h('th', { text: 'Day' }), h('th', { text: 'Time' }), h('th', { text: 'People' }), h('th', { text: 'Sessions' }))),
        h('tbody', {}, [...days].reverse().map(d => {
            const v = byDay.get(d);
            return h('tr', {}, h('td', { text: dayLabel(d, 'long') }), h('td', { text: v.activeSec ? formatDuration(v.activeSec) : '-' }),
                h('td', { text: String(v.people.size) }), h('td', { text: String(v.sessions) }));
        })));
    const det = h('details', { class: 'table-view' }, h('summary', { text: 'Show as a table' }), h('div', { class: 'table-wrap' }, table));
    det.open = state.tableOpen;
    det.addEventListener('toggle', () => { state.tableOpen = det.open; });
    body.append(
        h('div', { class: 'chart-foot' },
            h('span', { class: 'key' }, h('i', { 'aria-hidden': 'true' }), 'Hours of active use (clicks, keys or scrolling in the last minute)'),
            h('span', { class: 'key' }, h('i', { class: 'today', 'aria-hidden': 'true' }), 'Today, so far')),
        det);
}

/* ---- Horizontal bars ---- */

function hbars(entries, fmt = String) {
    const max = Math.max(1, ...entries.map(e => e[1]));
    return h('div', { class: 'hbars', role: 'list' }, entries.map(([label, v]) => [
        h('span', { class: 'lbl', title: label, text: label, role: 'listitem' }),
        h('span', { class: 'track', 'aria-hidden': 'true' }, h('span', { class: 'fill', style: `width:${((v / max) * 100).toFixed(2)}%` })),
        h('span', { class: 'val', text: fmt(v) })
    ]));
}

function renderFeatures() {
    const { tot } = summarise(dayList(state.range));
    const c = (k) => Number(tot.counts[k]) || 0;
    const all = [
        ...Object.entries(FEATURES).map(([k, label]) => [label, Number(tot.features[k]) || 0]),
        ['Print', c('printed')], ['Save file', c('savedFile')], ['Issue drawing', c('issued')], ['New tab', c('tabs')]
    ];
    const used = all.filter(e => e[1] > 0).sort((a, b) => b[1] - a[1]);
    const unused = all.filter(e => e[1] === 0).map(e => e[0]);
    subOf('secFeatures').textContent = 'times used';
    const body = bodyOf('secFeatures');
    if (!used.length) { body.replaceChildren(h('div', { class: 'empty' }, icon('ui-checks-grid'), 'No features used in this period yet.')); return; }
    const top = used.slice(0, 10), rest = used.slice(10);
    fill(body, hbars(top, compact),
        rest.length ? h('div', { class: 'unused' }, h('b', { text: 'Also used: ' }), rest.map(([l, n]) => `${l} (${n})`).join(', ')) : null,
        unused.length ? h('div', { class: 'unused' }, h('b', { text: 'Not used in this period: ' }), unused.join(', ')) : null);
}

function renderParts() {
    const { tot } = summarise(dayList(state.range));
    const parts = Object.entries(tot.components).filter(([t, n]) => n > 0 && !NOT_PARTS.has(t)).sort((a, b) => b[1] - a[1]);
    const total = parts.reduce((n, p) => n + p[1], 0);
    subOf('secParts').textContent = total ? `${compact(total)} in total` : '';
    const body = bodyOf('secParts');
    if (!parts.length) { body.replaceChildren(h('div', { class: 'empty' }, icon('grid-3x3-gap'), 'No parts placed in this period yet.')); return; }
    const top = parts.slice(0, 12);
    const rest = parts.slice(12);
    fill(body, hbars(top, compact),
        rest.length ? h('div', { class: 'unused' }, h('b', { text: `${rest.length} more: ` }), rest.map(([t, n]) => `${t} (${n})`).join(', ')) : null);
}

/* ---- People ---- */

const COLUMNS = [
    { key: 'name', label: 'Person', get: p => p.name.toLowerCase() },
    { key: 'activeSec', label: 'Time', get: p => p.activeSec },
    { key: 'sessions', label: 'Sessions', get: p => p.sessions },
    { key: 'drawings', label: 'Drawings', get: p => p.drawings.size },
    { key: 'added', label: 'Parts', get: p => Number(p.counts.added) || 0 },
    { key: 'cables', label: 'Cables', get: p => Number(p.counts.cables) || 0 },
    { key: 'printed', label: 'Prints', get: p => Number(p.counts.printed) || 0 },
    { key: 'issued', label: 'Issued', get: p => Number(p.counts.issued) || 0 },
    { key: 'lastSeen', label: 'Last seen', get: p => p.lastSeen }
];

function renderPeople() {
    const now = Date.now();
    const { people } = summarise(dayList(state.range));
    // Signed in now but nothing totted up yet today: still listed.
    state.presence.filter(p => isOnline(p, now) && !people.has(p.uid)).forEach(p => {
        people.set(p.uid, { uid: p.uid, name: personName(p), email: p.email, activeSec: 0, sessions: 0, counts: {}, drawings: new Set(), lastSeen: 0 });
    });
    people.forEach(p => {
        const pr = presenceOf(p.uid);
        if (pr) p.lastSeen = Math.max(p.lastSeen, ms(pr.lastSeen));
        p.online = isOnline(pr, now);
    });
    const col = COLUMNS.find(c => c.key === state.sort.key) || COLUMNS[1];
    const dir = state.sort.dir === 'asc' ? 1 : -1;
    const list = [...people.values()].sort((a, b) => {
        const x = col.get(a), y = col.get(b);
        return (x < y ? -1 : x > y ? 1 : 0) * dir || a.name.localeCompare(b.name);
    });
    subOf('secPeople').textContent = list.length ? `${plural(list.length, 'person', 'people')} · pick one to filter the activity` : '';
    const body = bodyOf('secPeople');
    if (!list.length) { body.replaceChildren(h('div', { class: 'empty' }, icon('people'), 'Nobody has used the tool while signed in during this period.')); return; }
    const maxSec = Math.max(1, ...list.map(p => p.activeSec));
    const sortBy = (key) => {
        state.sort = { key, dir: state.sort.key === key && state.sort.dir === 'desc' ? 'asc' : key === 'name' ? 'asc' : 'desc' };
        renderPeople();
    };
    const table = h('table', {},
        h('thead', {}, h('tr', {}, COLUMNS.map(c => h('th', {
            scope: 'col',
            'aria-sort': state.sort.key === c.key ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : null
        }, h('button', { type: 'button', text: c.label, onclick: () => sortBy(c.key) }))))),
        h('tbody', {}, list.map(p => {
            const pick = () => { state.pick = state.pick === p.uid ? null : p.uid; state.feedShown = FEED_PAGE; renderPeople(); renderFeed(); };
            return h('tr', {
                class: state.pick === p.uid ? 'picked' : null, tabindex: 0,
                'aria-selected': state.pick === p.uid ? 'true' : 'false',
                title: `Show only ${p.name}'s activity`,
                onclick: pick,
                onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }
            },
                h('td', {}, h('span', { class: 'who' }, avatar(p.name, 'sm'), h('span', { text: p.name }),
                    p.online ? h('i', { class: 'online', title: 'Signed in now', 'aria-label': 'signed in now' }) : null)),
                h('td', {}, h('span', { class: 'time-cell' },
                    h('i', { 'aria-hidden': 'true', style: `width:${Math.round((p.activeSec / maxSec) * 48)}px` }),
                    p.activeSec ? formatDuration(p.activeSec) : '-')),
                h('td', { text: String(p.sessions) }),
                h('td', { text: String(p.drawings.size) }),
                h('td', { text: compact(Number(p.counts.added) || 0) }),
                h('td', { text: compact(Number(p.counts.cables) || 0) }),
                h('td', { text: String(Number(p.counts.printed) || 0) }),
                h('td', { text: String(Number(p.counts.issued) || 0) }),
                h('td', { class: 'muted', text: p.online ? 'now' : p.lastSeen ? ago(p.lastSeen, now) : '-' }));
        })));
    body.replaceChildren(table);
}

/* ---- Recent activity ---- */

const KEY_ACTIONS = new Set(['printed', 'issued', 'savedFile', 'withdrew']);
const QUIET = new Set(['start', 'end', 'open-editor']);

function renderFeed() {
    const rows = state.pick ? state.rows.filter(r => r.uid === state.pick) : state.rows;
    const end = endOf('secFeed');
    end.replaceChildren();
    if (state.pick) {
        const who = rows[0] ? rows[0].name : (state.presence.find(p => p.uid === state.pick) && personName(state.presence.find(p => p.uid === state.pick))) || 'one person';
        end.append(h('span', { class: 'chip' }, `Only ${who}`,
            h('button', { type: 'button', 'aria-label': 'Show everyone', title: 'Show everyone', onclick: () => { state.pick = null; renderPeople(); renderFeed(); } }, icon('x-lg'))));
    }
    subOf('secFeed').textContent = rows.length ? `latest ${rows.length >= 100 ? 'actions' : plural(rows.length, 'action')}` : '';
    const body = bodyOf('secFeed');
    if (!rows.length) {
        body.replaceChildren(h('div', { class: 'empty' }, icon('activity'), state.pick ? 'Nothing recorded for this person in this period.' : 'No activity recorded in this period yet. It shows up here once Rako staff use the tool while signed in.'));
        return;
    }
    const shown = rows.slice(0, state.feedShown);
    const list = h('ol', { class: 'feed' });
    let lastDay = null;
    shown.forEach(r => {
        const day = dayKey(r.at);
        if (day !== lastDay) { list.append(h('li', { class: 'feed-day', text: dayLabel(day, 'feed') })); lastDay = day; }
        const a = r.e.a;
        const onDrawing = EDITS.has(a) && r.e.d ? h('span', { class: 'on', title: r.e.d, text: r.e.d }) : null;
        list.append(h('li', { class: `feed-row${KEY_ACTIONS.has(a) ? ' key-action' : ''}${QUIET.has(a) ? ' quiet' : ''}` },
            h('time', { datetime: new Date(r.at).toISOString(), text: timeOf(r.at) }),
            avatar(r.name, 'sm'),
            h('div', { class: 'what' }, h('b', { text: r.name }), ' ', describeAction(r.e), onDrawing)));
    });
    const kids = [h('div', { class: 'feed-scroll' }, list)];
    if (rows.length > shown.length) {
        kids.push(h('div', { class: 'feed-more' }, h('button', {
            type: 'button', class: 'btn light', text: `Show ${Math.min(FEED_PAGE, rows.length - shown.length)} more`,
            onclick: () => { state.feedShown += FEED_PAGE; renderFeed(); }
        })));
    }
    body.replaceChildren(...kids);
}

/* ---- Status bar ---- */

function renderStatus() {
    const mode = $('#sbMode'), hint = $('#sbHint'), right = $('#sbRight');
    if (!state.loaded) return;
    const hidden = document.visibilityState === 'hidden';
    mode.dataset.mode = state.failing || hidden ? 'paused' : 'live';
    mode.textContent = state.failing ? 'Offline' : hidden ? 'Paused' : DEMO ? 'Sample' : 'Live';
    const at = new Date(state.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    hint.textContent = state.failing
        ? `Couldn't reach the usage records - showing what was there at ${at}. Trying again every 30 seconds.`
        : `Updated ${at} · Only Rako staff signed in to the tool are recorded`;
    const days = dayList(state.range);
    right.textContent = `${dayLabel(days[0])} – ${dayLabel(days[days.length - 1])} · your local time`;
}

function spinRefresh(on) {
    $('#refreshBtn')?.classList.toggle('spin', on);
}

/* ------------------------------------------------------------------
 * Signing in, and the messages when the page can't show anything
 * ------------------------------------------------------------------ */

const GOOGLE_G = '<svg class="g" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';

function showGate(kind, detail = '') {
    clearInterval(timer);
    state.loaded = false;
    $('#toolbarControls').hidden = true;
    const mode = $('#sbMode');
    mode.dataset.mode = '';
    mode.textContent = kind === 'signin' ? 'Signed out' : kind === 'offline' ? 'Offline' : 'Stopped';
    $('#sbHint').textContent = 'Only Rako staff who are signed in to the tool are recorded.';
    $('#sbRight').textContent = '';
    const email = state.user ? state.user.email : '';
    let head, text, actions = [], note = null;
    if (kind === 'signin') {
        head = ['bar-chart-line', 'Rako Sketch usage'];
        text = detail || `Sign in with your @${STAFF_DOMAIN} Google account to see who's using the drawing tool and how.`;
        const btn = h('button', { type: 'button', class: 'btn wide', onclick: signIn });
        btn.innerHTML = `${GOOGLE_G} Sign in with Google`;
        actions.push(btn);
        note = 'For Rako admins. The tool only records Rako staff while they are signed in; nothing is recorded for anyone else.';
    } else if (kind === 'notAdmin') {
        head = ['shield-lock', 'This page is for Rako admins'];
        text = `You're signed in as ${email}, which isn't on the list of people who can see usage. Ask Jordan Huby if you need access.`;
        actions.push(h('a', { class: 'btn', href: 'custom.html' }, icon('pencil'), 'Open the tool'), h('button', { type: 'button', class: 'btn light', onclick: signOut, text: 'Sign out' }));
    } else if (kind === 'refused') {
        head = ['exclamation-octagon', "The usage records couldn't be read"];
        text = `The database turned ${email || 'this account'} away. The latest firestore.rules (with the usage section) may not be published yet: in the Firebase console, open Firestore Database > Rules and publish it.`;
        actions.push(h('button', { type: 'button', class: 'btn', onclick: () => start(state.user) }, icon('arrow-clockwise'), 'Try again'),
            h('button', { type: 'button', class: 'btn light', onclick: signOut, text: 'Sign out' }));
    } else {
        head = ['wifi-off', "Couldn't reach the usage records"];
        text = 'Check your connection and try again in a moment.';
        actions.push(h('button', { type: 'button', class: 'btn', onclick: () => start(state.user) }, icon('arrow-clockwise'), 'Try again'));
    }
    $('#main').replaceChildren(h('div', { class: 'gate' }, h('div', { class: 'panel' }, h('div', { class: 'panel-body' },
        h('div', { class: 'gate-head' }, icon(head[0]), h('div', {}, h('h1', { text: head[1] }), h('p', { text }))),
        h('div', { class: 'row' }, actions),
        note ? h('p', { class: 'note', text: note }) : null))));
}

function renderUser() {
    const el = $('#tbUser');
    if (!state.user) { el.replaceChildren(); return; }
    const name = state.user.displayName || nameFromEmail(state.user.email);
    fill(el, avatar(name), h('span', { class: 'who-name', text: name.split(' ')[0] }),
        DEMO ? null : h('button', { type: 'button', class: 'tb-btn', onclick: signOut, title: `Signed in as ${state.user.email}` }, icon('box-arrow-right'), h('span', { class: 'tb-label', text: 'Sign out' })));
}

async function loadFirebase() {
    if (fb) return fb;
    const [appMod, authMod] = await Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js')]);
    const app = appMod.initializeApp(FIREBASE);
    const auth = authMod.getAuth(app);
    if (EMULATOR && EMULATOR.auth) authMod.connectAuthEmulator(auth, EMULATOR.auth, { disableWarnings: true });
    fb = { auth, ...authMod };
    authMod.onAuthStateChanged(auth, onUser);
    return fb;
}

async function onUser(u) {
    if (u && !isStaff(u)) {
        await fb.signOut(fb.auth);
        state.user = null;
        showGate('signin', `Only @${STAFF_DOMAIN} Google accounts can see usage.`);
        return;
    }
    state.user = u || null;
    renderUser();
    if (!u) { showGate('signin'); return; }
    if (!isAdmin(u)) { showGate('notAdmin'); return; }
    start(u);
}

function start(u) {
    state.user = u;
    state.loaded = false;
    renderUser();
    buildLayout();
    loadAll().then(() => { if (state.loaded) startRefreshing(); });
}

async function signIn() {
    try { await loadFirebase(); } catch (e) { showGate('offline'); return; }
    const provider = new fb.GoogleAuthProvider();
    provider.setCustomParameters({ hd: STAFF_DOMAIN, prompt: 'select_account' });
    try {
        await fb.signInWithPopup(fb.auth, provider);
    } catch (e) {
        const code = e && e.code;
        if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
        showGate('signin', code === 'auth/popup-blocked'
            ? 'Your browser blocked the sign-in window. Allow pop-ups for this site, then try again.'
            : code === 'auth/unauthorized-domain' ? "Sign-in isn't switched on for this web address yet." : "Couldn't sign in. Please try again.");
    }
}

async function signOut() {
    clearInterval(timer);
    if (fb) await fb.signOut(fb.auth);
}

/* ---- Toolbar ---- */

function syncRangeButtons() {
    document.querySelectorAll('[data-range]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.range) === state.range)));
}
document.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => {
    const r = Number(b.dataset.range);
    if (r === state.range) return;
    state.range = r;
    state.feedShown = FEED_PAGE;
    try { localStorage.setItem(RANGE_KEY, String(r)); } catch (e) {}
    syncRangeButtons();
    loadAll();
}));
$('#refreshBtn').addEventListener('click', () => loadAll());

/* ------------------------------------------------------------------
 * Sample data (dashboard.html?demo) - invented people and drawings
 * ------------------------------------------------------------------ */

let demoData = null;
function demo() {
    if (demoData) return demoData;
    let seed = 20261021;
    const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const between = (a, b) => Math.round(a + rnd() * (b - a));
    const people = [
        { uid: 'demo-jh', name: 'Jordan Huby', email: 'jordanhuby@rakocontrols.com', busy: 0.75 },
        { uid: 'demo-sp', name: 'Sam Patel', email: 'sam.patel@rakocontrols.com', busy: 0.9 },
        { uid: 'demo-hb', name: 'Hannah Brooks', email: 'hannah.brooks@rakocontrols.com', busy: 0.8 },
        { uid: 'demo-te', name: 'Tom Ellis', email: 'tom.ellis@rakocontrols.com', busy: 0.55 },
        { uid: 'demo-ps', name: 'Priya Shah', email: 'priya.shah@rakocontrols.com', busy: 0.65 },
        { uid: 'demo-oc', name: 'Owen Carter', email: 'owen.carter@rakocontrols.com', busy: 0.3 }
    ];
    const drawings = ['Smith Residence', 'Oakwood Barns', 'The Old Rectory', 'Harbour View Apt 4', 'Kingsley House', 'Marlow Showroom', 'Hillcrest Farm', 'Elm Court Plot 7', 'Riverside Lofts', 'Ashby Hall'];
    const parts = [['RAK8', 9], ['WCM', 8], ['RAK-Link', 4], ['WK-MOD', 4], ['HUB', 3], ['PIR Sensor', 3], ['DIN-8S', 2], ['RAK-Star', 2], ['WK-EOS', 2], ['DIN-4C', 1], ['DIN-PSU-100', 1], ['RCM', 1], ['WCM-D', 1], ['DIN-DLI', 1]];
    const partBag = parts.flatMap(([t, w]) => Array(w).fill(t));
    const featureBag = [['zoom', 10], ['drawLine', 9], ['undo', 7], ['cableColour', 6], ['quickAdd', 4], ['recent', 3], ['search', 3], ['hand', 2], ['details', 3], ['label', 2], ['redo', 1], ['loadFile', 1], ['retrieve', 1], ['help', 1]]
        .flatMap(([k, w]) => Array(w).fill(k));
    const now = Date.now();
    const days = dayList(180);
    const today = dayKey();
    const hourNow = new Date().getHours() + new Date().getMinutes() / 60;
    const daily = [];
    days.forEach((day, di) => {
        const date = new Date(day + 'T12:00:00');
        const weekend = date.getDay() === 0 || date.getDay() === 6;
        const growth = 0.55 + 0.45 * (di / days.length); // more use lately
        people.forEach(p => {
            if (rnd() > (weekend ? 0.06 : p.busy * growth)) return;
            let activeSec = between(15, 260) * 60;
            if (day === today) activeSec = Math.round(activeSec * Math.min(1, Math.max(0.15, (hourNow - 8) / 9)));
            const added = Math.round(activeSec / 60 * (0.25 + rnd() * 0.35));
            const components = {};
            for (let i = 0; i < added; i++) { const t = pick(partBag); components[t] = (components[t] || 0) + 1; }
            const features = {};
            const uses = Math.round(activeSec / 60 * 0.6);
            for (let i = 0; i < uses; i++) { const k = pick(featureBag); features[k] = (features[k] || 0) + 1; }
            const nd = between(1, 3);
            const ds = new Set(); while (ds.size < nd) ds.add(pick(drawings));
            const sales = p.uid === 'demo-sp' || p.uid === 'demo-hb';
            daily.push({
                id: `${p.uid}_${day}`, uid: p.uid, email: p.email, name: p.name, day, activeSec,
                sessions: between(1, 3),
                counts: {
                    added, removed: Math.round(added * 0.12), cables: Math.round(added * 1.4), tabs: between(0, 2), opened: between(1, 4),
                    printed: between(0, 3), savedFile: between(0, 2), issued: sales && rnd() < 0.45 ? between(1, 2) : 0
                },
                components, features, drawings: [...ds],
                lastSeen: new Date(day === today ? now - between(2, 50) * 60000 : new Date(day + 'T00:00:00').getTime() + between(15, 18) * 3600000 + between(0, 59) * 60000).toISOString()
            });
        });
    });
    // Who's on right now
    const iso = (t) => new Date(t).toISOString();
    const presence = [
        { uid: 'demo-sp', name: 'Sam Patel', email: 'sam.patel@rakocontrols.com', state: 'active', doing: 'Drawing cables', beatSec: 180,
            since: now - 72 * 60000, lastSeen: iso(now - 25000), browser: 'Chrome', os: 'Windows',
            drawing: { name: 'Smith Residence', version: '1.2', tab: 'Ground floor', tabIndex: 1, tabs: 3, items: 18, cables: 24 },
            lastAction: { text: 'Drew 3 cables', at: now - 40000 } },
        { uid: 'demo-hb', name: 'Hannah Brooks', email: 'hannah.brooks@rakocontrols.com', state: 'idle', doing: 'Idle', beatSec: 180,
            since: now - 131 * 60000, lastSeen: iso(now - 70000), browser: 'Edge', os: 'Windows',
            drawing: { name: 'Oakwood Barns', version: '2.0', tab: 'Tab 1', tabIndex: 0, tabs: 1, items: 31, cables: 40 },
            lastAction: { text: 'Printed “Oakwood Barns”', at: now - 9 * 60000 } },
        { uid: 'demo-jh', name: 'Jordan Huby', email: 'jordanhuby@rakocontrols.com', state: 'away', doing: 'In another tab or window', beatSec: 180,
            since: now - 24 * 60000, lastSeen: iso(now - 50000), browser: 'Chrome', os: 'Mac',
            drawing: { name: 'Untitled drawing', version: '1.0', tab: 'Tab 1', tabIndex: 0, tabs: 1, items: 4, cables: 2 },
            lastAction: { text: 'Added 2 × RAK8', at: now - 6 * 60000 } },
        { uid: 'demo-te', name: 'Tom Ellis', email: 'tom.ellis@rakocontrols.com', state: 'closed', doing: 'Closed the tool', beatSec: 180,
            since: now - 5 * 3600000, lastSeen: iso(now - 3.2 * 3600000) },
        { uid: 'demo-ps', name: 'Priya Shah', email: 'priya.shah@rakocontrols.com', state: 'signed-out', doing: 'Signed out', beatSec: 180,
            since: now - 30 * 3600000, lastSeen: iso(now - 26 * 3600000) }
    ];
    // The latest actions, newest first, in batches like usage.js writes them
    const events = [];
    let t = now - 30000;
    const actions = [
        (d) => ({ a: 'added', t: pick(partBag), n: between(1, 3), d }), (d) => ({ a: 'added', t: pick(partBag), n: 1, d }),
        (d) => ({ a: 'cables', n: between(1, 6), d }), (d) => ({ a: 'cables', n: between(2, 8), d }),
        (d) => ({ a: 'added', t: 'Text box', n: between(1, 2), d }), (d) => ({ a: 'removed', t: pick(partBag), n: 1, d }),
        (d) => ({ a: 'printed', d, n: 1 }), (d) => ({ a: 'savedFile', d }), (d) => ({ a: 'opened', how: 'recent', d }),
        (d) => ({ a: 'tabAdded', n: 1, d }), (d) => ({ a: 'version', v: `1.${between(1, 4)}`, d })
    ];
    let n = 0;
    while (events.length < 220) {
        const p = pick(people.slice(0, 5));
        const d = p.uid === 'demo-sp' ? 'Smith Residence' : p.uid === 'demo-hb' ? 'Oakwood Barns' : pick(drawings);
        const evs = [];
        const count = between(1, 4);
        for (let i = 0; i < count; i++) evs.push({ ...pick(actions)(d), at: t - i * between(10, 50) * 1000 });
        if (n % 17 === 5) evs.push({ a: 'issued', d, code: `RK-${'7F3K'.split('').sort(() => rnd() - 0.5).join('')}-${'92QD'.split('').sort(() => rnd() - 0.5).join('')}`, at: t });
        if (n % 23 === 3) evs.push({ a: 'start', browser: 'Chrome', os: 'Windows', at: t - 60000 });
        if (n % 29 === 9) evs.push({ a: 'end', why: 'closed', sec: between(20, 180) * 60, at: t });
        events.push({ id: `demo-ev-${n}`, uid: p.uid, email: p.email, name: p.name, ts: iso(t), events: evs });
        t -= between(2, 14) * 60000;
        const hr = new Date(t).getHours();
        if (hr < 8) t -= (hr + 7) * 3600000; // skip the night
        n++;
    }
    demoData = { presence, daily, events };
    return demoData;
}

/* ------------------------------------------------------------------ */

if (DEMO) {
    state.user = { email: 'sample@rakocontrols.com', displayName: 'Sample viewer', getIdToken: async () => '' };
    renderUser();
    start(state.user);
} else {
    loadFirebase().catch(() => showGate('offline'));
}
