const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f"']/g;

function extractExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return '';
  }
  return filename.slice(lastDot + 1).toLowerCase();
}

export function sanitizeOriginalFilename(filename: string): string {
  const basename = filename.split(/[/\\]/).pop() ?? '';
  const extension = extractExtension(basename);
  const fallback = extension ? `video.${extension}` : 'video';

  const cleaned = basename
    .replace(UNSAFE_FILENAME_CHARS, '')
    .trim();

  if (
    !cleaned ||
    /^\.+$/.test(cleaned) ||
    (cleaned.startsWith('.') && cleaned.indexOf('.', 1) === -1)
  ) {
    return fallback;
  }

  return cleaned;
}
