import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  Module,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';

import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { VideosModule } from '../videos/videos.module';
import { VIDEO_PROCESSING_SWEEP_QUEUE } from '../videos/videos.constants';
import { MediaToolsService } from './media-tools.service';
import {
  ReconciliationProcessor,
  SWEEP_INTERVAL_MS,
  SWEEP_JOB_ID,
  SWEEP_JOB_NAME,
} from './reconciliation.processor';
import { ReconciliationService } from './reconciliation.service';
import { VideoProcessingProcessor } from './video-processing.processor';

@Injectable()
class SweepScheduler implements OnModuleInit {
  private readonly logger = new Logger(SweepScheduler.name);

  constructor(
    @InjectQueue(VIDEO_PROCESSING_SWEEP_QUEUE)
    private readonly sweepQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.sweepQueue.add(
      SWEEP_JOB_NAME,
      {},
      {
        repeat: { every: SWEEP_INTERVAL_MS },
        jobId: SWEEP_JOB_ID,
      },
    );

    this.logger.log(
      'Reconciliation sweep scheduled every 15 minutes',
    );
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, queueConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    QueueModule,
    VideosModule,
    UsersModule,
    StorageModule,
  ],
  providers: [
    MediaToolsService,
    VideoProcessingProcessor,
    ReconciliationService,
    ReconciliationProcessor,
    SweepScheduler,
  ],
})
export class WorkerModule {}
