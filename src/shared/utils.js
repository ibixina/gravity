// shared/utils.js — Shared utilities used across background, popup, and content scripts.
// Single source of truth to prevent divergence between copies.

/**
 * Detect file extension from magic bytes (file signature).
 * Works like the `file` command on Linux by reading the file header.
 * @param {Uint8Array|ArrayBuffer|number[]} bytes - The first bytes of the file
 * @returns {string|null} - The detected extension or null if unknown
 */
export function detectExtensionFromBytes(bytes) {
    if (!bytes || bytes.byteLength < 4) return null;
    
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const b = (i) => arr[i];
    
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) {
        return 'png';
    }
    
    // JPEG: FF D8 FF
    if (b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) {
        return 'jpg';
    }
    
    // GIF: 47 49 46 38 (GIF8)
    if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) {
        return 'gif';
    }
    
    // WebP: 52 49 46 46 .... 57 45 42 50 (RIFF....WEBP)
    if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 &&
        arr.byteLength >= 12 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) {
        return 'webp';
    }
    
    // WebM / EBML: 1A 45 DF A3
    if (b(0) === 0x1A && b(1) === 0x45 && b(2) === 0xDF && b(3) === 0xA3) {
        return 'webm';
    }
    
    // MP4/MOV: at offset 4, bytes are "ftyp" (66 74 79 70)
    if (arr.byteLength >= 8 && b(4) === 0x66 && b(5) === 0x74 && b(6) === 0x79 && b(7) === 0x70) {
        // Check for variant: 4D534E56 (M4V), 69736F6D (isom), 6D706432 (mp42)
        const brand = (b(8) << 24) | (b(9) << 16) | (b(10) << 8) | b(11);
        if (brand === 0x4D534E56) return 'm4v';
        if (brand === 0x69736F6D) return 'mp4';
        if (brand === 0x6D703432) return 'mp4';
        if (brand === 0x6D703432) return 'mp4';
        return 'mp4';
    }
    
    // FLAC: 66 4C 61 43
    if (b(0) === 0x66 && b(1) === 0x4C && b(2) === 0x61 && b(3) === 0x43) {
        return 'flac';
    }
    
    // OGG: 4F 67 67 53
    if (b(0) === 0x4F && b(1) === 0x67 && b(2) === 0x67 && b(3) === 0x53) {
        return 'ogg';
    }
    
    // PDF: 25 50 44 46
    if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) {
        return 'pdf';
    }
    
    // ZIP / APK / DOCX: 50 4B 03 04
    if (b(0) === 0x50 && b(1) === 0x4B && b(2) === 0x03 && b(3) === 0x04) {
        return 'zip';
    }
    
    // MP3: 49 44 33 (ID3) or FF (MPEG audio frame)
    if (b(0) === 0x49 && b(1) === 0x44 && b(2) === 0x33) {
        return 'mp3';
    }
    if (b(0) === 0xFF && (b(1) & 0xE0) === 0xE0) {
        return 'mp3';
    }
    
    // WAV: 52 49 46 46 .... 57 41 56 45 (RIFF....WAVE)
    if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 &&
        arr.byteLength >= 12 && b(8) === 0x57 && b(9) === 0x41 && b(10) === 0x56 && b(11) === 0x45) {
        return 'wav';
    }
    
    // AVIF: at offset 4 bytes are "avif" (61 76 69 66) or "avis" (61 76 69 73)
    if (arr.byteLength >= 8 && b(4) === 0x61 && b(5) === 0x76 && (b(6) === 0x69 || b(6) === 0x49) && (b(7) === 0x66 || b(7) === 0x66)) {
        return 'avif';
    }
    
    // HEIC/HEIF: at offset 4 bytes are "heic" or "heix" or "mif1" or "msf1"
    if (arr.byteLength >= 8 && b(4) === 0x68 && b(5) === 0x65 && b(6) === 0x69) {
        return 'heic';
    }
    
    // BMP: 42 4D (BM)
    if (b(0) === 0x42 && b(1) === 0x4D) {
        return 'bmp';
    }
    
    // TIFF (little endian): 49 49 2A 00
    // TIFF (big endian): 4D 4D 00 2A
    if ((b(0) === 0x49 && b(1) === 0x49 && b(2) === 0x2A && b(3) === 0x00) ||
        (b(0) === 0x4D && b(1) === 0x4D && b(2) === 0x00 && b(3) === 0x2A)) {
        return 'tiff';
    }
    
    return null;
}

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
 * Infer a filename from a URL, MIME type, Content-Disposition header, or magic bytes.
 * All filenames are prefixed with "Gravity_" and include a timestamp.
 */
export function inferFilename(url, mimeType, contentDisposition, initialBytes) {
    const timestamp = getTimestamp();
    const extFromBytes = initialBytes ? detectExtensionFromBytes(initialBytes) : null;
    const ext = mimeToExt(mimeType) || extFromBytes || 'bin';

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
            if (part.toLowerCase() === 'undefined' || part.toLowerCase() === 'null') {
                continue;
            }
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
    return `gravity_${timestamp}.${ext}`;
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
