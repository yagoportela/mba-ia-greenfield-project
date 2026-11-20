---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-create.e2e-spec.ts
---

# Endpoints de iniciação de upload e consulta do vídeo — Test Plan

## Application Overview

Expõe a criação de um rascunho de vídeo e a consulta do próprio vídeo. `POST /videos` valida o payload (allowlist MP4/WebM, limite de 10 GiB), gera o `public_id` único, cria a sessão multipart no object storage e persiste o vídeo com `status: draft` e `upload_id`. `GET /videos/{id}` retorna o estado do vídeo para o dono, incluindo `thumbnailUrl` presignada quando `status = ready`. Todas as rotas são protegidas pelo guard JWT global e escopadas ao dono do canal do vídeo.

## Test Scenarios

### 1. Criação do rascunho de vídeo

**Setup:** `beforeEach` trunca o banco de teste (`DELETE FROM ...`) e recompõe a aplicação via `Test.createTestingModule(...).compile()` com o mesmo `ValidationPipe`/filtros do `main.ts`; MinIO e Redis reais do Compose; suíte executada com `--runInBand` (per `testing-guide-nestjs-project`).

#### 1.1. create-draft-success

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-20T19:54:35Z

**Steps:**
  1. Criar um usuário confirmado e obter o access token (`POST /auth/register` → confirmar via `GET /auth/confirm-email` → `POST /auth/login`)
    - expect: o token de acesso é retornado e o canal do usuário existe
  2. `POST /videos` com `Authorization: Bearer <token>` e body `{ "originalFilename": "meu-video.mp4", "mimeType": "video/mp4", "sizeBytes": 104857600 }`
    - expect: resposta `201` com `id` (uuid), `publicId` de 12 caracteres, `status: "draft"`, `partSizeBytes: 67108864`, `partCount: 2`
    - expect: existe uma linha em `videos` com o mesmo `id`, `status = draft`, `upload_id` não nulo e `storage_key = videos/{id}/original.mp4`

#### 1.2. reject-unsupported-media-type

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-20T19:54:35Z

**Steps:**
  1. `POST /videos` autenticado com `{ "originalFilename": "doc.pdf", "mimeType": "application/pdf", "sizeBytes": 1048576 }`
    - expect: resposta `415` com `error: "UNSUPPORTED_MEDIA_TYPE"`
    - expect: nenhuma linha é criada em `videos`
  2. `POST /videos` autenticado com `{ "originalFilename": "clipe.mov", "mimeType": "video/quicktime", "sizeBytes": 1048576 }`
    - expect: resposta `415` com `error: "UNSUPPORTED_MEDIA_TYPE"`

#### 1.3. reject-file-too-large

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-20T19:54:35Z

**Steps:**
  1. `POST /videos` autenticado com `{ "originalFilename": "grande.mp4", "mimeType": "video/mp4", "sizeBytes": 10737418241 }`
    - expect: resposta `413` com `error: "FILE_TOO_LARGE"`
    - expect: nenhuma linha é criada em `videos`

#### 1.4. reject-unauthenticated-request

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-20T19:54:35Z

**Steps:**
  1. `POST /videos` com body válido e sem header `Authorization`
    - expect: resposta `401`
  2. `POST /videos` com header `Authorization: Bearer <token-inválido>` e body válido
    - expect: resposta `401`
    - expect: nenhuma linha é criada em `videos`

### 2. Consulta do vídeo

**Setup:** `beforeEach` trunca o banco de teste (`DELETE FROM ...`) e recompõe a aplicação via `Test.createTestingModule(...).compile()` com o mesmo `ValidationPipe`/filtros do `main.ts`; MinIO e Redis reais do Compose; suíte executada com `--runInBand` (per `testing-guide-nestjs-project`).

#### 2.1. reject-video-from-other-user

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-20T19:54:35Z

**Steps:**
  1. Usuário A cria um vídeo via `POST /videos` e captura o `id`
    - expect: vídeo criado com `status: "draft"`
  2. Usuário B (autenticado, com canal próprio) chama `GET /videos/{id-de-A}`
    - expect: resposta `403` com `error: "VIDEO_ACCESS_DENIED"`

#### 2.2. return-not-found-for-unknown-video

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-20T19:54:35Z

**Steps:**
  1. `GET /videos/{uuid-aleatório-inexistente}` autenticado
    - expect: resposta `404` com `error: "VIDEO_NOT_FOUND"`

#### 2.3. draft-video-has-no-thumbnail

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-20T19:54:35Z

**Steps:**
  1. Usuário cria um vídeo via `POST /videos` e captura o `id`
    - expect: `status: "draft"`
  2. `GET /videos/{id}` autenticado
    - expect: resposta `200` com `status: "draft"` e `thumbnailUrl: null`

#### 2.4. ready-video-exposes-presigned-thumbnail

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-20T19:54:35Z

**Steps:**
  1. Preparar um vídeo do usuário com `status = "ready"` e `thumbnail_key = videos/{id}/thumbnail.jpg`, com o objeto do thumbnail enviado ao MinIO
    - expect: linha em `videos` com `status = ready` e `thumbnail_key` preenchido
  2. `GET /videos/{id}` autenticado
    - expect: resposta `200` com `thumbnailUrl` não nulo, apontando para o valor de `S3_PUBLIC_ENDPOINT`
    - expect: a URL contém assinatura presignada e expira em 3600 segundos
