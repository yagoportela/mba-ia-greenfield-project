function extractExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return '';
  }
  return filename.slice(lastDot + 1).toLowerCase();
}

function isUnsafeFilenameChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 0x1f || code === 0x7f || char === '"' || char === "'";
}

export function sanitizeOriginalFilename(filename: string): string {
  const basename = filename.split(/[/\\]/).pop() ?? '';
  const extension = extractExtension(basename);
  const fallback = extension ? `video.${extension}` : 'video';

  const cleaned = Array.from(basename)
    .filter((char) => !isUnsafeFilenameChar(char))
    .join('')
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
