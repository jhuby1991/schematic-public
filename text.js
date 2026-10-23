// text.js
// Handles text tool logic for the schematic canvas: a contenteditable,
// multi-line, auto-wrapping label with rich formatting (bold/italic/
// underline/colour/alignment/lists), rather than a single-line plain input.

import { getVisibleCanvasOrigin, getZoom } from './zoom.js?v=1.55';

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

/* ------------------------------------------------------------------ *
 * Moving vs editing
 *
 * Click a text box to select it: drag from anywhere on it to move it,
 * and the formatting buttons apply to all of its text. Double-click it,
 * or press Enter, to edit: then the text takes a caret, dragging selects
 * text, and the formatting buttons apply to just what is highlighted.
 * Esc or a click elsewhere finishes editing.
 *
 * A box added with the Label button starts selected, not being edited,
 * so it can be dragged into place first. It used to open ready to type,
 * which held it where it landed (the top-left corner) until Esc. Typing
 * straight away still works: see "Typing into a new, empty box" below.
 * A second click on a selected box no longer edits it either - that
 * caught people who clicked the new box to pick it up.
 *
 * It used to be editable all the time, so only its 5px border would move
 * it, and a click into the text never selected the box - the formatting
 * buttons then had no box to act on and did nothing.
 * ------------------------------------------------------------------ */
let editingBox = null;   // the box whose text is being edited, if any
let savedRange = null;   // the last selection inside it, kept while a panel control has focus

const getEditable = (box) => box.querySelector('.text-editable');

function isEditing(box) {
    return !!box && box === editingBox && box.isConnected;
}

function selectRange(range) {
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
}

export function startEditing(box, { clientX = null, clientY = null, word = false } = {}) {
    if (!box || !box.isConnected) return;
    if (editingBox && editingBox !== box) stopEditing();
    // The panel's buttons act on the selected box, so make sure it is this one.
    if (!(selectedItems.size === 1 && selectedItems.has(box.id)) && typeof window.setSelectedObject === 'function') {
        window.setSelectedObject(box);
    }
    const editable = getEditable(box);
    const already = editingBox === box;
    editingBox = box;
    editable.contentEditable = 'true';
    box.classList.add('editing');
    editable.focus();
    if (already && clientX == null) return;
    // Caret where the pointer is, if it's over the text; otherwise at the end.
    let range = null;
    if (clientX != null && document.caretRangeFromPoint) range = document.caretRangeFromPoint(clientX, clientY);
    if (!range || !editable.contains(range.startContainer)) {
        range = document.createRange();
        range.selectNodeContents(editable);
        range.collapse(false);
    }
    selectRange(range);
    if (word) {
        const sel = window.getSelection();
        if (sel && sel.modify) { sel.modify('move', 'backward', 'word'); sel.modify('extend', 'forward', 'word'); }
    }
    updateToolbarState();
    document.dispatchEvent(new CustomEvent('schematic:mode'));
}

export function stopEditing() {
    const box = editingBox;
    editingBox = null;
    savedRange = null;
    if (!box) return;
    const editable = getEditable(box);
    box.classList.remove('editing');
    if (editable) {
        editable.contentEditable = 'false';
        const sel = window.getSelection();
        if (sel && sel.rangeCount && editable.contains(sel.anchorNode)) sel.removeAllRanges();
        if (document.activeElement === editable) editable.blur();
        const itemData = itemsOnCanvas.get(box.id);
        if (itemData) syncTextFromDom(itemData);
    }
    updateToolbarState();
    document.dispatchEvent(new CustomEvent('schematic:mode'));
}

/** Show which styles apply where the caret is: B / I / U and alignment light up. */
function updateToolbarState() {
    const editing = isEditing(editingBox);
    const state = (cmd) => { try { return editing && document.queryCommandState(cmd); } catch (e) { return false; } };
    [[boldBtn, 'bold'], [italicBtn, 'italic'], [underlineBtn, 'underline'],
     [alignLeftBtn, 'justifyLeft'], [alignCenterBtn, 'justifyCenter'], [alignRightBtn, 'justifyRight'],
     [bulletListBtn, 'insertUnorderedList'], [numberListBtn, 'insertOrderedList']].forEach(([btn, cmd]) => {
        if (btn) btn.classList.toggle('active', !!state(cmd));
    });
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
            // Top-left of whatever part of the drawing is on screen - (0, 0)
            // as before unless the view has been scrolled or zoomed away
            // from the corner, where a box at (0, 0) would appear off-screen.
            const at = getVisibleCanvasOrigin();
            const box = createTextBoxOnCanvas(at.x, at.y, '', null, false, { hasBackground: false });
            // Selected, ready to drag into place; double-click (or Enter) to type.
            if (typeof window.setSelectedObject === 'function') window.setSelectedObject(box);
        });
    }

    // Typing into a new, empty box: with one selected and not being edited,
    // a typed character starts editing it and goes in. Otherwise the keys
    // would be app shortcuts - "Lounge" would turn on Draw Line (L) and
    // change the cable colour (S). Runs before those shortcut handlers;
    // moving focus during keydown sends the character to the box. Only
    // for an empty box, so a box with text keeps its shortcuts; Space is
    // left alone (it toggles Draw Line).
    window.addEventListener('keydown', (e) => {
        if (e.key.length !== 1 || e.key === ' ' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable)) return;
        if (document.querySelector('.modal.show')) return;
        withSelectedTextBox(itemData => {
            const box = itemData.element;
            if (isEditing(box) || !box.isConnected) return;
            const editable = getEditable(box);
            if (!editable || editable.textContent !== '') return;
            e.stopImmediatePropagation(); // not a shortcut
            startEditing(box);
        });
    }, true);

    // Keep track of the highlighted text while editing, so a panel control
    // that takes focus (the colour picker, the font size box) can still
    // apply to it, and keep B / I / U showing what's under the caret.
    document.addEventListener('selectionchange', () => {
        if (!isEditing(editingBox)) return;
        const sel = window.getSelection();
        const editable = getEditable(editingBox);
        if (sel && sel.rangeCount && editable.contains(sel.anchorNode)) {
            savedRange = sel.getRangeAt(0).cloneRange();
            updateToolbarState();
        }
    });

    // A press anywhere other than the box being edited or its panel
    // finishes editing (the box stays selected if it was the target).
    document.addEventListener('mousedown', (e) => {
        if (!editingBox) return;
        if (!editingBox.isConnected) { editingBox = null; savedRange = null; updateToolbarState(); return; }
        if (editingBox.contains(e.target)) return;
        if (textBoxPropertiesPanel && textBoxPropertiesPanel.contains(e.target)) return;
        stopEditing();
    }, true);

    // Enter (or F2) on a selected text box starts editing it.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== 'F2') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'BUTTON' || active.tagName === 'SELECT' || active.isContentEditable)) return;
        withSelectedTextBox(itemData => {
            e.preventDefault();
            startEditing(itemData.element);
        });
    });

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
        // Leaving the box settles an out-of-range size on the nearest one
        // allowed (8-72) and shows it. 500 used to leave the text at 50px -
        // the last in-range value typed on the way - with 500 in the box.
        fontSizeInput.addEventListener('change', () => {
            withSelectedTextBox(itemData => {
                const typed = parseInt(fontSizeInput.value, 10);
                const size = Number.isFinite(typed) ? Math.max(8, Math.min(72, typed)) : (itemData.fontSize || 12);
                fontSizeInput.value = size;
                if (size !== itemData.fontSize) {
                    itemData.fontSize = size;
                    itemData.element.querySelector('.text-editable').style.fontSize = `${size}px`;
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

    // --- Rich formatting ---
    // While editing: applies to the highlighted text (or the word at the
    // caret, as a word processor does). With the box selected but not being
    // edited: applies to all of its text.
    function applyCommand(command, value = null) {
        withSelectedTextBox(itemData => {
            const box = itemData.element;
            const editable = getEditable(box);
            if (!editable) return;
            if (isEditing(box)) {
                editable.focus();
                if (savedRange && editable.contains(savedRange.commonAncestorContainer)) selectRange(savedRange);
                document.execCommand(command, false, value);
            } else {
                editable.contentEditable = 'true';
                editable.focus();
                const all = document.createRange();
                all.selectNodeContents(editable);
                selectRange(all);
                document.execCommand(command, false, value);
                window.getSelection().removeAllRanges();
                editable.contentEditable = 'false';
                editable.blur();
            }
            syncTextFromDom(itemData);
            updateToolbarState();
            _saveState();
        });
    }
    // These buttons must not take focus: clicking one used to move focus off
    // the text, which could drop the highlighted selection before the
    // command ran.
    const keepFocus = (btn) => btn && btn.addEventListener('mousedown', (e) => e.preventDefault());
    [boldBtn, italicBtn, underlineBtn, alignLeftBtn, alignCenterBtn, alignRightBtn, bulletListBtn, numberListBtn].forEach(keepFocus);
    if (boldBtn) boldBtn.addEventListener('click', () => applyCommand('bold'));
    if (italicBtn) italicBtn.addEventListener('click', () => applyCommand('italic'));
    if (underlineBtn) underlineBtn.addEventListener('click', () => applyCommand('underline'));
    // On change (when the picker closes), not on every input: re-focusing the
    // text mid-pick would close the colour picker under the pointer.
    if (colorInput) colorInput.addEventListener('change', () => applyCommand('foreColor', colorInput.value));
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
    // A fresh id must not clash with one loaded from a file: the counter
    // restarts at 1 every session, and a clash made two boxes share one
    // entry in itemsOnCanvas, so formatting one could change the other.
    let id = existingId;
    while (!id || (!existingId && document.getElementById(id))) id = `item-${itemIdCounter++}`;
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
    editable.contentEditable = 'false'; // until it's being edited - see startEditing
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

    // While editing, a press in the text is for the caret and highlighting,
    // so it must not reach the box's drag handler. Otherwise it does: the
    // whole box moves.
    editable.addEventListener('mousedown', (e) => { if (isEditing(textBoxDiv)) e.stopPropagation(); });
    editable.addEventListener('blur', (e) => {
        if (!isEditing(textBoxDiv)) return;
        if (!document.hasFocus()) return; // switching windows - carry on when back
        if (e.relatedTarget && textBoxPropertiesPanel && textBoxPropertiesPanel.contains(e.relatedTarget)) return; // font size, colour
        stopEditing();
    });
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
            e.preventDefault();
            e.stopPropagation();
            stopEditing(); // the box stays selected, ready to move or delete
        }
    });
    textBoxDiv.appendChild(editable);

    // Drag the handle on the right edge to change the box's width; the text
    // rewraps to fit. The right edge snaps to the grid.
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'text-box-resize';
    resizeHandle.title = 'Drag to change the width';
    resizeHandle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startWidth = textBoxDiv.offsetWidth;
        const left = parseFloat(textBoxDiv.style.left) || 0;
        const onMove = (ev) => {
            const raw = startWidth + (ev.clientX - startX) / (getZoom() || 1);
            const right = Math.round((left + raw) / 10) * 10;
            textBoxDiv.style.width = Math.max(40, right - left) + 'px';
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            const itemData = itemsOnCanvas.get(id);
            if (itemData) itemData.width = parseInt(textBoxDiv.style.width, 10);
            _saveState();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });
    textBoxDiv.appendChild(resizeHandle);

    textBoxDiv.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || isEditing(textBoxDiv)) return;
        // Already part of the selection: leave it alone, so a group drag
        // works. Shift+click is handled by the drag code (makeDraggable).
        if (textBoxDiv.classList.contains('selected') || e.shiftKey) return;
        if (typeof window.setSelectedObject === 'function') window.setSelectedObject(textBoxDiv);
    });
    textBoxDiv.addEventListener('dblclick', (e) => {
        if (e.target === resizeHandle) return;
        e.stopPropagation();
        startEditing(textBoxDiv, { clientX: e.clientX, clientY: e.clientY, word: true });
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
