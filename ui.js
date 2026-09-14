// ui.js
// Handles UI setup, toolbar, modals, and event listeners.
import { showNotification } from './utils.js';

export function setupUI(app) {
    // --- Toolbar event listeners ---
    const helpBtn = document.getElementById('helpBtn');
    if (helpBtn) {
        helpBtn.addEventListener('click', function() {
            let helpModal = document.getElementById('customHelpModal');
            if (!helpModal) {
                helpModal = document.createElement('div');
                helpModal.id = 'customHelpModal';
                helpModal.style.position = 'fixed';
                helpModal.style.top = '0';
                helpModal.style.left = '0';
                helpModal.style.width = '100vw';
                helpModal.style.height = '100vh';
                helpModal.style.background = 'rgba(0,0,0,0.6)';
                helpModal.style.display = 'flex';
                helpModal.style.alignItems = 'center';
                helpModal.style.justifyContent = 'center';
                helpModal.style.zIndex = '99999';
                helpModal.innerHTML = `
                  <div style="background: #fff; max-width: 700px; width: 90vw; max-height: 90vh; overflow-y: auto; border-radius: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.25); padding: 32px 32px 24px 32px; position: relative; font-size: 1.1rem;">
                    <button id="closeCustomHelpModal" style="position: absolute; top: 18px; right: 18px; background: #eee; border: none; border-radius: 50%; width: 36px; height: 36px; font-size: 1.5rem; cursor: pointer;">&times;</button>
                    <h2 style="margin-top:0; margin-bottom: 18px; font-size: 2rem; text-align: center;"><span style='vertical-align:middle;'>&#x2753;</span> How to Use the Schematic Tool</h2>
                    <h3 style="margin-bottom: 8px;">Objects</h3>
                    <ul>
                      <li>Drag and drop objects onto the canvas to position them</li>
                      <li>Set terminations for TERM or STAR by double clicking</li>
                      <li>Copy: <b>Ctrl+C</b>, Paste: <b>Ctrl+V</b></li>
                      <li>Multiple objects can be selected, moved, or deleted using the marquee tool (click and drag; anything in the selection will be highlighted)</li>
                      <li>Delete: <b>Delete</b> or <b>Backspace</b></li>
                      <li>Undo: <b>Ctrl+Z</b>, Redo: <b>Ctrl+Y</b></li>
                    </ul>
                    <h3 style="margin-bottom: 8px;">Project Information</h3>
                    <ul>
                      <li>Enter the information for the drawing in the fields on the left. This information will be saved along with the drawing and will appear in the print preview for saving</li>
                    </ul>
                    <h3 style="margin-bottom: 8px;">Connections</h3>
                    <ul>
                      <li>Once objects are placed, connect them with the relevant connector colour. Select <b>Draw Line</b> to enter line drawing mode and draw where necessary. This can be toggled on/off with the <b>Spacebar</b>. The connectors can be changed using the <b>QWASD</b> keys.</li>
                    </ul>
                    <h3 style="margin-bottom: 8px;">Saving/Loading</h3>
                    <ul>
                      <li>To save a drawing, select <b>Save File</b> which will begin a download. The file name is the project name + version</li>
                      <li>To load a drawing, select <b>Load File</b> and open the file which was saved previously</li>
                      <li>Quick Save/Load stores your schematic in your browser for fast access</li>
                      <li>When refreshing the page, an auto save will be created to prevent accidentally deleting drawings when refreshing/closing tab</li>
                      <li>To save a drawing as a .PDF or to print, select <b>Print Schematic</b>. Select a printer or select 'Save as PDF'</li>
                    </ul>
                    <h3 style="margin-bottom: 8px;">Shortcuts</h3>
                    <ul>
                      <li><b>Ctrl+Z</b>: Undo</li>
                      <li><b>Ctrl+Y</b>: Redo</li>
                      <li><b>Ctrl+C</b>: Copy</li>
                      <li><b>Ctrl+V</b>: Paste</li>
                      <li><b>Q/W/A/S/D</b>: Change connector color</li>
                      <li><b>Space</b>: Toggle Draw Line mode</li>
                    </ul>
                  </div>
                `;
                document.body.appendChild(helpModal);
                document.getElementById('closeCustomHelpModal').onclick = function() {
                  helpModal.remove();
                };
                helpModal.onclick = function(e) {
                  if (e.target === helpModal) helpModal.remove();
                };
            } else {
                helpModal.style.display = 'flex';
            }
        });
    }

    // --- Notification logic ---
    if (!document.getElementById('toolbarNotification')) {
        const notif = document.createElement('div');
        notif.id = 'toolbarNotification';
        notif.style.position = 'fixed';
        notif.style.top = '60px';
        notif.style.left = '50%';
        notif.style.transform = 'translateX(-50%)';
        notif.style.background = 'rgba(40,40,40,0.95)';
        notif.style.color = 'white';
        notif.style.padding = '12px 32px';
        notif.style.borderRadius = '8px';
        notif.style.fontSize = '1.2rem';
        notif.style.zIndex = '99999';
        notif.style.opacity = '0';
        notif.style.pointerEvents = 'none';
        notif.style.transition = 'opacity 0.5s';
        document.body.appendChild(notif);
    }
    app.showNotification = showNotification;

    // --- Dropdown and palette dropdown logic ---
    document.querySelectorAll('.palette-dropdown-header').forEach(header => {
        header.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = header.dataset.target;
            const content = document.getElementById(targetId);
            const icon = header.querySelector('.bi');
            if (content.classList.contains('collapsed')) {
                // Expand
                content.classList.remove('collapsed');
                header.classList.remove('collapsed');
            } else {
                // Collapse
                content.classList.add('collapsed');
                header.classList.add('collapsed');
            }
        });
    });
} 