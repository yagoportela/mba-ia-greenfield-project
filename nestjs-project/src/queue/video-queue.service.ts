import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';

export const VIDEO_PROCESSING_JOB = 'process-video';

export interface VideoProcessingJobData {
  videoId: string;
}

@Injectable()
export class VideoQueueService {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<VideoProcessingJobData>,
  ) {}

  async enqueueProcessing(videoId: string): Promise<void> {
    await this.processingQueue.add(
      VIDEO_PROCESSING_JOB,
      { videoId },
      {
        jobId: videoId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30000 },
        removeOnComplete: { age: 3600, count: 1000 },
      },
    );
  }
}
