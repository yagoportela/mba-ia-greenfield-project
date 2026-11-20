import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';

import { ChannelsService } from '../channels/channels.service';
import type { Channel } from '../channels/entities/channel.entity';
import {
  FileTooLargeException,
  InvalidUploadStateException,
  StorageException,
  UnsupportedMediaTypeException,
  UploadIncompleteException,
  VideoAccessDeniedException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { VideoQueueService } from '../queue/video-queue.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import type { CreateVideoDto } from './dto/create-video.dto';
import { VideosService } from './videos.service';

const VALID_DTO: CreateVideoDto = {
  originalFilename: 'meu-video.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 104857600,
};

function buildSavedVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-id',
    public_id: 'AbCdEf123456',
    channel_id: 'channel-1',
    title: null,
    original_filename: 'meu-video.mp4',
    storage_key: 'videos/video-id/original.mp4',
    thumbnail_key: null,
    upload_id: 'upload-1',
    mime_type: 'video/mp4',
    size_bytes: '104857600',
    duration_seconds: null,
    width: null,
    height: null,
    status: VideoStatus.Draft,
    failure_reason: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    channel: { id: 'channel-1', user_id: 'user-1' } as Channel,
    ...overrides,
  };
}

function buildUniqueViolation(column: string): QueryFailedError {
  const driverError = Object.assign(
    new Error('duplicate key value violates unique constraint'),
    {
      code: '23505',
      detail: `Key (${column})=(value) already exists.`,
    },
  );
  return new QueryFailedError('INSERT INTO videos', [], driverError);
}

describe('VideosService (unit)', () => {
  let service: VideosService;
  const videoRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
  };
  const storageService = {
    buildOriginalKey: jest.fn(
      (videoId: string, extension: string) =>
        `videos/${videoId}/original.${extension}`,
    ),
    createMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    presignGetObject: jest.fn(),
    downloadToFile: jest.fn(),
    uploadFile: jest.fn(),
  };
  const channelsService = {
    findByUserId: jest.fn(),
  };
  const videoQueueService = {
    enqueueProcessing: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    videoRepository.create.mockImplementation(
      (input: Partial<Video>) => input,
    );

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        { provide: ChannelsService, useValue: channelsService },
        { provide: VideoQueueService, useValue: videoQueueService },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  function mockSuccessfulDraft(): void {
    channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
    storageService.createMultipartUpload.mockResolvedValue({
      uploadId: 'upload-1',
    });
    videoRepository.save.mockImplementation(
      (entity: Partial<Video>) =>
        buildSavedVideo(entity as Partial<Video>),
    );
  }

  it('should create a draft with key layout, upload id and part count', async () => {
    mockSuccessfulDraft();

    const result = await service.createDraft('user-1', VALID_DTO);

    expect(storageService.buildOriginalKey).toHaveBeenCalledWith(
      expect.any(String),
      'mp4',
    );
    const [videoId] = storageService.buildOriginalKey.mock.calls[0] as [
      string,
      string,
    ];
    expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
      `videos/${videoId}/original.mp4`,
      'video/mp4',
    );

    const savedInput = videoRepository.create.mock.calls[0][0] as Video;
    expect(savedInput.id).toBe(videoId);
    expect(savedInput.public_id).toHaveLength(12);
    expect(savedInput.channel_id).toBe('channel-1');
    expect(savedInput.status).toBe(VideoStatus.Draft);
    expect(savedInput.upload_id).toBe('upload-1');
    expect(savedInput.storage_key).toBe(
      `videos/${videoId}/original.mp4`,
    );
    expect(savedInput.size_bytes).toBe('104857600');

    expect(result).toEqual({
      id: videoId,
      publicId: savedInput.public_id,
      status: VideoStatus.Draft,
      partSizeBytes: 67108864,
      partCount: 2,
    });
  });

  it('should retry with a new public_id when the unique constraint collides', async () => {
    mockSuccessfulDraft();
    videoRepository.save
      .mockRejectedValueOnce(buildUniqueViolation('public_id'))
      .mockImplementation((entity: Partial<Video>) =>
        buildSavedVideo(entity as Partial<Video>),
      );

    await service.createDraft('user-1', VALID_DTO);

    expect(videoRepository.save).toHaveBeenCalledTimes(2);
    const firstPublicId = (
      videoRepository.create.mock.calls[0][0] as Video
    ).public_id;
    const secondPublicId = (
      videoRepository.create.mock.calls[1][0] as Video
    ).public_id;
    expect(firstPublicId).not.toBe(secondPublicId);
  });

  it('should throw StorageException when the multipart session cannot be created', async () => {
    channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
    storageService.createMultipartUpload.mockRejectedValue(
      new Error('storage down'),
    );

    await expect(
      service.createDraft('user-1', VALID_DTO),
    ).rejects.toBeInstanceOf(StorageException);
    expect(videoRepository.save).not.toHaveBeenCalled();
  });

  it('should reject a mime type outside the allowlist', async () => {
    await expect(
      service.createDraft('user-1', {
        ...VALID_DTO,
        originalFilename: 'doc.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);

    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('should reject a filename extension that does not match the mime type', async () => {
    await expect(
      service.createDraft('user-1', {
        ...VALID_DTO,
        originalFilename: 'clip.webm',
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
  });

  it('should reject a declared size above 10 GiB', async () => {
    await expect(
      service.createDraft('user-1', {
        ...VALID_DTO,
        sizeBytes: 10737418241,
      }),
    ).rejects.toBeInstanceOf(FileTooLargeException);

    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('should throw VideoNotFoundException when the video does not exist', async () => {
    videoRepository.findOne.mockResolvedValue(null);

    await expect(
      service.findOwnedById('user-1', 'missing-id'),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });

  it('should throw VideoAccessDeniedException when the channel belongs to another user', async () => {
    videoRepository.findOne.mockResolvedValue(
      buildSavedVideo({
        channel: { id: 'channel-2', user_id: 'other-user' } as Channel,
      }),
    );

    await expect(
      service.findOwnedById('user-1', 'video-id'),
    ).rejects.toBeInstanceOf(VideoAccessDeniedException);
  });

  it('should return a draft detail with a null thumbnail URL', async () => {
    videoRepository.findOne.mockResolvedValue(buildSavedVideo());

    const detail = await service.findOwnedById('user-1', 'video-id');

    expect(detail.thumbnailUrl).toBeNull();
    expect(storageService.presignGetObject).not.toHaveBeenCalled();
    expect(detail.sizeBytes).toBe(104857600);
    expect(detail.durationSeconds).toBeNull();
  });

  it('should presign the thumbnail URL for a ready video', async () => {
    videoRepository.findOne.mockResolvedValue(
      buildSavedVideo({
        status: VideoStatus.Ready,
        thumbnail_key: 'videos/video-id/thumbnail.jpg',
      }),
    );
    storageService.presignGetObject.mockResolvedValue(
      'http://localhost:9000/bucket/thumbnail',
    );

    const detail = await service.findOwnedById('user-1', 'video-id');

    expect(detail.thumbnailUrl).toBe(
      'http://localhost:9000/bucket/thumbnail',
    );
    expect(storageService.presignGetObject).toHaveBeenCalledWith(
      'videos/video-id/thumbnail.jpg',
    );
  });

  it('should throw StorageException when the thumbnail cannot be presigned', async () => {
    videoRepository.findOne.mockResolvedValue(
      buildSavedVideo({
        status: VideoStatus.Ready,
        thumbnail_key: 'videos/video-id/thumbnail.jpg',
      }),
    );
    storageService.presignGetObject.mockRejectedValue(
      new Error('storage down'),
    );

    await expect(
      service.findOwnedById('user-1', 'video-id'),
    ).rejects.toBeInstanceOf(StorageException);
  });

  it('should presign one URL per requested part with a 3600s TTL', async () => {
    videoRepository.findOne.mockResolvedValue(buildSavedVideo());
    storageService.presignUploadPart = jest.fn(
      (_key: string, _uploadId: string, partNumber: number) =>
        Promise.resolve(`http://public/bucket/part-${partNumber}`),
    );

    const parts = await service.presignUploadParts('user-1', 'video-id', [
      1, 2,
    ]);

    expect(storageService.presignUploadPart).toHaveBeenCalledTimes(2);
    expect(storageService.presignUploadPart).toHaveBeenCalledWith(
      'videos/video-id/original.mp4',
      'upload-1',
      1,
    );
    expect(storageService.presignUploadPart).toHaveBeenCalledWith(
      'videos/video-id/original.mp4',
      'upload-1',
      2,
    );
    expect(parts).toEqual([
      {
        partNumber: 1,
        url: 'http://public/bucket/part-1',
        expiresInSeconds: 3600,
      },
      {
        partNumber: 2,
        url: 'http://public/bucket/part-2',
        expiresInSeconds: 3600,
      },
    ]);
  });

  it('should reject presigning when the video is not a draft', async () => {
    videoRepository.findOne.mockResolvedValue(
      buildSavedVideo({ status: VideoStatus.Processing }),
    );

    await expect(
      service.presignUploadParts('user-1', 'video-id', [1]),
    ).rejects.toBeInstanceOf(InvalidUploadStateException);
    expect(storageService.presignUploadPart).not.toHaveBeenCalled();
  });

  it('should reject presigning when the draft has no upload id', async () => {
    videoRepository.findOne.mockResolvedValue(
      buildSavedVideo({ upload_id: null }),
    );

    await expect(
      service.presignUploadParts('user-1', 'video-id', [1]),
    ).rejects.toBeInstanceOf(InvalidUploadStateException);
  });

  it('should throw StorageException when a part cannot be presigned', async () => {
    videoRepository.findOne.mockResolvedValue(buildSavedVideo());
    storageService.presignUploadPart = jest.fn(() =>
      Promise.reject(new Error('storage down')),
    );

    await expect(
      service.presignUploadParts('user-1', 'video-id', [1]),
    ).rejects.toBeInstanceOf(StorageException);
  });

  it('should complete the upload, update the video and enqueue processing', async () => {
    videoRepository.findOne.mockResolvedValue(buildSavedVideo());
    storageService.completeMultipartUpload = jest.fn(() =>
      Promise.resolve(undefined),
    );
    storageService.headObject = jest.fn(() =>
      Promise.resolve({
        contentLength: 104857600,
        contentType: 'video/mp4',
        etag: '"etag"',
      }),
    );
    videoRepository.save.mockImplementation(
      (entity: Partial<Video>) =>
        buildSavedVideo(entity as Partial<Video>),
    );

    const result = await service.completeUpload('user-1', 'video-id', {
      parts: [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
      ],
    });

    expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
      'videos/video-id/original.mp4',
      'upload-1',
      [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
      ],
    );

    const savedInput = videoRepository.save.mock.calls[0][0] as Video;
    expect(savedInput.status).toBe(VideoStatus.Processing);
    expect(savedInput.upload_id).toBeNull();
    expect(savedInput.size_bytes).toBe('104857600');
    expect(savedInput.failure_reason).toBeNull();

    expect(videoQueueService.enqueueProcessing).toHaveBeenCalledWith(
      'video-id',
    );
    expect(result).toEqual({
      id: 'video-id',
      publicId: 'AbCdEf123456',
      status: VideoStatus.Processing,
    });
  });

  it('should reject an upload whose parts do not cover the file', async () => {
    videoRepository.findOne.mockResolvedValue(buildSavedVideo());

    await expect(
      service.completeUpload('user-1', 'video-id', { parts: [] }),
    ).rejects.toBeInstanceOf(UploadIncompleteException);

    await expect(
      service.completeUpload('user-1', 'video-id', {
        parts: [{ partNumber: 1, etag: '"etag-1"' }],
      }),
    ).rejects.toBeInstanceOf(UploadIncompleteException);

    expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    expect(videoQueueService.enqueueProcessing).not.toHaveBeenCalled();
  });

  it('should reject completion when the video is no longer a draft', async () => {
    videoRepository.findOne.mockResolvedValue(
      buildSavedVideo({ status: VideoStatus.Processing }),
    );

    await expect(
      service.completeUpload('user-1', 'video-id', {
        parts: [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 2, etag: '"etag-2"' },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidUploadStateException);
  });

  it('should reject completion when the real object exceeds 10 GiB', async () => {
    videoRepository.findOne.mockResolvedValue(buildSavedVideo());
    storageService.completeMultipartUpload = jest.fn(() =>
      Promise.resolve(undefined),
    );
    storageService.headObject = jest.fn(() =>
      Promise.resolve({
        contentLength: 10737418241,
        contentType: 'video/mp4',
        etag: '"etag"',
      }),
    );

    await expect(
      service.completeUpload('user-1', 'video-id', {
        parts: [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 2, etag: '"etag-2"' },
        ],
      }),
    ).rejects.toBeInstanceOf(FileTooLargeException);

    expect(videoRepository.save).not.toHaveBeenCalled();
    expect(videoQueueService.enqueueProcessing).not.toHaveBeenCalled();
  });

  it('should reject completion when the real content type is not allowed', async () => {
    videoRepository.findOne.mockResolvedValue(buildSavedVideo());
    storageService.completeMultipartUpload = jest.fn(() =>
      Promise.resolve(undefined),
    );
    storageService.headObject = jest.fn(() =>
      Promise.resolve({
        contentLength: 104857600,
        contentType: 'application/pdf',
        etag: '"etag"',
      }),
    );

    await expect(
      service.completeUpload('user-1', 'video-id', {
        parts: [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 2, etag: '"etag-2"' },
        ],
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);

    expect(videoQueueService.enqueueProcessing).not.toHaveBeenCalled();
  });

  it('should throw StorageException when the multipart cannot be completed', async () => {
    videoRepository.findOne.mockResolvedValue(buildSavedVideo());
    storageService.completeMultipartUpload = jest.fn(() =>
      Promise.reject(new Error('storage down')),
    );

    await expect(
      service.completeUpload('user-1', 'video-id', {
        parts: [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 2, etag: '"etag-2"' },
        ],
      }),
    ).rejects.toBeInstanceOf(StorageException);

    expect(videoQueueService.enqueueProcessing).not.toHaveBeenCalled();
  });
});
