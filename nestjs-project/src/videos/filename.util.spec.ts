import { sanitizeOriginalFilename } from './filename.util';

describe('sanitizeOriginalFilename', () => {
  it('should keep a plain filename unchanged', () => {
    expect(sanitizeOriginalFilename('meu-video.mp4')).toBe('meu-video.mp4');
  });

  it('should strip directory components keeping only the basename', () => {
    expect(sanitizeOriginalFilename('../../etc/passwd.mp4')).toBe('passwd.mp4');
    expect(sanitizeOriginalFilename('C:\\videos\\clipe.webm')).toBe(
      'clipe.webm',
    );
  });

  it('should remove control characters and quotes', () => {
    expect(sanitizeOriginalFilename('Meu "Vídeo" Ação\n.mp4')).toBe(
      'Meu Vídeo Ação.mp4',
    );
  });

  it('should keep unicode characters for filename* encoding', () => {
    expect(sanitizeOriginalFilename('Meu Vídeo Ação.mp4')).toBe(
      'Meu Vídeo Ação.mp4',
    );
  });

  it('should fall back to video.{ext} when nothing usable remains', () => {
    expect(sanitizeOriginalFilename('"\u0000.mp4')).toBe('video.mp4');
    expect(sanitizeOriginalFilename('"""')).toBe('video');
  });

  it('should fall back to video when the name has no extension', () => {
    expect(sanitizeOriginalFilename('')).toBe('video');
    expect(sanitizeOriginalFilename('video')).toBe('video');
  });
});
