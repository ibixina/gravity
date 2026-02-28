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

                // Revoke the blob URL in the offscreen document context after 2 minutes
                // to prevent memory leaks, giving enough time for the download to start and finish.
                setTimeout(() => URL.revokeObjectURL(blobUrl), 120_000);

                sendResponse({ success: true, blobUrl });

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
    }
});
