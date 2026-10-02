// text.js
// Handles text tool logic for the schematic canvas: a contenteditable,
// multi-line, auto-wrapping label with rich formatting (bold/italic/
// underline/colour/alignment/lists), rather than a single-line plain input.

let drawingCanvas, addTextBtn, textBoxPropertiesPanel;
let fontSizeInput, boldBtn, italicBtn, underlineBtn, colorInput;
let alignLeftBtn, alignCenterBtn, alignRightBtn, bulletListBtn, numberListBtn;
let toggleBackgroundInput;
let itemsOnCanvas, selectedItems;
let itemIdCounter = 1;
const GRID_SIZE = 20;
const DEFAULT_WIDTH = 200;
let _makeItemDraggable = null;
let _saveState = null;

/* ------------------------------------------------------------------ *
 * A small allowlist-based sanitizer. Text box content is set via
 * innerHTML both on load (a saved/shared file could be hand-edited or
 * corrupted) and on paste (clipboard content from anywhere), so it must
 * never be trusted as-is - this rebuilds a clean tree from only the tags
 * and style properties the formatting toolbar itself can ever produce.
 * ------------------------------------------------------------------ */
const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'BR', 'DIV', 'SPAN', 'P']);
const ALLOWED_STYLE_PROPS = new Set(['color', 'text-align']);
// Their "text content" is source code/non-prose data, not something a
// disallowed-tag's text should ever be kept for (unlike e.g. a stray <a>,
// where showing the link text as plain text is reasonable).
const DISCARD_ENTIRELY_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE']);

function sanitizeHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html || '';

    function cleanNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return node.cloneNode();
        if (node.nodeType !== Node.ELEMENT_NODE) return null;
        if (DISCARD_ENTIRELY_TAGS.has(node.tagName)) return null;
        if (!ALLOWED_TAGS.has(node.tagName)) {
            // Not an allowed element - keep its text content (e.g. a
            // pasted <a> becomes plain text), drop the tag itself.
            const frag = document.createDocumentFragment();
            Array.from(node.childNodes).forEach(child => {
                const cleaned = cleanNode(child);
                if (cleaned) frag.appendChild(cleaned);
            });
            return frag;
        }
        const clean = document.createElement(node.tagName);
        const style = node.getAttribute('style');
        if (style) {
            const kept = [];
            style.split(';').forEach(decl => {
                const [prop, ...rest] = decl.split(':');
                if (!prop || !rest.length) return;
                const p = prop.trim().toLowerCase();
                if (ALLOWED_STYLE_PROPS.has(p)) kept.push(`${p}:${rest.join(':').trim()}`);
            });
            if (kept.length) clean.setAttribute('style', kept.join(';'));
        }
        Array.from(node.childNodes).forEach(child => {
            const cleaned = cleanNode(child);
            if (cleaned) clean.appendChild(cleaned);
        });
        return clean;
    }

    const out = document.createElement('div');
    Array.from(template.content.childNodes).forEach(child => {
        const cleaned = cleanNode(child);
        if (cleaned) out.appendChild(cleaned);
    });
    return out.innerHTML;
}

function withSelectedTextBox(fn) {
    if (selectedItems.size !== 1) return;
    const id = selectedItems.values().next().value;
    const itemData = itemsOnCanvas.get(id);
    if (itemData && itemData.type === 'TextBox') fn(itemData);
}

function focusEditable(itemData) {
    const editable = itemData.element.querySelector('.text-editable');
    if (editable) editable.focus();
}

export function initTextTool(canvasEl, toolbarEl, propertiesPanelEl, controls, _itemsOnCanvas, _selectedItems, makeItemDraggable, saveState) {
    drawingCanvas = canvasEl;
    addTextBtn = toolbarEl;
    textBoxPropertiesPanel = propertiesPanelEl;
    fontSizeInput = controls.fontSizeInput;
    boldBtn = controls.boldBtn;
    italicBtn = controls.italicBtn;
    underlineBtn = controls.underlineBtn;
    colorInput = controls.colorInput;
    alignLeftBtn = controls.alignLeftBtn;
    alignCenterBtn = controls.alignCenterBtn;
    alignRightBtn = controls.alignRightBtn;
    bulletListBtn = controls.bulletListBtn;
    numberListBtn = controls.numberListBtn;
    toggleBackgroundInput = controls.toggleBackgroundInput;
    itemsOnCanvas = _itemsOnCanvas;
    selectedItems = _selectedItems;
    _makeItemDraggable = makeItemDraggable;
    _saveState = saveState;

    if (addTextBtn) {
        addTextBtn.addEventListener('click', () => {
            const box = createTextBoxOnCanvas(0, 0, '', null, false, { hasBackground: false });
            if (typeof window.setSelectedObject === 'function') window.setSelectedObject(box);
            setTimeout(() => focusEditable(itemsOnCanvas.get(box.id)), 0);
        });
    }

    // --- Whole-box properties (font size, background) ---
    if (fontSizeInput) {
        fontSizeInput.addEventListener('input', () => {
            withSelectedTextBox(itemData => {
                const newSize = parseInt(fontSizeInput.value, 10);
                if (newSize >= 8 && newSize <= 72) {
                    itemData.fontSize = newSize;
                    itemData.element.querySelector('.text-editable').style.fontSize = `${newSize}px`;
                    _saveState();
                }
            });
        });
    }
    if (toggleBackgroundInput) {
        toggleBackgroundInput.addEventListener('change', () => {
            withSelectedTextBox(itemData => {
                itemData.hasBackground = toggleBackgroundInput.checked;
                itemData.element.style.backgroundColor = itemData.hasBackground ? 'rgba(255, 255, 255, 0.9)' : 'transparent';
                _saveState();
            });
        });
    }

    // --- Rich formatting, applied to the current selection within the box ---
    function applyCommand(command, value = null) {
        withSelectedTextBox(itemData => {
            focusEditable(itemData);
            document.execCommand(command, false, value);
            syncTextFromDom(itemData);
            _saveState();
        });
    }
    if (boldBtn) boldBtn.addEventListener('click', () => applyCommand('bold'));
    if (italicBtn) italicBtn.addEventListener('click', () => applyCommand('italic'));
    if (underlineBtn) underlineBtn.addEventListener('click', () => applyCommand('underline'));
    if (colorInput) colorInput.addEventListener('input', () => applyCommand('foreColor', colorInput.value));
    if (alignLeftBtn) alignLeftBtn.addEventListener('click', () => applyCommand('justifyLeft'));
    if (alignCenterBtn) alignCenterBtn.addEventListener('click', () => applyCommand('justifyCenter'));
    if (alignRightBtn) alignRightBtn.addEventListener('click', () => applyCommand('justifyRight'));
    if (bulletListBtn) bulletListBtn.addEventListener('click', () => applyCommand('insertUnorderedList'));
    if (numberListBtn) numberListBtn.addEventListener('click', () => applyCommand('insertOrderedList'));
}

function syncTextFromDom(itemData) {
    const editable = itemData.element.querySelector('.text-editable');
    if (!editable) return;
    itemData.html = sanitizeHtml(editable.innerHTML);
    itemData.text = editable.innerText;
}

export function createTextBoxOnCanvas(x, y, text = "", existingId = null, skipSave = false, itemProps = {}) {
    const id = existingId || `item-${itemIdCounter++}`;
    const textBoxDiv = document.createElement('div');
    textBoxDiv.classList.add('canvas-item', 'canvas-text-box');
    textBoxDiv.id = id;
    textBoxDiv.style.left = `${x}px`;
    textBoxDiv.style.top = `${y}px`;
    textBoxDiv.style.width = `${itemProps.width || DEFAULT_WIDTH}px`;
    textBoxDiv.dataset.itemType = 'textbox';

    const fontSize = itemProps.fontSize || 12;
    const hasBackground = itemProps.hasBackground === undefined ? true : itemProps.hasBackground;
    textBoxDiv.style.backgroundColor = hasBackground ? 'rgba(255, 255, 255, 0.9)' : 'transparent';

    const editable = document.createElement('div');
    editable.className = 'text-editable';
    editable.contentEditable = 'true';
    editable.style.fontSize = `${fontSize}px`;
    editable.style.outline = 'none';
    editable.style.whiteSpace = 'pre-wrap';
    editable.style.wordWrap = 'break-word';
    editable.style.minWidth = '30px';
    editable.style.minHeight = '1.3em';

    // itemProps.html (rich content) takes precedence; itemProps.text/the
    // legacy `text` argument is a plain-text fallback for files saved
    // before rich formatting existed.
    const initialHtml = itemProps.html
        ? sanitizeHtml(itemProps.html)
        : (text ? text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : '');
    editable.innerHTML = initialHtml;
    editable.setAttribute('data-placeholder', 'Type here...');

    editable.addEventListener('mousedown', (e) => e.stopPropagation());
    editable.addEventListener('input', () => {
        const itemData = itemsOnCanvas.get(id);
        if (itemData) syncTextFromDom(itemData);
        _saveState();
    });
    editable.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = (e.clipboardData || window.clipboardData).getData('text/html')
            || (e.clipboardData || window.clipboardData).getData('text/plain');
        const isHtml = !!(e.clipboardData || window.clipboardData).getData('text/html');
        if (isHtml) {
            document.execCommand('insertHTML', false, sanitizeHtml(pasted));
        } else {
            document.execCommand('insertText', false, pasted);
        }
    });
    editable.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
            e.preventDefault();
            document.execCommand('bold');
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
            e.preventDefault();
            document.execCommand('italic');
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'u') {
            e.preventDefault();
            document.execCommand('underline');
        } else if (e.key === 'Backspace' || e.key === 'Delete') {
            // Prevent backspace/delete from bubbling up and deleting the object
            e.stopPropagation();
        } else if (e.key === 'Escape') {
            editable.blur();
        }
    });
    textBoxDiv.appendChild(editable);

    textBoxDiv.addEventListener('mousedown', (e) => {
        if (e.target === textBoxDiv) {
            if (typeof window.setSelectedObject === 'function') {
                window.setSelectedObject(textBoxDiv, e.shiftKey);
            }
        }
    });

    drawingCanvas.appendChild(textBoxDiv);
    itemsOnCanvas.set(id, {
        element: textBoxDiv, x, y, type: 'TextBox', connections: [],
        fontSize, hasBackground, id, text: editable.innerText, html: initialHtml,
        width: itemProps.width || DEFAULT_WIDTH
    });
    _makeItemDraggable(textBoxDiv);
    if (!skipSave) _saveState();
    return textBoxDiv;
}
