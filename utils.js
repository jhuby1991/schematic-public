// utils.js
// Utility functions, helpers, and notifications.

export function showNotification(msg) {
    const notif = document.getElementById('toolbarNotification');
    notif.textContent = msg;
    notif.style.opacity = '1';
    clearTimeout(notif._fadeTimeout);
    notif._fadeTimeout = setTimeout(() => {
        notif.style.opacity = '0';
    }, 1200);
}
// Add other utility functions as needed. 