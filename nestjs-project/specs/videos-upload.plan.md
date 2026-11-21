---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload.e2e-spec.ts
---

# Assinatura de parts e conclusão do upload — Test Plan

## Application Overview

Completa o handshake de upload multipart presignado. `POST /videos/{id}/upload-parts` assina URLs de `UploadPart` para o browser enviar os bytes diretamente ao object storage; `POST /videos/{id}/upload-complete` valida que o conjunto de parts cobre o upload, finaliza o multipart, confere o tamanho real e o tipo via `HeadObject`, limpa o `upload_id`, transiciona o vídeo para `processing` e enfileira o job de processamento. Todas as rotas são protegidas pelo guard JWT global e escopadas ao dono do vídeo.

## Test Scenarios

### 1. Assinatura das partes

**Setup:** `beforeEach` trunca o banco de teste (`DELETE FROM ...`) e recompõe a aplicação via `Test.createTestingModule(...).compile()` com o mesmo `ValidationPipe`/filtros do `main.ts`; MinIO e Redis reais do Compose; suíte executada com `--runInBand` (per `testing-guide-nestjs-project`).

#### 1.1. presign-upload-parts-success

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-20T19:54:35Z

**Steps:**
  1. Criar um draft autenticado via `POST /videos` com `{ "originalFilename": "clipe.mp4", "mimeType": "video/mp4", "sizeBytes": 104857600 }`
    - expect: resposta `201` com `partSizeBytes: 67108864` e `partCount: 2`
  2. `POST /videos/{id}/upload-parts` com `{ "partNumbers": [1, 2] }`
    - expect: resposta `200` com `parts` contendo 2 itens `{ partNumber, url, expiresInSeconds: 3600 }`
    - expect: cada `url` aponta para o host de `S3_PUBLIC_ENDPOINT` e contém assinatura presignada de `UploadPart`
  3. `POST /videos/{id}/upload-parts` novamente com `{ "partNumbers": [2] }` (re-assinatura no resume)
    - expect: resposta `200` com uma URL de part 2 válida

#### 1.2. reject-parts-for-non-draft-video

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-20T19:54:35Z

**Steps:**
  1. Criar um draft, enviar a única part e concluir o upload com sucesso via `POST /videos/{id}/upload-complete`
    - expect: `status: "processing"`
  2. `POST /videos/{id}/upload-parts` com `{ "partNumbers": [1] }`
    - expect: resposta `409` com `error: "INVALID_UPLOAD_STATE"`

### 2. Conclusão do upload

**Setup:** `beforeEach` trunca o banco de teste (`DELETE FROM ...`) e recompõe a aplicação via `Test.createTestingModule(...).compile()` com o mesmo `ValidationPipe`/filtros do `main.ts`; MinIO e Redis reais do Compose; suíte executada com `--runInBand` (per `testing-guide-nestjs-project`).

#### 2.1. complete-upload-success-enqueues-processing

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-20T19:54:35Z

**Steps:**
  1. Criar um draft autenticado via `POST /videos` com `sizeBytes: 1048576`
    - expect: resposta `201` com `partCount: 1`
  2. Assinar a part 1, enviar 1 MiB via `PUT` na URL presignada e capturar o `ETag` da resposta
    - expect: `PUT` retorna sucesso e o header `ETag` está presente
  3. `POST /videos/{id}/upload-complete` com `{ "parts": [{ "partNumber": 1, "etag": "<etag>" }] }`
    - expect: resposta `202` com `{ id, publicId, status: "processing" }`
    - expect: a linha em `videos` fica com `status = processing`, `size_bytes = 1048576` e `upload_id = null`
    - expect: a fila `video-processing` contém um job `process-video` com `jobId` igual ao `id` do vídeo

#### 2.2. reject-incomplete-parts

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-20T19:54:35Z

**Steps:**
  1. Criar um draft autenticado via `POST /videos` com `sizeBytes: 1048576` (`partCount: 1`)
    - expect: `status: "draft"`
  2. `POST /videos/{id}/upload-complete` com `{ "parts": [] }`
    - expect: resposta `400` com `error: "UPLOAD_INCOMPLETE"`
    - expect: o vídeo permanece com `status = draft`

#### 2.3. reject-duplicate-completion

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-20T19:54:35Z

**Steps:**
  1. Completar um upload com sucesso (draft → upload da part 1 → `POST /videos/{id}/upload-complete`)
    - expect: `status: "processing"` e um job `process-video` enfileirado
  2. `POST /videos/{id}/upload-complete` novamente com as mesmas parts
    - expect: resposta `409` com `error: "INVALID_UPLOAD_STATE"`
    - expect: existe exatamente um job `process-video` para o `videoId` na fila (nenhum segundo job)
