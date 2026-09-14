// utils.js
// Shared UI primitives: toasts, confirm dialogs and small helpers.

const TOAST_STYLES = {
    success: { bg: '#198754', icon: 'bi-check-circle-fill' },
    error:   { bg: '#dc3545', icon: 'bi-exclamation-triangle-fill' },
    warning: { bg: '#fd7e14', icon: 'bi-exclamation-circle-fill' },
    info:    { bg: '#343a40', icon: 'bi-info-circle-fill' }
};

function toastContainer() {
    let el = document.getElementById('toastContainer');
    if (!el) {
        el = document.createElement('div');
        el.id = 'toastContainer';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.style.cssText = [
            'position:fixed', 'top:64px', 'left:50%', 'transform:translateX(-50%)',
            'z-index:99999', 'display:flex', 'flex-direction:column',
            'align-items:center', 'gap:8px', 'pointer-events:none',
            'max-width:min(92vw, 460px)'
        ].join(';');
        document.body.appendChild(el);
    }
    return el;
}

/**
 * Show a transient toast message.
 * @param {string} msg
 * @param {'success'|'error'|'warning'|'info'} [type='info']
 * @param {number} [duration=2600] milliseconds on screen
 */
export function showToast(msg, type = 'info', duration = 2600) {
    const style = TOAST_STYLES[type] || TOAST_STYLES.info;
    const toast = document.createElement('div');
    toast.style.cssText = [
        `background:${style.bg}`, 'color:#fff', 'padding:12px 20px',
        'border-radius:10px', 'font-size:0.95rem', 'line-height:1.4',
        'box-shadow:0 6px 24px rgba(0,0,0,0.22)', 'display:flex',
        'align-items:center', 'gap:10px', 'opacity:0',
        'transform:translateY(-8px)', 'transition:opacity .22s ease, transform .22s ease',
        'pointer-events:auto', 'text-align:left'
    ].join(';');
    toast.innerHTML = `<i class="bi ${style.icon}" style="font-size:1.1rem;flex-shrink:0;"></i><span></span>`;
    toast.querySelector('span').textContent = msg;
    toastContainer().appendChild(toast);

    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    });

    const dismiss = () => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-8px)';
        setTimeout(() => toast.remove(), 240);
    };
    const timer = setTimeout(dismiss, duration);
    toast.addEventListener('click', () => { clearTimeout(timer); dismiss(); });
    return toast;
}

/** Backwards-compatible alias used across the app. */
export function showNotification(msg, type = 'info') {
    return showToast(msg, type);
}

/**
 * In-app replacement for window.confirm().
 * @returns {Promise<boolean>} resolves true if the user confirms
 */
export function showConfirm({
    title = 'Are you sure?',
    message = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false
} = {}) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.5)',
            'z-index:100000', 'display:flex', 'align-items:center',
            'justify-content:center', 'padding:20px', 'opacity:0',
            'transition:opacity .18s ease'
        ].join(';');

        const box = document.createElement('div');
        box.style.cssText = [
            'background:#fff', 'border-radius:14px', 'max-width:440px', 'width:100%',
            'padding:28px', 'box-shadow:0 20px 60px rgba(0,0,0,0.3)',
            'font-family:Avenir, Arial, sans-serif', 'transform:scale(.96)',
            'transition:transform .18s ease'
        ].join(';');
        box.innerHTML = `
            <h3 style="margin:0 0 10px;font-size:1.2rem;font-weight:600;color:#212529;"></h3>
            <p style="margin:0 0 22px;color:#6c757d;line-height:1.55;font-size:0.95rem;"></p>
            <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;">
                <button data-act="cancel" class="btn btn-outline-secondary"></button>
                <button data-act="ok" class="btn ${danger ? 'btn-danger' : 'btn-primary'}"></button>
            </div>`;
        box.querySelector('h3').textContent = title;
        box.querySelector('p').textContent = message;
        box.querySelector('[data-act="cancel"]').textContent = cancelLabel;
        box.querySelector('[data-act="ok"]').textContent = confirmLabel;

        overlay.appendChild(box);
        document.body.appendChild(overlay);
        requestAnimationFrame(() => {
            overlay.style.opacity = '1';
            box.style.transform = 'scale(1)';
        });

        const close = (result) => {
            overlay.style.opacity = '0';
            box.style.transform = 'scale(.96)';
            document.removeEventListener('keydown', onKey);
            setTimeout(() => { overlay.remove(); resolve(result); }, 190);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') close(false);
            if (e.key === 'Enter') close(true);
        };

        box.querySelector('[data-act="ok"]').onclick = () => close(true);
        box.querySelector('[data-act="cancel"]').onclick = () => close(false);
        overlay.onclick = (e) => { if (e.target === overlay) close(false); };
        document.addEventListener('keydown', onKey);
        box.querySelector('[data-act="ok"]').focus();
    });
}

/**
 * A persistent action bar, used for autosave recovery.
 * Non-blocking, unlike window.confirm().
 */
export function showActionBar({ message, actions = [] }) {
    const existing = document.getElementById('actionBar');
    if (existing) existing.remove();

    const bar = document.createElement('div');
    bar.id = 'actionBar';
    bar.style.cssText = [
        'position:fixed', 'top:56px', 'left:50%', 'transform:translateX(-50%) translateY(-12px)',
        'z-index:99998', 'background:#fff', 'border:1px solid #dee2e6',
        'border-radius:12px', 'box-shadow:0 10px 34px rgba(0,0,0,0.18)',
        'padding:14px 18px', 'display:flex', 'align-items:center', 'gap:14px',
        'font-family:Avenir, Arial, sans-serif', 'font-size:0.92rem',
        'max-width:min(94vw,620px)', 'flex-wrap:wrap', 'opacity:0',
        'transition:opacity .25s ease, transform .25s ease'
    ].join(';');

    const text = document.createElement('span');
    text.style.cssText = 'color:#212529;flex:1 1 220px;line-height:1.45;';
    text.textContent = message;
    bar.appendChild(text);

    const close = () => {
        bar.style.opacity = '0';
        bar.style.transform = 'translateX(-50%) translateY(-12px)';
        setTimeout(() => bar.remove(), 260);
    };

    actions.forEach(({ label, onClick, variant = 'btn-outline-secondary' }) => {
        const btn = document.createElement('button');
        btn.className = `btn btn-sm ${variant}`;
        btn.textContent = label;
        btn.style.whiteSpace = 'nowrap';
        btn.onclick = () => { close(); if (onClick) onClick(); };
        bar.appendChild(btn);
    });

    document.body.appendChild(bar);
    requestAnimationFrame(() => {
        bar.style.opacity = '1';
        bar.style.transform = 'translateX(-50%) translateY(0)';
    });
    return { close };
}
