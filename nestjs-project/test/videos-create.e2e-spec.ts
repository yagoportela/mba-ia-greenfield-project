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
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

const BUCKET = process.env.S3_BUCKET ?? 'streamtube-videos';
const PUBLIC_ENDPOINT =
  process.env.S3_PUBLIC_ENDPOINT ?? 'http://localhost:9000';

interface CreateVideoResponse {
  id: string;
  publicId: string;
  status: string;
  partSizeBytes: number;
  partCount: number;
}

interface ErrorResponse {
  error: string;
}

interface VideoResponse {
  id: string;
  publicId: string;
  status: string;
  thumbnailUrl: string | null;
}

function bodyOf<T>(response: { body: unknown }): T {
  return response.body as T;
}

describe('videos-create (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let s3Client: S3Client;
  const uploadedKeys: string[] = [];

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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
    const videos = await dataSource.getRepository(Video).find();
    for (const video of videos) {
      if (video.upload_id) {
        await storage.abortMultipartUpload(video.storage_key, video.upload_id);
      }
      if (video.thumbnail_key) {
        uploadedKeys.push(video.thumbnail_key);
      }
    }

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

  function createVideoRequest(token: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  it('creates a draft video and persists the upload session', async () => {
    const token = await registerConfirmAndLogin('creator@example.com');

    const response = await createVideoRequest(token, {
      originalFilename: 'meu-video.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 104857600,
    }).expect(201);

    const body = bodyOf<CreateVideoResponse>(response);
    expect(body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.publicId).toHaveLength(12);
    expect(body.status).toBe('draft');
    expect(body.partSizeBytes).toBe(67108864);
    expect(body.partCount).toBe(2);

    const saved = await dataSource
      .getRepository(Video)
      .findOneBy({ id: body.id });
    expect(saved).not.toBeNull();
    expect(saved!.status).toBe('draft');
    expect(saved!.upload_id).toBeTruthy();
    expect(saved!.storage_key).toBe(`videos/${body.id}/original.mp4`);
  });

  it('rejects unsupported media types with UNSUPPORTED_MEDIA_TYPE', async () => {
    const token = await registerConfirmAndLogin('media@example.com');

    const pdfResponse = await createVideoRequest(token, {
      originalFilename: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1048576,
    }).expect(415);
    expect(bodyOf<ErrorResponse>(pdfResponse).error).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );

    const movResponse = await createVideoRequest(token, {
      originalFilename: 'clipe.mov',
      mimeType: 'video/quicktime',
      sizeBytes: 1048576,
    }).expect(415);
    expect(bodyOf<ErrorResponse>(movResponse).error).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );

    const count = await dataSource.getRepository(Video).count();
    expect(count).toBe(0);
  });

  it('rejects files above 10 GiB with FILE_TOO_LARGE', async () => {
    const token = await registerConfirmAndLogin('large@example.com');

    const response = await createVideoRequest(token, {
      originalFilename: 'grande.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 10737418241,
    }).expect(413);

    expect(bodyOf<ErrorResponse>(response).error).toBe('FILE_TOO_LARGE');
    const count = await dataSource.getRepository(Video).count();
    expect(count).toBe(0);
  });

  it('rejects unauthenticated requests', async () => {
    const body = {
      originalFilename: 'meu-video.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1048576,
    };

    await request(app.getHttpServer()).post('/videos').send(body).expect(401);

    await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', 'Bearer token-invalido')
      .send(body)
      .expect(401);

    const count = await dataSource.getRepository(Video).count();
    expect(count).toBe(0);
  });

  it('rejects access to a video owned by another user', async () => {
    const ownerToken = await registerConfirmAndLogin('owner@example.com');
    const intruderToken = await registerConfirmAndLogin('intruder@example.com');

    const createdResponse = await createVideoRequest(ownerToken, {
      originalFilename: 'meu-video.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 104857600,
    }).expect(201);
    const created = bodyOf<CreateVideoResponse>(createdResponse);

    const response = await request(app.getHttpServer())
      .get(`/videos/${created.id}`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(403);

    expect(bodyOf<ErrorResponse>(response).error).toBe('VIDEO_ACCESS_DENIED');
  });

  it('returns VIDEO_NOT_FOUND for an unknown video id', async () => {
    const token = await registerConfirmAndLogin('notfound@example.com');

    const response = await request(app.getHttpServer())
      .get(`/videos/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    expect(bodyOf<ErrorResponse>(response).error).toBe('VIDEO_NOT_FOUND');
  });

  it('returns a draft video with thumbnailUrl null', async () => {
    const token = await registerConfirmAndLogin('draft@example.com');

    const createdResponse = await createVideoRequest(token, {
      originalFilename: 'meu-video.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 104857600,
    }).expect(201);
    const created = bodyOf<CreateVideoResponse>(createdResponse);

    const response = await request(app.getHttpServer())
      .get(`/videos/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = bodyOf<VideoResponse>(response);
    expect(body.status).toBe('draft');
    expect(body.thumbnailUrl).toBeNull();
    expect(body.publicId).toBe(created.publicId);
  });

  it('returns a presigned thumbnail URL for a ready video', async () => {
    const token = await registerConfirmAndLogin('ready@example.com');

    const createdResponse = await createVideoRequest(token, {
      originalFilename: 'meu-video.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 104857600,
    }).expect(201);
    const videoId = bodyOf<CreateVideoResponse>(createdResponse).id;
    const thumbnailKey = `videos/${videoId}/thumbnail.jpg`;

    const dir = await mkdtemp(join(tmpdir(), 'videos-e2e-'));
    const filePath = join(dir, 'thumbnail.jpg');
    await writeFile(filePath, Buffer.from('fake-jpeg-content'));
    await storage.uploadFile(thumbnailKey, filePath, 'image/jpeg');
    uploadedKeys.push(thumbnailKey);
    await rm(dir, { recursive: true, force: true });

    await dataSource.getRepository(Video).update(videoId, {
      status: VideoStatus.Ready,
      thumbnail_key: thumbnailKey,
    });

    const response = await request(app.getHttpServer())
      .get(`/videos/${videoId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const thumbnailUrl = bodyOf<VideoResponse>(response).thumbnailUrl;
    expect(thumbnailUrl).toBeTruthy();
    const parsedUrl = new URL(thumbnailUrl as string);
    expect(parsedUrl.origin).toBe(PUBLIC_ENDPOINT);
    expect(parsedUrl.searchParams.get('X-Amz-Expires')).toBe('3600');
  });
});
