// icons.js
// Google Material Symbols icon library: a curated set relevant to lighting/
// electrical/home schematics, draggable onto the canvas the same way a
// palette component is, plus free-text lookup for anyone who knows the
// exact name of an icon outside the curated set (the font ships the full
// library regardless of what's listed here).

export const ICON_CATEGORIES = [
    {
        name: 'Lighting',
        icons: ['light', 'lightbulb', 'flare', 'wb_incandescent', 'wb_sunny', 'tungsten', 'brightness_6', 'brightness_7']
    },
    {
        name: 'Electrical',
        icons: ['bolt', 'electrical_services', 'power', 'cable', 'ev_station', 'battery_charging_full', 'power_input']
    },
    {
        name: 'Climate',
        icons: ['thermostat', 'device_thermostat', 'ac_unit', 'mode_fan', 'air']
    },
    {
        name: 'Security',
        icons: ['security', 'lock', 'lock_open', 'videocam', 'sensors', 'shield', 'key', 'doorbell']
    },
    {
        name: 'Audio/Visual',
        icons: ['speaker', 'tv', 'headphones', 'mic', 'volume_up', 'cast', 'radio']
    },
    {
        name: 'Network',
        icons: ['wifi', 'router', 'lan', 'hub', 'cloud', 'settings_ethernet']
    },
    {
        name: 'Home',
        icons: ['home', 'garage', 'door_front', 'blinds', 'stairs', 'deck', 'yard', 'roofing', 'pool', 'fence']
    },
    {
        name: 'Controls',
        icons: ['touch_app', 'toggle_on', 'dashboard', 'tune', 'schedule', 'timer', 'power_settings_new']
    },
    {
        name: 'Appliances',
        icons: ['kitchen', 'countertops', 'local_laundry_service', 'blender', 'coffee_maker', 'microwave']
    },
    {
        name: 'Annotation',
        icons: ['info', 'warning', 'star', 'flag', 'push_pin', 'label', 'note_add', 'sticky_note_2', 'check_circle']
    }
];

const DEFAULT_ICON_SIZE = 28;
const DEFAULT_ICON_COLOR = '#1A1A1A';

let drawingCanvas, iconPropertiesPanel, iconSizeInput, iconColorInput;
let itemsOnCanvas, selectedItems;
let itemIdCounter = 1;
const GRID_SIZE = 20;
let _makeItemDraggable = null;
let _saveState = null;

function friendlyLabel(iconName) {
    return iconName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function buildIconPalette(containerEl) {
    if (!containerEl) return;
    containerEl.innerHTML = `
        <input type="text" id="iconSearchInput" class="form-control form-control-sm" placeholder="Search icons or type an exact Material Symbol name..." style="margin-bottom:8px;">
        <div id="iconSearchGrid"></div>
    `;
    const grid = containerEl.querySelector('#iconSearchGrid');
    const searchInput = containerEl.querySelector('#iconSearchInput');

    function renderGrid(filter) {
        const q = (filter || '').trim().toLowerCase();
        grid.innerHTML = '';
        ICON_CATEGORIES.forEach(cat => {
            const matches = cat.icons.filter(name => !q || name.includes(q) || friendlyLabel(name).toLowerCase().includes(q));
            if (matches.length === 0) return;
            const section = document.createElement('div');
            section.style.marginBottom = '6px';
            const heading = document.createElement('div');
            heading.textContent = cat.name;
            heading.style.cssText = 'font-family:var(--rako-font-display);font-size:0.65rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--rako-text-muted);margin:6px 0 4px;';
            section.appendChild(heading);
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';
            matches.forEach(name => row.appendChild(buildIconTile(name)));
            section.appendChild(row);
            grid.appendChild(section);
        });
        // If the query looks like an exact icon name not in the curated list,
        // offer it directly - the font has thousands more than we list here.
        if (q && !/\s/.test(q) && !ICON_CATEGORIES.some(cat => cat.icons.includes(q))) {
            const section = document.createElement('div');
            const heading = document.createElement('div');
            heading.textContent = 'Custom name';
            heading.style.cssText = 'font-family:var(--rako-font-display);font-size:0.65rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--rako-text-muted);margin:6px 0 4px;';
            section.appendChild(heading);
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';
            row.appendChild(buildIconTile(q));
            section.appendChild(row);
            grid.appendChild(section);
        }
        if (!grid.children.length) {
            grid.innerHTML = '<div style="color:var(--rako-text-muted);font-size:0.8rem;padding:6px 2px;">No matching icon. Try the exact Material Symbol name.</div>';
        }
    }

    function buildIconTile(name) {
        const tile = document.createElement('div');
        tile.className = 'palette-item icon-palette-item';
        tile.draggable = true;
        tile.dataset.type = 'Icon';
        tile.dataset.iconName = name;
        tile.title = friendlyLabel(name);
        tile.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;width:54px;height:54px;cursor:grab;';
        tile.innerHTML = `<span class="material-symbols-outlined" style="font-size:22px;">${name}</span>
            <span style="font-size:0.58rem;line-height:1.1;text-align:center;margin-top:2px;color:var(--rako-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;">${friendlyLabel(name)}</span>`;
        tile.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', 'Icon');
            e.dataTransfer.setData('icon-name', name);
            e.dataTransfer.effectAllowed = 'copy';
        });
        return tile;
    }

    renderGrid('');
    searchInput.addEventListener('input', () => renderGrid(searchInput.value));
}

export function initIconTool(canvasEl, propertiesPanelEl, { sizeInput, colorInput }, _itemsOnCanvas, _selectedItems, makeItemDraggable, saveState) {
    drawingCanvas = canvasEl;
    iconPropertiesPanel = propertiesPanelEl;
    iconSizeInput = sizeInput;
    iconColorInput = colorInput;
    itemsOnCanvas = _itemsOnCanvas;
    selectedItems = _selectedItems;
    _makeItemDraggable = makeItemDraggable;
    _saveState = saveState;

    if (iconSizeInput) {
        iconSizeInput.addEventListener('input', () => {
            if (selectedItems.size === 1) {
                const id = selectedItems.values().next().value;
                const itemData = itemsOnCanvas.get(id);
                if (itemData && itemData.type === 'Icon') {
                    const size = Math.max(12, Math.min(96, parseInt(iconSizeInput.value, 10) || DEFAULT_ICON_SIZE));
                    itemData.size = size;
                    itemData.element.querySelector('.material-symbols-outlined').style.fontSize = size + 'px';
                    _saveState();
                }
            }
        });
    }
    if (iconColorInput) {
        iconColorInput.addEventListener('input', () => {
            if (selectedItems.size === 1) {
                const id = selectedItems.values().next().value;
                const itemData = itemsOnCanvas.get(id);
                if (itemData && itemData.type === 'Icon') {
                    itemData.color = iconColorInput.value;
                    itemData.element.querySelector('.material-symbols-outlined').style.color = iconColorInput.value;
                    _saveState();
                }
            }
        });
    }
}

export function createIconOnCanvas(iconName, x, y, existingId = null, skipSave = false, itemProps = {}) {
    // A distinct prefix from text.js's own "item-N" counter, since both
    // modules generate IDs independently and would otherwise collide.
    const id = existingId || `icon-${itemIdCounter++}`;
    const size = itemProps.size || DEFAULT_ICON_SIZE;
    const color = itemProps.color || DEFAULT_ICON_COLOR;

    const snapped = { x: Math.round(x / GRID_SIZE) * GRID_SIZE, y: Math.round(y / GRID_SIZE) * GRID_SIZE };
    const iconDiv = document.createElement('div');
    iconDiv.classList.add('canvas-item', 'canvas-icon');
    iconDiv.id = id;
    iconDiv.style.position = 'absolute';
    iconDiv.style.left = `${existingId ? x : snapped.x}px`;
    iconDiv.style.top = `${existingId ? y : snapped.y}px`;
    iconDiv.dataset.itemType = 'icon';
    iconDiv.dataset.iconName = iconName;

    const glyph = document.createElement('span');
    glyph.className = 'material-symbols-outlined';
    glyph.textContent = iconName;
    glyph.style.fontSize = size + 'px';
    glyph.style.color = color;
    glyph.style.display = 'block';
    glyph.style.lineHeight = '1';
    glyph.style.userSelect = 'none';
    iconDiv.appendChild(glyph);

    iconDiv.addEventListener('mousedown', (e) => {
        if (typeof window.setSelectedObject === 'function') {
            window.setSelectedObject(iconDiv, e.shiftKey);
        }
    });

    drawingCanvas.appendChild(iconDiv);
    itemsOnCanvas.set(id, { element: iconDiv, x: snapped.x, y: snapped.y, type: 'Icon', connections: [], iconName, size, color, id });
    _makeItemDraggable(iconDiv);
    if (!skipSave) _saveState();
    return iconDiv;
}
