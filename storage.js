// storage.js
// Handles local save/load logic.

import { getSchematicData, loadSchematicData } from './canvas.js?v=1.12';
import { showToast, showActionBar } from './utils.js?v=1.12';

export const AUTOSAVE_KEY = 'schematicAutoSave';

export function doAutosave(app) {
    try {
        const data = getSchematicData();
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
        // Autosave is now silent; no notification popup
        // if (app && app.showNotification) app.showNotification('Autosaved');
    } catch (e) {
        // Ignore autosave errors
    }
}

export function setupStorage(app) {
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
                showToast("Couldn't save \u2014 your browser storage may be full or blocked", 'error', 4000);
            }
        });
    }
    if (loadSchematicBtn) {
        loadSchematicBtn.addEventListener('click', () => {
            try {
                const data = localStorage.getItem('schematicToolData');
                if (data) {
                    loadSchematicData(JSON.parse(data));
                    showToast('Drawing restored', 'success');
                } else {
                    showToast('No saved drawing found in this browser', 'info');
                }
            } catch (e) {
                showToast("Couldn't open that saved drawing \u2014 it may be damaged", 'error', 4000);
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
            reader.onload = (e) => {
                try {
                    const data = JSON.parse(e.target.result);
                    loadSchematicData(data);
                    showToast(`Opened ${file.name}`, 'success');
                } catch (err) {
                    showToast("That file isn't a saved schematic, or it's damaged", 'error', 4500);
                } finally {
                    event.target.value = '';
                }
            };
            reader.readAsText(file);
        });
    }

    // --- Print ---
    if (printSchematicBtn) {
        printSchematicBtn.addEventListener('click', async () => {
            // Set document.title to project name and version for print file name
            const originalTitle = document.title;
            const projectName = (projectNameInput?.value || 'schematic').replace(/[^a-z0-9_.-]/gi, '_').toLowerCase();
            const version = versionInput?.value ? `_v${versionInput.value.replace(/[^a-z0-9_.-]/gi, '_')}` : '';
            document.title = `${projectName}${version}`;
            if (window.app && typeof window.app.printAllPages === 'function') {
                await window.app.printAllPages();
            }
            window.print();
            // Restore original title after a short delay
            setTimeout(() => { document.title = originalTitle; }, 1000);
        });
    }

    // --- Autosave recovery (non-blocking) ---
    offerAutosaveRecovery(app);
}

/**
 * If a recent autosave exists, offer to restore it via an in-app bar.
 * Deliberately non-blocking so the tool is usable immediately on load.
 */
export function offerAutosaveRecovery(app) {
    let autosave;
    try {
        const raw = localStorage.getItem(AUTOSAVE_KEY);
        if (!raw) return;
        autosave = JSON.parse(raw);
    } catch (e) {
        return;
    }

    const age = Date.now() - (autosave.timestamp || 0);
    if (age >= 60 * 60 * 1000) {              // older than an hour: discard quietly
        try { localStorage.removeItem(AUTOSAVE_KEY); } catch (e) {}
        return;
    }

    const minutesAgo = Math.floor(age / 60000);
    const when = minutesAgo < 1
        ? 'less than a minute ago'
        : `${minutesAgo} minute${minutesAgo === 1 ? '' : 's'} ago`;

    showActionBar({
        message: `You have an unsaved drawing from ${when}.`,
        actions: [
            {
                label: 'Discard',
                onClick: () => {
                    try { localStorage.removeItem(AUTOSAVE_KEY); } catch (e) {}
                }
            },
            {
                label: 'Restore it',
                variant: 'btn-primary',
                onClick: () => {
                    Promise.resolve(loadSchematicData(autosave.data))
                        .then(() => {
                            setTimeout(() => doAutosave(app), 100);
                            showToast('Drawing restored', 'success');
                        })
                        .catch(() => showToast("Couldn't restore that drawing", 'error', 4000));
                }
            }
        ]
    });
}
