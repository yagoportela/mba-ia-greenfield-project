import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateVideoDto {
  /** Original file name (basename only, no path separators). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(/^[^/\\]+$/, {
    message: 'originalFilename must not contain path separators',
  })
  originalFilename: string;

  /** Declared MIME type of the upload. */
  @IsString()
  @IsNotEmpty()
  mimeType: string;

  /** Declared file size in bytes. */
  @IsInt()
  @Min(1)
  sizeBytes: number;

  /** Optional draft title. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}
