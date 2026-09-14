// connections.js
// Handles drawing, editing, and rendering of connections (lines) between nodes/connectors on the canvas.

let connections = []; // Array of { x1, y1, x2, y2, color }
let drawing = false;
let startNode = null;
let tempLine = null;
let svgOverlay = null;
let currentColor = 'black';
let selectedLineIndices = [];

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
            line.setAttribute('stroke', '#ff6600');
            line.setAttribute('stroke-width', 4);
            line.classList.add('selected');
        }
        // Add hover effect, but don't override selected style
        line.addEventListener('mouseenter', (e) => {
            if (!selectedLineIndices.includes(i)) {
                line.setAttribute('stroke', '#ff9800');
                line.setAttribute('stroke-width', 4);
            }
        });
        line.addEventListener('mouseleave', (e) => {
            if (!selectedLineIndices.includes(i)) {
                line.setAttribute('stroke', conn.color || 'black');
                line.setAttribute('stroke-width', 2);
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
        svgOverlay.appendChild(line);
    });
}

export function clearConnections() {
    connections = [];
    renderConnections();
}

export function selectLine(indices) {
    if (!Array.isArray(indices)) indices = [indices];
    selectedLineIndices = indices.filter(i => i !== null && i !== undefined);
    renderConnections();
}

export function clearLineSelection() {
    selectedLineIndices = [];
    renderConnections();
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