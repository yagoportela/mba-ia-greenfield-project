import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import storageConfig from '../config/storage.config';

const DEFAULT_PRESIGNED_URL_TTL_SECONDS = 3600;

export interface CompletedUploadPart {
  partNumber: number;
  etag: string;
}

export interface ObjectHead {
  contentLength: number;
  contentType: string | null;
  etag: string | null;
}

export interface PresignGetObjectOptions {
  expiresInSeconds?: number;
  responseContentDisposition?: string;
}

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly publicClient: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    const clientConfig: S3ClientConfig = {
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };

    this.client = new S3Client({ ...clientConfig, endpoint: config.endpoint });
    this.publicClient = new S3Client({
      ...clientConfig,
      endpoint: config.publicEndpoint,
    });
    this.bucket = config.bucket;
  }

  buildOriginalKey(videoId: string, extension: string): string {
    return `videos/${videoId}/original.${extension}`;
  }

  buildThumbnailKey(videoId: string): string {
    return `videos/${videoId}/thumbnail.jpg`;
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<{ uploadId: string }> {
    const output = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!output.UploadId) {
      throw new Error(`Storage did not return an UploadId for key "${key}"`);
    }

    return { uploadId: output.UploadId };
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds = DEFAULT_PRESIGNED_URL_TTL_SECONDS,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedUploadPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map(({ partNumber, etag }) => ({
            PartNumber: partNumber,
            ETag: etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async headObject(key: string): Promise<ObjectHead> {
    const output = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    if (output.ContentLength === undefined) {
      throw new Error(`Storage did not return ContentLength for key "${key}"`);
    }

    return {
      contentLength: output.ContentLength,
      contentType: output.ContentType ?? null,
      etag: output.ETag ?? null,
    };
  }

  async presignGetObject(
    key: string,
    options: PresignGetObjectOptions = {},
  ): Promise<string> {
    const { expiresInSeconds, responseContentDisposition } = options;

    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(responseContentDisposition
          ? { ResponseContentDisposition: responseContentDisposition }
          : {}),
      }),
      {
        expiresIn:
          expiresInSeconds ?? DEFAULT_PRESIGNED_URL_TTL_SECONDS,
      },
    );
  }

  async downloadToFile(key: string, destinationPath: string): Promise<void> {
    const output = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    if (!output.Body) {
      throw new Error(`Storage returned an empty body for key "${key}"`);
    }

    await pipeline(output.Body as Readable, createWriteStream(destinationPath));
  }

  async uploadFile(
    key: string,
    filePath: string,
    contentType: string,
  ): Promise<void> {
    const { size } = await stat(filePath);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentType: contentType,
        ContentLength: size,
      }),
    );
  }
}
