import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import queueConfig from '../config/queue.config';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESSING_SWEEP_QUEUE,
} from '../videos/videos.constants';
import { VideoQueueService } from './video-queue.service';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: config.host,
          port: config.port,
          ...(config.password ? { password: config.password } : {}),
        },
      }),
    }),
    BullModule.registerQueue(
      { name: VIDEO_PROCESSING_QUEUE },
      { name: VIDEO_PROCESSING_SWEEP_QUEUE },
    ),
  ],
  providers: [VideoQueueService],
  exports: [BullModule, VideoQueueService],
})
export class QueueModule {}
