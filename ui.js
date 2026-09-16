// ui.js
// Toolbar, help, onboarding, empty state and palette chrome.

import { showNotification, showActionBar } from './utils.js?v=1.22';

const WELCOME_KEY = 'rakoSchematicWelcomeSeen';
const TOUR_KEY = 'rakoSchematicTourSeen';
const EMPTY_STATE_KEY = 'rakoSchematicEmptyStateSeen';

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
           border:1px solid var(--rako-line-dk);border-radius:2px;box-shadow:0 10px 40px rgba(0,0,0,0.30);padding:32px;position:relative;
           transform:scale(.97);transition:transform .2s ease;">
        <button class="app-modal-close" aria-label="Close"
                style="position:absolute;top:16px;right:16px;background:var(--rako-panel);border:1px solid var(--rako-line-dk);border-radius:2px;
                       width:32px;height:32px;font-size:1.3rem;line-height:1;cursor:pointer;color:var(--rako-text-muted);">&times;</button>
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
        `<div style="margin-top:24px;padding-top:18px;border-top:1px solid var(--rako-line);display:flex;gap:10px;flex-wrap:wrap;">
            <button class="btn btn-outline-secondary btn-sm" id="replayTourBtn">Take the guided tour</button>
            <button class="btn btn-outline-secondary btn-sm" id="replayWelcomeBtn">Show the welcome guide again</button>
         </div>`
    );
    overlay.querySelector('#replayWelcomeBtn').onclick = () => { close(); setTimeout(() => openWelcome(true), 240); };
    overlay.querySelector('#replayTourBtn').onclick = () => { close(); setTimeout(startTour, 240); };
}

/* ------------------------------------------------------------------ *
 * Guided tour - a sequence of spotlighted callouts pointing at the
 * actual on-screen position of each part of the UI, computed live
 * (getBoundingClientRect) rather than guessed, so it stays accurate
 * regardless of screen size. Purely visual - it doesn't block clicks
 * on the app underneath - and can be skipped at any point.
 * ------------------------------------------------------------------ */

const TOUR_STEPS = [
    {
        selector: '#palette',
        placement: 'right',
        title: 'Your components',
        body: 'Everything you can drag onto the drawing lives here, grouped by type &mdash; RAKs, DIN modules, keypads, sensors and connectors. Click a group’s heading to expand it.'
    },
    {
        selector: '#drawing-canvas-wrapper',
        placement: 'left',
        title: 'The drawing canvas',
        body: 'Drag components here. They snap to the grid automatically, so everything stays aligned.'
    },
    {
        selector: '#pageTabsBar',
        placement: 'bottom',
        title: 'Pages',
        body: 'Each tab is its own printable page. Click <b>+</b> to add another &mdash; handy for splitting a large job across several sheets.'
    },
    {
        selector: '#drawGridLineBtn',
        placement: 'bottom',
        title: 'Wiring things together',
        body: 'Click here (or press <b>L</b>) to start drawing cables between components, then click from one to the next. Click it again, press <b>Esc</b>, or right-click to stop.'
    },
    {
        selector: '#connectorColourDropdown',
        placement: 'bottom',
        title: 'Cable colour',
        body: 'Pick a cable type before you draw a line &mdash; each type prints in its own colour, with a legend on the printout.'
    },
    {
        selector: '#drawing-toolbar',
        placement: 'right',
        title: 'Labels',
        body: 'Click <b>Label</b> to drop a text box anywhere on the drawing, then type into it.'
    },
    {
        selector: '#project-details',
        placement: 'right',
        title: 'Project details',
        body: 'Fill in your project’s name, date, version and other details here. They’re saved with the drawing and printed in the title block &mdash; the DPU and circuit counters below warn you if a design goes past what the equipment supports.'
    },
    {
        selector: '#toolbarRightGroup',
        placement: 'bottom',
        title: 'Save, undo and print',
        body: '<b>Save File</b> downloads your drawing so you can keep or email it; <b>Load File</b> opens it again. <b>Undo</b>/<b>Redo</b> step back and forward through changes. <b>Print Schematic</b> opens your print dialog &mdash; choose <i>Save as PDF</i> to export.'
    }
];

function markTourSeen() {
    try { localStorage.setItem(TOUR_KEY, '1'); } catch (e) {}
}

export function startTour() {
    document.getElementById('appWelcomeModal')?.remove();
    document.getElementById('appHelpModal')?.remove();
    document.getElementById('tourSpotlight')?.remove();
    document.getElementById('tourCallout')?.remove();

    const spotlight = document.createElement('div');
    spotlight.id = 'tourSpotlight';
    spotlight.style.cssText = [
        'position:fixed', 'z-index:100000', 'pointer-events:none', 'border-radius:2px',
        'transition:top .22s ease, left .22s ease, width .22s ease, height .22s ease'
    ].join(';');
    document.body.appendChild(spotlight);

    const callout = document.createElement('div');
    callout.id = 'tourCallout';
    callout.style.cssText = [
        'position:fixed', 'z-index:100001', 'background:#fff', 'border:1px solid var(--rako-line-dk)',
        'border-radius:2px', 'box-sizing:border-box',
        'box-shadow:0 10px 40px rgba(0,0,0,0.30)', 'padding:20px', 'width:320px',
        'font-family:var(--rako-font)', 'transition:top .22s ease, left .22s ease'
    ].join(';');
    document.body.appendChild(callout);

    let index = 0;

    function endTour() {
        markTourSeen();
        spotlight.remove();
        callout.remove();
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('resize', render);
    }

    function render() {
        const step = TOUR_STEPS[index];
        const target = document.querySelector(step.selector);
        if (!target) { // element not present (e.g. hidden) - skip to the next step
            if (index < TOUR_STEPS.length - 1) { index++; render(); } else { endTour(); }
            return;
        }
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });

        requestAnimationFrame(() => {
            const r = target.getBoundingClientRect();
            const pad = 6;
            spotlight.style.top = (r.top - pad) + 'px';
            spotlight.style.left = (r.left - pad) + 'px';
            spotlight.style.width = (r.width + pad * 2) + 'px';
            spotlight.style.height = (r.height + pad * 2) + 'px';
            spotlight.style.boxShadow = '0 0 0 3px var(--rako-accent), 0 0 0 99999px rgba(1,3,31,0.55)';

            const calloutWidth = 320;
            const calloutHeight = 240;
            const margin = 14;
            let top, left;
            if (step.placement === 'right') {
                top = Math.max(margin, Math.min(r.top, window.innerHeight - calloutHeight - margin));
                left = r.right + margin;
                if (left + calloutWidth + margin > window.innerWidth) left = r.left - calloutWidth - margin;
            } else if (step.placement === 'left') {
                top = Math.max(margin, Math.min(r.top, window.innerHeight - calloutHeight - margin));
                left = r.left - calloutWidth - margin;
                if (left < margin) left = r.right + margin;
            } else { // bottom
                top = r.bottom + margin;
                left = Math.max(margin, Math.min(r.left, window.innerWidth - calloutWidth - margin));
                if (top + calloutHeight + margin > window.innerHeight) top = r.top - calloutHeight - margin;
            }
            // Final safety net: whatever placement logic decided, never let the
            // callout land outside the viewport (small screens, edge targets).
            top = Math.max(margin, Math.min(top, window.innerHeight - calloutHeight - margin));
            left = Math.max(margin, Math.min(left, window.innerWidth - calloutWidth - margin));
            callout.style.top = top + 'px';
            callout.style.left = left + 'px';

            callout.innerHTML = `
                <div style="font-size:0.72rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--rako-accent);margin-bottom:6px;">Step ${index + 1} of ${TOUR_STEPS.length}</div>
                <div style="font-weight:600;font-size:1.05rem;margin-bottom:6px;color:var(--rako-text);">${step.title}</div>
                <div style="color:var(--rako-text-muted);line-height:1.5;font-size:0.92rem;margin-bottom:18px;">${step.body}</div>
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                    <button class="btn btn-link text-decoration-none btn-sm" id="tourSkipBtn" style="color:var(--rako-text-muted);padding-left:0;">Skip tour</button>
                    <div style="display:flex;gap:8px;">
                        <button class="btn btn-outline-secondary btn-sm" id="tourBackBtn"${index === 0 ? ' disabled' : ''}>Back</button>
                        <button class="btn btn-primary btn-sm" id="tourNextBtn">${index === TOUR_STEPS.length - 1 ? 'Done' : 'Next'}</button>
                    </div>
                </div>`;

            callout.querySelector('#tourSkipBtn').onclick = endTour;
            callout.querySelector('#tourBackBtn').onclick = () => { if (index > 0) { index--; render(); } };
            callout.querySelector('#tourNextBtn').onclick = () => {
                if (index < TOUR_STEPS.length - 1) { index++; render(); } else { endTour(); }
            };
        });
    }

    function onKey(e) {
        if (e.key === 'Escape') endTour();
        else if (e.key === 'ArrowRight' && index < TOUR_STEPS.length - 1) { index++; render(); }
        else if (e.key === 'ArrowLeft' && index > 0) { index--; render(); }
    }
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', render);
    render();
}

/* ------------------------------------------------------------------ *
 * First-run welcome
 * ------------------------------------------------------------------ */

export function openWelcome(forced = false) {
    document.getElementById('appWelcomeModal')?.remove();

    const step = (num, title, body) => `
      <div style="display:flex;gap:16px;margin-bottom:20px;align-items:flex-start;">
        <div style="flex-shrink:0;width:32px;height:32px;border-radius:2px;background:var(--rako-accent);color:#fff;
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
        `<div style="margin-top:26px;padding-top:22px;border-top:1px solid var(--rako-line);">
            <button class="btn btn-primary" id="welcomeTourBtn"
                    style="width:100%;padding:18px 22px;font-size:1.15rem;font-weight:600;border-radius:2px;
                           display:flex;align-items:center;justify-content:center;gap:10px;">
                <i class="bi bi-signpost-split" style="font-size:1.3rem;"></i>
                Take the guided tour
            </button>
            <p style="color:var(--rako-text-muted);font-size:0.85rem;margin:10px 0 16px;text-align:center;">
                A quick walkthrough that points at each part of the screen and explains what it does.
            </p>
            <div style="display:flex;justify-content:center;gap:22px;">
                <button class="btn btn-link text-decoration-none btn-sm" id="welcomeSkipBtn" style="color:var(--rako-text-muted);">Skip, start drawing</button>
                <button class="btn btn-link text-decoration-none btn-sm" id="welcomeHelpBtn" style="color:var(--rako-text-muted);">See full instructions</button>
            </div>
         </div>`
    );

    const dismiss = () => { try { localStorage.setItem(WELCOME_KEY, '1'); } catch (e) {} };
    overlay.querySelector('.app-modal-close').addEventListener('click', dismiss);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
    overlay.querySelector('#welcomeTourBtn').onclick = () => { dismiss(); close(); setTimeout(startTour, 240); };
    overlay.querySelector('#welcomeSkipBtn').onclick = () => { dismiss(); markTourSeen(); close(); };
    overlay.querySelector('#welcomeHelpBtn').onclick = () => { dismiss(); close(); setTimeout(openHelp, 240); };
    if (forced) { /* reopened deliberately; still mark as seen on dismiss */ }
}

function maybeShowWelcome() {
    let welcomeSeen = false;
    try { welcomeSeen = localStorage.getItem(WELCOME_KEY) === '1'; } catch (e) { welcomeSeen = true; }
    // Don't interrupt someone who is mid-recovery of an autosaved drawing.
    let hasAutosave = false;
    try { hasAutosave = !!localStorage.getItem('schematicAutoSave'); } catch (e) {}
    if (hasAutosave) return;

    if (!welcomeSeen) {
        setTimeout(() => openWelcome(), 400);
        return;
    }

    // Returning users who dismissed the welcome screen before the guided
    // tour existed would otherwise never learn it's there - offer it once,
    // non-blocking, with an explicit way to dismiss.
    let tourSeen = false;
    try { tourSeen = localStorage.getItem(TOUR_KEY) === '1'; } catch (e) { tourSeen = true; }
    if (!tourSeen) {
        setTimeout(() => {
            showActionBar({
                message: 'New: a guided tour of the tool is now available.',
                actions: [
                    { label: 'No thanks', onClick: markTourSeen },
                    { label: 'Take the tour', variant: 'btn-primary', onClick: startTour }
                ]
            });
        }, 600);
    }
}

/* ------------------------------------------------------------------ *
 * Canvas empty state
 * ------------------------------------------------------------------ */

function setupEmptyState() {
    const canvas = document.getElementById('drawing-canvas');
    const wrapper = document.getElementById('drawing-canvas-wrapper');
    const palette = document.getElementById('palette');
    if (!canvas || !wrapper) return;

    // Only ever shown on the very first open - once seen (this run), it
    // never comes back, even if the canvas is emptied again later (a
    // cleared drawing, a fresh page tab, etc).
    let seen = false;
    try { seen = localStorage.getItem(EMPTY_STATE_KEY) === '1'; } catch (e) { seen = true; }
    if (seen) return;
    try { localStorage.setItem(EMPTY_STATE_KEY, '1'); } catch (e) {}

    const hint = document.createElement('div');
    hint.id = 'canvasEmptyState';
    hint.innerHTML = `
      <i class="bi bi-arrow-left" style="font-size:1.5rem;opacity:.5;"></i>
      <div>
        <div class="es-title" style="font-weight:600;font-size:1.05rem;color:var(--rako-text);margin-bottom:4px;">Your components are on the left</div>
        <div style="color:var(--rako-text-muted);font-size:0.92rem;">Open a group &mdash; RAKs, DIN, Keypads, Sensors, Connectors &mdash; and drag one onto the grid to get started.</div>
      </div>`;
    wrapper.appendChild(hint);

    // Line the hint up with wherever the palette actually is, rather than a
    // fixed offset, so it still points at the right spot regardless of
    // screen size or how much project-detail content sits above it.
    const alignToPalette = () => {
        if (!palette) return;
        const paletteRect = palette.getBoundingClientRect();
        const wrapperRect = wrapper.getBoundingClientRect();
        const top = Math.max(24, Math.min(
            (paletteRect.top - wrapperRect.top) + 8,
            wrapperRect.height - 100
        ));
        hint.style.top = top + 'px';
    };

    const update = () => {
        const empty = canvas.querySelectorAll('.canvas-item').length === 0;
        hint.style.opacity = empty ? '1' : '0';
        hint.style.visibility = empty ? 'visible' : 'hidden';
        if (empty) alignToPalette();
    };
    update();
    new MutationObserver(update).observe(canvas, { childList: true });
    window.addEventListener('resize', () => {
        if (canvas.querySelectorAll('.canvas-item').length === 0) alignToPalette();
    });
}

/* ------------------------------------------------------------------ *
 * Setup
 * ------------------------------------------------------------------ */

export function setupUI(app) {
    const helpBtn = document.getElementById('helpBtn');
    if (helpBtn) helpBtn.addEventListener('click', openHelp);

    const tourBtn = document.getElementById('tourBtn');
    if (tourBtn) tourBtn.addEventListener('click', startTour);

    app.showNotification = showNotification;
    app.openHelp = openHelp;
    app.startTour = startTour;

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
