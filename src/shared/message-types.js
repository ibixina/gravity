export const MessageType = {
  // Content Script → Service Worker
  MEDIA_DETECTED: 'gravity:media-detected',
  DOWNLOAD_REQUEST: 'gravity:download-request',
  BATCH_DOWNLOAD: 'gravity:batch-download',
  SCAN_REQUEST: 'gravity:scan-request',
  CAPTURE_REQUEST: 'gravity:capture-request',
  RECORD_START: 'gravity:record-start',
  RECORD_STOP: 'gravity:record-stop',
  UPDATE_BADGE: 'gravity:update-badge',
  DOWNLOAD_NETWORK_MEDIA: 'gravity:download-network-media',
  DOWNLOAD_STREAM: 'gravity:download-stream',
  DOWNLOAD_SEGMENTS: 'gravity:download-segments',
  YOUTUBE_VIDEO_EXTRACTED: 'gravity:youtube-video-extracted',
  ABORT_BUFFER: 'gravity:abort-buffer',

  // Service Worker → Content Script
  SCAN_TRIGGER: 'gravity:scan-trigger',
  DOWNLOAD_PROGRESS: 'gravity:download-progress',
  DOWNLOAD_COMPLETE: 'gravity:download-complete',
  DOWNLOAD_ERROR: 'gravity:download-error',
  NETWORK_MEDIA: 'gravity:network-media',
  SHOW_GALLERY: 'gravity:show-gallery',
  TOGGLE_PICK_MODE: 'gravity:toggle-pick-mode',
  TOAST: 'gravity:toast',
  PROGRESS: 'gravity:progress',
  PROGRESS_COMPLETE: 'gravity:progress-complete',
  DOWNLOAD_AT_CURSOR: 'gravity:download-at-cursor',
  BUFFER_PROGRESS: 'gravity:buffer-progress',

  // Service Worker ↔ Popup
  GET_SEGMENTS: 'gravity:get-segments',
  GET_TAB_MEDIA: 'gravity:get-tab-media',

  // Service Worker → Offscreen
  MERGE_SEGMENTS: 'gravity:merge-segments',
  STITCH_TILES: 'gravity:stitch-tiles',
  CONVERT_FORMAT: 'gravity:convert-format',
  PROCESS_RECORDING: 'gravity:process-recording',
  OFFSCREEN_FETCH: 'gravity:offscreen-fetch',
  OFFSCREEN_FETCH_STREAM: 'gravity:offscreen-fetch-stream',

  // Offscreen → Service Worker
  PROCESS_COMPLETE: 'gravity:process-complete',
  PROCESS_PROGRESS: 'gravity:process-progress',
  PROCESS_ERROR: 'gravity:process-error',
  PROGRESS_TO_TAB: 'gravity:progress-to-tab',
  PROGRESS_COMPLETE_TO_TAB: 'gravity:progress-complete-to-tab',

  // SW ↔ Header/DNR
  ENSURE_HEADERS: 'gravity:ensure-headers',

  // MAIN world → ISOLATED world (via CustomEvent on document)
  HOOK_DATA: 'gravity:hook-data',
  BLOB_CREATED: 'gravity:blob-created',
  MEDIA_SOURCE_CREATED: 'gravity:media-source-created',
  CANVAS_DRAW: 'gravity:canvas-draw',
  SHADOW_ROOT_CREATED: 'gravity:shadow-root-created',
  SEGMENT_CAPTURED: 'gravity:segment-captured',
  HOOKS_READY: 'gravity:hooks-ready',
};
