import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Job } from 'bullmq';

import type { Channel } from '../channels/entities/channel.entity';
import type { VideoProcessingJobData } from '../queue/video-queue.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { MediaToolsService } from './media-tools.service';
import { VideoProcessingProcessor } from './video-processing.processor';

function buildVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-id',
    public_id: 'AbCdEf123456',
    channel_id: 'channel-1',
    title: null,
    original_filename: 'original.mp4',
    storage_key: 'videos/video-id/original.mp4',
    thumbnail_key: null,
    upload_id: null,
    mime_type: 'video/mp4',
    size_bytes: '1024',
    duration_seconds: null,
    width: null,
    height: null,
    status: VideoStatus.Processing,
    failure_reason: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    channel: { id: 'channel-1', user_id: 'user-1' } as Channel,
    ...overrides,
  };
}

function buildJob(
  overrides: Partial<{
    videoId: string;
    attemptsMade: number;
    attempts: number;
  }> = {},
): Job<VideoProcessingJobData> {
  return {
    data: { videoId: overrides.videoId ?? 'video-id' },
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 3 },
  } as unknown as Job<VideoProcessingJobData>;
}

describe('VideoProcessingProcessor (unit)', () => {
  let processor: VideoProcessingProcessor;
  const videoRepository = {
    findOneBy: jest.fn(),
    save: jest.fn(),
  };
  const storageService = {
    downloadToFile: jest.fn(),
    uploadFile: jest.fn(),
    buildThumbnailKey: jest.fn(
      (videoId: string) => `videos/${videoId}/thumbnail.jpg`,
    ),
  };
  const mediaToolsService = {
    probe: jest.fn(),
    generateThumbnail: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        {
          provide: getRepositoryToken(Video),
          useValue: videoRepository,
        },
        { provide: StorageService, useValue: storageService },
        { provide: MediaToolsService, useValue: mediaToolsService },
      ],
    }).compile();

    processor = module.get(VideoProcessingProcessor);

    storageService.downloadToFile.mockResolvedValue(undefined);
    storageService.uploadFile.mockResolvedValue(undefined);
    mediaToolsService.generateThumbnail.mockResolvedValue(undefined);
    videoRepository.save.mockImplementation((video: Video) => video);
  });

  it('should move the video to ready with metadata and an uploaded thumbnail', async () => {
    videoRepository.findOneBy.mockResolvedValue(buildVideo());
    mediaToolsService.probe.mockResolvedValue({
      hasVideoStream: true,
      durationSeconds: 100,
      width: 1920,
      height: 1080,
      codecName: 'h264',
    });

    await processor.process(buildJob());

    expect(storageService.downloadToFile).toHaveBeenCalledWith(
      'videos/video-id/original.mp4',
      expect.stringContaining('original'),
    );
    expect(mediaToolsService.generateThumbnail).toHaveBeenCalledWith(
      expect.stringContaining('original'),
      expect.stringContaining('thumbnail.jpg'),
      10,
    );
    expect(storageService.uploadFile).toHaveBeenCalledWith(
      'videos/video-id/thumbnail.jpg',
      expect.stringContaining('thumbnail.jpg'),
      'image/jpeg',
    );

    const saved = videoRepository.save.mock.calls[0][0] as Video;
    expect(saved.status).toBe(VideoStatus.Ready);
    expect(saved.duration_seconds).toBe('100.000');
    expect(saved.width).toBe(1920);
    expect(saved.height).toBe(1080);
    expect(saved.thumbnail_key).toBe(
      'videos/video-id/thumbnail.jpg',
    );
    expect(saved.failure_reason).toBeNull();
  });

  it('should keep the result stable when the same job is processed twice', async () => {
    videoRepository.findOneBy.mockResolvedValue(buildVideo());
    mediaToolsService.probe.mockResolvedValue({
      hasVideoStream: true,
      durationSeconds: 100,
      width: 1920,
      height: 1080,
      codecName: 'h264',
    });

    await processor.process(buildJob());
    await processor.process(buildJob());

    expect(videoRepository.save).toHaveBeenCalledTimes(2);
    const saved = videoRepository.save.mock.calls[1][0] as Video;
    expect(saved.status).toBe(VideoStatus.Ready);
    expect(saved.thumbnail_key).toBe(
      'videos/video-id/thumbnail.jpg',
    );
  });

  it('should rethrow without marking failed when the attempt is not the last', async () => {
    videoRepository.findOneBy.mockResolvedValue(buildVideo());
    mediaToolsService.probe.mockResolvedValue({
      hasVideoStream: false,
      durationSeconds: 0,
      width: null,
      height: null,
      codecName: null,
    });

    await expect(
      processor.process(buildJob({ attemptsMade: 0, attempts: 3 })),
    ).rejects.toThrow('does not contain a valid video stream');

    expect(videoRepository.save).not.toHaveBeenCalled();
    expect(storageService.uploadFile).not.toHaveBeenCalled();
  });

  it('should mark the video as failed on the last attempt', async () => {
    videoRepository.findOneBy.mockResolvedValue(buildVideo());
    mediaToolsService.probe.mockRejectedValue(
      new Error('ffprobe exploded'),
    );

    await expect(
      processor.process(buildJob({ attemptsMade: 2, attempts: 3 })),
    ).rejects.toThrow('ffprobe exploded');

    const saved = videoRepository.save.mock.calls[0][0] as Video;
    expect(saved.status).toBe(VideoStatus.Failed);
    expect(saved.failure_reason).toContain('ffprobe exploded');
  });

  it('should mark the video as failed when the download fails on the last attempt', async () => {
    videoRepository.findOneBy.mockResolvedValue(buildVideo());
    storageService.downloadToFile.mockRejectedValue(
      new Error('storage unavailable'),
    );

    await expect(
      processor.process(buildJob({ attemptsMade: 2, attempts: 3 })),
    ).rejects.toThrow('storage unavailable');

    const saved = videoRepository.save.mock.calls[0][0] as Video;
    expect(saved.status).toBe(VideoStatus.Failed);
    expect(saved.failure_reason).toContain('storage unavailable');
  });

  it('should skip processing when the video no longer exists', async () => {
    videoRepository.findOneBy.mockResolvedValue(null);

    await expect(processor.process(buildJob())).resolves.toBeUndefined();

    expect(storageService.downloadToFile).not.toHaveBeenCalled();
  });
});
