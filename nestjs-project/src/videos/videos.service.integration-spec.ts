import type { ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';

import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  VideoAccessDeniedException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { VideoQueueService } from '../queue/video-queue.service';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import type { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

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

const DTO: CreateVideoDto = {
  originalFilename: 'meu-video.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 104857600,
};

describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  const videoQueueService = { enqueueProcessing: jest.fn() };
  const openUploads: { key: string; uploadId: string }[] = [];
  const completedKeys: string[] = [];
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
        VideosService,
        ChannelsService,
        StorageService,
        { provide: storageConfig.KEY, useValue: TEST_CONFIG },
        { provide: VideoQueueService, useValue: videoQueueService },
      ],
    }).compile();

    service = moduleRef.get(VideosService);
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
  });

  afterEach(async () => {
    for (const upload of openUploads) {
      await storage.abortMultipartUpload(upload.key, upload.uploadId);
    }
    openUploads.length = 0;

    for (const key of completedKeys) {
      await cleanupClient.send(
        new DeleteObjectCommand({
          Bucket: TEST_CONFIG.bucket,
          Key: key,
        }),
      );
    }
    completedKeys.length = 0;
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Videos Channel ${counter}`,
        nickname: `videos_chan_${counter}`,
        user_id: user.id,
      }),
    );
    return { user, channel };
  }

  it('should persist a draft with a real multipart upload id and storage key', async () => {
    const { user, channel } = await createUserWithChannel();

    const result = await service.createDraft(user.id, DTO);

    expect(result.publicId).toHaveLength(12);
    expect(result.status).toBe(VideoStatus.Draft);
    expect(result.partSizeBytes).toBe(67108864);
    expect(result.partCount).toBe(2);

    const saved = await videoRepository.findOne({
      where: { id: result.id },
      relations: ['channel'],
    });
    expect(saved).not.toBeNull();
    expect(saved!.status).toBe(VideoStatus.Draft);
    expect(saved!.upload_id).toBeTruthy();
    expect(saved!.storage_key).toBe(`videos/${result.id}/original.mp4`);
    expect(saved!.channel_id).toBe(channel.id);
    expect(saved!.channel.user_id).toBe(user.id);

    openUploads.push({
      key: saved!.storage_key,
      uploadId: saved!.upload_id!,
    });
  });

  it('should return the detail to the owner and reject other users', async () => {
    const owner = await createUserWithChannel();
    const other = await createUserWithChannel();
    const created = await service.createDraft(owner.user.id, DTO);
    const saved = await videoRepository.findOneBy({ id: created.id });
    openUploads.push({
      key: saved!.storage_key,
      uploadId: saved!.upload_id!,
    });

    const detail = await service.findOwnedById(owner.user.id, created.id);
    expect(detail.status).toBe(VideoStatus.Draft);
    expect(detail.thumbnailUrl).toBeNull();

    await expect(
      service.findOwnedById(other.user.id, created.id),
    ).rejects.toBeInstanceOf(VideoAccessDeniedException);

    await expect(
      service.findOwnedById(owner.user.id, randomUUID()),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });

  it('should presign the thumbnail and convert numeric columns for a ready video', async () => {
    const { user } = await createUserWithChannel();
    const created = await service.createDraft(user.id, DTO);
    const saved = await videoRepository.findOneBy({ id: created.id });
    openUploads.push({
      key: saved!.storage_key,
      uploadId: saved!.upload_id!,
    });

    await videoRepository.update(created.id, {
      status: VideoStatus.Ready,
      thumbnail_key: `videos/${created.id}/thumbnail.jpg`,
      duration_seconds: '12.500',
      width: 1920,
      height: 1080,
      size_bytes: '2048',
    });

    const detail = await service.findOwnedById(user.id, created.id);

    expect(detail.status).toBe(VideoStatus.Ready);
    expect(detail.durationSeconds).toBe(12.5);
    expect(detail.width).toBe(1920);
    expect(detail.height).toBe(1080);
    expect(detail.sizeBytes).toBe(2048);
    expect(detail.thumbnailUrl).not.toBeNull();

    const thumbnailUrl = new URL(detail.thumbnailUrl!);
    expect(thumbnailUrl.origin).toBe(TEST_CONFIG.publicEndpoint);
    expect(thumbnailUrl.searchParams.get('X-Amz-Expires')).toBe('3600');
  });

  it('should complete a real multipart upload against MinIO and enqueue processing', async () => {
    const { user } = await createUserWithChannel();
    const created = await service.createDraft(user.id, {
      originalFilename: 'small.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1048576,
    });
    expect(created.partCount).toBe(1);

    const [part] = await service.presignUploadParts(user.id, created.id, [1]);
    const body = Buffer.alloc(1024 * 1024, 7);
    const putResponse = await fetch(part.url, {
      method: 'PUT',
      body,
    });
    expect(putResponse.ok).toBe(true);
    const etag = putResponse.headers.get('etag');
    expect(etag).toBeTruthy();

    const result = await service.completeUpload(user.id, created.id, {
      parts: [{ partNumber: 1, etag: etag! }],
    });

    expect(result.status).toBe(VideoStatus.Processing);

    const saved = await videoRepository.findOneBy({ id: created.id });
    expect(saved!.status).toBe(VideoStatus.Processing);
    expect(saved!.size_bytes).toBe('1048576');
    expect(saved!.upload_id).toBeNull();
    expect(videoQueueService.enqueueProcessing).toHaveBeenCalledWith(
      created.id,
    );

    completedKeys.push(saved!.storage_key);
  }, 60000);

  it('should sign playback and download URLs for the owner and enforce state/ownership', async () => {
    const owner = await createUserWithChannel();
    const other = await createUserWithChannel();

    const created = await service.createDraft(owner.user.id, {
      originalFilename: 'Meu Vídeo Ação.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1048576,
    });
    const saved = await videoRepository.findOneBy({ id: created.id });
    openUploads.push({
      key: saved!.storage_key,
      uploadId: saved!.upload_id!,
    });

    await expect(
      service.getPlaybackUrl(owner.user.id, created.publicId),
    ).rejects.toBeInstanceOf(VideoNotReadyException);

    await videoRepository.update(created.id, {
      status: VideoStatus.Ready,
    });

    const playback = await service.getPlaybackUrl(
      owner.user.id,
      created.publicId,
    );
    const playbackUrl = new URL(playback.url);
    expect(playbackUrl.origin).toBe(TEST_CONFIG.publicEndpoint);
    expect(playbackUrl.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(playbackUrl.searchParams.has('response-content-disposition')).toBe(
      false,
    );

    const ttlMs = new Date(playback.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(3500 * 1000);
    expect(ttlMs).toBeLessThan(3700 * 1000);

    const download = await service.getDownloadUrl(
      owner.user.id,
      created.publicId,
    );
    const downloadUrl = new URL(download.url);
    expect(downloadUrl.searchParams.get('response-content-disposition')).toBe(
      "attachment; filename*=UTF-8''Meu%20V%C3%ADdeo%20A%C3%A7%C3%A3o.mp4",
    );

    await expect(
      service.getPlaybackUrl(other.user.id, created.publicId),
    ).rejects.toBeInstanceOf(VideoAccessDeniedException);

    await expect(
      service.getPlaybackUrl(owner.user.id, 'MissingId123'),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });
});
