import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';

const BUCKET = process.env.S3_BUCKET ?? 'streamtube-videos';
const PUBLIC_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://minio:9000';

describe('videos-upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;
  let s3Client: S3Client;
  const createdVideoIds: string[] = [];

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
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
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
    const videoRepository = dataSource.getRepository(Video);

    for (const videoId of createdVideoIds) {
      const job = await queue.getJob(videoId);
      await job?.remove();
    }

    const videos = await videoRepository.find();
    for (const video of videos) {
      if (video.upload_id) {
        await storage.abortMultipartUpload(
          video.storage_key,
          video.upload_id,
        );
      } else {
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: video.storage_key,
          }),
        );
      }
    }

    createdVideoIds.length = 0;
  });

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
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

    return loginResponse.body.access_token as string;
  }

  async function createDraft(
    token: string,
    sizeBytes: number,
  ): Promise<{ id: string; publicId: string; partCount: number }> {
    const response = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        originalFilename: 'clipe.mp4',
        mimeType: 'video/mp4',
        sizeBytes,
      })
      .expect(201);

    createdVideoIds.push(response.body.id as string);
    return {
      id: response.body.id as string,
      publicId: response.body.publicId as string,
      partCount: response.body.partCount as number,
    };
  }

  async function presignPart(
    token: string,
    videoId: string,
    partNumber: number,
  ): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload-parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers: [partNumber] })
      .expect(200);

    return response.body.parts[0].url as string;
  }

  async function uploadPart(url: string, body: Buffer): Promise<string> {
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    expect(response.ok).toBe(true);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag!;
  }

  function completeUpload(
    token: string,
    videoId: string,
    parts: { partNumber: number; etag: string }[],
  ) {
    return request(app.getHttpServer())
      .post(`/videos/${videoId}/upload-complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts });
  }

  it('presigns upload parts with a 3600s TTL and supports re-signing', async () => {
    const token = await registerConfirmAndLogin('signer@example.com');
    const draft = await createDraft(token, 104857600);
    expect(draft.partCount).toBe(2);

    const response = await request(app.getHttpServer())
      .post(`/videos/${draft.id}/upload-parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers: [1, 2] })
      .expect(200);

    const parts = response.body.parts as {
      partNumber: number;
      url: string;
      expiresInSeconds: number;
    }[];
    expect(parts).toHaveLength(2);

    for (const [index, part] of parts.entries()) {
      expect(part.partNumber).toBe(index + 1);
      expect(part.expiresInSeconds).toBe(3600);

      const url = new URL(part.url);
      expect(url.origin).toBe(PUBLIC_ENDPOINT);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
      expect(url.searchParams.get('partNumber')).toBe(
        String(part.partNumber),
      );
    }

    const resigned = await request(app.getHttpServer())
      .post(`/videos/${draft.id}/upload-parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers: [2] })
      .expect(200);

    expect(resigned.body.parts).toHaveLength(1);
    expect(resigned.body.parts[0].partNumber).toBe(2);
    expect(
      new URL(resigned.body.parts[0].url as string).origin,
    ).toBe(PUBLIC_ENDPOINT);
  });

  it('rejects presigning parts for a video that left the draft state', async () => {
    const token = await registerConfirmAndLogin('completed@example.com');
    const draft = await createDraft(token, 1048576);

    const partUrl = await presignPart(token, draft.id, 1);
    const etag = await uploadPart(partUrl, Buffer.alloc(1024 * 1024, 3));
    await completeUpload(token, draft.id, [
      { partNumber: 1, etag },
    ]).expect(202);

    const response = await request(app.getHttpServer())
      .post(`/videos/${draft.id}/upload-parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers: [1] })
      .expect(409);

    expect(response.body.error).toBe('INVALID_UPLOAD_STATE');
  });

  it('completes the upload, transitions to processing and enqueues the job', async () => {
    const token = await registerConfirmAndLogin('complete@example.com');
    const draft = await createDraft(token, 1048576);
    expect(draft.partCount).toBe(1);

    const partUrl = await presignPart(token, draft.id, 1);
    const etag = await uploadPart(partUrl, Buffer.alloc(1024 * 1024, 5));

    const response = await completeUpload(token, draft.id, [
      { partNumber: 1, etag },
    ]).expect(202);

    expect(response.body).toEqual({
      id: draft.id,
      publicId: draft.publicId,
      status: 'processing',
    });

    const saved = await dataSource
      .getRepository(Video)
      .findOneBy({ id: draft.id });
    expect(saved!.status).toBe('processing');
    expect(saved!.size_bytes).toBe('1048576');
    expect(saved!.upload_id).toBeNull();

    const job = await queue.getJob(draft.id);
    expect(job).not.toBeNull();
    expect(job!.name).toBe('process-video');
  });

  it('rejects an incomplete parts list with UPLOAD_INCOMPLETE', async () => {
    const token = await registerConfirmAndLogin('incomplete@example.com');
    const draft = await createDraft(token, 1048576);

    const response = await completeUpload(token, draft.id, []).expect(400);

    expect(response.body.error).toBe('UPLOAD_INCOMPLETE');

    const saved = await dataSource
      .getRepository(Video)
      .findOneBy({ id: draft.id });
    expect(saved!.status).toBe('draft');
  });

  it('rejects a second completion with INVALID_UPLOAD_STATE and keeps a single job', async () => {
    const token = await registerConfirmAndLogin('duplicate@example.com');
    const draft = await createDraft(token, 1048576);

    const partUrl = await presignPart(token, draft.id, 1);
    const etag = await uploadPart(partUrl, Buffer.alloc(1024 * 1024, 9));

    await completeUpload(token, draft.id, [
      { partNumber: 1, etag },
    ]).expect(202);

    const response = await completeUpload(token, draft.id, [
      { partNumber: 1, etag },
    ]).expect(409);

    expect(response.body.error).toBe('INVALID_UPLOAD_STATE');

    const jobs = await queue.getJobs([
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed',
    ]);
    expect(jobs.filter((job) => job.id === draft.id)).toHaveLength(1);
  });
});
