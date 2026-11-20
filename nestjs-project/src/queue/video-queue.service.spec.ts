import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';

import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { VideoQueueService } from './video-queue.service';

describe('VideoQueueService (unit)', () => {
  let service: VideoQueueService;
  const queue = { add: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        VideoQueueService,
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
      ],
    }).compile();

    service = module.get(VideoQueueService);
  });

  it('should enqueue a process-video job with deterministic jobId and retry policy', async () => {
    queue.add.mockResolvedValue({});

    await service.enqueueProcessing('video-1');

    expect(queue.add).toHaveBeenCalledWith(
      'process-video',
      { videoId: 'video-1' },
      {
        jobId: 'video-1',
        attempts: 3,
        backoff: { type: 'exponential', delay: 30000 },
        removeOnComplete: { age: 3600, count: 1000 },
      },
    );
  });
});
