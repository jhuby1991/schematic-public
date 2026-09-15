// main.js
// All JavaScript logic from custom.html, excluding dead cloud storage functions and their calls, should be placed here.
// ... (Insert all relevant JS code from custom.html here) ... 

import { setupUI } from './ui.js?v=1.17';
import { setupCanvas } from './canvas.js?v=1.17';
import { setupPalette } from './palette.js?v=1.17';
import { setupStorage } from './storage.js?v=1.17';
import { showNotification } from './utils.js?v=1.17';
import { setupZoomPan } from './zoom.js?v=1.17';

const app = {
    // Add shared state or methods here if needed
    showNotification
};

window.app = app;

document.addEventListener('DOMContentLoaded', () => {
    window._restoringFromAutosave = true;
    setupUI(app);
    setupCanvas(app);
    setupStorage(app);
    setupPalette(app);
    setupZoomPan();
    window._restoringFromAutosave = false;
}); 