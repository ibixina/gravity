// message-handler.js — Thin router that dispatches incoming messages to
// focused handler modules. Extracted from the original 948-line monolith.

import { MessageType } from '../shared/message-types.js';
import { registerBlobSource } from './network-monitor.js';
import { notifyProgressTab, notifyProgressCompleteTab } from './notify.js';
import { setupDownloadHeaders } from './header-manager.js';
import { handleDownloadRequest, handleDownloadStream, downloadViaOffscreenDocument, downloadStreamViaOffscreenDocument } from './download-manager.js';
import {
    handleDownloadSegments,
    handleGetSegments,
    handleDownloadNetworkMedia,
    handleGetTabMedia,
    storeCapturedSegment,
    storeYouTubeData,
    invokeAbortBuffer,
    cleanupTab,
} from './youtube-handler.js';


export function setupMessageHandling() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log(`[Gravity SW] Inbound: ${message.type}`, message.payload);

        switch (message.type) {

            // ── Download requests ──────────────────────────────────────
            case MessageType.DOWNLOAD_REQUEST:
                handleDownloadRequest(message.payload, sender, sendResponse);
                return true;

            // ── Pick Mode / right-click on blob: video ────────────────
            case MessageType.DOWNLOAD_NETWORK_MEDIA:
                handleDownloadNetworkMedia(message.payload, sender, sendResponse);
                return true;

            // ── Download Stream (HLS/DASH) ────────────────────────────
            case MessageType.DOWNLOAD_STREAM:
                handleDownloadStream(message.payload, sender, sendResponse);
                return true;

            // ── Download captured segments ─────────────────────────────
            case MessageType.DOWNLOAD_SEGMENTS:
                handleDownloadSegments(message.payload, sender, sendResponse);
                return true;

            // ── Get captured segments info ─────────────────────────────
            case MessageType.GET_SEGMENTS:
                handleGetSegments(message.payload, sender, sendResponse);
                return true;

            // ── Popup queries network-captured media for this tab ──────
            case MessageType.GET_TAB_MEDIA:
                handleGetTabMedia(message.payload?.tabId, sendResponse);
                return true;

            // ── gravity-early.js reports a blob→source mapping ─────────
            case MessageType.BLOB_CREATED:
                if (sender.tab) {
                    registerBlobSource(sender.tab.id, message.payload.blobUrl, message.payload.sourceUrl);
                }
                break;

            // ── Segment captured notification ─────────────────────────
            case MessageType.SEGMENT_CAPTURED:
                if (sender.tab) {
                    storeCapturedSegment(sender.tab.id, message.payload);
                }
                break;

            // ── YouTube video extracted notification ───────────────────
            case MessageType.YOUTUBE_VIDEO_EXTRACTED:
                if (sender.tab && message.payload) {
                    console.log(`[Gravity SW] YouTube metadata for tab ${sender.tab.id}: ${message.payload.title}`);
                    storeYouTubeData(sender.tab.id, message.payload);
                }
                break;

            // ── Abort auto-buffer ──────────────────────────────────────
            case MessageType.ABORT_BUFFER:
                if (message.payload?.tabId) {
                    invokeAbortBuffer(message.payload.tabId).then(result => {
                        sendResponse?.(result);
                    });
                    return true;
                }
                break;

            // ── Relay offscreen document progress to tab ───────────────
            case MessageType.PROGRESS_TO_TAB:
                if (message.payload?.tabId) {
                    notifyProgressTab(
                        message.payload.tabId,
                        message.payload.id,
                        message.payload.message,
                        message.payload.percent
                    );
                }
                break;

            case MessageType.PROGRESS_COMPLETE_TO_TAB:
                if (message.payload?.tabId) {
                    notifyProgressCompleteTab(
                        message.payload.tabId,
                        message.payload.id,
                        message.payload.message,
                        message.payload.isError
                    );
                }
                break;

            case MessageType.ENSURE_HEADERS:
                setupDownloadHeaders(message.payload.url, message.payload.tabId, true).then(() => {
                    sendResponse?.({ success: true });
                });
                return true;
        }
    });

    // ── Cleanup tab-specific storage on tab close ──────────────────────
    chrome.tabs.onRemoved.addListener((tabId) => {
        cleanupTab(tabId);
    });
}

// Re-export so context-menu.js can still import these
export { setupDownloadHeaders } from './header-manager.js';
export { downloadViaOffscreenDocument } from './download-manager.js';
