// network-monitor.js
// Passively watches HTTP traffic for media URLs using the webRequest API.
// Runs in the service worker — zero impact on page performance.

const tabMediaStore = new Map();

const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|m4v|avi|mkv|ogv|3gp|3gpp|flv|ts|m2ts)(\?|$)/i;
const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|ogg|oga|flac|wav|opus|weba|mka)(\?|$)/i;
const HLS_EXTENSIONS = /\.(m3u8)(\?|$)/i;
const DASH_EXTENSIONS = /\.(mpd)(\?|$)/i;
// Image extensions worth capturing when loaded via XHR/fetch on SPAs
const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|avif|heic|heif|bmp|tiff?|svg)(\?|$)/i;

// URLs that look like media CDN paths but are actually tracking/health pings.
// Skip these even if they're from googlevideo.com.
const SKIP_PATH_PATTERNS = [
    /\/generate_204/,
    /\/ptracking/,
    /\/api\/stats/,
    /\/videoads/,
    /\/(log|beacon|ping|track)/i,
];

function getOrCreateStore(tabId) {
    if (!tabMediaStore.has(tabId)) {
        tabMediaStore.set(tabId, {
            video: [],
            audio: [],
            hls: [],
            dash: [],
            image: [],
            blobs: new Map(),
        });
    }
    return tabMediaStore.get(tabId);
}

/**
 * Returns the media category ('video', 'audio', 'hls', 'dash', 'image') or null.
 * Uses Content-Type header first, then URL heuristics.
 */
function categoriseUrl(url, contentType) {
    const ct = (contentType || '').split(';')[0].trim().toLowerCase();

    // Must-skip: non-media content types regardless of URL
    if (ct.startsWith('text/') || ct === 'application/json' ||
        ct === 'application/javascript') {
        return null;
    }

    // ── Streaming manifests first ────────────────────────────────────────────
    if (HLS_EXTENSIONS.test(url) || ct === 'application/x-mpegurl' ||
        ct === 'application/vnd.apple.mpegurl') return 'hls';
    if (DASH_EXTENSIONS.test(url) || ct === 'application/dash+xml') return 'dash';

    // ── Audio / Video via Content-Type ──────────────────────────────────────
    if (ct.startsWith('audio/')) return 'audio';
    if (ct.startsWith('video/')) return 'video';

    // ── Image via Content-Type ───────────────────────────────────────────────
    // Only capture images that arrived over the network (not inline <img> tags —
    // those are handled by the content-script ImageDetector). This catches
    // dynamically loaded images on SPAs (Instagram, Imgur, etc.).
    if (ct.startsWith('image/') && ct !== 'image/x-icon' && ct !== 'image/vnd.microsoft.icon') {
        return 'image';
    }

    // ── URL-extension heuristics ─────────────────────────────────────────────
    if (AUDIO_EXTENSIONS.test(url)) return 'audio';
    if (VIDEO_EXTENSIONS.test(url)) return 'video';
    if (IMAGE_EXTENSIONS.test(url)) return 'image';

    // ── YouTube / googlevideo.com: Trust these CDNs ──────────────────────────
    if (url.includes('googlevideo.com') || url.includes('videoplayback')) {
        if (url.includes('mime=video')) return 'video';
        if (url.includes('mime=audio')) return 'audio';
        // itag-based classification
        const itagMatch = url.match(/itag=(\d+)/);
        if (itagMatch) {
            const itag = parseInt(itagMatch[1]);
            // Audio-only itags: 139-141, 171, 249-251
            return [139, 140, 141, 171, 249, 250, 251].includes(itag) ? 'audio' : 'video';
        }
        return 'video'; // last resort
    }

    if (ct === 'application/octet-stream' && VIDEO_EXTENSIONS.test(url)) return 'video';
    return null;
}

export function setupNetworkMonitor() {
    chrome.webRequest.onCompleted.addListener(
        (details) => {
            const { tabId, url, responseHeaders, type, statusCode } = details;
            if (tabId < 0) return;

            // Skip redirects, "no content" responses, and client errors
            if (statusCode === 204 || statusCode === 304 ||
                (statusCode >= 300 && statusCode < 400) ||
                statusCode >= 400) {
                return;
            }

            // Skip known tracking/ping paths
            try {
                const pathname = new URL(url).pathname;
                if (SKIP_PATH_PATTERNS.some(p => p.test(pathname))) return;
            } catch { return; }

            const contentType = (responseHeaders || [])
                .find(h => h.name.toLowerCase() === 'content-type')?.value || '';

            const category = categoriseUrl(url, contentType);

            // Debug logging for YouTube/googlevideo URLs
            if (url.includes('googlevideo.com') || url.includes('videoplayback')) {
                console.log(`[Gravity NM Debug] URL: ${url.slice(0, 100)}...`);
                console.log(`[Gravity NM Debug] Content-Type: ${contentType}`);
                console.log(`[Gravity NM Debug] Category: ${category}`);
            }

            if (!category) return;

            const contentLength = parseInt(
                (responseHeaders || []).find(h => h.name.toLowerCase() === 'content-length')?.value || '0'
            );

            // For xmlhttprequest (how YouTube fetches), be more lenient with size
            const minSize = type === 'xmlhttprequest' ? 10000 : 50000;
            if (type !== 'media' && contentLength > 0 && contentLength < minSize) {
                if (url.includes('googlevideo.com')) {
                    console.log(`[Gravity NM Debug] Skipped small request: ${contentLength} bytes`);
                }
                return;
            }

            const store = getOrCreateStore(tabId);
            const entry = {
                url,
                contentType: contentType.split(';')[0].trim() || 'unknown',
                size: contentLength || null,
                // Track whether the URL is a DASH segment (has range param)
                isDashSegment: url.includes('&range=') || url.includes('?range='),
                ts: Date.now(),
            };

            // For images: skip tiny files (icons, favicons, tracking pixels)
            const isImage = category === 'image';
            if (isImage && contentLength > 0 && contentLength < 5000) return;

            const list = store[category];
            if (!list.some(e => e.url === url)) {
                list.push(entry);
                console.log(`[Gravity NM] Captured ${category}: ${url.slice(0, 100)}... (Size: ${entry.size}, Type: ${entry.contentType}, Segment: ${entry.isDashSegment})`);
            }
        },
        { urls: ['<all_urls>'] },
        ['responseHeaders']
    );

    chrome.tabs.onRemoved.addListener((tabId) => tabMediaStore.delete(tabId));

    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (changeInfo.status === 'loading' && changeInfo.url) {
            tabMediaStore.delete(tabId);
        }
    });
}

// ── Public API ───────────────────────────────────────────────────────────────

export function getTabMedia(tabId) {
    return tabMediaStore.get(tabId) || { video: [], audio: [], hls: [], dash: [], image: [] };
}

export function registerBlobSource(tabId, blobUrl, sourceUrl) {
    getOrCreateStore(tabId).blobs.set(blobUrl, sourceUrl);
}

export function resolveBlobUrl(tabId, blobUrl) {
    return tabMediaStore.get(tabId)?.blobs.get(blobUrl) || null;
}
