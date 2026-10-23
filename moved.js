// moved.js
// The tool used to be at jhuby1991.github.io/schematic-public and now lives
// at create.rkdraw.workers.dev. GitHub Pages still serves the same files, so
// the old address sends everyone on to the new one - old links, bookmarks and
// printed check codes keep working.
//
// A browser keeps autosaved drawings per web address, so anyone with drawings
// saved at the old address is offered to bring them along first: the old page
// opens the new one and hands the drawings across (window.postMessage, checked
// at both ends against the other address). Nobody's work is left behind.

import { CHECK_ORIGIN } from './register.js?v=1.55';
import {
    hasDrawings, listDrawings, readDrawing, writeDrawing, findDrawingByContent,
    contentKey, isBlank, newDrawingId, migrateLegacy, displayName
} from './drawings.js?v=1.55';

export const OLD_ORIGIN = 'https://jhuby1991.github.io';
const OLD_PATH_PREFIX = '/schematic-public';
const NEW_ORIGIN = CHECK_ORIGIN;
const MOVED_FLAG = 'rakoMovedToNewAddress'; // drawings already brought across from this browser
const MAX_MOVED = 40;

export const isOldAddress = () => location.origin === OLD_ORIGIN;

/** The same page at the new address: /schematic-public/verify.html?c=… -> /verify.html?c=… */
export function newAddressFor(loc = location) {
    let path = loc.pathname.startsWith(OLD_PATH_PREFIX) ? loc.pathname.slice(OLD_PATH_PREFIX.length) : loc.pathname;
    if (!path || path === '/') path = '/custom.html';
    return NEW_ORIGIN + path + loc.search + loc.hash;
}

/** The check page and other pages that keep nothing: straight on. */
export function redirectIfOldAddress() {
    if (!isOldAddress()) return false;
    location.replace(newAddressFor());
    return true;
}

/**
 * The tool at the old address. Returns true when this page is moving on, in
 * which case the tool isn't set up here at all.
 */
export function handleOldAddress() {
    if (!isOldAddress()) return false;
    migrateLegacy(); // the single autosave of older versions joins the list first
    let moved = false;
    try { moved = localStorage.getItem(MOVED_FLAG) === '1'; } catch (e) {}
    if (moved || !hasDrawings()) {
        location.replace(newAddressFor());
        return true;
    }
    showMoveScreen();
    return true;
}

function drawingsToMove() {
    return listDrawings().slice(0, MAX_MOVED).map(meta => ({ id: meta.id, meta, data: readDrawing(meta.id) }))
        .filter(d => d.data);
}

function showMoveScreen() {
    const drawings = drawingsToMove();
    const n = drawings.length;
    const overlay = document.createElement('div');
    overlay.id = 'movedScreen';
    overlay.innerHTML = `
        <div class="mv-card" role="dialog" aria-modal="true" aria-labelledby="mvTitle">
            <h2 id="mvTitle">The schematic tool has moved</h2>
            <p>It now lives at <b>${NEW_ORIGIN.replace('https://', '')}</b>. Your browser keeps
            ${n === 1 ? 'one drawing' : `${n} drawings`} for this old address, so bring
            ${n === 1 ? 'it' : 'them'} with you.</p>
            <ul class="mv-list"></ul>
            <div class="mv-actions">
                <button type="button" class="mv-primary" data-act="move">Move my drawings and continue</button>
                <a class="mv-secondary" href="${newAddressFor()}">Go without them</a>
            </div>
            <p class="mv-status" aria-live="polite"></p>
        </div>`;
    const list = overlay.querySelector('.mv-list');
    drawings.slice(0, 6).forEach(d => {
        const li = document.createElement('li');
        li.textContent = d.meta.name || displayName(d.data.projectDetails && d.data.projectDetails.projectName);
        list.appendChild(li);
    });
    if (n > 6) {
        const li = document.createElement('li');
        li.textContent = `and ${n - 6} more`;
        list.appendChild(li);
    }
    document.body.appendChild(overlay);
    const status = overlay.querySelector('.mv-status');
    const button = overlay.querySelector('[data-act="move"]');
    button.focus();
    button.addEventListener('click', () => moveDrawings(drawings, status, button));
}

function moveDrawings(drawings, status, button) {
    // A new tab, opened by this click so pop-up blockers allow it; the hand-over
    // needs both pages open at once.
    const target = window.open(`${NEW_ORIGIN}/custom.html?import=moved`, '_blank');
    if (!target) {
        status.innerHTML = '';
        status.append("Your browser blocked the new tab. Allow pop-ups for this site and press the button again, or ");
        const a = document.createElement('a');
        a.href = '#';
        a.textContent = 'download the drawings as files';
        a.addEventListener('click', (e) => { e.preventDefault(); downloadAll(drawings); });
        status.append(a, ' to open with Load File.');
        return;
    }
    button.disabled = true;
    status.textContent = 'Opening the new address…';
    let sent = false;
    const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        button.disabled = false;
        status.textContent = "The new address didn't answer. Check your connection and try again.";
    }, 20000);
    function onMessage(e) {
        if (e.origin !== NEW_ORIGIN || e.source !== target || !e.data) return;
        if (e.data.type === 'rako-import-ready' && !sent) {
            sent = true;
            target.postMessage({ type: 'rako-import', drawings }, NEW_ORIGIN);
        } else if (e.data.type === 'rako-import-done') {
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            try { localStorage.setItem(MOVED_FLAG, '1'); } catch (err) {}
            status.textContent = `Done: ${e.data.count === 1 ? 'your drawing is' : 'your drawings are'} in the new tab. You can close this one.`;
            button.textContent = 'Moved';
        }
    }
    window.addEventListener('message', onMessage);
}

function downloadAll(drawings) {
    drawings.forEach((d, i) => setTimeout(() => {
        const name = (d.meta.name || 'schematic').replace(/[^a-z0-9_.-]/gi, '_').toLowerCase();
        const blob = new Blob([JSON.stringify(d.data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${name}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, i * 400));
}

/**
 * At the new address, opened by the old one with ?import=moved: take the
 * drawings it hands across. Only from the old address, and only from the
 * page that opened this one.
 */
export function receiveMovedDrawings(onDone) {
    const params = new URLSearchParams(location.search);
    if (params.get('import') !== 'moved') return;
    params.delete('import');
    history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash);
    const opener = window.opener;
    if (!opener || location.origin === OLD_ORIGIN) return;
    window.addEventListener('message', function onMessage(e) {
        if (e.origin !== OLD_ORIGIN || e.source !== opener || !e.data || e.data.type !== 'rako-import') return;
        window.removeEventListener('message', onMessage);
        const incoming = Array.isArray(e.data.drawings) ? e.data.drawings.slice(0, MAX_MOVED) : [];
        let count = 0;
        // Oldest first, so the list keeps its order (newest at the top).
        incoming.slice().reverse().forEach(d => {
            if (!d || typeof d !== 'object' || !d.data || typeof d.data !== 'object' || isBlank(d.data)) return;
            if (findDrawingByContent(contentKey(d.data))) { count++; return; } // already here
            const meta = d.meta && typeof d.meta === 'object' ? d.meta : {};
            let id = typeof d.id === 'string' && /^[a-z0-9]{6,40}$/i.test(d.id) ? d.id : newDrawingId();
            if (readDrawing(id)) id = newDrawingId();
            const updated = Number(meta.updated) > 0 && Number(meta.updated) <= Date.now() ? Number(meta.updated) : Date.now();
            if (writeDrawing(id, d.data, { savedToFile: meta.savedToFile === true }, updated)) count++;
        });
        try { opener.postMessage({ type: 'rako-import-done', count }, OLD_ORIGIN); } catch (err) {}
        if (typeof onDone === 'function') onDone(count);
    });
    try { opener.postMessage({ type: 'rako-import-ready' }, OLD_ORIGIN); } catch (e) {}
}
