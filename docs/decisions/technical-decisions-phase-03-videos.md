---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-20
scope_description: "Backend and cross-layer foundation for Phase 03 — video upload and processing: object storage, presigned multipart upload, async queue, media worker, FFmpeg metadata/thumbnail generation, unique video URLs, streaming/download delivery, and processing lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — primary subproject. Receives the object-storage adapter, upload-session/presign endpoints, video draft creation, queue producer, media-worker process, FFmpeg/ffprobe integration, video status lifecycle, migrations, and the new config/env keys.
- `next-frontend/` — consumer of the cross-layer contracts defined here: the presigned multipart upload handshake, the presigned playback/download URLs, and the public video identifier. No dedicated Frontend-scope TD exists because Phase 03's capability bullets contain no screen bullets — the upload UI belongs to Phase 04 (`Painel de gerenciamento`) and the player UI to Phase 05 (`Página de Visualização do Vídeo`). The Cross-layer TDs below are the contracts those screens will consume; no additional frontend decision is open in this document.

> Cross-doc anchors (already decided — do NOT reopen):
> - **Configuration:** namespaced `registerAs` factories + Joi env validation (`phase-01-configuracao-base/TD-01..TD-04`). New storage/queue keys extend the same schema; they do not introduce a second config mechanism.
> - **Authentication:** custom `@nestjs/jwt` guard registered globally via `APP_GUARD` (`phase-02-auth/TD-02`). Every new endpoint is protected by default; anonymous playback/download endpoints must opt out with `@Public()`.
> - **Error envelope:** `{ statusCode, error, message }` with machine-readable domain codes (`phase-02-auth/TD-07`). Storage/processing failures must surface through the same envelope.
> - **OpenAPI contract chain:** `@nestjs/swagger` + committed `openapi.json` (`openapi-docs-nestjs/TD-01`, `TD-02`), consumed by the FE through generated `paths` and the named aliases in `lib/api/contracts.ts` (`next-frontend-openapi-typing/TD-01..TD-05`). Every new endpoint must be exported to `openapi.json` before the FE consumes it.
> - **Strict BFF:** the browser never calls the NestJS API directly; only same-origin Route Handlers/RSC/Server Actions read `env.API_URL` (`next-frontend-config-base/TD-03`). The same TD explicitly anticipates object-storage presigned URLs as the separate mechanism for media: the browser talks to storage, not to the API. The storage-access TDs below formalize that exception.
> - **Docker DNS:** containers reach each other by Compose service name, never `localhost` (`CLAUDE.md`). The only `localhost` used here is the **browser-facing** storage endpoint in local development, which is a client-side address, not a container-to-container address.
> - **Deferred infrastructure prerequisite:** `next-frontend-config-base/TD-03` left the concrete BFF→API network value unresolved. Consuming the cross-layer contracts below requires that gap to be closed (shared network or `host.docker.internal`), but that is an infra task, not a decision reopened by this document.

---

## TD-01: Async Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** Phase 03 needs to move video processing off the request path. FFmpeg jobs are CPU-heavy and may run for minutes on a 10GB file; the queue must survive worker crashes, retry transient failures, and allow the worker to run as a separate container. The architecture diagram leaves the Message Queue technology as "TBD". The project currently has PostgreSQL 17 but no Redis or any other broker.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)

Redis-backed job queue with NestJS-native producers/workers. `BullModule.forRootAsync()` wires the Redis connection from the existing config layer; a `@Processor`/`WorkerHost` class consumes jobs in the worker process. BullMQ provides attempts, exponential backoff, deterministic `jobId` deduplication, delayed jobs, and automatic stalled-job recovery.

- **Pros:** Official NestJS integration with a peer range that covers Nest 11. Retries/backoff/stalled recovery map directly to long FFmpeg jobs; a deterministic `jobId` (e.g., `videoId`) prevents duplicate enqueues while a job is active. The worker runs in a separate process/container, so CPU spikes do not affect API latency. Redis is a single lightweight service and can later serve caching or throttler storage. Active project with a large feature set.
- **Cons:** Adds Redis as a new infrastructure service and an operational surface (persistence, memory, healthcheck). Jobs live in Redis memory; durability depends on Redis configuration. The `@nestjs/bullmq` v12 line is ESM-first while this project compiles to CommonJS — the install must either use the CJS-compatible v11 line (Nest 11 peer support) or validate Node 25's `require(ESM)` interop before adoption.

### Option B: pg-boss (PostgreSQL-backed queue)

Queue tables inside the existing PostgreSQL database. Producers insert jobs; workers poll and lock rows; retries and backoff are handled in SQL. No new infrastructure service.

- **Pros:** No new service — PostgreSQL is already in the stack. Enqueue can be transactional with the video status update, so a crash cannot leave "status changed but job not enqueued". Durable by default. Simple operational model for a single-instance project.
- **Cons:** Polling adds latency and DB load; the queue competes with application queries on the same database. No official NestJS integration — the module/provider wiring is manual. Requires its own schema/migrations and an understanding of its worker model. Less common in the NestJS ecosystem, so fewer examples for the team. Current pg-boss releases require Node ≥ 22.12; the project runs Node 25.6, so this is compatible, but it is an additional version constraint to track.

### Option C: RabbitMQ (AMQP)

Dedicated message broker, typically via `@nestjs/microservices` or a thin `amqplib` wrapper. Jobs are published to a queue and acknowledged by the worker.

- **Pros:** Mature broker with strong routing, acknowledgements, dead-letter queues, and language-agnostic clients. Good fit if the platform later grows multiple independent consumers or services in other languages.
- **Cons:** The heaviest operational option for one job type. Delayed/retry patterns need plugins or custom dead-letter wiring. NestJS microservices integration adds transport abstractions that are not needed for an in-process producer/worker pair. More concepts to learn than BullMQ for no Phase 03 benefit.

**Recommendation:** **Option A (BullMQ + Redis)** — BullMQ's retries, exponential backoff, deterministic `jobId`, and stalled-job recovery are exactly the primitives Phase 03 needs for long-running FFmpeg work, and `@nestjs/bullmq` keeps the producer/worker code inside the project's NestJS conventions. Redis is one small Compose service; PostgreSQL remains the domain source of truth, so a Redis flush only loses pending jobs that can be re-enqueued from videos stuck in `draft`/`processing`. Use the `@nestjs/bullmq` version line that is CJS-compatible with Nest 11 and verify the peer range at install time.

**Decision:** **A (BullMQ + Redis)**

---

## TD-02: Object Storage Backend and S3 Client

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Phase 03 must store 10GB video originals and generated thumbnails outside the API container. The API creates upload sessions and signs URLs; the worker reads the source and writes thumbnails; the browser eventually streams from the same storage. The architecture diagram names "S3 or MinIO" and leaves the concrete choice open. There is no storage service in `compose.yaml` today.

**Options:**

### Option A: S3-compatible storage — MinIO in development, S3-compatible provider in production — with AWS SDK v3

Add a MinIO container to the backend Compose stack. Both API and worker use `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` with `endpoint`, `region`, credentials, and `forcePathStyle: true` from config. The same code runs against MinIO locally and against S3/MinIO/R2 in production by changing env values.

- **Pros:** Matches the C4 diagram and preserves the option to switch providers without code changes. The S3 API provides multipart upload, presigned URLs, range reads, and object metadata natively — all Phase 03 requirements. MinIO is lightweight locally and keeps development offline. API and worker can access storage directly without a shared filesystem. AWS SDK v3 is TypeScript-first, actively maintained, and supports custom endpoints/path-style addressing (verified in its documentation). The SDK's `forcePathStyle: true` is the documented MinIO-compatible configuration.
- **Cons:** Adds a service and a bucket-bootstrap step (create bucket, policy, CORS). Requires the dual-endpoint configuration described in TD-05. Adds two server-side dependencies. MinIO still has to be operated/updated in development, and its console/API ports must be exposed for the browser-facing endpoint.

### Option B: Local filesystem volume shared by API and worker

Store files in a Docker volume mounted into both containers. The API serves files through NestJS and a custom Range implementation; the worker writes thumbnails to the same volume.

- **Pros:** No external service and no SDK. Simplest possible local setup and debugging. Files can be inspected directly on disk.
- **Cons:** The API would carry every media byte, including 10GB uploads and range reads, violating the "sem impacto na performance" requirement. No native multipart or presigned upload. Horizontal scaling requires a shared network filesystem. Range handling, cleanup, disk-capacity monitoring, and backup are all custom. The architecture explicitly expects object storage, so this would be a later rewrite.

### Option C: Managed S3 only (no local emulator)

Use a real cloud bucket for development, test, and production. No MinIO container.

- **Pros:** Identical behavior in every environment. No local object-storage service to operate. Useful when the team already has cloud credentials and fast network access.
- **Cons:** Every local run and test needs cloud credentials, network access, and bucket isolation. Offline development is impossible. Test runs create cloud objects and incur cost/egress. CI needs secrets. Contradicts the project's local-first Docker Compose workflow.

**Recommendation:** **Option A (S3-compatible storage + AWS SDK v3)** — It is the only option that satisfies direct browser upload, streaming, and worker access without routing media through the API. MinIO gives the project a real S3 implementation locally while keeping production open to S3-compatible providers. Use AWS SDK v3 rather than the MinIO-specific JS SDK: the API semantics needed here are standard S3 (multipart, presign, range), and a standard client keeps the production provider replaceable without a client rewrite.

**Decision:** **A (S3-compatible + AWS SDK v3)**

---

## TD-03: Storage Bucket and Object Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The API creates the upload target, the worker reads the source and writes the thumbnail, and the streaming endpoint signs reads. All three must agree on bucket names and object keys. Keys also determine how easy it is to delete all artifacts of a video, apply lifecycle rules, and avoid user-controlled path segments.

**Options:**

### Option A: Single private bucket with one prefix per video

One bucket (e.g., `streamtube-media`), private, with deterministic keys:

```text
videos/{videoId}/source
videos/{videoId}/thumbnail.jpg
```

Future derived objects can live under the same prefix (e.g., `videos/{videoId}/metadata.json`). All browser access is presigned; the bucket itself is never public. `{videoId}` is the internal UUID, never a user-supplied filename.

- **Pros:** One bucket to bootstrap, configure, and back up. A per-video prefix makes deletion and orphan cleanup trivial (`delete prefix videos/{videoId}/`). Deterministic keys mean every service can derive the key from the video ID without a second lookup. No user input enters the key, eliminating path traversal and weird-character surprises. Lifecycle rules can target the `videos/` prefix. Moving to separate buckets later is a config change if keys stay relative.
- **Cons:** All objects share one bucket's policies and quotas, so a bad bucket-level policy affects every media type. Prefix-based lifecycle rules are slightly less granular than bucket-level rules. Thumbnails cannot be made public independently without a separate bucket or bucket policy path.

### Option B: Separate buckets per media type (`streamtube-videos`, `streamtube-thumbnails`)

- **Pros:** Independent lifecycle/retention and IAM per media type. Thumbnails can be made public or CDN-served without touching video policy. Clear cost reporting per media type.
- **Cons:** More bootstrap and env configuration. Every read/write/presign path must choose the correct bucket. Cross-bucket operations and migrations are harder. Overkill for Phase 03, where both object types are private and served through presigned URLs.

### Option C: Channel-scoped hierarchy (`channels/{channelId}/videos/{videoId}/...`)

- **Pros:** Human-inspectable storage listing that mirrors the domain. Per-channel bulk deletion is a prefix operation. Channel ownership is visible in the storage layout.
- **Cons:** Longer keys and a second identifier in the storage path. The database is already the source of truth for ownership, so the hierarchy adds no functional benefit. It complicates presign/worker code and would require key rewrites if a video ever moves channels. It also exposes channel IDs in storage listings (not in presigned URLs, but in operational tooling).

**Recommendation:** **Option A (single private bucket, `videos/{videoId}/...`)** — It is the smallest layout that gives deterministic keys, one-prefix cleanup, and a single policy surface. The bucket stays private; all access is presigned. The exact bucket name is an env key (TD-05), not a hardcoded constant. Thumbnails can move to their own bucket later without changing the per-video key convention if the need appears.

**Decision:** **A (single private bucket + per-video prefix)**

---

## TD-04: Large-File Upload Protocol

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** Phase 03 must accept files up to 10GB without making the API carry the bytes, and the project plan's "Pontos de Atenção" explicitly requires resume after connection failure. The upload must pre-register a draft before the first byte is uploaded. S3's single `PutObject` is limited to 5GiB, so a 10GB object necessarily uses multipart upload. The frontend is under the strict-BFF model, but the BFF must orchestrate the upload session while the bytes go to storage. The C4 diagram's `API → Object Storage: Uploads` relation is satisfied by the API creating/completing multipart uploads and managing object metadata; the bulk bytes flow browser → storage, consistent with the "sem impacto na performance" requirement.

**Options:**

### Option A: Presigned S3 multipart upload — browser uploads parts directly to storage

The BFF calls the API to create a draft and initiate an S3 multipart upload. The API returns the `uploadId` plus presigned `UploadPart` URLs. The browser uploads parts (e.g., 64MiB each, ~160 parts for 10GB) with a small concurrency window, retrying individual parts. On resume after a reload/connection loss, the BFF calls `ListParts` and returns the missing part numbers. When all parts are uploaded, the BFF calls the API's completion endpoint; the API calls `CompleteMultipartUpload`, validates the resulting object, and enqueues processing. `AbortMultipartUpload` handles cancellation and cleanup.

- **Pros:** The API and BFF never handle the 10GB body. Parallel parts plus per-part retry make large uploads practical and resilient. `ListParts` provides native resume without a custom chunk protocol. Standard S3 semantics work with both MinIO and S3, up to 5TiB and 10,000 parts. Upload progress and cancellation are per part. The draft is created before the first part, satisfying the pre-registration requirement.
- **Cons:** The frontend must implement a multipart uploader (part slicing, concurrency, retry, progress, abort) instead of a single `fetch`. Bucket CORS must expose `ETag`; part URLs must be signed with headers the browser can reproduce. Presigned part URLs expire, so long uploads must re-sign. Abandoned uploads leave orphaned parts until the storage lifecycle/stale-upload cleanup runs. The handshake has more endpoints (initiate, sign/refresh parts, list, complete, abort) than a single upload endpoint.

### Option B: API-proxied streaming upload — browser sends the file through the BFF/API

The browser posts the file to a same-origin BFF Route Handler, which streams it to the NestJS API, which streams it to storage.

- **Pros:** Single origin, no storage CORS. The API can validate, meter, and authenticate every byte. The frontend implementation is a conventional form/`fetch` upload.
- **Cons:** Every byte crosses the BFF and the API twice (upstream and downstream), making the API the upload bottleneck and violating the performance requirement. Long-lived 10GB requests hit Node/Next/proxy timeouts and body limits. No native resume. Scaling uploads means scaling the API. Memory/backpressure bugs are easy to introduce. This option is listed to rule it out.

### Option C: tus resumable upload protocol with a dedicated tus server

Run a `tusd`-style server in front of storage; the browser uses a tus client to upload resumable chunks.

- **Pros:** Standardized resumable-upload protocol with client libraries, pause/resume, and checksums. Good upload UX with less custom client logic. Decouples upload from the API.
- **Cons:** Adds another service/container and a second data path to storage. Requires tus-to-S3 integration or tus storage of chunks plus a finalize step. Another protocol and operational surface for a requirement that S3 multipart already meets. The BFF still needs to authenticate the session and authorize the upload.

**Recommendation:** **Option A (presigned S3 multipart)** — It is the only option that keeps the API out of the media path while providing native resume and per-part retry. Recommended starting parameters for `/plan-build`: 64MiB parts (10GB ≈ 160 parts), 4–6 concurrent parts, part URLs valid for ~1 hour and re-signed on resume, `uploadId`/key persisted server-side so a reload can continue. The completion endpoint is the single place that finalizes the upload and enqueues processing. Configure stale-upload cleanup (MinIO/S3 lifecycle or an explicit abort sweep) so abandoned multipart uploads do not accumulate.

**Decision:** **A (presigned S3 multipart)**

---

## TD-05: Browser-to-Storage Access Topology (Dual Endpoint + CORS)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)"

**Context:** API and worker run inside Docker and must reach MinIO at its service name (`http://minio:9000`). The browser runs on the host/outside the Compose network and must reach storage at a browser-resolvable address (`http://localhost:9000` in development, a public domain in production). A SigV4 presigned URL includes the host in its signature, so the host used to sign must match the host the browser calls. This is the concrete consequence of the strict-BFF exception anticipated in `next-frontend-config-base/TD-03`: the browser talks to object storage, never to the API, and only with short-lived presigned URLs.

**Options:**

### Option A: Two configured endpoints — internal for operations, public for signing

Add `S3_ENDPOINT` (internal, e.g. `http://minio:9000`) and `S3_PUBLIC_ENDPOINT` (browser-reachable, e.g. `http://localhost:9000` in dev). The API/worker use `S3_ENDPOINT` for object operations (`CreateMultipartUpload`, `CompleteMultipartUpload`, `HeadObject`, `GetObject`, `ListParts`). A second S3 client (or a presigner-only client) configured with `S3_PUBLIC_ENDPOINT` signs only the URLs handed to the browser. MinIO's CORS allows the frontend origin and exposes the headers the browser needs.

- **Pros:** Works in both directions without a proxy: containers stay on the internal network, the browser uses a reachable host. The signing host is explicit and testable. Production can point `S3_PUBLIC_ENDPOINT` at a CDN or reverse proxy later without changing application code. Presigned URLs can be validated by a simple integration test that parses the URL host.
- **Cons:** Two endpoints must stay consistent; a mismatch produces URLs that work inside the API but fail in the browser (or vice versa). The public endpoint must be exposed from the Compose network. CORS and bucket policy need a bootstrap step. Local port exposure (`9000`) is required.

### Option B: One endpoint used by everything

Configure a single host reachable from both containers and the browser (e.g., `host.docker.internal:9000` or a public DNS name) and use it for operations and signing.

- **Pros:** One config value and one mental model. No risk of signing against the wrong host.
- **Cons:** Container-to-container storage traffic hairpins through the host/public network, adding latency and depending on host-specific DNS (`host.docker.internal` differs across platforms). In production, internal operations would unnecessarily traverse the public edge/TLS. Local development becomes less portable.

### Option C: Reverse proxy in front of MinIO with a single public origin

Run Caddy/Nginx in front of MinIO, expose a single path/host, and sign URLs against the proxy host. The proxy forwards to MinIO.

- **Pros:** Same-origin option (no CORS if the frontend is served from the same host), TLS termination, hides MinIO, and is CDN-ready. One public address for the browser.
- **Cons:** An extra service and configuration file. The proxy must correctly forward `Range`, preserve the `Host` header, and expose `ETag`/`Content-Range`; path-style signing and rewrites are easy to get wrong. More infrastructure than Phase 03 needs. It can be added later by changing `S3_PUBLIC_ENDPOINT`, which is why Option A keeps the door open.

**Recommendation:** **Option A (dual endpoint)** — It is the minimal configuration that works in both directions and keeps signing explicit. In development, set `S3_PUBLIC_ENDPOINT=http://localhost:9000`; in production, point it at the public storage/CDN host. Configure MinIO global CORS (`MINIO_API_CORS_ALLOW_ORIGIN`) for the frontend origin (never `*` outside local development) and bucket-level CORS exposing `ETag` (upload completion), `Content-Range`, `Accept-Ranges`, and `Content-Length` (playback/download), while allowing the headers the uploader sends (`Content-Type`, `x-amz-*`). A reverse proxy/CDN can replace the public endpoint later without changing application code.

**Decision:** **A (dual endpoint + CORS)**

---

## TD-06: Upload Constraints and Validation Policy

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Reprodução via streaming (sem necessidade de download completo)"

**Context:** Phase 03 does not include transcoding: the worker extracts metadata and a thumbnail, and the original object is what the browser streams. If the platform accepts arbitrary containers/codecs, many uploads will be unplayable in browsers even though they are valid video files. The 10GB cap comes from the project plan and must be enforced server-side; a client-declared size cannot be trusted. This is a cross-layer policy because the file picker, the API, and the worker must agree on what is acceptable.

**Options:**

### Option A: Strict playback-oriented allowlist + ffprobe validation

Accept only formats that browsers can play directly: MP4 with H.264 video + AAC audio, and WebM with VP8/VP9 + Opus/Vorbis. Enforce the 10GB cap at upload initiation and again before completion (sum of uploaded parts). The worker runs `ffprobe` on the completed object and marks the video `failed` if the container/codecs do not match the allowlist or the file is corrupt.

- **Pros:** Streaming works predictably without transcoding. Users get a clear, early error instead of a "ready" video that will not play. Storage does not fill with unusable files. The validation is based on the actual container/codecs, not just the filename extension. Keeps Phase 03's processing scope small.
- **Cons:** Rejects MOV, HEVC/H.265, AV1, and other legitimate video files unless the user converts them first. The allowlist must be maintained as browser codec support changes. A file that passes MIME/size checks can still fail ffprobe after the full upload, so failures are discovered late (the worker sets `failed`).

### Option B: Accept any `video/*` and rely on best-effort playback

- **Pros:** Broad acceptance; the fewest upload-time rejections. No allowlist maintenance.
- **Cons:** Unplayable files can become `ready` or fail only when the user tries to watch. The platform's streaming promise becomes unreliable. Support burden grows. A later transcoding phase would have to reprocess or invalidate existing videos.

### Option C: Accept any video and transcode to a web-safe rendition

- **Pros:** Best compatibility and user experience. The platform can accept MOV/HEVC/AV1 and normalize everything to H.264/AAC or adaptive renditions.
- **Cons:** Transcoding a 10GB source is CPU-heavy and long-running, requires additional storage for renditions, and introduces HLS/bitrate-ladder decisions that are outside Phase 03's stated processing scope. It would significantly expand worker architecture and cost. Defer to a dedicated future phase if the product needs it.

**Recommendation:** **Option A (strict playback-oriented allowlist)** — Without transcoding, accepting arbitrary codecs breaks the streaming capability. A narrow MP4/WebM allowlist keeps Phase 03 honest and avoids shipping a "ready" video that cannot play. Defer Option C to a future transcoding phase; if it is adopted later, the allowlist can be widened and the worker's processing output can gain a normalized rendition. Enforce size at both initiation and completion, and validate the actual stream metadata with `ffprobe`, not just the client-supplied MIME type or extension.

**Decision:** **A (strict allowlist + ffprobe)**

---

## TD-07: Media Worker Process Architecture

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Video processing is CPU-heavy and long-running. Running FFmpeg inside the API process would compete with HTTP request handling and make API latency unpredictable. The C4 diagram already models a separate "Video Worker" container. The project has one NestJS codebase; the worker should share its types, config, and storage adapter without becoming a second HTTP server or accidentally consuming jobs in the API process.

**Options:**

### Option A: Separate worker container built from the same NestJS codebase

Add a `video-worker` Compose service built from the same repository. A dedicated entrypoint (e.g., `src/worker.ts`) creates a Nest application context with a `WorkerModule` that registers the queue consumer, database, config, and storage — no HTTP controllers. The API modules register only the queue producer. Both processes share the same source, entities, config factories, and migrations.

- **Pros:** Matches the C4 diagram and isolates CPU-bound FFmpeg work from HTTP latency. The worker can be restarted, scaled, or paused independently. A worker crash does not take down the API. Shares code and types, avoiding a duplicated domain model. The worker image can include FFmpeg without bloating the API image. Job processing can be tested with a Nest testing module.
- **Cons:** A second process/container to build, run, monitor, and healthcheck. The process composition must be explicit so the API never registers the `@Processor` (otherwise both processes consume jobs). Environment configuration must be present in both containers. Deployment/restart orchestration is slightly more complex.

### Option B: In-process worker inside the API (same Nest application)

Register the `@Processor` in the API's module graph; the API both serves HTTP and processes jobs.

- **Pros:** One process and one container. Simplest composition and no extra Compose service. Shared DI without any process-boundary concerns.
- **Cons:** FFmpeg CPU/memory spikes directly affect API latency and availability, contradicting the performance requirement. Scaling the API also scales the workers (and vice versa) with no independent control. An API restart kills active jobs. A processing crash can take down the API. Harder to isolate logs and resource limits.

### Option C: Standalone non-Nest service (separate app/package)

A small Node/TypeScript worker with its own package, dependencies, and bootstrap, consuming the same queue and database.

- **Pros:** Maximum isolation and a minimal runtime for the worker. Independent deployment and dependency versions. No Nest HTTP overhead.
- **Cons:** Duplicates or extracts config, entities, and storage logic into a shared package. Diverges from the project's NestJS conventions and testing patterns. More plumbing for the queue consumer and database connection. Loses `@nestjs/bullmq`'s Nest integration unless replicated. Higher maintenance for a project that already has one Nest codebase.

**Recommendation:** **Option A (separate worker container, same codebase)** — It preserves the single-codebase simplicity while giving FFmpeg a dedicated process and resource boundary. The critical implementation guardrail is module composition: the API must import only the producer-side queue module, and the worker must be the only process that registers the `@Processor`. The worker should start with concurrency 1 per container (CPU-bound FFmpeg) and scale horizontally by adding containers. Build the worker from a worker-specific Dockerfile that installs FFmpeg (TD-08) so the API image stays lean.

**Decision:** **A (separate worker container)**

---

## TD-08: FFmpeg/ffprobe Integration and Packaging

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must extract duration, dimensions, codecs, and other metadata from the uploaded object, and generate a thumbnail from a frame. Phase 03 does not transcode. The worker runs in a controlled container, so the FFmpeg binary can be provisioned there. The integration must not block the Node event loop (so BullMQ lock renewal continues during long jobs) and must handle crashes/timeouts cleanly.

**Options:**

### Option A: System `ffmpeg`/`ffprobe` binaries in the worker image, invoked via `node:child_process.execFile`

Install FFmpeg in the worker Dockerfile (e.g., `apt-get install -y ffmpeg`). Invoke `ffprobe -v error -print_format json -show_format -show_streams <object>` for metadata and `ffmpeg -ss <timestamp> -i <object> -frames:v 1 -vf scale=... <thumbnail>` for the thumbnail. Use `execFile` with an argument array (never a shell string), a timeout, and explicit error handling.

- **Pros:** Uses the official tools with full codec/container support. The binary version is pinned by the worker image and can be upgraded deliberately. No npm wrapper or extra runtime dependency. Argument arrays avoid shell injection. `ffprobe` JSON output is stable and straightforward to parse. Spawning a child process keeps the Node event loop free, so BullMQ's job lock can renew during long FFmpeg runs. The same tooling is ready for future transcoding. Easy to unit-test command construction and to integration-test against fixture media.
- **Cons:** The worker image grows by the FFmpeg package (~100MB). The worker only runs correctly inside a container/host with FFmpeg installed. Spawn failures, non-zero exits, timeouts, and partial outputs must be handled explicitly. The binary version depends on the base image's package repository unless a static build is pinned.

### Option B: `ffmpeg-static` + `ffprobe-static` npm binaries

Install platform-specific binaries through npm and spawn them directly.

- **Pros:** Deterministic binaries via the lockfile; no OS package installation. Works on any Node runtime without a custom worker image (for development). Simpler CI images.
- **Cons:** Large packages (tens of MB each) and platform-specific artifacts. Adds a supply-chain surface for native binaries. Still requires child-process management. Updating FFmpeg means updating an npm package, which may lag upstream security/codec fixes. Duplicates the binary in node_modules instead of the system image.

### Option C: `fluent-ffmpeg` wrapper (with a static/installer binary)

Use the chainable `fluent-ffmpeg` API for both `ffprobe` and thumbnail generation.

- **Pros:** Familiar chainable API, progress events, and helpers for filters/output options. Less code for simple commands.
- **Cons:** The wrapper has had a low release cadence in recent years and adds an abstraction over the exact CLI. Callback/event APIs complicate error handling and async control flow. Debugging a failed command means reconstructing the underlying invocation. It still needs a binary provider. Direct `execFile` is simpler and more transparent for the two operations Phase 03 needs.

**Recommendation:** **Option A (system binaries + `execFile`)** — Phase 03 needs only two well-understood commands; a wrapper adds indirection without value. Installing FFmpeg in the worker image keeps the API image lean and gives the team explicit control over the binary version. Spawning FFmpeg as a child process preserves the worker's event loop for BullMQ lock renewal. The exact thumbnail timestamp and output format are SI-level parameters (e.g., a frame around 10% of duration, JPEG output); they are not strategic decisions and can be tuned without changing this TD.

**Decision:** **A (system binaries + execFile)**

---

## TD-09: Public Video Identifier and Unique URL

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a unique, conflict-free URL. The project plan's "Pontos de Atenção" also calls the URL "curta", and unlisted videos (Phase 04/05) rely on the link being unguessable. The database already uses UUID primary keys, but a 36-character UUID is not a short public URL and exposes the internal primary key. The public identifier is a frontend-facing contract: routes, share links, and future SEO decisions depend on it.

**Options:**

### Option A: UUID v4 as the public URL identifier

Expose the existing UUID primary key in the URL: `/videos/{uuid}`.

- **Pros:** Collision-free by construction; no extra generation or retry logic. Consistent with the project's existing UUID PK convention. No additional unique column or index. Unguessable enough for unlisted links in practice.
- **Cons:** The URL is 36 characters, which does not match the "short URL" goal. Exposes the internal primary key, coupling the public contract to the database design. No SEO/readability value. If the ID scheme ever changes, all existing links break.

### Option B: Short random public ID (base62, 10–12 characters) with UUID primary key kept internal

Store a `publicId` column (unique) generated from cryptographically random bytes and encoded as URL-safe base62/base64url. Public routes use `/videos/{publicId}`; internal relations, storage keys, and jobs keep using the UUID. Collisions are handled by a unique index plus a small bounded retry (using a SAVEPOINT inside a transaction, per the project's TypeORM rules).

- **Pros:** Short, shareable links (10–12 characters) matching the project plan's "URL curta". Roughly 60–72 bits of entropy makes unlisted links unguessable. Hides the internal primary key and decouples the public contract from the database. Stable across title changes (unlike a slug). Collision probability is negligible; the unique index is the safety net.
- **Cons:** Adds a second identifier, a unique column/index, generation code, and collision retry logic. Lookups by public ID must be indexed and used consistently. Two identifiers can be confused in code if naming is not disciplined.

### Option C: Title slug plus a short uniqueness suffix (`/videos/my-video-a1b2c3`)

Generate a slug from the title and append a random suffix for uniqueness.

- **Pros:** Readable, SEO-friendly URLs that communicate the video title. The suffix guarantees uniqueness. Good for sharing and search previews.
- **Cons:** Requires transliteration, Unicode handling, truncation, and reserved-word handling. Title edits either break the URL or require redirect bookkeeping. Collisions/retries are more complex than a random ID. Slugs add length and processing for a feature (SEO) that Phase 03 does not require.

**Recommendation:** **Option B (short random public ID)** — It satisfies both "única" and "curta" without the maintenance cost of slugs, and it keeps the internal UUID out of the public contract. Generate a 12-character base62/base64url value from `crypto.randomBytes`, enforce a unique index, and retry on the rare collision. Use the public ID only in public routes/share links; keep the UUID for database relations, storage keys, and queue payloads. A slug can be layered on top later (e.g., `/videos/{publicId}/{slug}`) without changing the identifier.

**Decision:** **B (short random public ID)**

---

## TD-10: Playback Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** The browser must start playing before the full 10GB file is downloaded, which requires HTTP Range requests and `206 Partial Content`. Download is an explicit user action and should produce the original file with a sensible filename. The API/BFF should not carry media bytes: the C4 diagram shows the frontend streaming from object storage, and the strict-BFF model explicitly anticipates presigned storage URLs. Drafts must remain private; public/unlisted visibility is a later phase, but the delivery mechanism must support it.

**Options:**

### Option A: Presigned GET URLs direct from storage

A BFF/API endpoint checks ownership/visibility and returns a short-lived presigned `GetObject` URL. The browser's `<video>` element requests it with `Range` headers; storage responds with `206 Partial Content`. For download, the API issues a separate presigned GET with `response-content-disposition=attachment` and the original filename. URLs can be refreshed when they expire.

- **Pros:** Media bytes never traverse the API or BFF. Storage handles Range/`206`, content length, and conditional requests natively. Scales with storage rather than application instances. Matches the C4 diagram. The same object serves both playback and download via different presigned parameters. A CDN can be placed in front of the public endpoint in Phase 07 without changing application code. Works with S3 and MinIO.
- **Cons:** Requires the public storage endpoint and CORS configuration from TD-05. Presigned URLs expire, so a long playback session may need a refresh flow. The URL itself is a bearer credential — anyone who has it can use it until expiry (unlisted links share this property by design). Visibility/authorization is enforced only when the URL is issued, not on every byte. The browser must be able to reach storage directly.

### Option B: API-proxied streaming (NestJS/BFF pipes the object with Range support)

The browser requests the video from the API/BFF; the server reads the object from storage and streams it back, implementing or forwarding Range semantics.

- **Pros:** Single origin — no storage CORS or public endpoint. Authorization/visibility can be checked on every request. Presigned URL expiry disappears. The API can rate-limit and log every request. Storage can stay entirely private.
- **Cons:** All media traffic flows through the API and BFF (two hops), consuming bandwidth, CPU, and connections. 10GB streams and concurrent viewers become an application-scaling problem. Backpressure and timeout bugs are easy to introduce. Node streams must correctly handle Range/206 and client aborts. The BFF may impose body/time limits. This contradicts the diagram and the performance goal.

### Option C: Public-read bucket (or CDN) with stable object URLs

Mark the bucket (or a published prefix) public and serve stable URLs, optionally through a CDN.

- **Pros:** Simplest player integration — no signing, no expiry, cacheable by browsers and CDNs. Excellent performance once a CDN is in front. Stable URLs are easy to share.
- **Cons:** Private drafts and unlisted videos need protection, so a single public bucket is unsafe. Unlisted access would rely solely on an unguessable key, with no ability to revoke a leaked URL. Per-request visibility checks are impossible. Bucket policy becomes complex if only some objects are public. Changing from public to private later invalidates every URL. A private bucket plus presigned URLs is safer and equally CDN-compatible.

**Recommendation:** **Option A (presigned GET direct from storage)** — It is the only option that satisfies streaming and download without turning the API into a media proxy. Issue the playback URL only after the current ownership/visibility check; use a TTL long enough for a typical session (e.g., 1 hour) with a refresh path for long videos. Issue the download URL with `response-content-disposition=attachment` and a sanitized original filename. Configure CORS to expose `Content-Range`, `Accept-Ranges`, and `Content-Length`. Keep the bucket private; Phase 07 can put a CDN in front of `S3_PUBLIC_ENDPOINT` without changing the app.

**Decision:** **A (presigned GET direct)**

---

## TD-11: Video Processing Status Lifecycle and Failure/Retry Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** A video is created as a draft before the upload starts, then uploaded, then processed asynchronously. The system needs an explicit, queryable status so the API and future upload/management screens can tell "not uploaded", "processing", "ready", and "failed" apart. Retries are handled by the queue, but the database must remain the domain source of truth. `ready` here means "processing completed"; publication/visibility is a Phase 04 concern and must not be conflated with processing status.

**Options:**

### Option A: Status enum on the video + BullMQ retry bookkeeping

Add a `status` enum to the video: `draft` → `processing` → `ready` | `failed`, plus a sanitized `processingError` and timestamps (`processingStartedAt`, `processedAt`). The draft is created when the upload session starts. The completion endpoint enqueues a job with `jobId = videoId`. The worker sets `processing`, performs idempotent metadata/thumbnail generation, and sets `ready` or lets the final failure set `failed`. BullMQ handles attempts (e.g., 3) and exponential backoff; a manual retry re-enqueues the same video.

- **Pros:** One explicit state machine that the API, worker, and future UI can query. PostgreSQL is the source of truth for domain state; BullMQ is only the retry executor. `jobId = videoId` prevents duplicate active jobs. BullMQ's stalled-job recovery handles worker crashes. A failed status with a reason is actionable by the user/support. No second job table to keep in sync. The worker can be idempotent, so retries are safe.
- **Cons:** Status transitions need guards to prevent invalid moves (e.g., `ready` back to `draft`). BullMQ and the database can drift if a worker crashes between the external side effect and the DB update; idempotent processing and retries mitigate this. There is no per-attempt history beyond the queue. Stale drafts and stuck `processing` rows need a reconciliation/cleanup path.

### Option B: Separate `video_processing_jobs` table as the source of truth

Persist every processing attempt in a dedicated table; derive the video status from the latest job row.

- **Pros:** Full audit trail and attempt history. Jobs can be rebuilt/replayed from the database. Fine-grained state (queued, running, failed, retried) and metrics are easy. Decouples the domain video from the queue.
- **Cons:** Duplicates BullMQ's state and introduces two sources of truth. More schema, repository, and state-transition code. Keeping the table and the queue consistent is itself a distributed-state problem. Overkill for a single worker type in Phase 03.

### Option C: Boolean flags (`isProcessed`, `processingFailed`)

- **Pros:** Minimal schema change. Trivial to query.
- **Cons:** Allows impossible states (`isProcessed && processingFailed`), cannot distinguish draft from processing, provides no error detail or attempt awareness, and produces a poor API contract. Rejected.

**Recommendation:** **Option A (status enum + BullMQ retries)** — It gives the domain a clean, queryable state machine while delegating retry mechanics to BullMQ. Use four states and keep `ready` strictly about processing; publication/visibility will be a separate Phase 04 field. Configure `attempts: 3` with exponential backoff (e.g., 30s base), `jobId = videoId`, and a bounded `removeOnComplete` policy for queue hygiene. Make the worker idempotent (overwrite metadata/thumbnail, upsert by video ID) so retries and stalled-job recovery are safe. Add a reconciliation sweep for videos stuck in `processing` beyond a threshold and for abandoned `draft` uploads (the exact schedule is an SI detail).

**Decision:** **A (status enum + BullMQ retries)**

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Async job queue technology | BullMQ + Redis (`@nestjs/bullmq`) | **A (BullMQ + Redis)** |
| TD-02 | Backend | Object storage backend and S3 client | S3-compatible storage (MinIO dev) + AWS SDK v3 | **A (S3-compatible + AWS SDK v3)** |
| TD-03 | Backend | Storage bucket and object key layout | Single private bucket + `videos/{videoId}/...` | **A (single private bucket + per-video prefix)** |
| TD-04 | Cross-layer | Large-file upload protocol | Presigned S3 multipart direct-to-storage | **A (presigned S3 multipart)** |
| TD-05 | Cross-layer | Browser-to-storage access topology | Dual endpoint (internal + public) + CORS | **A (dual endpoint + CORS)** |
| TD-06 | Cross-layer | Upload constraints and validation policy | Strict MP4/WebM allowlist + ffprobe validation | **A (strict allowlist + ffprobe)** |
| TD-07 | Backend | Media worker process architecture | Separate worker container from same codebase | **A (separate worker container)** |
| TD-08 | Backend | FFmpeg/ffprobe integration and packaging | System binaries + `execFile` in worker image | **A (system binaries + execFile)** |
| TD-09 | Cross-layer | Public video identifier and unique URL | Short random public ID + UUID internal PK | **B (short random public ID)** |
| TD-10 | Cross-layer | Playback streaming and download delivery | Presigned GET direct from storage | **A (presigned GET direct)** |
| TD-11 | Backend | Video status lifecycle and failure/retry | Status enum + BullMQ retries | **A (status enum + BullMQ retries)** |

---

## Dependencies and downstream notes

- **TD-04 depends on TD-02, TD-03, TD-05.** Multipart upload needs the storage backend, key layout, and browser-reachable presigned URL host.
- **TD-10 depends on TD-02, TD-03, TD-05.** Streaming/download needs the same storage stack and public endpoint; it also consumes the public ID from TD-09 for public routes.
- **TD-07 depends on TD-01.** The worker container only exists because the queue runs independently of the API.
- **TD-08 depends on TD-07.** FFmpeg is installed in the worker image, not the API image.
- **TD-11 depends on TD-01 and TD-04.** The draft is created by the upload handshake; the completion step enqueues the job; BullMQ owns retry execution.
- **TD-06 depends on TD-08.** The worker validates the actual stream metadata with `ffprobe` before marking the video `ready`.
- **New environment keys (indicative, finalized by `/plan-build`):** storage endpoint/public endpoint, bucket, region, access key, secret key, force-path-style, presigned TTLs, max upload size, allowed content types, Redis host/port, queue name, worker concurrency, processing attempt count. They must be added to `env.validation.ts`, the relevant `registerAs` config factory, and `.env.example`.
- **Migration obligations:** the `videos` table (or equivalent) needs the public ID, status enum, storage key, original filename, duration/metadata fields, thumbnail key, processing error, and timestamps. The schema change must go through a generated TypeORM migration — never `synchronize: true`.
- **Frontend consumption:** the upload screen (Phase 04) and player (Phase 05) must consume these contracts through the strict BFF. The upload handshake and URL-issuance endpoints must be added to `openapi.json` and to `lib/api/contracts.ts` before the FE wires them. The BFF→API network gap noted in `next-frontend-config-base/TD-03` must be resolved before those screens can call the API from a container.
- **Out of scope for this document:** transcoding/adaptive streaming (HLS), CDN provisioning, video visibility/publication rules (Phase 04), player UI (Phase 05), and the exact endpoint paths/payloads of the upload session API (resolved at `/plan-build`).
