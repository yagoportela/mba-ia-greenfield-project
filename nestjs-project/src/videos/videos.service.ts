import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  FindOptionsWhere,
  QueryFailedError,
  Repository,
} from 'typeorm';

import { ChannelsService } from '../channels/channels.service';
import {
  FileTooLargeException,
  InvalidUploadStateException,
  StorageException,
  UnsupportedMediaTypeException,
  UploadIncompleteException,
  VideoAccessDeniedException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { VideoQueueService } from '../queue/video-queue.service';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { sanitizeOriginalFilename } from './filename.util';
import {
  ALLOWED_VIDEO_MIME_TYPES,
  MAX_VIDEO_SIZE_BYTES,
  PRESIGNED_URL_TTL_SECONDS,
  UPLOAD_PART_SIZE_BYTES,
} from './videos.constants';

const MAX_PUBLIC_ID_RETRIES = 5;
const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_COLUMN = 'public_id';

const MIME_TO_EXTENSION: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

function extractExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return '';
  }
  return filename.slice(lastDot + 1).toLowerCase();
}

function isUniqueViolationOnColumn(
  error: unknown,
  column: string,
): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }

  const driverError = error as QueryFailedError & {
    code?: string;
    detail?: string;
  };

  return (
    driverError.code === PG_UNIQUE_VIOLATION &&
    typeof driverError.detail === 'string' &&
    driverError.detail.includes(column)
  );
}

export interface CreateVideoResult {
  id: string;
  publicId: string;
  status: VideoStatus;
  partSizeBytes: number;
  partCount: number;
}

export interface VideoDetail {
  id: string;
  publicId: string;
  status: VideoStatus;
  title: string | null;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PresignedPart {
  partNumber: number;
  url: string;
  expiresInSeconds: number;
}

export interface CompleteUploadResult {
  id: string;
  publicId: string;
  status: VideoStatus;
}

export interface DeliveryUrl {
  url: string;
  expiresAt: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    private readonly videoQueueService: VideoQueueService,
  ) {}

  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreateVideoResult> {
    const extension = this.assertSupportedMediaType(dto);

    if (dto.sizeBytes > MAX_VIDEO_SIZE_BYTES) {
      throw new FileTooLargeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`Channel not found for user "${userId}"`);
    }

    const videoId = randomUUID();
    const storageKey = this.storageService.buildOriginalKey(
      videoId,
      extension,
    );

    let uploadId: string;
    try {
      ({ uploadId } = await this.storageService.createMultipartUpload(
        storageKey,
        dto.mimeType,
      ));
    } catch {
      throw new StorageException();
    }

    const video = await this.persistDraft({
      videoId,
      channelId: channel.id,
      storageKey,
      uploadId,
      dto,
    });

    return {
      id: video.id,
      publicId: video.public_id,
      status: video.status,
      partSizeBytes: UPLOAD_PART_SIZE_BYTES,
      partCount: this.computePartCount(dto.sizeBytes),
    };
  }

  async findOwnedById(userId: string, id: string): Promise<VideoDetail> {
    const video = await this.findOwnedVideo(userId, id);

    let thumbnailUrl: string | null = null;
    if (video.status === VideoStatus.Ready && video.thumbnail_key) {
      try {
        thumbnailUrl = await this.storageService.presignGetObject(
          video.thumbnail_key,
        );
      } catch {
        throw new StorageException();
      }
    }

    return {
      id: video.id,
      publicId: video.public_id,
      status: video.status,
      title: video.title,
      originalFilename: video.original_filename,
      mimeType: video.mime_type,
      sizeBytes: Number(video.size_bytes),
      durationSeconds:
        video.duration_seconds === null
          ? null
          : Number(video.duration_seconds),
      width: video.width,
      height: video.height,
      thumbnailUrl,
      createdAt: video.created_at.toISOString(),
      updatedAt: video.updated_at.toISOString(),
    };
  }

  async getPlaybackUrl(
    userId: string,
    publicId: string,
  ): Promise<DeliveryUrl> {
    const video = await this.findOwnedVideoByPublicId(userId, publicId);
    this.assertVideoReady(video);

    try {
      const url = await this.storageService.presignGetObject(
        video.storage_key,
        { expiresInSeconds: PRESIGNED_URL_TTL_SECONDS },
      );

      return { url, expiresAt: this.buildExpiresAt() };
    } catch {
      throw new StorageException();
    }
  }

  async getDownloadUrl(
    userId: string,
    publicId: string,
  ): Promise<DeliveryUrl> {
    const video = await this.findOwnedVideoByPublicId(userId, publicId);
    this.assertVideoReady(video);

    const filename = sanitizeOriginalFilename(video.original_filename);
    const responseContentDisposition =
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;

    try {
      const url = await this.storageService.presignGetObject(
        video.storage_key,
        {
          expiresInSeconds: PRESIGNED_URL_TTL_SECONDS,
          responseContentDisposition,
        },
      );

      return { url, expiresAt: this.buildExpiresAt() };
    } catch {
      throw new StorageException();
    }
  }

  async presignUploadParts(
    userId: string,
    id: string,
    partNumbers: number[],
  ): Promise<PresignedPart[]> {
    const video = await this.findOwnedVideo(userId, id);
    this.assertUploadInProgress(video);

    try {
      return await Promise.all(
        partNumbers.map(async (partNumber) => ({
          partNumber,
          url: await this.storageService.presignUploadPart(
            video.storage_key,
            video.upload_id!,
            partNumber,
          ),
          expiresInSeconds: PRESIGNED_URL_TTL_SECONDS,
        })),
      );
    } catch {
      throw new StorageException();
    }
  }

  async completeUpload(
    userId: string,
    id: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.findOwnedVideo(userId, id);
    this.assertUploadInProgress(video);

    const partCount = this.computePartCount(Number(video.size_bytes));
    this.assertPartsCoverUpload(dto.parts, partCount);

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id!,
        dto.parts.map(({ partNumber, etag }) => ({ partNumber, etag })),
      );
    } catch {
      throw new StorageException();
    }

    const head = await this.headCompletedObject(video.storage_key);

    if (head.contentLength > MAX_VIDEO_SIZE_BYTES) {
      throw new FileTooLargeException();
    }

    if (
      !head.contentType ||
      !(ALLOWED_VIDEO_MIME_TYPES as readonly string[]).includes(
        head.contentType,
      )
    ) {
      throw new UnsupportedMediaTypeException();
    }

    video.size_bytes = String(head.contentLength);
    video.upload_id = null;
    video.status = VideoStatus.Processing;
    video.failure_reason = null;
    const updated = await this.videoRepository.save(video);

    await this.videoQueueService.enqueueProcessing(updated.id);

    return {
      id: updated.id,
      publicId: updated.public_id,
      status: updated.status,
    };
  }

  private async findOwnedVideo(
    userId: string,
    id: string,
  ): Promise<Video> {
    return this.findOwnedVideoWhere(userId, { id });
  }

  private async findOwnedVideoByPublicId(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    return this.findOwnedVideoWhere(userId, { public_id: publicId });
  }

  private async findOwnedVideoWhere(
    userId: string,
    where: FindOptionsWhere<Video>,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where,
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    if (video.channel.user_id !== userId) {
      throw new VideoAccessDeniedException();
    }

    return video;
  }

  private assertVideoReady(video: Video): void {
    if (video.status !== VideoStatus.Ready) {
      throw new VideoNotReadyException();
    }
  }

  private buildExpiresAt(): string {
    return new Date(
      Date.now() + PRESIGNED_URL_TTL_SECONDS * 1000,
    ).toISOString();
  }

  private assertUploadInProgress(video: Video): void {
    if (video.status !== VideoStatus.Draft || !video.upload_id) {
      throw new InvalidUploadStateException();
    }
  }

  private assertPartsCoverUpload(
    parts: { partNumber: number }[],
    partCount: number,
  ): void {
    if (parts.length !== partCount) {
      throw new UploadIncompleteException();
    }

    const partNumbers = new Set(
      parts.map((part) => part.partNumber),
    );
    if (partNumbers.size !== partCount) {
      throw new UploadIncompleteException();
    }

    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      if (!partNumbers.has(partNumber)) {
        throw new UploadIncompleteException();
      }
    }
  }

  private async headCompletedObject(
    storageKey: string,
  ): Promise<{ contentLength: number; contentType: string | null }> {
    try {
      return await this.storageService.headObject(storageKey);
    } catch {
      throw new StorageException();
    }
  }

  private computePartCount(sizeBytes: number): number {
    return Math.max(1, Math.ceil(sizeBytes / UPLOAD_PART_SIZE_BYTES));
  }

  private assertSupportedMediaType(dto: CreateVideoDto): string {
    const extension = MIME_TO_EXTENSION[dto.mimeType];
    if (!extension) {
      throw new UnsupportedMediaTypeException();
    }

    if (extractExtension(dto.originalFilename) !== extension) {
      throw new UnsupportedMediaTypeException();
    }

    return extension;
  }

  private async persistDraft(params: {
    videoId: string;
    channelId: string;
    storageKey: string;
    uploadId: string;
    dto: CreateVideoDto;
  }): Promise<Video> {
    const { videoId, channelId, storageKey, uploadId, dto } = params;

    for (let attempt = 0; attempt <= MAX_PUBLIC_ID_RETRIES; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            id: videoId,
            public_id: this.generatePublicId(),
            channel_id: channelId,
            title: dto.title ?? null,
            original_filename: dto.originalFilename,
            storage_key: storageKey,
            thumbnail_key: null,
            upload_id: uploadId,
            mime_type: dto.mimeType,
            size_bytes: String(dto.sizeBytes),
            status: VideoStatus.Draft,
          }),
        );
      } catch (error) {
        if (
          !isUniqueViolationOnColumn(error, PUBLIC_ID_COLUMN) ||
          attempt === MAX_PUBLIC_ID_RETRIES
        ) {
          throw error;
        }
      }
    }

    throw new Error('Public ID collision could not be resolved');
  }

  private generatePublicId(): string {
    return randomBytes(9).toString('base64url');
  }
}
