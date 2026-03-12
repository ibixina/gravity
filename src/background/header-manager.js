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
 * @param {string} [manualReferer] - Optional manual referer to use instead of tab.url
 */
export async function setupDownloadHeaders(url, tabId, manualReferer = null) {
    if (!tabId || !url.startsWith('http')) return;

    let newRuleId;
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab || (!tab.url && !manualReferer)) return;

        const referer = manualReferer || tab.url || "";
        const urlObj = new URL(url);
        const domain = urlObj.hostname;

        // Determine Sec-Fetch-Site
        let secFetchSite = 'cross-site';
        try {
            const pageUrlObj = new URL(tab.url);
            if (pageUrlObj.origin === urlObj.origin) {
                secFetchSite = 'same-origin';
            } else {
                const pageDomainParts = pageUrlObj.hostname.split('.');
                const videoDomainParts = urlObj.hostname.split('.');
                const pBase = pageDomainParts.slice(-2).join('.');
                const vBase = videoDomainParts.slice(-2).join('.');
                if (pBase === vBase) secFetchSite = 'same-site';
            }
        } catch (e) { }

        // Use a broader filter to ensure we catch all redirects and segments
        const urlToMatch = `*://${domain}/*`;

        // Aggressively clean up ALL previous rules to avoid conflicts
        const existingRules = await chrome.declarativeNetRequest.getSessionRules();
        const removeIds = existingRules.map(r => r.id);

        newRuleId = ++_ruleIdCounter;
        _activeRules.set(urlToMatch, newRuleId);

        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: removeIds,
            addRules: [{
                id: newRuleId,
                priority: 1000,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: [
                        { header: 'Referer', operation: 'set', value: referer },
                        { header: 'User-Agent', operation: 'set', value: navigator.userAgent },
                        { header: 'Sec-Fetch-Site', operation: 'set', value: secFetchSite },
                        { header: 'Sec-Fetch-Mode', operation: 'set', value: 'no-cors' },
                        { header: 'Sec-Fetch-Dest', operation: 'set', value: 'video' },
                        { header: 'Range', operation: 'set', value: 'bytes=0-' },
                        { header: 'Origin', operation: 'remove' },
                        { header: 'X-Requested-With', operation: 'remove' }
                    ]
                },
                condition: {
                    urlFilter: urlToMatch,
                    resourceTypes: ['main_frame', 'sub_frame', 'other', 'media', 'xmlhttprequest']
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
