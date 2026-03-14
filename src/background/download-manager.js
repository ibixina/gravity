// download-manager.js — Handles offscreen document lifecycle and download execution.
// Extracted from message-handler.js for single responsibility.

import { mimeToExt, inferFilename, getTimestamp } from '../shared/utils.js';
import { setupDownloadHeaders } from './header-manager.js';
import { notifyDownloadError, notifyTab } from './notify.js';

// ── Offscreen Document Lifecycle ────────────────────────────────────────────
let creatingOffscreen;

async function setupOffscreenDocument() {
    const offscreenUrl = chrome.runtime.getURL('src/background/offscreen.html');
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [offscreenUrl]
    });

    if (existingContexts.length > 0) return;

    if (creatingOffscreen) {
        await creatingOffscreen;
    } else {
        creatingOffscreen = chrome.offscreen.createDocument({
            url: 'src/background/offscreen.html',
            reasons: ['BLOBS', 'WORKERS'],
            justification: 'Fetch media into a blob to bypass background script limitations'
        });
        await creatingOffscreen;
        creatingOffscreen = null;
    }
}

// ── Download via Offscreen Document ─────────────────────────────────────────

export async function downloadViaOffscreenDocument(url, tabId, filename, referer = null) {
    await setupOffscreenDocument();

    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
            type: 'gravity:offscreen-fetch',
            payload: { url, filename, tabId, referer }
        }, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (!response) {
                reject(new Error("No response from offscreen document"));
                return;
            }
            if (!response.success) {
                reject(new Error(response.error || "Offscreen fetch failed"));
                return;
            }

            let finalName = filename;
            if (response.mimeType) {
                const hasExt = /\.[a-zA-Z0-9]{2,5}$/.test(finalName);
                if (!hasExt) {
                    const ext = mimeToExt(response.mimeType);
                    if (ext) finalName += `.${ext}`;
                }
            }

            // Perform the actual browser download action in the SW
            chrome.downloads.download({
                url: response.blobUrl,
                filename: finalName,
                saveAs: false
            }, (downloadId) => {
                resolve(downloadId);
            });
        });
    });
}

export async function downloadStreamViaOffscreenDocument(url, tabId, filename, type) {
    await setupOffscreenDocument();

    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
            type: 'gravity:offscreen-fetch-stream',
            payload: { url, filename, tabId, streamType: type }
        }, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (!response) {
                reject(new Error("No response from offscreen document"));
                return;
            }
            if (!response.success) {
                reject(new Error(response.error || "Offscreen stream fetch failed"));
                return;
            }

            chrome.downloads.download({
                url: response.blobUrl,
                filename,
                saveAs: false
            }, (downloadId) => {
                resolve(downloadId);
            });
        });
    });
}

// ── Download Request Handler ────────────────────────────────────────────────

export async function handleDownloadRequest(payload, sender, sendResponse) {
    try {
        const { url, filename, fallbackFetch, referer } = payload;
        const tabId = sender?.tab?.id || payload.tabId;

        if (url.startsWith('data:')) {
            const timestamp = getTimestamp();
            let finalName = filename;
            if (!finalName || String(finalName).toLowerCase() === 'undefined' || String(finalName).toLowerCase() === 'null' || finalName === '[object Object]') {
                finalName = `gravity_${timestamp}`;
            }
            const hasExt = /\.[a-zA-Z0-9]{2,5}$/.test(finalName);
            if (!hasExt) {
                const mimeMatch = url.match(/^data:([^;]+);/);
                const ext = mimeMatch ? mimeToExt(mimeMatch[1]) : 'bin';
                finalName += `.${ext}`;
            }

            const downloadId = await chrome.downloads.download({
                url, filename: finalName, saveAs: false
            });
            sendResponse?.({ success: true, downloadId });
            return;
        }

        if (url.startsWith('blob:')) {
            notifyDownloadError('Could not download — the video URL expired.');
            sendResponse?.({ success: false, error: 'blob_url_cross_process' });
            return;
        }

        let fname = filename;
        if (!fname || String(fname).toLowerCase() === 'undefined' || String(fname).toLowerCase() === 'null' || fname === '[object Object]') {
            fname = inferFilename(url, '');
        }

        // ── Auto-Detect Hotlink Traps ──
        // Clear any existing DNR rules so our probe doesn't get masked by previous spoofing.
        const existingRules = await chrome.declarativeNetRequest.getSessionRules();
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: existingRules.map(r => r.id) });

        let needsOffscreenBypass = false;
        try {
            console.log(`[Gravity SW] Probing URL for hotlink traps: ${url}`);
            const controller = new AbortController();
            const res = await fetch(url, {
                method: 'GET',
                headers: { 'Referer': referer },
                signal: controller.signal
            });
            const contentType = res.headers.get('content-type') || '';
            controller.abort(); // We only need the headers, cancel immediately.

            if (!res.ok || contentType.includes('text/html')) {
                console.log(`[Gravity SW] Probe detected trap (Status: ${res.status}, Type: ${contentType}).`);
                needsOffscreenBypass = true;
            }
        } catch (e) {
            // If fetch fails (e.g. strict CORS), it's highly likely a protected domain.
            console.log(`[Gravity SW] Probe fetch failed (${e.message}), assuming protected domain.`);
            needsOffscreenBypass = true;
        }

        if (needsOffscreenBypass) {
            console.log(`[Gravity SW] Forcing Offscreen Download to bypass native Chrome limitations for: ${url}`);
            await setupDownloadHeaders(url, tabId, referer);
            try {
                const dlId = await downloadViaOffscreenDocument(url, tabId, fname, referer);
                sendResponse?.({ success: true, downloadId: dlId });
            } catch (e) {
                sendResponse?.({ success: false, error: e.message });
            }
            return;
        }

        // Try native direct download with headers first
        console.log(`[Gravity SW] Starting native download with referer ${referer}: ${url} -> ${fname}`);
        await setupDownloadHeaders(url, tabId, referer);

        chrome.downloads.download({
            url: url,
            filename: fname,
            saveAs: false
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.warn('[Gravity SW] Native download failed:', chrome.runtime.lastError.message);

                // 3. Fallback to offscreen only if native fails
                console.log(`[Gravity SW] Falling back to offscreen download: ${url}`);
                downloadViaOffscreenDocument(url, tabId, fname, referer).then(dlId => {
                    sendResponse?.({ success: true, downloadId: dlId });
                }).catch(e => {
                    sendResponse?.({ success: false, error: e.message });
                });
            } else {
                console.log(`[Gravity SW] Download successfully queued with ID: ${downloadId}`);
                sendResponse?.({ success: true, downloadId });
            }
        });

        // Return without resolving here since we sent response inside callback
        return;

    } catch (error) {
        console.error('[Gravity SW] Download Request failed:', error);
        notifyDownloadError(error.message || 'Unknown download error');
        sendResponse?.({ success: false, error: error.message });
    }
}



// ── Stream Download Handler ─────────────────────────────────────────────────

export async function handleDownloadStream(payload, sender, sendResponse) {
    try {
        const { url, filename, streamType } = payload;
        const tabId = sender?.tab?.id || payload.tabId;

        console.log(`[Gravity SW] Stream download requested: ${url} (${streamType})`);
        await setupDownloadHeaders(url, tabId);

        let fname = filename;
        if (!fname || String(fname).toLowerCase() === 'undefined' || String(fname).toLowerCase() === 'null' || fname === '[object Object]') {
            fname = `gravity_${getTimestamp()}.ts`;
        }
        const downloadId = await downloadStreamViaOffscreenDocument(url, tabId, fname, streamType);
        console.log(`[Gravity SW] Stream download queued with ID: ${downloadId}`);

        sendResponse?.({ success: true, downloadId });

    } catch (error) {
        console.error('[Gravity SW] Stream download handler failed:', error);
        notifyDownloadError(error.message || 'Unknown stream download error');
        sendResponse?.({ success: false, error: error.message });
    }
}
