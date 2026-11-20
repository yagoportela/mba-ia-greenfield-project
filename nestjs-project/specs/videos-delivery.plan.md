---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos-delivery.e2e-spec.ts
---

# Entrega do vídeo: playback em streaming e download — Test Plan

## Application Overview

Expõe a entrega da mídia por URLs presignadas de GET, sem transformar a API em proxy. `GET /videos/{publicId}/playback` devolve uma URL de streaming (com suporte a range requests) e `GET /videos/{publicId}/download` devolve uma URL com `Content-Disposition: attachment` e o nome original sanitizado. Ambos exigem autenticação, ownership do vídeo e `status = ready` — a Fase 03 ainda não tem publicação/visibilidade, então a entrega é owner-only. Todas as rotas são protegidas pelo guard JWT global.

## Test Scenarios

### 1. Playback

**Setup:** `beforeEach` trunca o banco de teste (`DELETE FROM ...`) e recompõe a aplicação via `Test.createTestingModule(...).compile()` com o mesmo `ValidationPipe`/filtros do `main.ts`; MinIO e Redis reais do Compose; suíte executada com `--runInBand` (per `testing-guide-nestjs-project`).

#### 1.1. playback-ready-video

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-20T19:54:35Z

**Steps:**
  1. Preparar um usuário autenticado e um vídeo do seu canal com `status = "ready"`, com o objeto original presente no MinIO em `videos/{id}/original.mp4`
    - expect: vídeo `ready` e objeto acessível pelo storage
  2. `GET /videos/{publicId}/playback` autenticado
    - expect: resposta `200` com `url` presignada apontando para `S3_PUBLIC_ENDPOINT` e `expiresAt` coerente com TTL de 3600 segundos
  3. `GET` na `url` devolvida com header `Range: bytes=0-1023`
    - expect: resposta `206 Partial Content` com `Content-Range` e `Content-Length` presentes

#### 1.2. reject-playback-while-processing

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-20T19:54:35Z

**Steps:**
  1. Preparar um vídeo do usuário com `status = "processing"`
    - expect: vídeo existe com `status = processing`
  2. `GET /videos/{publicId}/playback` autenticado
    - expect: resposta `409` com `error: "VIDEO_NOT_READY"`

#### 1.3. reject-playback-from-non-owner

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-20T19:54:35Z

**Steps:**
  1. Preparar um vídeo `ready` de outro usuário
    - expect: vídeo pertence a outro canal
  2. `GET /videos/{publicId}/playback` autenticado como o usuário sem posse
    - expect: resposta `403` com `error: "VIDEO_ACCESS_DENIED"`

### 2. Download

**Setup:** `beforeEach` trunca o banco de teste (`DELETE FROM ...`) e recompõe a aplicação via `Test.createTestingModule(...).compile()` com o mesmo `ValidationPipe`/filtros do `main.ts`; MinIO e Redis reais do Compose; suíte executada com `--runInBand` (per `testing-guide-nestjs-project`).

#### 2.1. download-ready-video

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-20T19:54:35Z

**Steps:**
  1. Preparar um vídeo `ready` do usuário com `original_filename = "Meu Vídeo Ação.mp4"` e o objeto original no MinIO
    - expect: vídeo `ready` com `original_filename` gravado
  2. `GET /videos/{publicId}/download` autenticado
    - expect: resposta `200` com `url` presignada e `expiresAt` (TTL de 3600 segundos)
  3. `GET` na `url` devolvida
    - expect: resposta `200` com `Content-Disposition: attachment` e `filename*` contendo o nome original sanitizado
    - expect: o body da resposta é idêntico ao arquivo original enviado ao storage

### 3. Autenticação

**Setup:** `beforeEach` trunca o banco de teste (`DELETE FROM ...`) e recompõe a aplicação via `Test.createTestingModule(...).compile()` com o mesmo `ValidationPipe`/filtros do `main.ts`; MinIO e Redis reais do Compose; suíte executada com `--runInBand` (per `testing-guide-nestjs-project`).

#### 3.1. reject-anonymous-delivery

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-20T19:54:35Z

**Steps:**
  1. Preparar um vídeo `ready` de um usuário
    - expect: vídeo `ready` com `publicId` conhecido
  2. `GET /videos/{publicId}/playback` sem header `Authorization`
    - expect: resposta `401`
  3. `GET /videos/{publicId}/download` sem header `Authorization`
    - expect: resposta `401`
