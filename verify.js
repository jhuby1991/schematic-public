// verify.js
// The public check page: is this code in Rako's register of issued drawings?

import { normaliseCode, lookupIssued } from './register.js?v=1.55';
import { redirectIfOldAddress } from './moved.js?v=1.55';

redirectIfOldAddress(); // the old GitHub Pages address: on to the new one

const form = document.getElementById('checkForm');
const input = document.getElementById('codeInput');
const button = document.getElementById('checkBtn');
const result = document.getElementById('result');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' }) + ' at ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

function card(kind, icon, title, text, body = '') {
    result.innerHTML = `
        <div class="card ${kind}">
            <div class="verdict"><i class="bi ${icon}" aria-hidden="true"></i><div><h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}</div></div>
            ${body}
        </div>`;
}

function details(rec) {
    const p = rec.project || {};
    const s = rec.summary || {};
    const rows = [
        ['Project', p.name && p.name !== 'Schematic' ? p.name : 'Untitled'],
        ['Version', p.version],
        ['Reference', p.reference],
        ['Issued by', rec.issuedBy ? `${rec.issuedBy.name} (${rec.issuedBy.email})` : ''],
        ['Issued on', when(rec.issuedAt)],
        ['Tabs', (s.tabs || []).join(', ')]
    ].filter(([, v]) => v);
    const parts = Object.entries(s.components || {}).sort((a, b) => b[1] - a[1])
        .map(([type, n]) => `<span>${n} × ${esc(type)}</span>`).join('');
    return `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
        ${parts ? `<dt>Parts</dt><dd><div class="parts">${parts}</div></dd>` : ''}
        ${typeof s.cables === 'number' ? `<dt>Cables</dt><dd>${s.cables}</dd>` : ''}</dl>`;
}

async function check(raw) {
    const code = normaliseCode(raw);
    if (!code) {
        card('bad', 'bi-x-circle-fill', "That isn't a Rako drawing code", 'Codes look like RK-7F3K-92QD: RK, then two groups of four letters and numbers.');
        return;
    }
    input.value = code;
    history.replaceState(null, '', `?c=${code}`);
    button.disabled = true;
    card('muted', 'bi-hourglass-split', `Checking ${code}…`, '');
    const found = await lookupIssued(code);
    button.disabled = false;
    if (found.status === 'missing') {
        card('bad', 'bi-x-circle-fill', 'Not a Rako drawing', `No drawing has been issued by Rako with the code ${code}. Check the code was entered correctly; if it was, Rako didn't issue this drawing.`);
        return;
    }
    if (found.status === 'error') {
        card('muted', 'bi-wifi-off', "Couldn't check right now", "Rako's register couldn't be reached. Check your connection and try again in a moment.");
        return;
    }
    const rec = found.record;
    const open = `<div class="actions"><a href="custom.html?issued=${encodeURIComponent(code)}"><i class="bi bi-box-arrow-up-right" aria-hidden="true"></i> Open the drawing as issued</a>
        <small>Opens it in the schematic tool, best on a computer.</small></div>`;
    if (rec.withdrawn) {
        card('warn', 'bi-exclamation-triangle-fill', 'Withdrawn by Rako', `${code} was issued by Rako${rec.withdrawnAt ? ` but withdrawn on ${when(rec.withdrawnAt)}` : ' but has since been withdrawn'}. Don't work from it; ask Rako for the current drawing.`, details(rec));
        return;
    }
    card('ok', 'bi-patch-check-fill', 'Genuine Rako drawing', `${code} was issued by Rako Controls.`, details(rec) + open);
}

form.addEventListener('submit', (e) => {
    e.preventDefault();
    check(input.value);
});
input.addEventListener('input', () => {
    // RK7F3K92QD -> RK-7F3K-92QD as it's typed
    const s = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    const parts = s.startsWith('RK') ? ['RK', s.slice(2, 6), s.slice(6, 10)] : [s.slice(0, 4), s.slice(4, 8)];
    input.value = parts.filter(Boolean).join('-');
});

const initial = new URLSearchParams(location.search).get('c');
if (initial) check(initial);
else input.focus();
