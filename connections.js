// connections.js
// Handles drawing, editing, and rendering of connections (lines) between nodes/connectors on the canvas.

let connections = []; // Array of { x1, y1, x2, y2, color }
let drawing = false;
let startNode = null;
let tempLine = null;
let svgOverlay = null;
let currentColor = 'black';
let selectedLineIndices = [];
let cornerObserver = null;

const SVG_NS = 'http://www.w3.org/2000/svg';
// How far back from a right-angle corner two wires start to curve into each
// other, in canvas px (half a grid square). Kept small on purpose: the corner
// should read as clean and joined, not as a visibly rounded bend.
const CORNER_RADIUS = 5;

export function setupConnections(app) {
    // Create or get the SVG overlay for connections
    svgOverlay = document.getElementById('svg-overlay');
    if (!svgOverlay) {
        svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svgOverlay.id = 'svg-overlay';
        svgOverlay.style.position = 'absolute';
        svgOverlay.style.top = '0';
        svgOverlay.style.left = '0';
        svgOverlay.style.width = '100%';
        svgOverlay.style.height = '100%';
        svgOverlay.style.pointerEvents = 'none';
        // Insert svgOverlay as the first child of the canvas wrapper, so it is behind objects
        const canvasWrapper = document.getElementById('canvas-wrapper') || document.body;
        if (canvasWrapper.firstChild) {
            canvasWrapper.insertBefore(svgOverlay, canvasWrapper.firstChild);
        } else {
            canvasWrapper.appendChild(svgOverlay);
        }
    }
    // Clear any existing lines
    svgOverlay.innerHTML = '';
    // Dragging a wire moves its <line> directly (canvas.js sets x1..y2 as the
    // mouse moves, without a re-render), so the corners follow by watching
    // for that. Microtask timing: they are redrawn before the frame paints.
    if (!cornerObserver && typeof MutationObserver !== 'undefined') {
        cornerObserver = new MutationObserver(mutations => {
            if (mutations.every(m => m.target.classList && m.target.classList.contains('temp-line'))) return;
            renderCorners();
        });
        cornerObserver.observe(svgOverlay, { subtree: true, attributes: true, attributeFilter: ['x1', 'y1', 'x2', 'y2'] });
    }
    renderConnections();
}

export function setConnectionColor(color) {
    currentColor = color;
}

export function startConnection(fromObj, fromNode) {
    drawing = true;
    startNode = { objId: fromObj.id, nodeId: fromNode.dataset.nodeId };
    // Optionally, show a temp line following the mouse
}

export function finishConnection(toObj, toNode) {
    if (!drawing || !startNode) return;
    const newConn = {
        id: 'conn-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
        from: startNode,
        to: { objId: toObj.id, nodeId: toNode.dataset.nodeId },
        color: currentColor
    };
    connections.push(newConn);
    drawing = false;
    startNode = null;
    renderConnections();
}

export function addConnection(conn) {
    connections.push(conn);
}

export function renderConnections() {
    if (!svgOverlay) return;
    // Remove all children except temp-line
    Array.from(svgOverlay.children).forEach(child => {
        if (!child.classList.contains('temp-line')) {
            svgOverlay.removeChild(child);
        }
    });
    // Re-create all lines in the order of the connections array
    connections.forEach((conn, i) => {
        if (typeof conn.x1 !== 'number' || typeof conn.y1 !== 'number' || typeof conn.x2 !== 'number' || typeof conn.y2 !== 'number') return;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', conn.x1);
        line.setAttribute('y1', conn.y1);
        line.setAttribute('x2', conn.x2);
        line.setAttribute('y2', conn.y2);
        line.setAttribute('stroke', conn.color || 'black');
        line.setAttribute('stroke-width', 2);
        line.style.cursor = 'pointer';
        if (selectedLineIndices.includes(i)) {
            // The highlight is all CSS (svg .selected), and the line keeps its
            // own colour attribute: a selected line used to have its stroke
            // set to orange here, which the print copy kept - so a wire that
            // happened to be selected when Print was pressed printed orange.
            line.classList.add('selected');
        }
        // Add hover effect, but don't override selected style
        line.addEventListener('mouseenter', (e) => {
            if (!selectedLineIndices.includes(i)) {
                line.setAttribute('stroke-width', 3);
                (line._corners || []).forEach(c => c.setAttribute('stroke-width', 3));
            }
        });
        line.addEventListener('mouseleave', (e) => {
            if (!selectedLineIndices.includes(i)) {
                line.setAttribute('stroke', conn.color || 'black');
                line.setAttribute('stroke-width', 2);
                (line._corners || []).forEach(c => c.setAttribute('stroke-width', 2));
            }
        });
        line.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            selectLine([i]); // single selection on mousedown
            if (svgOverlay && typeof svgOverlay.focus === 'function') {
                svgOverlay.focus();
            }
        });
        if (conn.type === 'dashed') {
            line.setAttribute('stroke-dasharray', '4,3');
        } else {
            line.removeAttribute('stroke-dasharray');
        }
        // A custom-colour line: saved back as type 'custom' (canvas.js reads
        // this), so the printed legend can leave it out.
        if (conn.type === 'custom') line.setAttribute('data-line-type', 'custom');
        svgOverlay.appendChild(line);
    });
    renderCorners();
}

/**
 * Soften right-angle corners. Every wire is its own straight <line>, and those
 * lines ARE the drawing's data (saving, undo, the marquee and dragging all read
 * their x1..y2), so two wires meeting in an L used to leave a notch on the
 * outside of the corner where their square ends met.
 *
 * Where exactly two solid wires of the same colour meet end to end at a right
 * angle - and nothing else touches that point - each is drawn stopping a few
 * px short of the corner and a gentle curve joins them. The trim is a dash
 * pattern set as a style, so the lines' coordinates and stroke-dasharray
 * attribute (how a zone line is recognised) are untouched. The curve is drawn
 * in two halves, each styled as its own wire, so hovering or selecting a wire
 * highlights its half of the corner.
 *
 * Zone (dashed) lines, different colours meeting, and T-junctions keep their
 * square corners.
 */
export function renderCorners() {
    if (!svgOverlay) return;
    svgOverlay.querySelectorAll('.wire-corner').forEach(el => el.remove());

    const all = [];   // every visible wire, for "does anything else touch this point?"
    const solid = []; // the ones that can be rounded
    svgOverlay.querySelectorAll('line:not(.temp-line):not(.grid-line)').forEach(line => {
        line._corners = [];
        line.style.strokeDasharray = '';
        line.style.strokeDashoffset = '';
        const x1 = +line.getAttribute('x1'), y1 = +line.getAttribute('y1');
        const x2 = +line.getAttribute('x2'), y2 = +line.getAttribute('y2');
        if (![x1, y1, x2, y2].every(Number.isFinite)) return;
        if (x1 === x2 && y1 === y2) return; // a click with no drag: nothing drawn
        const seg = { line, x1, y1, x2, y2, len: Math.hypot(x2 - x1, y2 - y1), trim: [0, 0] };
        all.push(seg);
        const orthogonal = x1 === x2 || y1 === y2;
        if (orthogonal && !line.getAttribute('stroke-dasharray')) solid.push(seg);
    });

    // Wire ends, grouped by the point they sit on.
    const ends = new Map();
    solid.forEach(seg => {
        [[seg.x1, seg.y1, 0], [seg.x2, seg.y2, 1]].forEach(([x, y, end]) => {
            const key = x + ',' + y;
            if (!ends.has(key)) ends.set(key, []);
            ends.get(key).push({ seg, end });
        });
    });

    // How many wires touch (x, y): ending there or running through it.
    const touching = (x, y) => all.filter(s => {
        const minX = Math.min(s.x1, s.x2), maxX = Math.max(s.x1, s.x2);
        const minY = Math.min(s.y1, s.y2), maxY = Math.max(s.y1, s.y2);
        if (x < minX || x > maxX || y < minY || y > maxY) return false;
        // Wires are horizontal or vertical, so in its box means on it.
        return s.x1 === s.x2 || s.y1 === s.y2;
    }).length;

    const corners = [];
    ends.forEach(pair => {
        if (pair.length !== 2) return;
        const [a, b] = pair;
        const aHoriz = a.seg.y1 === a.seg.y2, bHoriz = b.seg.y1 === b.seg.y2;
        if (aHoriz === bHoriz) return; // straight on, not a corner
        if (a.seg.line.getAttribute('stroke') !== b.seg.line.getAttribute('stroke')) return;
        const px = a.end ? a.seg.x2 : a.seg.x1, py = a.end ? a.seg.y2 : a.seg.y1;
        if (touching(px, py) !== 2) return;
        // Never more than half a wire, so a short wire can curve at both ends.
        const r = Math.min(CORNER_RADIUS, a.seg.len / 2, b.seg.len / 2);
        a.seg.trim[a.end] = r;
        b.seg.trim[b.end] = r;
        corners.push({ px, py, r, a, b });
    });

    corners.forEach(({ px, py, r, a, b }) => {
        // Where each wire's straight part now stops: r back along it from the corner.
        const away = ({ seg, end }) => {
            const [fx, fy, tx, ty] = end ? [seg.x2, seg.y2, seg.x1, seg.y1] : [seg.x1, seg.y1, seg.x2, seg.y2];
            return { x: fx + Math.sign(tx - fx) * r, y: fy + Math.sign(ty - fy) * r };
        };
        const pa = away(a), pb = away(b);
        // One quadratic curve from pa to pb with its control point on the
        // corner, split at its midpoint so each wire owns its half.
        const mid = { x: (pa.x + 2 * px + pb.x) / 4, y: (pa.y + 2 * py + pb.y) / 4 };
        addCornerHalf(a.seg.line, `M ${pa.x} ${pa.y} Q ${(pa.x + px) / 2} ${(pa.y + py) / 2} ${mid.x} ${mid.y}`);
        addCornerHalf(b.seg.line, `M ${mid.x} ${mid.y} Q ${(px + pb.x) / 2} ${(py + pb.y) / 2} ${pb.x} ${pb.y}`);
    });

    // Stop each rounded wire short of its corners: a single dash covering the
    // middle of the line, starting trim[0] in from x1,y1.
    solid.forEach(seg => {
        const [s, e] = seg.trim;
        if (!s && !e) return;
        seg.line.style.strokeDasharray = `${seg.len - s - e} ${s + e}`;
        seg.line.style.strokeDashoffset = String(s ? seg.len - s : 0);
    });
}

function addCornerHalf(line, d) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', line.getAttribute('stroke') || 'black');
    path.setAttribute('stroke-width', line.getAttribute('stroke-width') || 2);
    // Round ends tuck into the wire on either side, so no hairline seam shows.
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('pointer-events', 'none');
    path.classList.add('wire-corner');
    if (line.classList.contains('selected')) {
        // On top, so the unselected wire's half doesn't cap over the highlight.
        path.classList.add('selected');
        svgOverlay.appendChild(path);
    } else {
        line.after(path);
    }
    line._corners.push(path);
}

export function clearConnections() {
    connections = [];
    renderConnections();
}

export function selectLine(indices) {
    if (!Array.isArray(indices)) indices = [indices];
    selectedLineIndices = indices.filter(i => i !== null && i !== undefined);
    renderConnections();
    document.dispatchEvent(new CustomEvent('schematic:lineselection')); // for the status bar's count
}

export function clearLineSelection() {
    const had = selectedLineIndices.length > 0;
    selectedLineIndices = [];
    renderConnections();
    if (had) document.dispatchEvent(new CustomEvent('schematic:lineselection'));
}

export function deleteSelectedLine() {
    // Delete all selected lines
    selectedLineIndices.sort((a, b) => b - a).forEach(idx => {
        if (connections[idx]) connections.splice(idx, 1);
    });
    selectedLineIndices = [];
    renderConnections();
}

export function getSelectedLineIndices() {
    return [...selectedLineIndices];
}

export function getConnections() {
    return connections.map(conn => ({...conn}));
}

export function setConnections(newConnections) {
    connections = newConnections.map(conn => ({...conn}));
    renderConnections();
}

export function updateConnectionLine(oldX1, oldY1, oldX2, oldY2, color, newX1, newY1, newX2, newY2) {
    const conn = connections.find(c =>
        c.x1 === oldX1 && c.y1 === oldY1 &&
        c.x2 === oldX2 && c.y2 === oldY2 &&
        c.color === color
    );
    if (conn) {
        conn.x1 = newX1;
        conn.y1 = newY1;
        conn.x2 = newX2;
        conn.y2 = newY2;
    }
}

export function findAndSelectLineByEndpoints(x1, y1, x2, y2, color) {
    const idx = connections.findIndex(conn =>
        conn.x1 === x1 && conn.y1 === y1 && conn.x2 === x2 && conn.y2 === y2 && (conn.color === color || !conn.color)
    );
    if (idx !== -1) {
        selectLine(idx);
    }
}

export function updateConnectionLineByIndex(index, x1, y1, x2, y2) {
    if (connections[index]) {
        connections[index].x1 = x1;
        connections[index].y1 = y1;
        connections[index].x2 = x2;
        connections[index].y2 = y2;
    }
}

// TODO: Add selection, deletion, temp line, and integration with canvas.js for node events.

// At the end of the file, attach all exports to window.connections for cross-module access
if (typeof window !== 'undefined') {
    window.connections = {
        setupConnections,
        setConnectionColor,
        startConnection,
        finishConnection,
        addConnection,
        renderConnections,
        clearConnections,
        selectLine,
        clearLineSelection,
        deleteSelectedLine,
        getSelectedLineIndices,
        getConnections,
        setConnections,
        updateConnectionLine,
        findAndSelectLineByEndpoints,
        updateConnectionLineByIndex
    };
} 