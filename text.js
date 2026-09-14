// text.js
// Handles text tool logic for the schematic canvas

let drawingCanvas, addTextBtn, textBoxPropertiesPanel, textBoxFontSizeInput, textBoxBoldBtn, textBoxUnderlineBtn, textBoxToggleBackgroundInput;
let itemsOnCanvas, selectedItems;
let itemIdCounter = 1;
const GRID_SIZE = 20;
let _makeItemDraggable = null;
let _saveState = null;

export function initTextTool(canvasEl, toolbarEl, propertiesPanelEl, {
    fontSizeInput, boldBtn, underlineBtn, toggleBackgroundInput
}, _itemsOnCanvas, _selectedItems, makeItemDraggable, saveState) {
    drawingCanvas = canvasEl;
    addTextBtn = toolbarEl;
    textBoxPropertiesPanel = propertiesPanelEl;
    textBoxFontSizeInput = fontSizeInput;
    textBoxBoldBtn = boldBtn;
    textBoxUnderlineBtn = underlineBtn;
    textBoxToggleBackgroundInput = toggleBackgroundInput;
    itemsOnCanvas = _itemsOnCanvas;
    selectedItems = _selectedItems;
    _makeItemDraggable = makeItemDraggable;
    _saveState = saveState;

    if (addTextBtn) {
        addTextBtn.addEventListener('click', () => {
            // Place at top left of the canvas
            let x = 0;
            let y = 0;
            // Snap to grid
            x = Math.round(x / GRID_SIZE) * GRID_SIZE;
            y = Math.round(y / GRID_SIZE) * GRID_SIZE;
            createTextBoxOnCanvas(x, y, '', null, false, { hasBackground: false });
        });
    }

    // Properties panel events
    textBoxFontSizeInput.addEventListener('input', () => {
        if (selectedItems.size === 1) {
            const selectedItemId = selectedItems.values().next().value;
            const itemData = itemsOnCanvas.get(selectedItemId);
            if (itemData && itemData.type === 'TextBox') {
                const newSize = parseInt(textBoxFontSizeInput.value, 10);
                if (newSize >= 8 && newSize <= 72) {
                    itemData.fontSize = newSize;
                    itemData.element.querySelector('input').style.fontSize = `${newSize}px`;
                    itemData.element.querySelector('input').focus();
                    _saveState();
                }
            }
        }
    });
    textBoxToggleBackgroundInput.addEventListener('change', () => {
        if (selectedItems.size === 1) {
            const selectedItemId = selectedItems.values().next().value;
            const itemData = itemsOnCanvas.get(selectedItemId);
            if (itemData && itemData.type === 'TextBox') {
                itemData.hasBackground = textBoxToggleBackgroundInput.checked;
                itemData.element.style.backgroundColor = itemData.hasBackground ? 'rgba(255, 255, 255, 0.9)' : 'transparent';
                _saveState();
            }
        }
    });
    textBoxBoldBtn.addEventListener('click', () => {
        if (selectedItems.size === 1) {
            const selectedItemId = selectedItems.values().next().value;
            const itemData = itemsOnCanvas.get(selectedItemId);
            if (itemData && itemData.type === 'TextBox') {
                itemData.isBold = !itemData.isBold;
                itemData.element.querySelector('input').style.fontWeight = itemData.isBold ? 'bold' : 'normal';
                textBoxBoldBtn.classList.toggle('active', itemData.isBold);
                _saveState();
            }
        }
    });
    textBoxUnderlineBtn.addEventListener('click', () => {
        if (selectedItems.size === 1) {
            const selectedItemId = selectedItems.values().next().value;
            const itemData = itemsOnCanvas.get(selectedItemId);
            if (itemData && itemData.type === 'TextBox') {
                itemData.isUnderlined = !itemData.isUnderlined;
                itemData.element.querySelector('input').style.textDecoration = itemData.isUnderlined ? 'underline' : 'none';
                textBoxUnderlineBtn.classList.toggle('active', itemData.isUnderlined);
                _saveState();
            }
        }
    });
}

export function createTextBoxOnCanvas(x, y, text = "", existingId = null, skipSave = false, itemProps = {}) {
    const id = existingId || `item-${itemIdCounter++}`;
    const textBoxDiv = document.createElement('div');
    textBoxDiv.classList.add('canvas-item', 'canvas-text-box');
    textBoxDiv.id = id;
    textBoxDiv.style.left = `${x}px`;
    textBoxDiv.style.top = `${y}px`;
    textBoxDiv.dataset.itemType = 'textbox';

    const fontSize = itemProps.fontSize || 12;
    const hasBackground = itemProps.hasBackground === undefined ? true : itemProps.hasBackground;
    const isBold = itemProps.isBold || false;
    const isUnderlined = itemProps.isUnderlined || false;

    textBoxDiv.style.backgroundColor = hasBackground ? 'rgba(255, 255, 255, 0.9)' : 'transparent';

    // Use a single-line input that expands as text is added
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = "Type here...";
    input.value = text;
    input.style.fontSize = `${fontSize}px`;
    input.style.fontWeight = isBold ? 'bold' : 'normal';
    input.style.textDecoration = isUnderlined ? 'underline' : 'none';
    input.style.width = '50px';
    input.style.minWidth = '50px';
    input.style.background = 'transparent';
    input.style.border = 'none';
    input.style.outline = 'none';
    input.style.resize = 'none';
    input.style.overflow = 'hidden';
    input.style.boxSizing = 'border-box';

    // Auto-expand width as text is entered
    function updateInputWidth() {
        // Create a temporary span to measure text width
        const span = document.createElement('span');
        span.style.visibility = 'hidden';
        span.style.position = 'absolute';
        span.style.fontSize = input.style.fontSize;
        span.style.fontWeight = input.style.fontWeight;
        span.style.fontFamily = 'Avenir, Arial, sans-serif';
        span.style.whiteSpace = 'pre';
        span.textContent = input.value || input.placeholder;
        document.body.appendChild(span);
        input.style.width = (span.offsetWidth + 20) + 'px';
        document.body.removeChild(span);
    }
    input.addEventListener('input', () => {
        updateInputWidth();
        const itemData = itemsOnCanvas.get(id);
        if (itemData) itemData.text = input.value;
        _saveState();
    });
    // Initial width
    updateInputWidth();

    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
            e.preventDefault();
            const itemData = itemsOnCanvas.get(id);
            if (itemData) {
                itemData.isBold = !itemData.isBold;
                input.style.fontWeight = itemData.isBold ? 'bold' : 'normal';
                if (typeof textBoxBoldBtn !== 'undefined') textBoxBoldBtn.classList.toggle('active', itemData.isBold);
                _saveState();
            }
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'u') {
            e.preventDefault();
            const itemData = itemsOnCanvas.get(id);
            if (itemData) {
                itemData.isUnderlined = !itemData.isUnderlined;
                input.style.textDecoration = itemData.isUnderlined ? 'underline' : 'none';
                if (typeof textBoxUnderlineBtn !== 'undefined') textBoxUnderlineBtn.classList.toggle('active', itemData.isUnderlined);
                _saveState();
            }
        } else if (e.key === 'Backspace' || e.key === 'Delete') {
            // Prevent backspace/delete from bubbling up and deleting the object
            e.stopPropagation();
        }
    });
    textBoxDiv.appendChild(input);

    // Add click event to select this text box
    textBoxDiv.addEventListener('mousedown', (e) => {
        // Only select if clicking the box itself, not the input
        if (e.target === textBoxDiv) {
            if (typeof window.setSelectedObject === 'function') {
                window.setSelectedObject(textBoxDiv);
            }
        }
    });

    drawingCanvas.appendChild(textBoxDiv);
    itemsOnCanvas.set(id, {
        element: textBoxDiv, x, y, type: 'TextBox', connections: [],
        fontSize, hasBackground, isBold, isUnderlined, id, text
    });
    _makeItemDraggable(textBoxDiv);
    if (!skipSave) _saveState();
    return textBoxDiv;
} 