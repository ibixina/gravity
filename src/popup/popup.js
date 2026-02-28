document.addEventListener('DOMContentLoaded', async () => {
    const btnPickMode = document.getElementById('btn-pick-mode');
    const optionsLink = document.getElementById('options-link');
    const mediaCounts = document.getElementById('media-counts');
    const noMediaMsg = document.getElementById('no-media-msg');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isWebPage = tab && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://');

    // ── Pick Mode ─────────────────────────────────────────────────────────────
    btnPickMode.addEventListener('click', () => {
        if (!isWebPage) return;
        chrome.tabs.sendMessage(tab.id, { type: 'gravity:toggle-pick-mode' });
        window.close();
    });

    // ── Settings ──────────────────────────────────────────────────────────────
    optionsLink.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.openOptionsPage();
    });

    if (!isWebPage) return;

    // ── Fetch data ─────────────────────────────────────────────────────────────
    const tabMedia = await chrome.runtime.sendMessage({
        type: 'gravity:get-tab-media',
        payload: { tabId: tab.id }
    }).catch(() => null);

    let segmentsInfo = null;
    try {
        segmentsInfo = await chrome.runtime.sendMessage({
            type: 'gravity:get-segments',
            payload: { tabId: tab.id }
        });
    } catch (e) { /* sw not ready */ }

    const { video = [], audio = [], hls = [], dash = [], image = [] } = tabMedia || {};
    const allStreams = [...hls, ...dash];
    const hasYouTubeData = segmentsInfo?.youtubeData?.hasData;

    let sectionsAdded = 0;

    // ── YouTube ───────────────────────────────────────────────────────────────
    if (hasYouTubeData) {
        const ytVideo = segmentsInfo.youtubeData.videos[0];
        const needsPlayback = segmentsInfo.youtubeData.needsPlayback;
        const ytSection = document.createElement('div');
        ytSection.className = 'media-section youtube-section';

        const statusHtml = needsPlayback
            ? `<div class="yt-hint">▶ Play &amp; let it buffer, then download</div>`
            : `<div class="yt-hint ok">✓ ${ytVideo.totalCaptured} captured (${ytVideo.segments} segs)</div>`;

        ytSection.innerHTML = `
            <div class="section-header static">
                <span class="sec-icon">📺</span>
                <span class="sec-label">YouTube: ${escHtml((ytVideo.title || 'Video').slice(0, 28))}${(ytVideo.title || '').length > 28 ? '…' : ''}</span>
            </div>
            ${statusHtml}
            <button id="btn-dl-youtube" class="action-btn${needsPlayback ? ' muted' : ' red'}">
                ${needsPlayback ? '▶ PLAY VIDEO FIRST' : 'DOWNLOAD VIDEO'}
            </button>
        `;
        mediaCounts.appendChild(ytSection);
        sectionsAdded++;

        document.getElementById('btn-dl-youtube').addEventListener('click', async () => {
            const btn = document.getElementById('btn-dl-youtube');
            btn.textContent = 'BUFFERING 0%…';
            btn.disabled = true;

            const progressListener = (req) => {
                if (req.type === 'gravity:buffer-progress' && req.payload) {
                    const { percent, capturedMB } = req.payload;
                    btn.textContent = `BUFFERING ${percent}% (${capturedMB}MB)`;
                    if (percent >= 100) btn.textContent = 'BUFFERING COMPLETE…';
                }
            };
            chrome.runtime.onMessage.addListener(progressListener);

            try {
                const result = await chrome.runtime.sendMessage({
                    type: 'gravity:download-segments',
                    payload: { tabId: tab.id }
                });
                if (result?.success) {
                    btn.textContent = '✓ DOWNLOAD STARTED';
                    btn.className = 'action-btn green';
                    setTimeout(() => window.close(), 1500);
                } else {
                    btn.textContent = result?.error || 'FAILED – TRY AGAIN';
                    btn.className = 'action-btn red';
                    btn.disabled = false;
                }
            } catch (err) {
                btn.textContent = 'ERROR: ' + err.message;
                btn.disabled = false;
            } finally {
                chrome.runtime.onMessage.removeListener(progressListener);
            }
        });
    }

    // ── Captured MediaSource streams (non-YouTube) ────────────────────────────
    if (segmentsInfo?.sources?.length > 0 && !hasYouTubeData) {
        buildCollapsibleSection({
            container: mediaCounts,
            icon: '📹',
            label: `${segmentsInfo.sources.length} stream${segmentsInfo.sources.length > 1 ? 's' : ''} captured`,
            items: segmentsInfo.sources,
            getLabel: (s) => shortenUrl(s.url || ''),
            getMeta: (s) => s.size ? fmtBytes(s.size) : '',
            onDownload: async (s, btn) => {
                btn.textContent = '…';
                await chrome.runtime.sendMessage({
                    type: 'gravity:download-segments',
                    payload: { tabId: tab.id }
                });
                btn.textContent = '✓';
                setTimeout(() => window.close(), 800);
            },
            onDownloadAll: async (btn) => {
                btn.textContent = 'DOWNLOADING…';
                btn.disabled = true;
                const result = await chrome.runtime.sendMessage({
                    type: 'gravity:download-segments',
                    payload: { tabId: tab.id }
                });
                if (result?.success) {
                    btn.textContent = '✓ DONE';
                    setTimeout(() => window.close(), 800);
                } else {
                    btn.textContent = result?.error || 'TRY AGAIN';
                    btn.disabled = false;
                }
            },
            downloadAllLabel: 'DOWNLOAD CAPTURED VIDEO',
            hint: 'Play the video first to capture segments'
        });
        sectionsAdded++;
    }

    // ── Videos ────────────────────────────────────────────────────────────────
    if (video.length > 0 && !hasYouTubeData) {
        const sorted = [...video].sort((a, b) => (b.size || 0) - (a.size || 0));
        buildCollapsibleSection({
            container: mediaCounts,
            icon: '🎬',
            label: `${video.length} video${video.length > 1 ? 's' : ''} detected`,
            items: sorted,
            getLabel: (v) => shortenUrl(v.url),
            getMeta: (v) => [v.contentType?.replace('video/', '') || '', v.size ? fmtBytes(v.size) : ''].filter(Boolean).join(' · '),
            onDownload: (v, btn) => {
                btn.textContent = '…';
                const ext = mimeToExt(v.contentType) || 'mp4';
                const name = inferName(v.url, ext);
                chrome.runtime.sendMessage({
                    type: 'gravity:download-request',
                    payload: { url: v.url, filename: name }
                });
                btn.textContent = '✓';
                setTimeout(() => window.close(), 600);
            },
            onDownloadAll: (btn) => {
                const best = sorted[0];
                btn.textContent = 'DOWNLOADING…';
                const ext = mimeToExt(best.contentType) || 'mp4';
                chrome.runtime.sendMessage({
                    type: 'gravity:download-request',
                    payload: { url: best.url, filename: inferName(best.url, ext) }
                });
                setTimeout(() => window.close(), 600);
            },
            downloadAllLabel: 'DOWNLOAD BEST VIDEO'
        });
        sectionsAdded++;
    }

    // ── Audio ──────────────────────────────────────────────────────────────────
    if (audio.length > 0) {
        const sorted = [...audio].sort((a, b) => (b.size || 0) - (a.size || 0));
        buildCollapsibleSection({
            container: mediaCounts,
            icon: '🔊',
            label: `${audio.length} audio file${audio.length > 1 ? 's' : ''} detected`,
            items: sorted,
            getLabel: (a) => shortenUrl(a.url),
            getMeta: (a) => [a.contentType?.replace('audio/', '') || '', a.size ? fmtBytes(a.size) : ''].filter(Boolean).join(' · '),
            onDownload: (a, btn) => {
                btn.textContent = '…';
                const ext = mimeToExt(a.contentType) || 'mp3';
                chrome.runtime.sendMessage({
                    type: 'gravity:download-request',
                    payload: { url: a.url, filename: inferName(a.url, ext) }
                });
                btn.textContent = '✓';
                setTimeout(() => window.close(), 600);
            },
            onDownloadAll: (btn) => {
                const best = sorted[0];
                btn.textContent = 'DOWNLOADING…';
                const ext = mimeToExt(best.contentType) || 'mp3';
                chrome.runtime.sendMessage({
                    type: 'gravity:download-request',
                    payload: { url: best.url, filename: inferName(best.url, ext) }
                });
                setTimeout(() => window.close(), 600);
            },
            downloadAllLabel: 'DOWNLOAD BEST AUDIO'
        });
        sectionsAdded++;
    }

    // ── Streams (HLS / DASH) ──────────────────────────────────────────────────
    if (allStreams.length > 0) {
        buildCollapsibleSection({
            container: mediaCounts,
            icon: '📡',
            label: `${allStreams.length} stream${allStreams.length > 1 ? 's' : ''} detected`,
            items: allStreams,
            getLabel: (s) => shortenUrl(s.url),
            getMeta: (s) => s.contentType || '',
            onDownload: async (s, btn) => {
                await navigator.clipboard.writeText(s.url);
                btn.textContent = 'COPIED!';
                setTimeout(() => { btn.textContent = 'COPY URL'; }, 1400);
            },
            onDownloadAll: async (btn) => {
                const best = allStreams[allStreams.length - 1];
                await navigator.clipboard.writeText(best.url);
                btn.textContent = 'COPIED!';
                setTimeout(() => { btn.textContent = 'COPY BEST URL'; }, 1500);
            },
            downloadAllLabel: 'COPY BEST URL',
            itemBtnLabel: 'COPY URL',
            hint: 'Paste into VLC or yt-dlp'
        });
        sectionsAdded++;
    }

    // ── Images (network-captured) ─────────────────────────────────────────────
    if (image.length > 0) {
        const sorted = [...image].sort((a, b) => (b.size || 0) - (a.size || 0));
        buildCollapsibleSection({
            container: mediaCounts,
            icon: '🖼',
            label: `${image.length} image${image.length > 1 ? 's' : ''} detected`,
            items: sorted,
            getLabel: (img) => shortenUrl(img.url),
            getMeta: (img) => [img.contentType?.replace('image/', '') || '', img.size ? fmtBytes(img.size) : ''].filter(Boolean).join(' · '),
            onDownload: (img, btn) => {
                btn.textContent = '…';
                const ext = mimeToExt(img.contentType) || 'jpg';
                chrome.runtime.sendMessage({
                    type: 'gravity:download-request',
                    payload: { url: img.url, filename: inferName(img.url, ext) }
                });
                btn.textContent = '✓';
            },
            onDownloadAll: (btn) => {
                sorted.forEach(img => {
                    const ext = mimeToExt(img.contentType) || 'jpg';
                    chrome.runtime.sendMessage({
                        type: 'gravity:download-request',
                        payload: { url: img.url, filename: inferName(img.url, ext) }
                    });
                });
                btn.textContent = `✓ ${sorted.length} QUEUED`;
                btn.disabled = true;
            },
            downloadAllLabel: 'DOWNLOAD ALL IMAGES'
        });
        sectionsAdded++;
    }

    // ── Show / hide empty state ───────────────────────────────────────────────
    if (sectionsAdded > 0) {
        mediaCounts.style.display = 'flex';
        if (noMediaMsg) noMediaMsg.style.display = 'none';
    } else {
        if (noMediaMsg) noMediaMsg.style.display = 'block';
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: buildCollapsibleSection
//  Creates a collapsible section with a header, optional "Download All" button,
//  and an expandable list where every row has its own download button.
// ─────────────────────────────────────────────────────────────────────────────
function buildCollapsibleSection({
    container, icon, label, items,
    getLabel, getMeta, onDownload, onDownloadAll,
    downloadAllLabel = 'DOWNLOAD ALL',
    itemBtnLabel = 'DOWNLOAD',
    hint = null
}) {
    const section = document.createElement('div');
    section.className = 'media-section';

    // ── Header row (clickable to toggle) ──────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'section-header collapsible';
    header.innerHTML = `
        <span class="sec-icon">${icon}</span>
        <span class="sec-label">${label}</span>
        <span class="sec-chevron">▼</span>
    `;
    section.appendChild(header);

    // ── Download-All button ────────────────────────────────────────────────────
    if (onDownloadAll) {
        const dlAll = document.createElement('button');
        dlAll.className = 'action-btn';
        dlAll.textContent = downloadAllLabel;
        dlAll.addEventListener('click', () => onDownloadAll(dlAll));
        section.appendChild(dlAll);
    }

    // ── Hint ──────────────────────────────────────────────────────────────────
    if (hint) {
        const hintEl = document.createElement('div');
        hintEl.className = 'hint-text';
        hintEl.textContent = hint;
        section.appendChild(hintEl);
    }

    // ── Collapsible list ──────────────────────────────────────────────────────
    const list = document.createElement('div');
    list.className = 'item-list collapsed';

    items.forEach((item, idx) => {
        const row = document.createElement('div');
        row.className = 'item-row';

        const info = document.createElement('div');
        info.className = 'item-info';

        const nameEl = document.createElement('div');
        nameEl.className = 'item-name';
        nameEl.textContent = getLabel(item);
        nameEl.title = item.url; // full URL on hover

        const metaEl = document.createElement('div');
        metaEl.className = 'item-meta';
        metaEl.textContent = getMeta(item);

        info.appendChild(nameEl);
        if (getMeta(item)) info.appendChild(metaEl);

        const btn = document.createElement('button');
        btn.className = 'btn-item-dl';
        btn.textContent = itemBtnLabel;
        btn.addEventListener('click', () => onDownload(item, btn));

        row.appendChild(info);
        row.appendChild(btn);
        list.appendChild(row);
    });

    section.appendChild(list);

    // ── Toggle logic ──────────────────────────────────────────────────────────
    header.addEventListener('click', () => {
        const isOpen = !list.classList.contains('collapsed');
        list.classList.toggle('collapsed', isOpen);
        header.querySelector('.sec-chevron').textContent = isOpen ? '▼' : '▲';
    });

    container.appendChild(section);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Utilities
// ─────────────────────────────────────────────────────────────────────────────
function shortenUrl(url) {
    if (!url) return '(unknown)';
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '');
        const path = u.pathname.split('/').filter(Boolean).pop() || '/';
        const name = decodeURIComponent(path).slice(0, 32);
        return `${host}/${name}`;
    } catch {
        return url.slice(0, 40);
    }
}

function fmtBytes(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function mimeToExt(mime) {
    const m = {
        'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv',
        'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
        'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg',
        'audio/webm': 'weba', 'audio/aac': 'aac', 'audio/flac': 'flac',
        'audio/wav': 'wav', 'audio/opus': 'opus',
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
        'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg',
    };
    return m[(mime || '').split(';')[0].trim()] || null;
}

function inferName(url, ext) {
    try {
        const path = new URL(url).pathname;
        const parts = path.split('/').filter(Boolean);
        for (let i = parts.length - 1; i >= 0; i--) {
            const p = decodeURIComponent(parts[i]);
            if (p.includes('.') && p.length > 3 && p.length < 100) {
                return `Gravity_${p.replace(/[<>:"/\\|?*]/g, '_')}`;
            }
        }
    } catch { }
    return `Gravity_media_${Date.now()}.${ext}`;
}

function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
