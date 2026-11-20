import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Max,
  Min,
} from 'class-validator';

export class PresignUploadPartsDto {
  /** Upload part numbers to (re)sign, 1..10000, unique. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(10000, { each: true })
  partNumbers: number[];
}
