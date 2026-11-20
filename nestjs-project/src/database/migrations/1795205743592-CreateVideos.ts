import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1795205743592 implements MigrationInterface {
  name = 'CreateVideos1795205743592';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "public_id" character varying(12) NOT NULL, "channel_id" uuid NOT NULL, "title" character varying(255), "original_filename" character varying(255) NOT NULL, "storage_key" character varying(512) NOT NULL, "thumbnail_key" character varying(512), "upload_id" character varying(255), "mime_type" character varying(127) NOT NULL, "size_bytes" bigint NOT NULL, "duration_seconds" numeric(10,3), "width" integer, "height" integer, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "failure_reason" character varying(255), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_39a1f0fe7991162aace659078ec" UNIQUE ("public_id"), CONSTRAINT "UQ_6ce3c9805943abd5b2950847b64" UNIQUE ("storage_key"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_status_updated_at" ON "videos" ("status", "updated_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_channel_id" ON "videos" ("channel_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_videos_channel_id"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_videos_status_updated_at"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
