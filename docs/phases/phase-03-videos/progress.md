# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 9/11 completed

### SI-03.1 — Dependências, namespaces de configuração e validação de env
- **Status:** completed
- **Tests:** no tests (infra)
- **Observations:**
  - `library-refs.md` não fixa versões numéricas; versões escolhidas no install a partir dos peer ranges compatíveis com NestJS 11: `@nestjs/bullmq@^11.0.5`, `bullmq@^5.81.5`, `@aws-sdk/client-s3@^3.1173.0`, `@aws-sdk/s3-request-presigner@^3.1173.0`.
  - `npm install` dentro do container exigiu `-u root` (EPERM de `chmod` no `node_modules` bind-mounted do Windows quando executado como usuário `node`).
  - `.env` local (untracked) recebeu as novas chaves S3/Redis para manter o bootstrap da app e os e2e funcionando; `.env.example` atualizado com os mesmos defaults.
  - Sem testes novos (SI com Tests vazio — Infra); o fixture `requiredEnv` de `env.validation.integration-spec.ts` foi atualizado com as chaves S3 obrigatórias (4 testes passando) e verificado que o Joi aborta sem `S3_ACCESS_KEY`/`S3_SECRET_KEY`/`S3_BUCKET`.

### SI-03.2 — Infraestrutura Docker: Redis, MinIO e media-worker
- **Status:** completed
- **Tests:** no tests (infra)
- **Observations:**
  - As imagens `minio/minio` e `minio/mc` não estão mais disponíveis publicamente no Docker Hub (`requested access to the resource is denied`) e `quay.io/minio/*` retorna `unauthorized`; adotada `cgr.dev/chainguard/minio:latest` (mesmo binário `minio`, `mc` incluído) para os serviços `minio` e `minio-init`.
  - O build MinIO usado não implementa `PutBucketCors` (responde "not implemented"); `scripts/minio-init.sh` trata isso como warning e a exposição de CORS fica a cargo de `MINIO_API_CORS_ALLOW_ORIGIN`, verificado por preflight/GET com `Access-Control-Expose-Headers` contendo `Etag`, `Accept-Ranges`, `Content-Range` e `Content-Length`.
  - Serviço one-shot `minio-init` adicionado ao `compose.yaml` para criar o bucket privado e aplicar o script de forma idempotente a cada `up`.
  - `media-worker` usa `Dockerfile.worker` (node 25.6.0-slim + ffmpeg 5.1.9/ffprobe no PATH) com `CMD ["npm", "run", "start:worker"]`; como o script `start:worker` só é criado no SI-03.8, o container permanece efêmero até lá — binários validados via `compose run` neste SI.

### SI-03.3 — Entidade Video, migration e VideosModule
- **Status:** completed
- **Tests:** 6 passing
- **Observations:**
  - Migration `1795205743592-CreateVideos.ts` gerada via CLI e aplicada no DB de dev; SQL revisado (enum `videos_status_enum`, uniques de `public_id`/`storage_key`, índices `IDX_videos_channel_id` e `IDX_videos_status_updated_at`, FK para `channels`).
  - `size_bytes` (bigint) e `duration_seconds` (numeric) tipados como `string`/`string | null` no entity (retorno do driver pg); conversão para number fica na camada de serviço (SI-03.6/SI-03.8).
  - `cleanAllTables` (helper compartilhado dos testes de integração) passou a deletar `videos` antes de `channels` para evitar violação de FK no DB compartilhado.

### SI-03.4 — Adapter de object storage (S3/MinIO)
- **Status:** completed
- **Tests:** 12 passing
- **Observations:**
  - `StorageService` instancia dois `S3Client`s: interno (operações de dados) e público (`S3_PUBLIC_ENDPOINT`, usado apenas para `getSignedUrl` de parts e GET), conforme TD-05.
  - Ambos os clients usam `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'` — o default do SDK (WHEN_SUPPORTED) adiciona CRC32/`aws-chunked` em presigned UploadPart e PutObject com stream, incompatível com MinIO/browser.
  - `headObject` normaliza a saída em `{ contentLength, contentType, etag }`; `presignUploadPart`/`presignGetObject` usam TTL default de 3600s.
  - No integration test (roda dentro do container), `publicEndpoint` foi apontado para `http://minio:9000` porque `localhost:9000` não resolve o MinIO a partir do container; a assinatura contra o endpoint público é verificada no unit test.

### SI-03.5 — Fila de processamento (producer BullMQ e contrato do job)
- **Status:** completed
- **Tests:** 3 passing
- **Observations:**
  - `QueueModule` usa `BullModule.forRootAsync` com `queueConfig.KEY` e exporta `BullModule` + `VideoQueueService`; nenhum `@Processor` é registrado no processo da API (TD-07).
  - O teste de dedupe roda contra o Redis real (dois `enqueueProcessing` com o mesmo `videoId` → um único job) e remove o job ao final para não poluir a fila `video-processing`.
  - `VIDEO_PROCESSING_QUEUE` e o nome do job `process-video` ficam centralizados em `videos.constants.ts`/`video-queue.service.ts`.

### SI-03.6 — Endpoint de iniciação de upload e consulta do vídeo
- **Status:** completed
- **Tests:** 22 passing
- **Observations:**
  - O DTO `CreateVideoDto` valida apenas a forma (`@IsString`/`@IsNotEmpty`/`@Matches` para basename); a allowlist MP4/WebM e o limite de 10 GiB são aplicados em `VideosService` para produzir `UNSUPPORTED_MEDIA_TYPE` (415) e `FILE_TOO_LARGE` (413) conforme os ACs e o Test Spec — usar `@IsIn`/`@Max` no DTO resultaria em `VALIDATION_ERROR` (400) pelo ValidationPipe.
  - O `public_id` (12 chars) é gerado com `crypto.randomBytes(9).toString('base64url')`; colisão no unique index é tratada com retry (até 5 tentativas) e o multipart já criado é reutilizado.
  - `ChannelsService.findByUserId` foi adicionado para resolver o canal do usuário dentro do módulo de canais; `VideosModule` importa `ChannelsModule` + `StorageModule`.
  - Spec-derived E2E `test/videos-create.e2e-spec.ts` cobre os 8 cenários de `specs/videos-create.plan.md`; multipart uploads abertos pelos testes são abortados no `afterEach` e thumbnails temporárias são removidas do bucket.

### SI-03.7 — Assinatura de parts e conclusão do upload
- **Status:** completed
- **Tests:** 30 passing
- **Observations:**
  - `CompleteUploadDto` não usa `@ArrayMinSize(1)`: lista vazia é aceita pelo ValidationPipe e mapeada para `UPLOAD_INCOMPLETE` (400) no service, conforme o Test Spec; `partNumbers` mantém todas as regras no DTO (1..200 itens, 1..10000, sem duplicatas → `VALIDATION_ERROR`).
  - `completeUpload` finaliza o multipart, valida tamanho/tipo reais via `headObject`, limpa `upload_id`, grava `size_bytes` real, transiciona para `processing` e só então enfileira o job; conclusão repetida cai em `INVALID_UPLOAD_STATE` (409) sem segundo job.
  - O caminho real > 10 GiB é coberto em unit (headObject mockado) — inviável via e2e; os demais cenários têm cobertura e2e contra MinIO/Redis reais.
  - No e2e `test/videos-upload.e2e-spec.ts`, `storageConfig.KEY` é sobrescrito com `publicEndpoint = S3_ENDPOINT` (minio:9000) para que as URLs presignadas sejam acessíveis de dentro do container de testes; a assinatura contra o endpoint público configurado continua coberta pelos unit tests.

### SI-03.8 — Worker de processamento: FFmpeg, thumbnail e lifecycle
- **Status:** completed
- **Tests:** 13 passing
- **Observations:**
  - `WorkerModule` é standalone (`createApplicationContext`) com ConfigModule + TypeORM próprios; importa QueueModule, VideosModule, StorageModule e UsersModule — este último é necessário para o metadata do TypeORM (`Video.channel → Channel.user`), embora não estivesse na lista original de imports.
  - Pipeline idempotente: download → `ffprobe` → thumbnail em ~10% da duração → upload em `videos/{id}/thumbnail.jpg` → `status=ready`; em erro, rethrow para o BullMQ e `status=failed` + `failure_reason` apenas na última tentativa; vídeo inexistente gera warn e no-op.
  - Adicionado `src/worker/worker.module.spec.ts` (compilação do módulo com imports configurados) além dos 3 arquivos de teste listados no plano — exigência do testing guide para módulos com imports configurados.
  - `start:worker` usa `ts-node --transpile-only src/worker/main.ts` em vez de `nest start`: neste host (Windows + Podman), `nest build/start` falha em `fs.copyFileSync` dos assets de mail com EPERM para usuário não-root; `start:worker:prod` segue `node dist/worker/main` (per plano).
  - `npm run build` como usuário `node` sofre do mesmo EPERM de asset copy neste host; o build foi validado com `podman compose exec -u root nestjs-api npm run build` (emite `dist/worker/main.js` e `dist/mail/templates/*`). O mesmo workaround será usado na verificação final.
  - Smoke real: container `media-worker` fica Up com ffmpeg/ffprobe 5.1.9, conecta a DB/Redis/MinIO e consome job (estado `completed`, warn de vídeo inexistente).

### SI-03.9 — Entrega: playback em streaming e download
- **Status:** completed
- **Tests:** 16 passing
- **Observations:**
  - `getPlaybackUrl`/`getDownloadUrl` resolvem o vídeo por `public_id`, validam ownership e `status = ready` (409 `VIDEO_NOT_READY`), assinam GET contra o `S3_PUBLIC_ENDPOINT` com TTL 3600 e retornam `{ url, expiresAt }`.
  - `sanitizeOriginalFilename` extrai o basename, remove caracteres de controle/aspas e usa fallback `video.{ext}` (ou `video`) quando o nome fica vazio.
  - E2E valida o comportamento real do storage: Range `bytes=0-1023` → `206` com `Content-Range`/`Content-Length`, e download com `Content-Disposition: attachment; filename*=UTF-8''…` contendo o nome sanitizado e body idêntico ao original.
  - Mesmo override de `storageConfig.KEY` do SI-03.7 no e2e (`publicEndpoint = S3_ENDPOINT`) para as URLs presignadas serem acessíveis de dentro do container.

### SI-03.10 — Varredura de reconciliação e limpeza de uploads abandonados
- **Status:** pending
- **Tests:** pending
- **Observations:** pending

### SI-03.11 — Exportação do contrato OpenAPI
- **Status:** pending
- **Tests:** pending
- **Observations:** pending
