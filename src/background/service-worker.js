import { setupContextMenus } from './context-menu.js';
import { setupMessageHandling } from './message-handler.js';
import { setupNetworkMonitor } from './network-monitor.js';

console.log('[Gravity SW] Service Worker started');

setupContextMenus();
setupMessageHandling();
setupNetworkMonitor(); // Phase 2: passive media URL capture

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        console.log('[Gravity SW] Extension installed');
    }
});
