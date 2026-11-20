import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );

    return channelRepository.save(
      channelRepository.create({
        name: `Video Channel ${counter}`,
        nickname: `video_chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Partial<Video> {
    return {
      public_id: 'AbCdEf123456',
      channel_id: channelId,
      original_filename: 'clip.mp4',
      storage_key: 'videos/AbCdEf123456/original.mp4',
      mime_type: 'video/mp4',
      size_bytes: '1048576',
      ...overrides,
    };
  }

  it('should default status to draft and fill timestamps', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create(buildVideo(channel.id)),
    );

    expect(video.status).toBe(VideoStatus.Draft);
    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
  });

  it('should enforce unique public_id constraint', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create(buildVideo(channel.id)),
    );

    await expect(
      videoRepository.save(
        videoRepository.create(
          buildVideo(channel.id, {
            storage_key: 'videos/other/original.mp4',
          }),
        ),
      ),
    ).rejects.toThrow();
  });

  it('should enforce unique storage_key constraint', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create(buildVideo(channel.id)),
    );

    await expect(
      videoRepository.save(
        videoRepository.create(
          buildVideo(channel.id, { public_id: 'ZzYyXx654321' }),
        ),
      ),
    ).rejects.toThrow();
  });

  it('should reject a status outside the VideoStatus enum', async () => {
    const channel = await createChannel();

    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("public_id", "channel_id", "original_filename", "storage_key", "mime_type", "size_bytes", "status") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'BadStatus123',
          channel.id,
          'clip.mp4',
          'videos/bad-status/original.mp4',
          'video/mp4',
          '1024',
          'invalid',
        ],
      ),
    ).rejects.toThrow();
  });

  it('should load the channel relation from both sides', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create(buildVideo(channel.id)),
    );

    const videoWithChannel = await videoRepository.findOne({
      where: { id: video.id },
      relations: ['channel'],
    });
    expect(videoWithChannel?.channel.id).toBe(channel.id);

    const channelWithVideos = await channelRepository.findOne({
      where: { id: channel.id },
      relations: ['videos'],
    });
    expect(channelWithVideos?.videos.map((item) => item.id)).toContain(
      video.id,
    );
  });
});
