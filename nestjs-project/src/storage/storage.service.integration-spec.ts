import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ConfigType } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

const TEST_CONFIG = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
  publicEndpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY ?? 'streamtube',
  secretKey: process.env.S3_SECRET_KEY ?? 'streamtube',
  bucket: process.env.S3_BUCKET ?? 'streamtube-videos',
  forcePathStyle: true,
} satisfies ConfigType<typeof storageConfig>;

describe('StorageService (integration)', () => {
  const service = new StorageService(TEST_CONFIG);
  const cleanupClient = new S3Client({
    endpoint: TEST_CONFIG.endpoint,
    region: TEST_CONFIG.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: TEST_CONFIG.accessKey,
      secretAccessKey: TEST_CONFIG.secretKey,
    },
  });
  const createdKeys: string[] = [];

  afterEach(async () => {
    for (const key of createdKeys) {
      await cleanupClient.send(
        new DeleteObjectCommand({ Bucket: TEST_CONFIG.bucket, Key: key }),
      );
    }
    createdKeys.length = 0;
  });

  afterAll(() => {
    cleanupClient.destroy();
  });

  it('should complete a real multipart upload and expose the object via presigned GET', async () => {
    const key = `videos/it-${randomUUID()}/original.mp4`;
    createdKeys.push(key);

    const firstPart = Buffer.alloc(5 * 1024 * 1024, 0x61);
    const lastPart = Buffer.from('last-part');

    const { uploadId } = await service.createMultipartUpload(key, 'video/mp4');

    const firstUrl = await service.presignUploadPart(key, uploadId, 1);
    const lastUrl = await service.presignUploadPart(key, uploadId, 2);

    const firstResponse = await fetch(firstUrl, {
      method: 'PUT',
      body: firstPart,
    });
    expect(firstResponse.ok).toBe(true);
    const firstEtag = firstResponse.headers.get('etag');
    expect(firstEtag).toBeTruthy();

    const lastResponse = await fetch(lastUrl, {
      method: 'PUT',
      body: lastPart,
    });
    expect(lastResponse.ok).toBe(true);
    const lastEtag = lastResponse.headers.get('etag');
    expect(lastEtag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: firstEtag! },
      { partNumber: 2, etag: lastEtag! },
    ]);

    const head = await service.headObject(key);
    expect(head.contentLength).toBe(firstPart.length + lastPart.length);
    expect(head.contentType).toBe('video/mp4');

    const getUrl = await service.presignGetObject(key);
    const getResponse = await fetch(getUrl);
    expect(getResponse.ok).toBe(true);

    const body = Buffer.from(await getResponse.arrayBuffer());
    expect(body.length).toBe(firstPart.length + lastPart.length);
    expect(body.subarray(0, 10).toString()).toBe('aaaaaaaaaa');
    expect(body.subarray(-9).toString()).toBe('last-part');
  }, 60000);

  it('should invalidate an aborted upload so a later complete fails', async () => {
    const key = `videos/it-${randomUUID()}/original.mp4`;
    createdKeys.push(key);

    const { uploadId } = await service.createMultipartUpload(key, 'video/mp4');
    await service.abortMultipartUpload(key, uploadId);

    await expect(
      service.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"etag-1"' },
      ]),
    ).rejects.toThrow();
  }, 30000);
});
