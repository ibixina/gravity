export const MessageType = {
  // Content Script → Service Worker
  MEDIA_DETECTED:     'gravity:media-detected',
  DOWNLOAD_REQUEST:   'gravity:download-request',
  BATCH_DOWNLOAD:     'gravity:batch-download',
  SCAN_REQUEST:       'gravity:scan-request',
  CAPTURE_REQUEST:    'gravity:capture-request',
  RECORD_START:       'gravity:record-start',
  RECORD_STOP:        'gravity:record-stop',
  UPDATE_BADGE:       'gravity:update-badge',

  // Service Worker → Content Script
  SCAN_TRIGGER:       'gravity:scan-trigger',
  DOWNLOAD_PROGRESS:  'gravity:download-progress',
  DOWNLOAD_COMPLETE:  'gravity:download-complete',
  DOWNLOAD_ERROR:     'gravity:download-error',
  NETWORK_MEDIA:      'gravity:network-media',

  // Service Worker → Offscreen
  MERGE_SEGMENTS:     'gravity:merge-segments',
  STITCH_TILES:       'gravity:stitch-tiles',
  CONVERT_FORMAT:     'gravity:convert-format',
  PROCESS_RECORDING:  'gravity:process-recording',

  // Offscreen → Service Worker
  PROCESS_COMPLETE:   'gravity:process-complete',
  PROCESS_PROGRESS:   'gravity:process-progress',
  PROCESS_ERROR:      'gravity:process-error',

  // MAIN world → ISOLATED world (via CustomEvent on document)
  HOOK_DATA:          'gravity:hook-data',
  BLOB_CREATED:       'gravity:blob-created',
  MEDIA_SOURCE_CREATED: 'gravity:media-source-created',
  CANVAS_DRAW:        'gravity:canvas-draw',
  SHADOW_ROOT_CREATED: 'gravity:shadow-root-created',
  SEGMENT_CAPTURED:   'gravity:segment-captured',
  HOOKS_READY:        'gravity:hooks-ready',

  // Additional message types for segment handling
  DOWNLOAD_SEGMENTS:  'gravity:download-segments',
  GET_SEGMENTS:       'gravity:get-segments',
};
