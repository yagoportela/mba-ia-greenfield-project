import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { VIDEO_PROCESSING_SWEEP_QUEUE } from '../videos/videos.constants';
import { ReconciliationService } from './reconciliation.service';

export const SWEEP_JOB_NAME = 'sweep';
export const SWEEP_JOB_ID = 'video-processing-sweep';
export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

@Processor(VIDEO_PROCESSING_SWEEP_QUEUE)
export class ReconciliationProcessor extends WorkerHost {
  private readonly logger = new Logger(ReconciliationProcessor.name);

  constructor(
    private readonly reconciliationService: ReconciliationService,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    const requeued = await this.reconciliationService.reconcileStuckProcessing();
    const removed =
      await this.reconciliationService.abortAbandonedUploads();

    this.logger.log(
      `Reconciliation sweep finished: ${requeued} stuck processing re-enqueued, ${removed} abandoned uploads removed`,
    );
  }
}
