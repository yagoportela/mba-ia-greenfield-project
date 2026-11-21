import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class CompletedPartDto {
  /** Upload part number, 1..10000. */
  @IsInt()
  @Min(1)
  @Max(10000)
  partNumber: number;

  /** ETag returned by the storage for the uploaded part. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /**
   * Uploaded parts. Coverage of 1..partCount is validated by the service so
   * an incomplete list maps to UPLOAD_INCOMPLETE.
   */
  @IsArray()
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
