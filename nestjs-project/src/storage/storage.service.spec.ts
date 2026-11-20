import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ConfigType } from '@nestjs/config';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

const TEST_CONFIG = {
  endpoint: 'http://minio-internal:9000',
  publicEndpoint: 'http://storage.example.test:9000',
  region: 'us-east-1',
  accessKey: 'test-access-key',
  secretKey: 'test-secret-key',
  bucket: 'test-bucket',
  forcePathStyle: true,
} satisfies ConfigType<typeof storageConfig>;

type SendSpy = jest.SpyInstance<Promise<unknown>, [unknown]>;

describe('StorageService (unit)', () => {
  let service: StorageService;
  let sendSpy: SendSpy;

  beforeEach(() => {
    service = new StorageService(TEST_CONFIG);
    sendSpy = jest.spyOn(
      S3Client.prototype as unknown as {
        send: (command: unknown) => Promise<unknown>;
      },
      'send',
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should build the original and thumbnail keys from the video id', () => {
    expect(service.buildOriginalKey('video-id', 'mp4')).toBe(
      'videos/video-id/original.mp4',
    );
    expect(service.buildThumbnailKey('video-id')).toBe(
      'videos/video-id/thumbnail.jpg',
    );
  });

  it('should send CreateMultipartUploadCommand and return the UploadId', async () => {
    sendSpy.mockResolvedValue({ UploadId: 'upload-abc' });

    const result = await service.createMultipartUpload(
      'videos/video-id/original.mp4',
      'video/mp4',
    );

    expect(result).toEqual({ uploadId: 'upload-abc' });
    const command = sendSpy.mock.calls[0][0] as CreateMultipartUploadCommand;
    expect(command).toBeInstanceOf(CreateMultipartUploadCommand);
    expect(command.input).toEqual({
      Bucket: 'test-bucket',
      Key: 'videos/video-id/original.mp4',
      ContentType: 'video/mp4',
    });
  });

  it('should presign upload parts against the public endpoint with a 3600s TTL', async () => {
    const url = await service.presignUploadPart(
      'videos/video-id/original.mp4',
      'upload-abc',
      2,
    );

    const parsed = new URL(url);
    expect(parsed.origin).toBe('http://storage.example.test:9000');
    expect(parsed.pathname).toBe('/test-bucket/videos/video-id/original.mp4');
    expect(parsed.searchParams.get('uploadId')).toBe('upload-abc');
    expect(parsed.searchParams.get('partNumber')).toBe('2');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(parsed.searchParams.has('x-amz-checksum-crc32')).toBe(false);
  });

  it('should send CompleteMultipartUploadCommand mapping parts to the SDK shape', async () => {
    sendSpy.mockResolvedValue({});

    await service.completeMultipartUpload('videos/video-id/original.mp4', 'upload-abc', [
      { partNumber: 1, etag: '"etag-1"' },
      { partNumber: 2, etag: '"etag-2"' },
    ]);

    const command = sendSpy.mock.calls[0][0] as CompleteMultipartUploadCommand;
    expect(command).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(command.input.Bucket).toBe('test-bucket');
    expect(command.input.Key).toBe('videos/video-id/original.mp4');
    expect(command.input.UploadId).toBe('upload-abc');
    expect(command.input.MultipartUpload?.Parts).toEqual([
      { PartNumber: 1, ETag: '"etag-1"' },
      { PartNumber: 2, ETag: '"etag-2"' },
    ]);
  });

  it('should send AbortMultipartUploadCommand for the given key and upload', async () => {
    sendSpy.mockResolvedValue({});

    await service.abortMultipartUpload('videos/video-id/original.mp4', 'upload-abc');

    const command = sendSpy.mock.calls[0][0] as AbortMultipartUploadCommand;
    expect(command).toBeInstanceOf(AbortMultipartUploadCommand);
    expect(command.input).toEqual({
      Bucket: 'test-bucket',
      Key: 'videos/video-id/original.mp4',
      UploadId: 'upload-abc',
    });
  });

  it('should map the HeadObject output to the public head shape', async () => {
    sendSpy.mockResolvedValue({
      ContentLength: 1234,
      ContentType: 'video/mp4',
      ETag: '"abc"',
    });

    const head = await service.headObject('videos/video-id/original.mp4');

    expect(head).toEqual({
      contentLength: 1234,
      contentType: 'video/mp4',
      etag: '"abc"',
    });
    const command = sendSpy.mock.calls[0][0] as HeadObjectCommand;
    expect(command).toBeInstanceOf(HeadObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'test-bucket',
      Key: 'videos/video-id/original.mp4',
    });
  });

  it('should presign a GET embedding the response content disposition', async () => {
    const url = await service.presignGetObject(
      'videos/video-id/original.mp4',
      {
        responseContentDisposition:
          'attachment; filename="my video.mp4"',
      },
    );

    const parsed = new URL(url);
    expect(parsed.origin).toBe('http://storage.example.test:9000');
    expect(parsed.pathname).toBe('/test-bucket/videos/video-id/original.mp4');
    expect(
      parsed.searchParams.get('response-content-disposition'),
    ).toBe('attachment; filename="my video.mp4"');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(parsed.searchParams.has('x-amz-checksum-mode')).toBe(false);
  });

  it('should upload a local file with PutObjectCommand including size and content type', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'storage-unit-'));
    const filePath = join(dir, 'original.bin');
    await writeFile(filePath, Buffer.from('hello storage'));
    sendSpy.mockResolvedValue({});

    try {
      await service.uploadFile(
        'videos/video-id/original.mp4',
        filePath,
        'video/mp4',
      );

      const command = sendSpy.mock.calls[0][0] as PutObjectCommand;
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input.Bucket).toBe('test-bucket');
      expect(command.input.Key).toBe('videos/video-id/original.mp4');
      expect(command.input.ContentType).toBe('video/mp4');
      expect(command.input.ContentLength).toBe(13);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('should stream a stored object to a local file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'storage-unit-'));
    const destinationPath = join(dir, 'downloaded.bin');
    sendSpy.mockResolvedValue({
      Body: Readable.from([Buffer.from('downloaded content')]),
    });

    try {
      await service.downloadToFile(
        'videos/video-id/original.mp4',
        destinationPath,
      );

      const content = await readFile(destinationPath);
      expect(content.toString()).toBe('downloaded content');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
