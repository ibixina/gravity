console.log('[Gravity ISOLATED] Starting primary detector');

// Listen to messages from the MAIN world bridge
document.addEventListener('__gravity_bridge__', (e) => {
    try {
        const data = JSON.parse(e.detail);
        handleBridgeMessage(data);
    } catch (err) {
        console.error('[Gravity] Error parsing bridge message', err);
    }
});

function handleBridgeMessage(data) {
    const { type, payload } = data;

    // Debug logging for all bridge messages
    if (type !== 'SEGMENT_CAPTURED') {
        console.log('[Gravity Detector] Received bridge message:', type, payload);
    }

    switch (type) {
        case 'SPA_NAVIGATE':
            scanner.handleNavigation();
            break;
        case 'BLOB_CREATED':
            scanner.handleBlobCreated(payload);
            break;
        case 'SEGMENT_CAPTURED':
            scanner.handleSegmentCaptured(payload);
            break;
        case 'YOUTUBE_VIDEO_EXTRACTED':
            console.log('[Gravity Detector] YouTube video extracted:', payload);
            scanner.handleYouTubeVideoExtracted(payload);
            break;
        case 'YOUTUBE_DATA_FOUND':
            console.log('[Gravity Detector] YouTube data found:', payload);
            break;
        case 'HOOKS_READY':
            console.log('[Gravity] Early hooks ready at', payload?.timestamp);
            break;
        case 'BUFFER_PROGRESS':
            chrome.runtime.sendMessage({
                type: 'gravity:buffer-progress',
                payload
            }).catch(() => { });
            break;
        case 'CANVAS_DRAW':
        case 'IMAGE_SRC_SET':
        case 'SHADOW_ROOT_CREATED':
            break;
        default:
            // Log unknown message types for debugging
            console.log('[Gravity] Unknown bridge message:', type);
    }
}

// ────────────────────────────────────────────────────────────────────────────
//  GravityScanner
// ────────────────────────────────────────────────────────────────────────────
class GravityScanner {
    constructor() {
        // ── Media storage ─────────────────────────────────────────────────
        // We store ALL media discovered across the browsing session
        // (multiple SPA pages). This is intentional: a downloader should
        // let the user browse several posts and then download everything.
        this.mediaMap = new Map();         // id → MediaItem (cumulative)
        this.capturedSegments = new Map(); // url → segment info
        this.mediaSources = new Map();     // blobUrl → media source info
        this.currentPageUrl = window.location.href;
        this.isScanning = false;
        this._scanTimeout = null;

        this.imageDetector = new window.GravityImageDetector(this.mediaMap);

        // ── MutationObserver ──────────────────────────────────────────────
        // Fires on new nodes OR attribute changes on src/srcset/style/class.
        this.observer = new MutationObserver((mutations) => {
            let needsRescan = false;
            for (const m of mutations) {
                if (m.addedNodes.length > 0) { needsRescan = true; break; }
                if (m.type === 'attributes' &&
                    ['src', 'srcset', 'data-src', 'data-srcset', 'style', 'class']
                        .includes(m.attributeName)) {
                    needsRescan = true; break;
                }
            }
            if (needsRescan) this.scheduleScan(400);
        });

        if (document.body) {
            this.startObserving();
        } else {
            document.addEventListener('DOMContentLoaded', () => this.startObserving());
        }
    }

    startObserving() {
        this.observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'srcset', 'data-src', 'data-srcset', 'poster',
                'data-original', 'data-lazy-src', 'data-full-src',
                'style', 'class']
        });
    }

    scheduleScan(delay = 400) {
        if (this._scanTimeout) clearTimeout(this._scanTimeout);
        this._scanTimeout = setTimeout(() => this.scan(), delay);
    }

    // ── SPA navigation handler ────────────────────────────────────────────
    // BUG FIX: We do NOT clear the map on navigation.
    // Keeping cumulative results is the right behaviour for a downloader:
    // the user can browse several Instagram posts and then download all at once.
    // We simply schedule a fresh scan to pick up new content on the current page.
    handleNavigation() {
        const newUrl = window.location.href;
        if (newUrl === this.currentPageUrl) return;
        this.currentPageUrl = newUrl;
        console.log('[Gravity] SPA navigation →', newUrl, '(rescanning, keeping existing items)');
        // Give the SPA framework time to hydrate its new route before scanning.
        this.scheduleScan(900);
    }

    // ── Handle blob/media source creation ─────────────────────────────────
    handleBlobCreated(payload) {
        const { blobUrl, sourceType, mediaSourceId } = payload;
        if (!this.mediaSources.has(blobUrl)) {
            this.mediaSources.set(blobUrl, {
                url: blobUrl,
                type: sourceType,
                id: mediaSourceId,
                timestamp: Date.now(),
                segmentCount: 0
            });
            console.log(`[Gravity] MediaSource created: ${blobUrl.slice(0, 60)}...`);
            this.updateBadge();
        }
    }

    // ── Handle segment capture ────────────────────────────────────────────
    handleSegmentCaptured(payload) {
        const { url, size, source, blobUrl } = payload;
        const segmentUrl = url || blobUrl;

        if (!segmentUrl) return;

        if (!this.capturedSegments.has(segmentUrl)) {
            this.capturedSegments.set(segmentUrl, {
                url: segmentUrl,
                size,
                source,
                timestamp: Date.now()
            });

            // Update media source segment count
            this.mediaSources.forEach((sourceInfo, msUrl) => {
                if (segmentUrl.includes(msUrl) || msUrl.includes(segmentUrl)) {
                    sourceInfo.segmentCount++;
                }
            });

            console.log(`[Gravity] Segment captured: ${String(segmentUrl).slice(0, 80)} (${(size / 1024 || 0).toFixed(1)}KB)`);

            // Forward to service worker for storage
            chrome.runtime.sendMessage({
                type: 'gravity:segment-captured',
                payload: { url: segmentUrl, size, source }
            }).catch(() => { });

            this.updateBadge();
        }
    }

    // ── Handle YouTube video extraction ───────────────────────────────────
    handleYouTubeVideoExtracted(payload) {
        console.log('[Gravity Scanner] YouTube video extracted:', payload);

        if (!this.youtubeVideos) {
            this.youtubeVideos = [];
        }

        this.youtubeVideos.push({
            title: payload.title,
            videoId: payload.videoId,
            formatCount: payload.formatCount,
            timestamp: Date.now()
        });

        console.log(`[Gravity Scanner] Stored YouTube video. Total: ${this.youtubeVideos.length}`);
        this.updateBadge();
    }

    // ── Core scan ─────────────────────────────────────────────────────────
    scan() {
        if (this.isScanning) return; // Prevent re-entrant scans
        this.isScanning = true;
        try {
            this.imageDetector.scan(document);
        } finally {
            this.isScanning = false;
        }
        this.updateBadge();
    }

    // ── Async scan: resolves after scan + an extra settle wait ────────────
    // Used by the popup to make sure any in-flight lazy-loading is captured
    // before we respond. Returns a serialisable array of MediaItems.
    scanAndWait(settleMs = 300) {
        return new Promise((resolve) => {
            this.scan(); // synchronous first pass
            setTimeout(() => {
                this.scan(); // second pass after lazy content settles
                resolve(this.getSerializableMedia());
            }, settleMs);
        });
    }

    getSerializableMedia() {
        const media = Array.from(this.mediaMap.values()).map(item => {
            const copy = { ...item };
            delete copy.element; // DOM nodes can't be serialised
            return copy;
        });

        // Include YouTube videos
        if (this.youtubeVideos && this.youtubeVideos.length > 0) {
            return {
                media,
                youtubeVideos: this.youtubeVideos
            };
        }

        return media;
    }

    // ── Get captured media sources ────────────────────────────────────────
    getMediaSources() {
        return Array.from(this.mediaSources.values()).map(s => ({
            ...s,
            segments: undefined // Don't include in serialization
        }));
    }

    // ── Get captured segments ─────────────────────────────────────────────
    getCapturedSegments() {
        return Array.from(this.capturedSegments.values());
    }

    updateBadge() {
        const imageCount = this.mediaMap.size;
        const sourceCount = this.mediaSources.size;
        const segmentCount = this.capturedSegments.size;
        const youtubeCount = this.youtubeVideos?.length || 0;
        const count = imageCount + sourceCount + segmentCount + youtubeCount;

        chrome.runtime.sendMessage({
            type: 'gravity:update-badge',
            payload: { count, images: imageCount, sources: sourceCount, segments: segmentCount, youtube: youtubeCount }
        }).catch(() => { }); // SW might not be awake yet
    }
}

// ────────────────────────────────────────────────────────────────────────────
//  Singleton — shared with gravity-ui.js (same ISOLATED world / same frame)
// ────────────────────────────────────────────────────────────────────────────
window.__gravityScanner = window.__gravityScanner || new GravityScanner();
const scanner = window.__gravityScanner;

// Initial scan after the page has had time to render
setTimeout(() => scanner.scan(), 1200);

// Also catch back/forward navigation
window.addEventListener('popstate', () => scanner.handleNavigation());

// ────────────────────────────────────────────────────────────────────────────
//  Message handler
// ────────────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'gravity:scan-request') {
        // BUG FIX: use scanAndWait so we don't respond with an empty map
        // during the 800ms SPA-navigation window before the DOM has settled.
        scanner.scanAndWait(350).then((result) => {
            let media, youtubeVideos;

            if (result && result.media) {
                // Result contains both media and youtubeVideos
                media = result.media;
                youtubeVideos = result.youtubeVideos;
            } else {
                // Result is just the media array
                media = result;
            }

            // Also include captured media sources
            const sources = scanner.getMediaSources();
            const segments = scanner.getCapturedSegments();

            console.log('[Gravity Detector] scan-request response:', {
                mediaCount: media?.length || 0,
                youtubeCount: youtubeVideos?.length || 0,
                sourceCount: sources?.length || 0,
                segmentCount: segments?.length || 0
            });

            sendResponse({
                media,
                youtubeVideos,
                sources,
                segments
            });
        });
        return true; // keep channel open for async response
    }
});
