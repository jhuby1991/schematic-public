// main.js
// All JavaScript logic from custom.html, excluding dead cloud storage functions and their calls, should be placed here.
// ... (Insert all relevant JS code from custom.html here) ... 

import { setupUI } from './ui.js?v=1.53';
import { setupCanvas } from './canvas.js?v=1.53';
import { setupPalette } from './palette.js?v=1.53';
import { setupStorage, offerAutosaveRecovery } from './storage.js?v=1.53';
import { showNotification, showToast } from './utils.js?v=1.53';
import { setupZoomPan } from './zoom.js?v=1.53';
import { setupStatusBar } from './statusbar.js?v=1.53';
import { setupQuickAdd } from './quickadd.js?v=1.53';
import { setupSales } from './sales.js?v=1.53';
import { handleOldAddress, receiveMovedDrawings } from './moved.js?v=1.53';

const app = {
    // Add shared state or methods here if needed
    showNotification
};

window.app = app;

document.addEventListener('DOMContentLoaded', () => {
    // The old GitHub Pages address: on to the new one (with any drawings saved there).
    if (handleOldAddress()) return;
    window._restoringFromAutosave = true;
    setupUI(app);
    setupCanvas(app);
    setupStorage(app);
    setupPalette(app);
    setupZoomPan();
    setupStatusBar(app);
    setupQuickAdd(app);
    setupSales(app);
    window._restoringFromAutosave = false;
    // Opened by the old address to take its drawings across.
    receiveMovedDrawings((count) => {
        if (!count) return;
        showToast(`Brought ${count === 1 ? 'your drawing' : `${count} drawings`} across from the old address`, 'success', 5000);
        offerAutosaveRecovery(app);
    });
}); 
