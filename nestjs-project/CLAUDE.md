# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, Redis, object storage) — **never** start the NestJS application server or the media worker unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app", "suba o worker").

Start infrastructure only:

```bash
docker compose up -d db mailpit redis minio minio-init
```

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # long-running services must show status "running" (and healthy where a healthcheck exists)
```

`minio-init` is a one-shot service: it creates the private bucket and exits with code 0, so `exited (0)` is the expected state for it.

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `docker compose exec minio mc ready local` — expect `local is ready`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment". The `media-worker` service boots the worker process (`npm run start:worker`) as its container command, so bring it up only when the user explicitly asks to run the worker.

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start all containers (infrastructure + api + media-worker)
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:

- `nestjs-api` — NestJS API, port `3000`
- `media-worker` — media processing worker, built from `Dockerfile.worker` (Node + FFmpeg/ffprobe), command `npm run start:worker`; consumes BullMQ jobs, no HTTP port
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP on port `1025`, web UI on port `8025`
- `redis` — Redis 7 (BullMQ broker), port `6379`
- `minio` — object storage API on port `9000`, console on port `9001`; credentials come from `S3_ACCESS_KEY`/`S3_SECRET_KEY`
- `minio-init` — one-shot service that runs `scripts/minio-init.sh` to create the private `S3_BUCKET` and then exits

Compose overrides the service hosts for both application processes: `DB_HOST=db`, `S3_ENDPOINT=http://minio:9000`, `REDIS_HOST=redis` (`nestjs-api` also gets `MAIL_HOST=mailpit`). `media-worker` waits for `db`, `redis`, and `minio` healthchecks.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify infrastructure readiness (runs inside each container)
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
docker compose exec minio mc ready local

# Check container logs
docker compose logs nestjs-api
docker compose logs media-worker
docker compose logs db
docker compose logs redis
docker compose logs minio

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm run start:worker                     # Worker process (ts-node, no watch)
npm run start:worker:prod                # Worker process from dist/

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

In normal operation the worker runs inside the `media-worker` service (its `CMD` is `npm run start:worker`). Running `npm run start:worker` inside `nestjs-api` also works, but do not run two consumers against the same Redis unless that is the intent.

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose logs media-worker
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
docker compose exec minio mc ready local
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `start:worker`, `start:worker:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Environment Variables

`.env.example` is the canonical list of keys. Two groups belong to the video pipeline and are validated by `src/config/env.validation.ts` (the app aborts on startup when a required key is missing).

### Object Storage (S3/MinIO) — `src/config/storage.config.ts`

| Variable              | Default                   | Notes                                                                                                 |
|-----------------------|---------------------------|-------------------------------------------------------------------------------------------------------|
| `S3_ENDPOINT`         | `http://minio:9000`       | Internal endpoint for data operations (create/complete multipart, head, download, upload). Compose overrides it in `nestjs-api` and `media-worker`. |
| `S3_PUBLIC_ENDPOINT`  | `http://localhost:9000`   | Used **only** to sign part and GET URLs handed to clients; must be reachable from the browser.        |
| `S3_REGION`           | `us-east-1`               | AWS SDK region.                                                                                        |
| `S3_ACCESS_KEY`       | — (required)              | Also used as the MinIO root user by Compose.                                                           |
| `S3_SECRET_KEY`       | — (required)              | Also used as the MinIO root password by Compose.                                                       |
| `S3_BUCKET`           | — (required)              | Bucket created private by `minio-init`.                                                                |
| `S3_FORCE_PATH_STYLE` | `true`                    | Only `true` / `false`; path-style addressing is required by MinIO.                                     |

### Queue (Redis) — `src/config/queue.config.ts`

| Variable         | Default  | Notes                                                                 |
|------------------|----------|-----------------------------------------------------------------------|
| `REDIS_HOST`     | `redis`  | BullMQ broker host. Compose overrides it in `nestjs-api` and `media-worker`. |
| `REDIS_PORT`     | `6379`   | BullMQ broker port.                                                   |
| `REDIS_PASSWORD` | _(none)_ | Optional; accepted (empty allowed) but not set in `.env.example` — the local Redis runs without auth. |

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

The backend has **two entry points over the same codebase**:

- `AppModule` (`src/main.ts`) — HTTP API server.
- `WorkerModule` (`src/worker/main.ts`) — Nest application context (no HTTP), started by the `media-worker` container.

### API process (`AppModule`)

- Domain modules: `AuthModule` (`src/auth/`), `UsersModule` (`src/users/`), `ChannelsModule` (`src/channels/`), `VideosModule` (`src/videos/`). `AppModule` registers `AuthModule`, `QueueModule`, and `VideosModule` directly; `UsersModule` comes through `AuthModule` and `ChannelsModule` through `VideosModule`.
- `VideosModule` — owns the `Video` entity (`videos` table, migration `1795205743592-CreateVideos.ts`), `VideosController`, and `VideosService`. Imports `ChannelsModule`, `StorageModule`, and `QueueModule`; exports `TypeOrmModule` (the `Video` repository provider) and `VideosService`, and the worker imports this module.
- `StorageModule` (`src/storage/`) — `StorageService` over S3/MinIO. Holds two clients: the internal one (`S3_ENDPOINT`) for data operations and a public one (`S3_PUBLIC_ENDPOINT`) used only to sign URLs handed to clients. Covers multipart create/complete/abort, part presigning, `headObject`, GET presigning, and the download/upload used by the worker. Keys are `videos/{id}/original.{ext}` and `videos/{id}/thumbnail.jpg`.
- `QueueModule` (`src/queue/`) — `BullModule.forRootAsync` reading `queueConfig`; registers the `video-processing` and `video-processing-sweep` queues and exports `BullModule` + `VideoQueueService`. `enqueueProcessing(videoId)` uses `jobId = videoId` (dedupe), 3 attempts, and exponential backoff of 30s. **No `@Processor` is registered in this process.**
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module.

### Worker process (`WorkerModule`, `src/worker/`)

Standalone Nest module with its own `ConfigModule` + `TypeOrmModule`; imports `QueueModule`, `VideosModule`, `UsersModule` (needed for TypeORM relation metadata) and `StorageModule`.

- `MediaToolsService` — wraps `ffprobe` (metadata: duration, dimensions, codec) and `ffmpeg` (thumbnail JPEG).
- `VideoProcessingProcessor` — `@Processor('video-processing', { concurrency: 1 })`. Downloads the original, probes it, generates a thumbnail at ~10% of the duration, uploads it, and sets the video to `ready` with duration/dimensions. On failure it rethrows so BullMQ retries; `failed` + `failure_reason` is written only on the last attempt.
- `ReconciliationProcessor` — `@Processor('video-processing-sweep')`, runs the reconciliation service.
- `ReconciliationService` — re-enqueues `processing` videos untouched for more than 30 minutes and aborts + deletes `draft` videos that still have an `upload_id` after 24 hours.
- `SweepScheduler` — registers the repeatable sweep job (`sweep`, job id `video-processing-sweep`) every 15 minutes on module init.

### Video upload and delivery flow

1. `POST /videos` — creates a `draft` owned by the authenticated user and starts a multipart upload (MP4/WebM, max 10 GiB, 64 MiB parts).
2. `POST /videos/:id/upload-parts` — returns presigned `UploadPart` URLs for the requested part numbers.
3. The client uploads the parts directly to MinIO.
4. `POST /videos/:id/upload-complete` — completes the multipart, validates real size/type via `headObject`, sets `processing`, and enqueues the job.
5. `media-worker` processes the job and sets `ready` (or `failed` after the last retry).
6. `GET /videos/:id` returns the owner's video state (with a presigned thumbnail when ready); `GET /videos/:publicId/playback` and `GET /videos/:publicId/download` return presigned GET URLs (3600s TTL) for `ready` videos.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
