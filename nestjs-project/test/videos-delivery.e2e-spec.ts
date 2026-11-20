import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';

import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

const BUCKET = process.env.S3_BUCKET ?? 'streamtube-videos';
const PUBLIC_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://minio:9000';

interface DeliveryResponse {
  url: string;
  expiresAt: string;
}

interface ErrorResponse {
  error: string;
}

function bodyOf<T>(response: { body: unknown }): T {
  return response.body as T;
}

describe('videos-delivery (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let s3Client: S3Client;
  const uploadedKeys: string[] = [];

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue({
        ...storageConfig(),
        publicEndpoint: PUBLIC_ENDPOINT,
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    s3Client = new S3Client({
      endpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? 'streamtube',
        secretAccessKey: process.env.S3_SECRET_KEY ?? 'streamtube',
      },
    });
  });

  afterAll(async () => {
    s3Client.destroy();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  afterEach(async () => {
    for (const key of uploadedKeys) {
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: key }),
      );
    }
    uploadedKeys.length = 0;
  });

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const mailService = app.get(MailService);
    let capturedToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_email, _name, token) => {
        capturedToken = token;
        return Promise.resolve();
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const loginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    return bodyOf<{ access_token: string }>(loginResponse).access_token;
  }

  async function prepareVideo(
    email: string,
    status: VideoStatus,
    originalFilename = 'meu-video.mp4',
  ): Promise<Video> {
    const user = await userRepository.findOneBy({ email });
    const channel = await channelRepository.findOneBy({
      user_id: user!.id,
    });
    const id = randomUUID();

    return videoRepository.save(
      videoRepository.create({
        id,
        public_id: randomUUID().replace(/-/g, '').slice(0, 12),
        channel_id: channel!.id,
        original_filename: originalFilename,
        storage_key: `videos/${id}/original.mp4`,
        mime_type: 'video/mp4',
        size_bytes: '2048',
        status,
      }),
    );
  }

  async function uploadOriginal(video: Video, content: Buffer): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'delivery-e2e-'));
    const filePath = join(dir, 'original.mp4');
    await writeFile(filePath, content);
    await storage.uploadFile(video.storage_key, filePath, 'video/mp4');
    await rm(dir, { recursive: true, force: true });
    uploadedKeys.push(video.storage_key);
  }

  function expectFreshExpiresAt(expiresAt: string): void {
    const ttlMs = new Date(expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(3500 * 1000);
    expect(ttlMs).toBeLessThan(3700 * 1000);
  }

  it('returns a presigned playback URL that supports range requests', async () => {
    const token = await registerConfirmAndLogin('playback@example.com');
    const video = await prepareVideo('playback@example.com', VideoStatus.Ready);
    const content = Buffer.alloc(2048, 0x61);
    await uploadOriginal(video, content);

    const response = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/playback`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const playback = bodyOf<DeliveryResponse>(response);
    const playbackUrl = new URL(playback.url);
    expect(playbackUrl.origin).toBe(PUBLIC_ENDPOINT);
    expect(playbackUrl.searchParams.get('X-Amz-Expires')).toBe('3600');
    expectFreshExpiresAt(playback.expiresAt);

    const rangeResponse = await fetch(playback.url, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get('content-range')).toBe(
      'bytes 0-1023/2048',
    );
    expect(rangeResponse.headers.get('content-length')).toBe('1024');
  });

  it('rejects playback while the video is not ready', async () => {
    const token = await registerConfirmAndLogin('processing@example.com');
    const video = await prepareVideo(
      'processing@example.com',
      VideoStatus.Processing,
    );

    const response = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/playback`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);

    expect(bodyOf<ErrorResponse>(response).error).toBe('VIDEO_NOT_READY');
  });

  it('rejects playback from a user who does not own the video', async () => {
    await registerConfirmAndLogin('owner@example.com');
    const intruderToken = await registerConfirmAndLogin('intruder@example.com');
    const video = await prepareVideo('owner@example.com', VideoStatus.Ready);
    await uploadOriginal(video, Buffer.from('owned-content'));

    const response = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/playback`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(403);

    expect(bodyOf<ErrorResponse>(response).error).toBe('VIDEO_ACCESS_DENIED');
  });

  it('returns a download URL with attachment disposition and the original filename', async () => {
    const token = await registerConfirmAndLogin('download@example.com');
    const video = await prepareVideo(
      'download@example.com',
      VideoStatus.Ready,
      'Meu Vídeo Ação.mp4',
    );
    const content = Buffer.from('original-video-bytes');
    await uploadOriginal(video, content);

    const response = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/download`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const download = bodyOf<DeliveryResponse>(response);
    const downloadUrl = new URL(download.url);
    expect(downloadUrl.origin).toBe(PUBLIC_ENDPOINT);
    expectFreshExpiresAt(download.expiresAt);

    const downloadResponse = await fetch(download.url);
    expect(downloadResponse.status).toBe(200);

    const disposition =
      downloadResponse.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    const filenameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    expect(filenameMatch).not.toBeNull();
    expect(decodeURIComponent(filenameMatch![1])).toBe('Meu Vídeo Ação.mp4');

    const body = Buffer.from(await downloadResponse.arrayBuffer());
    expect(body.equals(content)).toBe(true);
  });

  it('rejects anonymous playback and download requests', async () => {
    await registerConfirmAndLogin('anonymous@example.com');
    const video = await prepareVideo(
      'anonymous@example.com',
      VideoStatus.Ready,
    );

    await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/playback`)
      .expect(401);

    await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/download`)
      .expect(401);
  });
});
