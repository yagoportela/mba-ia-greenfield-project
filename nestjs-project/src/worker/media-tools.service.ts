import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';

export interface VideoProbeResult {
  hasVideoStream: boolean;
  durationSeconds: number;
  width: number | null;
  height: number | null;
  codecName: string | null;
}

interface FfprobeJson {
  streams?: {
    width?: number;
    height?: number;
    codec_name?: string;
  }[];
  format?: {
    duration?: string;
  };
}

@Injectable()
export class MediaToolsService {
  async probe(filePath: string): Promise<VideoProbeResult> {
    const output = await this.run('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,codec_name',
      '-show_entries',
      'format=duration',
      '-of',
      'json',
      filePath,
    ]);

    const parsed = JSON.parse(output) as FfprobeJson;
    const stream = parsed.streams?.[0];
    const duration = parsed.format?.duration
      ? Number(parsed.format.duration)
      : 0;

    return {
      hasVideoStream: Boolean(stream),
      durationSeconds: Number.isFinite(duration) ? duration : 0,
      width: stream?.width ?? null,
      height: stream?.height ?? null,
      codecName: stream?.codec_name ?? null,
    };
  }

  async generateThumbnail(
    inputPath: string,
    outputPath: string,
    atSeconds: number,
  ): Promise<void> {
    await this.run('ffmpeg', [
      '-y',
      '-ss',
      String(atSeconds),
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      outputPath,
    ]);
  }

  private run(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(command, args, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.toString());
      });
    });
  }
}
