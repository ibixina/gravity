// gravity-early.js — MAIN world, document_start
// Hooks MediaSource, fetch, XHR to capture streaming video/audio segments
// Also extracts YouTube player data for direct URL access
// Zero background scanning cost — captures data as it streams

(function () {
    'use strict';

    // ── Communication bridge to ISOLATED world ───────────────────────────────
    function notify(type, payload) {
        document.dispatchEvent(new CustomEvent('__gravity_bridge__', {
            detail: JSON.stringify({ type, payload })
        }));
    }

    // ── YouTube Video URL Extraction ─────────────────────────────────────────
    const extractedVideoData = [];

    function extractYouTubeVideoData() {
        try {
            if (window.ytInitialPlayerResponse) {
                processYouTubeData(window.ytInitialPlayerResponse);
            }

            if (window.ytInitialData) {
                notify('YOUTUBE_DATA_FOUND', { type: 'initialData', hasData: true });
            }

            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const text = script.textContent || '';
                if (text.includes('ytInitialPlayerResponse')) {
                    const match = text.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
                    if (match) {
                        try {
                            processYouTubeData(JSON.parse(match[1]));
                        } catch (e) { }
                    }
                }
                if (text.includes('ytplayer.config')) {
                    const match = text.match(/ytplayer\.config\s*=\s*({.+?});/);
                    if (match) {
                        try {
                            const config = JSON.parse(match[1]);
                            if (config.args?.player_response) {
                                processYouTubeData(JSON.parse(config.args.player_response));
                            }
                        } catch (e) { }
                    }
                }
            }
        } catch (e) {
            console.error('[Gravity Early] YouTube extraction error:', e);
        }
    }

    function processYouTubeData(data) {
        if (!data?.streamingData) return;
        console.log(`[Gravity Capture] YouTube player response intercepted. Video: ${data.videoDetails?.title}`);

        const videoDetails = data.videoDetails;
        const formats = [];

        // Collect format metadata (we won't use URLs directly anymore - SABR makes them unusable)
        const allFormats = [
            ...(data.streamingData.formats || []),
            ...(data.streamingData.adaptiveFormats || [])
        ];

        for (const format of allFormats) {
            formats.push({
                type: format.mimeType || '',
                itag: format.itag,
                quality: format.qualityLabel || format.audioQuality || 'unknown',
                width: format.width,
                height: format.height,
                bitrate: format.bitrate,
                contentLength: format.contentLength,
                isVideo: format.mimeType?.includes('video'),
                isAudio: format.mimeType?.includes('audio'),
                isCombined: !!(data.streamingData.formats || []).find(f => f.itag === format.itag)
            });
        }

        if (videoDetails) {
            const videoInfo = {
                title: videoDetails.title || 'Unknown',
                videoId: videoDetails.videoId || '',
                formats,
                timestamp: Date.now()
            };

            extractedVideoData.push(videoInfo);
            notify('YOUTUBE_VIDEO_EXTRACTED', videoInfo);

            try {
                chrome.runtime.sendMessage({
                    type: 'gravity:youtube-video-extracted',
                    payload: videoInfo
                });
            } catch (e) { }
        }
    }

    // Try to extract on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', extractYouTubeVideoData);
    } else {
        extractYouTubeVideoData();
    }

    // Also try when ytInitialPlayerResponse is set
    let _ytIPR = window.ytInitialPlayerResponse; // preserve any existing value
    try {
        Object.defineProperty(window, 'ytInitialPlayerResponse', {
            set: function (value) {
                _ytIPR = value;
                processYouTubeData(value);
            },
            get: function () {
                return _ytIPR;
            },
            configurable: true
        });
    } catch (e) { }

    // ══════════════════════════════════════════════════════════════════════════
    // ── VIDEO/AUDIO SEGMENT CAPTURE ─────────────────────────────────────────
    // This is the KEY part: capture actual response data from YouTube/video
    // streaming requests. Instead of trying to re-download from URLs (which
    // fails with SABR), we save the actual bytes as they stream through.
    // ══════════════════════════════════════════════════════════════════════════

    // Store captured video/audio data organized by track
    // Key: itag or generated track ID
    // Value: { segments: [ArrayBuffer], mimeType, totalSize, isVideo, isAudio }
    const capturedTracks = new Map();
    let totalCapturedBytes = 0;
    const MAX_CAPTURE_BYTES = 500 * 1024 * 1024; // 500MB cap per page

    function getTrackKey(url) {
        try {
            const u = new URL(url);
            const itag = u.searchParams.get('itag');
            const mime = u.searchParams.get('mime') || '';
            if (itag) return `yt-${itag}`;
            // For non-YouTube, use base URL (without range)
            u.searchParams.delete('range');
            u.searchParams.delete('rn');
            u.searchParams.delete('rbuf');
            return `track-${u.pathname.slice(0, 80)}`;
        } catch {
            return `track-${url.slice(0, 80)}`;
        }
    }

    function getTrackMimeType(url) {
        try {
            const u = new URL(url);
            const mime = u.searchParams.get('mime');
            if (mime) return decodeURIComponent(mime);
        } catch { }
        return null;
    }

    function isVideoUrl(url) {
        const mime = getTrackMimeType(url);
        if (mime) return mime.startsWith('video');

        try {
            const u = new URL(url);
            const itag = parseInt(u.searchParams.get('itag') || '0');
            // Common audio itags
            if ([139, 140, 141, 171, 249, 250, 251].includes(itag)) return false;
        } catch { }

        return true; // default to video
    }

    function captureResponseData(url, buffer, source) {
        if (!buffer || buffer.byteLength === 0) return;
        if (totalCapturedBytes > MAX_CAPTURE_BYTES) return; // Safety cap

        const trackKey = getTrackKey(url);
        const mime = getTrackMimeType(url);
        const isVideo = isVideoUrl(url);

        if (!capturedTracks.has(trackKey)) {
            capturedTracks.set(trackKey, {
                key: trackKey,
                segments: [],
                mimeType: mime || (isVideo ? 'video/mp4' : 'audio/mp4'),
                totalSize: 0,
                isVideo: isVideo,
                isAudio: !isVideo,
                firstUrl: url,
                segmentCount: 0
            });
        }

        const track = capturedTracks.get(trackKey);

        // Clone the buffer to prevent it from being detached
        const cloned = buffer.slice(0);
        track.segments.push(cloned);
        track.totalSize += cloned.byteLength;
        track.segmentCount++;
        totalCapturedBytes += cloned.byteLength;

        // Notify about capture progress (throttled)
        if (track.segmentCount % 5 === 1 || track.segmentCount <= 3) {
            notify('SEGMENT_CAPTURED', {
                trackKey,
                size: cloned.byteLength,
                totalSize: track.totalSize,
                segmentCount: track.segmentCount,
                isVideo: track.isVideo,
                source
            });
        }
        console.log(`[Gravity Capture] Captured segment for ${trackKey} (${source}): ${cloned.byteLength} bytes. Total captured: ${track.totalSize} bytes.`);
    }

    // ── Segment Storage (legacy MediaSource tracking) ────────────────────────
    const mediaSourceMap = new WeakMap();
    const segmentStore = new Map();

    // ── MediaSource Hook ─────────────────────────────────────────────────────
    const OriginalMediaSource = window.MediaSource;

    function hookedMediaSource() {
        const ms = new OriginalMediaSource();
        const msId = Math.random().toString(36).slice(2, 11);

        mediaSourceMap.set(ms, {
            id: msId,
            segments: [],
            sourceBuffers: [],
            url: null
        });

        return ms;
    }

    hookedMediaSource.prototype = OriginalMediaSource.prototype;
    hookedMediaSource.isTypeSupported = OriginalMediaSource.isTypeSupported;
    Object.setPrototypeOf(hookedMediaSource, OriginalMediaSource);
    window.MediaSource = hookedMediaSource;

    // ── SourceBuffer Hook ────────────────────────────────────────────────────
    const sourceBufferToMediaSource = new WeakMap();
    const sourceBufferMimeTypes = new WeakMap(); // Track mimeType per SourceBuffer
    let sbCounter = 0; // Unique counter for SourceBuffer track keys

    const origAddSourceBuffer = OriginalMediaSource.prototype.addSourceBuffer;
    OriginalMediaSource.prototype.addSourceBuffer = function (mimeType) {
        const sb = origAddSourceBuffer.call(this, mimeType);
        sourceBufferToMediaSource.set(sb, this);
        sourceBufferMimeTypes.set(sb, mimeType);

        if (mediaSourceMap.has(this)) {
            const msData = mediaSourceMap.get(this);
            msData.sourceBuffers.push({ buffer: sb, mimeType, type: mimeType });
        }

        // Create a capturedTracks entry for this SourceBuffer
        // This captures the CLEAN, decoded data (no SABR wrapper)
        const isVideo = mimeType.includes('video');
        const isAudio = mimeType.includes('audio');
        const trackKey = `mse-${isVideo ? 'video' : 'audio'}-${sbCounter++}`;

        // Store mapping from SourceBuffer to its track key
        sb.__gravityTrackKey = trackKey;

        if (!capturedTracks.has(trackKey)) {
            capturedTracks.set(trackKey, {
                key: trackKey,
                segments: [],
                mimeType: mimeType.split(';')[0].trim(), // e.g. "video/mp4"
                totalSize: 0,
                isVideo: isVideo,
                isAudio: isAudio,
                firstUrl: null,
                segmentCount: 0,
                isClean: true // Already decoded, no SABR stripping needed
            });
        }

        console.log(`[Gravity Early] SourceBuffer created: ${trackKey} (${mimeType})`);
        return sb;
    };

    const OriginalSourceBuffer = window.SourceBuffer || window.WebKitSourceBuffer;

    if (OriginalSourceBuffer) {
        const origAppendBuffer = OriginalSourceBuffer.prototype.appendBuffer;

        OriginalSourceBuffer.prototype.appendBuffer = function (data) {
            try {
                if (data && (data.slice || data.buffer)) {
                    const clonedData = data.slice(0);

                    // Store in legacy mediaSourceMap
                    const ms = sourceBufferToMediaSource.get(this);
                    if (ms && mediaSourceMap.has(ms)) {
                        const msData = mediaSourceMap.get(ms);
                        msData.segments.push({
                            data: clonedData,
                            timestamp: performance.now(),
                            type: this.type || 'unknown'
                        });
                    }

                    // *** KEY: Also store in capturedTracks ***
                    // This is CLEAN data — YouTube's player already decoded SABR
                    const trackKey = this.__gravityTrackKey;
                    if (trackKey && capturedTracks.has(trackKey)) {
                        const track = capturedTracks.get(trackKey);
                        if (totalCapturedBytes < MAX_CAPTURE_BYTES) {
                            track.segments.push(clonedData);
                            track.totalSize += clonedData.byteLength;
                            track.segmentCount++;
                            totalCapturedBytes += clonedData.byteLength;
                            console.log(`[Gravity Capture] Captured segment for ${trackKey} (SourceBuffer): ${clonedData.byteLength} bytes. Total captured: ${track.totalSize} bytes.`);
                        }
                    }
                }
            } catch (e) { }

            return origAppendBuffer.call(this, data);
        };
    }

    // ── URL.createObjectURL Hook ─────────────────────────────────────────────
    const origCreateObjectURL = URL.createObjectURL;
    window.URL.createObjectURL = function (obj) {
        const url = origCreateObjectURL.call(this, obj);

        if (obj instanceof window.MediaSource) {
            const msData = mediaSourceMap.get(obj);
            if (msData) {
                msData.url = url;
                segmentStore.set(url, {
                    id: msData.id,
                    segments: msData.segments,
                    url: url,
                    timestamp: Date.now()
                });

                notify('BLOB_CREATED', {
                    blobUrl: url,
                    sourceType: 'MediaSource',
                    mediaSourceId: msData.id
                });
            }
        } else if (obj instanceof window.Blob) {
            notify('BLOB_CREATED', { blobUrl: url, sourceType: 'Blob' });
        }

        return url;
    };

    // ══════════════════════════════════════════════════════════════════════════
    // ── Fetch Hook — THE KEY CAPTURE POINT ──────────────────────────────────
    // Captures actual response bodies from video/audio streaming requests.
    // This is how we get the real video data that YouTube sends.
    // ══════════════════════════════════════════════════════════════════════════
    const origFetch = window.fetch;
    window.fetch = function (...args) {
        const [input, options] = args;
        const urlStr = typeof input === 'string' ? input : (input?.url || input?.href || '');

        const isVideoSegment = looksLikeVideoSegment(urlStr);

        const promise = origFetch.apply(this, args);

        if (isVideoSegment) {
            promise.then(response => {
                if (response.ok && response.body) {
                    try {
                        const clonedResponse = response.clone();
                        clonedResponse.arrayBuffer().then(buffer => {
                            if (buffer && buffer.byteLength > 1000) { // Skip tiny responses (errors, pings)
                                captureResponseData(urlStr, buffer, 'fetch');
                            }
                        }).catch(() => { });
                    } catch (e) { }
                }
                return response;
            }).catch(() => { });
        }

        return promise;
    };

    // ── XMLHttpRequest Hook ──────────────────────────────────────────────────
    const OrigXMLHttpRequest = window.XMLHttpRequest;

    function HookedXHR() {
        const xhr = new OrigXMLHttpRequest();
        const originalOpen = xhr.open;
        const originalSend = xhr.send;
        let requestUrl = '';

        xhr.open = function (method, url, ...rest) {
            requestUrl = url;
            return originalOpen.call(this, method, url, ...rest);
        };

        xhr.send = function (...args) {
            const isVideo = looksLikeVideoSegment(requestUrl);

            if (isVideo) {
                const captureUrl = requestUrl;
                xhr.addEventListener('loadend', function () {
                    if (xhr.readyState === 4 && xhr.status === 200) {
                        try {
                            const response = xhr.response;
                            if (response instanceof ArrayBuffer && response.byteLength > 1000) {
                                captureResponseData(captureUrl, response, 'xhr');
                            }
                        } catch (e) { }
                    }
                });
            }

            return originalSend.apply(this, args);
        };

        return xhr;
    }

    HookedXHR.prototype = OrigXMLHttpRequest.prototype;

    try {
        Object.defineProperty(HookedXHR, 'UNSENT', { value: OrigXMLHttpRequest.UNSENT, writable: false });
        Object.defineProperty(HookedXHR, 'OPENED', { value: OrigXMLHttpRequest.OPENED, writable: false });
        Object.defineProperty(HookedXHR, 'HEADERS_RECEIVED', { value: OrigXMLHttpRequest.HEADERS_RECEIVED, writable: false });
        Object.defineProperty(HookedXHR, 'LOADING', { value: OrigXMLHttpRequest.LOADING, writable: false });
        Object.defineProperty(HookedXHR, 'DONE', { value: OrigXMLHttpRequest.DONE, writable: false });
    } catch (e) {
        ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'].forEach(prop => {
            try { HookedXHR[prop] = OrigXMLHttpRequest[prop]; } catch (e2) { }
        });
    }

    window.XMLHttpRequest = HookedXHR;

    // ── Helper Functions ─────────────────────────────────────────────────────

    // Returns true if a URL looks like a media segment that we should capture.
    // Used by both fetch and XHR hooks to decide whether to clone the response.
    function looksLikeVideoSegment(url) {
        if (!url) return false;
        const mediaPatterns = [
            // Video / segment container formats
            /\.ts(\?|$)/i,
            /\.m4s(\?|$)/i,
            /\.mp4(\?|$)/i,
            /\.webm(\?|$)/i,
            /\.mov(\?|$)/i,
            /\.mkv(\?|$)/i,
            /\.3gp(\?|$)/i,
            /\.ogv(\?|$)/i,
            /\.m2ts(\?|$)/i,
            // Audio segment formats
            /\.mp3(\?|$)/i,
            /\.m4a(\?|$)/i,
            /\.aac(\?|$)/i,
            /\.ogg(\?|$)/i,
            /\.opus(\?|$)/i,
            /\.flac(\?|$)/i,
            /\.weba(\?|$)/i,
            // Streaming manifests
            /\.m3u8(\?|$)/i,
            /\.mpd(\?|$)/i,
            // Segment naming patterns
            /\/seg(ment)?[_-]?\d+/i,
            /[_-]seg\d+/i,
            /chunk[_-]\d+/i,
            /frag(ment)?[_-]?\d+/i,
            /init\.mp4/i,
            // YouTube / Google Video CDN
            /\/videoplayback/,
            /googlevideo\.com/,
            /\.googlevideo\.com/,
            // Query param patterns
            /[?&]range=\d+-\d+/,
            /[?&]itag=\d+/,
            /[?&]mime=video/,
            /[?&]mime=audio/,
            // Twitter/X video CDN
            /video\.twimg\.com/,
            // Facebook/Meta CDN
            /fbcdn\.net\/.*\.(mp4|webm)/i,
            // Instagram CDN
            /cdninstagram\.com/,
            // TikTok CDN
            /tiktok\.com.*video/,
            /tiktokcdn\.com/,
            // Reddit video CDN
            /v\.redd\.it/,
            /redd-video/,
            // Cloudfront / CDN77 media patterns
            /\.cloudfront\.net\/.*\.(mp4|webm|ts|m4s)/i,
        ];
        return mediaPatterns.some(p => p.test(url));
    }

    // ── attachShadow Hook ────────────────────────────────────────────────────
    const origAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
        const shadowRoot = origAttachShadow.call(this, init);
        if (!this.__gravityShadowRoot) {
            Object.defineProperty(this, '__gravityShadowRoot', {
                value: shadowRoot,
                enumerable: false,
                configurable: true
            });
        }
        notify('SHADOW_ROOT_CREATED', { host: this.tagName });
        return shadowRoot;
    };

    // ── History hooks for SPA navigation ─────────────────────────────────────
    // IMPORTANT: YouTube fires replaceState very frequently (every few seconds)
    // to update the URL timestamp — we must NOT clear tracks on replaceState,
    // only on pushState (which signals a real page/video navigation).
    let _lastPushedUrl = window.location.href;
    function wrapHistory(method) {
        const orig = history[method];
        history[method] = function (...args) {
            const result = orig.apply(this, args);
            const newUrl = window.location.href;

            if (method === 'pushState') {
                // Real navigation: clear capture state for the new video
                if (newUrl !== _lastPushedUrl) {
                    _lastPushedUrl = newUrl;
                    capturedTracks.clear();
                    totalCapturedBytes = 0;
                    notify('SPA_NAVIGATE', { url: newUrl });
                }
            } else {
                // replaceState: just notify for URL tracking, don't clear tracks
                notify('SPA_NAVIGATE', { url: newUrl });
            }

            return result;
        };
    }
    wrapHistory('pushState');
    wrapHistory('replaceState');

    // ══════════════════════════════════════════════════════════════════════════
    // ── API exposed for extension scripts ────────────────────────────────────
    // Called via chrome.scripting.executeScript from the background script
    // ══════════════════════════════════════════════════════════════════════════

    window.__gravityGetSegments = function (blobUrl) {
        if (blobUrl && segmentStore.has(blobUrl)) {
            return segmentStore.get(blobUrl);
        }
        return {
            segmentStore: Array.from(segmentStore.entries()),
            capturedTracks: getCapturedTracksSummary()
        };
    };

    window.__gravityGetAllMediaSources = function () {
        return Array.from(segmentStore.values()).map(s => ({
            id: s.id,
            url: s.url,
            segmentCount: s.segments.length,
            timestamp: s.timestamp
        }));
    };

    window.__gravityGetYouTubeVideoData = function () {
        return extractedVideoData;
    };

    // ══════════════════════════════════════════════════════════════════════════
    // ── HIDDEN PLAYER AUTO-BUFFER SYSTEM ────────────────────────────────────
    // The "Hidden Player" Route: When download is requested, we automatically
    // scrub through the existing YouTube video element to force the browser to
    // download all segments. Our existing hooks (fetch, XHR, SourceBuffer)
    // capture everything as it streams in.
    // ══════════════════════════════════════════════════════════════════════════

    let _isAutoBuffering = false;
    let _bufferAbortController = null;

    /**
     * Get the total buffered duration of a video element.
     */
    function getBufferedDuration(video) {
        if (!video.buffered || video.buffered.length === 0) return 0;
        let total = 0;
        for (let i = 0; i < video.buffered.length; i++) {
            total += video.buffered.end(i) - video.buffered.start(i);
        }
        return total;
    }

    /**
     * Find the next un-buffered position after `time`.
     */
    function findNextUnbufferedPosition(video, time) {
        if (!video.buffered || video.buffered.length === 0) return time;
        for (let i = 0; i < video.buffered.length; i++) {
            if (time >= video.buffered.start(i) && time <= video.buffered.end(i)) {
                // We're inside a buffered range — skip to the end of it
                return video.buffered.end(i) + 0.5;
            }
        }
        return time; // Not in any buffered range, seek here
    }

    /**
     * Wait until the video has seeked and some data is buffered near `targetTime`.
     */
    function waitForSeekAndBuffer(video, targetTime, timeoutMs = 5000) {
        return new Promise((resolve) => {
            const start = Date.now();
            let resolved = false;

            function check() {
                if (resolved) return;
                // Check if we have data near the target time
                const buf = video.buffered;
                for (let i = 0; i < buf.length; i++) {
                    if (buf.start(i) <= targetTime + 1 && buf.end(i) >= targetTime - 1) {
                        resolved = true;
                        resolve(true);
                        return;
                    }
                }
                if (Date.now() - start > timeoutMs) {
                    resolved = true;
                    resolve(false); // Timed out
                    return;
                }
                requestAnimationFrame(check);
            }

            // Also listen for seeking/seeked events as a faster signal
            const onSeeked = () => {
                video.removeEventListener('seeked', onSeeked);
                // Give it a small delay to let buffer catch up
                setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        resolve(true);
                    }
                }, 100);
            };
            video.addEventListener('seeked', onSeeked);

            check();
        });
    }

    /**
     * Force-buffer the entire video by rapidly seeking through the timeline.
     * This is the core "Hidden Player" strategy:
     * 1. Mute the existing video element
     * 2. Ensure it's playing (seeks only load data when playing on YouTube)
     * 3. Progressively seek forward in chunks
     * 4. Monitor captured data via our hooks
     * 5. Report progress via callback
     * 6. When complete, restore the video state and trigger download
     *
     * @param {object} options
     * @param {number} options.seekStep - Seconds to jump forward each step (default: 5)
     * @param {number} options.seekDelay - Ms to wait between seeks (default: 300)
     * @param {boolean} options.autoDownload - Trigger download when complete (default: true)
     * @returns {Promise<object>} Result with success, error, stats
     */
    window.__gravityForceBuffer = async function (options = {}) {
        if (_isAutoBuffering) {
            return { success: false, error: 'Auto-buffering already in progress' };
        }

        const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
        if (!video) return { success: false, error: 'No video element found' };

        const duration = video.duration;
        if (!duration || isNaN(duration) || duration === Infinity) {
            return { success: false, error: 'Cannot determine video duration (live stream?)' };
        }

        const {
            seekStep = 5,
            seekDelay = 300,
            autoDownload = true
        } = options;

        _isAutoBuffering = true;
        _bufferAbortController = { aborted: false };

        console.log(`[Gravity HiddenPlayer] Starting auto-buffer for ${duration.toFixed(1)}s video`);
        console.log(`[Gravity HiddenPlayer] Settings: step=${seekStep}s, delay=${seekDelay}ms`);

        // Save current player state
        const wasPaused = video.paused;
        const wasMuted = video.muted;
        const wasVolume = video.volume;
        const origTime = video.currentTime;
        const origPlaybackRate = video.playbackRate;

        // Record starting captured data size
        const startingCapturedBytes = totalCapturedBytes;

        // Visual obscurification to mimic a "Hidden Player" without breaking MSE
        // Creating a truly separate hidden <video> on YouTube breaks because of SABR decoding
        // So we use the main player but hide it visually and mute it while we scrub.
        const origOpacity = video.style.opacity;
        const origFilter = video.style.filter;

        // Try to obscure the surrounding player too
        let overlayDiv = null;
        try {
            const player = document.getElementById('movie_player') || video.parentElement;
            if (player) {
                overlayDiv = document.createElement('div');
                overlayDiv.style.position = 'absolute';
                overlayDiv.style.top = '0';
                overlayDiv.style.left = '0';
                overlayDiv.style.width = '100%';
                overlayDiv.style.height = '100%';
                overlayDiv.style.backgroundColor = '#000';
                overlayDiv.style.zIndex = '9999';
                overlayDiv.style.display = 'flex';
                overlayDiv.style.alignItems = 'center';
                overlayDiv.style.justifyContent = 'center';
                overlayDiv.style.color = '#fff';
                overlayDiv.style.fontFamily = 'monospace';
                overlayDiv.style.fontSize = '24px';
                const innerDiv = document.createElement('div');

                const iconDiv = document.createElement('div');
                iconDiv.style.fontSize = '40px';
                iconDiv.style.marginBottom = '10px';
                iconDiv.textContent = '⏳';

                const textNode = document.createTextNode('Auto-Buffering...');

                const brNode = document.createElement('br');

                const spanNode = document.createElement('span');
                spanNode.id = 'gravity-buffer-percent';
                spanNode.style.fontSize = '16px';
                spanNode.style.color = '#aaa';
                spanNode.textContent = '0%';

                innerDiv.appendChild(iconDiv);
                innerDiv.appendChild(textNode);
                innerDiv.appendChild(brNode);
                innerDiv.appendChild(spanNode);

                overlayDiv.appendChild(innerDiv);
                player.appendChild(overlayDiv);
            }
        } catch (e) { }

        // Dispatch progress event
        function reportProgress(phase, percent, message) {
            const detail = {
                phase,
                percent: Math.min(100, Math.round(percent)),
                message,
                capturedMB: ((totalCapturedBytes - startingCapturedBytes) / 1024 / 1024).toFixed(1),
                totalTracks: capturedTracks.size
            };
            document.dispatchEvent(new CustomEvent('gravity:buffer-progress', { detail }));
            // Call notify to send it to our ISOLATED world bridge
            notify('BUFFER_PROGRESS', detail);

            if (overlayDiv) {
                const pctEl = overlayDiv.querySelector('#gravity-buffer-percent');
                if (pctEl) pctEl.textContent = `${detail.percent}% - ${detail.capturedMB}MB`;
            }

            console.log(`[Gravity HiddenPlayer] ${phase}: ${detail.percent}% - ${message} (${detail.capturedMB}MB captured)`);
        }

        try {
            // Phase 1: Prepare the video
            reportProgress('preparing', 0, 'Preparing video for buffering...');

            // Mute and set volume to 0 for silent operation
            video.muted = true;
            video.volume = 0;

            // Set a faster playback rate to speed up any wait times
            video.playbackRate = 1;

            // Ensure it's playing — YouTube needs the video to be playing to fetch segments
            if (video.paused) {
                try {
                    await video.play();
                } catch (e) {
                    // Autoplay blocked — try with user gesture simulation
                    console.warn('[Gravity HiddenPlayer] Autoplay blocked, trying click simulation');
                    const playBtn = document.querySelector('.ytp-play-button, [aria-label*="Play"]');
                    if (playBtn) playBtn.click();
                    await new Promise(r => setTimeout(r, 500));
                    try { await video.play(); } catch (e2) {
                        _isAutoBuffering = false;
                        return {
                            success: false,
                            error: 'Could not start playback. Click Play on the video first, then try again.'
                        };
                    }
                }
            }

            // Wait for the video to be in a ready state
            await new Promise(r => setTimeout(r, 200));

            // Phase 2: Try to set highest quality via YouTube's internal API
            reportProgress('quality', 2, 'Requesting highest quality...');
            try {
                const player = document.getElementById('movie_player');
                if (player && typeof player.setPlaybackQualityRange === 'function') {
                    const qualities = player.getAvailableQualityLevels?.() || [];
                    if (qualities.length > 0) {
                        const highest = qualities[0]; // YouTube returns highest first
                        console.log(`[Gravity HiddenPlayer] Setting quality: ${highest} (available: ${qualities.join(',')}`);
                        player.setPlaybackQualityRange(highest, highest);
                    }
                }
            } catch (e) {
                console.warn('[Gravity HiddenPlayer] Could not set quality:', e.message);
            }

            await new Promise(r => setTimeout(r, 300));

            // Phase 3: Scrub through the video timeline
            reportProgress('buffering', 5, 'Starting timeline scrub...');

            const totalSteps = Math.ceil(duration / seekStep);
            let seekPosition = 0;
            let step = 0;
            let stuckCount = 0;
            let lastCapturedBytes = totalCapturedBytes;

            while (seekPosition < duration - 1) {
                if (_bufferAbortController.aborted) {
                    console.log('[Gravity HiddenPlayer] Aborted by user');
                    break;
                }

                // Skip already-buffered regions
                seekPosition = findNextUnbufferedPosition(video, seekPosition);

                if (seekPosition >= duration - 1) {
                    break; // Fully buffered
                }

                // Seek to the position
                video.currentTime = Math.min(seekPosition, duration - 0.5);

                // Wait for the seek to complete and data to load
                const seeked = await waitForSeekAndBuffer(video, seekPosition, 3000);

                if (!seeked) {
                    // If seek didn't produce data, try advancing anyway
                    stuckCount++;
                    if (stuckCount > 10) {
                        console.warn('[Gravity HiddenPlayer] Stuck — breaking out to try download with partial data');
                        break;
                    }
                } else {
                    stuckCount = 0;
                }

                // Wait for fetch hooks to capture the segment data
                await new Promise(r => setTimeout(r, seekDelay));

                // Check if new data was captured
                const newBytes = totalCapturedBytes - lastCapturedBytes;
                if (newBytes > 0) {
                    lastCapturedBytes = totalCapturedBytes;
                }

                seekPosition += seekStep;
                step++;

                const percent = 5 + (step / totalSteps) * 85;
                const bufferedPercent = (getBufferedDuration(video) / duration * 100).toFixed(0);
                reportProgress('buffering', percent,
                    `Scrubbing: ${Math.min(100, Math.round(seekPosition / duration * 100))}% | ` +
                    `Buffered: ${bufferedPercent}%`);
            }

            // Phase 4: Seek to the end to make sure we get the final segments
            reportProgress('finalizing', 92, 'Capturing final segments...');
            video.currentTime = Math.max(0, duration - 2);
            await new Promise(r => setTimeout(r, 800));

            video.currentTime = duration - 0.5;
            await new Promise(r => setTimeout(r, 500));

            // Phase 5: Restore video state
            reportProgress('restoring', 96, 'Restoring player state...');
            video.currentTime = origTime;
            video.muted = wasMuted;
            video.volume = wasVolume;
            video.playbackRate = origPlaybackRate;
            video.style.opacity = origOpacity;
            video.style.filter = origFilter;

            if (overlayDiv && overlayDiv.parentNode) {
                overlayDiv.parentNode.removeChild(overlayDiv);
            }

            if (wasPaused) {
                video.pause();
            }

            const newCapturedBytes = totalCapturedBytes - startingCapturedBytes;
            const capturedMB = (newCapturedBytes / 1024 / 1024).toFixed(2);
            const bufferedPercent = (getBufferedDuration(video) / duration * 100).toFixed(0);

            console.log(`[Gravity HiddenPlayer] Buffering complete! Captured ${capturedMB}MB, ${bufferedPercent}% buffered`);

            // Phase 6: Auto-download if requested
            if (autoDownload && newCapturedBytes > 50000) {
                reportProgress('downloading', 98, 'Starting download...');
                const result = window.__gravityDownloadCapturedVideo(true);
                reportProgress('complete', 100, result.success ? 'Download started!' : result.error);

                _isAutoBuffering = false;
                return {
                    success: result.success,
                    error: result.error,
                    stats: {
                        capturedMB,
                        bufferedPercent,
                        tracks: capturedTracks.size,
                        filename: result.filename
                    }
                };
            }

            reportProgress('complete', 100, `Buffering complete: ${capturedMB}MB captured`);
            _isAutoBuffering = false;
            return {
                success: true,
                stats: {
                    capturedMB,
                    bufferedPercent,
                    tracks: capturedTracks.size,
                    duration: duration
                }
            };

        } catch (err) {
            console.error('[Gravity HiddenPlayer] Error:', err);

            // Try to restore video state
            try {
                video.currentTime = origTime;
                video.muted = wasMuted;
                video.volume = wasVolume;
                video.playbackRate = origPlaybackRate;
                video.style.opacity = origOpacity;
                video.style.filter = origFilter;

                if (overlayDiv && overlayDiv.parentNode) {
                    overlayDiv.parentNode.removeChild(overlayDiv);
                }

                if (wasPaused) video.pause();
            } catch (e) { }

            _isAutoBuffering = false;
            return { success: false, error: err.message };
        }
    };

    /**
     * Abort an in-progress auto-buffer operation.
     */
    window.__gravityAbortBuffer = function () {
        if (_bufferAbortController) {
            _bufferAbortController.aborted = true;
        }
        _isAutoBuffering = false;
        return { aborted: true };
    };

    /**
     * Check if auto-buffering is currently in progress.
     */
    window.__gravityIsBuffering = function () {
        return _isAutoBuffering;
    };

    // Get summary of captured tracks (no ArrayBuffers - just metadata)
    function getCapturedTracksSummary() {
        const tracks = [];
        for (const [key, track] of capturedTracks) {
            tracks.push({
                key: track.key,
                mimeType: track.mimeType,
                totalSize: track.totalSize,
                segmentCount: track.segmentCount,
                isVideo: track.isVideo,
                isAudio: track.isAudio,
                isClean: !!track.isClean,
            });
        }
        return tracks;
    }

    window.__gravityCapturedTracksSummary = function () {
        return getCapturedTracksSummary();
    };

    // ══════════════════════════════════════════════════════════════════════════
    // ── SABR PROTOBUF STRIPPING ─────────────────────────────────────────────
    // YouTube SABR wraps actual MP4/WebM data in a protobuf envelope.
    // We need to strip that wrapper and extract only the ISO BMFF boxes.
    // ══════════════════════════════════════════════════════════════════════════

    // Known ISO BMFF (MP4) box type FourCCs
    const MP4_BOX_TYPES = new Set([
        'ftyp', 'moov', 'moof', 'mdat', 'styp', 'sidx', 'free', 'skip',
        'mvhd', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'tfhd', 'trun',
        'tfdt', 'edts', 'mdhd', 'hdlr', 'dinf', 'stsd', 'stts', 'stsc',
        'stsz', 'stco', 'sgpd', 'sbgp', 'trex', 'mehd', 'pssh', 'tkhd',
        'elst', 'vmhd', 'smhd', 'dref', 'avc1', 'av01', 'mp4a', 'esds',
        'btrt', 'colr', 'pasp', 'uuid', 'emsg', 'prft'
    ]);

    // WebM/Matroska magic bytes
    const WEBM_MAGIC = [0x1A, 0x45, 0xDF, 0xA3]; // EBML header

    /**
     * Check if 4 bytes at offset look like a valid ASCII FourCC
     */
    function isValidFourCC(view, offset) {
        if (offset + 4 > view.byteLength) return false;
        let cc = '';
        for (let i = 0; i < 4; i++) {
            const c = view.getUint8(offset + i);
            if (c < 0x20 || c > 0x7E) return false; // Not printable ASCII
            cc += String.fromCharCode(c);
        }
        return MP4_BOX_TYPES.has(cc);
    }

    /**
     * Find the offset where actual MP4 data starts in a SABR-wrapped buffer.
     * MP4 boxes have format: [4-byte size][4-byte type FourCC][data...]
     * We scan for the first valid box header.
     */
    function findMP4Start(buffer) {
        const view = new DataView(buffer);
        const len = buffer.byteLength;

        for (let i = 0; i < Math.min(len - 8, 2048); i++) {
            // Check if bytes at i look like a box: [size][fourcc]
            if (i + 8 > len) break;

            const size = view.getUint32(i);
            const fourcc = String.fromCharCode(
                view.getUint8(i + 4), view.getUint8(i + 5),
                view.getUint8(i + 6), view.getUint8(i + 7)
            );

            // Valid box: size > 8, size <= remaining bytes, known FourCC
            if (MP4_BOX_TYPES.has(fourcc) && size >= 8 && size <= (len - i)) {
                return i;
            }

            // Also check for extended size (size == 1, next 8 bytes are real size)
            if (size === 1 && MP4_BOX_TYPES.has(fourcc) && i + 16 <= len) {
                return i;
            }
        }

        return -1; // No MP4 data found
    }

    /**
     * Find WebM/EBML header start
     */
    function findWebMStart(buffer) {
        const view = new Uint8Array(buffer);
        const len = Math.min(view.byteLength, 2048);

        for (let i = 0; i < len - 4; i++) {
            if (view[i] === WEBM_MAGIC[0] && view[i + 1] === WEBM_MAGIC[1] &&
                view[i + 2] === WEBM_MAGIC[2] && view[i + 3] === WEBM_MAGIC[3]) {
                return i;
            }
        }
        return -1;
    }

    /**
     * Extract just the media data from each segment, stripping SABR protobuf wrappers.
     * Returns an array of ArrayBuffers containing only valid media data.
     */
    function extractMediaData(segments, mimeType) {
        const isWebM = mimeType && mimeType.includes('webm');
        const cleanSegments = [];
        let initSegmentFound = false;

        for (let i = 0; i < segments.length; i++) {
            const buffer = segments[i];
            if (!buffer || buffer.byteLength < 8) continue;

            let mediaStart;
            if (isWebM) {
                // For WebM, look for EBML header or Cluster elements
                mediaStart = findWebMStart(buffer);
                if (mediaStart === -1) {
                    // Try finding Cluster element (0x1F 0x43 0xB6 0x75)
                    const view = new Uint8Array(buffer);
                    for (let j = 0; j < Math.min(view.byteLength - 4, 2048); j++) {
                        if (view[j] === 0x1F && view[j + 1] === 0x43 &&
                            view[j + 2] === 0xB6 && view[j + 3] === 0x75) {
                            mediaStart = j;
                            break;
                        }
                    }
                }
            } else {
                // For MP4, look for ISO BMFF boxes
                mediaStart = findMP4Start(buffer);
            }

            if (mediaStart >= 0) {
                const mediaData = buffer.slice(mediaStart);
                if (mediaData.byteLength > 0) {
                    cleanSegments.push(mediaData);

                    if (!initSegmentFound) {
                        const view = new DataView(mediaData);
                        const firstFourCC = String.fromCharCode(
                            view.getUint8(4), view.getUint8(5),
                            view.getUint8(6), view.getUint8(7)
                        );
                        console.log(`[Gravity Early] First segment starts with '${firstFourCC}' box at offset ${mediaStart}`);
                        initSegmentFound = true;
                    }
                }
            } else {
                // No recognizable header found — skip this segment
                console.log(`[Gravity Early] Segment ${i}: no media header found, skipping (${buffer.byteLength} bytes)`);
            }
        }

        return cleanSegments;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ── DOWNLOAD FUNCTION — runs in MAIN world page context ─────────────────
    // Creates a Blob from captured segments (with SABR headers stripped) and
    // triggers download via <a> click. Runs in page context to bypass
    // cross-process blob URL limitations.
    // ══════════════════════════════════════════════════════════════════════════

    window.__gravityDownloadCapturedVideo = function (preferVideo = true) {
        const tracks = getCapturedTracksSummary();
        console.log('[Gravity Early] Download requested. Captured tracks:', tracks);

        if (tracks.length === 0) {
            return { success: false, error: 'No video data captured. Play the video first!' };
        }

        // Separate clean (MSE) tracks from raw (fetch) tracks
        const cleanTracks = tracks.filter(t => t.isClean);
        const rawTracks = tracks.filter(t => !t.isClean);

        console.log(`[Gravity Early] Clean MSE tracks: ${cleanTracks.length}, Raw fetch tracks: ${rawTracks.length}`);

        // Prefer clean MSE tracks — they're already valid media data
        let candidateTracks = cleanTracks.length > 0 ? cleanTracks : rawTracks;

        // Filter by video/audio preference
        const targetTracks = preferVideo
            ? candidateTracks.filter(t => t.isVideo)
            : candidateTracks.filter(t => t.isAudio);

        const allTracks = targetTracks.length > 0 ? targetTracks : candidateTracks;

        if (allTracks.length === 0) {
            return { success: false, error: 'No matching tracks found' };
        }

        // Pick the track with the most data
        const bestTrackInfo = allTracks.reduce((best, track) =>
            track.totalSize > best.totalSize ? track : best
        );

        const bestTrack = capturedTracks.get(bestTrackInfo.key);
        if (!bestTrack || bestTrack.segments.length === 0) {
            return { success: false, error: 'Track data not found' };
        }

        console.log(`[Gravity Early] Downloading track: ${bestTrack.key}, ` +
            `${bestTrack.segmentCount} segments, ${(bestTrack.totalSize / 1024 / 1024).toFixed(2)}MB, ` +
            `clean=${!!bestTrack.isClean}`);

        try {
            let segmentsToUse;

            if (bestTrack.isClean) {
                // MSE data — already clean, use directly
                segmentsToUse = bestTrack.segments;
                console.log(`[Gravity Early] Using ${segmentsToUse.length} clean MSE segments directly`);
            } else {
                // Raw fetch data — needs SABR header stripping
                segmentsToUse = extractMediaData(bestTrack.segments, bestTrack.mimeType);
                if (segmentsToUse.length === 0) {
                    return { success: false, error: 'Could not extract media data from captured segments' };
                }
                console.log(`[Gravity Early] Extracted ${segmentsToUse.length} segments after SABR stripping`);
            }

            const totalSize = segmentsToUse.reduce((sum, s) => sum + s.byteLength, 0);

            // Concatenate into one Blob
            const blob = new Blob(segmentsToUse, { type: bestTrack.mimeType });
            const blobUrl = URL.createObjectURL(blob);

            // Determine filename
            let filename = 'Gravity_video';
            const ytData = extractedVideoData.length > 0 ? extractedVideoData[extractedVideoData.length - 1] : null;
            if (ytData) {
                const safeTitle = (ytData.title || 'video')
                    .replace(/[<>:"/\\|?*]/g, '')
                    .replace(/\s+/g, '_')
                    .slice(0, 80);
                filename = `Gravity_YT_${safeTitle}`;
            }

            // Determine extension from mime type
            let ext = 'mp4';
            if (bestTrack.mimeType.includes('webm')) ext = 'webm';
            else if (bestTrack.mimeType.includes('audio/')) ext = 'm4a';
            else if (bestTrack.mimeType.includes('ogg')) ext = 'ogg';

            // Trigger download via <a> click
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = `${filename}.${ext}`;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();

            // Clean up
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(blobUrl);
            }, 10000);

            return {
                success: true,
                filename: `${filename}.${ext}`,
                size: blob.size,
                segments: segmentsToUse.length,
                mimeType: bestTrack.mimeType
            };
        } catch (e) {
            console.error('[Gravity Early] Download error:', e);
            return { success: false, error: e.message };
        }
    };

    // Also expose debug info
    window.__gravityYouTubeDebug = {
        getRawData: function () {
            return {
                extractedVideoData,
                capturedTracks: getCapturedTracksSummary(),
                totalCapturedBytes,
                ytInitialPlayerResponse: window.ytInitialPlayerResponse,
            };
        }
    };

    // Notify that hooks are ready
    notify('HOOKS_READY', {
        timestamp: Date.now(),
        hooks: {
            mediaSource: !!window.MediaSource,
            sourceBuffer: !!window.SourceBuffer,
            fetch: !!window.fetch,
            xhr: !!window.XMLHttpRequest
        }
    });
    console.log('[Gravity Early] MSE & network hooks installed (with segment capture)');
})();
