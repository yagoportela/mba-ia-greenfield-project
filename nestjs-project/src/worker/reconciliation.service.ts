import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Not, Repository } from 'typeorm';

import { VideoQueueService } from '../queue/video-queue.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';

export const STUCK_PROCESSING_THRESHOLD_MS = 30 * 60 * 1000;
export const ABANDONED_UPLOAD_THRESHOLD_MS = 24 * 60 * 60 * 1000;

const NO_SUCH_UPLOAD_ERROR = 'NoSuchUpload';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly videoQueueService: VideoQueueService,
  ) {}

  async reconcileStuckProcessing(): Promise<number> {
    const cutoff = new Date(Date.now() - STUCK_PROCESSING_THRESHOLD_MS);

    const stuckVideos = await this.videoRepository.find({
      where: {
        status: VideoStatus.Processing,
        updated_at: LessThan(cutoff),
      },
      select: ['id'],
    });

    for (const video of stuckVideos) {
      await this.videoQueueService.enqueueProcessing(video.id);
    }

    return stuckVideos.length;
  }

  async abortAbandonedUploads(): Promise<number> {
    const cutoff = new Date(Date.now() - ABANDONED_UPLOAD_THRESHOLD_MS);

    const abandonedVideos = await this.videoRepository.find({
      where: {
        status: VideoStatus.Draft,
        upload_id: Not(IsNull()),
        created_at: LessThan(cutoff),
      },
    });

    for (const video of abandonedVideos) {
      if (video.upload_id) {
        try {
          await this.storageService.abortMultipartUpload(
            video.storage_key,
            video.upload_id,
          );
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.name !== NO_SUCH_UPLOAD_ERROR
          ) {
            throw error;
          }

          this.logger.warn(
            `Multipart upload for video "${video.id}" was already aborted`,
          );
        }
      }

      await this.videoRepository.remove(video);
    }

    return abandonedVideos.length;
  }
}
