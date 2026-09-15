// canvas.js
// Handles drawing, moving, and editing items on the canvas.

import { setupConnections, startConnection, finishConnection, renderConnections } from './connections.js?v=1.16';
import { doAutosave } from './storage.js?v=1.16';
import { initTextTool, createTextBoxOnCanvas } from './text.js?v=1.16';
import { showToast, showConfirm } from './utils.js?v=1.16';

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
    console.debug('[getSerializableCanvasState] called');
    // Collect all objects
    const drawingCanvas = document.getElementById('drawing-canvas');
    const items = [];
    // Save all generic wrappers and non-textbox canvas items
    Array.from(drawingCanvas.children).forEach(child => {
        // Skip text boxes (handled separately below)
        if (child.classList && child.classList.contains('canvas-text-box')) return;
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
        const input = box.querySelector('input');
        items.push({
            type: 'TextBox',
            id: box.id,
            x: parseInt(box.style.left, 10) || 0,
            y: parseInt(box.style.top, 10) || 0,
            text: input ? input.value : '',
            fontSize: input ? parseInt(input.style.fontSize, 10) || 12 : 12,
            hasBackground: box.style.backgroundColor !== 'transparent',
            isBold: input ? input.style.fontWeight === 'bold' : false,
            isUnderlined: input ? input.style.textDecoration === 'underline' : false
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
    console.debug('[getSerializableCanvasState] items:', items);
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

export function getSchematicData() {
    syncActivePageFromCanvas();
    return {
        projectDetails: collectProjectDetails(),
        pages: pages.map(p => ({ ...p })),
        activePageIndex
    };
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
        if (drawGridLineBtn) {
            drawGridLineBtn.classList.toggle('btn-success', on);
            drawGridLineBtn.classList.toggle('btn-primary', !on);
            drawGridLineBtn.textContent = on ? 'Exit Draw Line  Esc' : 'Draw Line  L';
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
    }
    function toggleDrawMode() { setDrawMode(!isGridLineDrawing); }
    app.setDrawMode = setDrawMode;

    if (drawGridLineBtn) {
        drawGridLineBtn.textContent = 'Draw Line  L';
        drawGridLineBtn.title = 'Draw Line (L) \u2014 Esc or right-click to exit';
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
        // Fix: Allow spacebar and shortcuts in input fields
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
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
                // Delete selected line if any
                import('./connections.js?v=1.16').then(mod => {
                    mod.deleteSelectedLine();
                });
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
        marginMm: 10,
        infoBlockMm: 50,           // reserved for the title block + notes (matches its 5cm print height)
        dpi: 96
    };

    function getPrintAreaPx() {
        const { pageWidthMm, pageHeightMm, marginMm, infoBlockMm, dpi } = PRINT_GEOMETRY;
        const mmToPx = (1 / 25.4) * dpi;
        return {
            width:  (pageWidthMm  - 2 * marginMm) * mmToPx,
            height: (pageHeightMm - 2 * marginMm - infoBlockMm) * mmToPx
        };
    }

    // The @page CSS rule's own margin (0.2cm = 2mm), which the browser
    // insets automatically before body's content box starts.
    const CSS_PAGE_MARGIN_MM = 2;

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
        const { pageWidthMm, pageHeightMm, dpi } = PRINT_GEOMETRY;
        const mmToPx = (1 / 25.4) * dpi;
        return {
            width:  (pageWidthMm  - 2 * CSS_PAGE_MARGIN_MM) * mmToPx - PAGE_BOX_SAFETY_PX,
            height: (pageHeightMm - 2 * CSS_PAGE_MARGIN_MM) * mmToPx - PAGE_BOX_SAFETY_PX
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

        // Keep the canvas the same size as the page. The canvas is
        // width/height: max-content, so it still grows if a drawing (or a
        // loaded file from before this change) extends past the page edge.
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
        // Show the info block
        printInfoBlockContent.classList.add('print-visible');
    }

    function renderPrintConnectorLegend() {
        if (!printConnectorLegend) return;
        printConnectorLegend.innerHTML = `
          <div style="display: flex; align-items: center; justify-content: center; gap: 16px; font-size: 8.1pt; font-weight: normal; padding: 0; margin: 0; background: none; border: none; box-shadow: none; width: 100%; position: relative; top: 0;">
          <span style="display: flex; align-items: center;">
  <span class="legend-swatch" style="width: 24px; height: 0; border-bottom: 2px dashed #000; margin-right: 5.4px; display: inline-block;"></span>
  Zone
</span>  
          <span style="display: flex; align-items: center;"><span class="legend-swatch" style="background:black; width:12.6px; height:12.6px; border-radius:2px; margin-right:5.4px; border:none; display:inline-block;"></span>Default</span>
            <span style="display: flex; align-items: center;"><span class="legend-swatch" style="background:#007bff; width:12.6px; height:12.6px; border-radius:2px; margin-right:5.4px; border:none; display:inline-block;"></span>RJ45</span>
            <span style="display: flex; align-items: center;"><span class="legend-swatch" style="background:#28a745; width:12.6px; height:12.6px; border-radius:2px; margin-right:5.4px; border:none; display:inline-block;"></span>Rako Wired Network</span>
            <span style="display: flex; align-items: center;"><span class="legend-swatch" style="background:purple; width:12.6px; height:12.6px; border-radius:2px; margin-right:5.4px; border:none; display:inline-block;"></span>DIN Bus</span>
            <span style="display: flex; align-items: center;"><span class="legend-swatch" style="background:red; width:12.6px; height:12.6px; border-radius:2px; margin-right:5.4px; border:none; display:inline-block;"></span>DALI</span>
            <span style="display: flex; align-items: center;"><span class="legend-swatch" style="background:orange; width:12.6px; height:12.6px; border-radius:2px; margin-right:5.4px; border:none; display:inline-block;"></span>RJ11</span>
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
    const PRINT_PADDING_PX = 8;
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

    /** Bounding box of everything drawn, in untransformed canvas pixels. */
    function getContentBoundsPx() {
        const canvasEl = document.getElementById('drawing-canvas');
        if (!canvasEl) return null;
        const canvasRect = canvasEl.getBoundingClientRect();
        const scale = getCanvasScale();

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, found = false;
        const include = (l, t, r, b) => {
            if (![l, t, r, b].every(Number.isFinite)) return;
            found = true;
            if (l < minX) minX = l;
            if (t < minY) minY = t;
            if (r > maxX) maxX = r;
            if (b > maxY) maxY = b;
        };

        // Components, text boxes and shapes (rect includes overflowing labels)
        canvasEl.querySelectorAll('.canvas-item').forEach(el => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return;
            include(
                (r.left   - canvasRect.left) / scale,
                (r.top    - canvasRect.top)  / scale,
                (r.right  - canvasRect.left) / scale,
                (r.bottom - canvasRect.top)  / scale
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
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    /** Pure fit math: bounds + printable area -> a translate+scale transform. */
    function computeFitTransform(bounds, area) {
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;

        const targetW = area.width  - PRINT_PADDING_PX * 2;
        const targetH = area.height - PRINT_PADDING_PX * 2;

        // Shrink to fit, but never enlarge: a two-component drawing should not
        // print blown up across the whole sheet.
        let scale = Math.min(targetW / bounds.width, targetH / bounds.height, 1);
        if (scale < PRINT_MIN_SCALE) scale = PRINT_MIN_SCALE;

        // Centre whatever room is left over.
        const offsetX = PRINT_PADDING_PX + Math.max(0, (targetW - bounds.width  * scale) / 2);
        const offsetY = PRINT_PADDING_PX + Math.max(0, (targetH - bounds.height * scale) / 2);

        const tx = offsetX - bounds.x * scale;
        const ty = offsetY - bounds.y * scale;
        return { scale, transform: `translate(${tx}px, ${ty}px) scale(${scale})` };
    }

    /**
     * Clone the currently-live #drawing-canvas into a single .print-sheet,
     * fitted to the page. #svg-overlay is a DOM child of #drawing-canvas, so
     * the clone's overlay is left untransformed - it inherits the canvas
     * clone's transform visually, and giving it its own would compound it.
     */
    function buildPrintSheet(pageName, pageNum, totalPages) {
        const bounds = getContentBoundsPx();
        const fit = computeFitTransform(bounds, getPrintAreaPx());
        if (fit && fit.scale <= PRINT_MIN_SCALE) lastPrintScale = Math.min(lastPrintScale, fit.scale);

        const sheet = document.createElement('div');
        sheet.className = 'print-sheet';
        const pageBox = getPageBoxPx();
        sheet.style.width = pageBox.width + 'px';
        sheet.style.height = pageBox.height + 'px';

        const canvasClone = drawingCanvas.cloneNode(true);
        canvasClone.classList.add('ps-canvas');
        canvasClone.style.transform = fit ? fit.transform : 'none';
        sheet.appendChild(canvasClone);

        if (totalPages > 1) {
            const tag = document.createElement('div');
            tag.className = 'print-sheet-tag';
            tag.textContent = `Page ${pageNum} of ${totalPages} — ${pageName}`;
            sheet.appendChild(tag);
        }
        return sheet;
    }

    /**
     * Wait for every <img> across `sheets` to finish loading (or fail), up
     * to `timeoutMs`. cloneNode() copies <img> tags as-is; it doesn't wait
     * for them, so without this a slow-loading component image (a real CDN,
     * not localhost) could still be mid-fetch when window.print() captures
     * the page, showing up cut off / partially rendered.
     */
    function waitForImages(sheets, timeoutMs = 4000) {
        const pending = [];
        sheets.forEach(sheet => {
            Array.from(sheet.querySelectorAll('img')).forEach(img => { if (!img.complete) pending.push(img); });
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
            clearPrintSheets();
            const sheets = [];

            for (let i = 0; i < pages.length; i++) {
                await renderPageContent(pages[i]);
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

            await waitForImages(sheets); // let every sheet's component images finish loading first
            await renderPageContent(pages[originalIndex]);
        } finally {
            isBuildingPrintSheets = false;
        }
        renderTabBar();
    }

    app.printAllPages = async function() {
        renderPrintInfoBlock();
        renderPrintConnectorLegend();
        await buildPrintSheets();
    };

    window.addEventListener('beforeprint', () => {
        renderPrintInfoBlock();
        renderPrintConnectorLegend();
        if (document.querySelector('.print-sheet')) return; // built by the Print button already
        // Native/Ctrl+P print: fall back to a single sheet of whatever page
        // is currently on screen (the full multi-page build only runs from
        // the Print Schematic button, since it needs to await page renders).
        clearPrintSheets();
        const sheet = buildPrintSheet(pages[activePageIndex].name, 1, 1);
        document.body.appendChild(sheet);
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
    const textBoxUnderlineBtn = document.getElementById('textBoxUnderlineBtn');
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
            underlineBtn: textBoxUnderlineBtn,
            toggleBackgroundInput: textBoxToggleBackgroundInput
        },
        window.itemsOnCanvas,
        window.selectedItems,
        makeDraggable,
        saveState
    );

    let draggedPaletteItem = null;

    if (palette && drawingCanvas) {
        palette.querySelectorAll('.palette-item').forEach(item => {
            item.addEventListener('dragstart', (e) => {
                draggedPaletteItem = item;
                e.dataTransfer.setData('text/plain', item.dataset.type);
                if (item.dataset.img) {
                    e.dataTransfer.setData('image-src', item.dataset.img);
                }
                e.dataTransfer.effectAllowed = 'copy';
            });
        });

        drawingCanvas.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });

        drawingCanvas.addEventListener('drop', (e) => {
            e.preventDefault();
            if (draggedPaletteItem) {
                const type = e.dataTransfer.getData('text/plain');
                const imgSrc = e.dataTransfer.getData('image-src');
                const coords = getCanvasCoordinates(e);
                createCanvasObject(type, imgSrc, coords.x, coords.y);
                draggedPaletteItem = null;
            }
        });
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
            labelDiv.style.position = 'absolute';
            labelDiv.style.left = (width + labelTextOffsetX) + 'px';
            labelDiv.style.top = (targetY - 6) + 'px';
            labelDiv.style.fontSize = '8px';
            labelDiv.style.background = '#fff';
            labelDiv.style.padding = '1px 2px';
            labelDiv.style.borderRadius = '2px';
            labelDiv.style.cursor = 'pointer';
            labelDiv.style.lineHeight = '1.2';
            labelDiv.style.zIndex = '21';
            labelDiv.style.whiteSpace = 'nowrap';
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
            obj.style.transform = rotation ? `rotate(${rotation}deg)` : '';
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
            obj.appendChild(rotateHandle);
        }
        drawingCanvas.appendChild(obj);
        // Attach double-click to the object (event delegation)
        if ([ 'RAK8', 'DIN4C', 'DIN4T', 'DIN8S', 'DINDLI' ].includes(type)) {
            if (!obj._outputLabels) {
                if (type === 'RAK8' || type === 'DIN8S') obj._outputLabels = Array(8).fill('');
                else if (type === 'DIN4C' || type === 'DIN4T') obj._outputLabels = Array(4).fill('');
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

    function makeDraggable(target, isGeneric = false) {
        // Prevent native drag-and-drop UI
        target.addEventListener('dragstart', e => e.preventDefault());
        let isDragging = false, dragStartX, dragStartY;
        let groupDragData = null;
        let groupLineDragData = null;
        function onMouseMove(e) {
            if (!isDragging) {
                // Check drag threshold
                const coords = getCanvasCoordinates(e);
                const dx = Math.abs(coords.x - dragStartX);
                const dy = Math.abs(coords.y - dragStartY);
                if (dx > 3 || dy > 3) {
                    isDragging = true;
                    target.style.zIndex = 1000;
                    document.body.style.userSelect = 'none';
                } else {
                    return;
                }
            }
            const coords = getCanvasCoordinates(e);
            const deltaX = coords.x - dragStartX;
            const deltaY = coords.y - dragStartY;
            // Move all selected objects by the mouse delta
            groupDragData.forEach(data => {
                const snapped = snapToGrid(data.startLeft + deltaX, data.startTop + deltaY);
                if (isGeneric) {
                    data.obj.style.left = snapped.x + 'px';
                    data.obj.style.top = snapped.y + 'px';
                } else {
                    data.obj.style.left = snapped.x + 'px';
                    data.obj.style.top = snapped.y + 'px';
                }
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
        }
        function onMouseUp(e) {
            if (isDragging) {
                isDragging = false;
                target.style.zIndex = 20;
                document.body.style.userSelect = '';
                // Update connection data for moved lines
                const svgOverlay = document.getElementById('svg-overlay');
                if (svgOverlay && groupLineDragData && groupLineDragData.length > 0) {
                    import('./connections.js?v=1.16').then(mod => {
                        groupLineDragData.forEach(lineData => {
                            // Get new endpoints from SVG
                            const x1 = parseInt(lineData.line.getAttribute('x1'), 10);
                            const y1 = parseInt(lineData.line.getAttribute('y1'), 10);
                            const x2 = parseInt(lineData.line.getAttribute('x2'), 10);
                            const y2 = parseInt(lineData.line.getAttribute('y2'), 10);
                            // Update the real data model by index
                            mod.updateConnectionLineByIndex(
                                lineData.index,
                                x1, y1, x2, y2
                            );
                        });
                        mod.renderConnections();
                    });
                }
                doAutosave(app);
                saveState(); // Save after move
            }
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        }
        target.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // Only left mouse button
            // While armed, the canvas owns the click: don't select or drag
            // components, and stay in draw mode. The event still bubbles to
            // #drawing-canvas, so a line can start on top of a component.
            // Esc, right-click, L or the button exit the mode.
            if (isGridLineDrawing) return;
            // Only change selection if you click an unselected object
            if (!isDragging) {
                if (!selectedObjects.has(target)) {
                    selectedObjects.forEach(o => {
                        o.classList.remove('selected');
                        // Also remove from .canvas-item child if generic
                        if (o.classList.contains('canvas-item')) return;
                        const child = o.querySelector('.canvas-item');
                        if (child) child.classList.remove('selected');
                    });
                    selectedObjects.clear();
                    selectedObjects.add(target);
                    target.classList.add('selected');
                    // Also add to .canvas-item child if generic
                    if (!target.classList.contains('canvas-item')) {
                        const child = target.querySelector('.canvas-item');
                        if (child) child.classList.add('selected');
                    }
                }
                // If already selected, do not change selection (allow group drag)
            }
            const coords = getCanvasCoordinates(e);
            dragStartX = coords.x;
            dragStartY = coords.y;
            // For each selected object, store its original left/top (canvas-relative)
            groupDragData = Array.from(selectedObjects).map(selObj => {
                return {
                    obj: selObj,
                    startLeft: parseInt(selObj.style.left, 10) || 0,
                    startTop: parseInt(selObj.style.top, 10) || 0
                };
            });
            // For each selected line, store its original endpoints and index
            const svgOverlay = document.getElementById('svg-overlay');
            groupLineDragData = [];
            if (svgOverlay) {
                // Get selected line indices synchronously
                const lines = svgOverlay.querySelectorAll('line');
                if (window.connections && window.connections.getSelectedLineIndices) {
                    const selectedIndices = window.connections.getSelectedLineIndices();
                    selectedIndices.forEach(idx => {
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
            }
            isDragging = false;
            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        });
    }

    // --- Interactive Line Drawing ---
    let isDrawingLine = false;
    let lineStart = null;
    let tempLine = null;
    let lineMouseDownClientPos = null;
    let lineMouseDownOnComponent = false;
    const CLICK_MOVE_THRESHOLD_PX = 4; // below this, mousedown->mouseup is a click, not a drag

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
        const rect = drawingCanvas.getBoundingClientRect();
        let x = coords.x;
        let y = coords.y;
        x = clamp(x, 0, rect.width);
        y = clamp(y, 0, rect.height);
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
        const pos = getClampedCanvasMousePos(e);
        const snappedStart = snapToGrid(pos.x, pos.y);
        isDrawingLine = true;
        lineStart = snappedStart;
        lineMouseDownClientPos = { x: e.clientX, y: e.clientY };
        lineMouseDownOnComponent = !!e.target.closest('.canvas-item');
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
        console.log('handleCanvasMouseMove running');
        const pos = getClampedCanvasMousePos(e);
        const snappedEnd = snapToGrid(pos.x, pos.y);
        const orthoEnd = getOrthogonalPoint(lineStart, snappedEnd);
        tempLine.setAttribute('x2', orthoEnd.x);
        tempLine.setAttribute('y2', orthoEnd.y);
        console.log('tempLine updated:', tempLine);
    }

    // Finish drawing the line (window-level)
    function handleWindowMouseUp(e) {
        window.removeEventListener('mouseup', handleWindowMouseUp);
        // Debug log
        console.log('handleWindowMouseUp', { isGridLineDrawing, isDrawingLine, tempLine, lineStart });
        if (!isGridLineDrawing || !isDrawingLine || !tempLine || !lineStart) {
            return;
        }
        // A plain click (no real drag) landing on a component isn't an
        // attempt to draw a line from it - it reads as "I want this
        // object", so exit draw mode instead of leaving a zero-length
        // connection behind at the click point.
        const moved = lineMouseDownClientPos
            ? Math.hypot(e.clientX - lineMouseDownClientPos.x, e.clientY - lineMouseDownClientPos.y)
            : Infinity;
        const wasClickOnComponent = lineMouseDownOnComponent && moved < CLICK_MOVE_THRESHOLD_PX;
        lineMouseDownClientPos = null;
        lineMouseDownOnComponent = false;
        if (wasClickOnComponent) {
            setDrawMode(false); // also cancels/removes the temp line via app._cancelTempLine
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
        import('./connections.js?v=1.16').then(mod => {
            mod.addConnection(conn);
            mod.renderConnections();
            doAutosave(app);
            saveState(); // Save after line is drawn
        });
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
                    const textBoxBoldBtn = document.getElementById('textBoxBoldBtn');
                    const textBoxUnderlineBtn = document.getElementById('textBoxUnderlineBtn');
                    if (textBoxFontSizeInput) textBoxFontSizeInput.value = itemData.fontSize || 12;
                    if (textBoxToggleBackgroundInput) textBoxToggleBackgroundInput.checked = itemData.hasBackground !== false;
                    if (textBoxBoldBtn) textBoxBoldBtn.classList.toggle('active', !!itemData.isBold);
                    if (textBoxUnderlineBtn) textBoxUnderlineBtn.classList.toggle('active', !!itemData.isUnderlined);
                }
            }
        } else {
            if (textBoxPropertiesPanel) textBoxPropertiesPanel.style.display = 'none';
        }
    }

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
        import('./connections.js?v=1.16').then(mod => mod.clearLineSelection());
        // Hide text box properties panel when nothing is selected
        const textBoxPropertiesPanel = document.getElementById('text-box-properties-panel');
        if (textBoxPropertiesPanel) textBoxPropertiesPanel.style.display = 'none';
    }

    // Add a click handler to the canvas background to clear selection
    drawingCanvas.addEventListener('mousedown', (e) => {
        // Only clear selection if clicking the actual canvas background, not the SVG overlay or a line
        if (e.target === drawingCanvas) {
            clearSelection();
            import('./connections.js?v=1.16').then(mod => mod.clearLineSelection());
        }
    });

    let clipboardObject = null;
    // Keyboard delete, copy, paste for object or line
    document.addEventListener('keydown', (e) => {
        // Delete
        if (e.key === 'Delete' || e.key === 'Backspace') {
            selectedObjects.forEach(obj => obj.remove());
            selectedObjects.clear();
            import('./connections.js?v=1.16').then(mod => mod.deleteSelectedLine());
            doAutosave(app);
            saveState(); // Save after object/line delete
            // Update DPU and circuit displays after object is deleted
            setTimeout(() => {
                updateDPUDisplay();
                updateCircuitDisplay();
            }, 100);
        }
        // Copy (Ctrl/Cmd + C)
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
            try {
                const selectedArray = Array.from(selectedObjects);
                if (selectedArray.length === 1) {
                    let obj = selectedArray[0];
                    // Handle generic wrapper
                    if (obj.classList.contains('generic-wrapper')) {
                        const canvasItem = obj.querySelector('.canvas-item');
                        const labelDiv = obj.querySelector('.generic-label-editable');
                        const type = canvasItem.querySelector('img') ? canvasItem.querySelector('img').alt : canvasItem.textContent;
                        const imgSrc = canvasItem.querySelector('img') ? canvasItem.querySelector('img').src : null;
                        const x = parseInt(obj.style.left, 10) || 0;
                        const y = parseInt(obj.style.top, 10) || 0;
                        const rotation = obj.style.transform && obj.style.transform.match(/rotate\(([-\d.]+)deg\)/)
                            ? parseInt(obj.style.transform.match(/rotate\(([-\d.]+)deg\)/)[1], 10) || 0
                            : 0;
                        const labelText = labelDiv ? labelDiv.innerText : '';
                        const labels = labelText ? [labelText] : null;
                        clipboardObject = { type, imgSrc, x, y, labels, rotation };
                    }
                    // Handle normal canvas-item
                    else if (obj.classList.contains('canvas-item')) {
                        const type = obj.querySelector('img') ? obj.querySelector('img').alt : obj.textContent;
                        const imgSrc = obj.querySelector('img') ? obj.querySelector('img').src : null;
                        const x = parseInt(obj.style.left, 10) || 0;
                        const y = parseInt(obj.style.top, 10) || 0;
                        let labels = null;
                        if ([ 'RAK8', 'DIN4C', 'DIN4T', 'DIN8S', 'DINDLI' ].includes(type) && obj._outputLabels) {
                            labels = [...obj._outputLabels];
                        }
                        clipboardObject = { type, imgSrc, x, y, labels };
                    } else {
                        clipboardObject = null;
                    }
                }
                else {
                    clipboardObject = null;
                }
            } catch (err) {
                clipboardObject = null;
            }
        }
        // Paste (Ctrl/Cmd + V)
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
            if (clipboardObject && clipboardObject.type) {
                // Offset pasted object by 20px
                const offset = 20;
                const newX = clipboardObject.x + offset;
                const newY = clipboardObject.y + offset;
                const newObj = createCanvasObject(clipboardObject.type, clipboardObject.imgSrc, newX, newY, clipboardObject);
                setSelectedObject(newObj);
                doAutosave(app);
            }
        }
        // Select All (Ctrl+A or Cmd+A)
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
            e.preventDefault();
            // Select all objects
            Array.from(document.querySelectorAll('.canvas-item')).forEach(obj => {
                obj.classList.add('selected');
                selectedObjects.add(obj);
            });
            // Select all lines
            import('./connections.js?v=1.16').then(mod => {
                for (let i = 0; i < mod.getConnections().length; i++) {
                    mod.selectLine(i);
                }
            });
            return;
        }
    });

    // Add .selected style
    const style = document.createElement('style');
    style.textContent = `
        .canvas-item.selected { outline: 2px solid #ff6600 !important; z-index: 2000 !important; }
        .canvas-item:hover:not(.selected) { outline: 2px solid #ff6600; z-index: 2000 !important; }
        svg .selected { filter: drop-shadow(0 0 4px #ff6600); stroke: #ff6600 !important; }
        svg line:hover { stroke: #ff6600 !important; cursor: pointer; }
    `;
    document.head.appendChild(style);

    function saveState() {
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
            renderPageContent(prevState);
        }
        updateUndoRedoButtons();
    }

    function redo() {
        if (redoStack.length > 0) {
            const stateToRestore = redoStack.pop();
            undoStack.push(stateToRestore);
            renderPageContent(stateToRestore);
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
        const isInput = document.activeElement && ['input', 'textarea'].includes(document.activeElement.tagName.toLowerCase());
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
        console.debug('[renderPageContent] called with:', pageData);
        isRestoring = true;
        if (!pageData) { isRestoring = false; return; }
        // Clear all objects
        if (drawingCanvas) {
            Array.from(drawingCanvas.querySelectorAll('.canvas-item')).forEach(el => el.remove());
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
                // Restore rotation for generics and sensors
                if (typeof item.rotation === 'number' && obj.classList.contains('canvas-item')) {
                    obj.style.transform = `rotate(${item.rotation}deg)`;
                }
            });
        }
        // Restore lines
        if (svgOverlay) {
            const mod = await import('./connections.js?v=1.16');
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
            marqueeDiv.style.position = 'absolute';
            marqueeDiv.style.border = '1.5px dashed #007bff';
            marqueeDiv.style.background = 'rgba(0,123,255,0.08)';
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
                    import('./connections.js?v=1.16').then(mod => {
                        if (selectedLineIndices.length > 0) {
                            mod.selectLine(selectedLineIndices);
                        } else {
                            mod.clearLineSelection();
                        }
                    });
                }
                marqueeDiv.style.display = 'none';
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
                clearSelection();
                import('./connections.js?v=1.16').then(mod => mod.clearLineSelection());
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

    // Utility to get mouse position in canvas coordinates, accounting for zoom and pan
    const FIXED_ZOOM = 1.3;
    function getCanvasCoordinates(e) {
        const rect = drawingCanvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) / FIXED_ZOOM;
        const y = (e.clientY - rect.top) / FIXED_ZOOM;
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
            const rect = drawingCanvas.getBoundingClientRect();
            const startX = e.clientX - rect.left;
            const startY = e.clientY - rect.top;
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
        const rect = drawingCanvas.getBoundingClientRect();
        const currX = e.clientX - rect.left;
        const currY = e.clientY - rect.top;
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
        const rect = drawingCanvas.getBoundingClientRect();
        const endX = e.clientX - rect.left;
        const endY = e.clientY - rect.top;
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