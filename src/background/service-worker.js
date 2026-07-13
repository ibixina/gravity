import { setupContextMenus } from './context-menu.js';
import { setupMessageHandling } from './message-handler.js';
import { setupNetworkMonitor } from './network-monitor.js';

console.log('[Gravity SW] Service Worker started');

setupContextMenus();
setupMessageHandling();
setupNetworkMonitor(); // Phase 2: passive media URL capture
setupActionClick(); // Clicking the toolbar icon toggles Pick Mode

// ── Toolbar icon click → toggle Pick Mode on the active tab ────────────────
// We removed `default_popup` from the manifest so that clicking the extension
// icon performs an action directly instead of opening the popup. The content
// script listens for `gravity:toggle-pick-mode` and toggles Pick Mode.
function setupActionClick() {
    chrome.action.onClicked.addListener(async (tab) => {
        if (!tab || !tab.id) return;
        // Skip unsupported pages (no content script runs there)
        if (tab.url && (tab.url.startsWith('chrome://') ||
            tab.url.startsWith('chrome-extension://') ||
            tab.url.startsWith('about:'))) {
            return;
        }
        try {
            await chrome.tabs.sendMessage(tab.id, { type: 'gravity:toggle-pick-mode' });
        } catch (e) {
            console.warn('[Gravity SW] Could not toggle Pick Mode on tab', tab.id, e);
        }
    });
}

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        console.log('[Gravity SW] Extension installed');
    }
});
