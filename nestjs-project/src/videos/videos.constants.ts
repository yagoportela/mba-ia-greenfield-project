export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024;
export const UPLOAD_PART_SIZE_BYTES = 64 * 1024 * 1024;
export const ALLOWED_VIDEO_MIME_TYPES = ['video/mp4', 'video/webm'] as const;
export const PRESIGNED_URL_TTL_SECONDS = 3600;
export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_PROCESSING_SWEEP_QUEUE = 'video-processing-sweep';
