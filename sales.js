// sales.js
// Rako staff sign-in, and issuing drawings in Rako's name.
//
// A salesperson clicks Sales in the toolbar and signs in with their
// @rakocontrols.com Google account. Issuing a drawing then adds it to Rako's
// register (register.js) and puts a stamp in the printed title block: their
// name, the date, a code such as RK-7F3K-92QD and a QR code. Anyone can check
// the code at create.rkdraw.workers.dev/verify and see the drawing exactly as
// it was issued. Change the drawing afterwards and the stamp comes off until
// it's issued again.

import { getSchematicData, getDrawingIssue, setDrawingIssue } from './canvas.js?v=1.46';
import { contentKey, isBlank, displayName } from './drawings.js?v=1.46';
import { openDrawingData } from './storage.js?v=1.46';
import { showToast, showConfirm, showActionBar } from './utils.js?v=1.46';
import {
    FIREBASE, STAFF_DOMAIN, EMULATOR, newIssueCode, normaliseCode, checkUrl, checkUrlShort,
    quickHash, sha256, createIssued, withdrawIssued, lookupIssued, summariseDrawing
} from './register.js?v=1.46';
import qrcode from './qrcode.js?v=1.46';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const SIGNED_IN_HINT = 'rakoStaffSignedIn'; // load sign-in straight away next time, so the button is right from the start
const TOOL_VERSION = 'v1.46';

let fb = null;          // the Firebase Auth module and instance, once loaded
let loading = null;
let user = null;        // a signed-in, verified Rako account - never anyone else
let busy = false;
let panel = null;

const isStaff = (u) => !!(u && u.emailVerified && (u.email || '').toLowerCase().endsWith('@' + STAFF_DOMAIN));

/** "jordan.huby@rakocontrols.com" -> "Jordan Huby", when the account has no display name. */
function staffName(u) {
    if (u.displayName && u.displayName.trim()) return u.displayName.trim();
    return (u.email || '').split('@')[0].split(/[._-]+/).filter(Boolean)
        .map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
const formatDate = (ts) => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

function remember(on) {
    try { on ? localStorage.setItem(SIGNED_IN_HINT, '1') : localStorage.removeItem(SIGNED_IN_HINT); } catch (e) {}
}

function loadFirebase() {
    if (loading) return loading;
    loading = (async () => {
        const [appMod, authMod] = await Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js')]);
        const app = appMod.initializeApp(FIREBASE);
        const auth = authMod.getAuth(app);
        if (EMULATOR && EMULATOR.auth) authMod.connectAuthEmulator(auth, EMULATOR.auth, { disableWarnings: true });
        fb = { auth, ...authMod };
        authMod.onAuthStateChanged(auth, async (u) => {
            if (u && !isStaff(u)) {
                // Signed in, but not with a Rako account: not kept for a moment.
                await authMod.signOut(auth);
                return;
            }
            user = u || null;
            remember(!!user);
            render();
        });
        if (typeof auth.authStateReady === 'function') await auth.authStateReady();
        return fb;
    })();
    loading.catch(() => { loading = null; });
    return loading;
}

/** After any sign-in: only a verified @rakocontrols.com account is accepted. */
async function acceptSignIn(u) {
    if (!isStaff(u)) {
        await fb.signOut(fb.auth);
        showToast(`Only @${STAFF_DOMAIN} Google accounts can issue drawings for Rako.`, 'error', 5000);
        return false;
    }
    showToast(`Signed in as ${staffName(u)}`, 'success');
    return true;
}

async function signIn() {
    try {
        await loadFirebase();
    } catch (e) {
        showToast("Couldn't reach Google sign-in. Check your connection and try again.", 'error', 5000);
        return;
    }
    const provider = new fb.GoogleAuthProvider();
    provider.setCustomParameters({ hd: STAFF_DOMAIN, prompt: 'select_account' });
    try {
        const result = await fb.signInWithPopup(fb.auth, provider);
        await acceptSignIn(result.user);
    } catch (e) {
        const code = e && e.code;
        if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
        if (code === 'auth/popup-blocked') showToast('Your browser blocked the sign-in window. Allow pop-ups for this site, then try again.', 'error', 6000);
        else if (code === 'auth/unauthorized-domain') showToast("Staff sign-in isn't switched on for this web address yet.", 'error', 6000);
        else showToast("Couldn't sign in. Please try again.", 'error', 5000);
    }
}

async function signOut() {
    if (!fb) return;
    await fb.signOut(fb.auth);
    showToast('Signed out', 'info');
}

/* ------------------------------------------------------------------
 * The drawing's stamp
 * ------------------------------------------------------------------ */

/** A component's name as the palette shows it ("WCM" rather than "KeypadWCM"). */
function paletteName(type) {
    const item = [...document.querySelectorAll('#palette .palette-item[data-type]')].find(el => el.dataset.type === type);
    const name = item && item.textContent.trim();
    return name || type;
}

/** The drawing as it would be issued: everything but the stamp itself. */
function plainData() {
    const data = getSchematicData();
    delete data.issue;
    return data;
}

/** 'none' | 'valid' (exactly as issued) | 'changed' (edited since). */
export function issueState() {
    const issue = getDrawingIssue();
    if (!issue) return { state: 'none' };
    const same = quickHash(contentKey(plainData())) === issue.localHash;
    return { state: same ? 'valid' : 'changed', issue };
}

/** Fill the printed stamp, or hide it when there's nothing genuine to show (canvas.js calls this). */
function fillIssueStamp(el) {
    if (!el) return;
    const st = issueState();
    const row = el.closest('#pdfInfoRow');
    if (row) row.classList.toggle('has-stamp', st.state === 'valid');
    if (st.state !== 'valid') { el.hidden = true; return; }
    const { code, name, issuedAt } = st.issue;
    const url = checkUrl(code);
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    el.querySelector('.pis-qr').innerHTML = qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true, alt: `Check code ${code}` });
    el.querySelector('.pis-name').textContent = name;
    el.querySelector('.pis-date').textContent = formatDate(issuedAt);
    el.querySelector('.pis-code').textContent = code;
    const link = el.querySelector('.pis-link');
    link.href = url; // a working link in the saved PDF too
    link.textContent = `Check at ${checkUrlShort()}`;
    el.hidden = false;
}

async function issueDrawing() {
    if (!user || busy) return;
    let data = plainData();
    if (isBlank(data)) { showToast('Draw something before issuing it.', 'info'); return; }
    const name = staffName(user);
    const pd = data.projectDetails || {};
    const ok = await showConfirm({
        title: 'Issue this drawing for Rako?',
        message: `“${displayName(pd.projectName)}”${pd.version ? ` v${pd.version}` : ''} will carry your name and a code anyone can check at ${checkUrlShort()}. If it's changed afterwards, the stamp comes off until it's issued again.`,
        confirmLabel: 'Issue drawing',
        cancelLabel: 'Cancel'
    });
    if (!ok) return;
    // "Prepared by" is the person issuing it, unless it already says.
    const prepared = document.getElementById('formSalesman');
    if (prepared && !prepared.value.trim()) {
        prepared.value = name;
        prepared.dispatchEvent(new Event('input', { bubbles: true }));
        data = plainData();
    }
    busy = true;
    render();
    try {
        const key = contentKey(data);
        const details = data.projectDetails || {};
        const record = {
            code: '',
            withdrawn: false,
            issuedBy: { uid: user.uid, email: user.email, name },
            project: {
                name: details.projectName || '', version: details.version || '', reference: details.quoteReference || '',
                date: details.date || '', preparedBy: details.salesperson || ''
            },
            summary: summariseDrawing(data, paletteName),
            contentHash: await sha256(key),
            drawing: JSON.stringify(data),
            toolVersion: TOOL_VERSION
        };
        const token = await user.getIdToken();
        let result = null, code = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            code = newIssueCode();
            record.code = code;
            result = await createIssued(code, record, token);
            if (result.ok || result.reason !== 'taken') break; // a clash with an existing code: just draw another
        }
        if (!result.ok) {
            const why = result.reason === 'offline' ? "Couldn't reach Rako's register. Check your connection and try again."
                : result.reason === 'refused' ? "Rako's register didn't accept it. Sign out and back in with your Rako account, then try again."
                : "Couldn't issue the drawing. Please try again.";
            showToast(why, 'error', 6000);
            return;
        }
        setDrawingIssue({ code, name, email: user.email, issuedAt: Date.now(), localHash: quickHash(key) });
        showToast(`Issued as ${code}. Print it to share it with the stamp.`, 'success', 5000);
    } catch (e) {
        showToast("Couldn't issue the drawing. Please try again.", 'error', 5000);
    } finally {
        busy = false;
        render();
    }
}

async function withdraw() {
    const st = issueState();
    if (!user || !st.issue || busy) return;
    const ok = await showConfirm({
        title: `Withdraw ${st.issue.code}?`,
        message: "Anyone who checks this code will be told Rako has withdrawn the drawing. This can't be undone.",
        confirmLabel: 'Withdraw',
        cancelLabel: 'Keep it',
        danger: true
    });
    if (!ok) return;
    busy = true;
    render();
    try {
        const result = await withdrawIssued(st.issue.code, await user.getIdToken());
        if (result.ok) {
            setDrawingIssue(null);
            showToast(`${st.issue.code} withdrawn`, 'success');
        } else {
            showToast(result.reason === 'refused' ? 'Only the person who issued a drawing can withdraw it.' : "Couldn't withdraw it. Please try again.", 'error', 5000);
        }
    } finally {
        busy = false;
        render();
    }
}

async function copyCheckLink() {
    const st = issueState();
    if (!st.issue) return;
    try {
        await navigator.clipboard.writeText(checkUrl(st.issue.code));
        showToast('Check link copied', 'success');
    } catch (e) {
        showToast(checkUrl(st.issue.code), 'info', 8000);
    }
}

/* ------------------------------------------------------------------
 * Toolbar button, panel and status bar
 * ------------------------------------------------------------------ */

function renderButton() {
    const btn = document.getElementById('salesBtn');
    if (!btn) return;
    btn.classList.toggle('signed-in', !!user);
    const label = btn.querySelector('.tb-label');
    if (user) {
        const name = staffName(user);
        if (label) label.textContent = name.split(' ')[0];
        btn.dataset.tip = `Signed in as ${name}, Rako staff`;
        btn.setAttribute('aria-label', `Rako staff: ${name}`);
    } else {
        if (label) label.textContent = 'Sales';
        btn.dataset.tip = 'Rako staff: sign in to issue drawings for Rako';
        btn.setAttribute('aria-label', 'Rako staff sign-in');
    }
}

function renderStatus() {
    const el = document.getElementById('statusIssue');
    if (!el) return;
    const st = issueState();
    if (st.state === 'none') { el.hidden = true; return; }
    el.hidden = false;
    el.dataset.state = st.state;
    el.innerHTML = st.state === 'valid'
        ? '<i class="bi bi-patch-check-fill" aria-hidden="true"></i><span></span>'
        : '<i class="bi bi-exclamation-circle" aria-hidden="true"></i><span></span>';
    el.querySelector('span').textContent = st.state === 'valid' ? `Issued ${st.issue.code}` : `Changed since ${st.issue.code}`;
    el.dataset.tip = st.state === 'valid'
        ? `Issued for Rako by ${st.issue.name} on ${formatDate(st.issue.issuedAt)}. The stamp prints in the title block.`
        : `Changed since ${st.issue.name} issued it as ${st.issue.code}, so the stamp won't print. Issue it again to stamp this version.`;
}

function render() {
    renderButton();
    renderStatus();
    if (panel && !panel.hidden) renderPanel();
}

function renderPanel() {
    const st = issueState();
    let html;
    if (!user) {
        html = `
            <div class="sp-head"><i class="bi bi-person-badge" aria-hidden="true"></i><div><h3>Rako staff</h3>
            <p>Sign in with your @${STAFF_DOMAIN} Google account to issue drawings for Rako.</p></div></div>
            <button type="button" class="btn btn-sm btn-primary sp-wide" data-act="signin"${loading && !fb ? ' disabled' : ''}>
                <svg class="sp-g" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>
                Sign in with Google</button>
            <p class="sp-note">Issued drawings carry your name and a code. Anyone can check the code at ${checkUrlShort()}.</p>`;
    } else {
        const name = staffName(user);
        let body;
        if (st.state === 'none') {
            body = `<p class="sp-state">This drawing hasn't been issued.</p>
                <button type="button" class="btn btn-sm btn-primary sp-wide" data-act="issue"${busy ? ' disabled' : ''}>${busy ? 'Issuing…' : 'Issue this drawing'}</button>`;
        } else if (st.state === 'valid') {
            const mine = (st.issue.email || '').toLowerCase() === (user.email || '').toLowerCase();
            body = `<p class="sp-state sp-ok"><i class="bi bi-patch-check-fill" aria-hidden="true"></i> Issued as <b>${escapeHtml(st.issue.code)}</b></p>
                <p class="sp-sub">by ${escapeHtml(st.issue.name)}, ${formatDate(st.issue.issuedAt)}. The stamp prints in the title block.</p>
                <div class="sp-row"><button type="button" class="btn btn-sm btn-outline-secondary" data-act="copy"><i class="bi bi-link-45deg"></i> Copy check link</button>
                ${mine ? `<button type="button" class="btn btn-sm btn-outline-secondary" data-act="withdraw"${busy ? ' disabled' : ''}>Withdraw</button>` : ''}</div>`;
        } else {
            body = `<p class="sp-state sp-warn"><i class="bi bi-exclamation-circle" aria-hidden="true"></i> Changed since it was issued as <b>${escapeHtml(st.issue.code)}</b></p>
                <p class="sp-sub">The stamp won't print on this version.</p>
                <button type="button" class="btn btn-sm btn-primary sp-wide" data-act="issue"${busy ? ' disabled' : ''}>${busy ? 'Issuing…' : 'Issue this version'}</button>`;
        }
        html = `
            <div class="sp-head"><span class="sp-avatar" aria-hidden="true">${escapeHtml(initials(name))}</span><div><h3>${escapeHtml(name)}</h3>
            <p class="sp-email" title="${escapeHtml(user.email)}">${escapeHtml(user.email)}</p></div>
            <button type="button" class="btn btn-sm btn-link sp-signout" data-act="signout">Sign out</button></div>
            <div class="sp-section">${body}</div>`;
    }
    panel.innerHTML = html;
}

function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openPanel() {
    const btn = document.getElementById('salesBtn');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'salesPanel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Rako staff');
        panel.hidden = true;
        document.body.appendChild(panel);
        panel.addEventListener('click', (e) => {
            const act = e.target.closest('[data-act]') && e.target.closest('[data-act]').dataset.act;
            if (act === 'signin') signIn();
            else if (act === 'signout') signOut();
            else if (act === 'issue') issueDrawing();
            else if (act === 'withdraw') withdraw();
            else if (act === 'copy') copyCheckLink();
        });
        document.addEventListener('mousedown', (e) => {
            // Stays open through its own confirm dialogs, so the result shows up in it.
            if (!panel.hidden && !panel.contains(e.target) && !e.target.closest('#salesBtn, #statusIssue, .app-confirm')) closePanel();
        }, true);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) closePanel(); });
    }
    renderPanel();
    panel.hidden = false;
    const r = btn ? btn.getBoundingClientRect() : { right: window.innerWidth - 12, bottom: 48 };
    const w = panel.offsetWidth || 320;
    panel.style.left = Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12)) + 'px';
    panel.style.top = (r.bottom + 8) + 'px';
    panel.classList.remove('sp-in');
    void panel.offsetWidth;
    panel.classList.add('sp-in');
    if (!fb) loadFirebase().then(() => renderPanel()).catch(() => {}); // warm up, so Sign in is instant
}
function closePanel() {
    if (panel) panel.hidden = true;
}
function togglePanel() {
    if (panel && !panel.hidden) closePanel();
    else openPanel();
}

/* ------------------------------------------------------------------
 * Opening a drawing from Rako's register: by link (custom.html?issued=RK-...)
 * or by typing its code into Retrieve drawing
 * ------------------------------------------------------------------ */

/**
 * Fetch an issued drawing. Resolves to { status: 'found', rec, data } |
 * { status: 'missing' } | { status: 'error' } | { status: 'damaged' }.
 */
async function fetchIssued(code) {
    const found = await lookupIssued(code);
    if (found.status !== 'found') return { status: found.status };
    try {
        const data = JSON.parse(found.record.drawing);
        if (!data || typeof data !== 'object') return { status: 'damaged' };
        return { status: 'found', rec: found.record, data };
    } catch (e) {
        return { status: 'damaged' };
    }
}

/** Open a fetched drawing. Whatever was open stays in Recent drawings; the stamp comes with it unless it was withdrawn. */
async function openIssued(code, rec, data) {
    const leaving = await openDrawingData(data);
    const by = (rec.issuedBy && rec.issuedBy.name) || 'Rako';
    const when = rec.issuedAt ? formatDate(rec.issuedAt) : '';
    const kept = leaving ? ` “${leaving}” is in Recent drawings.` : '';
    if (rec.withdrawn) {
        setDrawingIssue(null);
        showActionBar({ message: `${code} was issued by ${by}, but Rako has since withdrawn it, so it has no stamp. Ask Rako for the current drawing.${kept}`, actions: [{ label: 'OK', variant: 'btn-primary' }] });
    } else {
        setDrawingIssue({ code, name: by, email: (rec.issuedBy && rec.issuedBy.email) || '', issuedAt: Date.parse(rec.issuedAt) || Date.now(), localHash: quickHash(contentKey(plainData())) });
        showActionBar({ message: `This is ${code} exactly as ${by} issued it for Rako${when ? ` on ${when}` : ''}.${kept}`, actions: [{ label: 'OK', variant: 'btn-primary' }] });
    }
}

async function openFromLink() {
    const params = new URLSearchParams(location.search);
    if (!params.has('issued')) return;
    const code = normaliseCode(params.get('issued'));
    params.delete('issued');
    history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash);
    if (!code) { showToast("That link doesn't have a valid drawing code", 'error', 5000); return; }
    const got = await fetchIssued(code);
    if (got.status === 'missing') {
        showActionBar({ message: `No Rako drawing has the code ${code}.`, actions: [{ label: 'OK', variant: 'btn-primary' }] });
        return;
    }
    if (got.status === 'error') {
        showToast("Couldn't reach Rako's register to open that drawing. Please try again.", 'error', 6000);
        return;
    }
    if (got.status === 'damaged') { showToast("That drawing couldn't be opened", 'error'); return; }
    await openIssued(code, got.rec, got.data);
}

/** RK7F3K92QD -> RK-7F3K-92QD as it's typed (the check page does the same). */
function formatCodeInput(input) {
    const s = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    const parts = s.startsWith('RK') ? ['RK', s.slice(2, 6), s.slice(6, 10)] : [s.slice(0, 4), s.slice(4, 8)];
    input.value = parts.filter(Boolean).join('-');
}

/** The Retrieve drawing window: type the code from a drawing's stamp to open that drawing. */
export function showRetrieveDialog() {
    document.getElementById('retrieveDrawing')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'retrieveDrawing';
    overlay.className = 'rd-overlay';
    overlay.innerHTML = `
        <form class="rd-box rt-box" role="dialog" aria-modal="true" aria-labelledby="rtTitle" novalidate>
            <div class="rd-head">
                <div>
                    <h3 id="rtTitle">Retrieve a drawing</h3>
                    <p>Type the code printed next to the QR code on a drawing Rako has issued, to open that drawing here.</p>
                </div>
                <button type="button" class="rd-close" aria-label="Close"><i class="bi bi-x-lg"></i></button>
            </div>
            <div class="rt-body">
                <label for="rtCode" class="rt-label">Drawing code</label>
                <div class="rt-row">
                    <input id="rtCode" class="form-control rt-input" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="RK-7F3K-92QD" maxlength="12" aria-describedby="rtMsg">
                    <button type="submit" class="btn btn-primary rt-open">Open</button>
                </div>
                <p id="rtMsg" class="rt-msg" aria-live="polite"></p>
                <p class="rt-note">Whatever is open now stays in Recent drawings.</p>
            </div>
        </form>`;
    const form = overlay.querySelector('form');
    const input = overlay.querySelector('#rtCode');
    const button = overlay.querySelector('.rt-open');
    const msg = overlay.querySelector('#rtMsg');
    const previous = document.activeElement;
    let working = false;

    function close(restoreFocus = true) {
        overlay.classList.remove('rd-in');
        document.removeEventListener('keydown', onKey, true);
        setTimeout(() => overlay.remove(), 160);
        if (restoreFocus && previous && previous.focus) previous.focus();
    }
    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    }
    function say(text, kind = '') {
        msg.textContent = text;
        msg.dataset.kind = kind;
        input.setAttribute('aria-invalid', kind === 'bad' ? 'true' : 'false');
    }

    input.addEventListener('input', () => { formatCodeInput(input); if (msg.dataset.kind === 'bad') say(''); });
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (working) return;
        const code = normaliseCode(input.value);
        if (!code) {
            say(input.value.trim() ? "That isn't a drawing code. Codes look like RK-7F3K-92QD: RK, then two groups of four letters and numbers." : 'Type the code from the drawing first.', 'bad');
            input.focus();
            return;
        }
        input.value = code;
        working = true;
        button.disabled = true;
        button.textContent = 'Opening…';
        say(`Looking up ${code}…`);
        const got = await fetchIssued(code);
        working = false;
        button.disabled = false;
        button.textContent = 'Open';
        if (got.status === 'found') {
            close(false);
            await openIssued(code, got.rec, got.data);
            return;
        }
        say(got.status === 'missing' ? `No Rako drawing has the code ${code}. Check it was typed correctly.`
            : got.status === 'damaged' ? `${code} is in Rako's register, but its drawing couldn't be opened.`
            : "Couldn't reach Rako's register. Check your connection and try again.", 'bad');
        input.focus();
        input.select();
    });
    overlay.querySelector('.rd-close').addEventListener('click', () => close());
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('rd-in'));
    input.focus();
    return { close };
}

export function setupSales(app) {
    app.fillIssueStamp = fillIssueStamp;
    document.getElementById('salesBtn')?.addEventListener('click', togglePanel);
    document.getElementById('statusIssue')?.addEventListener('click', openPanel);
    document.getElementById('retrieveBtn')?.addEventListener('click', showRetrieveDialog);
    ['schematic:issue', 'schematic:content'].forEach(t => document.addEventListener(t, render));
    render();

    // Signed in last time: pick the session back up quietly.
    let hint = false;
    try { hint = localStorage.getItem(SIGNED_IN_HINT) === '1'; } catch (e) {}
    if (hint) setTimeout(() => loadFirebase().catch(() => {}), 300);

    openFromLink();

    // Tests sign in through the Firebase Auth emulator (localhost only).
    if (EMULATOR) {
        window.__rakoStaffTest = {
            async signIn(email, name, verified = true) {
                await loadFirebase();
                const cred = fb.GoogleAuthProvider.credential(JSON.stringify({ sub: 'test-' + email, email, email_verified: verified, name }));
                const result = await fb.signInWithCredential(fb.auth, cred);
                return acceptSignIn(result.user);
            },
            state: () => ({ user: user ? { email: user.email, name: staffName(user) } : null, issue: issueState() })
        };
    }
}
