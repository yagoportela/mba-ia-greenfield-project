import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from 'typeorm';

import type { VideoProcessingJobData } from '../queue/video-queue.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { MediaToolsService } from './media-tools.service';

const THUMBNAIL_POSITION_RATIO = 0.1;
const FAILURE_REASON_MAX_LENGTH = 255;

@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly mediaToolsService: MediaToolsService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });

    if (!video) {
      this.logger.warn(
        `Video "${job.data.videoId}" not found; skipping processing job`,
      );
      return;
    }

    const workDir = await mkdtemp(join(tmpdir(), 'video-processing-'));
    const originalPath = join(workDir, 'original');
    const thumbnailPath = join(workDir, 'thumbnail.jpg');

    try {
      await this.storageService.downloadToFile(video.storage_key, originalPath);

      const metadata = await this.mediaToolsService.probe(originalPath);

      if (!metadata.hasVideoStream || metadata.durationSeconds <= 0) {
        throw new Error('Uploaded file does not contain a valid video stream');
      }

      const thumbnailKey =
        video.thumbnail_key ?? this.storageService.buildThumbnailKey(video.id);

      await this.mediaToolsService.generateThumbnail(
        originalPath,
        thumbnailPath,
        metadata.durationSeconds * THUMBNAIL_POSITION_RATIO,
      );

      await this.storageService.uploadFile(
        thumbnailKey,
        thumbnailPath,
        'image/jpeg',
      );

      video.thumbnail_key = thumbnailKey;
      video.duration_seconds = metadata.durationSeconds.toFixed(3);
      video.width = metadata.width;
      video.height = metadata.height;
      video.status = VideoStatus.Ready;
      video.failure_reason = null;

      await this.videoRepository.save(video);
    } catch (error) {
      this.logger.error(
        `Video processing failed for "${job.data.videoId}"`,
        error instanceof Error ? error.stack : undefined,
      );

      if (this.isLastAttempt(job)) {
        await this.markAsFailed(video, error);
      }

      throw error;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private isLastAttempt(job: Job<VideoProcessingJobData>): boolean {
    const attempts = job.opts.attempts ?? 1;
    return job.attemptsMade + 1 >= attempts;
  }

  private async markAsFailed(video: Video, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    video.status = VideoStatus.Failed;
    video.failure_reason = message.slice(0, FAILURE_REASON_MAX_LENGTH);

    await this.videoRepository.save(video);
  }
}
