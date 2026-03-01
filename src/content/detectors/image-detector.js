// The ImageDetector module finds standard images: <img>, <picture>, <source>,
// <svg>, <canvas>, CSS backgrounds, video posters, and OG/meta tags.

class ImageDetector {
    constructor(mediaMap) {
        this.mediaMap = mediaMap;
        // Track already-processed elements so repeat scans skip known nodes.
        // WeakSet doesn't prevent GC of removed DOM nodes.
        this._seen = new WeakSet();
        // Track src/srcset values per element so we can re-process on change.
        this._seenSrc = new WeakMap(); // element → last seen src string
    }

    // Tags that can plausibly have a meaningful CSS background-image.
    // Scanning every span/button/input/li/etc is wasteful.
    static CSS_BG_TAGS = new Set([
        'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER',
        'ASIDE', 'FIGURE', 'FIGCAPTION', 'A', 'LI', 'TD', 'TH',
        'SPAN', 'P', 'NAV', 'UL', 'OL', 'PICTURE'
    ]);

    // Custom video player web components that wrap <video> in shadow DOM.
    // Uses the canonical set from OverlayBypass if available (loaded before us),
    // with a fallback to avoid duplication drift.
    static get CUSTOM_PLAYER_TAGS() {
        return window.GravityOverlayBypass?.CUSTOM_PLAYER_TAGS || new Set([
            'SHREDDIT-PLAYER', 'SHREDDIT-ASPECT-RATIO',
            'MEDIA-PLAYER', 'VIDEO-PLAYER', 'BRIGHTCOVE-PLAYER',
            'AMP-VIDEO', 'AMP-YOUTUBE', 'TWITTER-PLAYER',
            'LITE-YOUTUBE', 'LITE-VIMEO', 'JWPLAYER',
        ]);
    }

    scan(root) {
        const shadowWalker = window.GravityShadowDomWalker;

        if (shadowWalker) {
            shadowWalker.walk(root, (node) => {
                this.processNode(node);
            });
        } else {
            // Fallback: plain querySelectorAll
            root.querySelectorAll('*').forEach(node => this.processNode(node));
        }

        // OG/meta/JSON-LD extraction once per scan on the document root
        if (root === document || root === document.documentElement) {
            this.processMetaTags();
        }
    }

    processNode(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return;

        const tag = node.tagName;

        // ── Lazy-load re-check: if src/srcset changed, re-process ───────────
        // Don't rely only on _seen — some sites swap in the real URL later.
        if (this._seen.has(node)) {
            const currentSrcKey = this._getSrcKey(node, tag);
            if (currentSrcKey && this._seenSrc.get(node) !== currentSrcKey) {
                // src changed — re-process this element with updated URL
                this._seenSrc.set(node, currentSrcKey);
                if (tag === 'IMG') this.processImgTag(node, true);
                if (tag === 'SOURCE') this.processSourceTag(node, true);
                if (tag === 'VIDEO') this.processVideoTag(node, true);
            }
            return;
        }
        this._seen.add(node);

        if (tag === 'IMG') {
            this._seenSrc.set(node, this._getSrcKey(node, tag));
            this.processImgTag(node);
        }
        if (tag === 'PICTURE') this.processPictureTag(node);
        if (tag === 'SOURCE') {
            this._seenSrc.set(node, this._getSrcKey(node, tag));
            this.processSourceTag(node);
        }
        if (tag === 'SVG') this.processSVGTag(node);
        if (tag === 'CANVAS') this.processCanvasTag(node);
        if (tag === 'VIDEO') {
            this._seenSrc.set(node, this._getSrcKey(node, tag));
            this.processVideoTag(node);
        }

        // Custom video player web components (Reddit, AMP, etc.)
        if (ImageDetector.CUSTOM_PLAYER_TAGS.has(tag)) {
            this.processCustomPlayerTag(node);
        }

        // PERFORMANCE: only call getComputedStyle on elements that could
        // realistically carry a background-image. Calling it on every DOM
        // node forces style recalculation — very expensive on large pages.
        if (ImageDetector.CSS_BG_TAGS.has(tag)) {
            this.processCSSBackground(node);
        }
    }

    // Returns a compact key representing the current src state of an element,
    // used to detect lazy-load URL swaps.
    _getSrcKey(node, tag) {
        if (tag === 'IMG') {
            return (node.currentSrc || node.src || node.dataset.src || node.srcset || '').slice(0, 200);
        }
        if (tag === 'SOURCE') {
            return (node.src || node.getAttribute('src') || node.srcset || node.getAttribute('srcset') || '').slice(0, 200);
        }
        if (tag === 'VIDEO') {
            return (node.currentSrc || node.src || node.getAttribute('poster') || '').slice(0, 200);
        }
        return '';
    }

    // -----------------------------------------------------------------------
    //  Parse srcset to get highest-res URL
    // -----------------------------------------------------------------------
    parseSrcset(srcsetStr) {
        if (!srcsetStr) return null;
        // srcset format: "url1 1x, url2 2x" or "url1 300w, url2 600w, url3 1200w"
        const parts = srcsetStr.split(',').map(s => s.trim()).filter(Boolean);
        let bestUrl = null;
        let bestDescriptor = -1;

        for (const part of parts) {
            const segments = part.split(/\s+/);
            const url = segments[0];
            if (!url) continue;
            const descriptor = segments[1] || '1x';

            // Parse width (w) or pixel density (x) descriptors
            const widthMatch = descriptor.match(/^(\d+)w$/);
            const densityMatch = descriptor.match(/^([\d.]+)x$/);

            let numericValue = 1;
            if (widthMatch) numericValue = parseInt(widthMatch[1]);
            if (densityMatch) numericValue = parseFloat(densityMatch[1]) * 1000; // weight density vs width

            if (numericValue > bestDescriptor) {
                bestDescriptor = numericValue;
                bestUrl = url;
            }
        }
        return bestUrl;
    }

    extractAllSrcsetUrls(srcsetStr) {
        if (!srcsetStr) return [];
        return srcsetStr.split(',')
            .map(s => s.trim().split(/\s+/)[0])
            .filter(Boolean);
    }

    // -----------------------------------------------------------------------
    //  <img> tags
    // -----------------------------------------------------------------------
    processImgTag(img, forceUpdate = false) {
        // --- Priority order to find the best URL ---
        // 1. srcset (highest quality from the set)
        // 2. currentSrc (browser-selected optimal)
        // 3. dataset lazy-load attributes
        // 4. plain src
        const srcsetUrl = this.parseSrcset(img.srcset || img.dataset.srcset);
        const currentSrc = img.currentSrc;
        const datasetSrc = img.dataset.src
            || img.dataset.original
            || img.dataset.lazySrc
            || img.dataset.fullSrc
            || img.dataset.originalSrc
            || img.dataset.hi_res_src
            || img.getAttribute('data-full-src')
            || img.getAttribute('data-zoom-src');
        const src = img.src;

        const bestUrl = srcsetUrl || currentSrc || datasetSrc || src;
        if (!bestUrl || bestUrl.startsWith('chrome-extension://') || bestUrl === window.location.href) return;

        // Handle Data URIs separately
        if (bestUrl.startsWith('data:image')) {
            const id = this.hashString(bestUrl);
            if (!this.mediaMap.has(id) || forceUpdate) {
                this.mediaMap.set(id, {
                    id,
                    type: 'image',
                    subtype: 'data-uri',
                    url: bestUrl,
                    width: img.naturalWidth || img.width || 0,
                    height: img.naturalHeight || img.height || 0,
                    alt: img.alt || 'Image',
                    element: img
                });
            }
            return;
        }

        // Skip 1x1 tracking pixels
        if ((img.naturalWidth <= 2 && img.naturalHeight <= 2) ||
            (img.width <= 2 && img.height <= 2)) return;

        const id = this.normalizeUrl(bestUrl);
        if (!this.mediaMap.has(id) || forceUpdate) {
            const isAnimated = this._isAnimatedFormat(bestUrl);
            this.mediaMap.set(id, {
                id,
                type: isAnimated ? 'video' : 'image',
                subtype: isAnimated ? 'gif' : 'img',
                url: bestUrl,
                // Also store all srcset variants for user to pick from
                srcsetVariants: this.extractAllSrcsetUrls(img.srcset || img.dataset.srcset),
                width: img.naturalWidth || img.width || 0,
                height: img.naturalHeight || img.height || 0,
                alt: img.alt || img.title || 'Image',
                mimeHint: isAnimated ? 'image/gif' : null,
                element: img
            });
        }
    }

    // -----------------------------------------------------------------------
    //  <picture> container — scan its <source> children for AVIF/WebP variants
    // -----------------------------------------------------------------------
    processPictureTag(picture) {
        // processImgTag will handle the inner <img>; here we handle <source>
        // children to extract high-quality AVIF/WebP versions.
        const sources = picture.querySelectorAll('source');
        sources.forEach(source => {
            if (!this._seen.has(source)) {
                this._seen.add(source);
                this._seenSrc.set(source, this._getSrcKey(source, 'SOURCE'));
                this.processSourceTag(source);
            }
        });
    }

    // -----------------------------------------------------------------------
    //  <source> tags (inside <picture>)
    // -----------------------------------------------------------------------
    processSourceTag(source, forceUpdate = false) {
        // Only process <source> elements that are children of <picture>
        const parent = source.parentElement;
        if (!parent || parent.tagName !== 'PICTURE') return;

        const type = source.getAttribute('type') || '';
        // Skip non-image source types (e.g. <video><source>)
        if (type && !type.startsWith('image/')) return;

        const srcsetStr = source.srcset || source.getAttribute('srcset') || '';
        const srcStr = source.src || source.getAttribute('src') || '';
        const bestUrl = this.parseSrcset(srcsetStr) || srcStr;

        if (!bestUrl || bestUrl.startsWith('chrome-extension://')) return;

        const id = this.normalizeUrl(bestUrl);
        if (!this.mediaMap.has(id) || forceUpdate) {
            // Get dimensions from the sibling <img> or the <picture> itself
            const siblingImg = parent.querySelector('img');
            const width = siblingImg?.naturalWidth || siblingImg?.width || 0;
            const height = siblingImg?.naturalHeight || siblingImg?.height || 0;

            // Determine format label
            let formatLabel = 'img';
            if (type.includes('avif')) formatLabel = 'avif';
            else if (type.includes('webp')) formatLabel = 'webp';

            this.mediaMap.set(id, {
                id,
                type: 'image',
                subtype: formatLabel,
                url: bestUrl,
                srcsetVariants: this.extractAllSrcsetUrls(srcsetStr),
                width,
                height,
                alt: siblingImg?.alt || 'Image',
                mimeHint: type || null,
                element: source
            });
        }
    }

    // -----------------------------------------------------------------------
    //  <video> — extract poster image AND blob URL / direct src
    // -----------------------------------------------------------------------
    processVideoTag(video, forceUpdate = false) {
        // Extract poster image
        const poster = video.getAttribute('poster');
        if (poster && !poster.startsWith('chrome-extension://')) {
            const posterId = this.normalizeUrl(poster);
            if (!this.mediaMap.has(posterId)) {
                this.mediaMap.set(posterId, {
                    id: posterId,
                    type: 'image',
                    subtype: 'video-poster',
                    url: poster,
                    width: video.videoWidth || video.offsetWidth || 0,
                    height: video.videoHeight || video.offsetHeight || 0,
                    alt: 'Video Poster',
                    element: video
                });
            }
        }

        // Also try to capture a non-blob direct src
        const currentSrc = video.currentSrc;
        const src = video.src;
        const directSrc = (currentSrc && !currentSrc.startsWith('blob:')) ? currentSrc
            : (src && !src.startsWith('blob:')) ? src
                : null;

        if (directSrc) {
            const id = this.normalizeUrl(directSrc);
            if (!this.mediaMap.has(id) || forceUpdate) {
                this.mediaMap.set(id, {
                    id,
                    type: 'video',
                    subtype: 'video',
                    url: directSrc,
                    width: video.videoWidth || video.offsetWidth || 0,
                    height: video.videoHeight || video.offsetHeight || 0,
                    alt: 'Video',
                    element: video
                });
            }
        }
    }

    // -----------------------------------------------------------------------
    //  Custom video player web components (Reddit, AMP, etc.)
    //  Extract poster images and video URLs from their attributes.
    // -----------------------------------------------------------------------
    processCustomPlayerTag(el) {
        // Extract poster / thumbnail image
        const poster = el.getAttribute('poster');
        if (poster && !poster.startsWith('chrome-extension://')) {
            const posterId = this.normalizeUrl(poster);
            if (!this.mediaMap.has(posterId)) {
                this.mediaMap.set(posterId, {
                    id: posterId,
                    type: 'image',
                    subtype: 'video-poster',
                    url: poster,
                    width: el.offsetWidth || 0,
                    height: el.offsetHeight || 0,
                    alt: 'Video Poster',
                    element: el
                });
            }
        }

        // Extract video URL from various attributes
        const VIDEO_ATTRS = ['src', 'data-src', 'preview', 'content-href',
            'data-video-src', 'data-url', 'data-mp4-url'];

        for (const attr of VIDEO_ATTRS) {
            const val = el.getAttribute(attr);
            if (!val || val.startsWith('chrome-extension://') || val.startsWith('blob:')) continue;

            // Only add if it looks like a video URL
            const isVideoUrl = /\.(mp4|webm|mov|m4v|ogv|m3u8|mpd)(\?|$)/i.test(val)
                || /v\.redd\.it|video|stream|HLSPlaylist/i.test(val)
                || /CMAF_|DASH_/i.test(val);
            if (!isVideoUrl) continue;

            // Prefer direct MP4 over HLS
            const isDirectVideo = /\.(mp4|webm|mov)(\?|$)/i.test(val) || /CMAF_|DASH_/i.test(val);
            const id = this.normalizeUrl(val);
            if (!this.mediaMap.has(id)) {
                this.mediaMap.set(id, {
                    id,
                    type: 'video',
                    subtype: isDirectVideo ? 'video' : 'hls',
                    url: val,
                    width: el.offsetWidth || 0,
                    height: el.offsetHeight || 0,
                    alt: 'Video',
                    element: el
                });
            }
        }

        // Reddit-specific: if we have a v.redd.it base URL, construct DASH URLs
        const contentHref = el.getAttribute('content-href')
            || el.closest?.('[content-href]')?.getAttribute('content-href');
        if (contentHref && /v\.redd\.it\/[a-z0-9]+$/i.test(contentHref)) {
            const qualityLevels = ['DASH_1080.mp4', 'DASH_720.mp4', 'DASH_480.mp4', 'DASH_360.mp4'];
            for (const q of qualityLevels) {
                const dashUrl = contentHref + '/' + q;
                const id = this.normalizeUrl(dashUrl);
                if (!this.mediaMap.has(id)) {
                    this.mediaMap.set(id, {
                        id,
                        type: 'video',
                        subtype: 'video',
                        url: dashUrl,
                        width: el.offsetWidth || 0,
                        height: el.offsetHeight || 0,
                        alt: `Video ${q.replace('DASH_', '').replace('.mp4', 'p')}`,
                        element: el
                    });
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    //  SVG
    // -----------------------------------------------------------------------
    processSVGTag(svg) {
        // Skip tiny inline SVG icons (< 32x32)
        const rect = svg.getBoundingClientRect();
        if (rect.width < 32 && rect.height < 32) return;

        // Skip elements that are clearly icons/decorative
        if (svg.getAttribute('aria-hidden') === 'true') return;
        const role = svg.getAttribute('role');
        if (role === 'presentation' || role === 'none') return;

        try {
            const serializer = new XMLSerializer();
            let source = serializer.serializeToString(svg);

            if (!source.match(/^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)) {
                source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
            }

            const xmlHeader = '<?xml version="1.0" standalone="no"?>\r\n';
            const blobUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xmlHeader + source);
            const id = this.hashString(source);

            if (!this.mediaMap.has(id)) {
                this.mediaMap.set(id, {
                    id,
                    type: 'image',
                    subtype: 'svg',
                    url: blobUrl,
                    width: rect.width || 0,
                    height: rect.height || 0,
                    alt: svg.getAttribute('aria-label') || 'SVG Image',
                    element: svg
                });
            }
        } catch (e) {
            console.warn('[Gravity] Failed to serialize SVG', e);
        }
    }

    // -----------------------------------------------------------------------
    //  Canvas
    // -----------------------------------------------------------------------
    processCanvasTag(canvas) {
        // Skip tiny (likely tracking pixels or icon canvases)
        if (canvas.width < 32 || canvas.height < 32) return;
        try {
            const dataUrl = canvas.toDataURL('image/png');
            // Skip blank/white canvases — first 50 chars of a blank canvas are predictable
            if (dataUrl.length < 1000) return;
            const id = this.hashString(dataUrl.substring(0, 200));
            if (!this.mediaMap.has(id)) {
                this.mediaMap.set(id, {
                    id,
                    type: 'image',
                    subtype: 'canvas',
                    url: dataUrl,
                    width: canvas.width || 0,
                    height: canvas.height || 0,
                    alt: 'Canvas Graphic',
                    element: canvas
                });
            }
        } catch (e) {
            // Silently skip tainted canvases (cross-origin images)
        }
    }

    // -----------------------------------------------------------------------
    //  CSS background-image
    // -----------------------------------------------------------------------
    processCSSBackground(node) {
        try {
            const style = window.getComputedStyle(node);
            const bg = style.backgroundImage;
            if (!bg || bg === 'none' || !bg.includes('url(')) return;

            const urls = bg.match(/url\(["']?([^"')]+)["']?\)/g);
            if (!urls) return;

            urls.forEach(urlMatch => {
                // Strip the url() wrapper
                let extractedUrl = urlMatch.slice(4, -1).replace(/^['"]|['"]$/g, '');
                if (!extractedUrl || extractedUrl.startsWith('chrome-extension://')) return;
                // Skip data:image/svg (usually icons/gradients)
                if (extractedUrl.startsWith('data:image/svg')) return;

                const id = this.normalizeUrl(extractedUrl);
                const rect = node.getBoundingClientRect();
                // Skip very small backgrounds (likely gradients/patterns, not real images)
                if (rect.width < 32 || rect.height < 32) return;

                if (!this.mediaMap.has(id)) {
                    this.mediaMap.set(id, {
                        id,
                        type: 'image',
                        subtype: 'css-bg',
                        url: extractedUrl,
                        width: rect.width || 0,
                        height: rect.height || 0,
                        alt: 'CSS Background',
                        element: node
                    });
                }
            });
        } catch (e) {
            // Ignore
        }
    }

    // -----------------------------------------------------------------------
    //  OG / meta / preload / JSON-LD extraction
    //  Called once per full-page scan — reads <head> meta tags.
    // -----------------------------------------------------------------------
    processMetaTags() {
        try {
            // ── Open Graph ──────────────────────────────────────────────────
            const ogImage = document.querySelector('meta[property="og:image"]')?.content
                || document.querySelector('meta[name="og:image"]')?.content;
            const ogVideo = document.querySelector('meta[property="og:video"]')?.content
                || document.querySelector('meta[property="og:video:url"]')?.content;
            const twitterImage = document.querySelector('meta[name="twitter:image"]')?.content
                || document.querySelector('meta[name="twitter:image:src"]')?.content;

            for (const url of [ogImage, twitterImage]) {
                if (url && !url.startsWith('chrome-extension://')) {
                    const id = this.normalizeUrl(url);
                    if (!this.mediaMap.has(id)) {
                        this.mediaMap.set(id, {
                            id,
                            type: 'image',
                            subtype: 'meta-og',
                            url,
                            width: 0,
                            height: 0,
                            alt: document.title || 'OG Image',
                            element: null
                        });
                    }
                }
            }

            if (ogVideo && !ogVideo.startsWith('chrome-extension://')) {
                const id = this.normalizeUrl(ogVideo);
                if (!this.mediaMap.has(id)) {
                    this.mediaMap.set(id, {
                        id,
                        type: 'video',
                        subtype: 'meta-og',
                        url: ogVideo,
                        width: 0,
                        height: 0,
                        alt: document.title || 'OG Video',
                        element: null
                    });
                }
            }

            // ── <link rel="preload" as="image"> ─────────────────────────────
            document.querySelectorAll('link[rel="preload"][as="image"]').forEach(link => {
                const url = link.href || link.getAttribute('imagesrcset');
                if (!url || url.startsWith('chrome-extension://')) return;
                const bestUrl = link.getAttribute('imagesrcset')
                    ? this.parseSrcset(link.getAttribute('imagesrcset'))
                    : url;
                if (!bestUrl) return;
                const id = this.normalizeUrl(bestUrl);
                if (!this.mediaMap.has(id)) {
                    this.mediaMap.set(id, {
                        id,
                        type: 'image',
                        subtype: 'preload',
                        url: bestUrl,
                        width: 0,
                        height: 0,
                        alt: 'Preloaded Image',
                        element: null
                    });
                }
            });

            // ── JSON-LD structured data ──────────────────────────────────────
            document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
                try {
                    const data = JSON.parse(script.textContent);
                    const items = Array.isArray(data) ? data : [data];
                    items.forEach(item => this._extractJsonLdMedia(item));
                } catch (e) { /* malformed JSON-LD — skip */ }
            });

        } catch (e) {
            console.warn('[Gravity] Meta tag extraction error', e);
        }
    }

    _extractJsonLdMedia(item, depth = 0) {
        if (!item || typeof item !== 'object' || depth > 4) return;

        // Common JSON-LD image fields
        const imageFields = ['image', 'thumbnail', 'thumbnailUrl', 'photo', 'logo'];
        const videoFields = ['video', 'contentUrl', 'embedUrl'];

        for (const field of imageFields) {
            const val = item[field];
            if (!val) continue;
            const url = typeof val === 'string' ? val : (val.url || val.contentUrl);
            if (url && typeof url === 'string' && url.startsWith('http')) {
                const id = this.normalizeUrl(url);
                if (!this.mediaMap.has(id)) {
                    this.mediaMap.set(id, {
                        id,
                        type: 'image',
                        subtype: 'structured-data',
                        url,
                        width: val.width || 0,
                        height: val.height || 0,
                        alt: item.name || item.headline || 'Structured Data Image',
                        element: null
                    });
                }
            }
        }

        for (const field of videoFields) {
            const val = item[field];
            if (!val) continue;
            const url = typeof val === 'string' ? val : (val.contentUrl || val.url);
            if (url && typeof url === 'string' && url.startsWith('http')) {
                const id = this.normalizeUrl(url);
                if (!this.mediaMap.has(id)) {
                    this.mediaMap.set(id, {
                        id,
                        type: 'video',
                        subtype: 'structured-data',
                        url,
                        width: 0,
                        height: 0,
                        alt: item.name || 'Structured Data Video',
                        element: null
                    });
                }
            }
        }

        // Recurse into nested objects
        for (const key of Object.keys(item)) {
            if (typeof item[key] === 'object') {
                this._extractJsonLdMedia(item[key], depth + 1);
            }
        }
    }

    // -----------------------------------------------------------------------
    //  Detect animated formats (GIF, APNG, WebP animated) by URL pattern
    // -----------------------------------------------------------------------
    _isAnimatedFormat(url) {
        if (!url) return false;
        return /\.gif(\?|$)/i.test(url) ||
            /\.apng(\?|$)/i.test(url) ||
            // Some CDNs serve animated content with explicit params
            /[?&]format=gif/i.test(url) ||
            /[?&]fm=gif/i.test(url);
    }

    // -----------------------------------------------------------------------
    //  Utilities
    // -----------------------------------------------------------------------
    normalizeUrl(url) {
        try {
            const u = new URL(url, window.location.href); // Resolve relative URLs too
            return u.toString();
        } catch {
            return url;
        }
    }

    hashString(str) {
        let hash = 0;
        for (let i = 0, len = Math.min(str.length, 500); i < len; i++) {
            let chr = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0;
        }
        return hash.toString();
    }
}

window.GravityImageDetector = ImageDetector;
