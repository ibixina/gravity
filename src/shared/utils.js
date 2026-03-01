// shared/utils.js — Shared utilities used across background, popup, and content scripts.
// Single source of truth to prevent divergence between copies.

/**
 * Maps a MIME type (e.g. 'video/mp4') to a file extension (e.g. 'mp4').
 * Returns null if the MIME type is not recognised.
 */
export function mimeToExt(mime) {
    const m = {
        // Video
        'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv',
        'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
        'video/3gpp': '3gp', 'video/3gpp2': '3g2', 'video/x-flv': 'flv',
        'video/x-msvideo': 'avi', 'video/mp2t': 'ts',
        // Audio
        'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg',
        'audio/webm': 'weba', 'audio/aac': 'aac', 'audio/flac': 'flac',
        'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/opus': 'opus',
        'audio/x-matroska': 'mka',
        // Image
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
        'image/webp': 'webp', 'image/avif': 'avif', 'image/heic': 'heic',
        'image/heif': 'heif', 'image/bmp': 'bmp', 'image/tiff': 'tiff',
        'image/svg+xml': 'svg',
        // Streams / misc
        'application/x-mpegurl': 'm3u8', 'application/vnd.apple.mpegurl': 'm3u8',
        'application/dash+xml': 'mpd',
        'application/octet-stream': 'bin',
    };
    return m[(mime || '').split(';')[0].trim()] || null;
}

/**
 * Generate a timestamp string for filenames (YYYYMMDD_HHMMSS format).
 */
export function getTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

/**
 * Infer a filename from a URL, MIME type, and optional Content-Disposition header.
 * All filenames are prefixed with "Gravity_" and include a timestamp.
 */
export function inferFilename(url, mimeType, contentDisposition) {
    const timestamp = getTimestamp();
    const ext = mimeToExt(mimeType) || 'bin';

    // 1. Prefer filename from Content-Disposition header (most accurate)
    if (contentDisposition) {
        const cdMatch = contentDisposition.match(/filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']+)['"]?/i);
        if (cdMatch && cdMatch[1]) {
            const name = decodeURIComponent(cdMatch[1].trim().replace(/^["']|["']$/g, ''));
            if (name && name.length > 1) {
                // Insert timestamp before extension
                const cleanName = name.replace(/[<>:"\/\\|?*]/g, '_');
                const lastDotIndex = cleanName.lastIndexOf('.');
                if (lastDotIndex > 0) {
                    const baseName = cleanName.slice(0, lastDotIndex);
                    const fileExt = cleanName.slice(lastDotIndex + 1);
                    return `Gravity_${baseName}_${timestamp}.${fileExt}`;
                }
                return `Gravity_${cleanName}_${timestamp}.${ext}`;
            }
        }
    }

    let namePart = null;

    // 2. Try to extract a meaningful name from the URL path
    try {
        const u = new URL(url);
        const pathParts = u.pathname.split('/').filter(Boolean);
        // Walk backwards to find a segment that looks like a filename
        for (let i = pathParts.length - 1; i >= 0; i--) {
            const part = decodeURIComponent(pathParts[i]);
            if (part.includes('.') && part.length > 3 && part.length < 120) {
                const popExt = part.split('.').pop().toLowerCase();
                if (['php', 'asp', 'aspx', 'jsp', 'html', 'htm'].includes(popExt)) continue;
                const cleanPart = part.replace(/[<>:"\/\\|?*]/g, '_');
                const lastDotIndex = cleanPart.lastIndexOf('.');
                if (lastDotIndex > 0) {
                    const baseName = cleanPart.slice(0, lastDotIndex);
                    const fileExt = cleanPart.slice(lastDotIndex + 1);
                    return `Gravity_${baseName}_${timestamp}.${fileExt}`;
                }
                return `Gravity_${cleanPart}_${timestamp}.${ext}`;
            }
            if (!namePart && part.length > 2 && part.length < 120) namePart = part.replace(/[<>:"\/\\|?*]/g, '_');
        }
    } catch { }

    if (namePart) return `Gravity_${namePart}_${timestamp}.${ext}`;

    // 3. Fall back to MIME-based name with timestamp
    return `Gravity_media_${timestamp}.${ext}`;
}

/**
 * Resolve a tab ID from either sender.tab or payload.tabId.
 * Returns the tab ID or null.
 */
export function resolveTabId(sender, payload) {
    return sender?.tab?.id || payload?.tabId || null;
}

/**
 * Shorten a URL for display in the popup/UI.
 */
export function shortenUrl(url) {
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

/**
 * Format a byte count into a human-readable string.
 */
export function fmtBytes(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Escape HTML special characters to prevent XSS.
 */
export function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
