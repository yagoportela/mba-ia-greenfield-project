import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator } from 'typeorm';

import { VideoQueueService } from '../queue/video-queue.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { ReconciliationService } from './reconciliation.service';

describe('ReconciliationService (unit)', () => {
  let service: ReconciliationService;
  const videoRepository = {
    find: jest.fn(),
    remove: jest.fn(),
  };
  const storageService = {
    abortMultipartUpload: jest.fn(),
  };
  const videoQueueService = {
    enqueueProcessing: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        ReconciliationService,
        {
          provide: getRepositoryToken(Video),
          useValue: videoRepository,
        },
        { provide: StorageService, useValue: storageService },
        { provide: VideoQueueService, useValue: videoQueueService },
      ],
    }).compile();

    service = module.get(ReconciliationService);
  });

  it('should re-enqueue videos stuck in processing for over 30 minutes', async () => {
    videoRepository.find.mockResolvedValue([
      { id: 'video-1' },
      { id: 'video-2' },
    ]);

    const count = await service.reconcileStuckProcessing();

    expect(count).toBe(2);
    expect(videoQueueService.enqueueProcessing).toHaveBeenCalledTimes(2);
    expect(videoQueueService.enqueueProcessing).toHaveBeenCalledWith(
      'video-1',
    );
    expect(videoQueueService.enqueueProcessing).toHaveBeenCalledWith(
      'video-2',
    );

    const query = videoRepository.find.mock.calls[0][0] as {
      where: {
        status: VideoStatus;
        updated_at: FindOperator<Date>;
      };
      select: string[];
    };
    expect(query.where.status).toBe(VideoStatus.Processing);
    expect(query.select).toEqual(['id']);

    const cutoff = query.where.updated_at.value as Date;
    const ageMs = Date.now() - cutoff.getTime();
    expect(ageMs).toBeGreaterThan(30 * 60 * 1000 - 5000);
    expect(ageMs).toBeLessThan(30 * 60 * 1000 + 5000);
  });

  it('should abort and remove drafts created over 24 hours ago', async () => {
    videoRepository.find.mockResolvedValue([
      {
        id: 'video-1',
        storage_key: 'videos/video-1/original.mp4',
        upload_id: 'upload-1',
      },
      {
        id: 'video-2',
        storage_key: 'videos/video-2/original.mp4',
        upload_id: null,
      },
    ]);
    videoRepository.remove.mockResolvedValue(undefined);
    storageService.abortMultipartUpload.mockResolvedValue(undefined);

    const count = await service.abortAbandonedUploads();

    expect(count).toBe(2);
    expect(storageService.abortMultipartUpload).toHaveBeenCalledTimes(1);
    expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/video-1/original.mp4',
      'upload-1',
    );
    expect(videoRepository.remove).toHaveBeenCalledTimes(2);

    const query = videoRepository.find.mock.calls[0][0] as {
      where: {
        status: VideoStatus;
        upload_id: FindOperator<unknown>;
        created_at: FindOperator<Date>;
      };
    };
    expect(query.where.status).toBe(VideoStatus.Draft);
    expect(query.where.upload_id.type).toBe('not');

    const cutoff = query.where.created_at.value as Date;
    const ageMs = Date.now() - cutoff.getTime();
    expect(ageMs).toBeGreaterThan(24 * 60 * 60 * 1000 - 5000);
    expect(ageMs).toBeLessThan(24 * 60 * 60 * 1000 + 5000);
  });

  it('should still remove the row when the multipart was already aborted', async () => {
    videoRepository.find.mockResolvedValue([
      {
        id: 'video-1',
        storage_key: 'videos/video-1/original.mp4',
        upload_id: 'upload-1',
      },
    ]);
    videoRepository.remove.mockResolvedValue(undefined);
    storageService.abortMultipartUpload.mockRejectedValue(
      Object.assign(new Error('upload not found'), {
        name: 'NoSuchUpload',
      }),
    );

    const count = await service.abortAbandonedUploads();

    expect(count).toBe(1);
    expect(videoRepository.remove).toHaveBeenCalledTimes(1);
  });

  it('should propagate unexpected abort failures without removing the row', async () => {
    videoRepository.find.mockResolvedValue([
      {
        id: 'video-1',
        storage_key: 'videos/video-1/original.mp4',
        upload_id: 'upload-1',
      },
    ]);
    storageService.abortMultipartUpload.mockRejectedValue(
      new Error('storage down'),
    );

    await expect(service.abortAbandonedUploads()).rejects.toThrow(
      'storage down',
    );
    expect(videoRepository.remove).not.toHaveBeenCalled();
  });

  it('should do nothing when there are no matching videos', async () => {
    videoRepository.find.mockResolvedValue([]);

    await expect(service.reconcileStuckProcessing()).resolves.toBe(0);
    await expect(service.abortAbandonedUploads()).resolves.toBe(0);

    expect(videoQueueService.enqueueProcessing).not.toHaveBeenCalled();
    expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
  });
});
