// storage.js
// Keeping work safe: autosave into Recent drawings (drawings.js), Save File
// and Load File, Print, and the status bar's "saved" indicator.

import { getSchematicData, loadSchematicData } from './canvas.js?v=1.48';
import { showToast, showActionBar } from './utils.js?v=1.48';
import { printWithTip } from './ui.js?v=1.48';
import {
    META_PREFIX, contentKey, isBlank, displayName, friendlyTime, newDrawingId,
    listDrawings, readDrawing, writeDrawing, findDrawingByContent, migrateLegacy, openRecentDialog
} from './drawings.js?v=1.48';

/* Autosave is coalesced: the first change schedules one write a moment
   later and any changes in between ride along with it (the write reads the
   drawing as it is when it runs, so nothing is missed). Leaving or hiding
   the page writes straight away. */
const AUTOSAVE_DELAY_MS = 250;
let autosaveTimer = null;
let appRef = null;

// Which kept drawing this window is working on: null until there's
// something worth keeping, then a new id of its own - so new work never
// lands on top of an earlier drawing.
let currentId = null;
let storedKey = null;      // content last written under currentId
let fileKey = null;        // content as last saved to, or opened from, a file
let opening = false;       // a drawing is loading: the canvas is mid-rebuild
let forkOnNextWrite = false; // another window has written to this same drawing
let storageWorks = true;
let warnedStorage = false;
let lastStoredAt = null;
let onNewWorkKept = null;  // closes the "pick up where you left off" bar

function readCurrent() {
    try { return getSchematicData(); } catch (e) { return null; }
}

function writeAutosave() {
    autosaveTimer = null;
    if (opening) return;
    const data = readCurrent();
    if (!data) return;
    const key = contentKey(data);
    if (key !== storedKey) document.dispatchEvent(new CustomEvent('schematic:content')); // e.g. an issue stamp no longer matching
    // Nothing drawn yet: nothing to keep (and a drawing that's been cleared
    // keeps its last real version rather than being blanked).
    if (isBlank(data) || key === storedKey) { renderSaveStatus(data, key); return; }
    const isNew = !currentId || forkOnNextWrite;
    if (isNew) { currentId = newDrawingId(); forkOnNextWrite = false; }
    storageWorks = writeDrawing(currentId, data, { savedToFile: key === fileKey });
    if (storageWorks) {
        storedKey = key;
        lastStoredAt = Date.now();
    } else if (!warnedStorage) {
        warnedStorage = true;
        showToast("This browser isn't keeping an autosave (a private window, or storage is full). Use Save File to keep your work.", 'warning', 8000);
    }
    if (isNew && onNewWorkKept) { const done = onNewWorkKept; onNewWorkKept = null; done(); }
    renderSaveStatus(data, key);
}

export function doAutosave(app) {
    if (autosaveTimer) return;
    autosaveTimer = setTimeout(writeAutosave, AUTOSAVE_DELAY_MS);
}

/** Write any pending autosave now. */
export function flushAutosave() {
    if (!autosaveTimer) return;
    clearTimeout(autosaveTimer);
    writeAutosave();
}
window.addEventListener('pagehide', flushAutosave);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAutosave(); });

// Only warn on leaving when work would really be lost: this browser isn't
// keeping autosaves and the drawing isn't in a file either. Otherwise it's
// in Recent drawings, so leaving is safe and needs no "are you sure?".
window.addEventListener('beforeunload', (e) => {
    flushAutosave();
    if (storageWorks) return;
    const data = readCurrent();
    if (!data || isBlank(data) || contentKey(data) === fileKey) return;
    e.preventDefault();
    e.returnValue = '';
});

// The same drawing open in two windows: rather than the two taking turns
// overwriting each other, this one carries on as a copy of its own.
window.addEventListener('storage', (e) => {
    if (currentId && e.key === META_PREFIX + currentId) forkOnNextWrite = true;
});

const shortTime = (ts) => {
    const d = new Date(ts);
    return d.toDateString() === new Date().toDateString()
        ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

/** The status bar's note of where the drawing is kept. */
function renderSaveStatus(data = readCurrent(), key = data && contentKey(data)) {
    const el = document.getElementById('statusSave');
    if (!el) return;
    if (!data || (isBlank(data) && !currentId)) { el.hidden = true; return; }
    let icon, text, tip, state;
    if (!storageWorks) {
        state = 'warn'; icon = 'bi-exclamation-triangle-fill'; text = 'Not autosaved';
        tip = "This browser isn't letting the tool keep an autosave, for example in a private window. Use Save File to keep your work.";
    } else if (key === fileKey) {
        state = 'file'; icon = 'bi-check2-circle'; text = 'Saved to file';
        tip = 'No changes since the last Save File. Also kept in Recent drawings.';
    } else {
        state = 'auto'; icon = 'bi-clock-history'; text = lastStoredAt ? `Autosaved ${shortTime(lastStoredAt)}` : 'Autosaved';
        tip = 'Kept in this browser under Recent drawings. Use Save File for a copy you can email or open on another computer.';
    }
    el.hidden = false;
    el.dataset.state = state;
    el.dataset.tip = tip + ' Click to see Recent drawings.';
    el.innerHTML = `<i class="bi ${icon}" aria-hidden="true"></i><span></span>`;
    el.querySelector('span').textContent = text;
}

/**
 * Load a drawing onto the canvas. `id` is a kept drawing being reopened;
 * without one (a file, or a new blank drawing) it is kept as its own entry -
 * or, when exactly the same drawing is already kept, carries on with that.
 * Whatever was on screen is stored first, so opening never loses it.
 */
async function openDrawing(data, { id = null, fromFile = false } = {}) {
    flushAutosave();
    opening = true;
    try {
        await loadSchematicData(data);
        if (appRef && typeof appRef.whenSettled === 'function') await appRef.whenSettled();
    } finally {
        opening = false;
    }
    const now = readCurrent();
    const key = now ? contentKey(now) : null;
    forkOnNextWrite = false;
    if (id) {
        const meta = listDrawings().find(m => m.id === id);
        currentId = id;
        storedKey = key; // reopened as it was: no new write until it changes
        fileKey = meta && meta.savedToFile ? key : null;
        lastStoredAt = meta ? meta.updated : null;
    } else {
        const same = key && !isBlank(now) ? findDrawingByContent(key) : null;
        currentId = same ? same.id : null;
        storedKey = null;
        fileKey = fromFile ? key : null;
        lastStoredAt = null;
        doAutosave(); // into Recent drawings straight away
    }
    renderSaveStatus(now, key);
    document.dispatchEvent(new CustomEvent('schematic:content'));
}

/** Open a drawing that came from somewhere else (Rako's register): kept as its own entry, like a file. */
export async function openDrawingData(data) {
    flushAutosave();
    const leaving = currentId ? currentName() : null;
    onNewWorkKept = null;
    await openDrawing(data, { fromFile: true });
    return leaving;
}

function currentName() {
    const data = readCurrent();
    return data ? displayName(data.projectDetails && data.projectDetails.projectName) : '';
}

/** Reopen a kept drawing. */
async function openKept(id) {
    const data = readDrawing(id);
    const meta = listDrawings().find(m => m.id === id);
    if (!data) {
        showToast("Couldn't open that drawing. It may be damaged", 'error', 4000);
        return;
    }
    flushAutosave();
    const leaving = currentId && currentId !== id ? currentName() : null;
    onNewWorkKept = null;
    try {
        await openDrawing(data, { id });
    } catch (e) {
        showToast("Couldn't open that drawing", 'error', 4000);
        return;
    }
    const name = meta ? meta.name : currentName();
    showToast(leaving ? `Opened “${name}”. “${leaving}” is in Recent drawings.` : `Opened “${name}”`, 'success', 3500);
}

const blankDrawing = () => ({
    projectDetails: { projectName: 'Schematic', date: '', version: '1.0', salesperson: '', quoteReference: '' },
    pages: [{ name: 'Tab 1', items: [], connections: [], gridLines: [], rectangles: [] }],
    activePageIndex: 0
});

/** A clean sheet. Whatever was open stays in Recent drawings. */
async function startNewDrawing() {
    flushAutosave();
    const leaving = currentId ? currentName() : null;
    onNewWorkKept = null;
    await openDrawing(blankDrawing());
    currentId = null;
    if (leaving) showToast(`New drawing started. “${leaving}” is in Recent drawings.`, 'success', 3500);
}

export function showRecentDrawings() {
    flushAutosave(); // so the drawing on screen is listed as it is now
    openRecentDialog({ currentId, onOpen: openKept, onNew: startNewDrawing });
}

export function setupStorage(app) {
    appRef = app;
    // --- DOM references ---
    const saveSchematicBtn = document.getElementById('saveSchematicBtn');
    const loadSchematicBtn = document.getElementById('loadSchematicBtn');
    const saveToFileBtn = document.getElementById('saveToFileBtn');
    const loadFromFileBtn = document.getElementById('loadFromFileBtn');
    const fileLoaderInput = document.getElementById('fileLoader');
    const printSchematicBtn = document.getElementById('printSchematicBtn');
    const projectNameInput = document.getElementById('formProjectName');
    const versionInput = document.getElementById('formVersion');

    // --- LocalStorage Save/Load ---
    if (saveSchematicBtn) {
        saveSchematicBtn.addEventListener('click', () => {
            try {
                const data = getSchematicData();
                localStorage.setItem('schematicToolData', JSON.stringify(data));
                showToast('Drawing saved to this browser', 'success');
            } catch (e) {
                showToast("Couldn't save. Your browser storage may be full or blocked", 'error', 4000);
            }
        });
    }
    if (loadSchematicBtn) {
        loadSchematicBtn.addEventListener('click', () => {
            try {
                const data = localStorage.getItem('schematicToolData');
                if (data) {
                    openDrawing(JSON.parse(data)).then(() => showToast('Drawing restored', 'success'));
                } else {
                    showToast('No saved drawing found in this browser', 'info');
                }
            } catch (e) {
                showToast("Couldn't open that saved drawing. It may be damaged", 'error', 4000);
            }
        });
    }

    // --- File Save/Load ---
    if (saveToFileBtn) {
        saveToFileBtn.addEventListener('click', () => {
            try {
                const data = getSchematicData();
                const jsonData = JSON.stringify(data, null, 2);
                const blob = new Blob([jsonData], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const projectName = (projectNameInput?.value || 'schematic').replace(/[^a-z0-9_.-]/gi, '_').toLowerCase();
                const version = versionInput?.value ? `_v${versionInput.value.replace(/[^a-z0-9_.-]/gi, '_')}` : '';
                a.download = `${projectName}${version}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                // This is now the version in a file: the status bar says so,
                // and Recent drawings marks it saved.
                fileKey = contentKey(data);
                storedKey = null;
                flushAutosave();
                writeAutosave();
                showToast(`Saved as ${a.download}`, 'success');
            } catch (e) {
                console.error('Error saving schematic to file:', e);
                showToast("Couldn't save the file. Please try again.", 'error', 4000);
            }
        });
    }
    if (loadFromFileBtn && fileLoaderInput) {
        loadFromFileBtn.addEventListener('click', () => fileLoaderInput.click());
        fileLoaderInput.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (e) => {
                let data;
                try {
                    data = JSON.parse(e.target.result);
                } catch (err) {
                    showToast("That file isn't a saved schematic, or it's damaged", 'error', 4500);
                    event.target.value = '';
                    return;
                }
                event.target.value = '';
                const leaving = currentId ? currentName() : null;
                onNewWorkKept = null;
                try {
                    await openDrawing(data, { fromFile: true });
                    showToast(leaving ? `Opened ${file.name}. “${leaving}” is in Recent drawings.` : `Opened ${file.name}`, 'success', 3500);
                } catch (err) {
                    showToast("That file isn't a saved schematic, or it's damaged", 'error', 4500);
                }
            };
            reader.readAsText(file);
        });
    }

    // --- Print ---
    if (printSchematicBtn) {
        printSchematicBtn.addEventListener('click', () => {
            printWithTip(async () => {
                // Set document.title to project name and version for print file name
                const originalTitle = document.title;
                const projectName = (projectNameInput?.value || 'schematic').replace(/[^a-z0-9_.-]/gi, '_').toLowerCase();
                const version = versionInput?.value ? `_v${versionInput.value.replace(/[^a-z0-9_.-]/gi, '_')}` : '';
                document.title = `${projectName}${version}`;
                if (window.app && typeof window.app.printAllPages === 'function') {
                    // false = the user cancelled the "items will be cut off" warning
                    const proceed = await window.app.printAllPages();
                    if (proceed === false) { document.title = originalTitle; return; }
                }
                window.print();
                // Restore original title after a short delay
                setTimeout(() => { document.title = originalTitle; }, 1000);
            });
        });
    }

    // --- Recent drawings ---
    document.getElementById('recentBtn')?.addEventListener('click', showRecentDrawings);
    document.getElementById('statusSave')?.addEventListener('click', showRecentDrawings);

    // --- Pick up where you left off (non-blocking) ---
    offerAutosaveRecovery(app);
}

/**
 * Offer the most recent drawing, without getting in the way: the tool is
 * usable straight away, and starting something new instead never costs the
 * old one - it stays in Recent drawings, however long ago it was.
 */
export function offerAutosaveRecovery(app) {
    migrateLegacy();
    const recent = listDrawings();
    if (!recent.length) return;
    const last = recent[0];
    const bar = showActionBar({
        message: `Pick up where you left off? “${last.name}”, edited ${friendlyTime(last.updated)}.`,
        actions: [
            ...(recent.length > 1 ? [{ label: `All recent (${recent.length})`, onClick: () => { onNewWorkKept = null; showRecentDrawings(); } }] : []),
            { label: 'New drawing', onClick: () => { onNewWorkKept = null; } },
            { label: 'Continue', variant: 'btn-primary', onClick: () => { onNewWorkKept = null; openKept(last.id); } }
        ]
    });
    // Starting to draw answers the question: the bar steps aside, and the
    // earlier drawing is still there to go back to.
    onNewWorkKept = () => {
        bar.close();
        showToast(`“${last.name}” is still in Recent drawings`, 'info', 4000);
    };
}
