export const MediaType = {
    IMAGE: 'image',
    VIDEO: 'video',
    AUDIO: 'audio',
    UNKNOWN: 'unknown'
};

export const MediaSubtype = {
    IMG_TAG: 'img',
    CSS_BG: 'css-bg',
    CANVAS: 'canvas',
    SVG: 'svg',
    VIDEO_TAG: 'video',
    AUDIO_TAG: 'audio',
    HLS: 'hls',
    DASH: 'dash',
    BLOB: 'blob',
    // Image format subtypes
    GIF: 'gif',
    WEBP: 'webp',
    AVIF: 'avif',
    DATA_URI: 'data-uri',
    VIDEO_POSTER: 'video-poster',
    // Metadata-sourced
    META_OG: 'meta-og',
    PRELOAD: 'preload',
    STRUCTURED_DATA: 'structured-data',
    PICTURE_SOURCE: 'picture-source',
};

export const DEFAULT_SETTINGS = {
    defaultDownloadPath: 'Gravity/',
    filenameTemplate: '{site}_{title}_{index}',
    askSaveLocation: false,
    minImageSize: 100,
    autoScan: true,
    showBadge: true,
    enabledDetectors: ['image', 'video', 'audio', 'canvas', 'css-bg'],
    maxConcurrentDownloads: 3,
    imageFormat: 'original',
    videoFormat: 'mp4',
    theme: 'auto'
};
