import { MessageType } from '../shared/message-types.js';
import { getTabMedia, registerBlobSource } from './network-monitor.js';
import { notifyDownloadError, notifyTab, swNotify } from './notify.js';


export function setupMessageHandling() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message.type) {

            // ── Download requests ──────────────────────────────────────
            case MessageType.DOWNLOAD_REQUEST:
            case 'gravity:download-request':
                handleDownloadRequest(message.payload, sendResponse);
                return true;

            // ── Pick Mode / right-click on blob: video ────────────────
            case 'gravity:download-network-media':
                handleDownloadNetworkMedia(message.payload, sender, sendResponse);
                return true;

            // ── Download captured segments ─────────────────────────────
            case 'gravity:download-segments':
                handleDownloadSegments(message.payload, sender, sendResponse);
                return true;

            // ── Get captured segments info ─────────────────────────────
            case 'gravity:get-segments':
                handleGetSegments(message.payload, sender, sendResponse);
                return true;

            // ── Popup queries network-captured media for this tab ──────
            case 'gravity:get-tab-media':
                handleGetTabMedia(message.payload?.tabId, sendResponse);
                return true;

            // ── gravity-early.js reports a blob→source mapping ─────────
            case 'gravity:blob-created':
                if (sender.tab) {
                    registerBlobSource(sender.tab.id, message.payload.blobUrl, message.payload.sourceUrl);
                }
                break;

            // ── Segment captured notification ─────────────────────────
            case 'gravity:segment-captured':
                if (sender.tab) {
                    storeCapturedSegment(sender.tab.id, message.payload);
                }
                break;

            // ── YouTube video extracted notification ───────────────────
            case 'gravity:youtube-video-extracted':
                console.log('[Gravity SW] Received YouTube metadata:', message.payload?.title);
                if (sender.tab && message.payload) {
                    const existing = tabYouTubeData.get(sender.tab.id) || [];
                    existing.push(message.payload);
                    tabYouTubeData.set(sender.tab.id, existing);
                }
                break;

            // ── Abort auto-buffer ──────────────────────────────────────
            case 'gravity:abort-buffer':
                if (message.payload?.tabId) {
                    invokeAbortBuffer(message.payload.tabId).then(result => {
                        sendResponse?.(result);
                    });
                    return true;
                }
                break;
        }
    });
}

// ── Storage ─────────────────────────────────────────────────────────────────
const tabSegmentStore = new Map();
const tabYouTubeData = new Map();

function getOrCreateSegmentStore(tabId) {
    if (!tabSegmentStore.has(tabId)) {
        tabSegmentStore.set(tabId, new Map());
    }
    return tabSegmentStore.get(tabId);
}

function storeCapturedSegment(tabId, segmentInfo) {
    const store = getOrCreateSegmentStore(tabId);
    const key = segmentInfo.url;
    if (!store.has(key)) {
        store.set(key, segmentInfo);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── YouTube/Video Download via In-Page Capture ──────────────────────────────
// The key insight: YouTube uses SABR (Server ABR) which means captured URLs
// can't be re-downloaded. Instead, gravity-early.js captures the actual
// response body data as it streams. To download, we call a function in the 
// MAIN world that concatenates segments and triggers download via <a> click.
// ══════════════════════════════════════════════════════════════════════════════

async function downloadViaCapturedData(tabId, preferVideo = true) {
    console.log('[Gravity SW] Attempting download via captured data for tab', tabId);

    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: (prefVideo) => {
                if (window.__gravityDownloadCapturedVideo) {
                    return window.__gravityDownloadCapturedVideo(prefVideo);
                }
                return { success: false, error: 'Gravity capture hooks not loaded. Refresh the page.' };
            },
            args: [preferVideo],
            world: 'MAIN'
        });

        const result = results?.[0]?.result;
        console.log('[Gravity SW] Captured download result:', result);
        return result || { success: false, error: 'No result from page script' };
    } catch (err) {
        console.error('[Gravity SW] executeScript failed:', err);
        return { success: false, error: err.message };
    }
}

async function getCapturedTracksSummary(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                if (window.__gravityCapturedTracksSummary) {
                    return window.__gravityCapturedTracksSummary();
                }
                return [];
            },
            world: 'MAIN'
        });
        return results?.[0]?.result || [];
    } catch (err) {
        console.warn('[Gravity SW] Failed to get captured tracks:', err);
        return [];
    }
}

async function getYouTubeMetadata(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
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
        return results?.[0]?.result || [];
    } catch {
        return tabYouTubeData.get(tabId)?.map(v => ({
            title: v.title, videoId: v.videoId
        })) || [];
    }
}

async function isYouTubePage(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        return tab.url?.includes('youtube.com') || tab.url?.includes('youtu.be');
    } catch {
        return false;
    }
}

// ── Download Segments Handler ───────────────────────────────────────────────
async function handleDownloadSegments(payload, sender, sendResponse) {
    let tabId = sender.tab?.id;

    if (!tabId && payload?.tabId) {
        tabId = payload.tabId;
    }

    if (!tabId) {
        sendResponse?.({ success: false, error: 'No tab ID' });
        return;
    }

    try {
        const isYT = await isYouTubePage(tabId);

        // Strategy 1: "Hidden Player" auto-buffer for YouTube
        // We always do this for YT because otherwise we'd just download the first few 
        // seconds that the browser natively buffered. The ForceBuffer checks if it's 
        // already fully buffered and finishes instantly if so.
        if (isYT) {
            console.log('[Gravity SW] Initiating Hidden Player auto-buffer for YouTube');
            await notifyTab(tabId, 'success', 'Auto-buffering video... please wait');

            const forceBufferResult = await invokeForceBuffer(tabId);
            console.log('[Gravity SW] Force buffer result:', forceBufferResult);

            if (forceBufferResult?.success) {
                const stats = forceBufferResult.stats;
                if (stats?.filename) {
                    await notifyTab(tabId, 'success',
                        `Download started: ${stats.filename} (${stats.capturedMB}MB)`);
                }
                sendResponse?.({ success: true, autoBuffered: true, stats });
                return;
            } else {
                const errorMsg = forceBufferResult?.error || 'Auto-buffering failed';
                console.warn('[Gravity SW] Auto-buffer failed:', errorMsg);
                await notifyTab(tabId, 'warning', errorMsg);
                sendResponse?.({ success: false, error: errorMsg });
                return;
            }
        }

        // Strategy 2: Use captured data (works for other MSE players)
        const capturedTracks = await getCapturedTracksSummary(tabId);
        console.log('[Gravity SW] Captured tracks:', capturedTracks);

        if (capturedTracks.length > 0) {
            const totalSize = capturedTracks.reduce((sum, t) => sum + t.totalSize, 0);
            console.log(`[Gravity SW] Found ${capturedTracks.length} captured tracks, ${(totalSize / 1024 / 1024).toFixed(2)}MB total`);

            if (totalSize > 50000) { // At least 50KB of data
                const result = await downloadViaCapturedData(tabId, true);

                if (result.success) {
                    await notifyTab(tabId, 'success',
                        `Downloading: ${result.filename} (${(result.size / 1024 / 1024).toFixed(1)}MB)`);
                    sendResponse?.({ success: true });
                    return;
                } else {
                    console.warn('[Gravity SW] Captured download failed:', result.error);
                }
            } else {
                console.log('[Gravity SW] Captured data too small');
            }
        }

        // Strategy 3: Non-YouTube — try network monitor URLs
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

/**
 * Invokes the Hidden Player auto-buffer system in the page's MAIN world.
 * This mutes the YouTube player, scrubs through the timeline to force all
 * segments to load, captures them via our hooks, then triggers download.
 */
async function invokeForceBuffer(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
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

        const result = results?.[0]?.result;

        // The function returns a Promise, so the result might need awaiting
        // chrome.scripting.executeScript handles async functions properly
        return result || { success: false, error: 'No result from force buffer' };
    } catch (err) {
        console.error('[Gravity SW] invokeForceBuffer failed:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Abort an in-progress auto-buffer.
 */
async function invokeAbortBuffer(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                if (window.__gravityAbortBuffer) {
                    return window.__gravityAbortBuffer();
                }
                return { aborted: false };
            },
            world: 'MAIN'
        });
        return results?.[0]?.result;
    } catch (err) {
        return { aborted: false, error: err.message };
    }
}

// ── Segment Concatenation for Non-YouTube Sites ─────────────────────────────
async function handleSegmentConcatenation(tabId, networkMedia, mediaType, sendResponse) {
    const mediaList = mediaType === 'audio' ? networkMedia.audio : networkMedia.video;

    if (mediaList.length === 0) {
        sendResponse?.({ success: false, error: `No ${mediaType} segments found` });
        return;
    }

    // First try: use captured data from MAIN world hooks
    const capturedTracks = await getCapturedTracksSummary(tabId);
    if (capturedTracks.length > 0) {
        const totalSize = capturedTracks.reduce((sum, t) => sum + t.totalSize, 0);
        if (totalSize > 50000) {
            const result = await downloadViaCapturedData(tabId, mediaType === 'video');
            if (result.success) {
                await notifyTab(tabId, 'success',
                    `Downloading: ${result.filename} (${(result.size / 1024 / 1024).toFixed(1)}MB)`);
                sendResponse?.({ success: true });
                return;
            }
        }
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
        const downloadId = await chrome.downloads.download({
            url: bestTrack,
            filename,
            saveAs: false
        });
        sendResponse?.({ success: true, downloadId });
    } catch (err) {
        await notifyTab(tabId, 'error', `Download failed: ${err.message}`);
        sendResponse?.({ success: false, error: err.message });
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

// ── Get Segments Info ───────────────────────────────────────────────────────
async function handleGetSegments(payload, sender, sendResponse) {
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
            target: { tabId },
            func: () => {
                if (window.__gravityGetAllMediaSources) {
                    return window.__gravityGetAllMediaSources();
                }
                return [];
            },
            world: 'MAIN'
        });

        const sources = results?.[0]?.result || [];
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

/**
 * Downloads the best video/audio from the network monitor for a tab.
 */
async function handleDownloadNetworkMedia(payload, sender, sendResponse) {
    const tabId = sender.tab?.id;
    const elementType = payload?.elementType || 'video';

    if (!tabId) {
        notifyDownloadError('Could not identify the tab. Please try again.');
        sendResponse?.({ success: false });
        return;
    }

    const isYT = await isYouTubePage(tabId);
    if (isYT) {
        console.log('[Gravity SW] Initiating Hidden Player auto-buffer for YouTube (Network Media)');
        await notifyTab(tabId, 'success', 'Auto-buffering video... please wait');

        const forceBufferResult = await invokeForceBuffer(tabId);

        if (forceBufferResult?.success) {
            const stats = forceBufferResult.stats;
            if (stats?.filename) {
                await notifyTab(tabId, 'success',
                    `Download started: ${stats.filename} (${stats.capturedMB}MB)`);
            }
            sendResponse?.({ success: true, autoBuffered: true, stats });
            return;
        } else {
            const errorMsg = forceBufferResult?.error || 'Auto-buffering failed';
            console.warn('[Gravity SW] Auto-buffer failed:', errorMsg);
            await notifyTab(tabId, 'warning', errorMsg);
            sendResponse?.({ success: false, error: errorMsg });
            return;
        }
    }

    // First try: captured data
    const capturedTracks = await getCapturedTracksSummary(tabId);
    if (capturedTracks.length > 0) {
        const totalSize = capturedTracks.reduce((sum, t) => sum + t.totalSize, 0);
        if (totalSize > 50000) {
            const result = await downloadViaCapturedData(tabId, elementType === 'video');
            if (result.success) {
                await notifyTab(tabId, 'success',
                    `Downloading: ${result.filename} (${(result.size / 1024 / 1024).toFixed(1)}MB)`);
                sendResponse?.({ success: true });
                return;
            }
        }
    }

    // Fallback: network monitor URLs
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
            const downloadId = await chrome.downloads.download({ url: best.url, filename, saveAs: false });
            sendResponse?.({ success: true, downloadId });
        } catch (err) {
            notifyDownloadError(`Download failed: ${err.message}`);
            sendResponse?.({ success: false, error: err.message });
        }
        return;
    }

    // DASH segments — handled by captured data above, but fallback
    await notifyTab(tabId, 'error',
        'This site uses adaptive streaming. Play the video first, let it buffer, then try again.');
    sendResponse?.({ success: false, error: 'Adaptive streaming - play video first' });
}


function mimeToExt(mime) {
    const m = {
        // Video
        'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv',
        'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
        'video/3gpp': '3gp', 'video/3gpp2': '3g2', 'video/x-flv': 'flv',
        'video/x-msvideo': 'avi', 'video/mp2t': 'ts',
        // Audio
        'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg',
        'audio/webm': 'weba', 'audio/aac': 'aac', 'audio/flac': 'flac',
        'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/opus': 'opus',
        'audio/x-matroska': 'mka',
        // Image
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
        'image/webp': 'webp', 'image/avif': 'avif', 'image/heic': 'heic',
        'image/heif': 'heif', 'image/bmp': 'bmp', 'image/tiff': 'tiff',
        'image/svg+xml': 'svg',
        // Streams / misc
        'application/x-mpegurl': 'm3u8', 'application/vnd.apple.mpegurl': 'm3u8',
        'application/dash+xml': 'mpd',
        'application/octet-stream': 'bin',
    };
    return m[(mime || '').split(';')[0].trim()] || null;
}

async function handleDownloadRequest(payload, sendResponse) {
    try {
        const { url, filename, fallbackFetch } = payload;

        if (url.startsWith('data:')) {
            const downloadId = await chrome.downloads.download({
                url, filename: filename || `gravity_media_${Date.now()}`, saveAs: false
            });
            sendResponse?.({ success: true, downloadId });
            return;
        }

        if (url.startsWith('blob:')) {
            notifyDownloadError('Could not download — the video URL expired.');
            sendResponse?.({ success: false, error: 'blob_url_cross_process' });
            return;
        }

        if (!fallbackFetch) {
            const downloadId = await chrome.downloads.download({
                url, filename: filename || inferFilename(url, ''), saveAs: false
            });
            sendResponse?.({ success: true, downloadId });
            return;
        }

        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const downloadId = await chrome.downloads.download({
            url: blobUrl, filename: filename || inferFilename(url, blob.type), saveAs: false
        });
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
        sendResponse?.({ success: true, downloadId });

    } catch (error) {
        console.error('[Gravity SW] Download failed:', error);
        notifyDownloadError(error.message || 'Unknown download error');
        sendResponse?.({ success: false, error: error.message });
    }
}

function handleGetTabMedia(tabId, sendResponse) {
    if (!tabId) { sendResponse({ video: [], audio: [], hls: [], dash: [] }); return; }
    const store = getTabMedia(tabId);
    sendResponse({
        video: store.video,
        audio: store.audio,
        hls: store.hls,
        dash: store.dash,
    });
}

function inferFilename(url, mimeType, contentDisposition) {
    // 1. Prefer filename from Content-Disposition header (most accurate)
    if (contentDisposition) {
        const cdMatch = contentDisposition.match(/filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']+)['"]?/i);
        if (cdMatch && cdMatch[1]) {
            const name = decodeURIComponent(cdMatch[1].trim().replace(/^["']|["']$/g, ''));
            if (name && name.length > 1) return `Gravity_${name}`;
        }
    }

    // 2. Try to extract a meaningful name from the URL path
    try {
        const u = new URL(url);
        const pathParts = u.pathname.split('/').filter(Boolean);
        // Walk backwards to find a segment that looks like a filename
        for (let i = pathParts.length - 1; i >= 0; i--) {
            const part = decodeURIComponent(pathParts[i]);
            if (part.includes('.') && part.length > 3 && part.length < 120) {
                // Sanitize and return
                return `Gravity_${part.replace(/[<>:"/\\|?*]/g, '_')}`;
            }
        }
    } catch { }

    // 3. Fall back to MIME-based name with timestamp
    const ext = mimeToExt(mimeType) || 'bin';
    return `Gravity_media_${Date.now()}.${ext}`;
}
