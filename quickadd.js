// quickadd.js
// Finding a component without hunting through the palette:
// - Press / anywhere on the drawing, type a few letters ("rak8", "pir",
//   "single"), and Enter drops it at the pointer.
// - The search box at the top of the palette filters every group at once;
//   matching items can be dragged out as usual, and Enter adds the first.

import { createTextBoxOnCanvas, startEditing } from './text.js?v=1.53';
import { createIconOnCanvas, ICON_CATEGORIES } from './icons.js?v=1.53';
import { getVisibleCanvasOrigin } from './zoom.js?v=1.53';

const MAX_RESULTS = 40;
const norm = (s) => (s || '').toLowerCase().replace(/[\s\-_]+/g, '');

/** Everything that can be added, read from the palette itself so it never drifts. */
function buildCatalogue() {
    const entries = [];
    document.querySelectorAll('#palette .palette-dropdown-header').forEach(header => {
        const group = header.textContent.trim();
        const content = document.getElementById(header.dataset.target);
        if (!content) return;
        content.querySelectorAll('.palette-item:not(.icon-palette-item)').forEach(item => {
            const img = item.querySelector('img');
            entries.push({
                kind: 'component',
                name: item.textContent.trim() || item.dataset.type,
                type: item.dataset.type,
                img: item.dataset.img || (img && img.src) || '',
                group
            });
        });
    });
    entries.push({ kind: 'text', name: 'Label', type: 'TextBox', group: 'Text box' });
    ICON_CATEGORIES.forEach(cat => cat.icons.forEach(icon => {
        entries.push({ kind: 'icon', name: icon.replace(/_/g, ' '), type: icon, group: 'Icon · ' + cat.name });
    }));
    return entries;
}

/** Best matches first: exact, then starts-with, then a word starting with it, then anywhere. */
function search(entries, query) {
    const q = norm(query);
    if (!q) return entries.filter(e => e.kind !== 'icon').slice(0, MAX_RESULTS);
    const scored = [];
    entries.forEach((e, i) => {
        const name = norm(e.name), type = norm(e.type);
        const words = e.name.toLowerCase().split(/[\s\-_()]+/);
        let score = null;
        if (name === q || type === q) score = 0;
        // A word in the name starting with it counts as much as the name
        // starting with it: "link" finds RAK-Link and DIN-LINK as readily as
        // the "Link Supply" label.
        else if (name.startsWith(q) || type.startsWith(q) || words.some(w => w.startsWith(q))) score = 1;
        else if (name.includes(q) || type.includes(q)) score = 3;
        else if (norm(e.group).includes(q)) score = 4;
        // On a tie, real equipment before printed labels, and both before icons.
        const nudge = e.kind === 'icon' ? 0.5 : /^labels?$/i.test((e.group || '').trim()) ? 0.25 : 0;
        if (score !== null) scored.push({ e, score: score + nudge, i });
    });
    scored.sort((a, b) => a.score - b.score || a.i - b.i);
    return scored.slice(0, MAX_RESULTS).map(s => s.e);
}

export function setupQuickAdd(app) {
    const wrapper = document.getElementById('drawing-canvas-wrapper');
    if (!wrapper) return;
    let catalogue = null;
    const getCatalogue = () => (catalogue = catalogue || buildCatalogue());

    // Where the pointer is over the drawing (screen coords), for "add at the pointer".
    let pointer = null;
    wrapper.addEventListener('mousemove', (e) => { pointer = { x: e.clientX, y: e.clientY }; });
    wrapper.addEventListener('mouseleave', () => { pointer = null; });

    /** Add one catalogue entry at a canvas point, select it, and return it. */
    function place(entry, at) {
        const x = Math.max(0, Math.round(at.x / 10) * 10);
        const y = Math.max(0, Math.round(at.y / 10) * 10);
        if (entry.kind === 'component') return app.addComponent(entry.type, entry.img, x, y);
        if (typeof app.setDrawMode === 'function') app.setDrawMode(false, { notify: false });
        if (entry.kind === 'text') {
            const box = createTextBoxOnCanvas(x, y, '', null, false, { hasBackground: false });
            if (window.setSelectedObject) window.setSelectedObject(box);
            setTimeout(() => startEditing(box), 0);
            return box;
        }
        const el = createIconOnCanvas(entry.type, x, y);
        if (el && window.setSelectedObject) window.setSelectedObject(el);
        return el;
    }

    /** Pointer position on the canvas if it's over the drawing, else just inside the visible corner. */
    function insertionPoint(screenPoint) {
        if (screenPoint && typeof app.canvasPointFromClient === 'function') return app.canvasPointFromClient(screenPoint.x, screenPoint.y);
        const o = getVisibleCanvasOrigin();
        return { x: o.x + 40, y: o.y + 40 };
    }

    // --- The / popup ---
    const panel = document.createElement('div');
    panel.id = 'quickAdd';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Add a component');
    panel.hidden = true;
    panel.innerHTML = `
        <div class="qa-field">
            <i class="bi bi-search" aria-hidden="true"></i>
            <input id="quickAddInput" type="text" placeholder="Add a component, label or icon…" autocomplete="off" spellcheck="false" aria-controls="quickAddList">
            <kbd>Esc</kbd>
        </div>
        <ul id="quickAddList" class="qa-list" role="listbox"></ul>
        <div class="qa-foot"><span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>Enter</kbd> add at the pointer</span></div>`;
    document.body.appendChild(panel);
    const input = panel.querySelector('input');
    const list = panel.querySelector('ul');
    let results = [], active = 0, target = null;

    function renderList() {
        list.innerHTML = '';
        if (!results.length) {
            list.innerHTML = '<li class="qa-empty">Nothing matches. Try a part of the name, like "rak" or "din".</li>';
            return;
        }
        results.forEach((entry, i) => {
            const li = document.createElement('li');
            li.className = 'qa-item' + (i === active ? ' active' : '');
            li.setAttribute('role', 'option');
            li.setAttribute('aria-selected', i === active ? 'true' : 'false');
            const thumb = entry.kind === 'component'
                ? `<img src="${entry.img}" alt="">`
                : entry.kind === 'text'
                    ? '<i class="bi bi-fonts"></i>'
                    : `<span class="material-symbols-outlined">${entry.type}</span>`;
            li.innerHTML = `<span class="qa-thumb">${thumb}</span><span class="qa-name"></span><span class="qa-group"></span>`;
            li.querySelector('.qa-name').textContent = entry.name;
            li.querySelector('.qa-group').textContent = entry.group;
            li.addEventListener('mousemove', () => { if (active !== i) { active = i; highlight(); } });
            li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
            list.appendChild(li);
        });
    }
    function highlight() {
        [...list.children].forEach((li, i) => {
            li.classList.toggle('active', i === active);
            li.setAttribute('aria-selected', i === active ? 'true' : 'false');
        });
        const el = list.children[active];
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }
    function update() {
        results = search(getCatalogue(), input.value);
        active = 0;
        renderList();
    }
    function open() {
        target = pointer ? { ...pointer } : null;
        panel.hidden = false;
        // Next to the pointer when it's over the drawing, otherwise near the top of it.
        const w = panel.offsetWidth || 360, h = 380;
        const view = wrapper.getBoundingClientRect();
        let left = target ? target.x + 12 : view.left + (view.width - w) / 2;
        let top = target ? target.y + 12 : view.top + 60;
        left = Math.max(12, Math.min(left, window.innerWidth - w - 12));
        top = Math.max(12, Math.min(top, window.innerHeight - h - 12));
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        input.value = '';
        update();
        panel.classList.remove('qa-in');
        void panel.offsetWidth; // restart the entrance animation
        panel.classList.add('qa-in');
        input.focus();
    }
    function close() {
        if (panel.hidden) return;
        panel.hidden = true;
        input.blur();
    }
    function choose(i) {
        const entry = results[i];
        if (!entry) return;
        close();
        place(entry, insertionPoint(target));
    }

    input.addEventListener('input', update);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(results.length - 1, active + 1); highlight(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); highlight(); }
        else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    document.addEventListener('mousedown', (e) => { if (!panel.hidden && !panel.contains(e.target)) close(); }, true);

    document.addEventListener('keydown', (e) => {
        if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
        const a = document.activeElement;
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
        e.preventDefault(); // and Firefox's quick find
        open();
    });

    // --- Palette search box ---
    const paletteSearch = document.getElementById('paletteSearch');
    if (paletteSearch) setupPaletteSearch(paletteSearch, (entry) => place(entry, insertionPoint(null)), getCatalogue);
}

/** Filter every palette group at once; restores what was open when cleared. */
function setupPaletteSearch(inputEl, addEntry, getCatalogue) {
    const headers = [...document.querySelectorAll('#palette .palette-dropdown-header')];
    let saved = null; // each group's collapsed state before searching

    function apply() {
        const q = norm(inputEl.value);
        if (q && !saved) saved = headers.map(h => h.classList.contains('collapsed'));
        headers.forEach((header, i) => {
            const content = document.getElementById(header.dataset.target);
            if (!content) return;
            const isIcons = !!content.querySelector('#icon-palette-content');
            if (!q) {
                header.style.display = '';
                content.style.display = '';
                content.querySelectorAll('.palette-item').forEach(it => { it.style.display = ''; });
                if (saved) {
                    header.classList.toggle('collapsed', saved[i]);
                    content.classList.toggle('collapsed', saved[i]);
                }
                return;
            }
            if (isIcons) { header.style.display = 'none'; content.style.display = 'none'; return; }
            let shown = 0;
            content.querySelectorAll('.palette-item:not(.icon-palette-item)').forEach(it => {
                const hit = norm(it.textContent).includes(q) || norm(it.dataset.type).includes(q);
                it.style.display = hit ? '' : 'none';
                if (hit) shown++;
            });
            header.style.display = shown ? '' : 'none';
            content.style.display = shown ? '' : 'none';
            header.classList.toggle('collapsed', !shown);
            content.classList.toggle('collapsed', !shown);
        });
        // Hide whole palette boxes left with nothing in them
        document.querySelectorAll('#palette .palette-dropdown').forEach(box => {
            const anyHeader = [...box.querySelectorAll('.palette-dropdown-header')].some(h => h.style.display !== 'none');
            box.style.display = anyHeader ? '' : 'none';
        });
        if (!q) saved = null;
        const empty = document.getElementById('paletteSearchEmpty');
        if (empty) empty.hidden = !q || headers.some(h => h.style.display !== 'none');
    }

    inputEl.addEventListener('input', apply);
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); inputEl.value = ''; apply(); inputEl.blur(); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            const first = search(getCatalogue(), inputEl.value).find(x => x.kind === 'component');
            if (first) addEntry(first);
        }
    });
}
