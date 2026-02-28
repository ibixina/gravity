console.log('[Gravity UI] Loaded');

// Will inject exactly one UI root
let uiRoot = document.getElementById('gravity-ui-root');

if (!uiRoot) {
    uiRoot = document.createElement('div');
    uiRoot.id = 'gravity-ui-root';
    document.documentElement.appendChild(uiRoot);

    const galleryOverlay = document.createElement('div');
    galleryOverlay.className = 'gravity-gallery-overlay';
    galleryOverlay.id = 'gravity-gallery';

    const header = document.createElement('div');
    header.style.padding = '20px';
    header.style.borderBottom = '4px solid #000';
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.backgroundColor = '#fff';
    header.innerHTML = `<h2>Gravity Gallery</h2> <button id="gravity-close-gallery" style="background: #e4e4e4; border: 2px solid #000; color: #000; cursor: pointer; font-size: 20px; font-weight: bold; padding: 0 8px; box-shadow: 2px 2px 0px #000;">X</button>`;
    galleryOverlay.appendChild(header);

    // Quick container for images
    const grid = document.createElement('div');
    grid.id = 'gravity-grid';
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(150px, 1fr))';
    grid.style.gap = '16px';
    grid.style.padding = '20px';
    grid.style.overflowY = 'auto';
    grid.style.flexGrow = '1';
    galleryOverlay.appendChild(grid);

    uiRoot.appendChild(galleryOverlay);

    // Close event listener
    document.getElementById('gravity-close-gallery').addEventListener('click', () => {
        galleryOverlay.classList.remove('active');
        uiRoot.style.pointerEvents = 'none';
    });
}

// ── In-page toast notifications ───────────────────────────────────────────
// Used for feedback that originates in the content script (blob errors, pick
// mode misses, etc). Also invoked via gravity:toast message from the SW.
const TOAST_COLORS = {
    error: { bg: '#000', text: '#fff', icon: '[!]' },
    success: { bg: '#000', text: '#fff', icon: '[✓]' },
    warning: { bg: '#3a3a00', text: '#fff', icon: '[?]' },
};

function showToast(message, level = 'error') {
    const c = TOAST_COLORS[level] || TOAST_COLORS.error;

    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483647;
        max-width: 320px;
        padding: 12px 16px;
        background: ${c.bg};
        color: ${c.text};
        font-family: 'Courier New', Courier, monospace;
        font-size: 13px;
        font-weight: bold;
        border: 3px solid #fff;
        box-shadow: 4px 4px 0px rgba(255,255,255,0.3);
        display: flex;
        gap: 10px;
        align-items: flex-start;
        line-height: 1.4;
        opacity: 0;
        transform: translateY(12px);
        transition: opacity 0.2s, transform 0.2s;
        pointer-events: none;
    `;
    toast.innerHTML = `<span style="flex-shrink:0">${c.icon}</span><span>${message}</span>`;
    document.documentElement.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    });

    // Auto-dismiss after 4s
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(12px)';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// Expose for the pick-mode handlers and right-click handler
window.__gravityShowToast = showToast;


// ── Right-click overlay bypass ────────────────────────────────────────────
// On contextmenu, we immediately resolve what's under the cursor and cache
// a PLAIN STRING URL in window.__gravityLastRightClickUrl.
// The background script reads this string via executeScript — it must never
// be an object, because chrome.downloads.download only accepts strings.

window.__gravityLastRightClickUrl = null;
window.__gravityLastRightClickPos = { x: 0, y: 0 };

document.addEventListener('contextmenu', async (e) => {
    window.__gravityLastRightClickPos = { x: e.clientX, y: e.clientY };
    window.__gravityLastRightClickUrl = null;

    const bypass = window.GravityOverlayBypass;
    if (!bypass) return;

    const mediaEl = bypass.getMediaUnderCursor(e.clientX, e.clientY);
    if (!mediaEl) return;

    const result = extractUrlFromElement(mediaEl);
    if (!result) return;

    // Simple string URL — store directly
    if (typeof result === 'string') {
        window.__gravityLastRightClickUrl = result;
        return;
    }

    // Blob URL descriptor — CANNOT fetch blob URLs directly as they are 
    // process-scoped and often fail with "Failed to fetch". Instead, rely on
    // the network monitor which has captured the actual segment URLs.
    if (result.type === 'blob' && result.blobUrl) {
        // Store sentinel for network monitor fallback
        // The network monitor has the actual video URLs from fetch/XHR interception
        window.__gravityLastRightClickUrl = `gravity-network-monitor:${result.elementType || 'video'}`;
        return;
    }

    // need-network-monitor: mark the element type so context-menu.js
    // can query the network monitor store instead.
    if (result.type === 'need-network-monitor') {
        // Store a sentinel so context-menu.js knows to fall back to network monitor
        window.__gravityLastRightClickUrl = `gravity-network-monitor:${result.elementType}`;
    }
}, true);



chrome.runtime.onMessage.addListener((request) => {
    // NOTE: Do NOT return true here. None of these handlers call sendResponse,
    // so returning true would tell Chrome to keep the channel open indefinitely,
    // causing "message channel closed before a response was received" errors.

    if (request.type === 'gravity:show-gallery') {
        const gallery = document.getElementById('gravity-gallery');
        gallery.classList.add('active');
        uiRoot.style.pointerEvents = 'auto';
        const media = request.media || [];
        renderGallery(media);

    } else if (request.type === 'gravity:toggle-pick-mode') {
        pickModeActive = !pickModeActive;
        if (pickModeActive) enablePickMode();
        else disablePickMode();

    } else if (request.type === 'gravity:toast') {
        const { level = 'error', message } = request.payload || {};
        showToast(message, level);

    } else if (request.type === 'gravity:download-at-cursor') {
        const { x, y } = request.payload || {};
        const bypass = window.GravityOverlayBypass;
        if (bypass && x != null && y != null) {
            const mediaEl = bypass.getMediaUnderCursor(x, y);
            if (mediaEl) {
                const result = extractUrlFromElement(mediaEl);
                if (result) {
                    triggerDownload(result, `Gravity_context_${Date.now()}`);
                } else {
                    showToast('No downloadable media found here. Try Pick Mode instead.');
                }
            } else {
                showToast('No media found under the cursor. Try hovering directly over the image or video.');
            }
        }
    }
    // Return nothing (undefined) = synchronous, no response expected.
});



// ── Shared URL extractor ─────────────────────────────────────────────────
// Used by both right-click tracking and pick-mode click handler.
// Returns either a URL string or a special descriptor object for complex cases.
function extractUrlFromElement(el) {
    if (!el) return null;
    const tag = el.tagName;

    // ── VIDEO ──────────────────────────────────────────────────────────────
    if (tag === 'VIDEO') {
        return extractVideoUrl(el);
    }

    // ── AUDIO ──────────────────────────────────────────────────────────────
    if (tag === 'AUDIO') {
        return extractAudioUrl(el);
    }

    // ── IMG ────────────────────────────────────────────────────────────────
    if (tag === 'IMG') {
        // Prefer the highest-res srcset URL over src
        const srcset = el.srcset || el.dataset.srcset;
        if (srcset) {
            const parts = srcset.split(',').map(s => s.trim());
            let bestUrl = null, bestW = -1;
            parts.forEach(part => {
                const segs = part.split(/\s+/);
                const url = segs[0];
                const w = parseInt((segs[1] || '1w').replace('w', '')) || 1;
                if (w > bestW) { bestW = w; bestUrl = url; }
            });
            if (bestUrl) return bestUrl;
        }
        // Check common lazy-load attributes
        const lazySrc = el.dataset.src || el.dataset.original || el.dataset.lazySrc
            || el.dataset.fullSrc || el.dataset.originalSrc
            || el.getAttribute('data-full-src') || el.getAttribute('data-zoom-src');
        return el.currentSrc || lazySrc || el.src || null;
    }

    // ── PICTURE ─────────────────────────────────────────────────────────────
    // Return the highest-quality <source> URL from inside the <picture> element,
    // falling back to the inner <img>.
    if (tag === 'PICTURE') {
        // Prefer AVIF > WebP > anything else
        const preferenceOrder = ['image/avif', 'image/webp', ''];
        for (const preferred of preferenceOrder) {
            const sources = el.querySelectorAll('source');
            for (const source of sources) {
                const type = source.getAttribute('type') || '';
                if (!preferred || type === preferred) {
                    const srcset = source.srcset || source.getAttribute('srcset');
                    if (srcset) {
                        const best = srcset.split(',').map(s => s.trim().split(/\s+/)[0]).pop();
                        if (best) return best;
                    }
                    const src = source.src || source.getAttribute('src');
                    if (src) return src;
                }
            }
        }
        // Fall back to inner <img>
        const img = el.querySelector('img');
        if (img) return extractUrlFromElement(img);
        return null;
    }

    // ── SOURCE inside PICTURE ────────────────────────────────────────────────
    if (tag === 'SOURCE' && el.parentElement?.tagName === 'PICTURE') {
        const srcset = el.srcset || el.getAttribute('srcset');
        if (srcset) {
            const best = srcset.split(',').map(s => s.trim().split(/\s+/)[0]).pop();
            if (best) return best;
        }
        return el.src || el.getAttribute('src') || null;
    }

    // ── CANVAS ──────────────────────────────────────────────────────────────
    if (tag === 'CANVAS') {
        try { return el.toDataURL('image/png'); } catch (e) { return null; }
    }

    // ── SVG ─────────────────────────────────────────────────────────────────
    if (tag === 'SVG') {
        try {
            const serializer = new XMLSerializer();
            let src = serializer.serializeToString(el);
            if (!src.includes('xmlns=')) {
                src = src.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
            }
            return 'data:image/svg+xml;charset=utf-8,' +
                encodeURIComponent('<?xml version="1.0" standalone="no"?>\r\n' + src);
        } catch (e) { return null; }
    }

    // ── Custom video player web components ─────────────────────────────────
    // Sites like Reddit (<shreddit-player>), AMP, JW Player, etc. wrap <video>
    // inside shadow DOMs. Try to extract the URL from the component's attributes
    // or by looking into its shadow root.
    {
        const url = extractCustomPlayerUrl(el);
        if (url) return url;
    }

    // ── CSS background-image (any other element) ──────────────────────────
    try {
        const bg = window.getComputedStyle(el).backgroundImage;
        if (bg && bg !== 'none') {
            const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
            if (m && m[1]) return m[1];
        }
    } catch (e) { }

    return null;
}

// ── Extract URL from custom video player elements ─────────────────────────
// Handles <shreddit-player>, <amp-video>, <lite-youtube>, and any element
// that carries video URL information in attributes or shadow DOM.
function extractCustomPlayerUrl(el) {
    if (!el) return null;

    // 1. Check the element's own attributes for video URLs
    const VIDEO_URL_ATTRS = [
        'src', 'data-src', 'data-video-src', 'data-url',
        'data-video-url', 'preview', 'content-href',
        'data-embed-url', 'data-mp4-url', 'data-hls-url',
    ];

    let bestUrl = null;
    let hlsUrl = null;

    for (const attr of VIDEO_URL_ATTRS) {
        const val = el.getAttribute(attr);
        if (!val || val.startsWith('chrome-extension://')) continue;

        // Prefer direct MP4/WebM over HLS manifests
        if (/\.(mp4|webm|mov|m4v|ogv)(\?|$)/i.test(val)) {
            bestUrl = val;
            break;
        }
        if (/\.(m3u8|mpd)(\?|$)/i.test(val) || /HLSPlaylist/i.test(val)) {
            hlsUrl = val;
        }
        // Reddit v.redd.it base URL → construct DASH fallback URL
        if (/v\.redd\.it\/[a-z0-9]+$/i.test(val)) {
            bestUrl = val + '/DASH_720.mp4';
            hlsUrl = hlsUrl || (val + '/HLSPlaylist.m3u8');
        }
    }

    if (bestUrl) return bestUrl;

    // 2. Check <source> children (may be in light DOM even for custom elements)
    const sources = el.querySelectorAll('source');
    for (const source of sources) {
        const srcVal = source.src || source.getAttribute('src') || '';
        const typeVal = source.getAttribute('type') || '';

        if (/\.(mp4|webm|mov)(\?|$)/i.test(srcVal)) return srcVal;
        if (/\.(m3u8|mpd)(\?|$)/i.test(srcVal) || /HLSPlaylist/i.test(srcVal)) {
            hlsUrl = hlsUrl || srcVal;
        }
        if (typeVal.startsWith('video/') && srcVal && !srcVal.startsWith('blob:')) {
            return srcVal;
        }
    }

    // 3. Look inside shadow root for a real <video> element
    const shadowRoot = el.shadowRoot || el.__gravityShadowRoot;
    if (shadowRoot) {
        const innerVideo = shadowRoot.querySelector('video');
        if (innerVideo) {
            const videoResult = extractVideoUrl(innerVideo);
            if (videoResult) return videoResult;
        }
        // Also check for nested custom players
        const nestedPlayer = shadowRoot.querySelector(
            'shreddit-player, media-player, video-player, amp-video'
        );
        if (nestedPlayer && nestedPlayer !== el) {
            return extractCustomPlayerUrl(nestedPlayer);
        }
    }

    // 4. Walk up a few levels to find a parent with content-href or similar
    //    (Reddit's <shreddit-post> has content-href="https://v.redd.it/...")
    let parent = el.parentElement;
    let walkDepth = 0;
    while (parent && walkDepth < 6) {
        const contentHref = parent.getAttribute('content-href');
        if (contentHref && /v\.redd\.it|video|stream|media/i.test(contentHref)) {
            if (/\.(mp4|webm|mov)(\?|$)/i.test(contentHref)) return contentHref;
            // Reddit v.redd.it base → construct download URL
            if (/v\.redd\.it\/[a-z0-9]+$/i.test(contentHref)) {
                return contentHref + '/DASH_720.mp4';
            }
            return contentHref;
        }
        parent = parent.parentElement;
        walkDepth++;
    }

    // 5. If we found an HLS URL, return it as last resort
    if (hlsUrl) return hlsUrl;

    // 6. If nothing found, defer to network monitor
    // Only do this if the element looks like it's genuinely a media player
    if (el.tagName && (el.tagName.includes('PLAYER') ||
        el.tagName.includes('VIDEO') || el.tagName.includes('MEDIA'))) {
        return { type: 'need-network-monitor', elementType: 'video' };
    }

    return null;
}

function extractVideoUrl(video) {
    const currentSrc = video.currentSrc;
    const src = video.src;

    // Best case: browser has already resolved the best source
    if (currentSrc && !currentSrc.startsWith('blob:')) return currentSrc;
    if (src && !src.startsWith('blob:')) return src;

    // Check lazy-load attributes (common on sites that defer video loading)
    const lazySrc = video.dataset.src || video.dataset.lazySrc
        || video.getAttribute('data-video-src') || video.getAttribute('data-src');
    if (lazySrc && !lazySrc.startsWith('blob:')) return lazySrc;

    // Multiple <source> children — prefer by MIME type then resolution hint
    const sources = Array.from(video.querySelectorAll('source'));
    const preferredTypes = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'];
    let best = null;
    let bestSize = -1;

    for (const preferred of preferredTypes) {
        const candidates = sources.filter(s => {
            const t = s.getAttribute('type') || '';
            const u = s.src || s.getAttribute('src') || '';
            return t.startsWith(preferred) && u && !u.startsWith('blob:');
        });
        if (candidates.length === 0) continue;
        // Among matching MIME candidates, pick the one with a size / resolution hint
        for (const s of candidates) {
            const hint = parseInt(s.getAttribute('size') || s.getAttribute('data-res') || '0');
            if (hint > bestSize) { bestSize = hint; best = s; }
        }
        if (!best) best = candidates[0]; // first match if no hint
        break;
    }

    // Fallback: any non-blob source
    if (!best) {
        best = sources.find(s => {
            const u = s.src || s.getAttribute('src') || '';
            return u && !u.startsWith('blob:');
        });
    }

    if (best) return best.src || best.getAttribute('src');

    // All sources are blob: URLs — defer to the network monitor
    const blobUrl = currentSrc || src;
    if (blobUrl && blobUrl.startsWith('blob:')) {
        return { type: 'blob', blobUrl, elementType: 'video' };
    }

    return { type: 'need-network-monitor', elementType: 'video' };
}


function extractAudioUrl(audio) {
    const currentSrc = audio.currentSrc;
    const src = audio.src;

    if (currentSrc && !currentSrc.startsWith('blob:')) return currentSrc;
    if (src && !src.startsWith('blob:')) return src;

    // Check lazy-load attributes
    const lazySrc = audio.dataset.src || audio.getAttribute('data-src') || audio.getAttribute('data-audio-src');
    if (lazySrc && !lazySrc.startsWith('blob:')) return lazySrc;

    // Multiple <source> children — prefer common audio MIME order
    const sources = Array.from(audio.querySelectorAll('source'));
    const preferredTypes = ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/webm', 'audio/aac', 'audio/flac'];
    for (const preferred of preferredTypes) {
        const match = sources.find(s => {
            const t = s.getAttribute('type') || '';
            const u = s.src || s.getAttribute('src') || '';
            return t.startsWith(preferred) && u && !u.startsWith('blob:');
        });
        if (match) return match.src || match.getAttribute('src');
    }
    // Fallback: any non-blob source
    for (const s of sources) {
        const u = s.src || s.getAttribute('src');
        if (u && !u.startsWith('blob:')) return u;
    }

    const blobUrl = currentSrc || src;
    if (blobUrl && blobUrl.startsWith('blob:')) {
        return { type: 'blob', blobUrl, elementType: 'audio' };
    }

    return { type: 'need-network-monitor', elementType: 'audio' };
}

// Handles the result of extractUrlFromElement, including complex descriptors
async function triggerDownload(result, fallbackFilename) {
    if (!result) return;

    // Simple string URL — direct download
    if (typeof result === 'string') {
        if (result.startsWith('chrome-extension://')) return;
        chrome.runtime.sendMessage({
            type: 'gravity:download-request',
            payload: { url: result, filename: fallbackFilename }
        });
        return;
    }

    // Blob URL (MSE player like YouTube) — the blob itself is just a MediaSource
    // handle, not actual video data. Route to the network monitor which has the
    // real CDN segment URLs. The SW will deduplicate + strip range params.
    if (result.type === 'blob' || result.type === 'need-network-monitor') {
        chrome.runtime.sendMessage({
            type: 'gravity:download-network-media',
            payload: { elementType: result.elementType || 'video' }
        }, (response) => {
            // SW will show its own notification on error — nothing extra needed here
            if (chrome.runtime.lastError) {
                showToast('Could not reach the background script. Try reloading the extension.', 'error');
            }
        });
        return;
    }
}




let pickModeActive = false;
let hoveredElement = null;

function enablePickMode() {
    document.body.style.cursor = 'crosshair';
    document.addEventListener('mousemove', handlePickMove, true);
    document.addEventListener('click', handlePickClick, true);

    // Add visual outline container if not exists
    if (!document.getElementById('gravity-pick-highlight')) {
        const highlight = document.createElement('div');
        highlight.id = 'gravity-pick-highlight';
        highlight.style.position = 'fixed';
        highlight.style.pointerEvents = 'none';
        highlight.style.zIndex = '2147483646';
        highlight.style.border = '4px dashed #000';
        highlight.style.backgroundColor = 'rgba(0, 0, 0, 0.1)';
        highlight.style.borderRadius = '0px';
        highlight.style.transition = 'all 0.1s ease';
        highlight.style.display = 'none';

        const label = document.createElement('div');
        label.id = 'gravity-pick-label';
        label.style.position = 'absolute';
        label.style.bottom = '100%';
        label.style.right = '0';
        label.style.backgroundColor = '#000';
        label.style.color = '#fff';
        label.style.padding = '2px 6px';
        label.style.fontSize = '12px';
        label.style.fontWeight = 'bold';
        label.style.border = '4px solid #000';
        label.style.borderBottom = 'none';
        label.textContent = 'Image';
        highlight.appendChild(label);

        document.documentElement.appendChild(highlight);
    }
}

function disablePickMode() {
    pickModeActive = false;
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', handlePickMove, true);
    document.removeEventListener('click', handlePickClick, true);

    const highlight = document.getElementById('gravity-pick-highlight');
    if (highlight) highlight.style.display = 'none';
    hoveredElement = null;
}

function handlePickMove(e) {
    if (!pickModeActive) return;

    // Use OverlayBypass to find actual media
    const mediaEl = window.GravityOverlayBypass ?
        window.GravityOverlayBypass.getMediaUnderCursor(e.clientX, e.clientY) : null;

    const highlight = document.getElementById('gravity-pick-highlight');
    const label = document.getElementById('gravity-pick-label');

    if (mediaEl) {
        hoveredElement = mediaEl;
        const rect = mediaEl.getBoundingClientRect();
        highlight.style.top = rect.top + 'px';
        highlight.style.left = rect.left + 'px';
        highlight.style.width = rect.width + 'px';
        highlight.style.height = rect.height + 'px';
        highlight.style.display = 'block';

        const tagLabels = {
            'IMG': 'IMG', 'VIDEO': 'VIDEO', 'AUDIO': 'AUDIO',
            'SVG': 'SVG', 'CANVAS': 'CANVAS', 'PICTURE': 'IMG',
            'SHREDDIT-PLAYER': 'VIDEO', 'AMP-VIDEO': 'VIDEO',
            'LITE-YOUTUBE': 'VIDEO', 'MEDIA-PLAYER': 'VIDEO',
            'VIDEO-PLAYER': 'VIDEO',
        };
        const tagName = mediaEl.tagName || '';
        // Recognize any element with PLAYER in its tag as VIDEO
        const autoLabel = tagName.includes('PLAYER') ? 'VIDEO' : 'CSS-BG';
        label.textContent = tagLabels[tagName] || autoLabel;
    } else {
        hoveredElement = null;
        highlight.style.display = 'none';
    }
}

function handlePickClick(e) {
    if (!pickModeActive) return;

    // Prevent the click from triggering anything on the page
    e.preventDefault();
    e.stopPropagation();

    if (hoveredElement) {
        const result = extractUrlFromElement(hoveredElement);
        const tag = hoveredElement.tagName.toLowerCase();
        const filename = `Gravity_${tag}_${Date.now()}`;

        if (result) {
            // Flash confirmation, then exit Pick Mode
            const highlight = document.getElementById('gravity-pick-highlight');
            if (highlight) {
                highlight.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
                setTimeout(() => {
                    highlight.style.backgroundColor = 'rgba(0, 0, 0, 0.1)';
                    disablePickMode();
                }, 300);
            }
            triggerDownload(result, filename);
        } else {
            showToast(
                tag === 'video' || tag === 'audio'
                    ? 'Could not extract a URL from this player. Try pressing Play first.'
                    : 'No downloadable media found here. Try a different element.',
                'error'
            );
            disablePickMode();
        }
    } else {
        showToast('Click on a highlighted media element to download it.', 'warning');
    }
}



function renderGallery(mediaItems) {
    const grid = document.getElementById('gravity-grid');
    grid.innerHTML = ''; // Clear existing

    const images = mediaItems.filter(m => m.type === 'image');
    images.forEach(item => {
        const card = document.createElement('div');
        card.style.background = '#ffffff';
        card.style.border = '2px solid #000000';
        card.style.padding = '8px';
        card.style.display = 'flex';
        card.style.flexDirection = 'column';
        card.style.boxShadow = '4px 4px 0px #000000';

        const res = item.width && item.height ? `${item.width}x${item.height}` : 'Unknown';

        card.innerHTML = `
            <div style="height: 120px; overflow: hidden; border: 2px dashed #000; background: #f4f4f0; display: flex; align-items: center; justify-content: center; image-rendering: pixelated;">
                <img src="${item.url}" style="max-width: 100%; max-height: 100%; object-fit: contain;">
            </div>
            <div style="margin-top: 8px; font-size: 12px; font-weight: bold; color: #000; display: flex; justify-content: space-between;">
                <span>${item.subtype.toUpperCase()}</span>
                <span>${res}</span>
            </div>
        `;

        const dlBtn = document.createElement('button');
        dlBtn.textContent = 'DOWNLOAD';
        dlBtn.style.marginTop = '8px';
        dlBtn.style.padding = '6px';
        dlBtn.style.background = '#e4e4e4';
        dlBtn.style.color = '#000';
        dlBtn.style.border = '2px solid #000';
        dlBtn.style.boxShadow = '2px 2px 0px #000';
        dlBtn.style.fontFamily = 'inherit';
        dlBtn.style.fontWeight = 'bold';
        dlBtn.style.cursor = 'pointer';

        dlBtn.onclick = () => {
            chrome.runtime.sendMessage({
                type: 'gravity:download-request',
                payload: { url: item.url, filename: `Gravity_${Date.now()}.png` }
            });
        };

        card.appendChild(dlBtn);
        grid.appendChild(card);
    });
}
