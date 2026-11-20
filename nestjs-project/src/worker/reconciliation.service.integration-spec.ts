import type { ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';

import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { VideoQueueService } from '../queue/video-queue.service';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { ReconciliationService } from './reconciliation.service';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

const TEST_CONFIG = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
  publicEndpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY ?? 'streamtube',
  secretKey: process.env.S3_SECRET_KEY ?? 'streamtube',
  bucket: process.env.S3_BUCKET ?? 'streamtube-videos',
  forcePathStyle: true,
} satisfies ConfigType<typeof storageConfig>;

describe('ReconciliationService (integration)', () => {
  let moduleRef: TestingModule;
  let service: ReconciliationService;
  let storage: StorageService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  const videoQueueService = { enqueueProcessing: jest.fn() };
  const openUploads: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
      ],
      providers: [
        ReconciliationService,
        StorageService,
        { provide: storageConfig.KEY, useValue: TEST_CONFIG },
        { provide: VideoQueueService, useValue: videoQueueService },
      ],
    }).compile();

    service = moduleRef.get(ReconciliationService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await cleanAllTables(dataSource);
  });

  afterEach(async () => {
    for (const upload of openUploads) {
      await storage
        .abortMultipartUpload(upload.key, upload.uploadId)
        .catch(() => undefined);
    }
    openUploads.length = 0;
  });

  let counter = 0;
  async function createVideo(
    status: VideoStatus,
    uploadId: string | null = null,
  ): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `recon_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Recon Channel ${counter}`,
        nickname: `recon_chan_${counter}`,
        user_id: user.id,
      }),
    );
    const id = randomUUID();

    return videoRepository.save(
      videoRepository.create({
        id,
        public_id: randomUUID().replace(/-/g, '').slice(0, 12),
        channel_id: channel.id,
        original_filename: 'original.mp4',
        storage_key: `videos/${id}/original.mp4`,
        upload_id: uploadId,
        mime_type: 'video/mp4',
        size_bytes: '1024',
        status,
      }),
    );
  }

  it('should re-enqueue only processing videos older than 30 minutes', async () => {
    const stuck = await createVideo(VideoStatus.Processing);
    const recent = await createVideo(VideoStatus.Processing);
    const readyOld = await createVideo(VideoStatus.Ready);

    await dataSource.query(
      `UPDATE "videos" SET "updated_at" = NOW() - INTERVAL '40 minutes' WHERE id = $1`,
      [stuck.id],
    );
    await dataSource.query(
      `UPDATE "videos" SET "updated_at" = NOW() - INTERVAL '40 minutes' WHERE id = $1`,
      [readyOld.id],
    );

    const count = await service.reconcileStuckProcessing();

    expect(count).toBe(1);
    expect(videoQueueService.enqueueProcessing).toHaveBeenCalledTimes(1);
    expect(videoQueueService.enqueueProcessing).toHaveBeenCalledWith(
      stuck.id,
    );
    expect(recent.id).not.toBe(stuck.id);
  });

  it('should abort and remove abandoned drafts older than 24 hours', async () => {
    const abandoned = await createVideo(VideoStatus.Draft);
    const { uploadId: abandonedUploadId } =
      await storage.createMultipartUpload(
        abandoned.storage_key,
        'video/mp4',
      );
    await videoRepository.update(abandoned.id, {
      upload_id: abandonedUploadId,
    });
    await dataSource.query(
      `UPDATE "videos" SET "created_at" = NOW() - INTERVAL '25 hours' WHERE id = $1`,
      [abandoned.id],
    );

    const recent = await createVideo(VideoStatus.Draft);
    const { uploadId: recentUploadId } =
      await storage.createMultipartUpload(recent.storage_key, 'video/mp4');
    await videoRepository.update(recent.id, {
      upload_id: recentUploadId,
    });
    openUploads.push({
      key: recent.storage_key,
      uploadId: recentUploadId,
    });

    const count = await service.abortAbandonedUploads();

    expect(count).toBe(1);
    await expect(
      videoRepository.findOneBy({ id: abandoned.id }),
    ).resolves.toBeNull();
    await expect(
      videoRepository.findOneBy({ id: recent.id }),
    ).resolves.not.toBeNull();

    await expect(
      storage.completeMultipartUpload(
        abandoned.storage_key,
        abandonedUploadId,
        [{ partNumber: 1, etag: '"etag"' }],
      ),
    ).rejects.toThrow();
  });
});
