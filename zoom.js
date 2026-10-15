// zoom.js
// View zoom and panning for the drawing canvas.
//
// How it fits together:
// - Zoom is a CSS scale on #drawing-canvas (transform-origin 0 0), inside the
//   scrolling #drawing-canvas-wrapper. Scrollbars, the mouse wheel and
//   trackpad scrolling keep working the way they always have.
// - Where the canvas sits in the view is one number per axis, its "origin":
//   the distance from the view's left/top edge to the canvas's own. Negative
//   is scrolled past the edge (the wrapper's scroll position); positive
//   floats the canvas in from the edge (its CSS left/top), which is what lets
//   the sheet zoom out around the pointer instead of collapsing into the
//   top-left corner. setOrigin() is the only thing that moves the view.
// - Nothing about the drawing changes with the view. Items keep their
//   positions in canvas pixels - the units that are saved to file and
//   printed - and anything that turns a mouse position into a canvas
//   position divides by the zoom (getCanvasCoordinates in canvas.js reads
//   the transform actually applied, so it can never disagree with this file).
// - Printing never sees the view: it clones the canvas into its own sheet
//   with its own position and fit transform, and measures with the zoom set
//   back to 100% for the duration (see atPrintScale), then restores the view.

// Steps for the - / + buttons and keys. 100% is the size it prints at.
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];
const PRINT_ZOOM = 1;
// Ctrl/Cmd + wheel and trackpad pinch: zoom factor per pixel of wheel delta.
// One notch of a typical mouse wheel (100px) is about a 16% step.
const WHEEL_ZOOM_RATE = 0.0018;
const FIT_PADDING_PX = 24;
// However far it is panned or zoomed, this much of the canvas stays on
// screen, so the drawing can't be lost off the edge of the view.
const KEEP_VISIBLE_PX = 80;

let zoom = PRINT_ZOOM;
let canvas = null;
let wrapper = null;
let spacer = null;
let handMode = false;
let pan = null; // the pan gesture in progress, if any

const clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Current view zoom (1 = 100% = print size). */
export function getZoom() {
    return zoom;
}

/**
 * Top-left of the part of the canvas currently on screen, in canvas units,
 * rounded up onto the 10px grid so it is never just off the top or left.
 * (0, 0) unless the view has been scrolled or zoomed away from the corner.
 */
export function getVisibleCanvasOrigin() {
    if (!canvas || !wrapper) return { x: 0, y: 0 };
    const o = getOrigin();
    const snapUp = (v) => Math.max(0, Math.ceil(v / 10) * 10);
    return { x: snapUp(-o.x / zoom), y: snapUp(-o.y / zoom) };
}

/**
 * Run fn with the canvas at exactly 100%, then put the view back - even if
 * fn throws. Used by print, so measuring the drawing for the printout can
 * never depend on the zoom.
 */
export async function atPrintScale(fn) {
    const saved = saveView();
    try {
        return await fn();
    } finally {
        restoreView(saved);
    }
}

/** Synchronous version of atPrintScale, for the beforeprint event. */
export function atPrintScaleSync(fn) {
    const saved = saveView();
    try {
        return fn();
    } finally {
        restoreView(saved);
    }
}

function saveView() {
    if (!canvas || !wrapper) return null;
    cancelViewAnimation();
    const saved = { zoom, origin: getOrigin() };
    applyZoom(PRINT_ZOOM);
    return saved;
}

function restoreView(saved) {
    if (!saved) return;
    applyZoom(saved.zoom);
    setOrigin(saved.origin.x, saved.origin.y);
}

export function setupZoomPan() {
    canvas = document.getElementById('drawing-canvas');
    wrapper = document.getElementById('drawing-canvas-wrapper');
    if (!canvas || !wrapper) return;

    // Invisible, and only ever as big as the current view needs: it keeps
    // the scroll range wide enough to hold the point under the pointer still
    // when zooming in near the canvas's right or bottom edge.
    spacer = document.createElement('div');
    spacer.id = 'zoom-scroll-spacer';
    spacer.setAttribute('aria-hidden', 'true');
    spacer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;';
    wrapper.appendChild(spacer);

    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const zoomResetBtn = document.getElementById('zoomResetBtn');
    const zoomFitBtn = document.getElementById('zoomFitBtn');
    const panBtn = document.getElementById('panBtn');

    applyZoom(PRINT_ZOOM);

    const zoomBar = document.getElementById('zoom-bar');
    if (zoomBar) zoomBar.style.display = 'flex';

    if (zoomInBtn) zoomInBtn.addEventListener('click', () => stepZoom(+1));
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => stepZoom(-1));
    if (zoomResetBtn) zoomResetBtn.addEventListener('click', resetView);
    if (zoomFitBtn) zoomFitBtn.addEventListener('click', fitPage);
    if (panBtn) panBtn.addEventListener('click', () => setPanMode(!handMode));

    // --- Wheel: Ctrl/Cmd + wheel (and trackpad pinch, which browsers send
    // as Ctrl + wheel) zooms around the pointer. A plain wheel is left alone
    // so it scrolls the drawing natively, as it always has.
    wrapper.addEventListener('wheel', (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16;        // lines
        else if (e.deltaMode === 2) dy *= 400;  // pages
        dy = Math.max(-150, Math.min(150, dy)); // one fast flick shouldn't jump end to end
        zoomAt(zoom * Math.exp(-dy * WHEEL_ZOOM_RATE), e.clientX, e.clientY);
    }, { passive: false });

    // Safari sends trackpad pinches as gesture events rather than Ctrl+wheel.
    let gestureStartZoom = null;
    wrapper.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureStartZoom = zoom; });
    wrapper.addEventListener('gesturechange', (e) => {
        if (gestureStartZoom == null) return;
        e.preventDefault();
        zoomAt(gestureStartZoom * e.scale, e.clientX, e.clientY);
    });
    wrapper.addEventListener('gestureend', () => { gestureStartZoom = null; });

    // --- Panning: drag with the middle mouse button at any time, or with the
    // left button while the Hand tool is on. Captured at the wrapper, before
    // anything on the canvas sees the press, so a pan never also drags an
    // item, starts a selection box or draws a line.
    wrapper.addEventListener('mousedown', (e) => {
        const wantsPan = e.button === 1 || (e.button === 0 && handMode);
        if (!wantsPan) return;
        if (isOnScrollbar(e)) return; // let the scrollbar work as normal
        startPan(e);
    }, true);
    // With the Hand tool on, clicks belong to the tool: no double-click
    // opening a RAK's label editor, no Term/Star cycling, no text editing.
    ['click', 'dblclick'].forEach(type => {
        wrapper.addEventListener(type, (e) => {
            if (handMode) { e.stopPropagation(); e.preventDefault(); }
        }, true);
    });
    // Middle-click would otherwise open the browser's autoscroll on Windows.
    wrapper.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

    // --- Keyboard: H toggles the Hand tool, Esc leaves it, + / - zoom in
    // steps around the middle of the view, 0 goes back to 100%.
    document.addEventListener('keydown', (e) => {
        if (isTyping()) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser zoom (Ctrl +/-) alone
        switch (e.key) {
            case 'h':
            case 'H':
                e.preventDefault();
                setPanMode(!handMode);
                break;
            case 'Escape':
                if (handMode) setPanMode(false);
                break;
            case '+':
            case '=':
                e.preventDefault();
                stepZoom(+1);
                break;
            case '-':
            case '_':
                e.preventDefault();
                stepZoom(-1);
                break;
            case '0':
                e.preventDefault();
                resetView();
                break;
        }
    });

    if (window.app) window.app.setPanMode = setPanMode;

    // Kept for anything that still reads the view state this way.
    window.getCurrentZoomPan = function() {
        const o = getOrigin();
        return { zoom, panX: o.x, panY: o.y };
    };
}

function isTyping() {
    const active = document.activeElement;
    if (!active) return false;
    const tag = active.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable;
}

function isOnScrollbar(e) {
    const r = wrapper.getBoundingClientRect();
    return e.clientX - r.left - wrapper.clientLeft >= wrapper.clientWidth
        || e.clientY - r.top - wrapper.clientTop >= wrapper.clientHeight;
}

/** Set the zoom without touching the canvas's position. */
function applyZoom(z) {
    zoom = clampZoom(z);
    if (canvas) canvas.style.transform = `scale(${zoom})`;
    const display = document.getElementById('zoomLevelDisplay');
    if (display) display.textContent = `${Math.round(zoom * 100)}%`;
    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    if (zoomInBtn) zoomInBtn.disabled = zoom >= MAX_ZOOM - 1e-6;
    if (zoomOutBtn) zoomOutBtn.disabled = zoom <= MIN_ZOOM + 1e-6;
}

/** Where the canvas's top-left corner is on screen, in px from the view's top-left. */
function getOrigin() {
    const c = canvas.getBoundingClientRect();
    const v = wrapper.getBoundingClientRect();
    return { x: c.left - v.left - wrapper.clientLeft, y: c.top - v.top - wrapper.clientTop };
}

/**
 * Put the canvas's top-left corner at (x, y) px from the view's top-left.
 * Past the edge (negative) is a scroll position; inside it (positive) is
 * the canvas's own left/top. Never both, so whenever the canvas reaches the
 * view's edge the scrollbars behave exactly as they always have.
 */
function setOrigin(x, y) {
    const viewW = wrapper.clientWidth;
    const viewH = wrapper.clientHeight;
    x = Math.round(clamp(x, KEEP_VISIBLE_PX - canvas.offsetWidth * zoom, viewW - KEEP_VISIBLE_PX));
    y = Math.round(clamp(y, KEEP_VISIBLE_PX - canvas.offsetHeight * zoom, viewH - KEEP_VISIBLE_PX));
    const scrollX = Math.max(0, -x);
    const scrollY = Math.max(0, -y);
    canvas.style.left = Math.max(0, x) + 'px';
    canvas.style.top = Math.max(0, y) + 'px';
    if (spacer) {
        spacer.style.width = (scrollX + viewW) + 'px';
        spacer.style.height = (scrollY + viewH) + 'px';
    }
    wrapper.scrollLeft = scrollX;
    wrapper.scrollTop = scrollY;
}

/* --- Animated view changes ---
   The zoom buttons and keys, Fit and 100% glide to the new view over a
   fifth of a second instead of jumping, so it's easy to see where you've
   ended up. Ctrl + wheel and pinch stay immediate - they are already
   continuous - and anything that moves the view by hand (a pan, a wheel
   zoom) takes over from an animation in flight. Skipped for anyone whose
   system asks for reduced motion. */
const VIEW_ANIMATION_MS = 180;
let viewAnimation = null; // { frame, targetZoom }

function cancelViewAnimation() {
    if (!viewAnimation) return;
    cancelAnimationFrame(viewAnimation.frame);
    viewAnimation = null;
}

/**
 * Glide to `targetZoom`. `originAt(z, progress)` gives where the canvas's
 * corner should be at zoom z, so each caller decides what stays put.
 */
function animateView(targetZoom, originAt) {
    cancelViewAnimation();
    targetZoom = clampZoom(targetZoom);
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const startZoom = zoom;
    const step = (progress) => {
        // Zoom eases geometrically, so 25%->50% feels as quick as 200%->400%.
        const z = startZoom * Math.pow(targetZoom / startZoom, progress);
        applyZoom(z);
        const o = originAt(zoom, progress);
        setOrigin(o.x, o.y);
    };
    if (reduce) { step(1); return; }
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const frame = (now) => {
        const t = Math.min(1, (now - start) / VIEW_ANIMATION_MS);
        step(ease(t));
        if (t < 1) viewAnimation.frame = requestAnimationFrame(frame);
        else viewAnimation = null;
    };
    viewAnimation = { frame: requestAnimationFrame(frame), targetZoom };
}

/** Where (clientX, clientY) is in the view, defaulting to the view's middle. */
function viewPoint(clientX, clientY) {
    const v = wrapper.getBoundingClientRect();
    return {
        x: (clientX == null ? v.left + wrapper.clientLeft + wrapper.clientWidth / 2 : clientX) - v.left - wrapper.clientLeft,
        y: (clientY == null ? v.top + wrapper.clientTop + wrapper.clientHeight / 2 : clientY) - v.top - wrapper.clientTop
    };
}

/**
 * Zoom to `newZoom`, keeping the canvas point under (clientX, clientY)
 * where it is on screen. Defaults to the middle of the view. Immediate,
 * or with { animate: true } a short glide that holds the same point still.
 */
function zoomAt(newZoom, clientX, clientY, { animate = false } = {}) {
    if (!canvas || !wrapper) return;
    newZoom = clampZoom(newZoom);
    if (!animate) cancelViewAnimation();
    if (Math.abs(newZoom - zoom) < 1e-4) return;
    const p = viewPoint(clientX, clientY);
    const o = getOrigin();
    const anchorX = (p.x - o.x) / zoom; // canvas units under the pointer
    const anchorY = (p.y - o.y) / zoom;
    const originAt = (z) => ({ x: p.x - anchorX * z, y: p.y - anchorY * z });
    if (animate) { animateView(newZoom, originAt); return; }
    applyZoom(newZoom);
    const target = originAt(zoom);
    setOrigin(target.x, target.y);
}

/** Next step up (+1) or down (-1), around the view's middle. Quick presses
 *  count from where the last one is heading, not from mid-glide. */
function stepZoom(direction) {
    const eps = 1e-3;
    const from = viewAnimation ? viewAnimation.targetZoom : zoom;
    const next = direction > 0
        ? ZOOM_STEPS.find(s => s > from + eps)
        : [...ZOOM_STEPS].reverse().find(s => s < from - eps);
    if (next != null) zoomAt(next, null, null, { animate: true });
}

/** Back to 100% (print size), with the canvas in the top-left corner as on first open. */
function resetView() {
    const o = getOrigin();
    animateView(PRINT_ZOOM, (z, t) => ({ x: o.x * (1 - t), y: o.y * (1 - t) }));
}

/**
 * The area to fit, in canvas units: the page, grown to take in anything
 * placed past its edges. Items are absolutely positioned, so they don't
 * stretch the canvas box itself - they are measured one by one instead.
 */
function getDrawingExtent() {
    let left = 0, top = 0, right = canvas.offsetWidth, bottom = canvas.offsetHeight;
    const c = canvas.getBoundingClientRect();
    // Labels hang outside their component's own box (circuit names to the
    // right of a RAK, Term/Star below a keypad), so they are measured too.
    canvas.querySelectorAll('.canvas-item, .generic-wrapper, .output-label, .dindli-label, .keypad-term-star-label').forEach(el => {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return;
        left = Math.min(left, (r.left - c.left) / zoom);
        top = Math.min(top, (r.top - c.top) / zoom);
        right = Math.max(right, (r.right - c.left) / zoom);
        bottom = Math.max(bottom, (r.bottom - c.top) / zoom);
    });
    canvas.querySelectorAll('#svg-overlay line:not(.temp-line)').forEach(ln => {
        const xs = [+ln.getAttribute('x1'), +ln.getAttribute('x2')];
        const ys = [+ln.getAttribute('y1'), +ln.getAttribute('y2')];
        if (![...xs, ...ys].every(Number.isFinite)) return;
        left = Math.min(left, ...xs);
        top = Math.min(top, ...ys);
        right = Math.max(right, ...xs);
        bottom = Math.max(bottom, ...ys);
    });
    return { left, top, width: right - left, height: bottom - top };
}

/** Fit the page - plus anything placed past its edges - in view, centred. */
function fitPage() {
    const area = getDrawingExtent();
    if (!area.width || !area.height) return;
    const target = clampZoom(Math.min(
        (wrapper.clientWidth - FIT_PADDING_PX * 2) / area.width,
        (wrapper.clientHeight - FIT_PADDING_PX * 2) / area.height
    ));
    const from = getOrigin();
    const to = {
        x: (wrapper.clientWidth - area.width * target) / 2 - area.left * target,
        y: (wrapper.clientHeight - area.height * target) / 2 - area.top * target
    };
    animateView(target, (z, t) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }));
}

/**
 * Hand tool on/off. Turning it on turns Draw Line off - they share
 * left-drag - quietly, so only this tool's own notice shows.
 */
export function setPanMode(on, { notify = true } = {}) {
    on = !!on;
    if (on === handMode) return;
    handMode = on;
    if (on && window.app && typeof window.app.setDrawMode === 'function') window.app.setDrawMode(false, { notify: false });
    if (wrapper) wrapper.classList.toggle('hand-mode', on);
    const panBtn = document.getElementById('panBtn');
    if (panBtn) {
        panBtn.classList.toggle('active', on);
        panBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (notify && window.app && typeof window.app.showNotification === 'function') {
        window.app.showNotification(on ? 'Hand tool: ON  (drag to move around, H or Esc to exit)' : 'Hand tool: OFF');
    }
    document.dispatchEvent(new CustomEvent('schematic:mode'));
}

function startPan(e) {
    e.preventDefault();
    e.stopPropagation();
    // Take focus off any label being edited, as a click elsewhere would.
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) {
        document.activeElement.blur();
    }
    cancelViewAnimation(); // a hand on the view takes over from a glide in flight
    pan = { button: e.button, x: e.clientX, y: e.clientY, origin: getOrigin() };
    wrapper.classList.add('is-panning');
    window.addEventListener('mousemove', onPanMove, true);
    window.addEventListener('mouseup', onPanEnd, true);
    window.addEventListener('blur', endPan);
}

function onPanMove(e) {
    if (!pan) return;
    // Released outside the window - mouseup never arrived.
    if ((e.buttons & (pan.button === 1 ? 4 : 1)) === 0) { endPan(); return; }
    e.preventDefault();
    e.stopPropagation();
    setOrigin(pan.origin.x + (e.clientX - pan.x), pan.origin.y + (e.clientY - pan.y));
}

function onPanEnd(e) {
    if (!pan || e.button !== pan.button) return;
    e.preventDefault();
    e.stopPropagation();
    endPan();
}

function endPan() {
    pan = null;
    if (wrapper) wrapper.classList.remove('is-panning');
    window.removeEventListener('mousemove', onPanMove, true);
    window.removeEventListener('mouseup', onPanEnd, true);
    window.removeEventListener('blur', endPan);
}
