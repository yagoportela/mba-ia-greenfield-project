import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource, Repository } from 'typeorm';

import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import type { VideoProcessingJobData } from '../queue/video-queue.service';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { MediaToolsService } from './media-tools.service';
import { VideoProcessingProcessor } from './video-processing.processor';

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

describe('VideoProcessingProcessor (integration)', () => {
  let moduleRef: TestingModule;
  let processor: VideoProcessingProcessor;
  let storage: StorageService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  const mediaToolsService = {
    probe: jest.fn(),
    generateThumbnail: jest.fn(),
  };
  const createdKeys: string[] = [];
  const cleanupClient = new S3Client({
    endpoint: TEST_CONFIG.endpoint,
    region: TEST_CONFIG.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: TEST_CONFIG.accessKey,
      secretAccessKey: TEST_CONFIG.secretKey,
    },
  });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
      ],
      providers: [
        VideoProcessingProcessor,
        StorageService,
        { provide: storageConfig.KEY, useValue: TEST_CONFIG },
        { provide: MediaToolsService, useValue: mediaToolsService },
      ],
    }).compile();

    processor = moduleRef.get(VideoProcessingProcessor);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    cleanupClient.destroy();
    await moduleRef.close();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await cleanAllTables(dataSource);
    mediaToolsService.generateThumbnail.mockImplementation(
      async (_inputPath: string, outputPath: string) => {
        await writeFile(outputPath, Buffer.from('fake-thumbnail'));
      },
    );
  });

  afterEach(async () => {
    for (const key of createdKeys) {
      await cleanupClient.send(
        new DeleteObjectCommand({
          Bucket: TEST_CONFIG.bucket,
          Key: key,
        }),
      );
    }
    createdKeys.length = 0;
  });

  let counter = 0;
  async function createVideoRow(): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `worker_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Worker Channel ${counter}`,
        nickname: `worker_chan_${counter}`,
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
        mime_type: 'video/mp4',
        size_bytes: '1024',
        status: VideoStatus.Processing,
      }),
    );
  }

  async function uploadOriginal(video: Video): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'worker-it-'));
    const filePath = join(dir, 'original.mp4');
    await writeFile(filePath, Buffer.from('original-bytes'));
    await storage.uploadFile(video.storage_key, filePath, 'video/mp4');
    await rm(dir, { recursive: true, force: true });
    createdKeys.push(video.storage_key);
  }

  function buildJob(
    videoId: string,
    attemptsMade = 0,
    attempts = 3,
  ): Job<VideoProcessingJobData> {
    return {
      data: { videoId },
      attemptsMade,
      opts: { attempts },
    } as unknown as Job<VideoProcessingJobData>;
  }

  it('should process a real job against DB + MinIO and stay idempotent on retry', async () => {
    const video = await createVideoRow();
    await uploadOriginal(video);
    mediaToolsService.probe.mockResolvedValue({
      hasVideoStream: true,
      durationSeconds: 12.5,
      width: 640,
      height: 360,
      codecName: 'h264',
    });

    await processor.process(buildJob(video.id));

    let saved = await videoRepository.findOneBy({ id: video.id });
    expect(saved!.status).toBe(VideoStatus.Ready);
    expect(saved!.duration_seconds).toBe('12.500');
    expect(saved!.width).toBe(640);
    expect(saved!.height).toBe(360);
    expect(saved!.thumbnail_key).toBe(
      `videos/${video.id}/thumbnail.jpg`,
    );

    createdKeys.push(saved!.thumbnail_key!);
    const thumbnail = await storage.headObject(saved!.thumbnail_key!);
    expect(thumbnail.contentLength).toBeGreaterThan(0);
    expect(thumbnail.contentType).toBe('image/jpeg');

    await processor.process(buildJob(video.id));

    saved = await videoRepository.findOneBy({ id: video.id });
    expect(saved!.status).toBe(VideoStatus.Ready);
    expect(saved!.thumbnail_key).toBe(
      `videos/${video.id}/thumbnail.jpg`,
    );
  }, 60000);

  it('should mark the video as failed with a reason on the last attempt', async () => {
    const video = await createVideoRow();
    await uploadOriginal(video);
    mediaToolsService.probe.mockRejectedValue(
      new Error('invalid media stream'),
    );

    await expect(
      processor.process(buildJob(video.id, 2, 3)),
    ).rejects.toThrow('invalid media stream');

    const saved = await videoRepository.findOneBy({ id: video.id });
    expect(saved!.status).toBe(VideoStatus.Failed);
    expect(saved!.failure_reason).toContain('invalid media stream');
  }, 60000);
});
