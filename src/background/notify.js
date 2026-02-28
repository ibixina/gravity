// notify.js — service-worker-side user feedback
// Uses chrome.notifications for errors/warnings that happen in the background.

let _notifId = 0;

/**
 * Show a Chrome system notification.
 * @param {'error'|'success'|'warning'} level
 * @param {string} title
 * @param {string} message
 */
export function swNotify(level, title, message) {
    const iconMap = {
        error: 'icons/gravity-48.png',
        success: 'icons/gravity-48.png',
        warning: 'icons/gravity-48.png',
    };

    chrome.notifications.create(`gravity-${++_notifId}`, {
        type: 'basic',
        iconUrl: iconMap[level],
        title: `Gravity — ${title}`,
        message,
        priority: level === 'error' ? 2 : 1,
    });
}

/**
 * Show an error notification to the user for download failures.
 */
export function notifyDownloadError(details) {
    swNotify('error', 'Download Failed', details || 'An unknown error occurred.');
}

/**
 * Ask a content script tab to show a brief in-page toast.
 * Used when we need user feedback but don't want a system notification.
 */
export async function notifyTab(tabId, level, message) {
    try {
        await chrome.tabs.sendMessage(tabId, {
            type: 'gravity:toast',
            payload: { level, message }
        });
    } catch {
        // Tab might be closed or restricted — fall back to system notification
        swNotify(level, level === 'error' ? 'Error' : 'Notice', message);
    }
}
