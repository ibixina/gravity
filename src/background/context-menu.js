import { MessageType } from '../shared/message-types.js';
import { notifyTab, notifyDownloadError } from './notify.js';
import { getTabMedia } from './network-monitor.js';
import { setupDownloadHeaders, downloadViaOffscreenDocument } from './message-handler.js';


export function setupContextMenus() {
    chrome.runtime.onInstalled.addListener(() => {
        // Standard context-type items — only appear when Chrome itself
        // identifies the right-clicked element as the matching media type.
        // These work fine for pages WITHOUT overlays.
        chrome.contextMenus.create({
            id: 'gravity-download-image',
            title: 'Gravity: Download this image',
            contexts: ['image']
        });

        chrome.contextMenus.create({
            id: 'gravity-download-video',
            title: 'Gravity: Download this video',
            contexts: ['video']
        });

        chrome.contextMenus.create({
            id: 'gravity-download-audio',
            title: 'Gravity: Download this audio',
            contexts: ['audio']
        });

        chrome.contextMenus.create({
            type: 'separator',
            id: 'gravity-separator-1',
            contexts: ['all']
        });

        // ── OVERLAY BYPASS ITEM ──────────────────────────────────────────
        // This item ALWAYS appears regardless of what's under the cursor.
        // It uses our content script's tracked right-click position and
        // elementsFromPoint() to pierce through any transparent overlays.
        // This is the item that works on Instagram, Twitter, etc.
        chrome.contextMenus.create({
            id: 'gravity-save-here',
            title: 'Gravity: ⬇ Save media here',
            contexts: ['all']
        });

        chrome.contextMenus.create({
            type: 'separator',
            id: 'gravity-separator-2',
            contexts: ['all']
        });

        chrome.contextMenus.create({
            id: 'gravity-open-gallery',
            title: 'Gravity: 🔍 Open Gallery',
            contexts: ['all']
        });
    });

    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
        switch (info.menuItemId) {

            // Standard items — srcUrl is available because Chrome saw the native img/video/audio tag
            case 'gravity-download-image':
            case 'gravity-download-video':
            case 'gravity-download-audio':
                if (info.srcUrl) {
                    await triggerDownload(info.srcUrl, tab.id);
                }
                break;

            // Overlay bypass — ask the content script what was under the cursor
            case 'gravity-save-here':
                await handleSaveHere(info, tab);
                break;

            case 'gravity-open-gallery':
                chrome.tabs.sendMessage(tab.id, { type: 'gravity:scan-request' });
                break;
        }
    });
}

// ── Overlay-bypass download handler ──────────────────────────────────────────
// The content script resolves what's under the cursor on contextmenu and stores
// it as window.__gravityLastRightClickUrl — always a plain string:
//   - A regular https:// URL
//   - A data: URL (for blobs converted in-process by the content script)
//   - The sentinel "gravity-network-monitor:<type>" (for unresolvable blobs)
async function handleSaveHere(info, tab) {
    try {
        // If Chrome natively identified an image/video element (no overlay),
        // srcUrl is populated — use it directly.
        if (info.srcUrl && typeof info.srcUrl === 'string' &&
            !info.srcUrl.startsWith('data:')) {
            await triggerDownload(info.srcUrl, tab.id);
            return;
        }

        // Read the cached URL that gravity-ui.js resolved on contextmenu
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
            func: () => window.__gravityLastRightClickUrl || null
        });

        const cached = results?.[0]?.result;

        if (!cached) {
            // Nothing in the cache yet — the async blob conversion may have been
            // skipped (e.g. non-media element). Try a live lookup instead.
            chrome.tabs.sendMessage(tab.id, {
                type: 'gravity:download-at-cursor',
                payload: { x: info.x, y: info.y }
            });
            return;
        }

        // ── Sentinel: network monitor fallback ──────────────────────────────
        if (cached.startsWith('gravity-network-monitor:')) {
            const elementType = cached.split(':')[1]; // 'video' or 'audio'
            await handleNetworkMonitorDownload(tab.id, elementType);
            return;
        }


        // ── data: URL (blob was converted by content script) ────────────────
        // Route through the message handler which knows how to handle data URIs.
        if (cached.startsWith('data:')) {
            await chrome.runtime.sendMessage({
                type: 'gravity:download-request',
                payload: { url: cached, filename: `Gravity_media_${Date.now()}` }
            });
            return;
        }

        // ── Regular https:// or http:// URL ─────────────────────────────────
        await triggerDownload(cached, tab.id);

    } catch (err) {
        console.error('[Gravity] handleSaveHere failed:', err);
        // Show the user a meaningful error instead of silently failing
        try {
            await notifyTab(tab.id, 'error', `Could not save media: ${err.message}`);
        } catch {
            notifyDownloadError(err.message);
        }
    }
}

// ── Download from network monitor ───────────────────────────────────────────
async function handleNetworkMonitorDownload(tabId, elementType) {
    const store = getTabMedia(tabId);
    const list = elementType === 'audio' ? store.audio : store.video;

    if (list.length === 0) {
        // Try downloading captured segments instead
        const result = await chrome.runtime.sendMessage({
            type: 'gravity:download-segments',
            payload: { elementType }
        });

        if (!result?.success) {
            await notifyTab(tabId, 'error',
                `No ${elementType} URL detected yet. Press Play on the video first, then right-click again.`);
        }
        return;
    }

    // Find the best quality URL
    const best = list.reduce((a, b) => (b.size || 0) > (a.size || 0) ? b : a, list[0]);

    const ext = best.contentType?.includes('audio') ? 'mp3' : 'mp4';
    const filename = `Gravity_${elementType}_${Date.now()}.${ext}`;

    await triggerDownload(best.url, tabId, filename);
}

async function triggerDownload(url, tabId, filename) {
    try {
        await setupDownloadHeaders(url, tabId);
        await downloadViaOffscreenDocument(url, tabId, filename);
    } catch (err) {
        console.error('[Gravity] Download failed:', err);
        await notifyTab(tabId, 'error', `Download failed: ${err.message}`);
    }
}
