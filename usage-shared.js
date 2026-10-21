// usage-shared.js
// What the usage tracker (usage.js, in the tool) and the usage dashboard
// (dashboard.js) agree on: where the records live, who may read them, and
// what the recorded actions are called.
//
// Only Rako staff who are signed in are ever recorded. See usage.js.

/**
 * Who can open the dashboard. This list is only for the page's own
 * messages: the real gate is firestore.rules (isUsageAdmin), which has the
 * same list and must be kept in step with it. Lower case.
 */
export const USAGE_ADMINS = ['jordanhuby@rakocontrols.com'];

export const USAGE_EVENTS = 'toolUsage';       // one record per batch of actions (written at most every couple of minutes)
export const USAGE_DAILY = 'toolUsageDaily';   // one running total per person per day: {uid}_{YYYY-MM-DD}
export const PRESENCE = 'toolPresence';        // one per person: what they're doing right now

/** A person counts as signed in now when their last heartbeat is this recent (plus the beat they promised). */
export const PRESENCE_GRACE_MS = 90 * 1000;

/** Local calendar day, YYYY-MM-DD - the running totals are kept per day. */
export function dayKey(ts = Date.now()) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Features counted by the tracker, with the names the dashboard shows.
 * Keys are plain identifiers so they're safe as Firestore field names.
 */
export const FEATURES = {
    drawLine:    'Draw line',
    hand:        'Hand tool',
    cableColour: 'Cable colour',
    customColour:'Custom colour',
    zoom:        'Zoom',
    undo:        'Undo',
    redo:        'Redo',
    quickAdd:    'Quick add ( / )',
    search:      'Component search',
    label:       'Label button',
    recent:      'Recent drawings',
    loadFile:    'Load file',
    retrieve:    'Retrieve',
    details:     'Project details',
    help:        'Help',
    tour:        'Tour'
};

/** Totals kept per person per day (USAGE_DAILY `counts`), with the dashboard's names. */
export const COUNTS = {
    added:     'Parts placed',
    removed:   'Parts removed',
    cables:    'Cables drawn',
    tabs:      'Tabs added',
    opened:    'Drawings opened',
    printed:   'Prints',
    savedFile: 'Files saved',
    issued:    'Drawings issued',
    withdrew:  'Issues withdrawn'
};

/** How a drawing came to be open (the `opened` action). */
export const OPENED_HOW = {
    new: 'started a new drawing',
    recent: 'opened',
    file: 'opened a file:',
    register: 'retrieved'
};

/**
 * A Firestore field path segment: plain names as they are, anything else
 * (part names like "RAK-Link" or "Text box") in backticks.
 */
export function fieldSeg(name) {
    return /^[A-Za-z_][A-Za-z_0-9]*$/.test(name) ? name : '`' + String(name).replace(/[`\\]/g, c => '\\' + c) + '`';
}

/** Labels and icons are counted with the parts, but aren't parts. */
export const NOT_PARTS = new Set(['Text box', 'Icon']);

/** 45 -> "45 s", 720 -> "12 min", 4800 -> "1 h 20 min". */
export function formatDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    if (sec < 60) return `${sec} s`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
}

const quoted = (s) => `“${s || 'Untitled drawing'}”`;
function things(n, t) {
    if (t === 'Text box') return n === 1 ? 'a label' : `${n} labels`;
    if (t === 'Icon') return n === 1 ? 'an icon' : `${n} icons`;
    return `${n} × ${t}`;
}

/** One recorded action as words, without who did it: "added 2 × RAK8", "printed “Smith Residence”". */
export function describeAction(e) {
    const n = Number(e.n) || 1;
    switch (e.a) {
        case 'start':      return 'started a session' + (e.browser ? ` (${e.browser}${e.os ? ` on ${e.os}` : ''})` : '');
        case 'end':        return (e.why === 'signed-out' ? 'signed out' : 'closed the tool') + (e.sec ? ` after ${formatDuration(e.sec)}` : '');
        case 'added':      return `added ${things(n, e.t)}`;
        case 'removed':    return `removed ${things(n, e.t)}`;
        case 'cables':     return n === 1 ? 'drew a cable' : `drew ${n} cables`;
        case 'uncabled':   return n === 1 ? 'removed a cable' : `removed ${n} cables`;
        case 'tabAdded':   return n === 1 ? 'added a tab' : `added ${n} tabs`;
        case 'tabRemoved': return n === 1 ? 'removed a tab' : `removed ${n} tabs`;
        case 'renamed':    return `renamed ${quoted(e.from)} to ${quoted(e.d)}`;
        case 'version':    return e.v ? `set the version to ${e.v}` : 'cleared the version';
        case 'opened':
            if (e.how === 'new') return 'started a new drawing';
            if (e.how === 'file') return `opened ${quoted(e.d)} from a file`;
            if (e.how === 'register') return `retrieved ${quoted(e.d)} from Rako's register`;
            return `opened ${quoted(e.d)}`;
        case 'printed':    return `printed ${quoted(e.d)}`;
        case 'savedFile':  return `saved ${quoted(e.d)} to a file`;
        case 'issued':     return `issued ${quoted(e.d)}${e.code ? ` as ${e.code}` : ''}`;
        case 'withdrew':   return `withdrew ${e.code || 'an issued drawing'}`;
        case 'open-editor':return 'opened the tool'; // records from the private version of the tool
        default:           return String(e.a || 'did something');
    }
}

/** Actions that change the drawing - the feed shows which drawing beside them. */
export const EDITS = new Set(['added', 'removed', 'cables', 'uncabled', 'tabAdded', 'tabRemoved', 'version']);
