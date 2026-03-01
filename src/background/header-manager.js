// header-manager.js — Manages declarativeNetRequest session rules for spoofing
// Referer/Origin/Sec-Fetch-* headers to make downloads appear native.

let _ruleIdCounter = 1000;
const _activeRules = new Map(); // urlPattern → ruleId

/**
 * Apply DNR session header overrides for a download URL so it carries
 * the source tab's Referer/Origin, bypassing CDN 403 errors.
 *
 * @param {string} url - The media URL being downloaded
 * @param {number} tabId - Source tab ID to derive Referer/Origin from
 * @param {boolean} [isDir=false] - If true, applies a wildcard rule for the URL directory
 */
export async function setupDownloadHeaders(url, tabId, isDir = false) {
    if (!tabId || !url.startsWith('http')) return;

    let newRuleId;
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab || !tab.url || !tab.url.startsWith('http')) return;

        const origin = new URL(tab.url).origin;
        const referer = tab.url;
        let urlToMatch = url.split('#')[0];
        try { urlToMatch = urlToMatch.split('?')[0]; } catch { }

        if (isDir || urlToMatch.endsWith('.m3u8') || urlToMatch.endsWith('.mpd')) {
            const lastSlash = urlToMatch.lastIndexOf('/');
            if (lastSlash > 7) { // past the "https://" part
                urlToMatch = urlToMatch.substring(0, lastSlash) + '/*';
            } else {
                urlToMatch = urlToMatch + '/*';
            }
        }

        // Remove any existing rule for this URL pattern before creating a new one
        const existingRuleId = _activeRules.get(urlToMatch);
        const removeIds = existingRuleId ? [existingRuleId] : [];

        newRuleId = ++_ruleIdCounter;
        _activeRules.set(urlToMatch, newRuleId);

        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [...removeIds, newRuleId],
            addRules: [{
                id: newRuleId,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: [
                        { header: 'Referer', operation: 'set', value: referer },
                        { header: 'Origin', operation: 'set', value: origin },
                        { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-origin' },
                        { header: 'Sec-Fetch-Mode', operation: 'set', value: 'cors' },
                        { header: 'Sec-Fetch-Dest', operation: 'set', value: 'empty' }
                    ]
                },
                condition: {
                    urlFilter: urlToMatch,
                    resourceTypes: ['xmlhttprequest', 'media', 'other']
                }
            }]
        });

        console.log(`[Gravity SW] DNR Session Headers applied (Rule ID: ${newRuleId}): ${urlToMatch}`);

        // Cleanup after 3 minutes
        const ruleId = newRuleId;
        const pattern = urlToMatch;
        setTimeout(async () => {
            console.log(`[Gravity SW] DNR Rule cleanup: Removing Rule ID ${ruleId}`);
            try {
                await chrome.declarativeNetRequest.updateSessionRules({
                    removeRuleIds: [ruleId]
                });
            } catch { }
            // Only remove from map if it's still our rule (not replaced)
            if (_activeRules.get(pattern) === ruleId) {
                _activeRules.delete(pattern);
            }
        }, 180_000);

    } catch (err) {
        console.warn(`[Gravity SW] DNR Header failed to apply (Tab ${tabId}, Rule ${newRuleId}):`, err);
    }
}
