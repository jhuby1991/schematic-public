// storage.js
// Handles local save/load logic.

import { getSchematicData, loadSchematicData } from './canvas.js';

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
    // TODO: Migrate all local save/load, file save/load, and cloud storage (Firebase) logic here from custom.html
    // This includes:
    // - LocalStorage save/load
    // - File save/load
    // - Cloud storage (Firebase) logic
    // - Any storage-specific helpers

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
                alert('Schematic saved successfully to Quick Save!');
            } catch (e) {
                alert('Error saving schematic.');
            }
        });
    }
    if (loadSchematicBtn) {
        loadSchematicBtn.addEventListener('click', () => {
            try {
                const data = localStorage.getItem('schematicToolData');
                if (data) {
                    loadSchematicData(JSON.parse(data));
                    alert('Schematic loaded successfully from Quick Save!');
                } else {
                    alert('No Quick Saved schematic found.');
                }
            } catch (e) {
                alert('Error loading schematic.');
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
            } catch (e) {
                console.error('Error saving schematic to file:', e);
                alert('Error saving schematic to file.');
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
                    alert('Schematic loaded successfully from file!');
                } catch (err) {
                    alert('Error loading schematic from file.');
                }
            };
            reader.readAsText(file);
        });
    }

    // --- Print ---
    if (printSchematicBtn) {
        printSchematicBtn.addEventListener('click', () => {
            // Set document.title to project name and version for print file name
            const originalTitle = document.title;
            const projectName = (projectNameInput?.value || 'schematic').replace(/[^a-z0-9_.-]/gi, '_').toLowerCase();
            const version = versionInput?.value ? `_v${versionInput.value.replace(/[^a-z0-9_.-]/gi, '_')}` : '';
            document.title = `${projectName}${version}`;
            window.print();
            // Restore original title after a short delay
            setTimeout(() => { document.title = originalTitle; }, 1000);
        });
    }

    // --- Autosave ---
    try {
        const autosaveRaw = localStorage.getItem(AUTOSAVE_KEY);
        if (autosaveRaw) {
            const autosave = JSON.parse(autosaveRaw);
            const age = Date.now() - (autosave.timestamp || 0);
            const minutesAgo = Math.floor(age / (1000 * 60));
            if (age < 60 * 60 * 1000) { // less than 1 hour old
                const msg = `Found auto-saved schematic from ${minutesAgo} minute${minutesAgo !== 1 ? 's' : ''} ago.\n\nWould you like to recover your work?\n\nClick OK to recover, or Cancel to start over.`;
                if (confirm(msg)) {
                    loadSchematicData(autosave.data).then(() => setTimeout(() => doAutosave(app), 100));
                    localStorage.removeItem(AUTOSAVE_KEY);
                    if (app.showNotification) app.showNotification('Autosave restored');
                } else {
                    localStorage.removeItem(AUTOSAVE_KEY);
                }
            } else {
                localStorage.removeItem(AUTOSAVE_KEY);
            }
        }
    } catch (e) {
        // Ignore autosave errors
    }
}

export function maybeRestoreAutosave(app) {
    try {
        const autosaveRaw = localStorage.getItem(AUTOSAVE_KEY);
        if (autosaveRaw) {
            const autosave = JSON.parse(autosaveRaw);
            const age = Date.now() - (autosave.timestamp || 0);
            const minutesAgo = Math.floor(age / (1000 * 60));
            if (age < 60 * 60 * 1000) { // less than 1 hour old
                const msg = `Found auto-saved schematic from ${minutesAgo} minute${minutesAgo !== 1 ? 's' : ''} ago.\n\nWould you like to recover your work?\n\nClick OK to recover, or Cancel to start over.`;
                if (confirm(msg)) {
                    loadSchematicData(autosave.data).then(() => setTimeout(() => doAutosave(app), 100));
                    localStorage.removeItem(AUTOSAVE_KEY);
                    if (app.showNotification) app.showNotification('Autosave restored');
                } else {
                    localStorage.removeItem(AUTOSAVE_KEY);
                }
            } else {
                localStorage.removeItem(AUTOSAVE_KEY);
            }
        }
    } catch (e) {
        // Ignore autosave errors
    }
} 