// canvas.js
// Handles drawing, moving, and editing items on the canvas.

import { setupConnections, startConnection, finishConnection, renderConnections, clearLineSelection, selectLine, getSelectedLineIndices, getConnections, addConnection, updateConnectionLineByIndex, deleteSelectedLine } from './connections.js?v=1.44';
// connections.js is used through these static imports. The handful of
// dynamic import() calls that used to sit in event handlers resolved a
// moment later and out of order - a click that cleared the wire selection
// could land after a selection box had already selected wires.
import { doAutosave } from './storage.js?v=1.44';
import { initTextTool, createTextBoxOnCanvas } from './text.js?v=1.44';
import { initIconTool, createIconOnCanvas, buildIconPalette } from './icons.js?v=1.44';
import { showToast, showConfirm } from './utils.js?v=1.44';
import { atPrintScale, atPrintScaleSync } from './zoom.js?v=1.44';

// --- Type Normalization ---
const TYPE_NORMALIZATION_MAP = {
    'DIN-DLI': 'DINDLI'
};

function normalizeType(type) {
    if (!type) return type;
    return TYPE_NORMALIZATION_MAP[type] || type;
}

// --- Undo/Redo State ---
const MAX_HISTORY_SIZE = 250;
let undoStack = [];
let redoStack = [];
let isRestoring = false;
// True for the whole multi-page print build (see buildPrintSheets), not just
// each individual page's isRestoring window. Between per-page renders the
// canvas is still showing a page other than activePageIndex (isRestoring is
// briefly false there too), so a stray autosave - a delayed image load, or
// any other async trigger - is unsafe there just as much as mid-render.
let isBuildingPrintSheets = false;
const DINDLI_DEFAULT_LABEL = 'Up to 64 DALI Ballasts';

// --- Pages (tabs) ---
// Each page is one printable sheet: its own components, connections, grid
// lines and rectangles. The app still has exactly one live canvas/overlay
// pair (see setupCanvas) - switching tabs swaps a page's data in and out of
// it, rather than keeping N separate canvases, so every existing drag/
// select/wire handler keeps working unmodified. Project details are shared
// across all pages, not stored here.
let pages = [];
let activePageIndex = 0;
// Component images still finishing their onload setup (see trackImageSetup).
const pendingImageSetups = new Set();
// Per-page undo/redo history, keyed by page id. `undoStack`/`redoStack`
// above always alias the active page's arrays (see activatePage below).
let pageHistories = {};

function makePageId() {
    return 'page-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}
function makeBlankPage(name) {
    return { id: makePageId(), name, items: [], connections: [], gridLines: [], rectangles: [] };
}

// --- Schematic Save/Load ---
/** Shared project details, common to every page/tab in the file. */
function collectProjectDetails() {
    const projectNameInput = document.getElementById('formProjectName');
    const dateInput = document.getElementById('formDate');
    const versionInput = document.getElementById('formVersion');
    const salespersonInput = document.getElementById('formSalesman');
    const quoteReferenceInput = document.getElementById('formQuoteReference');

    return {
        projectName: projectNameInput ? projectNameInput.value : '',
        date: dateInput ? dateInput.value : '',
        version: versionInput ? versionInput.value : '',
        salesperson: salespersonInput ? salespersonInput.value : '',
        quoteReference: quoteReferenceInput ? quoteReferenceInput.value : ''
    };
}

/**
 * Snapshot of the currently-live canvas: one page's worth of content
 * (items, connections, grid lines, rectangles). Does not include project
 * details, which are shared across pages. Used for undo/redo snapshots and
 * for capturing a page's content before switching away from it.
 */
function getSerializableCanvasState() {
    // Collect all objects
    const drawingCanvas = document.getElementById('drawing-canvas');
    const items = [];
    // Save all generic wrappers and non-textbox canvas items
    Array.from(drawingCanvas.children).forEach(child => {
        // Skip text boxes and icons (handled separately below)
        if (child.classList && (child.classList.contains('canvas-text-box') || child.classList.contains('canvas-icon'))) return;
        // Generic wrapper: absolutely positioned, contains a .canvas-item child
        if (child.style.position === 'absolute' && child.querySelector('.canvas-item')) {
            const obj = child.querySelector('.canvas-item');
            let type = obj.querySelector('img') ? obj.querySelector('img').alt : obj.textContent;
            type = normalizeType(type);
            let imgSrc = obj.querySelector('img') ? obj.querySelector('img').src : null;
            let x = parseInt(child.style.left, 10) || 0;
            let y = parseInt(child.style.top, 10) || 0;
            // Get label from editable text field
            let labelDiv = child.querySelector('.generic-label-editable');
            let labelText = labelDiv ? labelDiv.innerText : '';
            let labels = labelText ? [labelText] : null;
            let termStarState = obj._termStarState || null;
            // Get rotation from wrapper.dataset.rotation
            let rotation = 0;
            if (child.dataset && child.dataset.rotation) {
                rotation = parseInt(child.dataset.rotation, 10) || 0;
            }
            items.push({ type, imgSrc, x, y, labels, termStarState, rotation });
        }
        // Non-generic: .canvas-item direct child
        if (child.classList && child.classList.contains('canvas-item')) {
            let type = child.querySelector('img') ? child.querySelector('img').alt : child.textContent;
            type = normalizeType(type);
            let imgSrc = child.querySelector('img') ? child.querySelector('img').src : null;
            let x = parseInt(child.style.left, 10) || 0;
            let y = parseInt(child.style.top, 10) || 0;
            let labels = null;
            if ([ 'RAK8', 'DIN4C', 'DIN4T', 'DIN8S', 'DINDLI' ].includes(type) && child._outputLabels) labels = [...child._outputLabels];
            let termStarState = child._termStarState || null;
            // Get rotation (from style.transform)
            let rotation = 0;
            const match = child.style.transform && child.style.transform.match(/rotate\(([-\d.]+)deg\)/);
            if (match) rotation = parseInt(match[1], 10) || 0;
            items.push({ type, imgSrc, x, y, labels, termStarState, rotation });
        }
    });
    // Save all text boxes
    Array.from(drawingCanvas.querySelectorAll('.canvas-text-box')).forEach(box => {
        const editable = box.querySelector('.text-editable');
        items.push({
            type: 'TextBox',
            id: box.id,
            x: parseInt(box.style.left, 10) || 0,
            y: parseInt(box.style.top, 10) || 0,
            width: parseInt(box.style.width, 10) || 200,
            html: editable ? editable.innerHTML : '',
            text: editable ? editable.innerText : '',
            fontSize: editable ? parseInt(editable.style.fontSize, 10) || 12 : 12,
            hasBackground: box.style.backgroundColor !== 'transparent'
        });
    });
    // Save all icons
    Array.from(drawingCanvas.querySelectorAll('.canvas-icon')).forEach(iconEl => {
        const glyph = iconEl.querySelector('.material-symbols-outlined');
        items.push({
            type: 'Icon',
            id: iconEl.id,
            x: parseInt(iconEl.style.left, 10) || 0,
            y: parseInt(iconEl.style.top, 10) || 0,
            iconName: iconEl.dataset.iconName,
            size: glyph ? parseInt(glyph.style.fontSize, 10) || 28 : 28,
            color: glyph ? glyph.style.color : '#1A1A1A'
        });
    });
    // Collect all lines
    const svgOverlay = document.getElementById('svg-overlay');
    const connections = Array.from(svgOverlay.querySelectorAll('line')).map(line => ({
        x1: parseInt(line.getAttribute('x1'), 10),
        y1: parseInt(line.getAttribute('y1'), 10),
        x2: parseInt(line.getAttribute('x2'), 10),
        y2: parseInt(line.getAttribute('y2'), 10),
        color: line.getAttribute('stroke'),
        type: line.getAttribute('stroke-dasharray') ? 'dashed' : 'colour'
    }));
    // Collect grid lines (if any, e.g., lines with a special class)
    const gridLines = Array.from(svgOverlay.querySelectorAll('line.grid-line')).map(line => ({
        x1: parseInt(line.getAttribute('x1'), 10),
        y1: parseInt(line.getAttribute('y1'), 10),
        x2: parseInt(line.getAttribute('x2'), 10),
        y2: parseInt(line.getAttribute('y2'), 10),
        color: line.getAttribute('stroke')
    }));
    // Collect hand-drawn rectangles
    const rectangles = Array.from(svgOverlay.querySelectorAll('rect.canvas-rect')).map(r => ({
        x: parseFloat(r.getAttribute('x')),
        y: parseFloat(r.getAttribute('y')),
        width: parseFloat(r.getAttribute('width')),
        height: parseFloat(r.getAttribute('height'))
    }));
    return { items, connections, gridLines, rectangles };
}

/** Refresh the active page's stored content from the currently-live canvas. */
function syncActivePageFromCanvas() {
    // While a page is being programmatically rebuilt (tab switch, undo/redo,
    // print, file load - see renderPageContent), the live canvas is
    // mid-teardown/rebuild: items may be back but connections not yet, or
    // vice versa. Several create/update helpers autosave unconditionally as
    // they run, so autosave can fire in the middle of that rebuild - capturing
    // it here would overwrite the page's real data with a torn snapshot.
    // isBuildingPrintSheets covers the wider window: for the whole print
    // build, the canvas may be showing a page other than activePageIndex
    // even when isRestoring is momentarily false between per-page renders.
    if (isRestoring || isBuildingPrintSheets) return;
    if (!pages[activePageIndex]) return;
    pages[activePageIndex] = { ...pages[activePageIndex], ...getSerializableCanvasState() };
}

// The Rako issue stamp this drawing carries, if a salesperson has issued
// it (sales.js): { code, name, email, issuedAt, localHash }. Saved with the
// drawing; whether it still applies - the drawing unchanged since - is
// worked out from localHash when it's shown or printed.
let drawingIssue = null;
// Only a well-formed stamp is kept: a drawing file is just data, and could
// carry anything in this field.
function validIssue(issue) {
    if (!issue || typeof issue !== 'object' || !/^RK-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(issue.code || '')) return null;
    return {
        code: issue.code,
        name: String(issue.name || '').slice(0, 120),
        email: String(issue.email || '').slice(0, 200),
        issuedAt: Number(issue.issuedAt) || 0,
        localHash: String(issue.localHash || '')
    };
}
export function getDrawingIssue() { return drawingIssue ? { ...drawingIssue } : null; }
export function setDrawingIssue(issue) {
    drawingIssue = validIssue(issue);
    document.dispatchEvent(new CustomEvent('schematic:issue'));
    if (window.app) doAutosave(window.app);
}

export function getSchematicData() {
    syncActivePageFromCanvas();
    const data = {
        projectDetails: collectProjectDetails(),
        pages: pages.map(p => ({ ...p })),
        activePageIndex
    };
    if (drawingIssue) data.issue = { ...drawingIssue };
    return data;
}

export function setupCanvas(app) {
    // Assign loader to window.app after definition
    window.app = window.app || app;
    window.app._realLoadSchematicData = realLoadSchematicData;
    window.app.loadSchematicData = function(data) { return window.app._realLoadSchematicData(data); };

    // Start with a single blank page; a subsequent file/autosave load (if
    // any) replaces this via realLoadSchematicData.
    pages = [makeBlankPage('Tab 1')];
    activePageIndex = 0;
    pageHistories = {};

    // TODO: Migrate all canvas drawing, selection, marquee, grid lines, SVG overlay, and canvas-related event logic here from custom.html
    // This includes:
    // - Drawing lines and shapes
    // - Selection and marquee logic
    // - SVG overlay event listeners
    // - Grid line logic
    // - Canvas click/drag logic
    // - Helper functions for canvas manipulation

    // --- DOM references ---
    const drawGridLineBtn = document.getElementById('drawGridLineBtn');
    const connectorColourDropdown = document.getElementById('connectorColourDropdown');
    const connectorColourOptions = document.querySelectorAll('.connector-color-option');
    const selectedConnectorColourSwatch = document.getElementById('selectedConnectorColorSwatch');
    const pdfPageGuide = document.getElementById('pdf-page-guide');
    let isGridLineDrawing = false;
    let currentLineType = 'colour'; // 'colour' or 'dashed'
    let currentLineColor = 'black';

    // --- Draw Line Mode ---
    // Single source of truth. Every entry point (button, L, Space, Escape,
    // right-click) goes through here, so the button label, the canvas cursor
    // and the notification can never drift out of sync.
    function setDrawMode(on, { notify = true } = {}) {
        on = !!on;
        if (on === isGridLineDrawing) return;
        isGridLineDrawing = on;
        // Draw Line and the Hand tool both claim a plain left-drag on the
        // canvas, so only one can be on at a time (see setPanMode in zoom.js).
        if (on && typeof app.setPanMode === 'function') app.setPanMode(false, { notify: false });
        if (drawGridLineBtn) {
            drawGridLineBtn.classList.toggle('btn-success', on);
            drawGridLineBtn.classList.toggle('btn-primary', !on);
            drawGridLineBtn.innerHTML = on
                ? '<i class="bi bi-pencil-fill"></i><span class="tb-label">Drawing</span><kbd>Esc</kbd>'
                : '<i class="bi bi-pencil"></i><span class="tb-label">Draw Line</span><kbd>L</kbd>';
            drawGridLineBtn.classList.toggle('active', on);
            drawGridLineBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        // The cursor is the mode indicator; see #drawing-canvas.draw-mode.
        const canvasEl = document.getElementById('drawing-canvas');
        if (canvasEl) canvasEl.classList.toggle('draw-mode', on);
        // Abandon a half-drawn line when the mode is exited by keyboard or
        // right-click rather than by completing the drag.
        if (!on && typeof app._cancelTempLine === 'function') app._cancelTempLine();
        if (notify && app.showNotification) {
            app.showNotification(on ? 'Draw Line Mode: ON  (Esc or right-click to exit)' : 'Draw Line Mode: OFF');
        }
        document.dispatchEvent(new CustomEvent('schematic:mode'));
    }
    function toggleDrawMode() { setDrawMode(!isGridLineDrawing); }
    app.setDrawMode = setDrawMode;
    // For the status bar and quick-add: a screen point in canvas units, and
    // adding a component as a drop would (then selecting it).
    app.canvasPointFromClient = (clientX, clientY) => getCanvasCoordinates({ clientX, clientY });
    // Resolves once a freshly loaded drawing has finished setting itself up
    // (component images run their setup on load), so storage.js can take its
    // "as opened" snapshot of the finished drawing rather than a half-built one.
    app.whenSettled = async () => {
        await waitForImageSetups();
        await new Promise(resolve => requestAnimationFrame(() => resolve()));
    };
    app.addComponent = (type, imgSrc, x, y) => {
        if (isGridLineDrawing) setDrawMode(false);
        const obj = createCanvasObject(type, imgSrc, Math.max(0, x), Math.max(0, y));
        if (obj) setSelectedObject(obj);
        return obj;
    };

    if (drawGridLineBtn) {
        drawGridLineBtn.addEventListener('click', toggleDrawMode);
    }

    // --- Connector Colour Dropdown ---
    connectorColourOptions.forEach(option => {
        option.addEventListener('click', function(e) {
            e.preventDefault();
            const colour = this.getAttribute('data-color');
            if (colour === 'dashed') {
                currentLineType = 'dashed';
                setConnectorColor('black');
                if (app.showNotification) app.showNotification('Zone - Dashed');
            } else {
                currentLineType = 'colour';
                setConnectorColor(colour);
            }
        });
    });

    // --- Keyboard Shortcuts for Connector Colour ---
    document.addEventListener('keydown', function(e) {
        // Allow spacebar and shortcuts in input fields, textareas, and any
        // contenteditable (text box labels, generic component labels) -
        // otherwise typing an ordinary label steals keystrokes as app
        // shortcuts (most visibly 'l' and Space, which are also Draw Line
        // toggles here).
        const active = document.activeElement;
        const tag = active && active.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (active && active.isContentEditable)) return;
        switch (e.key.toLowerCase()) {
            case 'q':
                currentLineType = 'colour';
                setConnectorColor('black');
                break;
            case 'w':
                currentLineType = 'colour';
                setConnectorColor('#28a745');
                break;
            case 'a':
                currentLineType = 'colour';
                setConnectorColor('#007bff');
                break;
            case 's':
                currentLineType = 'colour';
                setConnectorColor('orange');
                break;
            case 'd':
                currentLineType = 'colour';
                setConnectorColor('purple');
                break;
            case 'r':
                currentLineType = 'colour';
                setConnectorColor('red');
                if (app.showNotification) app.showNotification('DALI - Red');
                break;
            case 'l':
                e.preventDefault();
                toggleDrawMode();
                break;
            case ' ':
                // Legacy binding, kept so existing muscle memory still works.
                e.preventDefault();
                toggleDrawMode();
                break;
            case 'escape':
                if (isGridLineDrawing) {
                    e.preventDefault();
                    setDrawMode(false);
                }
                break;
            case 'delete':
            case 'backspace':
                // Delete selected line if any (deleteSelection covers it too)
                break;
            case 'f':
                currentLineType = 'dashed';
                setConnectorColor('black'); // Always black for dashed
                if (app.showNotification) app.showNotification('Zone - Dashed');
                break;
        }
    });

    function setConnectorColor(color) {
        currentLineColor = color;
        if (selectedConnectorColourSwatch) selectedConnectorColourSwatch.style.background = color;
        connectorColourOptions.forEach(opt => {
            if (opt.getAttribute('data-color') === color) opt.classList.add('active');
            else opt.classList.remove('active');
        });
    }

    // --- Orange Print Area (pdf-page-guide) ---
    /* ------------------------------------------------------------------
       Printable area
       One source of truth for "what actually fits on the page". Used both
       to draw the on-screen page guide and to fit the drawing at print time.
       ------------------------------------------------------------------ */
    const PRINT_GEOMETRY = {
        pageWidthMm: 297,          // A4 landscape
        pageHeightMm: 210,
        edgeMm: 6,                 // drawing's margin inside the printed frame, left, right and top
        footerMm: 50,              // title block + notes, fixed to the bottom of every sheet (5cm in custom.html)
        footerGapMm: 1.5,          // clear space between the drawing and the footer
        stripMm: 7,                // band at the top of the footer, above its rule: page name, cable legend
        dpi: 96
    };
    const GRID_PX = 10;            // the canvas grid (GRID_SIZE below); the page is a whole number of squares
    const MM_TO_PX = PRINT_GEOMETRY.dpi / 25.4;

    // The @page CSS rule's own margin (0.2cm = 2mm), which the browser
    // insets automatically before body's content box starts.
    const CSS_PAGE_MARGIN_MM = 2;

    /**
     * Where the drawing goes on the printed sheet, in px from the sheet's
     * top-left - and so the size of the page guide on screen, which is this
     * same box. Worked out from the sheet as it actually prints: the frame,
     * an even margin inside it, and the title block fixed to the bottom.
     *
     * It used to be a nominal 10mm margin all round with the drawing then
     * printed hard against the top-left corner, so it never matched: about
     * 20mm went unused on the right and 25mm between the drawing and the
     * title block. It also wasn't a whole number of grid squares (1046.9 x
     * 529.1px), so a component snapped into the right or bottom corner
     * either stopped short of the edge or overhung it by a fraction of a
     * pixel - enough to switch print to shrink-to-fit and move everything.
     */
    function getPrintAreaPx() {
        const { pageWidthMm, pageHeightMm, edgeMm, footerMm, footerGapMm } = PRINT_GEOMETRY;
        const sheetWidth = (pageWidthMm - 2 * CSS_PAGE_MARGIN_MM) * MM_TO_PX;
        const sheetHeight = (pageHeightMm - 2 * CSS_PAGE_MARGIN_MM) * MM_TO_PX;
        const footerTop = sheetHeight - footerMm * MM_TO_PX;
        const width = Math.floor((sheetWidth - 2 * edgeMm * MM_TO_PX) / GRID_PX) * GRID_PX;
        const left = (sheetWidth - width) / 2; // whatever rounding to the grid leaves, split evenly
        const top = left;
        const height = Math.floor((footerTop - footerGapMm * MM_TO_PX - top) / GRID_PX) * GRID_PX;
        return { left, top, width, height };
    }

    /**
     * Full printable page, in px, inside the @page margin - i.e. what a
     * .print-sheet's box should actually be. Computed the same way as
     * getPrintAreaPx() (same PRINT_GEOMETRY), rather than left to the
     * browser to resolve via vh/vw or a height:100% chain: both can resolve
     * against the on-screen viewport rather than the real printed page
     * depending on the exact print pipeline, and a viewport shorter than the
     * page clips content at that boundary ("the bottom half of an object is
     * missing").
     */
    // Shaved off the computed page box so it's never an exact match to the
    // browser's own internal @page content-box math: floating-point mm->px
    // conversion done independently by two different code paths (ours here,
    // Chromium's own layout engine) landing a hair apart, if ours rounds up,
    // is enough to spill a near-empty page's worth of content over into a
    // spurious extra trailing page.
    const PAGE_BOX_SAFETY_PX = 2;

    function getPageBoxPx() {
        const { pageWidthMm, pageHeightMm } = PRINT_GEOMETRY;
        return {
            width:  (pageWidthMm  - 2 * CSS_PAGE_MARGIN_MM) * MM_TO_PX - PAGE_BOX_SAFETY_PX,
            height: (pageHeightMm - 2 * CSS_PAGE_MARGIN_MM) * MM_TO_PX - PAGE_BOX_SAFETY_PX
        };
    }

    function updatePdfPageGuide() {
        const area = getPrintAreaPx();
        const canvasEl = document.getElementById('drawing-canvas');

        if (pdfPageGuide) {
            pdfPageGuide.style.width = `${area.width}px`;
            pdfPageGuide.style.height = `${area.height}px`;
            pdfPageGuide.style.display = 'block';
        }

        // Keep the canvas the same size as the page. Items can still be
        // placed past its edge; print then shrinks the page to take them in.
        if (canvasEl) {
            canvasEl.style.minWidth = `${area.width}px`;
            canvasEl.style.minHeight = `${area.height}px`;
        }
    }
    updatePdfPageGuide();
    window.addEventListener('resize', updatePdfPageGuide);

    // --- Print formatting: info block and colour legend ---
    const printInfoBlockContent = document.getElementById('print-info-block-content');
    const printInfoBlockTemplate = document.getElementById('print-info-block-template');
    const printConnectorLegend = document.getElementById('print-connector-legend');
    const projectNameInput = document.getElementById('formProjectName');
    const dateInput = document.getElementById('formDate');
    const versionInput = document.getElementById('formVersion');
    const salespersonInput = document.getElementById('formSalesman');
    const quoteReferenceInput = document.getElementById('formQuoteReference');

    function renderPrintInfoBlock() {
        if (!printInfoBlockContent || !printInfoBlockTemplate) return;
        printInfoBlockContent.innerHTML = printInfoBlockTemplate.innerHTML;
        // Fill in project info
        const dateValPrint = printInfoBlockContent.querySelector('#printDateVal');
        if(dateValPrint) dateValPrint.textContent = dateInput.value || '';
        const projectNameValPrint = printInfoBlockContent.querySelector('#printProjectNameVal');
        if(projectNameValPrint) projectNameValPrint.textContent = projectNameInput.value || '';
        const versionValPrint = printInfoBlockContent.querySelector('#printVersionVal');
        if(versionValPrint) versionValPrint.textContent = versionInput.value || '';
        const salespersonValPrint = printInfoBlockContent.querySelector('#printSalesmanVal');
        if(salespersonValPrint) salespersonValPrint.textContent = salespersonInput.value || '';
        const quoteRefValPrint = printInfoBlockContent.querySelector('#printQuoteReferenceVal');
        if(quoteRefValPrint) quoteRefValPrint.textContent = quoteReferenceInput.value || '';
        // The Rako issue stamp, only while the drawing is exactly as issued (sales.js)
        if (window.app && typeof window.app.fillIssueStamp === 'function') {
            window.app.fillIssueStamp(printInfoBlockContent.querySelector('#pdfIssueStamp'));
        }
        // Show the info block
        printInfoBlockContent.classList.add('print-visible');
    }

    // The full set of connector types the legend can show, each keyed by
    // how it's actually distinguished on a line: 'zone' by its dashed
    // stroke, everything else by its stroke colour.
    const CONNECTOR_LEGEND_ITEMS = [
        { key: 'zone', label: 'Zone', swatch: '<span class="legend-swatch" style="width: 24px; height: 0; border-bottom: 2px dashed #000; margin-right: 5.4px; display: inline-block;"></span>' },
        { key: 'black', label: 'Default', swatch: '<span class="legend-swatch" style="background:black; width:12.6px; height:12.6px; border-radius:2px; margin-right:5.4px; border:none; display:inline-block;"></span>' },
        { key: '#007bff', label: 'RJ45', swatch: '<span class="legend-swatch" style="background:#007bff; width:12.6px; height:12.6px; border-radius:2px; margin-right:5.4px; border:none; display:inline-block;"></span>' },
        { key: '#28a745', label: 'Rako Wired Network', swatch: '<span class="legend-swatch" style="background:#28a745; width:12.6px; height:12.6px; border-radius:2px; margin-right:5.4px; border:none; display:inline-block;"></span>' },
        { key: 'purple', label: 'DIN Bus', swatch: '<span class="legend-swatch" style="background:purple; width:12.6px; height:12.6px; border-radius:2px; margin-right:5.4px; border:none; display:inline-block;"></span>' },
        { key: 'red', label: 'DALI', swatch: '<span class="legend-swatch" style="background:red; width:12.6px; height:12.6px; border-radius:2px; margin-right:5.4px; border:none; display:inline-block;"></span>' },
        { key: 'orange', label: 'RJ11', swatch: '<span class="legend-swatch" style="background:orange; width:12.6px; height:12.6px; border-radius:2px; margin-right:5.4px; border:none; display:inline-block;"></span>' }
    ];

    // Which connector types actually appear anywhere in the document, across
    // every page - not just the one on screen - so the printed legend only
    // lists what was actually used, not every colour the tool supports.
    function getUsedConnectorKeys() {
        const used = new Set();
        const addFrom = (conns) => {
            (conns || []).forEach(c => used.add(c.type === 'dashed' ? 'zone' : (c.color || 'black')));
        };
        pages.forEach((p, i) => {
            if (i === activePageIndex) {
                const liveConns = Array.from(document.getElementById('svg-overlay').querySelectorAll('line')).map(line => ({
                    color: line.getAttribute('stroke'),
                    type: line.getAttribute('stroke-dasharray') ? 'dashed' : 'colour'
                }));
                addFrom(liveConns);
            } else {
                addFrom(p.connections);
            }
        });
        return used;
    }

    function renderPrintConnectorLegend() {
        if (!printConnectorLegend) return;
        const used = getUsedConnectorKeys();
        const items = CONNECTOR_LEGEND_ITEMS.filter(item => used.has(item.key));
        if (items.length === 0) {
            printConnectorLegend.innerHTML = '';
            printConnectorLegend.classList.add('legend-empty');
            return;
        }
        printConnectorLegend.classList.remove('legend-empty');
        const spans = items.map(item =>
            `<span style="display: flex; align-items: center;">${item.swatch}${item.label}</span>`
        ).join('');
        printConnectorLegend.innerHTML = `
          <div style="display: flex; align-items: center; justify-content: center; gap: 16px; font-size: 8.1pt; font-weight: normal; padding: 0; margin: 0; background: none; border: none; box-shadow: none; width: 100%; position: relative; top: 0;">
            ${spans}
          </div>
        `;
    }

    function cleanupPrintInfoBlock() {
        if (printInfoBlockContent) {
            printInfoBlockContent.classList.remove('print-visible');
            printInfoBlockContent.innerHTML = '';
        }
        if (printConnectorLegend) {
            printConnectorLegend.style.display = 'none';
            printConnectorLegend.innerHTML = '';
        }
    }

    /* ------------------------------------------------------------------
       Fit each page to its own sheet at print time.

       Print produces one .print-sheet per page/tab (see buildPrintSheets
       below), each a clone of #drawing-canvas positioned and scaled to fit
       that page's own content. Without this the canvas printed at 1:1 and
       anything past the page guide was lost off the edge of the sheet.
       ------------------------------------------------------------------ */
    const PRINT_MIN_SCALE = 0.5;   // below this the drawing is too small to read
    let lastPrintScale = 1;

    function getCanvasScale() {
        const canvasEl = document.getElementById('drawing-canvas');
        if (!canvasEl) return 1;
        const t = getComputedStyle(canvasEl).transform;
        if (!t || t === 'none') return 1;
        const m = t.match(/matrix\(([^)]+)\)/);
        if (!m) return 1;
        const a = parseFloat(m[1].split(',')[0]);
        return (Number.isFinite(a) && a !== 0) ? a : 1;
    }

    /** Screen rect covering just the text in a text box, or null if it has none. */
    function textExtent(box) {
        const editable = box.querySelector('.text-editable');
        if (!editable) return null;
        let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
        const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent.trim()) continue;
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
                if (!rect.width && !rect.height) continue;
                l = Math.min(l, rect.left); t = Math.min(t, rect.top);
                r = Math.max(r, rect.right); b = Math.max(b, rect.bottom);
            }
        }
        if (l === Infinity) return null; // an empty label prints nothing
        return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
    }

    /** Bounding box of everything drawn, in untransformed canvas pixels. */
    function getContentBoundsPx() {
        const canvasEl = document.getElementById('drawing-canvas');
        if (!canvasEl) return null;
        const canvasRect = canvasEl.getBoundingClientRect();
        const scale = getCanvasScale();

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, found = false;
        const rects = []; // each item's own box, for the print fit's off-sheet check
        const include = (l, t, r, b, isItem) => {
            if (isItem) rects.push({ left: l, top: t, right: r, bottom: b });
            if (![l, t, r, b].every(Number.isFinite)) return;
            found = true;
            if (l < minX) minX = l;
            if (t < minY) minY = t;
            if (r > maxX) maxX = r;
            if (b > maxY) maxY = b;
        };

        // Components, text boxes and shapes
        canvasEl.querySelectorAll('.canvas-item').forEach(el => {
            // A text box counts as its words, not its box. The box prints
            // invisible and is usually far wider than its text (200px by
            // default), so a short label placed near the right edge used to
            // shrink the whole printed page when only empty space overhung.
            const r = el.classList.contains('canvas-text-box') ? textExtent(el) : el.getBoundingClientRect();
            if (!r || (r.width === 0 && r.height === 0)) return;
            include(
                (r.left   - canvasRect.left) / scale,
                (r.top    - canvasRect.top)  / scale,
                (r.right  - canvasRect.left) / scale,
                (r.bottom - canvasRect.top)  / scale,
                true
            );
        });

        // Connection lines live in canvas coordinates already
        const overlay = document.getElementById('svg-overlay');
        if (overlay) {
            overlay.querySelectorAll('line').forEach(ln => {
                if (ln.classList.contains('temp-line')) return;
                const x1 = parseFloat(ln.getAttribute('x1')), y1 = parseFloat(ln.getAttribute('y1'));
                const x2 = parseFloat(ln.getAttribute('x2')), y2 = parseFloat(ln.getAttribute('y2'));
                include(Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2));
            });
        }

        if (!found) return null;
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY, rects };
    }

    /**
     * What the sheet should frame. The page guide is the drawing area of the
     * printed sheet, so when the whole drawing sits inside it, print 1:1 with
     * the guide's corner on the drawing area's corner, and every object lands
     * exactly where it was placed. Only when something spills outside does
     * this fall back to shrinking the page to fit (computeFitTransform). An
     * empty page is placed 1:1 too.
     */
    const GUIDE_TOLERANCE_PX = 0.5;
    function computePageTransform(bounds, area) {
        if (!bounds || (
            bounds.x >= -GUIDE_TOLERANCE_PX
            && bounds.y >= -GUIDE_TOLERANCE_PX
            && bounds.x + bounds.width  <= area.width  + GUIDE_TOLERANCE_PX
            && bounds.y + bounds.height <= area.height + GUIDE_TOLERANCE_PX)) {
            return { scale: 1, tx: area.left, ty: area.top, transform: `translate(${area.left}px, ${area.top}px)` };
        }
        return computeFitTransform(bounds, area);
    }

    /**
     * Shrink-to-fit, for a drawing that spills past the page guide. The frame
     * is the page itself, stretched just far enough to take in whatever
     * spills over, scaled down into the drawing area from the page's own
     * top-left corner. Everything keeps its place relative to the page: a
     * slight overhang shrinks the page slightly, and nothing else moves.
     *
     * It used to frame only the drawn items and centre them, so a page whose
     * drawing sat towards one side jumped to the middle of the sheet - and
     * every object moved - the moment anything (often a text box) poked past
     * an edge.
     */
    function computeFitTransform(bounds, area) {
        const left = Math.min(0, bounds.x);
        const top = Math.min(0, bounds.y);
        const right = Math.max(area.width, bounds.x + bounds.width);
        const bottom = Math.max(area.height, bounds.y + bounds.height);

        let scale = Math.min(area.width / (right - left), area.height / (bottom - top), 1);
        if (scale < PRINT_MIN_SCALE) scale = PRINT_MIN_SCALE;

        const tx = area.left - left * scale;
        const ty = area.top - top * scale;
        return { scale, tx, ty, transform: `translate(${tx}px, ${ty}px) scale(${scale})` };
    }

    /**
     * Clone the currently-live #drawing-canvas into a single .print-sheet,
     * fitted to the page. #svg-overlay is a DOM child of #drawing-canvas, so
     * the clone's overlay is left untransformed - it inherits the canvas
     * clone's transform visually, and giving it its own would compound it.
     */
    function buildPrintSheet(pageName, pageNum, totalPages) {
        const bounds = getContentBoundsPx();
        const area = getPrintAreaPx();
        const fit = computePageTransform(bounds, area);
        if (fit && fit.scale <= PRINT_MIN_SCALE) lastPrintScale = Math.min(lastPrintScale, fit.scale);

        const sheet = document.createElement('div');
        sheet.className = 'print-sheet';
        const pageBox = getPageBoxPx();
        sheet.style.width = pageBox.width + 'px';
        sheet.style.height = pageBox.height + 'px';

        // The fit never shrinks past PRINT_MIN_SCALE, so a drawing spread wider
        // than that allows is not scaled down any further - the overhang simply
        // falls off the paper, or under the title block. Record what lands
        // outside the space above the title block while its fit is known, so
        // printAllPages() can warn before the print dialog opens rather than
        // leaving it to be found in the PDF.
        const visibleBottom = area.top + area.height + PRINT_GEOMETRY.footerGapMm * MM_TO_PX;
        const offSheet = (fit && bounds && bounds.rects) ? bounds.rects.filter(r => fit.tx + r.left * fit.scale < 0 || fit.ty + r.top * fit.scale < 0 || fit.tx + r.right * fit.scale > pageBox.width || fit.ty + r.bottom * fit.scale > visibleBottom).length : 0;
        if (offSheet > 0) sheet.dataset.clippedItems = String(offSheet);
        if (offSheet > 0) sheet.dataset.pageName = pageName;

        const canvasClone = drawingCanvas.cloneNode(true);
        canvasClone.classList.add('ps-canvas');
        // Selection is a screen affordance. Whatever happened to be selected
        // when Print was pressed would otherwise print with its orange ring
        // (components, labels and shapes) or an orange stroke (connector
        // lines), so the clone is deselected before it is measured.
        canvasClone.querySelectorAll('.selected, .editing').forEach(el => el.classList.remove('selected', 'editing'));
        canvasClone.style.transform = fit.transform;
        sheet.appendChild(canvasClone);

        // The band between the drawing and the title block's rule: the page
        // name on the left (when there's more than one page), the cable
        // legend on the right, lined up with the drawing's own edges. The
        // legend used to sit in the top-right corner, on top of whatever was
        // drawn there.
        const strip = document.createElement('div');
        strip.className = 'print-sheet-strip';
        strip.style.left = area.left + 'px';
        strip.style.width = area.width + 'px';
        strip.style.top = (area.top + area.height + PRINT_GEOMETRY.footerGapMm * MM_TO_PX) + 'px';
        strip.style.height = (PRINT_GEOMETRY.stripMm * MM_TO_PX) + 'px';
        if (totalPages > 1) {
            const tag = document.createElement('div');
            tag.className = 'print-sheet-tag';
            tag.textContent = `Page ${pageNum} of ${totalPages}: ${pageName}`;
            strip.appendChild(tag);
        }
        if (printConnectorLegend && !printConnectorLegend.classList.contains('legend-empty') && printConnectorLegend.innerHTML.trim()) {
            const legend = document.createElement('div');
            legend.className = 'print-sheet-legend';
            legend.innerHTML = printConnectorLegend.innerHTML;
            strip.appendChild(legend);
        }
        if (strip.children.length) sheet.appendChild(strip);
        return sheet;
    }

    /**
     * Wait for every <img> across `sheets` to finish loading (or fail), up
     * to `timeoutMs`. cloneNode() copies <img> tags as-is; it doesn't wait
     * for them, so without this a slow-loading component image (a real CDN,
     * not localhost) could still be mid-fetch when window.print() captures
     * the page, showing up cut off / partially rendered.
     */
    function waitForImages(nodes, timeoutMs = 4000) {
        const pending = [];
        nodes.forEach(node => {
            const imgs = node.tagName === 'IMG' ? [node] : Array.from(node.querySelectorAll('img'));
            imgs.forEach(img => { if (!img.complete) pending.push(img); });
        });
        if (pending.length === 0) return Promise.resolve();
        return Promise.race([
            Promise.all(pending.map(img => new Promise(resolve => {
                img.addEventListener('load', resolve, { once: true });
                img.addEventListener('error', resolve, { once: true }); // don't hang printing on one broken image
            }))),
            new Promise(resolve => setTimeout(resolve, timeoutMs))
        ]);
    }

    /**
     * Material Symbols icons render via a web font ligature (the element's
     * text content, e.g. "bolt", is substituted for the glyph once the font
     * is ready) - until it loads, the icon renders as that literal fallback
     * text instead, at a very different size to the intended glyph. Print's
     * page-fit scale is computed from each item's measured bounding box
     * (see getContentBoundsPx), so if that measurement happens against the
     * oversized fallback text, the whole page gets scaled to accommodate
     * it - then once the font swaps in and the icon shrinks to its real
     * size, everything (icons included) sits somewhere other than where
     * that stale scale put it. Icons are normally already on screen well
     * before printing, so the font is normally already loaded by then, but
     * this closes the race outright rather than relying on that timing.
     */
    function waitForIconFont(timeoutMs = 2500) {
        if (!document.fonts || !document.fonts.load) return Promise.resolve();
        return Promise.race([
            document.fonts.load('24px "Material Symbols Outlined"').then(() => document.fonts.ready).catch(() => {}),
            new Promise(resolve => setTimeout(resolve, timeoutMs))
        ]);
    }

    /**
     * Print sheets are appended directly to <body>, not into a wrapper
     * element: a wrapper's own display mode (block vs contents vs anything
     * else) has repeatedly proven unreliable for print pagination in
     * Chromium, breaking in ways that depend on unrelated CSS elsewhere on
     * the page (body's own display mode, in particular). A plain .print-sheet
     * class is enough to find and clean them up.
     */
    function clearPrintSheets() {
        document.querySelectorAll('.print-sheet').forEach(el => el.remove());
    }

    /**
     * Build one print sheet per page/tab. Sequentially renders each page's
     * data into the live canvas (reusing all normal rendering logic) so it
     * can be measured and cloned, then restores whichever page was actually
     * showing before printing began.
     */
    async function buildPrintSheets() {
        persistActivePage();
        const originalIndex = activePageIndex;
        lastPrintScale = 1;
        isBuildingPrintSheets = true;

        try {
            // Measured at exactly 100% - the scale the drawing is stored and
            // printed at - whatever zoom the screen is showing. The bounds
            // math divides the zoom back out anyway (see getContentBoundsPx),
            // but measuring unzoomed means the printout cannot depend on the
            // view at all, not even through sub-pixel rounding of a scaled
            // layout. The view's zoom and position are put back after.
            await atPrintScale(async () => {
                clearPrintSheets();
                await waitForIconFont(); // before any page's content bounds are measured
                const sheets = [];

                for (let i = 0; i < pages.length; i++) {
                    await renderPageContent(pages[i]);
                    await waitForImageSetups(); // circuit and Term/Star labels are added on image load
                    await new Promise(requestAnimationFrame); // let layout settle before measuring
                    const sheet = buildPrintSheet(pages[i].name, i + 1, pages.length);
                    document.body.appendChild(sheet); // always last in DOM order
                    sheets.push(sheet);
                }
                // Only the actual last sheet should skip the trailing page break;
                // set directly rather than via a :last-child selector, since
                // sheets are siblings of everything else in body now, not a
                // wrapper's only children.
                if (sheets.length) {
                    const last = sheets[sheets.length - 1];
                    last.style.pageBreakAfter = 'auto';
                    last.style.breakAfter = 'auto';
                }

                // Every sheet's component images, plus the print-only artwork
                // (background logo, title block logos), finish loading first.
                await waitForImages([...sheets, ...document.querySelectorAll('#printWatermark, #rakoPrintLogo, #pdfLogoCell img')]);
                await renderPageContent(pages[originalIndex]);
            });
        } finally {
            isBuildingPrintSheets = false;
        }
        renderTabBar();
    }

    // Returns false if the user backed out of the "items will be cut off"
    // warning, in which case the caller must not open the print dialog.
    app.printAllPages = async function() {
        renderPrintInfoBlock();
        renderPrintConnectorLegend();
        await buildPrintSheets();
        const lost = [...document.querySelectorAll('.print-sheet')].filter(el => el.dataset.clippedItems).map(el => ({ name: el.dataset.pageName, count: Number(el.dataset.clippedItems) }));
        const total = lost.reduce((n, pg) => n + pg.count, 0);
        const where = lost.length > 1 ? ' (' + lost.map(pg => pg.name + ': ' + pg.count).join(', ') + ')' : '';
        const message = total + (total === 1 ? ' item' : ' items') + where + ' sit outside the printable area and will not appear on the printout. The drawing is already being printed at its smallest readable size, so it cannot be shrunk further to fit them in. Move them inside the orange page guide to keep them.';
        const proceed = !total || await showConfirm({ title: 'Some items will be cut off', message: message, confirmLabel: 'Print anyway', cancelLabel: 'Cancel', danger: true });
        // Nothing reaches the print dialog when cancelled, so afterprint never
        // fires: undo what was staged for it by hand.
        if (!proceed) { clearPrintSheets(); cleanupPrintInfoBlock(); lastPrintScale = 1; }
        return proceed;
    };

    window.addEventListener('beforeprint', () => {
        renderPrintInfoBlock();
        renderPrintConnectorLegend();
        if (document.querySelector('.print-sheet')) return; // built by the Print button already
        // Native/Ctrl+P print: fall back to a single sheet of whatever page
        // is currently on screen (the full multi-page build only runs from
        // the Print Schematic button, since it needs to await page renders).
        clearPrintSheets();
        atPrintScaleSync(() => {
            const sheet = buildPrintSheet(pages[activePageIndex].name, 1, 1);
            document.body.appendChild(sheet);
        });
    });
    window.addEventListener('afterprint', () => {
        cleanupPrintInfoBlock();
        clearPrintSheets();
        if (lastPrintScale <= PRINT_MIN_SCALE) {
            showToast(
                'One or more pages are wider than the sheet, so they were printed at the smallest readable size. Moving components closer together will print larger.',
                'warning',
                7000
            );
        }
        lastPrintScale = 1;
    });

    // --- Drag-and-drop from palette to canvas ---
    const palette = document.getElementById('palette');
    const drawingCanvas = document.getElementById('drawing-canvas');
    const svgOverlay = document.getElementById('svg-overlay');
    // --- Text tool integration ---
    const addTextBtn = document.getElementById('addTextBtn');
    const textBoxPropertiesPanel = document.getElementById('text-box-properties-panel');
    const textBoxFontSizeInput = document.getElementById('textBoxFontSize');
    const textBoxBoldBtn = document.getElementById('textBoxBoldBtn');
    const textBoxItalicBtn = document.getElementById('textBoxItalicBtn');
    const textBoxUnderlineBtn = document.getElementById('textBoxUnderlineBtn');
    const textBoxColorInput = document.getElementById('textBoxColorInput');
    const textBoxAlignLeftBtn = document.getElementById('textBoxAlignLeftBtn');
    const textBoxAlignCenterBtn = document.getElementById('textBoxAlignCenterBtn');
    const textBoxAlignRightBtn = document.getElementById('textBoxAlignRightBtn');
    const textBoxBulletListBtn = document.getElementById('textBoxBulletListBtn');
    const textBoxNumberListBtn = document.getElementById('textBoxNumberListBtn');
    const textBoxToggleBackgroundInput = document.getElementById('textBoxToggleBackground');
    // State for text tool
    if (!window.itemsOnCanvas) window.itemsOnCanvas = new Map();
    if (!window.selectedItems) window.selectedItems = new Set();
    // Initialize text tool
    initTextTool(
        drawingCanvas,
        addTextBtn,
        textBoxPropertiesPanel,
        {
            fontSizeInput: textBoxFontSizeInput,
            boldBtn: textBoxBoldBtn,
            italicBtn: textBoxItalicBtn,
            underlineBtn: textBoxUnderlineBtn,
            colorInput: textBoxColorInput,
            alignLeftBtn: textBoxAlignLeftBtn,
            alignCenterBtn: textBoxAlignCenterBtn,
            alignRightBtn: textBoxAlignRightBtn,
            bulletListBtn: textBoxBulletListBtn,
            numberListBtn: textBoxNumberListBtn,
            toggleBackgroundInput: textBoxToggleBackgroundInput
        },
        window.itemsOnCanvas,
        window.selectedItems,
        makeDraggable,
        saveState
    );

    // Icon library (Material Symbols)
    const iconPropertiesPanel = document.getElementById('icon-properties-panel');
    const iconSizeInput = document.getElementById('iconSizeInput');
    const iconColorInput = document.getElementById('iconColorInput');
    const iconPaletteContent = document.getElementById('icon-palette-content');
    if (iconPaletteContent) buildIconPalette(iconPaletteContent);
    initIconTool(
        drawingCanvas,
        iconPropertiesPanel,
        { sizeInput: iconSizeInput, colorInput: iconColorInput },
        window.itemsOnCanvas,
        window.selectedItems,
        makeDraggable,
        saveState
    );

    let draggedPaletteItem = null;

    if (palette && drawingCanvas) {
        // Icon palette tiles wire their own dragstart (icon-name payload) in
        // buildIconPalette, and are (re)built dynamically as the search
        // filters, so they're excluded here rather than wired once at setup.
        palette.querySelectorAll('.palette-item:not(.icon-palette-item)').forEach(item => {
            item.addEventListener('dragstart', (e) => {
                draggedPaletteItem = item;
                e.dataTransfer.setData('text/plain', item.dataset.type);
                if (item.dataset.img) {
                    e.dataTransfer.setData('image-src', item.dataset.img);
                }
                e.dataTransfer.effectAllowed = 'copy';
                // Carry the component itself, at the size it will be on the
                // canvas at this zoom, with its top-left corner on the pointer
                // - exactly where it lands when dropped. (The browser's own
                // drag image was the whole palette row, name and all.)
                const ghost = makeDragGhost(item);
                if (ghost) {
                    e.dataTransfer.setDragImage(ghost, 0, 0);
                    setTimeout(() => ghost.remove(), 0);
                }
            });
        });

        // Drops are taken by the scrolling wrapper, not just the canvas: zoomed
        // out, the canvas covers only part of the view, and a component let
        // go over the grey surround should still land where it was dropped.
        // Past the page edge is allowed, as it always has been - print scales
        // the page down to take it in.
        const dropZone = document.getElementById('drawing-canvas-wrapper') || drawingCanvas;
        // Never above or left of the canvas origin, where nothing can be seen.
        const getDropCoordinates = (e) => {
            const coords = getCanvasCoordinates(e);
            return { x: Math.max(0, coords.x), y: Math.max(0, coords.y) };
        };

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            const type = e.dataTransfer.getData('text/plain');
            // Icon tiles are rebuilt on every search keystroke (see
            // buildIconPalette), so they're never covered by the one-time
            // dragstart wiring above that sets draggedPaletteItem - read the
            // drag data directly instead of depending on it for this case.
            if (type === 'Icon') {
                if (isGridLineDrawing) setDrawMode(false);
                const iconName = e.dataTransfer.getData('icon-name');
                const coords = getDropCoordinates(e);
                if (iconName) createIconOnCanvas(iconName, coords.x, coords.y);
                draggedPaletteItem = null;
                return;
            }
            if (draggedPaletteItem) {
                if (isGridLineDrawing) setDrawMode(false); // adding an object reads as "done drawing", not "draw to it"
                const coords = getDropCoordinates(e);
                const imgSrc = e.dataTransfer.getData('image-src');
                createCanvasObject(type, imgSrc, coords.x, coords.y);
                draggedPaletteItem = null;
            }
        });
    }

    function makeDragGhost(item) {
        const img = item.querySelector('img');
        if (!img || !img.complete || !img.naturalWidth) return null;
        const size = getTypeGridSize(normalizeType(item.dataset.type), img);
        const z = getCanvasScale();
        const ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.style.width = (size.width * z) + 'px';
        ghost.style.height = (size.height * z) + 'px';
        const copy = document.createElement('img');
        copy.src = img.src;
        copy.alt = '';
        ghost.appendChild(copy);
        document.body.appendChild(ghost);
        return ghost;
    }

    // --- Grid snapping and type-based sizing ---
    const GRID_SIZE = 10; // Use the original grid size from your custom.html
    const COMPONENT_SCALE = 0.1; // Use the original component scale

    function snapToGrid(x, y) {
        return {
            x: Math.round(x / GRID_SIZE) * GRID_SIZE,
            y: Math.round(y / GRID_SIZE) * GRID_SIZE
        };
    }

    function getTypeGridSize(type, img) {
        // Use the original logic: scale image, then round to grid
        let width = 40, height = 32;
        if (img && img.naturalWidth && img.naturalHeight) {
            width = img.naturalWidth * COMPONENT_SCALE;
            height = img.naturalHeight * COMPONENT_SCALE;
            width = Math.max(GRID_SIZE, Math.round(width / GRID_SIZE) * GRID_SIZE);
            height = Math.max(GRID_SIZE, Math.round(height / GRID_SIZE) * GRID_SIZE);
        }
        // Type-specific overrides
        type = normalizeType(type);
        switch (type) {
            case 'KeypadWCM':
            case 'KeypadEOS':
            case 'KeypadMOD':
            case 'RCM':
            case 'RK-EOS':
            case 'RK-MOD':
                width = 4 * GRID_SIZE; height = 4 * GRID_SIZE; break;
            case 'KeypadMD':
                width = 3 * GRID_SIZE; height = 4 * GRID_SIZE; break;
            case 'RAK8':
            case 'RAKSTAR':
                width = 10 * GRID_SIZE; height = 7 * GRID_SIZE; break;
            case 'RAKLink':
                width = 10 * GRID_SIZE; height = 5 * GRID_SIZE; break;
            case 'HUB':
                width = 5 * GRID_SIZE; height = 5 * GRID_SIZE; break;
            case 'DIN4C':
            case 'DIN4T':
            case 'DIN8S':
            case 'DINLINK':
            case 'DINDLI':
                width = 10 * GRID_SIZE; height = 7 * GRID_SIZE; break;
            case 'DINPSU100':
                width = 5 * GRID_SIZE; height = 6 * GRID_SIZE; break;
            case 'DINCONNECT':
            case 'WKCONNECT':
                width = 4 * GRID_SIZE; height = 2 * GRID_SIZE; break;
            case 'SensorPIR':
                width = 4 * GRID_SIZE; height = 8 * GRID_SIZE; break;
            case 'GenericSingle':
                width = 6 * GRID_SIZE; height = 2 * GRID_SIZE; break;
            case 'GenericDouble':
                width = 7 * GRID_SIZE; height = 2 * GRID_SIZE; break;
            case 'GenericRACUB':
                width = 7 * GRID_SIZE; height = 2 * GRID_SIZE; break;
            case 'Generic1200':
                width = 4 * GRID_SIZE; height = 7 * GRID_SIZE; break;
            case 'LabelWIRELESS':
                width = 2 * GRID_SIZE; height = 2 * GRID_SIZE; break;
            default:
                // Labels and unknown types: 32px height, preserve aspect ratio
                break;
        }
        return { width, height };
    }

    // --- Label rendering and editing for RAK8, RAK-Link, DIN modules ---
    let currentEditingObj = null;
    let currentEditingType = null;
    let currentEditingLabels = null;

    function renderOutputLabels(obj, type, labels) {
        obj.querySelectorAll('.output-label').forEach(el => el.remove());
        obj.querySelectorAll('svg.output-label-lines').forEach(el => el.remove());
        if (!labels) return;
        const width = obj.offsetWidth;
        const height = obj.offsetHeight;
        let count = 0;
        if (type === 'RAK8' || type === 'DIN8S') count = 8;
        else if (type === 'DIN4C' || type === 'DIN4T') count = 4;
        else return;
        // SVG for lines
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('output-label-lines');
        svg.style.position = 'absolute';
        svg.style.left = (width - 2) + 'px'; // align with right edge
        svg.style.top = '0px';
        svg.style.width = '75px';
        svg.style.height = height + 'px';
        svg.style.pointerEvents = 'none';
        svg.style.zIndex = '20';
        obj.appendChild(svg);
        const componentPadding = 2;
        const imageEdgeTopY = componentPadding;
        const imageActualHeight = Math.max(0, height - 2 * componentPadding);
        const labelTextOffsetX = 15;
        const lineLength = 10;
        for (let i = 0; i < count; i++) {
            let labelText = labels[i] && labels[i].trim() !== '' ? labels[i].trim() : '';
            // Only show a label if it is not empty
            if (!labelText) continue;
            const targetY = Math.round(imageEdgeTopY + ((i + 0.5) * (imageActualHeight / count)));
            // Label
            const labelDiv = document.createElement('div');
            labelDiv.className = 'output-label';
            labelDiv.textContent = labelText;
            // Only the computed position is set inline. Appearance (font, padding,
            // line-height, background) belongs to .output-label in the stylesheet,
            // so the @media print rules can override it - inline styles cannot be
            // overridden by a stylesheet without !important on every property.
            labelDiv.style.left = (width + labelTextOffsetX) + 'px';
            // Centre the label's box on its leader line. Box height is
            // font-size x line-height (8 x 1 = 8px), so half of that is 4px.
            labelDiv.style.top = (targetY - 4) + 'px';
            labelDiv.dataset.index = i;
            obj.appendChild(labelDiv);
            // Line
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', '0');
            line.setAttribute('y1', targetY.toString());
            line.setAttribute('x2', lineLength.toString());
            line.setAttribute('y2', targetY.toString());
            line.setAttribute('stroke', '#888');
            line.setAttribute('stroke-width', '1');
            svg.appendChild(line);
        }
        doAutosave(app);
    }

    function renderDindliLabel(obj, labels) {
        obj.querySelectorAll('.dindli-label, .dindli-label-line').forEach(el => el.remove());

        const width = obj.offsetWidth;
        const height = obj.offsetHeight;
        const labelText = (labels && labels[0] != null) ? String(labels[0]).trim() : '';

        // Keep label state even if visually hidden, so save/load can preserve user choice.
        if (!labels) {
            obj._outputLabels = [DINDLI_DEFAULT_LABEL];
        }

        if (!labelText) return;

        const line = document.createElement('div');
        line.className = 'dindli-label-line';
        line.style.position = 'absolute';
        line.style.top = (height / 2) + 'px';
        line.style.left = (width - 2) + 'px';
        line.style.width = '12px';
        line.style.height = '1px';
        line.style.background = '#333';
        line.style.pointerEvents = 'none';
        line.style.transform = 'translateY(-0.5px)';
        line.style.zIndex = '24';
        obj.appendChild(line);

        const label = document.createElement('div');
        label.className = 'dindli-label';
        label.textContent = labelText;
        label.style.position = 'absolute';
        label.style.left = (width + 14) + 'px';
        label.style.top = '50%';
        label.style.transform = 'translateY(-50%)';
        label.style.fontSize = '8px';
        label.style.background = '#fff';
        label.style.padding = '1px 3px';
        label.style.borderRadius = '2px';
        label.style.lineHeight = '1.2';
        label.style.color = '#333';
        label.style.whiteSpace = 'nowrap';
        label.style.pointerEvents = 'auto';
        label.style.userSelect = 'none';
        label.style.cursor = 'pointer';
        label.style.zIndex = '25';
        label.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!obj._outputLabels) obj._outputLabels = [DINDLI_DEFAULT_LABEL];
            openLabelModal(obj, 'DINDLI', obj._outputLabels);
        });
        obj.appendChild(label);
    }

    function openLabelModal(obj, type, labels) {
        if (typeof clearSelection === 'function') clearSelection();
        currentEditingObj = obj;
        currentEditingType = type;
        currentEditingLabels = labels;
        const form = document.getElementById('rak8LabelsForm');
        if (!form) return;
        form.innerHTML = '';
        let count = 0;
        let labelPrefix = 'Circuit';
        if (type === 'RAK8' || type === 'DIN8S') { count = 8; }
        else if (type === 'DIN4C' || type === 'DIN4T') { count = 4; }
        else if (type === 'DINDLI') { count = 1; labelPrefix = 'Label'; }
        else return;
        for (let i = 0; i < count; i++) {
            const div = document.createElement('div');
            div.classList.add('mb-2');
            const labelEl = document.createElement('label');
            labelEl.setAttribute('for', `rak8LabelInput-${i}`);
            labelEl.classList.add('form-label');
            labelEl.textContent = `${labelPrefix} ${i + 1} Label:`;
            const inputEl = document.createElement('input');
            inputEl.type = 'text';
            inputEl.id = `rak8LabelInput-${i}`;
            inputEl.classList.add('form-control', 'form-control-sm');
            let value = labels && labels[i] ? labels[i] : '';
            inputEl.value = value;
            div.appendChild(labelEl);
            div.appendChild(inputEl);
            form.appendChild(div);
        }
        // Show modal (Bootstrap 5)
        const modal = document.getElementById('rak8LabelModal');
        if (modal) {
            if (!modal._bsModal) {
                modal._bsModal = new window.bootstrap.Modal(modal, {});
            }
            modal._bsModal.show();
        }
        // After saving labels in the modal, call doAutosave(app)
        const saveBtn = document.getElementById('saveRak8LabelsBtn');
        if (saveBtn) {
            saveBtn.onclick = function() {
                if (!currentEditingObj || !currentEditingType) return;
                let count = 0;
                let labelPrefix = 'Circuit';
                if (currentEditingType === 'RAK8' || currentEditingType === 'DIN8S') { count = 8; }
                else if (currentEditingType === 'DIN4C' || currentEditingType === 'DIN4T') { count = 4; }
                else if (currentEditingType === 'DINDLI') { count = 1; labelPrefix = 'Label'; }
                else return;
                const newLabels = [];
                for (let i = 0; i < count; i++) {
                    const inputEl = document.getElementById(`rak8LabelInput-${i}`);
                    let val = inputEl ? inputEl.value.trim() : '';
                    // If the value is empty, keep it empty (no label on object)
                    newLabels.push(val);
                }
                // Update and re-render
                currentEditingLabels.splice(0, count, ...newLabels);
                if (currentEditingType === 'DINDLI') {
                    renderDindliLabel(currentEditingObj, currentEditingLabels);
                } else {
                    renderOutputLabels(currentEditingObj, currentEditingType, currentEditingLabels);
                }
                // Hide modal
                const modal = document.getElementById('rak8LabelModal');
                if (modal && modal._bsModal) modal._bsModal.hide();
                currentEditingObj = null;
                currentEditingType = null;
                currentEditingLabels = null;
                doAutosave(app);
            };
        }
    }

    /* Component images finish setting themselves up in their onload handler
       below - final size, circuit labels, the Term/Star label - which runs
       some time after createCanvasObject() returns, even for an image that
       is already cached. Print waits on these (waitForImageSetups) before it
       measures and clones a page; it used to clone straight away, so pages
       printed with or without their circuit and Term/Star labels depending
       on which got there first. */
    function trackImageSetup(img) {
        const done = new Promise(resolve => {
            // Resolved on a timeout, so after every load handler on the
            // image - including the onload property the caller sets after
            // this - has run.
            img.addEventListener('load', () => setTimeout(resolve, 0), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
        });
        pendingImageSetups.add(done);
        done.then(() => pendingImageSetups.delete(done));
    }
    function waitForImageSetups(timeoutMs = 4000) {
        if (pendingImageSetups.size === 0) return Promise.resolve();
        return Promise.race([
            Promise.all([...pendingImageSetups]),
            new Promise(resolve => setTimeout(resolve, timeoutMs)) // never hang printing on one image
        ]);
    }

    /* A rotated component turns about its own centre, as it does on screen.
       The pivot is set inline next to the rotate: the print stylesheet gives
       every component `transform-origin: top left` (for its print scale), and
       without an inline pivot a rotated one swung round its top-left corner
       on paper instead - up to 80px from where it was placed. */
    function applyRotation(obj, deg) {
        obj.style.transform = deg ? `rotate(${deg}deg)` : '';
        obj.style.transformOrigin = deg ? '50% 50%' : '';
    }

    function createCanvasObject(type, imgSrc, x, y, item) {
        type = normalizeType(type);
        if (type === 'TextBox') {
            // Never create a text box here; use createTextBoxOnCanvas instead!
            return null;
        }
        const snapped = snapToGrid(x, y);
        // --- For Generic objects, use a wrapper for label and object ---
        if (type.startsWith('Generic')) {
            const wrapper = document.createElement('div');
            wrapper.style.position = 'absolute';
            wrapper.style.left = snapped.x + 'px';
            wrapper.style.top = snapped.y + 'px';
            wrapper.style.overflow = 'visible';
            wrapper.classList.add('generic-wrapper');
            wrapper.style.transformOrigin = 'top left';
            // The actual object
            const obj = document.createElement('div');
            obj.className = 'canvas-item';
            obj.style.position = 'relative';
            obj.style.left = '0px';
            obj.style.top = '0px';
            obj.style.zIndex = 20;
            obj.draggable = false;
            const size = getTypeGridSize(type);
            obj.style.width = size.width + 'px';
            obj.style.height = size.height + 'px';
            // Restore rotation if present (APPLY TO obj, NOT wrapper)
            let rotation = (item && typeof item.rotation === 'number') ? item.rotation : 0;
            obj.style.transform = rotation ? `rotate(${rotation}deg)` : '';
            wrapper.dataset.rotation = rotation;
            // (Overlay removed)
            // Editable text field above the object
            const editableText = document.createElement('div');
            editableText.contentEditable = 'true';
            editableText.innerText = '';
            editableText.setAttribute('data-placeholder', 'Label...');
            // Restore label if present
            if (item && item.labels && item.labels[0]) {
                editableText.innerText = item.labels[0];
            }
            editableText.style.position = 'absolute';
            editableText.style.left = '0';
            editableText.style.top = '-' + GRID_SIZE + 'px';
            if (type === 'Generic1200') {
                editableText.style.width = (size.width * 2) + 'px';
                editableText.style.left = '-' + (size.width / 2) + 'px';
            } else {
                editableText.style.width = size.width + 'px';
                editableText.style.left = '0';
            }
            editableText.style.height = GRID_SIZE + 'px';
            editableText.style.lineHeight = GRID_SIZE + 'px';
            editableText.style.fontSize = '8pt';
            editableText.style.fontWeight = 'bold';
            editableText.style.color = '#222';
            editableText.style.background = 'rgba(255,255,255,0.8)';
            editableText.style.borderRadius = '3px';
            editableText.style.outline = 'none';
            editableText.style.textAlign = 'center';
            editableText.style.pointerEvents = 'auto';
            editableText.style.userSelect = 'text';
            editableText.style.zIndex = '100';
            editableText.classList.add('generic-label-editable');
            // Counter-rotate label if rotation present
            if (rotation) {
                // For Generic1200, let label rotate with object and move it down by double grid size
                if (type === 'Generic1200') {
                    editableText.style.transform = '';
                    editableText.style.top = (2 * GRID_SIZE) + 'px';
                } else {
                    editableText.style.transform = `rotate(${-rotation}deg)`;
                    // For all other generics, move label down by 1 grid square when rotated
                    editableText.style.top = GRID_SIZE + 'px';
                }
                // Make label fit inside the object when rotated
                if (type === 'Generic1200') {
                    editableText.style.width = (size.width * 2) + 'px';
                    editableText.style.left = '-' + (size.width / 2) + 'px';
                } else {
                    editableText.style.width = size.width + 'px';
                    editableText.style.left = '0';
                }
            } else {
                editableText.style.transform = 'none';
                // Default label width/left and position
                if (type === 'Generic1200') {
                    editableText.style.width = (size.width * 2) + 'px';
                    editableText.style.left = '-' + (size.width / 2) + 'px';
                    editableText.style.top = '-' + GRID_SIZE + 'px';
                } else {
                    editableText.style.width = size.width + 'px';
                    editableText.style.left = '0';
                    editableText.style.top = '-' + GRID_SIZE + 'px';
                }
            }
            // Prevent selection when clicking the label to edit
            editableText.addEventListener('mousedown', (e) => {
                e.stopPropagation();
            });
            editableText.addEventListener('blur', (e) => {
                setTimeout(() => {
                    if (!wrapper.contains(document.activeElement)) {
                        if (wrapper.classList.contains('selected')) {
                            wrapper.classList.remove('selected');
                        }
                        if (obj.classList.contains('selected')) {
                            obj.classList.remove('selected');
                        }
                        if (window.selectedObjects) {
                            window.selectedObjects.delete(wrapper);
                        }
                    }
                }, 0);
            });
            editableText.addEventListener('input', () => {
                if (typeof saveState === 'function') saveState();
            });
            // Deselect object when label is focused for editing
            editableText.addEventListener('focus', () => {
                wrapper.classList.remove('selected');
                obj.classList.remove('selected');
                // Use the local selectedObjects set to clear selection
                if (selectedObjects) {
                    selectedObjects.delete(wrapper);
                    selectedObjects.delete(obj);
                }
            });
            wrapper.appendChild(obj);
            wrapper.appendChild(editableText); // label is after object in DOM
            editableText.style.zIndex = '2000'; // ensure label is above
            if (imgSrc) {
                const img = document.createElement('img');
                img.src = imgSrc;
                img.alt = type;
                img.style.position = 'absolute';
                img.style.top = '0';
                img.style.left = '0';
                img.style.width = '100%';
                img.style.height = '100%';
                img.style.objectFit = 'fill';
                obj.appendChild(img);
            }
            // --- Add rotate handle for generics ---
            const rotateHandle = document.createElement('div');
            rotateHandle.className = 'rotate-handle';
            rotateHandle.title = 'Rotate Clockwise';
            rotateHandle.style.position = 'absolute';
            rotateHandle.style.top = '-12px';
            rotateHandle.style.right = '-12px';
            rotateHandle.style.width = '20px';
            rotateHandle.style.height = '20px';
            rotateHandle.style.background = '#fff';
            rotateHandle.style.border = 'none';
            rotateHandle.style.borderRadius = '50%';
            rotateHandle.style.cursor = 'pointer';
            rotateHandle.style.alignItems = 'center';
            rotateHandle.style.justifyContent = 'center';
            rotateHandle.style.zIndex = '200';
            rotateHandle.style.display = 'flex'; // ensure flex centering
            rotateHandle.style.alignItems = 'center';
            rotateHandle.style.justifyContent = 'center';
            rotateHandle.style.padding = '0';
            rotateHandle.style.margin = '0';
            rotateHandle.innerHTML = '<i class="bi bi-arrow-clockwise" style="font-size:14.5px;color:#000;line-height:1;display:flex;align-items:center;justify-content:center;"></i>';
            let currentRotation = rotation;
            rotateHandle.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.preventDefault();
                currentRotation = ((currentRotation + 90) % 360);
                // For GenericDouble, match GenericSingle: do NOT swap width/height on rotation
                obj.style.transform = `rotate(${currentRotation}deg)`;
                const label = wrapper.querySelector('.generic-label-editable');
                if (label) {
                    if (type === 'Generic1200') {
                        label.style.transform = '';
                        label.style.top = (2 * GRID_SIZE) + 'px';
                        label.style.width = (size.width * 2) + 'px';
                        label.style.left = '-' + (size.width / 2) + 'px';
                    } else {
                        label.style.transform = `rotate(${-currentRotation}deg)`;
                        label.style.top = GRID_SIZE + 'px';
                        label.style.width = size.width + 'px';
                        label.style.left = '0';
                    }
                }
                wrapper.dataset.rotation = currentRotation;
                if (typeof saveState === 'function') saveState();
            });
            wrapper.appendChild(rotateHandle);
            // Ensure only one append and one draggable call
            drawingCanvas.appendChild(wrapper);
            makeDraggable(wrapper, true);
            // Update DPU and circuit displays after object is created
            setTimeout(() => {
                updateDPUDisplay();
                updateCircuitDisplay();
            }, 100);
            return wrapper;
        }
        // --- Original logic for all other types ---
        const obj = document.createElement('div');
        obj.className = 'canvas-item';
        obj.dataset.type = type;
        obj.style.position = 'absolute';
        obj.style.zIndex = 20;
        obj.draggable = false;
        let labels = null;
        if (imgSrc) {
            const img = document.createElement('img');
            img.src = imgSrc;
            img.alt = type;
            // Set a placeholder size to avoid flash
            const placeholderSize = getTypeGridSize(type);
            obj.style.width = placeholderSize.width + 'px';
            obj.style.height = placeholderSize.height + 'px';
            obj.style.left = snapped.x + 'px';
            obj.style.top = snapped.y + 'px';
            img.style.width = '100%';
            img.style.height = '100%';
            obj.appendChild(img);
            trackImageSetup(img);
            img.onload = function() {
                const size = getTypeGridSize(type, img);
                obj.style.width = size.width + 'px';
                obj.style.height = size.height + 'px';
                obj.style.left = snapped.x + 'px';
                obj.style.top = snapped.y + 'px';
                // Add output/channel labels for supported types (after append, so offsetWidth/Height are correct)
                if ([ 'RAK8', 'DIN4C', 'DIN4T', 'DIN8S' ].includes(type)) {
                    let count = 0;
                    let labelPrefix = 'Circuit';
                    if (type === 'RAK8' || type === 'DIN8S') { count = 8; }
                    else if (type === 'DIN4C' || type === 'DIN4T') { count = 4; }
                    // Only fill defaults for new objects (no item.labels provided)
                    if (item && item.labels && Array.isArray(item.labels)) {
                        labels = [...item.labels]; // Use saved labels as-is (may include empty strings)
                    } else {
                        labels = Array.from({ length: count }, (_, i) => `${labelPrefix} ${i + 1}`);
                    }
                    obj._outputLabels = labels;
                    renderOutputLabels(obj, type, obj._outputLabels);
                }
                if (type === 'DINDLI') {
                    if (item && item.labels && Array.isArray(item.labels)) {
                        labels = [...item.labels];
                    } else {
                        labels = [DINDLI_DEFAULT_LABEL];
                    }
                    obj._outputLabels = labels;
                    renderDindliLabel(obj, obj._outputLabels);
                }
                // Add Term/Star label for Keypads, WKCONNECT, DINCONNECT, RAKLink, WKPIR, SensorPIR
                if (type.startsWith('Keypad') || type === 'WKCONNECT' || type === 'DINCONNECT' || type === 'RAKLink' || type === 'WKPIR' || type === 'SensorPIR') {
                    const termStar = (item && item.termStarState) ? item.termStarState : 'blank';
                    addTermStarLabel(obj, termStar);
                }
                doAutosave(app);
            };
        } else {
            const size = getTypeGridSize(type);
            obj.style.width = size.width + 'px';
            obj.style.height = size.height + 'px';
            obj.style.left = snapped.x + 'px';
            obj.style.top = snapped.y + 'px';
            obj.textContent = type;
        }
        // --- Add rotate handle for allowed types ---
        const excludedTypes = [
            'TextBox', 'Label', 'RAK8', 'RAKSTAR', 'RAKLink', 'DIN4C', 'DIN4T', 'DIN8S', 'DINLINK', 'DINPSU100',
            'DINCONNECT', 'WKCONNECT', 'DINDLI', 'KeypadWCM', 'KeypadEOS', 'KeypadMOD', 'KeypadMD', 'RCM', 'RK-EOS', 'RK-MOD', 'HUB'
        ];
        // Remove sensor types from excludedTypes so they get rotate handle
        if (!excludedTypes.includes(type) || type === 'SensorPIR' || type === 'WKPIR') {
            // Restore rotation if present
            let rotation = (item && typeof item.rotation === 'number') ? item.rotation : 0;
            applyRotation(obj, rotation);
            const rotateHandle = document.createElement('div');
            rotateHandle.className = 'rotate-handle';
            rotateHandle.title = 'Rotate Clockwise';
            rotateHandle.style.position = 'absolute';
            rotateHandle.style.top = '-12px';
            rotateHandle.style.right = '-12px';
            rotateHandle.style.width = '20px';
            rotateHandle.style.height = '20px';
            rotateHandle.style.background = '#fff';
            rotateHandle.style.border = 'none';
            rotateHandle.style.borderRadius = '50%';
            rotateHandle.style.cursor = 'pointer';
            rotateHandle.style.alignItems = 'center';
            rotateHandle.style.justifyContent = 'center';
            rotateHandle.style.zIndex = '200';
            rotateHandle.style.display = 'flex'; // ensure flex centering
            rotateHandle.style.alignItems = 'center';
            rotateHandle.style.justifyContent = 'center';
            rotateHandle.style.padding = '0';
            rotateHandle.style.margin = '0';
            rotateHandle.innerHTML = '<i class="bi bi-arrow-clockwise" style="font-size:14.5px;color:#000;line-height:1;display:flex;align-items:center;justify-content:center;"></i>';
            let currentRotation = rotation;
            rotateHandle.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.preventDefault();
                currentRotation = ((currentRotation + 90) % 360);
                applyRotation(obj, currentRotation);
                // (This used to go on to adjust a generic's label through a
                // `wrapper` that doesn't exist for these components. The
                // ReferenceError stopped it before saveState(), so a rotation
                // never made it into undo history.)
                if (typeof saveState === 'function') saveState();
            });
            obj.appendChild(rotateHandle);
        }
        drawingCanvas.appendChild(obj);
        // Attach double-click to the object (event delegation)
        if ([ 'RAK8', 'DIN4C', 'DIN4T', 'DIN8S', 'DINDLI' ].includes(type)) {
            // Until the picture loads and sets them up, a new component holds
            // the same default labels it will end up with. It used to hold
            // blanks, and anything saved in that moment - the undo starting
            // point of a freshly opened drawing, in particular - kept them, so
            // undoing straight after opening wiped a RAK8's "Circuit 1-8".
            if (!obj._outputLabels) {
                if (type === 'RAK8' || type === 'DIN8S') obj._outputLabels = Array.from({ length: 8 }, (_, i) => `Circuit ${i + 1}`);
                else if (type === 'DIN4C' || type === 'DIN4T') obj._outputLabels = Array.from({ length: 4 }, (_, i) => `Circuit ${i + 1}`);
                else if (type === 'DINDLI') obj._outputLabels = [DINDLI_DEFAULT_LABEL];
            }
            obj.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                openLabelModal(obj, type, obj._outputLabels);
            });
        }
        // Ensure DIN-DLI never has a rotate handle
        if (type === 'DINDLI') {
            const rotateHandle = obj.querySelector('.rotate-handle');
            if (rotateHandle) rotateHandle.remove();
        }
        // Double-click to cycle Term/Star for Keypads, WKCONNECT, DINCONNECT, RAKLink, WKPIR
        if (type.startsWith('Keypad') || type === 'WKCONNECT' || type === 'DINCONNECT' || type === 'RAKLink' || type === 'WKPIR' || type === 'SensorPIR') {
            obj.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                cycleTermStarLabel(obj);
            });
        }
        // Add permanent label for DINCONNECT and WKCONNECT
        if (type === 'DINCONNECT' || type === 'WKCONNECT') {
            const nameLabel = document.createElement('div');
            nameLabel.textContent = type === 'DINCONNECT' ? 'DIN-CONNECT' : 'WK-CONNECT';
            nameLabel.style.position = 'absolute';
            nameLabel.style.left = '50%';
            nameLabel.style.top = '0px';
            nameLabel.style.transform = 'translate(-50%, -100%)';
            nameLabel.style.fontSize = '7px';
            nameLabel.style.fontFamily = 'Avenir, Arial, sans-serif';
            nameLabel.style.fontWeight = 'normal';
            nameLabel.style.color = '#666';
            nameLabel.style.background = 'none';
            nameLabel.style.borderRadius = '';
            nameLabel.style.padding = '0';
            nameLabel.style.pointerEvents = 'none';
            nameLabel.style.userSelect = 'none';
            nameLabel.style.zIndex = '40';
            nameLabel.style.whiteSpace = 'nowrap';
            nameLabel.style.width = '';
            nameLabel.style.maxWidth = '';
            nameLabel.style.textAlign = 'center';
            nameLabel.style.border = '';
            obj.appendChild(nameLabel);
        }
        // Fix PNG alignment for DINCONNECT and WKCONNECT
        if ((type === 'DINCONNECT' || type === 'WKCONNECT') && imgSrc) {
            const img = obj.querySelector('img');
            if (img) {
                img.style.position = 'absolute';
                img.style.top = '0';
                img.style.left = '0';
                img.style.width = '100%';
                img.style.height = '100%';
                img.style.objectFit = 'contain';
                img.style.margin = '0';
                img.style.padding = '0';
                img.style.display = 'block';
                img.style.background = 'none';
            }
        }
        makeDraggable(obj, false);
        doAutosave(app);
        // Update DPU and circuit displays after object is created
        setTimeout(() => {
            updateDPUDisplay();
            updateCircuitDisplay();
        }, 100);
        return obj;
    }

    function addTermStarLabel(obj, initialState = 'blank') {
        // Remove any existing label to prevent duplicates
        const existing = obj.querySelector('.keypad-term-star-label');
        if (existing) existing.remove();
        const labelDiv = document.createElement('div');
        labelDiv.className = 'keypad-term-star-label';
        labelDiv.textContent = initialState === 'blank' ? '' : initialState;
        labelDiv.style.position = 'absolute';
        labelDiv.style.left = '50%';
        labelDiv.style.transform = 'translateX(-50%)';
        const type = obj.querySelector('img') ? obj.querySelector('img').alt : obj.textContent;
        if (type === 'SensorPIR' || type === 'WKPIR') {
            labelDiv.style.top = (typeof GRID_SIZE !== 'undefined' ? GRID_SIZE : 10) + 'px';
            labelDiv.style.bottom = '';
            labelDiv.style.marginTop = '';
            labelDiv.style.width = '';
            labelDiv.style.height = '';
            labelDiv.style.minWidth = '';
            labelDiv.style.maxWidth = '';
            labelDiv.style.minHeight = '';
            labelDiv.style.maxHeight = '';
            labelDiv.style.display = 'inline-block';
            labelDiv.style.fontSize = '9px';
            labelDiv.style.lineHeight = 'normal';
            labelDiv.style.padding = '0';
            labelDiv.style.background = 'none';
            labelDiv.style.color = '#333';
            labelDiv.style.borderRadius = '0';
            labelDiv.style.whiteSpace = 'nowrap';
            labelDiv.style.boxShadow = 'none';
            // Add a span for the text background
            const span = document.createElement('span');
            span.textContent = labelDiv.textContent;
            labelDiv.textContent = '';
            span.style.background = 'rgba(255,255,255,0.8)';
            span.style.padding = '1px 3px';
            span.style.borderRadius = '2px';
            span.style.color = '#333';
            labelDiv.appendChild(span);
        } else if (type === 'DINCONNECT' || type === 'WKCONNECT') {
            labelDiv.style.top = '100%';
            labelDiv.style.bottom = '';
            labelDiv.style.marginTop = '4px';
        } else {
            labelDiv.style.bottom = '0px';
            labelDiv.style.top = '';
            labelDiv.style.marginTop = '';
        }
        labelDiv.style.zIndex = '30';
        obj.appendChild(labelDiv);
        obj._termStarState = initialState;
    }

    function cycleTermStarLabel(obj) {
        const labelDiv = obj.querySelector('.keypad-term-star-label');
        if (!labelDiv) return;
        let currentState = obj._termStarState || 'blank';
        let nextState;
        if (currentState === 'blank') nextState = 'TERM';
        else if (currentState === 'TERM') nextState = 'STAR';
        else nextState = 'blank';
        obj._termStarState = nextState;
        labelDiv.textContent = nextState === 'blank' ? '' : nextState;
        // Optionally persist to dataset for save/load
        obj.dataset.termStarState = nextState;
        if (typeof saveState === 'function') saveState();
    }

    /* ------------------------------------------------------------------
       Alignment guides
       While a selection is dragged, guides show when its left, centre or
       right edge (or top, middle, bottom) lines up with another item's, or
       with the page's edges and centre lines - and within a few screen
       pixels of one it snaps to it, the way Figma or PowerPoint do. Hold
       Alt while dragging to place freely on the grid alone.
       ------------------------------------------------------------------ */
    const GUIDE_SNAP_SCREEN_PX = 6;
    let guideEls = [];

    /** Visual box of a top-level object (a generic's is its inner item), in canvas units. */
    function visualBox(el, canvasRect, z) {
        const inner = el.classList.contains('generic-wrapper') ? (el.querySelector('.canvas-item') || el) : el;
        const r = inner.getBoundingClientRect();
        if (!r.width && !r.height) return null;
        return { l: (r.left - canvasRect.left) / z, t: (r.top - canvasRect.top) / z, r: (r.right - canvasRect.left) / z, b: (r.bottom - canvasRect.top) / z };
    }

    /** Everything a dragged selection can line up with: other items' boxes, and the page. */
    function collectGuideTargets(excluded, canvasRect, z) {
        const boxes = [];
        Array.from(drawingCanvas.children).forEach(el => {
            if (excluded.has(el)) return;
            if (!(el.classList.contains('canvas-item') || el.classList.contains('generic-wrapper'))) return;
            const b = visualBox(el, canvasRect, z);
            if (b) boxes.push(b);
        });
        const area = getPrintAreaPx();
        boxes.push({ l: 0, t: 0, r: area.width, b: area.height, page: true });
        const xs = [], ys = [];
        boxes.forEach(b => {
            xs.push({ v: b.l, box: b }, { v: (b.l + b.r) / 2, box: b }, { v: b.r, box: b });
            ys.push({ v: b.t, box: b }, { v: (b.t + b.b) / 2, box: b }, { v: b.b, box: b });
        });
        return { xs, ys };
    }

    /** Nearest alignment for the points `gs` (moved by `d`) among `targets`, within `tol`. */
    function nearestAlignment(gs, d, targets, tol) {
        let best = null;
        gs.forEach(g => targets.forEach(c => {
            const off = c.v - (g + d);
            if (Math.abs(off) <= tol && (!best || Math.abs(off) < Math.abs(best.off))) best = { off, v: c.v };
        }));
        return best;
    }

    function clearGuides() {
        guideEls.forEach(el => el.remove());
        guideEls = [];
    }

    /** Draw guides for every exact line-up between `box` and the targets. */
    function showGuides(box, targets, z) {
        clearGuides();
        const thin = 1 / z; // one screen pixel at any zoom
        const draw = (vertical, at, from, to) => {
            const el = document.createElement('div');
            el.className = 'align-guide';
            if (vertical) Object.assign(el.style, { left: (at - thin / 2) + 'px', top: from + 'px', width: thin + 'px', height: (to - from) + 'px' });
            else Object.assign(el.style, { top: (at - thin / 2) + 'px', left: from + 'px', height: thin + 'px', width: (to - from) + 'px' });
            drawingCanvas.appendChild(el);
            guideEls.push(el);
        };
        const pad = 8 / z;
        [[box.l, true], [(box.l + box.r) / 2, true], [box.r, true], [box.t, false], [(box.t + box.b) / 2, false], [box.b, false]].forEach(([v, vertical]) => {
            const hits = (vertical ? targets.xs : targets.ys).filter(c => Math.abs(c.v - v) < 0.5);
            if (!hits.length) return;
            let from = vertical ? box.t : box.l, to = vertical ? box.b : box.r;
            hits.forEach(h => {
                from = Math.min(from, vertical ? h.box.t : h.box.l);
                to = Math.max(to, vertical ? h.box.b : h.box.r);
            });
            draw(vertical, v, from - pad, to + pad);
        });
    }

    // Alt pressed mid-drag means "ignore guides"; without this, letting go of
    // it on Windows can hand focus to the browser's own menu.
    function swallowAltKey(e) {
        if (e.key === 'Alt') e.preventDefault();
    }

    function makeDraggable(target, isGeneric = false) {
        // Prevent native drag-and-drop UI
        target.addEventListener('dragstart', e => e.preventDefault());
        let isDragging = false, dragStartX, dragStartY;
        let dragRoomLeft = Infinity, dragRoomTop = Infinity; // how far the selection can go left/up
        let groupDragData = null;
        let groupLineDragData = null;
        let guideTargets = null, groupBox = null, dragZoom = 1;
        let pendingMove = null, moveFrame = null;
        // Selected before this press? Recorded in the capture phase, before
        // text.js/icons.js select the item themselves - Shift+click needs it.
        let wasSelected = false;
        target.addEventListener('mousedown', () => { wasSelected = selectedObjects.has(target); }, true);
        // Was draw-line mode armed when this gesture started? A component
        // is always draggable/clickable as normal, draw mode or not - the
        // difference is only that armed mode exits once the gesture resolves
        // into a real drag (moving it) or a plain click (selecting it),
        // since either one reads as "I want this object", not "draw a line".
        let startedWhileArmed = false;

        function beginDrag() {
            isDragging = true;
            document.dispatchEvent(new CustomEvent('schematic:drag', { detail: { active: true } }));
            window.addEventListener('keydown', swallowAltKey, true);
            window.addEventListener('keyup', swallowAltKey, true);
            target.style.zIndex = 1000;
            document.body.style.userSelect = 'none';
            if (startedWhileArmed) setDrawMode(false);
            // Measure once per drag; each frame then only compares numbers.
            const canvasRect = drawingCanvas.getBoundingClientRect();
            dragZoom = getCanvasScale();
            const excluded = new Set(groupDragData.map(d => d.obj));
            guideTargets = collectGuideTargets(excluded, canvasRect, dragZoom);
            let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
            groupDragData.forEach(d => {
                const box = visualBox(d.obj, canvasRect, dragZoom);
                if (!box) return;
                l = Math.min(l, box.l); t = Math.min(t, box.t); r = Math.max(r, box.r); b = Math.max(b, box.b);
            });
            groupBox = Number.isFinite(l) ? { l, t, r, b } : null;
        }

        // Positions are worked out at most once per frame, however fast the
        // mouse reports, so a big selection moves without stutter.
        function onMouseMove(e) {
            if (!isDragging) {
                // Check drag threshold
                const coords = getCanvasCoordinates(e);
                const dx = Math.abs(coords.x - dragStartX);
                const dy = Math.abs(coords.y - dragStartY);
                if (dx > 3 || dy > 3) beginDrag();
                else return;
            }
            // Alt (or Ctrl/Cmd, since a lone Alt can open the browser's menu
            // on Windows) places on the grid alone, ignoring guides.
            pendingMove = { clientX: e.clientX, clientY: e.clientY, free: e.altKey || e.ctrlKey || e.metaKey };
            if (!moveFrame) moveFrame = requestAnimationFrame(applyMove);
        }

        function applyMove() {
            moveFrame = null;
            const e = pendingMove;
            if (!e) return;
            pendingMove = null;
            const coords = getCanvasCoordinates(e);
            // Never past the canvas's left or top edge, where nothing can be
            // seen and anything there drags the whole printed page out of
            // place (shrink-to-fit). Applied to the group as one, so a
            // multi-selection keeps its shape against the edge.
            const deltaX = Math.max(coords.x - dragStartX, -dragRoomLeft);
            const deltaY = Math.max(coords.y - dragStartY, -dragRoomTop);
            // Alignment: within a few screen pixels of lining up with
            // something, that axis goes exactly there instead of to the grid.
            let alignX = null, alignY = null;
            if (!e.free && groupBox && guideTargets) {
                const tol = GUIDE_SNAP_SCREEN_PX / dragZoom;
                alignX = nearestAlignment([groupBox.l, (groupBox.l + groupBox.r) / 2, groupBox.r], deltaX, guideTargets.xs, tol);
                alignY = nearestAlignment([groupBox.t, (groupBox.t + groupBox.b) / 2, groupBox.b], deltaY, guideTargets.ys, tol);
                if (alignX && deltaX + alignX.off < -dragRoomLeft) alignX = null;
                if (alignY && deltaY + alignY.off < -dragRoomTop) alignY = null;
            }
            // Move all selected objects by the mouse delta
            let movedX = null, movedY = null;
            groupDragData.forEach(data => {
                const snapped = snapToGrid(data.startLeft + deltaX, data.startTop + deltaY);
                const x = alignX ? data.startLeft + deltaX + alignX.off : snapped.x;
                const y = alignY ? data.startTop + deltaY + alignY.off : snapped.y;
                data.obj.style.left = x + 'px';
                data.obj.style.top = y + 'px';
                if (movedX === null) { movedX = x - data.startLeft; movedY = y - data.startTop; }
            });
            // Move all selected lines by the same delta, snapping to grid
            groupLineDragData.forEach(lineData => {
                const snapped1 = snapToGrid(lineData.x1 + deltaX, lineData.y1 + deltaY);
                const snapped2 = snapToGrid(lineData.x2 + deltaX, lineData.y2 + deltaY);
                lineData.line.setAttribute('x1', snapped1.x);
                lineData.line.setAttribute('y1', snapped1.y);
                lineData.line.setAttribute('x2', snapped2.x);
                lineData.line.setAttribute('y2', snapped2.y);
            });
            // Guides for whatever now lines up exactly, snapped there or not.
            if (groupBox && guideTargets && movedX !== null && !e.free) {
                showGuides({ l: groupBox.l + movedX, r: groupBox.r + movedX, t: groupBox.t + movedY, b: groupBox.b + movedY }, guideTargets, dragZoom);
            } else {
                clearGuides();
            }
        }

        function onMouseUp(e) {
            if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = null; applyMove(); }
            clearGuides();
            if (isDragging) {
                isDragging = false;
                document.dispatchEvent(new CustomEvent('schematic:drag', { detail: { active: false } }));
                window.removeEventListener('keydown', swallowAltKey, true);
                window.removeEventListener('keyup', swallowAltKey, true);
                target.style.zIndex = 20;
                document.body.style.userSelect = '';
                // Update connection data for moved lines
                const svgOverlay = document.getElementById('svg-overlay');
                if (svgOverlay && groupLineDragData && groupLineDragData.length > 0) {
                    groupLineDragData.forEach(lineData => {
                        // Get new endpoints from SVG
                        const x1 = parseInt(lineData.line.getAttribute('x1'), 10);
                        const y1 = parseInt(lineData.line.getAttribute('y1'), 10);
                        const x2 = parseInt(lineData.line.getAttribute('x2'), 10);
                        const y2 = parseInt(lineData.line.getAttribute('y2'), 10);
                        // Update the real data model by index
                        updateConnectionLineByIndex(lineData.index, x1, y1, x2, y2);
                    });
                    renderConnections();
                }
                doAutosave(app);
                saveState(); // Save after move
            } else if (startedWhileArmed) {
                // A plain click (no real drag) on a component while armed:
                // reads as "select this object", not "draw a line from it".
                setDrawMode(false);
            }
            startedWhileArmed = false;
            guideTargets = null;
            groupBox = null;
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        }
        target.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // Only left mouse button
            // A component is always draggable/clickable, draw mode or not -
            // see onMouseMove/onMouseUp above for how armed mode exits once
            // the gesture resolves into a move or a click.
            startedWhileArmed = isGridLineDrawing;
            if (e.shiftKey) {
                // Shift+click adds to the selection, or takes a selected item out of it.
                if (wasSelected) {
                    deselectObject(target);
                    return; // nothing left under the pointer to drag
                }
                selectObjectEl(target);
            } else if (!selectedObjects.has(target)) {
                // Only change selection if you click an unselected object
                selectedObjects.forEach(o => {
                    o.classList.remove('selected');
                    // Also remove from .canvas-item child if generic
                    if (o.classList.contains('canvas-item')) return;
                    const child = o.querySelector('.canvas-item');
                    if (child) child.classList.remove('selected');
                });
                selectedObjects.clear();
                clearLineSelection();
                selectObjectEl(target);
                // This path selects any draggable target directly, bypassing
                // setSelectedObject - text boxes/icons show their own
                // properties panel via their own mousedown handler (which
                // runs first and leaves them already selected here, so this
                // branch is skipped for them), so a fresh selection of
                // anything else needs to clear a stale panel left open.
                if (window.selectedItems) window.selectedItems.clear();
                const staleTextPanel = document.getElementById('text-box-properties-panel');
                if (staleTextPanel) staleTextPanel.style.display = 'none';
                const staleIconPanel = document.getElementById('icon-properties-panel');
                if (staleIconPanel) staleIconPanel.style.display = 'none';
            }
            // If already selected, do not change selection (allow group drag)
            const coords = getCanvasCoordinates(e);
            dragStartX = coords.x;
            dragStartY = coords.y;
            // For each selected object, store its original left/top (canvas-relative)
            groupDragData = Array.from(selectedObjects).filter(o => o.isConnected).map(selObj => {
                return {
                    obj: selObj,
                    startLeft: parseFloat(selObj.style.left) || 0,
                    startTop: parseFloat(selObj.style.top) || 0
                };
            });
            // For each selected line, store its original endpoints and index
            const svgOverlay = document.getElementById('svg-overlay');
            groupLineDragData = [];
            if (svgOverlay) {
                const lines = svgOverlay.querySelectorAll('line');
                getSelectedLineIndices().forEach(idx => {
                    const line = lines[idx];
                    if (line) {
                        groupLineDragData.push({
                            line,
                            x1: parseInt(line.getAttribute('x1'), 10),
                            y1: parseInt(line.getAttribute('y1'), 10),
                            x2: parseInt(line.getAttribute('x2'), 10),
                            y2: parseInt(line.getAttribute('y2'), 10),
                            index: idx
                        });
                    }
                });
            }
            dragRoomLeft = Math.max(0, Math.min(...groupDragData.map(d => d.startLeft), ...groupLineDragData.map(l => Math.min(l.x1, l.x2))));
            dragRoomTop = Math.max(0, Math.min(...groupDragData.map(d => d.startTop), ...groupLineDragData.map(l => Math.min(l.y1, l.y2))));
            isDragging = false;
            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        });
    }

    /** Mark one top-level object selected (a generic's inner item shows it too). */
    function selectObjectEl(el) {
        selectedObjects.add(el);
        el.classList.add('selected');
        if (!el.classList.contains('canvas-item')) {
            const child = el.querySelector('.canvas-item');
            if (child) child.classList.add('selected');
        }
        if (window.selectedItems && el.id && (el.classList.contains('canvas-text-box') || el.classList.contains('canvas-icon'))) window.selectedItems.add(el.id);
        notifySelectionChanged();
    }

    function deselectObject(el) {
        selectedObjects.delete(el);
        el.classList.remove('selected');
        const child = el.querySelector && el.querySelector('.canvas-item');
        if (child) child.classList.remove('selected');
        if (window.selectedItems && el.id) window.selectedItems.delete(el.id);
        notifySelectionChanged();
    }

    // The status bar listens for this; batched to one update per frame.
    // Clicking a wire changes the selection inside connections.js, which
    // says so with its own event.
    document.addEventListener('schematic:lineselection', () => notifySelectionChanged());
    let selectionNotice = null;
    function notifySelectionChanged() {
        if (selectionNotice) return;
        selectionNotice = requestAnimationFrame(() => {
            selectionNotice = null;
            document.dispatchEvent(new CustomEvent('schematic:selection', { detail: { count: selectedObjects.size + getSelectedLineIndices().length } }));
        });
    }

    // --- Interactive Line Drawing ---
    let isDrawingLine = false;
    let lineStart = null;
    let tempLine = null;

    // Called by setDrawMode() when the mode is exited mid-drag.
    app._cancelTempLine = function () {
        if (tempLine && tempLine.parentNode) tempLine.parentNode.removeChild(tempLine);
        tempLine = null;
        lineStart = null;
        isDrawingLine = false;
    };

    // Helper to clamp a value between min and max
    function clamp(val, min, max) {
        return Math.max(min, Math.min(max, val));
    }

    // Helper to get mouse position relative to drawing-canvas, clamped to canvas bounds
    function getClampedCanvasMousePos(e) {
        const coords = getCanvasCoordinates(e);
        // offsetWidth/offsetHeight are the canvas's own size in canvas
        // units. getBoundingClientRect() is its size on screen, which is
        // scaled by the zoom, so clamping to it let lines run off the canvas
        // when zoomed in and stopped them short of the edge when zoomed out.
        let x = coords.x;
        let y = coords.y;
        x = clamp(x, 0, drawingCanvas.offsetWidth);
        y = clamp(y, 0, drawingCanvas.offsetHeight);
        return { x, y };
    }

    // Helper to constrain a line to orthogonal (horizontal or vertical)
    function getOrthogonalPoint(start, end) {
        const dx = Math.abs(end.x - start.x);
        const dy = Math.abs(end.y - start.y);
        if (dx > dy) {
            // Horizontal
            return { x: end.x, y: start.y };
        } else {
            // Vertical
            return { x: start.x, y: end.y };
        }
    }

    // Helper to find the nearest object to a point (within a threshold)
    function findNearestObject(x, y, threshold = 20) {
        let nearest = null;
        let minDist = threshold;
        Array.from(drawingCanvas.querySelectorAll('.canvas-item')).forEach(obj => {
            const left = parseInt(obj.style.left, 10) || 0;
            const top = parseInt(obj.style.top, 10) || 0;
            const width = parseInt(obj.style.width, 10) || 0;
            const height = parseInt(obj.style.height, 10) || 0;
            // Center of object
            const cx = left + width / 2;
            const cy = top + height / 2;
            const dist = Math.hypot(x - cx, y - cy);
            if (dist < minDist) {
                minDist = dist;
                nearest = { obj, offsetX: x - left, offsetY: y - top };
            }
        });
        return nearest;
    }

    // Start drawing a line
    function handleCanvasMouseDown(e) {
        if (!isGridLineDrawing) return;
        // Lines only start from empty canvas. A mousedown that landed on a
        // component is a move-or-exit gesture instead (see makeDraggable) -
        // an existing line can still end ON a component via the
        // findNearestObject snap below, just not start by clicking one.
        if (e.target.closest('.canvas-item')) return;
        const pos = getClampedCanvasMousePos(e);
        const snappedStart = snapToGrid(pos.x, pos.y);
        isDrawingLine = true;
        lineStart = snappedStart;
        // Create temp SVG line
        if (!tempLine) {
            tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            tempLine.setAttribute('stroke', currentLineColor);
            tempLine.setAttribute('stroke-width', 2);
            tempLine.setAttribute('pointer-events', 'none');
            tempLine.setAttribute('class', 'temp-line');
            if (currentLineType === 'dashed') {
                tempLine.setAttribute('stroke-dasharray', '4,3');
                tempLine.setAttribute('stroke', 'black');
            } else {
                tempLine.removeAttribute('stroke-dasharray');
            }
            svgOverlay.appendChild(tempLine);
        }
        tempLine.setAttribute('x1', snappedStart.x);
        tempLine.setAttribute('y1', snappedStart.y);
        tempLine.setAttribute('x2', snappedStart.x);
        tempLine.setAttribute('y2', snappedStart.y);
        // Attach window-level mouseup for global line placement
        window.addEventListener('mouseup', handleWindowMouseUp);
    }

    // Update temp line as mouse moves
    function handleCanvasMouseMove(e) {
        if (!isGridLineDrawing || !isDrawingLine || !tempLine) return;
        const pos = getClampedCanvasMousePos(e);
        const snappedEnd = snapToGrid(pos.x, pos.y);
        const orthoEnd = getOrthogonalPoint(lineStart, snappedEnd);
        tempLine.setAttribute('x2', orthoEnd.x);
        tempLine.setAttribute('y2', orthoEnd.y);
    }

    // Finish drawing the line (window-level)
    function handleWindowMouseUp(e) {
        window.removeEventListener('mouseup', handleWindowMouseUp);
        if (!isGridLineDrawing || !isDrawingLine || !tempLine || !lineStart) {
            return;
        }
        const pos = getClampedCanvasMousePos(e);
        const snappedEnd = snapToGrid(pos.x, pos.y);
        const orthoEnd = getOrthogonalPoint(lineStart, snappedEnd);
        // Find nearest objects for each endpoint
        const startObj = findNearestObject(lineStart.x, lineStart.y);
        const endObj = findNearestObject(orthoEnd.x, orthoEnd.y);
        // Prepare connection data
        const conn = {
            x1: lineStart.x, y1: lineStart.y,
            x2: orthoEnd.x, y2: orthoEnd.y,
            color: currentLineType === 'dashed' ? 'black' : currentLineColor,
            type: currentLineType // Save the type
        };
        if (startObj) {
            conn.startObjId = startObj.obj.id;
            conn.startOffsetX = startObj.offsetX;
            conn.startOffsetY = startObj.offsetY;
        }
        if (endObj) {
            conn.endObjId = endObj.obj.id;
            conn.endOffsetX = endObj.offsetX;
            conn.endOffsetY = endObj.offsetY;
        }
        // Save the line via connections.js
        addConnection(conn);
        renderConnections();
        doAutosave(app);
        saveState(); // Save after line is drawn
        // Remove temp line if it's still a child
        if (tempLine && tempLine.parentNode === svgOverlay) {
            svgOverlay.removeChild(tempLine);
        }
        tempLine = null;
        isDrawingLine = false;
        lineStart = null;
    }

    if (drawingCanvas && svgOverlay) {
        drawingCanvas.addEventListener('mousedown', handleCanvasMouseDown);
        drawingCanvas.addEventListener('contextmenu', (e) => {
            if (!isGridLineDrawing) return;
            e.preventDefault();
            setDrawMode(false);
        });
        drawingCanvas.addEventListener('mousemove', handleCanvasMouseMove);
        svgOverlay.addEventListener('mousemove', handleCanvasMouseMove);
        // Remove mouseup from canvas/svgOverlay, now handled globally
        // svgOverlay.addEventListener('mouseup', handleCanvasMouseUp);
    }

    setupConnections(app);

    // --- Multi-Select State ---
    let selectedObjects = new Set();

    // Selection visual style (multi-select, toggle)
    function setSelectedObject(obj, additive = false) {
        // Original selection code without resize handles
        if (!additive) clearSelection();
        if (!obj) return;
        obj.classList.add('selected');
        selectedObjects.add(obj);
        notifySelectionChanged();
        // text.js/icons.js look up the selected item's own data (font size,
        // colour, etc) by id through this Set - it was never actually
        // populated anywhere before, so their properties panels could show
        // but editing them silently did nothing.
        if (window.selectedItems) {
            if (!additive) window.selectedItems.clear();
            window.selectedItems.add(obj.id);
        }
        // Show text box properties panel if a text box is selected
        const textBoxPropertiesPanel = document.getElementById('text-box-properties-panel');
        if (obj.classList.contains('canvas-text-box')) {
            if (textBoxPropertiesPanel) {
                textBoxPropertiesPanel.style.display = '';
                // Set controls to match selected text box
                const itemsOnCanvas = window.itemsOnCanvas || new Map();
                const itemData = itemsOnCanvas.get(obj.id);
                if (itemData) {
                    const textBoxFontSizeInput = document.getElementById('textBoxFontSize');
                    const textBoxToggleBackgroundInput = document.getElementById('textBoxToggleBackground');
                    if (textBoxFontSizeInput) textBoxFontSizeInput.value = itemData.fontSize || 12;
                    if (textBoxToggleBackgroundInput) textBoxToggleBackgroundInput.checked = itemData.hasBackground !== false;
                }
            }
        } else {
            if (textBoxPropertiesPanel) textBoxPropertiesPanel.style.display = 'none';
        }
        // Show icon properties panel if an icon is selected
        const iconPropertiesPanel = document.getElementById('icon-properties-panel');
        if (obj.classList.contains('canvas-icon')) {
            if (iconPropertiesPanel) {
                iconPropertiesPanel.style.display = '';
                const itemsOnCanvas = window.itemsOnCanvas || new Map();
                const itemData = itemsOnCanvas.get(obj.id);
                if (itemData) {
                    const iconSizeInput = document.getElementById('iconSizeInput');
                    const iconColorInput = document.getElementById('iconColorInput');
                    if (iconSizeInput) iconSizeInput.value = itemData.size || 28;
                    if (iconColorInput) iconColorInput.value = itemData.color || '#1A1A1A';
                }
            }
        } else {
            if (iconPropertiesPanel) iconPropertiesPanel.style.display = 'none';
        }
    }

    // text.js and icons.js call window.setSelectedObject to select the item
    // they just created/clicked, which also shows their properties panel -
    // makeDraggable's own mousedown handler manages basic drag-selection
    // directly and doesn't know about either panel, so without this those
    // panels never appeared even though the class="selected" highlight did.
    window.setSelectedObject = setSelectedObject;

    function clearSelection() {
        selectedObjects.forEach(obj => {
            obj.classList.remove('selected');
            // Also remove from .canvas-item child if generic
            if (!obj.classList.contains('canvas-item')) {
                const child = obj.querySelector('.canvas-item');
                if (child) child.classList.remove('selected');
            }
        });
        selectedObjects.clear();
        if (window.selectedItems) window.selectedItems.clear();
        // Synchronously: this used to be an async import, so a selection made
        // straight after clearing (paste, duplicate) had its lines wiped a
        // moment later.
        clearLineSelection();
        notifySelectionChanged();
        // Hide text box/icon properties panels when nothing is selected
        const textBoxPropertiesPanel = document.getElementById('text-box-properties-panel');
        if (textBoxPropertiesPanel) textBoxPropertiesPanel.style.display = 'none';
        const iconPropertiesPanel = document.getElementById('icon-properties-panel');
        if (iconPropertiesPanel) iconPropertiesPanel.style.display = 'none';
    }

    // Add a click handler to the canvas background to clear selection
    drawingCanvas.addEventListener('mousedown', (e) => {
        // Only clear selection if clicking the actual canvas background, not the SVG overlay or a line
        if (e.target === drawingCanvas) {
            clearSelection(); // wires too
        }
    });
    // ...and the grey surround past the canvas edge, which is most of the
    // view when zoomed out.
    const canvasWrapperEl = document.getElementById('drawing-canvas-wrapper');
    if (canvasWrapperEl) {
        canvasWrapperEl.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || e.target !== canvasWrapperEl) return;
            // Not when grabbing a scrollbar - scrolling must keep the selection.
            const r = canvasWrapperEl.getBoundingClientRect();
            if (e.clientX - r.left >= canvasWrapperEl.clientWidth || e.clientY - r.top >= canvasWrapperEl.clientHeight) return;
            clearSelection();
        });
    }

    /* ------------------------------------------------------------------
       Copy, cut, paste, duplicate and nudge
       Work on the whole selection - any mix of components, labels, text
       boxes, icons and wires - where copy/paste used to take one component
       and nothing else. Each is one step in undo history.
       ------------------------------------------------------------------ */
    let clipboard = null;   // { items, lines }
    let pasteCount = 0;     // each paste of the same copy lands one step further on
    let suppressHistory = 0; // >0 while a multi-item change builds up (see saveState)
    const COPY_OFFSET = 2 * GRID_SIZE;

    const rotationOf = (el) => {
        const m = el.style.transform && el.style.transform.match(/rotate\(([-\d.]+)deg\)/);
        return m ? parseInt(m[1], 10) || 0 : 0;
    };

    /** One top-level object, described the way it is saved to file. */
    function describeObject(el) {
        const x = parseFloat(el.style.left) || 0;
        const y = parseFloat(el.style.top) || 0;
        if (el.classList.contains('canvas-text-box')) {
            const editable = el.querySelector('.text-editable');
            return {
                type: 'TextBox', x, y,
                width: parseInt(el.style.width, 10) || 200,
                html: editable ? editable.innerHTML : '',
                text: editable ? editable.innerText : '',
                fontSize: editable ? parseInt(editable.style.fontSize, 10) || 12 : 12,
                hasBackground: el.style.backgroundColor !== 'transparent'
            };
        }
        if (el.classList.contains('canvas-icon')) {
            const glyph = el.querySelector('.material-symbols-outlined');
            return {
                type: 'Icon', x, y, iconName: el.dataset.iconName,
                size: glyph ? parseInt(glyph.style.fontSize, 10) || 28 : 28,
                color: glyph ? glyph.style.color : '#1A1A1A'
            };
        }
        if (el.classList.contains('generic-wrapper')) {
            const item = el.querySelector('.canvas-item');
            if (!item) return null;
            const img = item.querySelector('img');
            const labelDiv = el.querySelector('.generic-label-editable');
            const labelText = labelDiv ? labelDiv.innerText : '';
            return {
                type: normalizeType(img ? img.alt : item.textContent), imgSrc: img ? img.src : null, x, y,
                labels: labelText ? [labelText] : null,
                // A generic's rotation is kept on its wrapper (which is never
                // itself transformed) - copying it from the transform lost it.
                rotation: parseInt(el.dataset.rotation, 10) || 0
            };
        }
        if (el.classList.contains('canvas-item')) {
            const img = el.querySelector('img');
            const type = normalizeType(img ? img.alt : el.textContent);
            return {
                type, imgSrc: img ? img.src : null, x, y,
                labels: ['RAK8', 'DIN4C', 'DIN4T', 'DIN8S', 'DINDLI'].includes(type) && el._outputLabels ? [...el._outputLabels] : null,
                termStarState: el._termStarState || null,
                rotation: rotationOf(el)
            };
        }
        return null;
    }

    function snapshotSelection() {
        const items = Array.from(selectedObjects).filter(o => o.isConnected).map(describeObject).filter(Boolean);
        const all = getConnections();
        const lines = getSelectedLineIndices().map(i => all[i]).filter(Boolean).map(c => ({ ...c }));
        return (items.length || lines.length) ? { items, lines } : null;
    }

    /** Place copies of a snapshot `offset` px down and right, and select them. */
    function placeCopies(snapshot, offset) {
        if (!snapshot) return;
        const created = [];
        suppressHistory++;
        try {
            snapshot.items.forEach(item => {
                const x = item.x + offset, y = item.y + offset;
                let el = null;
                if (item.type === 'TextBox') el = createTextBoxOnCanvas(x, y, item.text, null, true, item);
                else if (item.type === 'Icon') el = createIconOnCanvas(item.iconName, x, y, null, true, item);
                else el = createCanvasObject(item.type, item.imgSrc, x, y, item);
                if (el) created.push(el);
            });
            const firstLine = getConnections().length;
            snapshot.lines.forEach(c => addConnection({ ...c, x1: c.x1 + offset, y1: c.y1 + offset, x2: c.x2 + offset, y2: c.y2 + offset }));
            clearSelection();
            created.forEach(selectObjectEl);
            if (snapshot.lines.length) selectLine(snapshot.lines.map((_, i) => firstLine + i));
            else renderConnections();
        } finally {
            suppressHistory--;
        }
        saveState();
        setTimeout(() => { updateDPUDisplay(); updateCircuitDisplay(); }, 100);
    }

    function deleteSelection() {
        selectedObjects.forEach(obj => {
            if (window.itemsOnCanvas) window.itemsOnCanvas.delete(obj.id);
            obj.remove();
        });
        selectedObjects.clear();
        if (window.selectedItems) window.selectedItems.clear();
        const textBoxPropertiesPanel = document.getElementById('text-box-properties-panel');
        if (textBoxPropertiesPanel) textBoxPropertiesPanel.style.display = 'none';
        const iconPropertiesPanel = document.getElementById('icon-properties-panel');
        if (iconPropertiesPanel) iconPropertiesPanel.style.display = 'none';
        deleteSelectedLine();
        notifySelectionChanged();
        doAutosave(app);
        saveState(); // Save after object/line delete
        // Update DPU and circuit displays after object is deleted
        setTimeout(() => {
            updateDPUDisplay();
            updateCircuitDisplay();
        }, 100);
    }

    /** Move the selection by (dx, dy) canvas px, never past the left or top edge. */
    let nudgeSaveTimer = null;
    function nudgeSelection(dx, dy) {
        const objs = Array.from(selectedObjects).filter(o => o.isConnected);
        const lineIdx = getSelectedLineIndices();
        const conns = getConnections();
        if (!objs.length && !lineIdx.length) return false;
        const minX = Math.min(...objs.map(o => parseFloat(o.style.left) || 0), ...lineIdx.map(i => Math.min(conns[i].x1, conns[i].x2)));
        const minY = Math.min(...objs.map(o => parseFloat(o.style.top) || 0), ...lineIdx.map(i => Math.min(conns[i].y1, conns[i].y2)));
        dx = Math.max(dx, -Math.max(0, minX));
        dy = Math.max(dy, -Math.max(0, minY));
        if (!dx && !dy) return true;
        objs.forEach(o => {
            o.style.left = ((parseFloat(o.style.left) || 0) + dx) + 'px';
            o.style.top = ((parseFloat(o.style.top) || 0) + dy) + 'px';
        });
        lineIdx.forEach(i => {
            const c = conns[i];
            updateConnectionLineByIndex(i, c.x1 + dx, c.y1 + dy, c.x2 + dx, c.y2 + dy);
        });
        if (lineIdx.length) renderConnections();
        // Holding an arrow key repeats: one undo step for the whole move.
        clearTimeout(nudgeSaveTimer);
        nudgeSaveTimer = setTimeout(saveState, 350);
        return true;
    }

    document.addEventListener('keydown', (e) => {
        // Not while typing: in a label, Backspace deletes a letter, Ctrl+A
        // selects the text, Ctrl+V pastes text. Without this, typing in a
        // generic's label could delete other selected objects, Ctrl+A
        // selected every object instead of the label's text, and Ctrl+V
        // dropped a copied component on the canvas.
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable)) return;
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        if (e.key === 'Delete' || e.key === 'Backspace') {
            deleteSelection();
        } else if (e.key.startsWith('Arrow') && !mod && !e.altKey) {
            // Arrow keys: one grid square; with Shift, five.
            const step = GRID_SIZE * (e.shiftKey ? 5 : 1);
            const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
            if (d && nudgeSelection(d[0], d[1])) e.preventDefault();
        } else if (mod && (key === 'c' || key === 'x')) {
            const snap = snapshotSelection();
            if (!snap) return;
            clipboard = snap;
            pasteCount = 0;
            if (key === 'x') { e.preventDefault(); deleteSelection(); }
        } else if (mod && key === 'v') {
            if (!clipboard) return;
            e.preventDefault();
            pasteCount += 1;
            placeCopies(clipboard, COPY_OFFSET * pasteCount);
        } else if (mod && key === 'd') {
            // Duplicate (and stop the browser bookmarking the page)
            const snap = snapshotSelection();
            if (!snap) return;
            e.preventDefault();
            placeCopies(snap, COPY_OFFSET);
        } else if (mod && key === 'a') {
            e.preventDefault();
            // Select all objects - the top-level ones, so a generic is
            // selected by its wrapper (as clicking it does), and Delete
            // removes the whole thing rather than leaving its label behind.
            Array.from(drawingCanvas.children).forEach(obj => {
                if (obj.classList.contains('generic-wrapper') || obj.classList.contains('canvas-item')) selectObjectEl(obj);
            });
            // Select all lines - at once (one at a time left only the last one selected)
            const count = getConnections().length;
            if (count) selectLine(Array.from({ length: count }, (_, i) => i));
            notifySelectionChanged();
        }
    });

    // Add .selected style
    const style = document.createElement('style');
    // Selection: a crisp ring set just off the item with a soft halo;
    // hover: a quieter ring. Colours are tokens in custom.html (--sel*).
    style.textContent = `
        .canvas-item.selected { outline: 1.5px solid var(--sel) !important; outline-offset: 2px; box-shadow: 0 0 0 5px var(--sel-halo) !important; z-index: 2000 !important; }
        .canvas-item:hover:not(.selected) { outline: 1px solid var(--sel-hover); outline-offset: 2px; z-index: 2000 !important; }
        svg .selected { filter: drop-shadow(0 0 3px var(--sel-glow)); stroke: var(--sel) !important; }
        svg line:hover { stroke: var(--sel) !important; cursor: pointer; }
    `;
    document.head.appendChild(style);

    function saveState() {
        if (suppressHistory > 0) return; // a multi-item change saves once, when it's done
        if (window._restoringFromAutosave) {
            console.debug('[saveState] Skipped due to _restoringFromAutosave');
            return;
        }
        const state = getSerializableCanvasState();
        undoStack.push(JSON.parse(JSON.stringify(state)));
        if (undoStack.length > MAX_HISTORY_SIZE) undoStack.shift();
        redoStack.length = 0; // truncate in place: pageHistories keeps a reference to this array
        updateUndoRedoButtons();
        doAutosave(app);
    }

    function undo() {
        if (undoStack.length > 1) {
            const currentState = undoStack.pop();
            redoStack.push(currentState);
            const prevState = undoStack[undoStack.length - 1];
            // Autosave what undo brought back: only components with pictures
            // used to trigger a save as they reloaded, so undoing a text or
            // cable change could leave the undone version in Recent drawings.
            renderPageContent(prevState).then(() => doAutosave(app));
        }
        updateUndoRedoButtons();
    }

    function redo() {
        if (redoStack.length > 0) {
            const stateToRestore = redoStack.pop();
            undoStack.push(stateToRestore);
            renderPageContent(stateToRestore).then(() => doAutosave(app));
        }
        updateUndoRedoButtons();
    }

    function updateUndoRedoButtons() {
        const undoBtn = document.getElementById('undoBtn');
        const redoBtn = document.getElementById('redoBtn');
        if (undoBtn) undoBtn.disabled = undoStack.length <= 1;
        if (redoBtn) redoBtn.disabled = redoStack.length === 0;
    }

    // Wire up keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        const active = document.activeElement;
        const isInput = active && (['input', 'textarea'].includes(active.tagName.toLowerCase()) || active.isContentEditable);
        if (isInput) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            undo();
        } else if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z')) {
            e.preventDefault();
            redo();
        }
    });

    // Wire up UI buttons (attach directly, not inside DOMContentLoaded)
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');
    if (undoBtn) undoBtn.addEventListener('click', undo);
    if (redoBtn) redoBtn.addEventListener('click', redo);
    updateUndoRedoButtons();

    // Call saveState after every meaningful change
    // After creating an object
    const originalCreateCanvasObject = createCanvasObject;
    createCanvasObject = function(...args) {
        const obj = originalCreateCanvasObject.apply(this, args);
        if (!isRestoring) saveState(); // Only save if not restoring
        return obj;
    };
    // After deleting an object
    // (in delete handler, after remove and before doAutosave)
    // After drawing or deleting lines (in handleWindowMouseUp and line delete logic)
    // After label changes (in renderOutputLabels, openLabelModal, etc.)
    // After project detail changes (add listeners to projectNameInput, dateInput, versionInput, salespersonInput, quoteReferenceInput)

    // 6. After project detail changes
    if (projectNameInput) projectNameInput.addEventListener('input', () => doAutosave(app));
    if (dateInput) dateInput.addEventListener('input', () => doAutosave(app));
    if (versionInput) versionInput.addEventListener('input', () => doAutosave(app));
    if (salespersonInput) salespersonInput.addEventListener('input', () => doAutosave(app));
    if (quoteReferenceInput) quoteReferenceInput.addEventListener('input', () => doAutosave(app));

    // "Today" button next to the date field
    const formDateTodayBtn = document.getElementById('formDateTodayBtn');
    if (formDateTodayBtn && dateInput) {
        formDateTodayBtn.addEventListener('click', () => {
            const now = new Date();
            const yyyy = now.getFullYear();
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            dateInput.value = `${yyyy}-${mm}-${dd}`;
            dateInput.dispatchEvent(new Event('input', { bubbles: true })); // triggers the autosave listener above
        });
    }

    // --- Initialize undo stack with initial state ---
    saveState();
    pageHistories[pages[activePageIndex].id] = { undo: undoStack, redo: redoStack };

    // --- Real loader for undo/redo and schematic load ---
    /**
     * Rebuild the live canvas from one page's data: items, connections, grid
     * lines and rectangles. Shared by undo/redo, tab switching and the
     * per-page print rendering below - none of those touch project details,
     * which are shared across pages and handled separately.
     */
    async function renderPageContent(pageData) {
        isRestoring = true;
        if (!pageData) { isRestoring = false; return; }
        // Clear all objects. Generic components sit inside a wrapper with
        // their label and rotate handle: removing only the .canvas-item inside
        // it left the wrapper and its label behind, so a generic's label
        // turned up on every tab (and every printed page) after its own.
        if (drawingCanvas) {
            Array.from(drawingCanvas.querySelectorAll(':scope > .generic-wrapper, .canvas-item')).forEach(el => el.remove());
        }
        if (svgOverlay) {
            svgOverlay.innerHTML = '';
        }
        drawnRects = [];
        // Restore objects
        if (pageData.items && drawingCanvas) {
            pageData.items.forEach(item => {
                if (!item) return;
                if (typeof item.x !== 'number' || typeof item.y !== 'number') return;
                if (item.type === 'TextBox') {
                    createTextBoxOnCanvas(item.x, item.y, item.text, item.id, true, item);
                    return;
                }
                if (item.type === 'Icon') {
                    createIconOnCanvas(item.iconName, item.x, item.y, item.id, true, item);
                    return;
                }
                const normalizedType = normalizeType(item.type);
                const obj = createCanvasObject(normalizedType, item.imgSrc, item.x, item.y, item);
                if (item.labels && obj) {
                    obj._outputLabels = [...item.labels];
                    if ([ 'RAK8', 'DIN4C', 'DIN4T', 'DIN8S' ].includes(normalizedType)) {
                        renderOutputLabels(obj, normalizedType, obj._outputLabels);
                    } else if (normalizedType === 'DINDLI') {
                        renderDindliLabel(obj, obj._outputLabels);
                    }
                }
                if (item.termStarState && obj) obj._termStarState = item.termStarState;
                // Restore rotation for sensors and labels (a generic's is
                // restored by createCanvasObject, on the item inside its wrapper)
                if (typeof item.rotation === 'number' && obj && obj.classList.contains('canvas-item')) {
                    applyRotation(obj, item.rotation);
                }
            });
        }
        // Restore lines
        if (svgOverlay) {
            const mod = await import('./connections.js?v=1.44');
            mod.setConnections(pageData.connections || []);
            mod.renderConnections();
        }
        // Restore grid lines
        if (pageData.gridLines && svgOverlay) {
            pageData.gridLines.forEach(line => {
                const gridLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                gridLine.setAttribute('x1', line.x1);
                gridLine.setAttribute('y1', line.y1);
                gridLine.setAttribute('x2', line.x2);
                gridLine.setAttribute('y2', line.y2);
                gridLine.setAttribute('stroke', line.color || '#ccc');
                gridLine.setAttribute('stroke-width', 1);
                gridLine.classList.add('grid-line');
                svgOverlay.appendChild(gridLine);
            });
        }
        // Restore hand-drawn rectangles
        if (Array.isArray(pageData.rectangles) && svgOverlay) {
            drawnRects = pageData.rectangles.slice();
            drawnRects.forEach(r => {
                const rectSvg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                rectSvg.setAttribute('x', r.x);
                rectSvg.setAttribute('y', r.y);
                rectSvg.setAttribute('width', r.width);
                rectSvg.setAttribute('height', r.height);
                rectSvg.setAttribute('stroke', '#333');
                rectSvg.setAttribute('stroke-width', '2');
                rectSvg.setAttribute('fill', 'none');
                rectSvg.setAttribute('stroke-dasharray', '6,4');
                rectSvg.setAttribute('class', 'canvas-rect');
                svgOverlay.appendChild(rectSvg);
            });
        }
        // Deselect everything
        if (typeof clearSelection === 'function') clearSelection();
        // Update undo/redo buttons
        if (typeof updateUndoRedoButtons === 'function') updateUndoRedoButtons();
        isRestoring = false;
        // A loaded page may extend past the page guide, growing the canvas.
        if (typeof window._renderGrid === 'function') window._renderGrid();
        // Update DPU and circuit displays after loading is complete
        setTimeout(() => {
            updateDPUDisplay();
            updateCircuitDisplay();
        }, 200);
    }

    /**
     * File-level load: an entire saved document (project details plus every
     * page). Handles both the current multi-page format and files saved
     * before tabs existed, which land entirely on a single "Tab 1".
     */
    async function realLoadSchematicData(data) {
        console.debug('[realLoadSchematicData] called with:', data);
        window._restoringFromAutosave = false;
        if (!data) return;
        // A drawing brings its own stamp, or none.
        drawingIssue = validIssue(data.issue);
        document.dispatchEvent(new CustomEvent('schematic:issue'));

        // Restore shared project details
        if (data.projectDetails) {
            const projectNameInput = document.getElementById('formProjectName');
            const dateInput = document.getElementById('formDate');
            const versionInput = document.getElementById('formVersion');
            const salespersonInput = document.getElementById('formSalesman');
            const quoteReferenceInput = document.getElementById('formQuoteReference');
            if (projectNameInput) projectNameInput.value = data.projectDetails.projectName || '';
            if (dateInput) dateInput.value = data.projectDetails.date || '';
            if (versionInput) versionInput.value = data.projectDetails.version || '';
            if (salespersonInput) salespersonInput.value = data.projectDetails.salesperson || '';
            if (quoteReferenceInput) quoteReferenceInput.value = data.projectDetails.quoteReference || '';
        }

        if (Array.isArray(data.pages) && data.pages.length > 0) {
            pages = data.pages.map((p, i) => ({
                id: p.id || makePageId(),
                name: p.name || `Tab ${i + 1}`,
                items: Array.isArray(p.items) ? p.items : [],
                connections: Array.isArray(p.connections) ? p.connections : [],
                gridLines: Array.isArray(p.gridLines) ? p.gridLines : [],
                rectangles: Array.isArray(p.rectangles) ? p.rectangles : []
            }));
            activePageIndex = Number.isInteger(data.activePageIndex) && data.activePageIndex >= 0 && data.activePageIndex < pages.length
                ? data.activePageIndex : 0;
        } else {
            // A file saved before tabs existed (or a bare {items,...} object):
            // everything it has goes on a single "Tab 1".
            pages = [{
                id: makePageId(),
                name: 'Tab 1',
                items: Array.isArray(data.items) ? data.items : [],
                connections: Array.isArray(data.connections) ? data.connections : [],
                gridLines: Array.isArray(data.gridLines) ? data.gridLines : [],
                rectangles: Array.isArray(data.rectangles) ? data.rectangles : []
            }];
            activePageIndex = 0;
        }
        pageHistories = {};

        await renderPageContent(pages[activePageIndex]);
        await waitForImageSetups(); // so the undo baseline below is the finished drawing
        renderTabBar();

        // Seed a fresh undo baseline for the freshly-loaded active page.
        const id = pages[activePageIndex].id;
        pageHistories[id] = { undo: [JSON.parse(JSON.stringify(getSerializableCanvasState()))], redo: [] };
        undoStack = pageHistories[id].undo;
        redoStack = pageHistories[id].redo;
        updateUndoRedoButtons();
    }

    /** Persist the live canvas into the active page and stash its history. */
    function persistActivePage() {
        const current = pages[activePageIndex];
        if (!current) return;
        pages[activePageIndex] = { ...current, ...getSerializableCanvasState() };
        pageHistories[current.id] = { undo: undoStack, redo: redoStack };
    }

    /** Make page `index` active: swap in its history and render its content. */
    async function activatePage(index) {
        activePageIndex = index;
        const target = pages[activePageIndex];
        if (!pageHistories[target.id]) {
            pageHistories[target.id] = { undo: [JSON.parse(JSON.stringify(target))], redo: [] };
        }
        undoStack = pageHistories[target.id].undo;
        redoStack = pageHistories[target.id].redo;
        await renderPageContent(target);
        renderTabBar();
        doAutosave(app);
    }

    function switchToPage(index) {
        if (index === activePageIndex || !pages[index]) return;
        persistActivePage();
        activatePage(index);
    }

    function addPage() {
        persistActivePage();
        pages.push(makeBlankPage(`Tab ${pages.length + 1}`));
        activatePage(pages.length - 1);
    }

    function renamePage(index, name) {
        if (!pages[index]) return;
        const trimmed = (name || '').trim();
        pages[index].name = trimmed || pages[index].name;
        renderTabBar();
        doAutosave(app);
    }

    async function deletePage(index) {
        if (pages.length <= 1 || !pages[index]) return;
        const confirmed = await showConfirm({
            title: 'Delete this tab?',
            message: `"${pages[index].name}" and everything drawn on it will be deleted. This can't be undone.`,
            confirmLabel: 'Delete',
            danger: true
        });
        if (!confirmed) return;
        const removedId = pages[index].id;
        const wasActive = index === activePageIndex;
        pages.splice(index, 1);
        delete pageHistories[removedId];
        if (wasActive) {
            await activatePage(Math.min(index, pages.length - 1));
        } else {
            if (index < activePageIndex) activePageIndex -= 1;
            renderTabBar();
            doAutosave(app);
        }
    }

    /** Build the DOM structure for the page-tabs bar. */
    function renderTabBar() {
        const bar = document.getElementById('pageTabsBar');
        if (!bar) return;
        bar.innerHTML = '';
        pages.forEach((page, i) => {
            const tab = document.createElement('div');
            tab.className = 'page-tab' + (i === activePageIndex ? ' active' : '');

            const label = document.createElement('span');
            label.className = 'page-tab-label';
            label.textContent = page.name;
            label.title = 'Double-click to rename';
            label.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'page-tab-label-input';
                input.value = page.name;
                label.replaceWith(input);
                input.focus();
                input.select();
                // Removing `input` (done by both paths below) blurs it as a
                // side effect, which would otherwise re-trigger `commit` after
                // `cancel` already ran. `done` makes each path fire once.
                let done = false;
                const commit = () => { if (done) return; done = true; renamePage(i, input.value); };
                const cancel = () => { if (done) return; done = true; renderTabBar(); };
                input.addEventListener('blur', commit);
                input.addEventListener('keydown', (ke) => {
                    if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
                    if (ke.key === 'Escape') { ke.preventDefault(); cancel(); }
                });
            });
            tab.appendChild(label);

            if (pages.length > 1) {
                const close = document.createElement('button');
                close.type = 'button';
                close.className = 'page-tab-close';
                close.innerHTML = '&times;';
                close.title = 'Delete tab';
                close.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deletePage(i);
                });
                tab.appendChild(close);
            }

            tab.addEventListener('click', () => switchToPage(i));
            bar.appendChild(tab);
        });

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'page-tab-add';
        addBtn.title = 'Add page';
        addBtn.innerHTML = '<i class="bi bi-plus-lg"></i>';
        addBtn.addEventListener('click', addPage);
        bar.appendChild(addBtn);
    }

    app.tabs = {
        getPages: () => pages.map(p => ({ id: p.id, name: p.name })),
        getActiveIndex: () => activePageIndex,
        switchTo: switchToPage,
        add: addPage,
        rename: renamePage,
        remove: deletePage
    };
    renderTabBar();

    // --- Marquee Selection ---
    let marqueeDiv = null;
    let marqueeStart = null;
    drawingCanvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (isGridLineDrawing || isDrawingLine) return;
        if (e.target.closest('.canvas-item')) return;
        marqueeStart = getCanvasCoordinates(e);
        if (!marqueeDiv) {
            marqueeDiv = document.createElement('div');
            marqueeDiv.className = 'marquee-box'; // styled in custom.html
            marqueeDiv.style.position = 'absolute';
            marqueeDiv.style.pointerEvents = 'none';
            marqueeDiv.style.zIndex = 9999;
            drawingCanvas.appendChild(marqueeDiv);
        }
        marqueeDiv.style.display = 'block';
        marqueeDiv.style.left = marqueeStart.x + 'px';
        marqueeDiv.style.top = marqueeStart.y + 'px';
        marqueeDiv.style.width = '0px';
        marqueeDiv.style.height = '0px';
        if (!(isGridLineDrawing || isDrawingLine)) {
            function onMarqueeMove(ev) {
                const coords = getCanvasCoordinates(ev);
                // Snap to grid
                const snap = v => Math.round(v / GRID_SIZE) * GRID_SIZE;
                const x1 = snap(Math.min(marqueeStart.x, coords.x));
                const y1 = snap(Math.min(marqueeStart.y, coords.y));
                const x2 = snap(Math.max(marqueeStart.x, coords.x));
                const y2 = snap(Math.max(marqueeStart.y, coords.y));
                marqueeDiv.style.left = x1 + 'px';
                marqueeDiv.style.top = y1 + 'px';
                marqueeDiv.style.width = (x2 - x1) + 'px';
                marqueeDiv.style.height = (y2 - y1) + 'px';
            }
            function onMarqueeUp(ev) {
                const coords = getCanvasCoordinates(ev);
                // Snap to grid
                const snap = v => Math.round(v / GRID_SIZE) * GRID_SIZE;
                const x1 = snap(Math.min(marqueeStart.x, coords.x));
                const y1 = snap(Math.min(marqueeStart.y, coords.y));
                const x2 = snap(Math.max(marqueeStart.x, coords.x));
                const y2 = snap(Math.max(marqueeStart.y, coords.y));
                selectedObjects.forEach(o => o.classList.remove('selected'));
                selectedObjects.clear();
                // Only select top-level objects (children of drawingCanvas)
                Array.from(drawingCanvas.children).forEach(obj => {
                    let left, top, width, height;
                    if (obj.classList.contains('generic-wrapper')) {
                        const item = obj.querySelector('.canvas-item');
                        left = parseInt(obj.style.left, 10) || 0;
                        top = parseInt(obj.style.top, 10) || 0;
                        width = item ? parseInt(item.style.width, 10) || 0 : 0;
                        height = item ? parseInt(item.style.height, 10) || 0 : 0;
                    } else if (obj.classList.contains('canvas-item')) {
                        left = parseInt(obj.style.left, 10) || 0;
                        top = parseInt(obj.style.top, 10) || 0;
                        width = parseInt(obj.style.width, 10) || 0;
                        height = parseInt(obj.style.height, 10) || 0;
                    } else {
                        return; // skip non-object children
                    }
                    const ox1 = left;
                    const oy1 = top;
                    const ox2 = left + width;
                    const oy2 = top + height;
                    if (ox2 >= x1 && ox1 <= x2 && oy2 >= y1 && oy1 <= y2) {
                        selectedObjects.add(obj);
                        obj.classList.add('selected');
                        // For generics, also add .selected to the child .canvas-item for visual feedback
                        if (obj.classList.contains('generic-wrapper')) {
                            const item = obj.querySelector('.canvas-item');
                            if (item) item.classList.add('selected');
                        }
                    } else {
                        obj.classList.remove('selected');
                        selectedObjects.delete(obj);
                        if (obj.classList.contains('generic-wrapper')) {
                            const item = obj.querySelector('.canvas-item');
                            if (item) item.classList.remove('selected');
                        }
                    }
                });
                // Select all SVG lines whose endpoints are inside the marquee
                const svgOverlay = document.getElementById('svg-overlay');
                let selectedLineIndices = [];
                if (svgOverlay) {
                    Array.from(svgOverlay.querySelectorAll('line')).forEach((line, idx) => {
                        const x1l = parseInt(line.getAttribute('x1'), 10);
                        const y1l = parseInt(line.getAttribute('y1'), 10);
                        const x2l = parseInt(line.getAttribute('x2'), 10);
                        const y2l = parseInt(line.getAttribute('y2'), 10);
                        const p1In = x1l >= x1 && x1l <= x2 && y1l >= y1 && y1l <= y2;
                        const p2In = x2l >= x1 && x2l <= x2 && y2l >= y1 && y2l <= y2;
                        if (p1In || p2In) {
                            line.classList.add('selected');
                            selectedLineIndices.push(idx);
                        } else {
                            line.classList.remove('selected');
                        }
                    });
                    if (selectedLineIndices.length > 0) selectLine(selectedLineIndices);
                    else clearLineSelection();
                }
                marqueeDiv.style.display = 'none';
                notifySelectionChanged();
                window.removeEventListener('mousemove', onMarqueeMove);
                window.removeEventListener('mouseup', onMarqueeUp);
            }
            window.addEventListener('mousemove', onMarqueeMove);
            window.addEventListener('mouseup', onMarqueeUp);
        }
    });

    if (svgOverlay) {
        svgOverlay.addEventListener('mousedown', (e) => {
            // Only clear selection if clicking the SVG background, not a line
            if (e.target === svgOverlay) {
                clearSelection(); // wires too
            }
        });
    }

    // --- Grid rendering ---
    function renderGrid() {
        const gridSvg = document.getElementById('grid-svg');
        if (!gridSvg) return;
        // Clear previous grid
        gridSvg.innerHTML = '';
        // Set SVG size to match canvas
        const width = Math.max(drawingCanvas.offsetWidth, drawingCanvas.scrollWidth);
        const height = Math.max(drawingCanvas.offsetHeight, drawingCanvas.scrollHeight);
        gridSvg.setAttribute('width', width);
        gridSvg.setAttribute('height', height);
        gridSvg.style.position = 'absolute';
        gridSvg.style.top = '0';
        gridSvg.style.left = '0';
        gridSvg.style.zIndex = '0';
        gridSvg.style.pointerEvents = 'none';
        // Draw vertical lines
        for (let x = 0; x < width; x += GRID_SIZE) {
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', x);
            line.setAttribute('y1', 0);
            line.setAttribute('x2', x);
            line.setAttribute('y2', height);
            line.setAttribute('stroke', '#e0e0e0');
            line.setAttribute('stroke-width', '1');
            gridSvg.appendChild(line);
        }
        // Draw horizontal lines
        for (let y = 0; y < height; y += GRID_SIZE) {
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', 0);
            line.setAttribute('y1', y);
            line.setAttribute('x2', width);
            line.setAttribute('y2', y);
            line.setAttribute('stroke', '#e0e0e0');
            line.setAttribute('stroke-width', '1');
            gridSvg.appendChild(line);
        }
    }

    // Call renderGrid on load, zoom, pan, and resize
    window.addEventListener('resize', renderGrid);
    window._renderGrid = renderGrid;
    renderGrid();

    // Mouse position in canvas coordinates - the units items are positioned,
    // saved and printed in - whatever the current zoom and scroll position.
    // The rect already includes scrolling; the scale is read from the
    // transform actually applied to the canvas (see zoom.js) rather than
    // from a constant, so the two can never disagree. It used to divide by a
    // fixed 1.3, left over from when the canvas was always shown at 130%:
    // once the screen went to 100% in v1.32, every drag covered only 77% of
    // the distance the cursor moved, and drops, lines and the selection box
    // all landed short of the pointer.
    function getCanvasCoordinates(e) {
        const rect = drawingCanvas.getBoundingClientRect();
        const scale = getCanvasScale();
        const x = (e.clientX - rect.left) / scale;
        const y = (e.clientY - rect.top) / scale;
        return { x, y };
    }

    // --- Rectangle Drawing Tool ---
    let isDrawingRect = false;
    let rectStart = null;
    let currentRectSvg = null;
    let drawnRects = [];

    const drawRectBtn = document.getElementById('drawRectBtn');
    if (drawRectBtn) {
        drawRectBtn.addEventListener('click', () => {
            isDrawingRect = !isDrawingRect;
            drawRectBtn.classList.toggle('active', isDrawingRect);
        });
    }

    if (drawingCanvas && svgOverlay) {
        drawingCanvas.addEventListener('mousedown', (e) => {
            if (!isDrawingRect) return;
            if (e.button !== 0) return;
            // Canvas units, so a box drawn while zoomed lands under the pointer
            const start = getCanvasCoordinates(e);
            const startX = start.x;
            const startY = start.y;
            rectStart = { x: startX, y: startY };
            currentRectSvg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            currentRectSvg.setAttribute('x', startX);
            currentRectSvg.setAttribute('y', startY);
            currentRectSvg.setAttribute('width', 0);
            currentRectSvg.setAttribute('height', 0);
            currentRectSvg.setAttribute('stroke', '#333');
            currentRectSvg.setAttribute('stroke-width', '2');
            currentRectSvg.setAttribute('fill', 'none');
            currentRectSvg.setAttribute('stroke-dasharray', '6,4');
            currentRectSvg.setAttribute('class', 'canvas-rect');
            // Insert rectangle above the grid but below all objects/lines
            let inserted = false;
            // Find the first .canvas-item or line in svgOverlay
            for (let i = 0; i < svgOverlay.childNodes.length; i++) {
                const node = svgOverlay.childNodes[i];
                if (node.nodeType === 1 && (node.tagName === 'line' || node.classList.contains('canvas-item'))) {
                    svgOverlay.insertBefore(currentRectSvg, node);
                    inserted = true;
                    break;
                }
            }
            if (!inserted) svgOverlay.appendChild(currentRectSvg);
            window.addEventListener('mousemove', onRectMouseMove);
            window.addEventListener('mouseup', onRectMouseUp);
        });
    }

    function onRectMouseMove(e) {
        if (!rectStart || !currentRectSvg) return;
        const curr = getCanvasCoordinates(e);
        const currX = curr.x;
        const currY = curr.y;
        const x = Math.min(rectStart.x, currX);
        const y = Math.min(rectStart.y, currY);
        const width = Math.abs(currX - rectStart.x);
        const height = Math.abs(currY - rectStart.y);
        currentRectSvg.setAttribute('x', x);
        currentRectSvg.setAttribute('y', y);
        currentRectSvg.setAttribute('width', width);
        currentRectSvg.setAttribute('height', height);
    }

    function onRectMouseUp(e) {
        if (!rectStart || !currentRectSvg) return;
        const end = getCanvasCoordinates(e);
        const endX = end.x;
        const endY = end.y;
        const x = Math.min(rectStart.x, endX);
        const y = Math.min(rectStart.y, endY);
        const width = Math.abs(endX - rectStart.x);
        const height = Math.abs(endY - rectStart.y);
        if (width > 5 && height > 5) {
            // Save the rectangle and keep the SVG in the DOM
            drawnRects.push({ x, y, width, height });
            // (currentRectSvg is already in the DOM)
        } else {
            // Too small, remove
            if (currentRectSvg.parentNode) currentRectSvg.parentNode.removeChild(currentRectSvg);
        }
        rectStart = null;
        currentRectSvg = null;
        window.removeEventListener('mousemove', onRectMouseMove);
        window.removeEventListener('mouseup', onRectMouseUp);
        saveState();
    }

    function getCurrentSelectedBox() {
        // Return the first selected object that is a box
        return Array.from(selectedObjects).find(obj => obj.classList.contains('canvas-hatched-box'));
    }

    // --- DPU Calculation Functions ---
    function calculateDPU() {
        const drawingCanvas = document.getElementById('drawing-canvas');
        if (!drawingCanvas) return { capacity: 0, usage: 0 };
        
        let capacity = 0;
        let usage = 0;
        
        // Count DIN-LINK (each provides 64 DPU capacity)
        const dinLinks = drawingCanvas.querySelectorAll('.canvas-item[data-type="DINLINK"], .generic-wrapper .canvas-item[data-type="DINLINK"]');
        capacity = dinLinks.length * 64;
        
        // Count DIN modules (each uses 8 DPU)
        const dinModules = drawingCanvas.querySelectorAll('.canvas-item[data-type="DIN4C"], .canvas-item[data-type="DIN4T"], .canvas-item[data-type="DIN8S"], .generic-wrapper .canvas-item[data-type="DIN4C"], .generic-wrapper .canvas-item[data-type="DIN4T"], .generic-wrapper .canvas-item[data-type="DIN8S"]');
        usage += dinModules.length * 8;
        
        // Count DIN-DLI (each uses 16 DPU)
        const dinDLIs = drawingCanvas.querySelectorAll('.canvas-item[data-type="DINDLI"], .generic-wrapper .canvas-item[data-type="DINDLI"]');
        usage += dinDLIs.length * 16;
        
        return { capacity, usage };
    }

    function updateDPUDisplay() {
        const dpuDisplay = document.getElementById('dpuDisplay');
        const dpuValue = document.getElementById('dpuValue');
        const dpuWarning = document.getElementById('dpuWarning');
        
        if (!dpuDisplay || !dpuValue || !dpuWarning) return;
        
        const { capacity, usage } = calculateDPU();
        dpuValue.textContent = `${usage} / ${capacity}`;
        
        // Show warning if: usage exceeds capacity OR if there are DIN modules but no DIN-LINK (capacity is 0 but usage > 0)
        if ((capacity > 0 && usage > capacity) || (capacity === 0 && usage > 0)) {
            dpuWarning.style.display = 'inline';
        } else {
            dpuWarning.style.display = 'none';
        }
    }

    // Initialize DPU display on setup
    setTimeout(() => updateDPUDisplay(), 500);

    // --- Circuit Calculation Functions ---
    function calculateCircuits() {
        const drawingCanvas = document.getElementById('drawing-canvas');
        if (!drawingCanvas) return { capacity: 0, usage: 0 };
        
        let capacity = 0;
        let usage = 0;
        
        // Count RAK-LINK (each provides 32 circuit capacity)
        const rakLinks = drawingCanvas.querySelectorAll('.canvas-item[data-type="RAKLink"], .canvas-component[data-type="RAKLink"], .generic-wrapper .canvas-item[data-type="RAKLink"]');
        capacity = rakLinks.length * 32;
        
        // Count RAK8 (each uses 8 circuits) - assuming RAK8 is RAK8-MB or RAK8S
        const rak8s = drawingCanvas.querySelectorAll('.canvas-item[data-type="RAK8"], .canvas-component[data-type="RAK8"], .generic-wrapper .canvas-item[data-type="RAK8"]');
        usage += rak8s.length * 8;
        
        // RAK-STAR is ignored (not counted)
        
        return { capacity, usage };
    }

    function updateCircuitDisplay() {
        const circuitDisplay = document.getElementById('circuitDisplay');
        const circuitValue = document.getElementById('circuitValue');
        const circuitWarning = document.getElementById('circuitWarning');
        
        if (!circuitDisplay || !circuitValue || !circuitWarning) return;
        
        const { capacity, usage } = calculateCircuits();
        circuitValue.textContent = `${usage} / ${capacity}`;
        
        if (capacity > 0 && usage > capacity) {
            circuitWarning.style.display = 'inline';
        } else {
            circuitWarning.style.display = 'none';
        }
    }

    // Initialize circuit display on setup
    setTimeout(() => updateCircuitDisplay(), 500);
}

export async function loadSchematicData(data) {
    console.debug('[loadSchematicData] called with:', data);
    if (window.app && window.app._realLoadSchematicData) {
        const result = await window.app._realLoadSchematicData(data);
        console.debug('[loadSchematicData] window.app._realLoadSchematicData returned:', result);
        return result;
    }
    console.debug('[loadSchematicData] window.app._realLoadSchematicData not found');

    // A loaded drawing may extend past the page, growing the canvas.
    if (typeof window._renderGrid === 'function') window._renderGrid();
}

// At the very end of the file, add:
const rotatePrintHideStyle = document.createElement('style');
rotatePrintHideStyle.textContent = `@media print { .rotate-handle, .rotate-handle *, .bi-arrow-clockwise, .bi { display: none !important; visibility: hidden !important; opacity: 0 !important; } }`;
document.head.appendChild(rotatePrintHideStyle);

let currentLineType = 'colour'; // 'colour' or 'dashed'
