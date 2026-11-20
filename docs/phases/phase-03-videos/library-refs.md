---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-11-20T16:49:07-03:00"
  "bullmq":
    version: "^5.81.5"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-20T16:49:07-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1173.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-20T16:49:07-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1173.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-20T16:49:07-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-20T16:23:31-03:00"
---

# Library References — Phase 03 (videos)

Docs cacheadas via Context7 para as bibliotecas introduzidas pelas TDs da Fase 03. As versões fixadas abaixo priorizam o stack **NestJS 11 + CommonJS** (per `phase-03-videos/TD-01`).

**Compatibilidade (verificada no registry em 2026-11-20):**

- `@nestjs/bullmq@11.0.5` — `main: dist/index.js` (CJS), peers `@nestjs/common ^10 || ^11`, `@nestjs/core ^10 || ^11`, `bullmq ^3 || ^4 || ^5 || ^6`. A linha **v12 é ESM-first (`"type": "module"`)** e não deve ser usada neste projeto CommonJS (per `phase-03-videos/TD-01`).
- `bullmq@5.81.5` — CJS (`main: ./dist/cjs/index.js`), engines `node >=12.22.0`.
- `@aws-sdk/client-s3@3.1173.0` e `@aws-sdk/s3-request-presigner@3.1173.0` — CJS (`main: ./dist-cjs/index.js`), engines `node >=20.0.0`; manter os dois pacotes na mesma versão.

## @nestjs/bullmq

**Configuração assíncrona** — `BullModule.forRootAsync` com `inject` do config namespace e `useFactory` retornando `{ connection }`:

```typescript
BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (config: ConfigType<typeof queueConfig>) => ({
    connection: {
      host: config.host,
      port: config.port,
      ...(config.password ? { password: config.password } : {}),
    },
  }),
});
```

**Registro de fila** — `BullModule.registerQueue({ name: 'video-processing' })`; exportar `BullModule` para que o módulo produtor e o worker compartilhem a conexão.

**Processor** — a classe consome a fila estendendo `WorkerHost` e implementando `process(job, token?)`:

```typescript
@Processor('video-processing', { concurrency: 1 })
export class VideoProcessingProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> {
    // ...
  }
}
```

`@Processor('name', workerOptions)` aceita `concurrency`, `limiter`, etc. O `@Processor` só deve ser registrado no processo worker (per `phase-03-videos/TD-07`).

## bullmq

**Opções de job** usadas no enfileiramento (per `phase-03-videos/TD-11`):

```typescript
await queue.add(
  'process-video',
  { videoId },
  {
    jobId: videoId, // dedupe determinístico
    attempts: 3,
    backoff: { type: 'exponential', delay: 30000 },
    removeOnComplete: { age: 3600, count: 1000 },
  },
);
```

Semântica relevante:

- `jobId` customizado torna o `add` idempotente enquanto o job existe na fila; jobs removidos por `removeOnComplete`/`removeOnFailed` **não** contam como duplicata.
- `backoff: { type: 'exponential', delay }` espera `2^(attempts-1) * delay` ms entre tentativas.
- Jobs stalled são devolvidos à lista de espera e reprocessados — o worker precisa ser idempotente (per `phase-03-videos/TD-11`).
- **Jobs repetíveis** usam `repeat: { every: <ms> }` (ex.: 15 min = `900000`) com um `jobId` estável para não duplicar o agendamento; desde o BullMQ 2.0 não é necessário `QueueScheduler`.
- **Worker** aceita `{ concurrency }`; para FFmpeg (CPU-bound) usar `1` por container (per `phase-03-videos/TD-07`).

## @aws-sdk/client-s3

**Cliente para MinIO/S3-compatível** — endpoint estático + path-style:

```typescript
const client = new S3Client({
  endpoint: config.endpoint, // interno (ex.: http://minio:9000)
  forcePathStyle: true,
  region: config.region,
  credentials: {
    accessKeyId: config.accessKey,
    secretAccessKey: config.secretKey,
  },
});
```

Operações do fluxo de upload/entrega:

- `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → retorna `UploadId`.
- `UploadPartCommand({ Bucket, Key, UploadId, PartNumber, Body })` — assinado via presigner; o browser envia o `Body` diretamente ao storage.
- `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts } })`, onde cada `CompletedPart` carrega `PartNumber` e `ETag`. `PartNumber` é 1..10000; com checksums adicionais os números devem ser **consecutivos** (per `phase-03-videos/TD-04`).
- `AbortMultipartUploadCommand({ Bucket, Key, UploadId })` — limpeza de uploads abandonados (per `phase-03-videos/TD-11`).
- `HeadObjectCommand({ Bucket, Key })` → `ContentLength`, `ContentType`, `ETag` (validação de tamanho/tipo no complete).
- `GetObjectCommand({ Bucket, Key, ResponseContentDisposition })` — base do playback/download presignado.

**CORS:** uploads presignados no browser exigem que o bucket exponha `ETag`; playback/download exigem `Content-Range`, `Accept-Ranges` e `Content-Length` (per `phase-03-videos/TD-05`).

## @aws-sdk/s3-request-presigner

`getSignedUrl(client, command, { expiresIn })` gera URLs temporárias para operações S3 (default `expiresIn` = 900s):

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';

const url = await getSignedUrl(
  client,
  new GetObjectCommand({ Bucket, Key }),
  { expiresIn: 3600 },
);
```

Para as part URLs, assinar `UploadPartCommand` com o mesmo `UploadId`/`Key`/`PartNumber` — a re-assinatura no resume usa a mesma chamada (per `phase-03-videos/TD-04`). O presigner assina com o endpoint do `S3Client`: para que o browser acesse o storage, o cliente usado na assinatura deve estar configurado com o `S3_PUBLIC_ENDPOINT` (per `phase-03-videos/TD-05`).
