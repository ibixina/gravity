// Overlay Bypass — loaded as a plain script (no export keyword)

class OverlayBypass {
    // ── Common custom video player tag names across popular sites ──────────
    // These web components wrap a <video> inside their shadow DOM.
    static CUSTOM_PLAYER_TAGS = new Set([
        'SHREDDIT-PLAYER',      // Reddit
        'SHREDDIT-ASPECT-RATIO',// Reddit wrapper
        'MEDIA-PLAYER',         // Generic
        'VIDEO-PLAYER',         // Generic
        'BRIGHTCOVE-PLAYER',    // Brightcove
        'JWPLAYER',             // JW Player
        'AMP-VIDEO',            // AMP
        'AMP-YOUTUBE',          // AMP
        'TWITTER-PLAYER',       // Twitter
        'LITE-YOUTUBE',         // lite-youtube-embed
        'LITE-VIMEO',           // lite-vimeo-embed
    ]);

    // ── URL-like attributes that custom players often use ──────────────────
    static MEDIA_URL_ATTRS = [
        'src', 'data-src', 'data-video-src', 'data-url',
        'data-video-url', 'poster', 'content-href',
        'data-embed-url', 'data-mp4-url', 'data-hls-url',
    ];

    /**
     * Uses elementsFromPoint to find the deepest media element under the cursor,
     * bypassing any transparent divs or pointer-events blocking layers.
     * Handles standard media tags, custom video players, shadow DOMs, and CSS bgs.
     */
    static getMediaUnderCursor(x, y) {
        console.log(`[Gravity Selection] Probing elements at (${x}, ${y})`);
        const elements = document.elementsFromPoint(x, y);
        console.log(`[Gravity Selection] Found ${elements.length} elements under cursor`);

        for (const el of elements) {
            // ── Standard media elements ───────────────────────────────────
            if (el.tagName === 'IMG' || el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
                console.log(`[Gravity Selection] Found standard media tag: <${el.tagName}>`, el);
                return el;
            }

            // <source> inside <picture> — return the parent picture
            if (el.tagName === 'SOURCE' && el.parentElement?.tagName === 'PICTURE') {
                return el.parentElement;
            }

            // <picture> element directly
            if (el.tagName === 'PICTURE') return el;

            // Canvas
            if (el.tagName === 'CANVAS') return el;

            // SVG (including children of SVG — walk up to the root)
            if (el.tagName === 'SVG') return el;
            const svgRoot = el.closest('svg');
            if (svgRoot) return svgRoot;

            // ── Custom video player elements ──────────────────────────────
            // Sites like Reddit, Twitter, AMP wrap <video> inside custom
            // web components with shadow DOMs. Recognize them by tag name.
            if (OverlayBypass.CUSTOM_PLAYER_TAGS.has(el.tagName)) {
                console.log(`[Gravity Selection] Found custom player tag: <${el.tagName}>`, el);
                return el;
            }

            // ── Check shadow DOM for <video>/<audio> ──────────────────────
            // Even if we don't recognize the tag, check for a shadow root
            // that contains media elements.
            const shadowRoot = el.shadowRoot || el.__gravityShadowRoot;
            if (shadowRoot) {
                const shadowMedia = shadowRoot.querySelector('video, audio, img');
                if (shadowMedia) return shadowMedia;
            }

            // ── CSS background-image ──────────────────────────────────────
            try {
                const style = window.getComputedStyle(el);
                if (style.backgroundImage && style.backgroundImage !== 'none' &&
                    style.backgroundImage !== 'initial') {
                    return el;
                }
            } catch { }
        }

        // ── Second pass: walk up the DOM looking for media ────────────────
        // Covers cases like a <figure> wrapping a <video>, or a custom player
        // component wrapping everything in nested divs.
        if (elements.length > 0) {
            let ancestor = elements[0];
            let depth = 0;
            while (ancestor && depth < 10) {
                // Check if this ancestor IS a custom player
                if (OverlayBypass.CUSTOM_PLAYER_TAGS.has(ancestor.tagName)) {
                    return ancestor;
                }

                // Check for a media URL attribute (content-href, data-src, etc.)
                if (OverlayBypass._hasMediaUrlAttr(ancestor)) {
                    return ancestor;
                }

                // Check direct children and shadow root for media
                const directMedia = ancestor.querySelector('video, audio, img[src], picture');
                if (directMedia) return directMedia;

                const shadowRoot = ancestor.shadowRoot || ancestor.__gravityShadowRoot;
                if (shadowRoot) {
                    const shadowMedia = shadowRoot.querySelector('video, audio, img[src], picture');
                    if (shadowMedia) return shadowMedia;
                    // Also check for nested custom players inside shadow DOM
                    for (const tag of OverlayBypass.CUSTOM_PLAYER_TAGS) {
                        const nested = shadowRoot.querySelector(tag.toLowerCase());
                        if (nested) return nested;
                    }
                }

                ancestor = ancestor.parentElement;
                depth++;
            }
        }

        console.warn(`[Gravity Selection] No media found at (${x}, ${y}) after probing ${elements.length} elements and ancestors.`);
        return null;
    }

    /**
     * Checks whether an element has any attribute that looks like a media URL.
     */
    static _hasMediaUrlAttr(el) {
        for (const attr of OverlayBypass.MEDIA_URL_ATTRS) {
            const val = el.getAttribute(attr);
            if (val && (val.startsWith('http') || val.startsWith('//') || val.startsWith('blob:'))) {
                // Quick sanity check: does it look like a media URL?
                if (/\.(mp4|webm|mov|m3u8|mpd|m4v|ogg|ts|m4s)/i.test(val) ||
                    /v\.redd\.it|video|stream|media|cdn/i.test(val)) {
                    console.log(`[Gravity Selection] Matched media URL in attribute [${attr}]:`, val);
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Temporarily disables pointer events on a masking element
     * to allow interaction with the element underneath.
     */
    static pierceOverlay(overlayElement) {
        const originalPointerEvents = overlayElement.style.pointerEvents;
        overlayElement.style.pointerEvents = 'none';

        return () => {
            overlayElement.style.pointerEvents = originalPointerEvents;
        };
    }
}

window.GravityOverlayBypass = OverlayBypass;
