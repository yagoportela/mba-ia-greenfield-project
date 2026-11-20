import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';

import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { QueueModule } from './queue.module';
import { VideoQueueService } from './video-queue.service';

describe('QueueModule', () => {
  it('should compile with BullModule.forRootAsync + registerQueue and connect to Redis', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    try {
      const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
      const counts = await queue.getJobCounts();

      expect(module.get(VideoQueueService)).toBeInstanceOf(VideoQueueService);
      expect(counts).toBeDefined();
    } finally {
      await module.close();
    }
  }, 30000);

  it('should keep a single job while the same videoId is enqueued twice (jobId dedupe)', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    const videoId = `queue-dedupe-${randomUUID()}`;
    const service = module.get(VideoQueueService);
    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    try {
      await queue.pause();
      await service.enqueueProcessing(videoId);
      await service.enqueueProcessing(videoId);

      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs.filter((job) => job.id === videoId)).toHaveLength(1);
    } finally {
      const job = await queue.getJob(videoId);
      await job?.remove().catch(() => undefined);
      await queue.resume();
      await module.close();
    }
  }, 30000);
});
