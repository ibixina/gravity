// download-manager.js — Handles offscreen document lifecycle and download execution.
// Extracted from message-handler.js for single responsibility.

import { mimeToExt, inferFilename } from '../shared/utils.js';
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

export async function downloadViaOffscreenDocument(url, tabId, filename) {
    await setupOffscreenDocument();

    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
            type: 'gravity:offscreen-fetch',
            payload: { url, filename, tabId }
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
        const { url, filename, fallbackFetch } = payload;
        const tabId = sender?.tab?.id || payload.tabId;

        if (url.startsWith('data:')) {
            let finalName = filename || `gravity_media_${Date.now()}`;
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

        const fname = filename || inferFilename(url, '');

        // 1. Try an in-page fetch first.
        // This preserves SameSite cookies and native referers, fixing 403 Forbidden
        // errors on protected same-origin files (like Torn.com).
        if (tabId) {
            try {
                const inPageResults = await chrome.scripting.executeScript({
                    target: { tabId, allFrames: true },
                    func: _inPageDownload,
                    args: [url, fname],
                    world: 'MAIN'
                });

                const pageResult = inPageResults?.map(r => r.result).find(r => r && r.success);
                if (pageResult) {
                    console.log(`[Gravity SW] In-page download succeeded for: ${fname}`);
                    sendResponse?.({ success: true, downloadId: 'in-page-download' });
                    return;
                }
            } catch (pageErr) {
                console.warn(`[Gravity SW] In-page download skipped/failed:`, pageErr);
            }
        }

        // 2. Offscreen fallback for cross-origin CORS-blocked requests
        console.log(`[Gravity SW] Falling back to offscreen download: ${url} -> ${fname}`);
        await setupDownloadHeaders(url, tabId);
        const downloadId = await downloadViaOffscreenDocument(url, tabId, fname);
        console.log(`[Gravity SW] Download successfully queued with ID: ${downloadId}`);

        sendResponse?.({ success: true, downloadId });

    } catch (error) {
        console.error('[Gravity SW] Download Request failed:', error);
        notifyDownloadError(error.message || 'Unknown download error');
        sendResponse?.({ success: false, error: error.message });
    }
}

/**
 * In-page download function. Runs inside the page's MAIN world via executeScript.
 * Cannot reference any module imports — must be fully self-contained.
 */
function _inPageDownload(targetUrl, downloadName) {
    try {
        // This is a serialized function — NO access to outer scope or imports.
        const MIME_MAP = {
            'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv',
            'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
            'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg',
            'audio/webm': 'weba', 'audio/aac': 'aac', 'audio/flac': 'flac',
            'audio/wav': 'wav', 'image/jpeg': 'jpg', 'image/png': 'png',
            'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
            'image/svg+xml': 'svg'
        };

        return fetch(targetUrl, { credentials: 'include' })
            .then(res => {
                if (!res.ok) return { success: false, status: res.status };
                return res.blob().then(blob => {
                    let finalName = downloadName;
                    const hasExt = /\.[a-zA-Z0-9]{2,5}$/.test(finalName);
                    if (!hasExt && blob.type) {
                        const ext = MIME_MAP[blob.type.split(';')[0].trim()];
                        if (ext) finalName += `.${ext}`;
                    }

                    const blobUrl = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = blobUrl;
                    a.download = finalName;
                    a.style.display = 'none';
                    document.body.appendChild(a);
                    a.click();

                    setTimeout(() => {
                        URL.revokeObjectURL(blobUrl);
                        a.remove();
                    }, 5000);

                    return { success: true };
                });
            })
            .catch(e => ({ success: false, error: e.message }));
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ── Stream Download Handler ─────────────────────────────────────────────────

export async function handleDownloadStream(payload, sender, sendResponse) {
    try {
        const { url, filename, streamType } = payload;
        const tabId = sender?.tab?.id || payload.tabId;

        console.log(`[Gravity SW] Stream download requested: ${url} (${streamType})`);
        await setupDownloadHeaders(url, tabId);

        const fname = filename || `Gravity_Stream_${Date.now()}.ts`;
        const downloadId = await downloadStreamViaOffscreenDocument(url, tabId, fname, streamType);
        console.log(`[Gravity SW] Stream download queued with ID: ${downloadId}`);

        sendResponse?.({ success: true, downloadId });

    } catch (error) {
        console.error('[Gravity SW] Stream download handler failed:', error);
        notifyDownloadError(error.message || 'Unknown stream download error');
        sendResponse?.({ success: false, error: error.message });
    }
}
