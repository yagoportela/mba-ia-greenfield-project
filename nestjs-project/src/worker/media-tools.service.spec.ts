import { execFile } from 'node:child_process';

import { MediaToolsService } from './media-tools.service';

jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));

const execFileMock = execFile as unknown as jest.Mock;

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

describe('MediaToolsService (unit)', () => {
  let service: MediaToolsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MediaToolsService();
  });

  function mockSuccess(stdout = ''): void {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], callback: ExecFileCallback) => {
        callback(null, stdout, '');
      },
    );
  }

  it('should run ffprobe with the expected arguments and parse the metadata', async () => {
    mockSuccess(
      JSON.stringify({
        streams: [{ width: 1920, height: 1080, codec_name: 'h264' }],
        format: { duration: '12.345000' },
      }),
    );

    const result = await service.probe('/tmp/original');

    expect(execFileMock).toHaveBeenCalledWith(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,codec_name',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        '/tmp/original',
      ],
      expect.any(Function),
    );
    expect(result).toEqual({
      hasVideoStream: true,
      durationSeconds: 12.345,
      width: 1920,
      height: 1080,
      codecName: 'h264',
    });
  });

  it('should report a missing video stream and zero duration', async () => {
    mockSuccess(JSON.stringify({ streams: [], format: {} }));

    const result = await service.probe('/tmp/audio-only');

    expect(result.hasVideoStream).toBe(false);
    expect(result.durationSeconds).toBe(0);
    expect(result.width).toBeNull();
    expect(result.height).toBeNull();
    expect(result.codecName).toBeNull();
  });

  it('should build the ffmpeg arguments without a shell and pass the seek time', async () => {
    mockSuccess();

    await service.generateThumbnail(
      '/tmp/original',
      '/tmp/thumbnail.jpg',
      1.25,
    );

    expect(execFileMock).toHaveBeenCalledWith(
      'ffmpeg',
      [
        '-y',
        '-ss',
        '1.25',
        '-i',
        '/tmp/original',
        '-frames:v',
        '1',
        '-q:v',
        '2',
        '/tmp/thumbnail.jpg',
      ],
      expect.any(Function),
    );
  });

  it('should reject when the underlying command fails', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], callback: ExecFileCallback) => {
        callback(new Error('ffprobe failed'), '', 'boom');
      },
    );

    await expect(service.probe('/tmp/broken')).rejects.toThrow(
      'ffprobe failed',
    );
  });
});
