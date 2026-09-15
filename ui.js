// ui.js
// Toolbar, help, onboarding, empty state and palette chrome.

import { showNotification } from './utils.js?v=1.17';

const WELCOME_KEY = 'rakoSchematicWelcomeSeen';

/* ------------------------------------------------------------------ *
 * Help
 * ------------------------------------------------------------------ */

const HELP_HTML = `
  <h3>Getting around</h3>
  <ul>
    <li><b>Add a component</b> &mdash; open a group in the left-hand panel, then drag an item onto the grid.</li>
    <li><b>Move it</b> &mdash; drag it. Components snap to the grid so things stay tidy.</li>
    <li><b>Select several</b> &mdash; click an empty part of the grid and drag a box around them.</li>
    <li><b>Remove something</b> &mdash; select it and press <b>Delete</b> or <b>Backspace</b>.</li>
  </ul>

  <h3>Wiring things together</h3>
  <ul>
    <li>Click <b>Draw Line</b> (or press <b>Space</b>) to start drawing cables, then click from one component to another.</li>
    <li>Use <b>Connector Colour</b> to pick the cable type &mdash; each type prints in its own colour with a legend.</li>
    <li>Press <b>Space</b> again to go back to moving components.</li>
  </ul>

  <h3>Labelling</h3>
  <ul>
    <li>Click <b>Label</b> to drop a text box anywhere, then type into it.</li>
    <li>Double-click a <b>TERM</b> or <b>STAR</b> label to cycle through its settings.</li>
    <li>Double-click a RAK to name each of its circuits.</li>
  </ul>

  <h3>Your project details</h3>
  <ul>
    <li>Fill in the fields on the left. They're saved with the drawing and printed in the title block on your PDF.</li>
  </ul>

  <h3>Saving and printing</h3>
  <ul>
    <li><b>Save File</b> downloads your drawing as a file you can keep or email. <b>Load File</b> opens it again later.</li>
    <li>Your work is also kept in this browser automatically, so a refresh or a closed tab won't lose it.</li>
    <li><b>Print Schematic</b> opens your print dialog &mdash; choose <i>Save as PDF</i> to get a PDF.</li>
  </ul>

  <h3>Keyboard shortcuts</h3>
  <ul>
    <li><b>Space</b> &mdash; switch between drawing cables and moving components</li>
    <li><b>Q W A S D R F</b> &mdash; change cable colour while drawing</li>
    <li><b>Ctrl+Z</b> / <b>Ctrl+Y</b> &mdash; undo / redo</li>
    <li><b>Ctrl+C</b> / <b>Ctrl+V</b> &mdash; copy / paste</li>
    <li><b>Delete</b> &mdash; remove what's selected</li>
  </ul>

  <h3>What the names mean</h3>
  <ul>
    <li><b>RAK</b> &mdash; a wall-mounted dimmer rack that powers and controls lighting circuits.</li>
    <li><b>DIN</b> &mdash; modules that clip into a consumer unit or distribution board.</li>
    <li><b>Keypad</b> &mdash; the wall switch people actually press.</li>
    <li><b>DPU</b> &mdash; the number of DIN power units your design is using, against the number available.</li>
    <li><b>Wired RAK Circuits</b> &mdash; how many lighting circuits you've used, against the number available.</li>
  </ul>
  <p style="color:#6c757d;font-size:0.9rem;margin-bottom:0;">
    If either counter turns red you've gone past what the equipment supports &mdash; the message next to it tells you what to add.
  </p>
`;

function buildModal(id, titleHtml, bodyHtml, footerHtml = '') {
    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.style.cssText = [
        'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.55)', 'z-index:99999',
        'display:flex', 'align-items:center', 'justify-content:center', 'padding:20px',
        'opacity:0', 'transition:opacity .2s ease'
    ].join(';');
    overlay.innerHTML = `
      <div class="app-modal-box" style="background:#fff;max-width:720px;width:100%;max-height:88vh;overflow-y:auto;
           border-radius:16px;box-shadow:0 20px 60px rgba(1,3,31,0.3);padding:32px;position:relative;
           transform:scale(.97);transition:transform .2s ease;">
        <button class="app-modal-close" aria-label="Close"
                style="position:absolute;top:16px;right:16px;background:var(--rako-panel);border:none;border-radius:50%;
                       width:36px;height:36px;font-size:1.4rem;line-height:1;cursor:pointer;color:var(--rako-text-muted);">&times;</button>
        <div class="app-modal-head">${titleHtml}</div>
        <div class="app-modal-body">${bodyHtml}</div>
        ${footerHtml}
      </div>`;
    document.body.appendChild(overlay);

    const box = overlay.querySelector('.app-modal-box');
    requestAnimationFrame(() => { overlay.style.opacity = '1'; box.style.transform = 'scale(1)'; });

    const close = () => {
        overlay.style.opacity = '0';
        box.style.transform = 'scale(.97)';
        document.removeEventListener('keydown', onKey);
        setTimeout(() => overlay.remove(), 210);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };

    overlay.querySelector('.app-modal-close').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    document.addEventListener('keydown', onKey);
    return { overlay, close };
}

export function openHelp() {
    document.getElementById('appHelpModal')?.remove();
    const { overlay, close } = buildModal(
        'appHelpModal',
        `<h2 style="margin:0 0 6px;font-size:1.6rem;font-weight:600;">Using the Schematic Tool</h2>
         <p style="color:var(--rako-text-muted);margin:0 0 20px;">Everything you need to draw and print a lighting schematic.</p>`,
        `<div class="help-content">${HELP_HTML}</div>`,
        `<div style="margin-top:24px;padding-top:18px;border-top:1px solid var(--rako-line);">
            <button class="btn btn-outline-secondary btn-sm" id="replayWelcomeBtn">Show the welcome guide again</button>
         </div>`
    );
    overlay.querySelector('#replayWelcomeBtn').onclick = () => { close(); setTimeout(() => openWelcome(true), 240); };
}

/* ------------------------------------------------------------------ *
 * First-run welcome
 * ------------------------------------------------------------------ */

export function openWelcome(forced = false) {
    document.getElementById('appWelcomeModal')?.remove();

    const step = (num, title, body) => `
      <div style="display:flex;gap:16px;margin-bottom:20px;align-items:flex-start;">
        <div style="flex-shrink:0;width:32px;height:32px;border-radius:50%;background:var(--rako-accent);color:#fff;
                    display:flex;align-items:center;justify-content:center;font-weight:600;font-size:0.95rem;">${num}</div>
        <div>
          <div style="font-weight:600;margin-bottom:3px;">${title}</div>
          <div style="color:var(--rako-text-muted);line-height:1.5;font-size:0.95rem;">${body}</div>
        </div>
      </div>`;

    const { overlay, close } = buildModal(
        'appWelcomeModal',
        `<h2 style="margin:0 0 8px;font-size:1.7rem;font-weight:600;">Welcome to the Schematic Tool</h2>
         <p style="color:var(--rako-text-muted);margin:0 0 26px;line-height:1.55;">
           Plan a RAKO lighting system by dragging components onto a grid and wiring them together.
           When you're happy, print it to PDF. It's free to use and nothing is uploaded &mdash; your drawing stays on your computer.
         </p>`,
        step(1, 'Pick your components',
                'Open a group in the left-hand panel &mdash; RAKs, DIN modules, keypads, sensors &mdash; and drag what you need onto the grid.') +
        step(2, 'Wire them up',
                'Click <b>Draw Line</b>, choose a cable colour, then click from one component to the next.') +
        step(3, 'Add your details and print',
                'Fill in the project fields on the left, then <b>Print Schematic</b> and choose <i>Save as PDF</i>.'),
        `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:26px;padding-top:20px;border-top:1px solid var(--rako-line);">
            <button class="btn btn-primary" id="welcomeStartBtn">Start drawing</button>
            <button class="btn btn-link text-decoration-none" id="welcomeHelpBtn" style="color:var(--rako-text-muted);">See full instructions</button>
         </div>`
    );

    const dismiss = () => { try { localStorage.setItem(WELCOME_KEY, '1'); } catch (e) {} };
    overlay.querySelector('.app-modal-close').addEventListener('click', dismiss);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
    overlay.querySelector('#welcomeStartBtn').onclick = () => { dismiss(); close(); };
    overlay.querySelector('#welcomeHelpBtn').onclick = () => { dismiss(); close(); setTimeout(openHelp, 240); };
    if (forced) { /* reopened deliberately; still mark as seen on dismiss */ }
}

function maybeShowWelcome() {
    let seen = false;
    try { seen = localStorage.getItem(WELCOME_KEY) === '1'; } catch (e) { seen = true; }
    // Don't interrupt someone who is mid-recovery of an autosaved drawing.
    let hasAutosave = false;
    try { hasAutosave = !!localStorage.getItem('schematicAutoSave'); } catch (e) {}
    if (!seen && !hasAutosave) setTimeout(() => openWelcome(), 400);
}

/* ------------------------------------------------------------------ *
 * Canvas empty state
 * ------------------------------------------------------------------ */

function setupEmptyState() {
    const canvas = document.getElementById('drawing-canvas');
    const wrapper = document.getElementById('drawing-canvas-wrapper');
    if (!canvas || !wrapper) return;

    const hint = document.createElement('div');
    hint.id = 'canvasEmptyState';
    hint.innerHTML = `
      <i class="bi bi-arrow-left" style="font-size:1.5rem;opacity:.5;"></i>
      <div>
        <div class="es-title" style="font-weight:600;font-size:1.05rem;color:var(--rako-text);margin-bottom:4px;">Your drawing starts here</div>
        <div style="color:var(--rako-text-muted);font-size:0.92rem;">Open a group on the left and drag a component onto the grid.</div>
      </div>`;
    wrapper.appendChild(hint);

    const update = () => {
        const empty = canvas.querySelectorAll('.canvas-item').length === 0;
        hint.style.opacity = empty ? '1' : '0';
        hint.style.visibility = empty ? 'visible' : 'hidden';
    };
    update();
    new MutationObserver(update).observe(canvas, { childList: true });
}

/* ------------------------------------------------------------------ *
 * Setup
 * ------------------------------------------------------------------ */

export function setupUI(app) {
    const helpBtn = document.getElementById('helpBtn');
    if (helpBtn) helpBtn.addEventListener('click', openHelp);

    app.showNotification = showNotification;
    app.openHelp = openHelp;

    // Palette group expand/collapse
    document.querySelectorAll('.palette-dropdown-header').forEach(header => {
        header.addEventListener('click', (e) => {
            e.preventDefault();
            const content = document.getElementById(header.dataset.target);
            if (!content) return;
            const collapsed = content.classList.contains('collapsed');
            content.classList.toggle('collapsed', !collapsed);
            header.classList.toggle('collapsed', !collapsed);
        });
    });

    // Small-screen escape hatch
    const dismissSmall = document.getElementById('dismissSmallScreen');
    if (dismissSmall) {
        dismissSmall.addEventListener('click', () => {
            document.body.classList.add('small-screen-dismissed');
        });
    }

    setupEmptyState();
    maybeShowWelcome();
}
