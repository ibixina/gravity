chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'gravity:offscreen-fetch') {
        const { url, filename, tabId } = request.payload;

        (async () => {
            let received = 0;
            let total = 0;
            try {
                chrome.runtime.sendMessage({
                    type: 'gravity:progress-to-tab',
                    payload: { tabId, id: url, message: `Starting background fetch for ${filename || 'media'}...`, percent: 0 }
                });

                const response = await fetch(url, { credentials: 'include' });
                if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

                const contentLength = response.headers.get('content-length');
                total = parseInt(contentLength, 10);

                const reader = response.body.getReader();
                const chunks = [];
                let lastReportTime = Date.now(); // delay the first progress toast

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    chunks.push(value);
                    received += value.length;

                    const now = Date.now();
                    if (now - lastReportTime > 500) {
                        lastReportTime = now;
                        const mb = (received / 1024 / 1024).toFixed(1);
                        let msg = `Downloading: ${mb}MB...`;
                        let percent = 0;
                        if (total) {
                            percent = Math.floor((received / total) * 100);
                            const totalMb = (total / 1024 / 1024).toFixed(1);
                            msg = `Downloading: ${percent}% (${mb}MB / ${totalMb}MB)`;
                        }

                        chrome.runtime.sendMessage({
                            type: 'gravity:progress-to-tab',
                            payload: { tabId, id: url, message: msg, percent: total ? percent : null }
                        });
                    }
                }

                chrome.runtime.sendMessage({
                    type: 'gravity:progress-complete-to-tab',
                    payload: { tabId, id: url, message: `Fetch complete. Saving ${filename || 'file'} to disk...`, isError: false }
                });

                const blob = new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' });
                const blobUrl = URL.createObjectURL(blob);
                console.log(`[Gravity Offscreen] Blob created for ${filename}: ${blob.size} bytes`, blobUrl);

                // Revoke the blob URL in the offscreen document context after 2 minutes
                // to prevent memory leaks, giving enough time for the download to start and finish.
                setTimeout(() => {
                    console.log(`[Gravity Offscreen] Revoking Blob URL: ${blobUrl}`);
                    URL.revokeObjectURL(blobUrl);
                }, 120_000);

                sendResponse({ success: true, blobUrl, mimeType: response.headers.get('content-type') });

            } catch (err) {
                console.error('[Gravity Offscreen] Fetch error:', err);
                const msg = err.message || 'Network fetch failed.';
                chrome.runtime.sendMessage({
                    type: 'gravity:progress-complete-to-tab',
                    payload: { tabId, id: url, message: `Download failed: ${msg}`, isError: true }
                });
                sendResponse({ success: false, error: err.message, received });
            }
        })();

        return true;
    } else if (request.type === 'gravity:offscreen-fetch-stream') {
        const { url, filename, tabId, streamType } = request.payload;

        (async () => {
            try {
                if (streamType === 'hls' || url.includes('.m3u8')) {
                    chrome.runtime.sendMessage({
                        type: 'gravity:progress-to-tab',
                        payload: { tabId, id: url, message: `Analyzing stream...`, percent: 0 }
                    });

                    async function ensureHeaders(targetUrl) {
                        console.log(`[Gravity Offscreen] Ensuring headers for: ${targetUrl}`);
                        return new Promise(resolve => {
                            chrome.runtime.sendMessage({
                                type: 'gravity:ensure-headers',
                                payload: { url: targetUrl, tabId }
                            }, resolve);
                        });
                    }

                    let currentUrl = url;
                    console.log(`[Gravity Offscreen] Fetching HLS manifest: ${currentUrl}`);
                    await ensureHeaders(currentUrl);
                    let manifestRes = await fetch(currentUrl, { credentials: 'include' });
                    let manifest = await manifestRes.text();

                    // Resolve master playlist to best media playlist
                    if (manifest.includes('#EXT-X-STREAM-INF')) {
                        console.log(`[Gravity Offscreen] Master playlist detected. Parsing variants...`);
                        const lines = manifest.split('\n');
                        let bestUrl = null;
                        let bestBw = 0;
                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                                const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                                const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
                                if (bw >= bestBw && lines[i + 1]) {
                                    bestBw = bw;
                                    bestUrl = lines[i + 1].trim();
                                }
                            }
                        }
                        if (bestUrl) {
                            currentUrl = new URL(bestUrl, currentUrl).href;
                            console.log(`[Gravity Offscreen] Selected variant bandwidth ${bestBw}: ${currentUrl}`);
                            await ensureHeaders(currentUrl);
                            manifestRes = await fetch(currentUrl, { credentials: 'include' });
                            manifest = await manifestRes.text();
                        }
                    }

                    // Parse media playlist for chunks
                    const lines = manifest.split('\n');
                    const segments = [];
                    for (let line of lines) {
                        line = line.trim();
                        if (line && !line.startsWith('#')) {
                            segments.push(new URL(line, currentUrl).href);
                        }
                    }

                    if (segments.length === 0) {
                        throw new Error('No video segments found in stream playlist');
                    }
                    if (segments.length > 0) {
                        await ensureHeaders(segments[0]);
                    }

                    chrome.runtime.sendMessage({
                        type: 'gravity:progress-to-tab',
                        payload: { tabId, id: url, message: `Downloading ${segments.length} stream segments...`, percent: 0 }
                    });

                    const chunks = [];
                    for (let i = 0; i < segments.length; i++) {
                        const segRes = await fetch(segments[i], { credentials: 'include' });
                        if (!segRes.ok) {
                            console.error(`[Gravity Offscreen] Segment ${i} failed: ${segRes.status}`, segments[i]);
                            throw new Error(`Failed to fetch segment ${i} (${segments[i]})`);
                        }
                        const buffer = await segRes.arrayBuffer();
                        chunks.push(buffer);

                        const percent = Math.floor(((i + 1) / segments.length) * 100);
                        if (i % 20 === 0 || i === segments.length - 1) {
                            console.log(`[Gravity Offscreen] Stream download progress: ${percent}% (${i + 1}/${segments.length})`);
                            chrome.runtime.sendMessage({
                                type: 'gravity:progress-to-tab',
                                payload: { tabId, id: url, message: `Downloading stream: ${percent}% (${i + 1}/${segments.length})`, percent }
                            });
                        }
                    }

                    chrome.runtime.sendMessage({
                        type: 'gravity:progress-complete-to-tab',
                        payload: { tabId, id: url, message: `Stream fetch complete. Saving...`, isError: false }
                    });

                    const blobType = chunks[0] && new Uint8Array(chunks[0])[0] === 0x47 ? 'video/mp2t' : 'video/mp4';
                    const totalSize = chunks.reduce((sum, c) => sum + c.byteLength, 0);
                    const blob = new Blob(chunks, { type: blobType });
                    const blobUrl = URL.createObjectURL(blob);
                    console.log(`[Gravity Offscreen] Stream blob created: ${totalSize} bytes`, blobUrl);

                    setTimeout(() => {
                        console.log(`[Gravity Offscreen] Revoking stream Blob URL: ${blobUrl}`);
                        URL.revokeObjectURL(blobUrl);
                    }, 120_000);
                    sendResponse({ success: true, blobUrl });
                } else {
                    throw new Error('Unsupported stream format (only HLS/m3u8 is supported currently)');
                }
            } catch (err) {
                console.error('[Gravity Offscreen] Stream fetch error:', err);
                chrome.runtime.sendMessage({
                    type: 'gravity:progress-complete-to-tab',
                    payload: { tabId, id: url, message: `Stream failed: ${err.message}`, isError: true }
                });
                sendResponse({ success: false, error: err.message });
            }
        })();

        return true;
    }
});
