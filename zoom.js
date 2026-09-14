// zoom.js
// Handles zooming and panning functionality for the canvas

let initialZoom = 1.3;
let initialTranslate = { x: 0, y: 0 };
let currentZoom = initialZoom;
let isPanning = false;
let startPoint = { x: 0, y: 0 };
let currentTranslate = { x: 0, y: 0 };

export function setupZoomPan() {
    const canvas = document.getElementById('drawing-canvas');
    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const zoomResetBtn = document.getElementById('zoomResetBtn');
    const zoomFitBtn = document.getElementById('zoomFitBtn');
    const panBtn = document.getElementById('panBtn');
    const zoomLevelDisplay = document.getElementById('zoomLevelDisplay');

    // Always set initial pan and zoom on load
    currentZoom = initialZoom;
    currentTranslate = { ...initialTranslate };
    updateTransform();
    updateZoomLevel();
    console.log('ZoomPan INIT', { currentZoom, currentTranslate });

    // Disable zoom buttons and mouse wheel zoom
    if (zoomInBtn) zoomInBtn.disabled = true;
    if (zoomOutBtn) zoomOutBtn.disabled = true;
    if (zoomResetBtn) zoomResetBtn.disabled = true;
    if (zoomFitBtn) zoomFitBtn.disabled = true;
    // Remove event listeners for zooming
    if (canvas) {
        canvas.onwheel = null;
    }
    // Optionally, hide the zoom bar UI
    const zoomBar = document.getElementById('zoom-bar');
    if (zoomBar) zoomBar.style.display = 'none';

    // Pan button
    if (panBtn && canvas) {
        panBtn.addEventListener('click', () => {
            isPanning = !isPanning;
            panBtn.classList.toggle('btn-primary', isPanning);
            panBtn.classList.toggle('btn-light', !isPanning);
            canvas.classList.toggle('pan-active', isPanning);
        });
    }

    // Pan handlers
    if (canvas) {
        canvas.addEventListener('mousedown', (e) => {
            if (e.button === 1) { // Middle mouse button
                isPanning = true;
                canvas.classList.add('pan-active');
                startPan(e);
            } else {
                startPan(e);
            }
        });
        document.addEventListener('mousemove', doPan);
        document.addEventListener('mouseup', (e) => {
            if (e.button === 1 && canvas) { // Middle mouse button
                isPanning = false;
                canvas.classList.remove('pan-active');
            }
            endPan(e);
        });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        // Fix: Allow spacebar in input fields
        if (document.activeElement && ['input', 'textarea'].includes(document.activeElement.tagName.toLowerCase())) return;
        if (e.code === 'Space' && !e.repeat) {
            e.preventDefault();
            if (!isPanning) {
                isPanning = true;
                panBtn.classList.add('btn-primary');
                panBtn.classList.remove('btn-light');
                canvas.classList.add('pan-active');
            }
        }
    });

    document.addEventListener('keyup', (e) => {
        if (e.code === 'Space') {
            isPanning = false;
            panBtn.classList.remove('btn-primary');
            panBtn.classList.add('btn-light');
            canvas.classList.remove('pan-active');
        }
    });

    // Expose current zoom and pan for other modules
    window.getCurrentZoomPan = function() {
        return { zoom: currentZoom, panX: currentTranslate.x, panY: currentTranslate.y };
    };
}

function startPan(e) {
    if (!isPanning) return;
    e.preventDefault();
    startPoint = { x: e.clientX - currentTranslate.x, y: e.clientY - currentTranslate.y };
    canvas.style.cursor = 'grabbing';
}

function doPan(e) {
    if (!isPanning || e.buttons === 0) return;
    e.preventDefault();
    currentTranslate = {
        x: e.clientX - startPoint.x,
        y: e.clientY - startPoint.y
    };
    updateTransform();
}

function endPan() {
    if (!isPanning) return;
    canvas.style.cursor = 'grab';
}

function zoom(delta) {
    const newZoom = Math.max(0.1, Math.min(5, currentZoom + delta));
    if (newZoom !== currentZoom) {
        currentZoom = newZoom;
        // Do not change translation when zooming
        updateTransform();
        updateZoomLevel();
    }
}

function zoomAtPoint(delta, x, y) {
    // Illustrator-style: just scale from top-left, do not adjust translation
    const newZoom = Math.max(0.1, Math.min(5, currentZoom + delta));
    if (newZoom === currentZoom) return;
    currentZoom = newZoom;
    updateTransform();
    updateZoomLevel();
}

function updateTransform() {
    const canvas = document.getElementById('drawing-canvas');
    canvas.style.transform = `translate(${currentTranslate.x}px, ${currentTranslate.y}px) scale(${currentZoom})`;
}

function updateZoomLevel() {
    const zoomLevelDisplay = document.getElementById('zoomLevelDisplay');
    if (zoomLevelDisplay) {
        zoomLevelDisplay.textContent = `${Math.round(currentZoom * 100)}%`;
    }
}

function fitToView() {
    const canvas = document.getElementById('drawing-canvas');
    const container = canvas.parentElement;
    
    // Get all components
    const components = Array.from(canvas.children);
    if (components.length === 0) return;
    
    // Calculate bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    components.forEach(comp => {
        const rect = comp.getBoundingClientRect();
        minX = Math.min(minX, rect.left);
        minY = Math.min(minY, rect.top);
        maxX = Math.max(maxX, rect.right);
        maxY = Math.max(maxY, rect.bottom);
    });
    
    // Calculate required scale
    const padding = 40;
    const scaleX = (container.clientWidth - padding * 2) / (maxX - minX);
    const scaleY = (container.clientHeight - padding * 2) / (maxY - minY);
    currentZoom = Math.min(scaleX, scaleY, 1); // Don't zoom in, only out
    
    // Center the content
    currentTranslate.x = (container.clientWidth - (maxX - minX) * currentZoom) / 2;
    currentTranslate.y = (container.clientHeight - (maxY - minY) * currentZoom) / 2;
    
    updateTransform();
    updateZoomLevel();
} 