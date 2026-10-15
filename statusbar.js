// statusbar.js
// The strip under the canvas: what a drag will do right now (with the keys
// that go with it), how much is selected, and where the pointer is on the
// printed page. It only listens - canvas.js, zoom.js and text.js announce
// changes with schematic:mode / schematic:drag / schematic:selection events.

const MM_PER_PX = 25.4 / 96;

const MODES = {
    select: ['Select', 'Drag to move · Shift+click to add or remove · Arrow keys nudge · / adds a component'],
    draw:   ['Draw Line', 'Drag across the grid to draw a cable · Q W A S D R F set the cable type · Esc to finish'],
    hand:   ['Hand', 'Drag to move around the drawing · H or Esc to finish'],
    text:   ['Editing text', 'Highlight words to format them · Esc or a click elsewhere to finish'],
    drag:   ['Moving', 'Guides show when edges or centres line up · hold Alt or Ctrl to place on the grid only']
};

export function setupStatusBar(app) {
    const modeEl = document.getElementById('statusMode');
    const hintEl = document.getElementById('statusHint');
    const selectionEl = document.getElementById('statusSelection');
    const pointerEl = document.getElementById('statusPointer');
    const wrapper = document.getElementById('drawing-canvas-wrapper');
    const canvas = document.getElementById('drawing-canvas');
    if (!modeEl || !wrapper || !canvas) return;

    let dragging = false;
    const currentMode = () => {
        if (dragging) return 'drag';
        if (document.querySelector('.canvas-text-box.editing')) return 'text';
        if (canvas.classList.contains('draw-mode')) return 'draw';
        if (wrapper.classList.contains('hand-mode')) return 'hand';
        return 'select';
    };
    const renderMode = () => {
        const key = currentMode();
        const [name, hint] = MODES[key];
        modeEl.textContent = name;
        modeEl.dataset.mode = key;
        hintEl.textContent = hint;
    };

    document.addEventListener('schematic:mode', renderMode);
    document.addEventListener('schematic:drag', (e) => {
        dragging = !!(e.detail && e.detail.active);
        renderMode();
    });
    document.addEventListener('schematic:selection', (e) => {
        const n = e.detail ? e.detail.count : 0;
        selectionEl.textContent = n ? `${n} selected` : '';
    });

    // Pointer position in mm on the printed page, measured from the drawing
    // area's top-left corner - at most once a frame.
    let frame = null, last = null;
    wrapper.addEventListener('mousemove', (e) => {
        last = e;
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = null;
            if (!last || typeof app.canvasPointFromClient !== 'function') return;
            const p = app.canvasPointFromClient(last.clientX, last.clientY);
            pointerEl.textContent = `x ${Math.round(p.x * MM_PER_PX)}  y ${Math.round(p.y * MM_PER_PX)} mm`;
        });
    });
    wrapper.addEventListener('mouseleave', () => { last = null; pointerEl.textContent = ''; });

    renderMode();
}
