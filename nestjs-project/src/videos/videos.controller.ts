import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { PresignUploadPartsDto } from './dto/presign-upload-parts.dto';
import {
  type CompleteUploadResult,
  type CreateVideoResult,
  type DeliveryUrl,
  type PresignedPart,
  type VideoDetail,
  VideosService,
} from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Creates a draft video owned by the authenticated user and starts a presigned multipart upload session.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft video created and upload session started',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        publicId: { type: 'string', example: 'AbCdEf123456' },
        status: { type: 'string', example: 'draft' },
        partSizeBytes: { type: 'integer', example: 67108864 },
        partCount: { type: 'integer', example: 2 },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Declared size exceeds the 10 GiB limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'Unsupported media type',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 502,
    description: 'Object storage operation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateVideoResult> {
    return this.videosService.createDraft(user.sub, dto);
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a video',
    description:
      'Returns the video state for its owner, including a presigned thumbnail URL when processing is complete.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video found',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        publicId: { type: 'string', example: 'AbCdEf123456' },
        status: {
          type: 'string',
          enum: ['draft', 'processing', 'ready', 'failed'],
        },
        title: { type: 'string', nullable: true },
        originalFilename: { type: 'string' },
        mimeType: { type: 'string' },
        sizeBytes: { type: 'integer' },
        durationSeconds: { type: 'number', nullable: true },
        width: { type: 'integer', nullable: true },
        height: { type: 'integer', nullable: true },
        thumbnailUrl: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user is not the owner of the video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 502,
    description: 'Object storage operation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<VideoDetail> {
    return this.videosService.findOwnedById(user.sub, id);
  }

  @Get(':publicId/playback')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a presigned playback URL',
    description:
      'Returns a presigned GET URL for streaming the original video. The URL supports range requests and expires in 3600 seconds.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned playback URL',
    schema: {
      properties: {
        url: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user is not the owner of the video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 502,
    description: 'Object storage operation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  getPlaybackUrl(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<DeliveryUrl> {
    return this.videosService.getPlaybackUrl(user.sub, publicId);
  }

  @Get(':publicId/download')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a presigned download URL',
    description:
      'Returns a presigned GET URL that downloads the original video as an attachment using the sanitized original filename. Expires in 3600 seconds.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL',
    schema: {
      properties: {
        url: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user is not the owner of the video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for download',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 502,
    description: 'Object storage operation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  getDownloadUrl(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<DeliveryUrl> {
    return this.videosService.getDownloadUrl(user.sub, publicId);
  }

  @Post(':id/upload-parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Presign multipart upload part URLs',
    description:
      'Returns presigned UploadPart URLs for the requested part numbers of an in-progress draft upload.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              partNumber: { type: 'integer' },
              url: { type: 'string' },
              expiresInSeconds: { type: 'integer', example: 3600 },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user is not the owner of the video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in a draft upload state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 502,
    description: 'Object storage operation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async presignUploadParts(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: PresignUploadPartsDto,
  ): Promise<{ parts: PresignedPart[] }> {
    const parts = await this.videosService.presignUploadParts(
      user.sub,
      id,
      dto.partNumbers,
    );

    return { parts };
  }

  @Post(':id/upload-complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete the multipart upload',
    description:
      'Validates and finishes the multipart upload, then transitions the video to processing and enqueues its processing job.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed and processing enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        publicId: { type: 'string', example: 'AbCdEf123456' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Uploaded parts do not cover the complete file',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user is not the owner of the video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in a draft upload state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Stored object exceeds the 10 GiB limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'Stored object content type is not allowed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 502,
    description: 'Object storage operation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(user.sub, id, dto);
  }
}
