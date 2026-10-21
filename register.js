// register.js
// Rako's register of issued drawings, kept in the Firestore database of the
// rako-system-designer Firebase project (the project the private version of
// this tool signs in with).
//
// Why a register: the tool's code is public, so anything it can print a
// customer could print too, or edit into a PDF. What they can't do is add a
// record here - the database's own rules (firestore.rules) only accept one
// from a signed-in @rakocontrols.com account, in that account's own name. A
// stamp is genuine when its code is in the register, and the check page
// shows the drawing exactly as it was issued.
//
// It talks to Firestore over its plain REST API: reading needs no sign-in
// and no SDK, so the check page stays small and quick on a phone.

export const FIREBASE = {
    apiKey: 'AIzaSyCJYVbz38ZWYVutUiYCajNgYHhiX39y-LA',
    authDomain: 'rako-system-designer-b7de1.firebaseapp.com',
    projectId: 'rako-system-designer-b7de1',
    appId: '1:447759247794:web:74a9d739ded00c4fe41cab'
};
export const STAFF_DOMAIN = 'rakocontrols.com';
export const COLLECTION = 'issuedDrawings';
// Where printed codes send people to check them. One fixed address, so a
// drawing printed from any copy of the tool points at Rako's own page.
export const CHECK_ORIGIN = 'https://create.rkdraw.workers.dev';
export const CHECK_PATH = '/verify';

/* Tests run against local stand-ins (the Firebase Auth emulator and a local
   Firestore). Only ever on this computer's own address, and only when the
   test sets the flag, so the live tool can't be pointed anywhere else. */
function emulator() {
    try {
        const local = ['localhost', '127.0.0.1'].includes(location.hostname);
        const flag = local && localStorage.getItem('rakoFirebaseEmulator');
        return flag ? JSON.parse(flag) : null; // { auth: 'http://127.0.0.1:9099', firestore: 'http://127.0.0.1:8085' }
    } catch (e) {
        return null;
    }
}
export const EMULATOR = emulator();

export const DOCS = `projects/${FIREBASE.projectId}/databases/(default)/documents`;
export const API = (EMULATOR ? EMULATOR.firestore : 'https://firestore.googleapis.com') + '/v1/';

/* ---- Codes: RK-7F3K-92QD ---- */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I: easy to read back off paper
export const CODE_PATTERN = /^RK-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

export function newIssueCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const chars = [...bytes].map(b => ALPHABET[b % ALPHABET.length]).join('');
    return `RK-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** "rk 7f3k 92qd", "RK7F3K92QD", "7F3K-92QD" -> "RK-7F3K-92QD"; null when it can't be a code. */
export function normaliseCode(input) {
    let s = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s.length === 10 && s.startsWith('RK')) s = s.slice(2);
    if (s.length !== 8) return null;
    const code = `RK-${s.slice(0, 4)}-${s.slice(4)}`;
    return CODE_PATTERN.test(code) ? code : null;
}

export const checkUrl = (code) => `${CHECK_ORIGIN}${CHECK_PATH}?c=${encodeURIComponent(code)}`;
export const checkUrlShort = () => `${CHECK_ORIGIN.replace(/^https?:\/\//, '')}${CHECK_PATH}`;

/* ---- Hashes ---- */
/** Quick, synchronous fingerprint (cyrb53), for "has this changed since it was issued?" while printing. */
export function quickHash(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export async function sha256(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---- Firestore's typed JSON ---- */
function toValue(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === 'string') return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
    return { mapValue: { fields: toFields(v) } };
}
export function toFields(obj) {
    const fields = {};
    Object.keys(obj).forEach(k => { if (obj[k] !== undefined) fields[k] = toValue(obj[k]); });
    return fields;
}
function fromValue(v) {
    if (!v) return null;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return v.doubleValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('timestampValue' in v) return v.timestampValue;
    if ('nullValue' in v) return null;
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
    if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
    return null;
}
export function fromFields(fields) {
    const out = {};
    Object.keys(fields || {}).forEach(k => { out[k] = fromValue(fields[k]); });
    return out;
}

/**
 * Look a code up. Resolves to { status: 'found', record } | { status:
 * 'missing' } | { status: 'error', detail } - 'missing' only when the
 * register answered that there's no such drawing.
 */
export async function lookupIssued(code) {
    if (!CODE_PATTERN.test(code)) return { status: 'missing' };
    let res;
    try {
        res = await fetch(`${API}${DOCS}/${COLLECTION}/${code}?key=${FIREBASE.apiKey}`, { cache: 'no-store' });
    } catch (e) {
        return { status: 'error', detail: 'offline' };
    }
    if (res.status === 404) return { status: 'missing' };
    if (!res.ok) return { status: 'error', detail: String(res.status) };
    try {
        const doc = await res.json();
        return { status: 'found', record: fromFields(doc.fields) };
    } catch (e) {
        return { status: 'error', detail: 'unreadable' };
    }
}

async function commit(writes, idToken) {
    let res;
    try {
        res = await fetch(`${API}${DOCS}:commit?key=${FIREBASE.apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ writes })
        });
    } catch (e) {
        return { ok: false, reason: 'offline' };
    }
    if (res.ok) return { ok: true };
    let status = '';
    try { status = (await res.json()).error.status || ''; } catch (e) {}
    if (res.status === 403 || status === 'PERMISSION_DENIED') return { ok: false, reason: 'refused' };
    if (res.status === 409 || status === 'ALREADY_EXISTS' || status === 'FAILED_PRECONDITION') return { ok: false, reason: 'taken' };
    return { ok: false, reason: 'error', detail: `${res.status} ${status}` };
}

/** Add a drawing to the register. The time is the database's own, not this computer's. */
export function createIssued(code, record, idToken) {
    return commit([{
        update: { name: `${DOCS}/${COLLECTION}/${code}`, fields: toFields(record) },
        currentDocument: { exists: false }, // never on top of an existing code
        updateTransforms: [{ fieldPath: 'issuedAt', setToServerValue: 'REQUEST_TIME' }]
    }], idToken);
}

/** Withdraw an issued drawing (its own issuer only - see firestore.rules). */
export function withdrawIssued(code, idToken) {
    return commit([{
        update: { name: `${DOCS}/${COLLECTION}/${code}`, fields: toFields({ withdrawn: true }) },
        updateMask: { fieldPaths: ['withdrawn'] },
        currentDocument: { exists: true },
        updateTransforms: [{ fieldPath: 'withdrawnAt', setToServerValue: 'REQUEST_TIME' }]
    }], idToken);
}

/** The components in a drawing, counted by name - the check page lists them. `nameOf` gives a type's palette name. */
export function summariseDrawing(data, nameOf = (type) => type) {
    const pages = Array.isArray(data.pages) ? data.pages : [data];
    const components = {};
    let items = 0;
    pages.forEach(p => (p.items || []).forEach(it => {
        items++;
        const type = it.type === 'Icon' ? 'Icon' : it.type === 'TextBox' ? 'Text box' : nameOf(it.type);
        components[type] = (components[type] || 0) + 1;
    }));
    return {
        tabs: pages.map((p, i) => p.name || `Tab ${i + 1}`),
        items,
        cables: pages.reduce((n, p) => n + ((p.connections || []).length), 0),
        components
    };
}
