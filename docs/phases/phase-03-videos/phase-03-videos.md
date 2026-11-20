---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-20T16:33:40-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-20T16:49:17-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-20T16:23:31-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-09T21:11:59-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-11-09T21:11:59-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-11-09T21:11:59-03:00"
  docs/decisions/technical-decisions-next-frontend-msw-foundation.md: "2026-11-09T21:11:59-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver Phase 03's video pipeline end to end: presigned multipart uploads of files up to 10GB directly to object storage without routing media through the API, automatic background processing (duration/metadata extraction and thumbnail generation via FFmpeg), and delivery of each video through a unique public identifier with streaming playback and download.

---

## Step Implementations

### SI-03.1 — Dependências, namespaces de configuração e validação de env

**Description:** Instalar as dependências de produção da Fase 03 e criar os namespaces `storage` e `queue` seguindo o padrão `registerAs` da Fase 01, estendendo o schema Joi e o `.env.example`.

**Technical actions:**

1. Instalar dependências de produção em `nestjs-project`: `@nestjs/bullmq`, `bullmq`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` — versões compatíveis com NestJS 11/CommonJS fixadas em `docs/phases/phase-03-videos/library-refs.md` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `S3_ENDPOINT` (interno, container→MinIO), `S3_PUBLIC_ENDPOINT` (browser-facing), `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-05`)
3. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` lendo `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`), `REDIS_PASSWORD` (opcional) (per `phase-03-videos/TD-01`)
4. Atualizar `src/config/env.validation.ts` — novas chaves Joi: `S3_ACCESS_KEY`, `S3_SECRET_KEY` e `S3_BUCKET` required; `S3_ENDPOINT` default `http://minio:9000`, `S3_PUBLIC_ENDPOINT` default `http://localhost:9000`, `S3_REGION` default `us-east-1`, `S3_FORCE_PATH_STYLE` default `true`, `REDIS_HOST` default `redis`, `REDIS_PORT` default `6379` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-05`)
5. Atualizar `.env.example` com todas as novas chaves e defaults compatíveis com o Compose (per `phase-03-videos/TD-05`)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- A aplicação inicia com as novas variáveis fornecidas; ausência de `S3_ACCESS_KEY`, `S3_SECRET_KEY` ou `S3_BUCKET` aborta o bootstrap com erro de validação Joi
- `storage` e `queue` são injetáveis via `ConfigType<typeof ...>` + `@Inject(...KEY)` sem duplicar leitura de `process.env`
- `.env.example` documenta todas as novas chaves com os defaults usados pelo Docker Compose

---

### SI-03.2 — Infraestrutura Docker: Redis, MinIO e media-worker

**Description:** Subir a infraestrutura de storage e fila no Compose, criar o `Dockerfile.worker` com FFmpeg e o serviço `media-worker`, e preparar bucket privado + CORS do MinIO.

**Technical actions:**

1. Atualizar `nestjs-project/compose.yaml` — serviço `redis` (`redis:7-alpine`, porta 6379, healthcheck `redis-cli ping`) e serviço `minio` (`minio/minio`, comando `server /data --console-address ":9001"`, portas `9000` e `9001`, credenciais root via env, volume persistente, healthcheck) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`)
2. Configurar CORS do MinIO — `MINIO_API_CORS_ALLOW_ORIGIN` no serviço e CORS de bucket permitindo `Content-Type` e `x-amz-*`, expondo `ETag`, `Content-Range`, `Accept-Ranges` e `Content-Length` (per `phase-03-videos/TD-05`)
3. Criar `nestjs-project/Dockerfile.worker` — mesma base Node do `Dockerfile.dev`, instala `ffmpeg` (que inclui `ffprobe`) via apt, executa o entrypoint do worker (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`)
4. Adicionar serviço `media-worker` ao `compose.yaml` — build pelo `Dockerfile.worker`, env de DB/Redis/S3, `depends_on` `db`, `redis` e `minio` saudáveis, sem portas publicadas (per `phase-03-videos/TD-07`)
5. Criar `nestjs-project/scripts/minio-init.sh` — cria o bucket privado de forma idempotente e aplica as regras de CORS (per `phase-03-videos/TD-03`, `phase-03-videos/TD-05`)

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `docker compose up -d` sobe `redis` e `minio` com status saudável; o MinIO responde na API S3 em `localhost:9000` e no console em `localhost:9001`
- O bucket configurado existe, permanece privado e expõe as regras de CORS exigidas para upload (`ETag`) e playback/download (`Content-Range`, `Accept-Ranges`, `Content-Length`)
- O container `media-worker` inicia com `ffmpeg` e `ffprobe` disponíveis no `PATH`

---

### SI-03.3 — Entidade Video, migration e VideosModule

**Description:** Criar a entidade `Video` com o schema decidido, a migration correspondente e o esqueleto do `VideosModule` registrado na aplicação.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com as colunas do Data Model (`id`, `public_id`, `channel_id`, `title`, `original_filename`, `storage_key`, `thumbnail_key`, `upload_id`, `mime_type`, `size_bytes`, `duration_seconds`, `width`, `height`, `status` enum `VideoStatus` com `draft`/`processing`/`ready`/`failed`, `failure_reason`, `created_at`, `updated_at`), relação `@ManyToOne(() => Channel)` com `@JoinColumn({ name: 'channel_id' })` e índices únicos em `public_id`/`storage_key` + índices em `channel_id` e `(status, updated_at)` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-09`, `phase-03-videos/TD-11`)
2. Adicionar o lado inverso em `src/channels/entities/channel.entity.ts` — `@OneToMany(() => Video, (video) => video.channel) videos: Video[]` (per `phase-03-videos/TD-09`)
3. Gerar a migration via `npm run migration:generate -- src/database/migrations/CreateVideos` e revisar o SQL gerado (colunas, FK, índices, enum)
4. Criar `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])` em `imports`; registrar `VideosModule` em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unique `public_id`/`storage_key`, default `status = draft`, enum constraint, timestamps, relação com `Channel` | `src/videos/entities/video.entity.integration-spec.ts` |
| `VideosModule` | Unit: compila com `TypeOrmModule.forFeature([Video])` | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com todas as colunas, FK para `channels` e índices do Data Model
- Inserir dois vídeos com o mesmo `public_id` falha com violação de unique constraint
- Um vídeo recém-criado tem `status = 'draft'` por default e `created_at`/`updated_at` preenchidos automaticamente
- A relação `Channel 1..N Video` retorna os vídeos do canal ao carregar a relação
- Inserir um `status` fora de `draft`/`processing`/`ready`/`failed` é rejeitado

---

### SI-03.4 — Adapter de object storage (S3/MinIO)

**Description:** Encapsular o AWS SDK v3 em um `StorageService` que assina multipart uploads e URLs de leitura contra o endpoint público, com os layouts de chave por vídeo.

**Technical actions:**

1. Criar `src/storage/storage.service.ts` — `StorageService` injetando `ConfigType<typeof storageConfig>`; instancia `S3Client` com `endpoint` interno, `forcePathStyle`, `region` e credenciais; expõe helpers `buildOriginalKey(id, ext)` (`videos/{id}/original.{ext}`) e `buildThumbnailKey(id)` (`videos/{id}/thumbnail.jpg`) (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`)
2. Implementar `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber, expiresInSeconds = 3600)`, `completeMultipartUpload(key, uploadId, parts)` e `abortMultipartUpload(key, uploadId)` via `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (per `phase-03-videos/TD-04`)
3. Implementar `headObject(key)` retornando `ContentLength`, `ContentType` e `ETag`, `presignGetObject(key, { expiresInSeconds, responseContentDisposition? })` assinando contra `S3_PUBLIC_ENDPOINT`, e os helpers do worker `downloadToFile(key, destPath)` / `uploadFile(key, filePath, contentType)` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-08`, `phase-03-videos/TD-10`)
4. Criar `src/storage/storage.module.ts` — provê e exporta `StorageService` (per `phase-03-videos/TD-02`)
5. Criar `src/videos/videos.constants.ts` — `MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024`, `UPLOAD_PART_SIZE_BYTES = 64 * 1024 * 1024`, `ALLOWED_VIDEO_MIME_TYPES = ['video/mp4', 'video/webm']`, `PRESIGNED_URL_TTL_SECONDS = 3600`, `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `VIDEO_PROCESSING_SWEEP_QUEUE = 'video-processing-sweep'` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-06`, `phase-03-videos/TD-10`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Unit: montagem de chaves e payloads das commands com `S3Client` mockado | `src/storage/storage.service.spec.ts` |
| `StorageService` | Integration: multipart real contra MinIO (`create` → `UploadPart` → `complete` → `head` → `presignGet`) | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compila com `ConfigModule` global e `storageConfig` injetado | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `createMultipartUpload` retorna um `UploadId` e `headObject` do objeto completado retorna o `ContentLength` real
- As URLs de `UploadPart` são assinadas contra `S3_PUBLIC_ENDPOINT` com expiração de 3600 segundos
- `presignGetObject` com `responseContentDisposition` embute `attachment` e o filename sanitizado na URL assinada
- `abortMultipartUpload` invalida o upload em andamento — um `complete` posterior falha

---

### SI-03.5 — Fila de processamento (producer BullMQ e contrato do job)

**Description:** Configurar o BullMQ com a conexão Redis configurada, registrar a fila `video-processing` e centralizar o enfileiramento com deduplicação por `jobId`.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync` com `inject: [queueConfig.KEY]` construindo `connection: { host, port, password? }`; `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`; exportar `BullModule` (per `phase-03-videos/TD-01`)
2. Criar `src/queue/video-queue.service.ts` — `VideoQueueService.enqueueProcessing(videoId)`: `queue.add('process-video', { videoId }, { jobId: videoId, attempts: 3, backoff: { type: 'exponential', delay: 30000 }, removeOnComplete: { age: 3600, count: 1000 } })` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-11`)
3. Registrar `QueueModule` em `AppModule` — somente o produtor; nenhum `@Processor` no processo da API (per `phase-03-videos/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoQueueService` | Unit: job com `jobId = videoId`, `attempts: 3`, backoff exponencial de 30s (queue mockada) | `src/queue/video-queue.service.spec.ts` |
| `QueueModule` | Unit: compila com `BullModule.forRootAsync` + `registerQueue` | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `enqueueProcessing(videoId)` adiciona um job `process-video` na fila `video-processing` com `jobId` igual ao `videoId`
- Enfileirar o mesmo `videoId` duas vezes enquanto o job está ativo resulta em um único job na fila (dedupe por `jobId`)
- O processo da API inicia conectado ao Redis e não registra nenhum `@Processor`

---

### SI-03.6 — Endpoint de iniciação de upload e consulta do vídeo

**Route:** POST /videos, GET /videos/{id}
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Authenticated + Owner

**Description:** Criar a iniciação do upload — validação do DTO, geração do `public_id` único, criação do draft com sessão multipart e as exceções de domínio da fase — além do endpoint de consulta do próprio vídeo.

**Technical actions:**

1. Criar `src/videos/dto/create-video.dto.ts` — `originalFilename` (`@IsString`, `@IsNotEmpty`, `@MaxLength(255)`, rejeita `/` e `\`), `mimeType` (`@IsIn(ALLOWED_VIDEO_MIME_TYPES)`), `sizeBytes` (`@IsInt`, `@Min(1)`, `@Max(MAX_VIDEO_SIZE_BYTES)`) e `title` (`@IsOptional`, `@IsString`, `@MaxLength(255)`) (per `phase-03-videos/TD-06`)
2. Adicionar as exceções de domínio em `src/common/exceptions/domain.exception.ts` — `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `VideoAccessDeniedException` (`VIDEO_ACCESS_DENIED`, 403), `VideoNotReadyException` (`VIDEO_NOT_READY`, 409), `UnsupportedMediaTypeException` (`UNSUPPORTED_MEDIA_TYPE`, 415), `FileTooLargeException` (`FILE_TOO_LARGE`, 413), `InvalidUploadStateException` (`INVALID_UPLOAD_STATE`, 409), `UploadIncompleteException` (`UPLOAD_INCOMPLETE`, 400) e `StorageException` (`STORAGE_ERROR`, 502) (per `phase-03-videos/TD-06`, `phase-03-videos/TD-10`, `phase-03-videos/TD-11`)
3. Criar `src/videos/videos.service.ts` — `createDraft(userId, dto)`: resolve o canal do usuário, gera `public_id` de 12 chars base62/base64url via `crypto.randomBytes` com retry em colisão, deriva `storage_key`, chama `StorageService.createMultipartUpload` e persiste `Video` com `status: draft` + `upload_id`, retornando `{ id, publicId, status, partSizeBytes, partCount }`; `findOwnedById(userId, id)` valida ownership e lança as exceções do catálogo (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`, `phase-03-videos/TD-09`)
4. Criar `src/videos/videos.controller.ts` — `@ApiTags('videos')` + `@Controller('videos')`; `@Post()` retornando 201 e `@Get(':id')` retornando 200 (este serializa `thumbnailUrl` presignada quando `status = ready`); `@ApiBearerAuth('access-token')`, `@ApiOperation` e `@ApiResponse` de sucesso e de cada erro do Error Catalog com `getSchemaPath(ApiErrorEnvelope)` (per `openapi-docs-nestjs/TD-01`, `phase-02-auth/TD-07`)
5. Registrar `VideosController` e `VideosService` em `VideosModule` — imports de `TypeOrmModule.forFeature([Video])` e `StorageModule` (per `phase-03-videos/TD-03`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: geração/retry de `public_id`, key layout, falha do storage, ownership | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: persiste draft com `upload_id`/`storage_key` reais, resolve canal e valida ownership | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.3, SI-03.4

**Acceptance criteria:**

- `POST /videos` com payload válido retorna `201` com `{ id, publicId, status: "draft", partSizeBytes: 67108864, partCount }` e persiste um vídeo `draft` com `upload_id`
- `POST /videos` com `mimeType` fora da allowlist retorna `415` com `errorCode: "UNSUPPORTED_MEDIA_TYPE"`
- `POST /videos` com `sizeBytes` acima de 10 GiB retorna `413` com `errorCode: "FILE_TOO_LARGE"`
- `POST /videos` sem token retorna `401`
- `GET /videos/{id}` de vídeo de outro usuário retorna `403` com `errorCode: "VIDEO_ACCESS_DENIED"`; id inexistente retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`
- `GET /videos/{id}` de vídeo `ready` retorna `thumbnailUrl` presignada; de vídeo `draft` retorna `thumbnailUrl: null`

---

### SI-03.7 — Assinatura de parts e conclusão do upload

**Route:** POST /videos/{id}/upload-parts, POST /videos/{id}/upload-complete
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Authenticated + Owner

**Description:** Implementar a assinatura das URLs de partes do multipart e a conclusão do upload com validação de estado, tamanho real e tipo, transicionando o vídeo para `processing` e enfileirando o processamento.

**Technical actions:**

1. Criar `src/videos/dto/presign-upload-parts.dto.ts` — `partNumbers: number[]` com `@IsArray`, `@ArrayMinSize(1)`, `@ArrayMaxSize(200)`, `@IsInt({ each: true })`, `@Min(1, { each: true })`, `@Max(10000, { each: true })` e validação de unicidade (per `phase-03-videos/TD-04`)
2. Criar `src/videos/dto/complete-upload.dto.ts` — `parts` (array de `{ partNumber: number, etag: string }` com `@ValidateNested`, `@Type`, 1..10000 itens, `etag` não vazio) (per `phase-03-videos/TD-04`)
3. Implementar `presignUploadParts(userId, id, partNumbers)` em `VideosService` — valida ownership, exige `status = draft` e `upload_id` presente; assina cada parte via `StorageService.presignUploadPart`; lança `InvalidUploadStateException` quando o estado não permite (per `phase-03-videos/TD-04`)
4. Implementar `completeUpload(userId, id, dto)` em `VideosService` — valida que as parts cobrem exatamente 1..`partCount`, chama `completeMultipartUpload`, valida via `headObject` que o tamanho real ≤ 10 GiB e que o `ContentType` está na allowlist, atualiza `size_bytes` real, limpa `upload_id`, muda `status` para `processing` e chama `VideoQueueService.enqueueProcessing(id)` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-06`, `phase-03-videos/TD-11`)
5. Adicionar ao `VideosController` — `@Post(':id/upload-parts')` (200) e `@Post(':id/upload-complete')` (202), com `@ApiOperation`/`@ApiResponse` completos (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: partes inválidas, estado inválido, validação de tamanho/tipo no complete, enqueue | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: complete real contra MinIO → `status = processing` + job enfileirado | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5, SI-03.6

**Acceptance criteria:**

- `POST /videos/{id}/upload-parts` com `partNumbers` válidos retorna `200` com uma URL presignada por parte
- `POST /videos/{id}/upload-parts` em vídeo que não está em `draft` retorna `409` com `errorCode: "INVALID_UPLOAD_STATE"`
- `POST /videos/{id}/upload-complete` com o conjunto completo de parts retorna `202` com `status: "processing"` e enfileira um job `process-video` com `jobId` igual ao `videoId`
- `POST /videos/{id}/upload-complete` com parts faltando retorna `400` com `errorCode: "UPLOAD_INCOMPLETE"`
- `POST /videos/{id}/upload-complete` cujo objeto real excede 10 GiB retorna `413` com `errorCode: "FILE_TOO_LARGE"`
- Repetir o complete após o sucesso retorna `409` com `errorCode: "INVALID_UPLOAD_STATE"` e não enfileira um segundo job

---

### SI-03.8 — Worker de processamento: FFmpeg, thumbnail e lifecycle

**Description:** Criar o processo worker dedicado que consome `video-processing`, extrai metadados com `ffprobe`, gera a thumbnail com `ffmpeg` e conduz o ciclo de vida `processing → ready|failed` de forma idempotente.

**Technical actions:**

1. Criar `src/worker/main.ts` + `src/worker/worker.module.ts` — bootstrap standalone (`NestFactory.createApplicationContext(WorkerModule)`) importando config, TypeORM, `QueueModule`, `VideosModule` e `StorageModule`; adicionar scripts `start:worker` e `start:worker:prod` (`node dist/worker/main`) ao `package.json` (per `phase-03-videos/TD-07`)
2. Criar `src/worker/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })` estendendo `WorkerHost`; `process(job)` carrega o `Video` por `job.data.videoId` e executa o pipeline (per `phase-03-videos/TD-01`, `phase-03-videos/TD-07`)
3. Criar `src/worker/media-tools.service.ts` — wrappers `probe(filePath)` (`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name -show_entries format=duration -of json`) e `generateThumbnail(inputPath, outputPath, atSeconds)` (`ffmpeg -y -ss {atSeconds} -i {inputPath} -frames:v 1 -q:v 2`), ambos via `execFile` sem shell (per `phase-03-videos/TD-08`)
4. Implementar o pipeline idempotente — baixar o original (`downloadToFile`), validar o stream real com `ffprobe` (exige stream de vídeo e duração > 0), gerar thumbnail em ~10% da duração, subir `thumbnail_key` como JPEG, atualizar `duration_seconds`/`width`/`height`/`status = ready` e limpar temporários; em erro, deixar o BullMQ retentar e, na última tentativa (`job.attemptsMade + 1 >= job.opts.attempts`), marcar `status = failed` com `failure_reason` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-08`, `phase-03-videos/TD-11`)
5. Garantir a separação de processos — apenas o worker registra `@Processor` com `concurrency: 1`; a API importa somente o módulo produtor (per `phase-03-videos/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaToolsService` | Unit: parsing do JSON do `ffprobe` e montagem dos args do `ffmpeg` (`execFile` mockado) | `src/worker/media-tools.service.spec.ts` |
| `VideoProcessingProcessor` | Unit: transições `processing → ready/failed`, retry e idempotência (repo/storage/media tocados por mock) | `src/worker/video-processing.processor.spec.ts` |
| `VideoProcessingProcessor` | Integration: consome job real com DB + MinIO reais e `MediaToolsService` stubado → `ready` com metadata e thumbnail | `src/worker/video-processing.processor.integration-spec.ts` |

_O smoke real de `ffmpeg`/`ffprobe` executa no container `media-worker`, cuja imagem instala os binários; o container de testes da API não os instala (per `phase-03-videos/TD-08`)._

**Dependencies:** SI-03.2, SI-03.3, SI-03.4, SI-03.5

**Acceptance criteria:**

- Consumir um job `video-processing` de um MP4 válido leva o vídeo a `ready`, com `duration_seconds`, `width` e `height` preenchidos e `videos/{id}/thumbnail.jpg` presente no bucket
- Consumir o mesmo job duas vezes (retry) mantém o resultado final e não falha — a operação é idempotente
- Consumir um job de um objeto sem stream de vídeo válido leva o vídeo a `failed` com `failure_reason` preenchido na última tentativa
- O worker processa com `concurrency: 1` e é o único processo que registra `@Processor`
- O processo da API não consome jobs da fila

---

### SI-03.9 — Entrega: playback em streaming e download

**Route:** GET /videos/{publicId}/playback, GET /videos/{publicId}/download
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Authenticated + Owner

**Description:** Expor o playback via streaming e o download por URLs presignadas de GET, com verificação de dono e `status = ready`, sem tornar a API um proxy de mídia.

**Technical actions:**

1. Implementar `getPlaybackUrl(userId, publicId)` em `VideosService` — resolve o vídeo por `public_id`, verifica ownership, exige `status = ready` (`VideoNotReadyException` caso contrário) e assina `presignGetObject(storage_key, { expiresInSeconds: 3600 })`, retornando `{ url, expiresAt }` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-10`)
2. Implementar `getDownloadUrl(userId, publicId)` em `VideosService` — mesmo fluxo de ownership/estado, com `responseContentDisposition = attachment; filename*=UTF-8''{sanitized original_filename}` (per `phase-03-videos/TD-10`)
3. Criar `src/videos/filename.util.ts` — `sanitizeOriginalFilename(filename)` normaliza basename, remove caracteres de controle/aspas e garante fallback `video.{ext}` válido (per `phase-03-videos/TD-10`)
4. Adicionar ao `VideosController` — `@Get(':publicId/playback')` e `@Get(':publicId/download')` (200), com `@ApiOperation`/`@ApiResponse` completos, incluindo `403`, `404`, `409` e `502` do Error Catalog (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `sanitizeOriginalFilename` | Unit: basename, caracteres de controle/aspas, fallback por extensão | `src/videos/filename.util.spec.ts` |
| `VideosService` | Integration: playback/download exigem owner e `ready`; URL assinada com `response-content-disposition` correta | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4, SI-03.6

**Acceptance criteria:**

- `GET /videos/{publicId}/playback` de vídeo `ready` do próprio usuário retorna `200` com `url` presignada e `expiresAt` (TTL de 3600s)
- `GET /videos/{publicId}/playback` de vídeo em `processing` retorna `409` com `errorCode: "VIDEO_NOT_READY"`
- `GET /videos/{publicId}/playback` de vídeo de outro usuário retorna `403` com `errorCode: "VIDEO_ACCESS_DENIED"`
- `GET /videos/{publicId}/download` retorna URL cuja resposta do storage traz `Content-Disposition: attachment` com o nome original sanitizado
- Requisições anônimas a playback/download retornam `401`

---

### SI-03.10 — Varredura de reconciliação e limpeza de uploads abandonados

**Description:** Adicionar um job repetível no worker que reenfileira vídeos presos em `processing` e aborta multipart uploads abandonados em `draft`, mantendo o estado do domínio convergente.

**Technical actions:**

1. Criar `src/worker/reconciliation.service.ts` — `ReconciliationService` com `reconcileStuckProcessing()`: vídeos com `status = processing` e `updated_at` anterior a 30 minutos são reenfileirados via `VideoQueueService.enqueueProcessing` (dedupe por `jobId`) (per `phase-03-videos/TD-11`)
2. Implementar `abortAbandonedUploads()` — vídeos `draft` com `upload_id` e `created_at` anterior a 24 horas têm o multipart abortado via `StorageService.abortMultipartUpload` e a linha é removida (per `phase-03-videos/TD-04`, `phase-03-videos/TD-11`)
3. Criar `src/worker/reconciliation.processor.ts` — `@Processor(VIDEO_PROCESSING_SWEEP_QUEUE)` consumindo o job repetível `video-processing-sweep` e executando as duas varreduras (per `phase-03-videos/TD-11`)
4. Registrar a fila `video-processing-sweep` no `QueueModule` e agendar o job repetível no bootstrap do worker (`queue.add('sweep', {}, { repeat: { every: 15 * 60 * 1000 }, jobId: 'video-processing-sweep' })`) (per `phase-03-videos/TD-11`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ReconciliationService` | Unit: seleção de vídeos stuck/abandoned e ações chamadas (repo/storage/queue mockados) | `src/worker/reconciliation.service.spec.ts` |
| `ReconciliationService` | Integration: reenfileira `processing` antigo e remove `draft` abandonado contra DB real | `src/worker/reconciliation.service.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.5, SI-03.8

**Acceptance criteria:**

- Um vídeo em `processing` há mais de 30 minutos recebe um novo job `process-video` na próxima varredura
- Um `draft` com `upload_id` criado há mais de 24 horas tem o multipart abortado e a linha removida
- A varredura é agendada como job repetível a cada 15 minutos no processo worker
- Vídeos em `ready` e drafts recentes não são tocados pela varredura

---

### SI-03.11 — Exportação do contrato OpenAPI

**Description:** Regenerar o `openapi.json` commitado com os endpoints da Fase 03 e verificar que o contrato exportado cobre os paths e os erros de domínio definidos nas Technical Specifications.

**Technical actions:**

1. Rodar `npm run openapi:export` no `nestjs-project` e commitar o `openapi.json` regenerado com os seis endpoints da fase (per `openapi-docs-nestjs/TD-02`, `openapi-docs-nestjs/TD-03`)
2. Verificar que cada endpoint documenta os status de erro do Error Catalog referenciando o `ApiErrorEnvelope` (`{ statusCode, error, message }`) (per `openapi-docs-nestjs/TD-01`, `phase-02-auth/TD-07`)
3. Estender `src/openapi-export.integration-spec.ts` para cobrir os novos paths e os schemas de erro exportados (per `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `openapi.json` | Integration: export contém os paths e schemas de erro da Fase 03 | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.6, SI-03.7, SI-03.9

**Acceptance criteria:**

- O `openapi.json` regenerado contém `/videos`, `/videos/{id}`, `/videos/{id}/upload-parts`, `/videos/{id}/upload-complete`, `/videos/{publicId}/playback` e `/videos/{publicId}/download`
- Cada endpoint referencia o envelope de erro nos status de erro documentados
- `npx tsc --noEmit` e `npm run lint` passam no `nestjs-project`

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| public_id | varchar(12) | unique, not null — 12-char base62/base64url a partir de `crypto.randomBytes`, índice único com retry em colisão (per `phase-03-videos/TD-09`) |
| channel_id | uuid | FK → channels.id, not null |
| title | varchar(255) | nullable — título do rascunho; edição/obrigatoriedade pertence à Fase 04 |
| original_filename | varchar(255) | not null — nome original sanitizado, usado no `Content-Disposition` do download (per `phase-03-videos/TD-10`) |
| storage_key | varchar(512) | unique, not null — prefixo por vídeo `videos/{id}/` (per `phase-03-videos/TD-03`) |
| thumbnail_key | varchar(512) | nullable — `videos/{id}/thumbnail.jpg` (per `phase-03-videos/TD-08`) |
| upload_id | varchar(255) | nullable — `UploadId` do multipart S3 persistido server-side para retomada do upload (per `phase-03-videos/TD-04`) |
| mime_type | varchar(127) | not null — allowlist `video/mp4`, `video/webm` (per `phase-03-videos/TD-06`) |
| size_bytes | bigint | not null — limite máximo 10 GiB (10 737 418 240 bytes) (per `phase-03-videos/TD-06`) |
| duration_seconds | numeric(10,3) | nullable — preenchido pelo worker via ffprobe (per `phase-03-videos/TD-08`) |
| width | integer | nullable — preenchido pelo worker via ffprobe (per `phase-03-videos/TD-08`) |
| height | integer | nullable — preenchido pelo worker via ffprobe (per `phase-03-videos/TD-08`) |
| status | enum `VideoStatus` | not null, default `draft` — valores `draft`, `processing`, `ready`, `failed` (per `phase-03-videos/TD-11`) |
| failure_reason | varchar(255) | nullable — motivo da falha de processamento (per `phase-03-videos/TD-11`) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | atualizado a cada escrita |

**Relations:** `Channel` has many `Video` (one-to-many, `Video.channel_id` → `channels.id`); `Video` belongs to `Channel`.

**Indexes:** unique on `public_id`; unique on `storage_key`; index on `channel_id`; index on `(status, updated_at)` para a varredura de reconciliação (per `phase-03-videos/TD-11`).

**Key layout:** `storage_key = videos/{id}/original.{ext}` com `{ext}` ∈ {`mp4`, `webm`}; `thumbnail_key = videos/{id}/thumbnail.jpg`. Um único prefixo por vídeo garante chaves determinísticas e limpeza/cascata por prefixo (per `phase-03-videos/TD-03`).

---

### API Contracts

> Todas as URLs presignadas (`part` URLs, `playback`, `download`, `thumbnailUrl`) são assinadas contra `S3_PUBLIC_ENDPOINT` — o endpoint acessível pelo browser — enquanto a API fala com o storage pelo endpoint interno (per `phase-03-videos/TD-05`). URLs de parts expiram em ~1 hora e são re-assinadas no resume (per `phase-03-videos/TD-04`); playback/download usam TTL de 1 hora (per `phase-03-videos/TD-10`).

#### POST /videos (SI-03.6)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access token>

**Request body:**
- originalFilename: string, required — 1–255 chars, apenas o nome do arquivo (sem separador de path)
- mimeType: string, required — `video/mp4` ou `video/webm`
- sizeBytes: integer, required — > 0 e ≤ 10737418240 (10 GiB)
- title: string, optional — ≤ 255 chars

**Response 201:**
- id: string (uuid)
- publicId: string (12 chars)
- status: string — `draft`
- partSizeBytes: integer — `67108864` (64 MiB) (per `phase-03-videos/TD-04`)
- partCount: integer — derivado de `sizeBytes` e `partSizeBytes`, mínimo 1

**Error responses:**
- 415 UNSUPPORTED_MEDIA_TYPE: `mimeType`/extensão fora da allowlist MP4/WebM
- 413 FILE_TOO_LARGE: `sizeBytes` acima de 10 GiB
- 400 VALIDATION_ERROR: corpo inválido
- 502 STORAGE_ERROR: falha ao iniciar o multipart upload no storage

---

#### GET /videos/{id} (SI-03.6)

**Request headers:**
- Authorization: Bearer <access token>

**Request path parameters:**
- id: string (uuid), required — identificador interno do vídeo

**Response 200:**
- id: string (uuid)
- publicId: string (12 chars)
- status: string — `draft` | `processing` | `ready` | `failed`
- title: string | null
- originalFilename: string
- mimeType: string
- sizeBytes: integer
- durationSeconds: number | null
- width: integer | null
- height: integer | null
- thumbnailUrl: string | null — URL presignada de GET do thumbnail quando `status = ready` (TTL 3600s)
- createdAt: string (ISO-8601)
- updatedAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente
- 403 VIDEO_ACCESS_DENIED: usuário autenticado não é dono do vídeo

---

#### POST /videos/{id}/upload-parts (SI-03.7)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access token>

**Request path parameters:**
- id: string (uuid), required

**Request body:**
- partNumbers: integer[], required — entre 1 e 200 itens, cada um em 1..10000, sem duplicatas

**Response 200:**
- parts: array de `{ partNumber: integer, url: string, expiresInSeconds: integer }` — `url` presignada de `UploadPart` (TTL 3600s)

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente
- 403 VIDEO_ACCESS_DENIED: usuário autenticado não é dono do vídeo
- 409 INVALID_UPLOAD_STATE: vídeo não está em `draft` ou não possui `upload_id`
- 400 VALIDATION_ERROR: `partNumbers` inválido
- 502 STORAGE_ERROR: falha ao assinar as URLs

---

#### POST /videos/{id}/upload-complete (SI-03.7)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access token>

**Request path parameters:**
- id: string (uuid), required

**Request body:**
- parts: array, required — 1..10000 itens de `{ partNumber: integer, etag: string }` com `etag` não vazio

**Response 202:**
- id: string (uuid)
- publicId: string (12 chars)
- status: string — `processing`

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente
- 403 VIDEO_ACCESS_DENIED: usuário autenticado não é dono do vídeo
- 409 INVALID_UPLOAD_STATE: vídeo não está em `draft` ou não possui `upload_id`
- 400 UPLOAD_INCOMPLETE: conjunto de parts não cobre 1..`partCount` ou contém parte inválida
- 413 FILE_TOO_LARGE: tamanho real (HeadObject) acima de 10 GiB
- 415 UNSUPPORTED_MEDIA_TYPE: `Content-Type` real do objeto fora da allowlist
- 502 STORAGE_ERROR: falha ao completar o multipart upload

---

#### GET /videos/{publicId}/playback (SI-03.9)

**Request headers:**
- Authorization: Bearer <access token>

**Request path parameters:**
- publicId: string (12 chars), required

**Response 200:**
- url: string — URL presignada de GET para streaming (suporta range requests; exposta via CORS com `Accept-Ranges`, `Content-Range`, `Content-Length`) (per `phase-03-videos/TD-10`)
- expiresAt: string (ISO-8601) — TTL 3600s

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente
- 403 VIDEO_ACCESS_DENIED: usuário autenticado não é dono do vídeo
- 409 VIDEO_NOT_READY: vídeo ainda não está em `ready`
- 502 STORAGE_ERROR: falha ao assinar a URL

---

#### GET /videos/{publicId}/download (SI-03.9)

**Request headers:**
- Authorization: Bearer <access token>

**Request path parameters:**
- publicId: string (12 chars), required

**Response 200:**
- url: string — URL presignada de GET com `response-content-disposition=attachment` e `filename*` do nome original sanitizado (per `phase-03-videos/TD-10`)
- expiresAt: string (ISO-8601) — TTL 3600s

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente
- 403 VIDEO_ACCESS_DENIED: usuário autenticado não é dono do vídeo
- 409 VIDEO_NOT_READY: vídeo ainda não está em `ready`
- 502 STORAGE_ERROR: falha ao assinar a URL

---

#### Validation Rules — Upload initiation and completion

- `originalFilename`: required, 1–255 chars, apenas basename (rejeita `/` e `\`)
- `mimeType`: required, allowlist `video/mp4` | `video/webm`; extensão do arquivo coerente com o tipo (per `phase-03-videos/TD-06`)
- `sizeBytes`: required, integer, 1..10737418240 (10 GiB)
- `title`: optional, ≤ 255 chars
- `partNumbers`: cada item em 1..10000; sem duplicatas; máximo 200 itens por requisição
- `parts` (complete): deve cobrir exatamente 1..`partCount`; cada `etag` não vazio; tamanho real validado via HeadObject (per `phase-03-videos/TD-04`)
- O worker valida os metadados reais do stream com `ffprobe`, não apenas o `mime_type`/extensão informados pelo cliente (per `phase-03-videos/TD-06`)

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ | ✓ (cria em nome do próprio canal) |
| GET /videos/{id} | ✗ | ✗ | ✓ |
| POST /videos/{id}/upload-parts | ✗ | ✗ | ✓ |
| POST /videos/{id}/upload-complete | ✗ | ✗ | ✓ |
| GET /videos/{publicId}/playback | ✗ | ✗ | ✓ |
| GET /videos/{publicId}/download | ✗ | ✗ | ✓ |

**Owner** = o usuário autenticado é dono do `Channel` ao qual o vídeo pertence (`channels.user_id = user.sub`). Todas as rotas são protegidas por padrão pelo guard JWT global (`phase-02-auth/TD-02`); nenhuma rota desta fase usa `@Public()`.

**Nota:** A Fase 03 não possui campo de publicação/visibilidade — `ready` diz respeito apenas ao processamento, e publicação/visibilidade é um campo separado da Fase 04 (per `phase-03-videos/TD-11`). Por isso o playback/download são owner-only nesta fase; o acesso anônimo chega com a visibilidade da Fase 04 e o player da Fase 05.

---

### Error Catalog

Envelope herdado: `{ statusCode, error, message }` com códigos de domínio (per `phase-02-auth/TD-07`). Códigos novos desta fase:

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | Vídeo inexistente pelo id interno ou pelo publicId |
| VIDEO_ACCESS_DENIED | 403 | Usuário autenticado não é dono do canal do vídeo |
| UNSUPPORTED_MEDIA_TYPE | 415 | `mimeType`/extensão fora da allowlist MP4/WebM — na iniciação ou no `Content-Type` real do objeto concluído |
| FILE_TOO_LARGE | 413 | `sizeBytes` declarado ou tamanho real no storage excede 10 GiB |
| INVALID_UPLOAD_STATE | 409 | Operação de upload sobre vídeo fora de `draft` ou sem `upload_id` |
| UPLOAD_INCOMPLETE | 400 | Lista de parts no complete não cobre 1..`partCount` ou contém parte inválida |
| VIDEO_NOT_READY | 409 | Playback/download solicitado com `status != 'ready'` |
| STORAGE_ERROR | 502 | Falha do object storage ao iniciar/assinar/completar upload ou ao gerar URL |

`VALIDATION_ERROR` (400, validation exception filter) e o 401 do guard JWT global são herdados de `phase-02-auth` e não são redefinidos aqui.

---

### Events/Messages

**Queue backend:** BullMQ sobre Redis via `@nestjs/bullmq` (per `phase-03-videos/TD-01`). A API importa somente o módulo produtor; o processo media-worker é o único que registra o `@Processor` (per `phase-03-videos/TD-07`).

#### video-processing

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (per `phase-03-videos/TD-01`)
**Consumer:** `VideoProcessingProcessor` no processo media-worker (per `phase-03-videos/TD-07`)
**Trigger:** conclusão do multipart upload em `POST /videos/{id}/upload-complete`, após validação de tamanho/tipo; transição `draft → processing` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-11`)
**Delivery semantics:** at-least-once — `attempts: 3`, backoff exponencial com base de 30s, `jobId = videoId`, `removeOnComplete` limitado e recuperação de jobs stalled (per `phase-03-videos/TD-01`, `phase-03-videos/TD-11`); worker idempotente por `videoId` (overwrite de metadata/thumbnail, upsert) (per `phase-03-videos/TD-11`)

#### video-processing-sweep

**Payload:** nenhum (job repetível)

**Producer:** scheduler de jobs repetíveis no media-worker (per `phase-03-videos/TD-11`)
**Consumer:** `ReconciliationProcessor` no media-worker
**Trigger:** a cada 15 minutos — reenfileira vídeos em `processing` há mais de 30 minutos e aborta multipart uploads abandonados (`draft` com `upload_id` criado há mais de 24 horas, via `AbortMultipartUpload`) (per `phase-03-videos/TD-11`)
**Delivery semantics:** best-effort; operações idempotentes

---

## Dependency Map

SI-03.1 (root)
├── SI-03.2 — infraestrutura Docker (Redis, MinIO, media-worker)
│   └── SI-03.8 — worker FFmpeg (+ SI-03.3, SI-03.4, SI-03.5)
│       └── SI-03.10 — reconciliação (+ SI-03.5)
├── SI-03.3 — entidade Video, migration e VideosModule
│   └── SI-03.6 — iniciação de upload e consulta (+ SI-03.4)
│       ├── SI-03.7 — parts e conclusão do upload (+ SI-03.5)
│       │   └── SI-03.11 — export OpenAPI (+ SI-03.9)
│       └── SI-03.9 — playback e download (+ SI-03.4)
├── SI-03.4 — adapter de object storage
└── SI-03.5 — fila de processamento

---

## Deliverables

- [ ] SI-03.1 — Dependências, namespaces de configuração e validação de env
- [ ] SI-03.2 — Infraestrutura Docker: Redis, MinIO e media-worker
- [ ] SI-03.3 — Entidade Video, migration e VideosModule
- [ ] SI-03.4 — Adapter de object storage (S3/MinIO)
- [ ] SI-03.5 — Fila de processamento (producer BullMQ e contrato do job)
- [ ] SI-03.6 — Endpoint de iniciação de upload e consulta do vídeo
- [ ] SI-03.7 — Assinatura de parts e conclusão do upload
- [ ] SI-03.8 — Worker de processamento: FFmpeg, thumbnail e lifecycle
- [ ] SI-03.9 — Entrega: playback em streaming e download
- [ ] SI-03.10 — Varredura de reconciliação e limpeza de uploads abandonados
- [ ] SI-03.11 — Exportação do contrato OpenAPI

**Full test suites** (executar a partir de `nestjs-project/`):

- [ ] Backend tests (unit + integration) passam — `docker compose exec nestjs-api npm test -- --runInBand`
- [ ] E2E tests passam — `docker compose exec nestjs-api npm run test:e2e`
- [ ] Type-check passa — `docker compose exec nestjs-api npx tsc --noEmit`
- [ ] Build passa — `docker compose exec nestjs-api npm run build`
- [ ] Lint passa — `docker compose exec nestjs-api npm run lint`
- [ ] Contrato OpenAPI atualizado — `docker compose exec nestjs-api npm run openapi:export` seguido de `git diff --exit-code openapi.json`
- [ ] Binários do worker presentes — `docker compose exec media-worker sh -c "ffmpeg -version && ffprobe -version"`
