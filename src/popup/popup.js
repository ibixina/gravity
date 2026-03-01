import { inferFilename, shortenUrl, fmtBytes, escHtml } from '../shared/utils.js';

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

    // ── Active Downloads ────────────────────────────────────────────────────────
    const dlsSection = document.getElementById('active-downloads-section');
    const dlsList = document.getElementById('active-downloads-list');

    try {
        const activeDownloads = await new Promise((resolve) => {
            chrome.downloads.search({ state: 'in_progress' }, resolve);
        });

        if (activeDownloads && activeDownloads.length > 0) {
            dlsSection.style.display = 'block';

            activeDownloads.forEach(dl => {
                const row = document.createElement('div');
                row.className = 'item-row';
                row.style.borderLeftColor = '#006600'; // Green stripe for active

                const info = document.createElement('div');
                info.className = 'item-info';

                const nameEl = document.createElement('div');
                nameEl.className = 'item-name';

                let displayName = dl.filename ? dl.filename.split(/[\/\\]/).pop() : shortenUrl(dl.url);
                nameEl.textContent = displayName;
                nameEl.title = dl.filename || dl.url;

                const metaEl = document.createElement('div');
                metaEl.className = 'item-meta';

                let progressText = 'Downloading...';
                if (dl.totalBytes > 0) {
                    const percent = Math.floor((dl.bytesReceived / dl.totalBytes) * 100);
                    // Prevent 100% jumping if size is approximated
                    const capPercent = Math.min(percent, 99);
                    progressText = `${capPercent}% · ${fmtBytes(dl.bytesReceived)} / ${fmtBytes(dl.totalBytes)}`;
                } else if (dl.bytesReceived > 0) {
                    progressText = `${fmtBytes(dl.bytesReceived)} received`;
                }

                metaEl.textContent = progressText;

                info.appendChild(nameEl);
                info.appendChild(metaEl);

                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'btn-item-dl';
                cancelBtn.textContent = '✕';
                cancelBtn.style.color = '#cc0000';
                cancelBtn.title = 'Cancel Download';
                cancelBtn.addEventListener('click', () => {
                    chrome.downloads.cancel(dl.id);
                    row.remove();
                    if (dlsList.children.length === 0) {
                        dlsSection.style.display = 'none';
                    }
                });

                row.appendChild(info);
                row.appendChild(cancelBtn);
                dlsList.appendChild(row);
            });
        }
    } catch (err) {
        console.warn('[Gravity Popup] Failed to get active downloads:', err);
    }

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
                const name = inferFilename(v.url, v.contentType);
                chrome.runtime.sendMessage({
                    type: 'gravity:download-request',
                    payload: { url: v.url, filename: name, tabId: tab.id }
                });
                btn.textContent = '✓';
                setTimeout(() => window.close(), 600);
            },
            onDownloadAll: (btn) => {
                const best = sorted[0];
                btn.textContent = 'DOWNLOADING…';
                chrome.runtime.sendMessage({
                    type: 'gravity:download-request',
                    payload: { url: best.url, filename: inferFilename(best.url, best.contentType), tabId: tab.id }
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
                chrome.runtime.sendMessage({
                    type: 'gravity:download-request',
                    payload: { url: a.url, filename: inferFilename(a.url, a.contentType), tabId: tab.id }
                });
                btn.textContent = '✓';
                setTimeout(() => window.close(), 600);
            },
            onDownloadAll: (btn) => {
                const best = sorted[0];
                btn.textContent = 'DOWNLOADING…';
                chrome.runtime.sendMessage({
                    type: 'gravity:download-request',
                    payload: { url: best.url, filename: inferFilename(best.url, best.contentType), tabId: tab.id }
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
                btn.textContent = '…';
                const ext = s.url.includes('.m3u8') ? 'ts' : 'mp4';
                chrome.runtime.sendMessage({
                    type: 'gravity:download-stream',
                    payload: {
                        url: s.url,
                        filename: `Gravity_Stream_${Date.now()}.${ext}`,
                        streamType: s.url.includes('.m3u8') ? 'hls' : 'dash',
                        tabId: tab.id
                    }
                });
                btn.textContent = '✓';
                setTimeout(() => window.close(), 600);
            },
            onDownloadAll: async (btn) => {
                const best = allStreams[allStreams.length - 1];
                btn.textContent = 'DOWNLOADING…';
                const ext = best.url.includes('.m3u8') ? 'ts' : 'mp4';
                chrome.runtime.sendMessage({
                    type: 'gravity:download-stream',
                    payload: {
                        url: best.url,
                        filename: `Gravity_Stream_${Date.now()}.${ext}`,
                        streamType: best.url.includes('.m3u8') ? 'hls' : 'dash',
                        tabId: tab.id
                    }
                });
                setTimeout(() => window.close(), 600);
            },
            downloadAllLabel: 'DOWNLOAD BEST STREAM',
            itemBtnLabel: 'DOWNLOAD',
            hint: 'Downloads the highest quality stream'
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
                chrome.runtime.sendMessage({
                    type: 'gravity:download-request',
                    payload: { url: img.url, filename: inferFilename(img.url, img.contentType) }
                });
                btn.textContent = '✓';
            },
            onDownloadAll: (btn) => {
                sorted.forEach(img => {
                    chrome.runtime.sendMessage({
                        type: 'gravity:download-request',
                        payload: { url: img.url, filename: inferFilename(img.url, img.contentType) }
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

// Utilities imported from '../shared/utils.js' at the top of this file.
