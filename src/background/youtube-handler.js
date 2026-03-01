// youtube-handler.js — YouTube/video streaming download logic.
// Handles captured segment downloads, auto-buffering, and YouTube-specific flows.

import { mimeToExt } from '../shared/utils.js';
import { getTabMedia } from './network-monitor.js';
import { notifyDownloadError, notifyTab } from './notify.js';
import { setupDownloadHeaders } from './header-manager.js';
import { downloadViaOffscreenDocument } from './download-manager.js';

// ── Storage ─────────────────────────────────────────────────────────────────
const tabSegmentStore = new Map();
const tabYouTubeData = new Map();

export function getOrCreateSegmentStore(tabId) {
    if (!tabSegmentStore.has(tabId)) {
        tabSegmentStore.set(tabId, new Map());
    }
    return tabSegmentStore.get(tabId);
}

export function storeCapturedSegment(tabId, segmentInfo) {
    const store = getOrCreateSegmentStore(tabId);
    const key = segmentInfo.url;
    if (!store.has(key)) {
        store.set(key, segmentInfo);
    }
}

export function storeYouTubeData(tabId, payload) {
    const existing = tabYouTubeData.get(tabId) || [];
    existing.push(payload);
    tabYouTubeData.set(tabId, existing);
}

/**
 * Clean up tab-specific data when a tab is removed.
 */
export function cleanupTab(tabId) {
    tabSegmentStore.delete(tabId);
    tabYouTubeData.delete(tabId);
}

// ── YouTube Detection ───────────────────────────────────────────────────────

export async function isYouTubePage(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        return tab.url?.includes('youtube.com') || tab.url?.includes('youtu.be');
    } catch {
        return false;
    }
}

// ── MAIN World Script Invocations ───────────────────────────────────────────

async function getCapturedTracksSummary(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: () => {
                if (window.__gravityCapturedTracksSummary) {
                    return window.__gravityCapturedTracksSummary();
                }
                return [];
            },
            world: 'MAIN'
        });
        return results?.flatMap(r => r.result || []) || [];
    } catch (err) {
        console.warn('[Gravity SW] Failed to get captured tracks:', err);
        return [];
    }
}

async function downloadViaCapturedData(tabId, preferVideo = true) {
    console.log('[Gravity SW] Attempting download via captured data for tab', tabId);

    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: (prefVideo) => {
                if (window.__gravityDownloadCapturedVideo) {
                    return window.__gravityDownloadCapturedVideo(prefVideo);
                }
                return { success: false, error: 'Gravity capture hooks not loaded. Refresh the page.' };
            },
            args: [preferVideo],
            world: 'MAIN'
        });

        const result = results?.map(r => r.result).find(r => r && r.success) || results?.[0]?.result;
        console.log('[Gravity SW] Captured download result:', result);
        if (result && !result.success) {
            console.error('[Gravity SW] Download via captured data failed:', result.error);
        }
        return result || { success: false, error: 'No result from page script' };
    } catch (err) {
        console.error('[Gravity SW] executeScript failed:', err);
        return { success: false, error: err.message };
    }
}

async function getYouTubeMetadata(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: () => {
                if (window.__gravityGetYouTubeVideoData) {
                    return window.__gravityGetYouTubeVideoData().map(v => ({
                        title: v.title,
                        videoId: v.videoId
                    }));
                }
                return [];
            },
            world: 'MAIN'
        });
        return results?.flatMap(r => r.result || []) || [];
    } catch {
        return tabYouTubeData.get(tabId)?.map(v => ({
            title: v.title, videoId: v.videoId
        })) || [];
    }
}

// ── Shared: Try downloading from captured data ──────────────────────────────
// This pattern was duplicated 4x in the old message-handler.js.

async function tryDownloadFromCapturedData(tabId, preferVideo = true) {
    const capturedTracks = await getCapturedTracksSummary(tabId);
    if (capturedTracks.length === 0) return null;

    const totalSize = capturedTracks.reduce((sum, t) => sum + t.totalSize, 0);
    if (totalSize <= 50000) return null; // Less than 50KB

    const result = await downloadViaCapturedData(tabId, preferVideo);
    if (result.success) {
        await notifyTab(tabId, 'success',
            `Downloading: ${result.filename} (${(result.size / 1024 / 1024).toFixed(1)}MB)`);
        return result;
    }

    console.warn('[Gravity SW] Captured download failed:', result.error);
    return null;
}

// ── Shared: Try YouTube auto-buffer ─────────────────────────────────────────
// This flow was duplicated in handleDownloadSegments and handleDownloadNetworkMedia.

async function invokeForceBuffer(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: () => {
                if (window.__gravityForceBuffer) {
                    return window.__gravityForceBuffer({
                        seekStep: 5,
                        seekDelay: 300,
                        autoDownload: true
                    });
                }
                return { success: false, error: 'Gravity hooks not loaded. Refresh the page.' };
            },
            world: 'MAIN'
        });

        const result = results?.map(r => r.result).find(r => r && r.success) || results?.[0]?.result;
        return result || { success: false, error: 'No result from force buffer' };
    } catch (err) {
        console.error('[Gravity SW] invokeForceBuffer failed:', err);
        return { success: false, error: err.message };
    }
}

export async function invokeAbortBuffer(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: () => {
                if (window.__gravityAbortBuffer) {
                    return window.__gravityAbortBuffer();
                }
                return { aborted: false };
            },
            world: 'MAIN'
        });
        return results?.map(r => r.result).find(r => r && r.aborted) || results?.[0]?.result;
    } catch (err) {
        return { aborted: false, error: err.message };
    }
}

/**
 * Try the YouTube auto-buffer flow. Returns a result object or null if not YouTube.
 */
async function tryYouTubeAutoBuffer(tabId) {
    const isYT = await isYouTubePage(tabId);
    if (!isYT) return null;

    console.log('[Gravity SW] Initiating Hidden Player auto-buffer for YouTube');
    await notifyTab(tabId, 'success', 'Auto-buffering video... please wait');

    const forceBufferResult = await invokeForceBuffer(tabId);

    if (forceBufferResult?.success) {
        const stats = forceBufferResult.stats;
        if (stats?.filename) {
            await notifyTab(tabId, 'success',
                `Download started: ${stats.filename} (${stats.capturedMB}MB)`);
        }
        return { success: true, autoBuffered: true, stats };
    } else {
        const errorMsg = forceBufferResult?.error || 'Auto-buffering failed';
        console.warn('[Gravity SW] Auto-buffer failed:', errorMsg);
        await notifyTab(tabId, 'warning', errorMsg);
        return { success: false, error: errorMsg };
    }
}

// ── Helper Functions ────────────────────────────────────────────────────────

function getBaseUrl(url) {
    try {
        const u = new URL(url);
        u.searchParams.delete('range');
        return u.toString();
    } catch {
        return url;
    }
}

// ── Download Segments Handler ───────────────────────────────────────────────

export async function handleDownloadSegments(payload, sender, sendResponse) {
    let tabId = sender.tab?.id;
    if (!tabId && payload?.tabId) tabId = payload.tabId;

    if (!tabId) {
        sendResponse?.({ success: false, error: 'No tab ID' });
        return;
    }

    try {
        // Strategy 1: YouTube auto-buffer
        const ytResult = await tryYouTubeAutoBuffer(tabId);
        if (ytResult) {
            sendResponse?.(ytResult);
            return;
        }

        // Strategy 2: Use captured data (works for other MSE players)
        const capturedResult = await tryDownloadFromCapturedData(tabId, true);
        if (capturedResult) {
            sendResponse?.({ success: true });
            return;
        }

        // Strategy 3: Network monitor URLs
        const networkMedia = getTabMedia(tabId);

        if (networkMedia.video.length === 0 && networkMedia.audio.length === 0) {
            await notifyTab(tabId, 'warning',
                'No video data captured. Play the video first, then try downloading.');
            sendResponse?.({ success: false, error: 'No video data' });
            return;
        }

        await handleSegmentConcatenation(tabId, networkMedia, 'video', sendResponse);

    } catch (err) {
        console.error('[Gravity SW] Segment download failed:', err);
        notifyDownloadError(`Download failed: ${err.message}`);
        sendResponse?.({ success: false, error: err.message });
    }
}

// ── Segment Concatenation for Non-YouTube Sites ─────────────────────────────

async function handleSegmentConcatenation(tabId, networkMedia, mediaType, sendResponse) {
    const mediaList = mediaType === 'audio' ? networkMedia.audio : networkMedia.video;

    if (mediaList.length === 0) {
        sendResponse?.({ success: false, error: `No ${mediaType} segments found` });
        return;
    }

    // First try: use captured data
    const capturedResult = await tryDownloadFromCapturedData(tabId, mediaType === 'video');
    if (capturedResult) {
        sendResponse?.({ success: true });
        return;
    }

    // Fallback: try direct URL download
    const segmentGroups = new Map();
    for (const entry of mediaList) {
        const baseUrl = getBaseUrl(entry.url);
        if (!segmentGroups.has(baseUrl)) segmentGroups.set(baseUrl, []);
        segmentGroups.get(baseUrl).push(entry);
    }

    let bestTrack = null;
    let maxTotalSize = 0;

    for (const [baseUrl, segments] of segmentGroups) {
        const totalSize = segments.reduce((sum, s) => sum + (s.size || 0), 0);
        if (totalSize > maxTotalSize) {
            maxTotalSize = totalSize;
            bestTrack = baseUrl;
        }
    }

    if (!bestTrack) {
        await notifyTab(tabId, 'error', `No valid ${mediaType} segments found.`);
        sendResponse?.({ success: false, error: 'No segments' });
        return;
    }

    try {
        const ext = mediaType === 'audio' ? 'm4a' : 'mp4';
        const filename = `Gravity_${mediaType}_${Date.now()}.${ext}`;

        await notifyTab(tabId, 'success', `Downloading ${mediaType}...`);
        await setupDownloadHeaders(bestTrack, tabId);

        const downloadId = await downloadViaOffscreenDocument(bestTrack, tabId, filename);
        sendResponse?.({ success: true, downloadId });
    } catch (err) {
        await notifyTab(tabId, 'error', `Download failed: ${err.message}`);
        sendResponse?.({ success: false, error: err.message });
    }
}

// ── Download Network Media Handler ──────────────────────────────────────────

export async function handleDownloadNetworkMedia(payload, sender, sendResponse) {
    const tabId = sender.tab?.id;
    const elementType = payload?.elementType || 'video';

    if (!tabId) {
        notifyDownloadError('Could not identify the tab. Please try again.');
        sendResponse?.({ success: false });
        return;
    }

    // Strategy 1: YouTube auto-buffer
    const ytResult = await tryYouTubeAutoBuffer(tabId);
    if (ytResult) {
        sendResponse?.(ytResult);
        return;
    }

    // Strategy 2: Captured data
    const capturedResult = await tryDownloadFromCapturedData(tabId, elementType === 'video');
    if (capturedResult) {
        sendResponse?.({ success: true });
        return;
    }

    // Strategy 3: Network monitor URLs
    const store = getTabMedia(tabId);
    const rawList = elementType === 'audio' ? store.audio : store.video;

    if (rawList.length === 0) {
        await notifyTab(tabId, 'error',
            `No ${elementType} stream detected yet. Press Play on the video, let it buffer, then try again.`);
        sendResponse?.({ success: false, reason: 'no_network_data' });
        return;
    }

    // Full-file URLs (non-DASH)
    const fullFileUrls = rawList.filter(e => !e.isDashSegment);
    if (fullFileUrls.length > 0) {
        const best = fullFileUrls.reduce(
            (a, b) => ((b.size || 0) > (a.size || 0) ? b : a), fullFileUrls[0]
        );
        const ext = mimeToExt(best.contentType) || (elementType === 'audio' ? 'mp3' : 'mp4');
        const filename = `Gravity_${elementType}_${Date.now()}.${ext}`;
        try {
            await setupDownloadHeaders(best.url, tabId);
            const downloadId = await downloadViaOffscreenDocument(best.url, tabId, filename);
            sendResponse?.({ success: true, downloadId });
        } catch (err) {
            notifyDownloadError(`Download failed: ${err.message}`);
            sendResponse?.({ success: false, error: err.message });
        }
        return;
    }

    // DASH segments — no direct download possible
    await notifyTab(tabId, 'error',
        'This site uses adaptive streaming. Play the video first, let it buffer, then try again.');
    sendResponse?.({ success: false, error: 'Adaptive streaming - play video first' });
}

// ── Get Segments Info Handler ───────────────────────────────────────────────

export async function handleGetSegments(payload, sender, sendResponse) {
    let tabId = sender.tab?.id;
    if (!tabId && payload?.tabId) tabId = payload.tabId;

    if (!tabId) {
        sendResponse?.({ segments: [], sources: [], youtubeData: [] });
        return;
    }

    try {
        const isYT = await isYouTubePage(tabId);
        const capturedTracks = await getCapturedTracksSummary(tabId);
        const ytMeta = isYT ? await getYouTubeMetadata(tabId) : [];

        // Get MSE sources from MAIN world
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: () => {
                if (window.__gravityGetAllMediaSources) {
                    return window.__gravityGetAllMediaSources();
                }
                return [];
            },
            world: 'MAIN'
        });

        const sources = results?.flatMap(r => r.result || []) || [];
        const networkMedia = getTabMedia(tabId);

        // Build YouTube info from captured data
        let youtubeData = null;
        const totalCapturedSize = capturedTracks.reduce((sum, t) => sum + t.totalSize, 0);
        const videoTracks = capturedTracks.filter(t => t.isVideo);
        const audioTracks = capturedTracks.filter(t => t.isAudio);

        if (isYT || ytMeta.length > 0) {
            const hasEnoughData = totalCapturedSize > 50000; // 50KB minimum

            youtubeData = {
                hasData: true,
                needsPlayback: !hasEnoughData,
                videos: [{
                    title: ytMeta[0]?.title || 'YouTube Video',
                    videoId: ytMeta[0]?.videoId || '',
                    formatCount: capturedTracks.length,
                    totalCaptured: `${(totalCapturedSize / 1024 / 1024).toFixed(1)}MB`,
                    videoTracks: videoTracks.length,
                    audioTracks: audioTracks.length,
                    segments: capturedTracks.reduce((sum, t) => sum + t.segmentCount, 0)
                }]
            };
        }

        sendResponse?.({
            success: true,
            sources,
            segments: networkMedia.video.length + networkMedia.audio.length,
            youtubeData,
            capturedTracks: capturedTracks.length,
            networkMedia: {
                video: networkMedia.video.length,
                audio: networkMedia.audio.length,
                hls: networkMedia.hls.length,
                dash: networkMedia.dash.length
            }
        });
    } catch (err) {
        console.error('[Gravity SW] handleGetSegments error:', err);
        sendResponse?.({ success: false, error: err.message });
    }
}

// ── Get Tab Media Handler ───────────────────────────────────────────────────

export function handleGetTabMedia(tabId, sendResponse) {
    if (!tabId) { sendResponse({ video: [], audio: [], hls: [], dash: [] }); return; }
    const store = getTabMedia(tabId);
    sendResponse({
        video: store.video,
        audio: store.audio,
        hls: store.hls,
        dash: store.dash,
    });
}
